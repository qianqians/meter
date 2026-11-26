// 逻辑服实体（参考 abelkhan hub/BaseEntity 的结构，实现按本仓库协议重写）。
//
// Entity 是"一个有 id 的东西"：玩家（绑了客户端连接）、怪/NPC（没有连接，只收客户端调用）、
// 将来的跨服实体（路由到别的 hub）。**它不认识任何业务方法**——业务通过 register 挂上来，
// 与 rpc.ts 的 register 同一个形状（schema 值决定编解码，调用处零泛型参数）。
//
// 两个方向：
//   客户端 → 实体：gate.clientRequest → Server 按 entity_id 找到这里 → 分派到 register 的 handler；
//               REQUEST 的回包经 forwardHubCallClient{RESPONSE} 发出（gate 侧原样透传）。
//   实体 → 客户端：rpcRequest（等回包，配对靠 callbackId）/ rpcNotify（推完即忘）。
//
// 视图同步三原语（createRemoteTo / deleteRemoteFrom / refreshTo）供组视图同步使用。

import {
  create,
  fromBinary,
  toBinary,
  type DescMessage,
  type MessageShape,
} from '@bufbuild/protobuf';

import { EnvelopeSchema, MsgType } from './gen/envelope_pb';
import { ErrorCodeSchema } from './gen/common_pb';
import {
  GateForwardHubCallClientSchema,
  HubCreateRemoteEntitySchema,
  HubDeleteRemoteEntitySchema,
  HubRefreshEntitySchema,
} from './gen/gate_logic_pb';

/** 错误码：与 common.proto 的约定一致（同 rpc.ts）。 */
export const ERR = {
  OK: 0,
  UNKNOWN: 1,
  TIMEOUT: 2,
  NOT_FOUND: 7,
  BAD_FRAME: 10,
} as const;

/** 实体回调收到的上下文：谁在调（连接）。 */
export interface CallContext {
  connId: string;
}

/** 下行通道：实体只管装配 Envelope，怎么发（TCP / 测试假连接）由 Server 注入。 */
export interface Downlink {
  send(envelope: Uint8Array): void;
}

interface Pending {
  resolve: (body: Uint8Array) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  method: string;
}

type Handler = (req: Uint8Array, ctx: CallContext) => Uint8Array | Promise<Uint8Array>;

export interface EntityStats {
  unknownMethod: number;
  timeout: number;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/** 装配 Envelope 字节（下行统一形状，server.ts / group.ts 也用）。 */
export function envelopeBytes(
  msgType: MsgType,
  method: string,
  callbackId: number,
  status: number,
  body: Uint8Array,
): Uint8Array {
  return toBinary(EnvelopeSchema, create(EnvelopeSchema, { msgType, method, callbackId, status, body }));
}

/** gate.forwardHubCallClient 的 Envelope（rpcRequest / rpcNotify / 回包共用）。 */
export function forwardCallClient(
  msgType: MsgType,
  connId: string,
  entityId: string,
  method: string,
  callbackId: number,
  content: Uint8Array,
): Uint8Array {
  return envelopeBytes(msgType, 'gate.forwardHubCallClient', callbackId, 0,
    toBinary(GateForwardHubCallClientSchema, create(GateForwardHubCallClientSchema, {
      connId, entityId, method, content,
    })));
}

/**
 * Entity：一个逻辑实体。玩家实体的 connId 非空；怪/NPC 为空（只能收调用、不能主动发）。
 */
export class Entity {
  readonly id: string;
  readonly type: string;
  /** 玩家的连接；怪/NPC 为 undefined。 */
  readonly connId: string | undefined;
  /** 服务端视角的玩家 id（登录时由业务给出）。 */
  readonly userId: string | undefined;

  /** 实体销毁时 Server 调用；业务可以挂清理逻辑（离开场景、存档等）。 */
  onDestroy?: () => void;

  private readonly down: Downlink;
  private readonly handlers = new Map<string, Handler>();
  private readonly pending = new Map<number, Pending>();
  private nextCallbackId = 1;
  readonly stats: EntityStats = { unknownMethod: 0, timeout: 0 };

