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
  HubClaimUserSchema,
} from './gen/logic_gate_pb';
import {
  GateForwardHubCallGlobalSchema,
  GateOwnerInfoSchema,
  HubCreatePlayerEntitySchema,
  HubKickOffClientSchema,
} from './gen/gate_logic_pb';
import { HubSessionReplacedSchema } from './gen/logic_logic_pb';
import { ErrorCodeSchema } from './gen/common_pb';
import { Entity, envelopeBytes, forwardCallClient, ERR, RpcError, type CallContext, type DestroyReason } from './entity';
import { Group, type ViewContent } from './group';

/** 传输层：与 rpc.ts 同形状——搬 envelope 字节，不认识帧（帧由 gatelink 处理）。 */
export interface Transport {
  send(bytes: Uint8Array): void;
  onData(cb: (bytes: Uint8Array) => void): void;
}

/**
 * 一条逻辑层 → gate 的链路。**一台 gate 一条**：逻辑节点可以同时连多台 gate
 * （每台都有一条 TCP），实体记住自己的连接在哪台上，下行据此选链路。
 */
export interface GateLink {
  /** gate 的名字（握手回包里由 gate 告知，见 gatelink.ts）。 */
  name: string;
  transport: Transport;
}

/**
 * 节点总线：节点之间的一次性通知（目前只有顶号）。用 NATS 的 `hub_{nodeId}_mq`——
 * 与 `entity_{id}_*_mq` 是同一套旁路，只是收件人从"实体所在节点"变成"某个节点"。
 */
export interface NodeBus {
  publish(subject: string, body: Uint8Array): void;
  /** 返回退订函数。 */
  subscribe(subject: string, onMessage: (body: Uint8Array) => void): () => void;
}

/** 节点总线上"你负责的那个会话已被接管"的 subject。 */
export function ticketSubject(nodeId: string): string {
  return `hub_${nodeId}_mq`;
}

/**
 * 一次会话目录占位的结果。
 *
 * `prev` 是**占位前**的主人（没有则 undefined）；`seq` 是本节点这次占到的序号——
 * 本节点记下它，之后用更大的 seq 挡掉迟到的跨节点接管通知。
 */
export interface ClaimResult {
  prev?: { nodeId: string; gateName: string; connId: string; entityId: string };
  seq: bigint;
}

/** 登录决策：业务给出玩家实体的标识与初始视图，或拒绝。 */
export type LoginResult =
  | { ok: true; userId: string; entityId: string; entityType: string; content: Uint8Array }
  | { ok: false; code: number; detail: string };

export interface LogicServerOptions {
  /** 已握手的 gate 链路（至少一台）。每台 gate 一条，名字来自握手回包。 */
  gates: GateLink[];
  nodeId: string;
  /**
   * 登录决策（token 校验、选角都在这里；返回 ok 即建实体）。
   * `ctx.gateName` 是这条连接所在的那台 gate（业务很少需要，但写日志/分区时有用）。
   */
  onLogin: (login: Login, ctx: { connId: string; gateName: string }) => LoginResult;
  /** 玩家实体建好、发完 createPlayerEntity 之后调用：业务在这里挂方法表。 */
  onPlayerCreate?: (player: Entity) => void;
  /**
   * 玩家实体销毁前调用（存档、退场景都在这里）。
   * `reason` 区分掉线与被顶号：`disconnect` = 连接断了；`replaced` = 同一账号在别处登录
   * （同节点复用的情形**不会**触发本钩子——对象还在）。
   */
  onPlayerDestroy?: (player: Entity, reason: DestroyReason) => void;
  /** 客户端主动登出（ClientUplink.logout 透传；**只带 reason**——conn 在协议里没有回传，真正的清理走 gate.clientDisconnect）。 */
  onLogout?: (reason: string) => void;
  /** 组视图内容（怎么把实体序列化给客户端看）。 */
  view?: ViewContent;
  /**
   * 节点总线（可选）。有它才做**跨节点**顶号：新登录落在别的节点时，通过目录找到旧节点，
   * 发一条 `HubSessionReplaced` 让它退役旧实体。没有它 = 单节点部署，行为与 S1 一致。
   */
  bus?: NodeBus;
}

export interface LogicServerStats {
  logins: number;
  /** 下行的目标 gate 不在 `gates` 里（配置漏了某台 gate / 握手还没完成）。 */
  unknownGate: number;
  /** 会话目录占位失败（Redis 不可用 / 超时）而被拒的登录。 */
  claimFailed: number;
  /** 因**跨节点**顶号而退役的本节点实体数。 */
  replacedByOther: number;
  /** 同一账号同角色重登录时复用旧对象的次数（内存状态因此没有丢）。 */
  rebinds: number;
  loginRejected: number;
  unknownEntity: number;
  badEnvelope: number;
  disconnects: number;
}

