// 逻辑服装配：上行分派 + 实体/组管理 + global 广播（参考 abelkhan hub/MainClass 的 GateMsgHandle）。
//
// **执行模型**：`gate.clientRequest` 只是把调用交给实体的 Actor 队列（entity.ts / actor.ts），
// 同一实体严格串行、不同实体互不等待。所以这里的 `dispatch` 不再 await 实体处理——
// 它只负责"找到实体 + 入队"。
//
// 上行（gate → 逻辑）分派表：
//   gate.clientLogin      → onLogin 决策 → hub.createPlayerEntity + 建玩家实体 / hub.kickOffClient
//   gate.clientRequest    → 按 entity_id 分派（REQUEST 回包 / NOTIFY 不回），entity 不存在回 NOT_FOUND
//   gate.clientResponse   → 配对实体的在途 rpcRequest
//   gate.clientDisconnect → 销毁玩家实体 + 从所有组退组
//   gate.clientUplink     → logout 钩子（heartbeat/ack 是框架消息，P0 忽略）
//
// 下行直接复用 transport（envelope 字节，与 rpc.ts 的 Transport 同形状），
// 真连接由 gatelink.ts 提供（TCP + 帧 + logic.hello 握手）。

import { create, fromBinary, toBinary } from '@bufbuild/protobuf';

import { EnvelopeSchema, MsgType } from './gen/envelope_pb';
import { LoginSchema, type Login, type ClientUplink } from './gen/gate_pb';
import { ClientUplinkSchema } from './gen/gate_pb';
import {
  ClientDisconnectSchema,
  ClientRequestHubSchema,
  ClientResponseHubSchema,
  ClientNotifyHubSchema,
  GateForwardClientRequestServiceSchema,
} from './gen/logic_gate_pb';
import {
  GateForwardHubCallGlobalSchema,
  HubCreatePlayerEntitySchema,
  HubKickOffClientSchema,
} from './gen/gate_logic_pb';
import { ErrorCodeSchema } from './gen/common_pb';
import { Entity, envelopeBytes, forwardCallClient, ERR, type CallContext } from './entity';
import { Group, type ViewContent } from './group';

/** 传输层：与 rpc.ts 同形状——搬 envelope 字节，不认识帧（帧由 gatelink 处理）。 */
export interface Transport {
  send(bytes: Uint8Array): void;
  onData(cb: (bytes: Uint8Array) => void): void;
}

/** 登录决策：业务给出玩家实体的标识与初始视图，或拒绝。 */
export type LoginResult =
  | { ok: true; userId: string; entityId: string; entityType: string; content: Uint8Array }
  | { ok: false; code: number; detail: string };

export interface LogicServerOptions {
  transport: Transport;
  nodeId: string;
  /** 登录决策（token 校验、选角都在这里；返回 ok 即建实体）。 */
  onLogin: (login: Login, connId: string) => LoginResult;
  /** 玩家实体建好、发完 createPlayerEntity 之后调用：业务在这里挂方法表。 */
  onPlayerCreate?: (player: Entity) => void;
  /** 玩家实体销毁前调用（存档、退场景都在这里）。 */
  onPlayerDestroy?: (player: Entity) => void;
  /** 客户端主动登出（ClientUplink.logout 透传；**只带 reason**——conn 在协议里没有回传，真正的清理走 gate.clientDisconnect）。 */
  onLogout?: (reason: string) => void;
  /** 组视图内容（怎么把实体序列化给客户端看）。 */
  view?: ViewContent;
}

export interface LogicServerStats {
  logins: number;
  loginRejected: number;
  unknownEntity: number;
  badEnvelope: number;
  disconnects: number;
}