  constructor(
    id: string,
    type: string,
    down: Downlink,
    opts: { connId?: string; userId?: string } = {},
  ) {
    this.id = id;
    this.type = type;
    this.down = down;
    this.connId = opts.connId;
    this.userId = opts.userId;
  }

  /** 是否玩家实体（有连接、能主动调客户端）。 */
  get isPlayer(): boolean {
    return this.connId !== undefined;
  }

  // ---------------- 客户端 → 实体（register） ----------------

  /**
   * 注册客户端可调用的方法。同一个方法同时服务 REQUEST（要回包）与 NOTIFY。
   * handler 返回值用 rspSchema 编码后经 RESPONSE 发回（只有 REQUEST 会发）。
   */
  register<Req extends DescMessage, Rsp extends DescMessage>(
    method: string,
    reqSchema: Req,
    rspSchema: Rsp,
    handler: (req: MessageShape<Req>, ctx: CallContext) => MessageShape<Rsp> | Promise<MessageShape<Rsp>>,
  ): void {
    this.handlers.set(method, async (reqBytes, ctx) => {
      const req = fromBinary(reqSchema, reqBytes);
      const rsp = await handler(req, ctx);
      return toBinary(rspSchema, rsp);
    });
  }

  /** 只收 NOTIFY（不回包）的轻量注册（心跳类、操作类上报）。 */
  registerNotify<Req extends DescMessage>(
    method: string,
    reqSchema: Req,
    handler: (req: MessageShape<Req>, ctx: CallContext) => void | Promise<void>,
  ): void {
    this.handlers.set(method, async (reqBytes, ctx) => {
      const req = fromBinary(reqSchema, reqBytes);
      await handler(req, ctx);
      return new Uint8Array(0);
    });
  }

  /**
   * 收到一条客户端调用（Server 分派进来）。
   * needsReply：REQUEST 时回包；callbackId 是客户端的配对号，回包原样带回。
   */
  async dispatch(method: string, reqBytes: Uint8Array, ctx: CallContext, needsReply: boolean, callbackId = 0): Promise<void> {
    const h = this.handlers.get(method);
    if (!h) {
      this.stats.unknownMethod++;
      if (needsReply) {
        this.replyError(ctx.connId, method, callbackId, ERR.NOT_FOUND, `unknown method: ${method}`);
      }
      return;
    }
    try {
      const rspBytes = await h(reqBytes, ctx);
      if (needsReply) {
        this.replyOk(ctx.connId, method, callbackId, rspBytes);
      }
    } catch (e) {
      if (needsReply) {
        const detail = e instanceof Error ? e.message : String(e);
        this.replyError(ctx.connId, method, callbackId, ERR.UNKNOWN, detail);
      }
    }
  }

  // ---------------- 实体 → 客户端（rpcRequest / rpcNotify） ----------------

  /**
   * 服务端调客户端，等回包。返回类型由 RspSchema 推出（同 rpc.ts 的 callEntity）。
   * 只有玩家实体可用（怪没有连接，调了直接拒绝）。
   */
  rpcRequest<Desc extends DescMessage>(
    method: string,
    req: Uint8Array,
    rsp: Desc,
    options: { timeoutMs?: number } = {},
  ): Promise<MessageShape<Desc>> {
    if (this.connId === undefined) {
      return Promise.reject(
        new RpcError(`实体 ${this.id}（${this.type}）不是玩家，没有可调用的客户端`, ERR.NOT_FOUND),
      );
    }
    const id = this.nextCallbackId++;
    if (this.nextCallbackId > 0xffffffff) this.nextCallbackId = 1; // 回绕后不复用 0
    return this.sendRequest(method, req, id, options.timeoutMs ?? 10_000).then((bytes) => fromBinary(rsp, bytes));
  }