export function createLogicServer(opts: LogicServerOptions) {
  const { nodeId } = opts;
  const view: ViewContent = opts.view ?? (() => new Uint8Array(0));

  const entities = new Map<string, Entity>();
  /** userId → 玩家实体：顶号判定靠它（同一账号换了 entityId 也能找到旧对象）。 */
  const byUser = new Map<string, Entity>();
  const groups = new Map<string, Group>();
  const stats: LogicServerStats = {
    logins: 0, rebinds: 0, loginRejected: 0, unknownEntity: 0, badEnvelope: 0, disconnects: 0,
    unknownGate: 0, claimFailed: 0, replacedByOther: 0,
  };

  const links = new Map(opts.gates.map((g) => [g.name, g.transport]));

  /**
   * 下行：按 gate 名选链路。名字不认识时计数丢弃——这类错误只可能是配置漏了一台 gate，
   * 猜一个链路发出去会让客户端收到不是它连接的回包。
   */
  function sendToGate(gateName: string | undefined, bytes: Uint8Array): void {
    if (gateName === undefined) {
      stats.unknownGate++;
      return;
    }
    const t = links.get(gateName);
    if (!t) {
      stats.unknownGate++;
      return;
    }
    t.send(bytes);
  }
  const down = { send: sendToGate };

  // ---------------- 会话目录（占位） ----------------

  /** 在途的占位请求：callback_id → 等待方。回包是 `gate.ownerInfo`。 */
  const claimPending = new Map<
    number,
    { resolve: (r: ClaimResult) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }
  >();
  let nextClaimId = 1;
  /** 本节点给每个账号占到的 seq（挡迟到的跨节点接管通知）。 */
  const sessionSeq = new Map<string, bigint>();

  /**
   * 把用户占给本节点，返回**占位前**的主人（没有则 undefined）。
   *
   * 为什么问 gate：旧会话可能在别的 gate 上，只有共享目录知道它在哪；而认证只能由逻辑层做，
   * 所以这次查询发生在认证之后。目录未启用时 gate 回一个空结果，登录照常进行。
   */
  function claimUser(userId: string, entityId: string, gateName: string, connId: string): Promise<ClaimResult> {
    return new Promise((resolve, reject) => {
      const link = links.get(gateName);
      if (!link) {
        reject(new Error(`会话目录占位失败：不认识的 gate ${gateName}`));
        return;
      }
      const id = nextClaimId++;
      if (nextClaimId > 0xffffffff) nextClaimId = 1;
      const timer = setTimeout(() => {
        claimPending.delete(id);
        reject(new Error('会话目录占位超时（gate 没回 gate.ownerInfo）'));
      }, 3000);
      claimPending.set(id, { resolve, reject, timer });

      link.send(envelopeBytes(MsgType.MSG_REQUEST, 'hub.claimUser', id, 0,
        toBinary(HubClaimUserSchema, create(HubClaimUserSchema, { userId, entityId, connId }))));
    });
  }

  function onOwnerInfo(callbackId: number, status: number, body: Uint8Array): void {
    const p = claimPending.get(callbackId);
    if (!p) return; // 迟到 / 已超时：丢弃
    claimPending.delete(callbackId);
    if (p.timer) clearTimeout(p.timer);
    if (status !== 0) {
      p.reject(new RpcError('会话目录不可用', status));
      return;
    }
    const info = fromBinary(GateOwnerInfoSchema, body);
    p.resolve({
      prev: info.nodeId
        ? { nodeId: info.nodeId, gateName: info.gateName, connId: info.connId, entityId: info.entityId }
        : undefined,
      seq: info.seq,
    });
  }

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

  /** 某个账号当前的活实体（没有则 undefined）。 */
  function entityOfUser(userId: string): Entity | undefined {
    return byUser.get(userId);
  }

  /**
   * 销毁实体：退组 → 业务钩子（带原因）→ 清方法表与在途请求。
   * 幂等：实体已经不在表里时返回 false，钩子不会跑第二次。
   */
  function destroyEntity(id: string, reason: DestroyReason = 'disconnect'): boolean {
    const e = entities.get(id);
    if (!e) return false;
    for (const g of groups.values()) {
      g.leave(e);
    }
    opts.onPlayerDestroy?.(e, reason);
    e.destroy(reason);
    entities.delete(id);
    if (e.userId !== undefined && byUser.get(e.userId) === e) {
      byUser.delete(e.userId);
    }
    return true;
  }

  /** 通知 gate 绑定会话并下发 CreatePlayerEntity（登录成功与顶号复用共用）。 */
  function announcePlayer(gateName: string, connId: string, userId: string, entityId: string, entityType: string, content: Uint8Array): void {
    down.send(gateName, envelopeBytes(MsgType.MSG_NOTIFY, 'hub.createPlayerEntity', 0, 0,
      toBinary(HubCreatePlayerEntitySchema, create(HubCreatePlayerEntitySchema, {
        connId, userId, entityId, entityType, content,
      }))));
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
     * gate 只把它发给**自己**的全部客户端连接，所以这里要对每台 gate 各发一条。
     */
    rpcNotify(method: string, content: Uint8Array, from = ''): void {
      const bytes = envelopeBytes(MsgType.MSG_NOTIFY, 'gate.forwardHubCallGlobal', 0, 0,
        toBinary(GateForwardHubCallGlobalSchema, create(GateForwardHubCallGlobalSchema, {
          entityId: from, method, content,
        })));
      for (const gateName of links.keys()) {
        down.send(gateName, bytes);
      }
    },
  };

  // ---------------- 工具 ----------------

  /** 踢掉一条连接（登录拒绝 / 业务封禁）。 */
  function kick(connId: string, gateName: string, code: number, detail: string): void {
    down.send(gateName, envelopeBytes(MsgType.MSG_NOTIFY, 'hub.kickOffClient', 0, 0,
      toBinary(HubKickOffClientSchema, create(HubKickOffClientSchema, {
        connId,
        error: create(ErrorCodeSchema, { code, detail }),
        promptInfo: detail,
      }))));
  }

  // ---------------- 上行分派 ----------------

  async function dispatch(bytes: Uint8Array, fromGate: string): Promise<void> {
    let env;
    try {
      env = fromBinary(EnvelopeSchema, bytes);
    } catch {
      stats.badEnvelope++;
      return;
    }

    // 会话目录的占位回包：按 callback_id 配对在途的 claimUser
    if (env.msgType === MsgType.MSG_RESPONSE && env.method === 'gate.ownerInfo') {
      onOwnerInfo(env.callbackId, env.status, env.body);
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
          kick(fwd.connId, fwd.gateName || fromGate, ERR.BAD_FRAME, 'login body 解不开');
          return;
        }
        // 登录消息自己带 gate_name（客户端在"哪台 gate 的哪条连接上"），以它为准；
        // 老客户端/测试没填时退回到"这条链路对应的 gate"。
        const gateName = fwd.gateName || fromGate;
        const decision = opts.onLogin(login, { connId: fwd.connId, gateName });
        if (!decision.ok) {
          stats.loginRejected++;
          kick(fwd.connId, gateName, decision.code, decision.detail);
          return;
        }

        // ---- 会话归属：先占位，再决定复用/退役/新建 ----
        // 认证只能由逻辑层做，所以"这个用户归谁"的查询只能发生在这里；占位本身由 gate
        // 用一条 Lua 完成（跨节点并发登录只有一个赢家拿到旧记录）。
        let claim: ClaimResult;
        try {
          claim = await claimUser(decision.userId, decision.entityId, gateName, fwd.connId);
          sessionSeq.set(decision.userId, claim.seq);
        } catch (e) {
          // 目录是"不能有两个写者"的前提：占位失败就不能装作登录成功。
          stats.claimFailed++;
          kick(fwd.connId, gateName, ERR.UNKNOWN, e instanceof Error ? e.message : String(e));
          return;
        }
        const prev = claim.prev;
        if (prev && prev.nodeId !== nodeId && opts.bus) {
          // 旧实体还在**别的节点**上：通知它退役（它自己踢旧连接 + 跑 destroyed 钩子）。
          // 状态不搬（存储模块还没写），所以跨节点是"退役 + 重建"。
          opts.bus.publish(ticketSubject(prev.nodeId), envelopeBytes(MsgType.MSG_NOTIFY, 'hub.sessionReplaced', 0, 0,
            toBinary(HubSessionReplacedSchema, create(HubSessionReplacedSchema, {
              userId: decision.userId,
              entityId: prev.entityId,
              gateName: prev.gateName,
              connId: prev.connId,
              seq: claim.seq,
            }))));
        }

        // ---- 顶号判定（规则见 core/SPEC.md「会话与顶号」）----
        // ① 同一 userId 且同一 entityId：这是同一个人重新连上来，**复用旧对象**（内存状态不丢），
        //    只换 connId 并重发 createPlayerEntity。旧连接由 gate 挤掉。
        const sameId = entities.get(decision.entityId);
        if (sameId && sameId.userId === decision.userId) {
          sameId.rebind(fwd.connId, gateName);
          stats.rebinds++;
          announcePlayer(gateName, fwd.connId, decision.userId, sameId.id, sameId.type, decision.content);
          stats.logins++;
          return;
        }

        // ② 同一 userId 但实体 id 变了（换角色 / 业务每次登录都发新 id）：旧对象不能被复用，
        //    否则它在组里、在途请求里继续当第二个写者。先退役，再建。
        const sameUser = byUser.get(decision.userId);
        if (sameUser && sameUser.id !== decision.entityId) {
          destroyEntity(sameUser.id, 'replaced');
        }
        // ③ 目标 entityId 被另一个账号占着：同样先退役（id 是地址，不能让两个账号抢）。
        if (sameId && sameId.userId !== decision.userId) {
          destroyEntity(sameId.id, 'replaced');
        }

        const player = new Entity(decision.entityId, decision.entityType, down, {
          connId: fwd.connId, gateName, userId: decision.userId,
        });
        entities.set(decision.entityId, player);
        byUser.set(decision.userId, player);
        // 先建实体再通知 gate 绑会话：绑完 gate 就开始把该连接的上行路由过来，
        // 实体必须先就位（方法表在 onPlayerCreate 里挂）。
        opts.onPlayerCreate?.(player);
        announcePlayer(gateName, fwd.connId, decision.userId, decision.entityId, decision.entityType, decision.content);
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
            down.send(fromGate, forwardCallClient(MsgType.MSG_RESPONSE, body.connId, body.entityId, body.method, env.callbackId, err));
          }
          return;
        }
        const ctx: CallContext = { connId: body.connId, gateName: fromGate };
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
          // 错误码 4 = DUPLICATE_LOGIN：这条断开是顶号引起的，不是掉线。
          const reason: DestroyReason = body.error?.code === ERR.DUPLICATE_LOGIN ? 'replaced' : 'disconnect';
          destroyEntity(body.entityId, reason);
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

  // ---------------- 节点总线：跨节点顶号 ----------------

  /**
   * 收到"你负责的那个会话已被接管"：踢掉旧连接，让旧实体退役。
   *
   * 只认 seq 更大的通知——跨节点并发登录时会有多条通知在路上，迟到的必须被忽略，
   * 否则会把刚建好的新会话又踢一次。
   */
  function onSessionReplaced(m: {
    userId: string;
    entityId: string;
    gateName: string;
    connId: string;
    seq: bigint;
  }): void {
    const local = sessionSeq.get(m.userId) ?? 0n;
    if (m.seq <= local) return;
    sessionSeq.set(m.userId, m.seq);

    const e = entities.get(m.entityId) ?? byUser.get(m.userId);
    if (!e) return; // 已经退役过了
    stats.replacedByOther++;
    // 用**它自己的** gate 链路踢旧连接：conn_id 只在所属 gate 内有意义。
    if (e.connId !== undefined && e.gateName !== undefined) {
      kick(e.connId, e.gateName, ERR.DUPLICATE_LOGIN, '该账号已在别处登录');
    }
    destroyEntity(e.id, 'replaced');
  }

  async function onNodeMessage(body: Uint8Array): Promise<void> {
    let env;
    try {
      env = fromBinary(EnvelopeSchema, body);
    } catch {
      stats.badEnvelope++;
      return;
    }
    if (env.method !== 'hub.sessionReplaced') {
      stats.badEnvelope++;
      return;
    }
    onSessionReplaced(fromBinary(HubSessionReplacedSchema, env.body));
  }

  const disposeBus = opts.bus?.subscribe(ticketSubject(nodeId), (body) => {
    void onNodeMessage(body);
  });

  for (const gate of opts.gates) {
    gate.transport.onData((bytes) => {
      void dispatch(bytes, gate.name);
    });
  }

  return {
    nodeId,
    stats,
    createEntity,
    entityOf,
    entityOfUser,
    destroyEntity,
    createGroup,
    groupOf,
    destroyGroup,
    global: global_,
    kick,
    /** 退订节点总线（测试与优雅退出用）。 */
    dispose: () => disposeBus?.(),
  };
}

export type LogicServer = ReturnType<typeof createLogicServer>;