export function createLogicServer(opts: LogicServerOptions) {
  const { transport, nodeId } = opts;
  const view: ViewContent = opts.view ?? (() => new Uint8Array(0));

  const entities = new Map<string, Entity>();
  const groups = new Map<string, Group>();
  const stats: LogicServerStats = {
    logins: 0, loginRejected: 0, unknownEntity: 0, badEnvelope: 0, disconnects: 0,
  };

  const down = { send: (bytes: Uint8Array) => transport.send(bytes) };

  // ---------------- 实体管理 ----------------

  /** 建一个本地实体（怪/NPC：没有连接，只能收客户端调用）。 */
  function createEntity(id: string, type: string): Entity {
    const e = new Entity(id, type, down);
    entities.set(id, e);
    return e;
  }

  function entityOf(id: string): Entity | undefined {
    return entities.get(id);
  }

  /** 销毁实体：退组 → 业务钩子 → 清方法表与在途请求。 */
  function destroyEntity(id: string): boolean {
    const e = entities.get(id);
    if (!e) return false;
    for (const g of groups.values()) {
      g.leave(e);
    }
    opts.onPlayerDestroy?.(e);
    e.destroy();
    entities.delete(id);
    return true;
  }

  // ---------------- 组管理 ----------------

  function createGroup(id: string): Group {
    const existing = groups.get(id);
    if (existing) return existing;
    const g = new Group(id, down, view);
    groups.set(id, g);
    return g;
  }

  function groupOf(id: string): Group | undefined {
    return groups.get(id);
  }

  function destroyGroup(id: string): void {
    groups.get(id)?.clear();
    groups.delete(id);
  }

  // ---------------- global 广播 ----------------

  const global_ = {
    /**
     * 广播给整个游戏服所有玩家：gate.forwardHubCallGlobal。
     * 注意语义边界：gate 会把这条消息发给**它自己**的全部客户端连接；多 gate 部署时
     * 要对每台 gate 各发一条（P0 单 gate，先不建 gate 路由表）。
     */
    rpcNotify(method: string, content: Uint8Array, from = ''): void {
      down.send(envelopeBytes(MsgType.MSG_NOTIFY, 'gate.forwardHubCallGlobal', 0, 0,
        toBinary(GateForwardHubCallGlobalSchema, create(GateForwardHubCallGlobalSchema, {
          entityId: from, method, content,
        }))));
    },
  };

  // ---------------- 工具 ----------------

  /** 踢掉一条连接（登录拒绝 / 业务封禁）。 */
  function kick(connId: string, code: number, detail: string): void {
    down.send(envelopeBytes(MsgType.MSG_NOTIFY, 'hub.kickOffClient', 0, 0,
      toBinary(HubKickOffClientSchema, create(HubKickOffClientSchema, {
        connId,
        error: create(ErrorCodeSchema, { code, detail }),
        promptInfo: detail,
      }))));
  }

  // ---------------- 上行分派 ----------------

  async function dispatch(bytes: Uint8Array): Promise<void> {
    let env;
    try {
      env = fromBinary(EnvelopeSchema, bytes);
    } catch {
      stats.badEnvelope++;
      return;
    }

    switch (env.method) {
      case 'gate.clientLogin': {
        const fwd = fromBinary(GateForwardClientRequestServiceSchema, env.body);
        let login: Login;
        try {
          login = fromBinary(LoginSchema, fwd.content);
        } catch {
          stats.badEnvelope++;
          kick(fwd.connId, ERR.BAD_FRAME, 'login body 解不开');
          return;
        }
        const decision = opts.onLogin(login, fwd.connId);
        if (!decision.ok) {
          stats.loginRejected++;
          kick(fwd.connId, decision.code, decision.detail);
          return;
        }
        const player = new Entity(decision.entityId, decision.entityType, down, {
          connId: fwd.connId, userId: decision.userId,
        });
        entities.set(decision.entityId, player);
        // 先建实体再通知 gate 绑会话：绑完 gate 就开始把该连接的上行路由过来，
        // 实体必须先就位（方法表在 onPlayerCreate 里挂）。
        opts.onPlayerCreate?.(player);
        down.send(envelopeBytes(MsgType.MSG_NOTIFY, 'hub.createPlayerEntity', 0, 0,
          toBinary(HubCreatePlayerEntitySchema, create(HubCreatePlayerEntitySchema, {
            connId: fwd.connId, userId: decision.userId,
            entityId: decision.entityId, entityType: decision.entityType,
            content: decision.content,
          }))));
        stats.logins++;
        return;
      }

      case 'gate.clientRequest': {
        // REQUEST 与 NOTIFY 共用这个 method，body 形状一致（ClientRequestHub / ClientNotifyHub）
        const needsReply = env.msgType === MsgType.MSG_REQUEST;
        const body = needsReply
          ? fromBinary(ClientRequestHubSchema, env.body)
          : fromBinary(ClientNotifyHubSchema, env.body);
        const e = entities.get(body.entityId);
        if (!e) {
          stats.unknownEntity++;
          if (needsReply) {
            const err = toBinary(ErrorCodeSchema, create(ErrorCodeSchema, {
              code: ERR.NOT_FOUND, detail: `unknown entity: ${body.entityId}`,
            }));
            down.send(forwardCallClient(MsgType.MSG_RESPONSE, body.connId, body.entityId, body.method, env.callbackId, err));
          }
          return;
        }
        const ctx: CallContext = { connId: body.connId };
        // 只入队、不等它跑完：同一实体的顺序由它的 Actor 队列保证；这里 await 只会让
        // 一个慢 handler 变成这条链路上后续帧的等待（而帧是各自分派的，等它没有意义）。
        void e.dispatch(body.method, body.content, ctx, needsReply, env.callbackId);
        return;
      }

      case 'gate.clientResponse': {
        const body = fromBinary(ClientResponseHubSchema, env.body);
        const e = entities.get(body.entityId);
        if (!e) {
          stats.unknownEntity++;
          return;
        }
        const status = body.error ? body.error.code : ERR.OK;
        e.onClientResponse(env.callbackId, status, body.content);
        return;
      }

      case 'gate.clientDisconnect': {
        const body = fromBinary(ClientDisconnectSchema, env.body);
        stats.disconnects++;
        if (body.entityId) {
          destroyEntity(body.entityId);
        }
        return;
      }

      case 'gate.clientUplink': {
        // 框架消息透传（logout / heartbeat / ack）。P0 只把 logout 的 reason 给业务，其余忽略。
        // 已知缺口：clientUplink 是原样透传，协议里没带 conn_id——要按连接定位时得改 logic_gate.proto
        // （连接的权威清理路径是 gate.clientDisconnect，logout 只是业务通知）。
        try {
          const up: ClientUplink = fromBinary(ClientUplinkSchema, env.body);
          if (up.body?.case === 'logout') {
            opts.onLogout?.(up.body.value.reason);
          }
        } catch {
          stats.badEnvelope++;
        }
        return;
      }

      case 'gate.clientReconnect':
        // 重连恢复（凭 resume_token 判定恢复/全量重建）——P0 计数不处理。
        return;

      default:
        // 未知路由方法：只有来自 gate 的固定集合才该出现在这条链路上
        stats.badEnvelope++;
        return;
    }
  }

  transport.onData((bytes) => {
    void dispatch(bytes);
  });

  return {
    nodeId,
    stats,
    createEntity,
    entityOf,
    destroyEntity,
    createGroup,
    groupOf,
    destroyGroup,
    global: global_,
    kick,
  };
}

export type LogicServer = ReturnType<typeof createLogicServer>;