  /** 服务端推客户端，不等回包。 */
  rpcNotify(method: string, ntf: Uint8Array): void {
    if (this.connId === undefined) {
      throw new RpcError(`实体 ${this.id}（${this.type}）不是玩家，没有可推送的客户端`, ERR.NOT_FOUND);
    }
    this.down.send(forwardCallClient(MsgType.MSG_NOTIFY, this.connId, this.id, method, 0, ntf));
  }

  // ---------------- 实体视图同步（组视图的原语） ----------------

  /** 把自己的视图建到某个客户端（组内新成员要看见我）。 */
  createRemoteTo(player: Entity, content: Uint8Array): void {
    if (player.connId === undefined) return;
    this.down.send(envelopeBytes(MsgType.MSG_NOTIFY, 'hub.createRemoteEntity', 0, 0,
      toBinary(HubCreateRemoteEntitySchema, create(HubCreateRemoteEntitySchema, {
        connId: player.connId,
        entityId: this.id,
        entityType: this.type,
        content,
      }))));
  }

  /** 从某个客户端的视图里删掉自己（组内成员离开）。 */
  deleteRemoteFrom(player: Entity): void {
    if (player.connId === undefined) return;
    this.down.send(envelopeBytes(MsgType.MSG_NOTIFY, 'hub.deleteRemoteEntity', 0, 0,
      toBinary(HubDeleteRemoteEntitySchema, create(HubDeleteRemoteEntitySchema, {
        connId: player.connId,
        entityId: this.id,
      }))));
  }

  /** 给某个客户端刷新自己的视图（属性变化，全量内容）。 */
  refreshTo(player: Entity, content: Uint8Array): void {
    if (player.connId === undefined) return;
    this.down.send(envelopeBytes(MsgType.MSG_NOTIFY, 'hub.refreshEntity', 0, 0,
      toBinary(HubRefreshEntitySchema, create(HubRefreshEntitySchema, {
        connId: player.connId,
        entityId: this.id,
        entityType: this.type,
        content,
      }))));
  }

  // ---------------- 内部 ----------------

  private sendRequest(method: string, body: Uint8Array, id: number, timeout: number): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer =
        timeout > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              this.stats.timeout++;
              reject(new RpcError(`调用超时: ${method}`, ERR.TIMEOUT));
            }, timeout)
          : undefined;
      this.pending.set(id, { resolve, reject, timer, method });
      this.down.send(forwardCallClient(MsgType.MSG_REQUEST, this.connId!, this.id, method, id, body));
    });
  }

  /** gate.clientResponse 到达（Server 按 entity_id 配对到实体后调用）。 */
  onClientResponse(callbackId: number, status: number, body: Uint8Array): void {
    const p = this.pending.get(callbackId);
    if (!p) return; // 迟到/已超时：丢弃（同 rpc.ts 的纪律）
    this.pending.delete(callbackId);
    if (p.timer) clearTimeout(p.timer);
    if (status !== ERR.OK) {
      let detail = '';
      try {
        detail = fromBinary(ErrorCodeSchema, body).detail;
      } catch {
        /* 包体可能为空 */
      }
      p.reject(new RpcError(detail || `status=${status}`, status));
    } else {
      p.resolve(body);
    }
  }

  /** 实体销毁（Server 调）：拒绝所有在途请求、清 handler、跑清理钩子。 */
  destroy(): void {
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new RpcError(`实体销毁: ${p.method}`, ERR.NOT_FOUND));
    }
    this.pending.clear();
    this.handlers.clear();
    this.onDestroy?.();
  }

  private replyOk(connId: string, method: string, callbackId: number, rspBytes: Uint8Array): void {
    this.down.send(forwardCallClient(MsgType.MSG_RESPONSE, connId, this.id, method, callbackId, rspBytes));
  }

  private replyError(connId: string, method: string, callbackId: number, code: number, detail: string): void {
    const err = toBinary(ErrorCodeSchema, create(ErrorCodeSchema, { code, detail }));
    this.down.send(forwardCallClient(MsgType.MSG_RESPONSE, connId, this.id, method, callbackId, err));
  }
}
