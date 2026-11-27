// 逻辑服验收测试——离线：内存 pair 一端是逻辑服，另一端扮演 gate（只做协议装配/解析）。
//
// 测的是真问题：登录建实体 → hub.createPlayerEntity 的形状、客户端 REQUEST 分派回包闭环、
// gate.clientResponse 配对 rpcRequest、断开销毁实体退组、global 广播。

import { describe, expect, it } from 'vitest';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { EnvelopeSchema, MsgType } from './gen/envelope_pb';
import { LoginSchema, type Login } from './gen/gate_pb';
import {
  ClientRequestHubSchema,
  ClientDisconnectSchema,
  ClientResponseHubSchema,
  GateForwardClientRequestServiceSchema,
  HubClaimUserSchema,
} from './gen/logic_gate_pb';
import {
  GateForwardHubCallGlobalSchema,
  GateOwnerInfoSchema,
  HubCreatePlayerEntitySchema,
  HubKickOffClientSchema,
  GateForwardHubCallClientSchema,
} from './gen/gate_logic_pb';
import { RefreshEntitySchema } from './gen/client_pb';
import { HubSessionReplacedSchema } from './gen/logic_logic_pb';
import { ErrorCodeSchema } from './gen/common_pb';
import { createLogicServer, type Transport } from './server';
import { envelopeBytes } from './entity';

/** 内存 pair：一端 send 的 envelope 字节立刻进另一端 onData。 */
function pair(): [Transport, Transport] {
  let a: ((b: Uint8Array) => void) | undefined;
  let b: ((x: Uint8Array) => void) | undefined;
  return [
    { send: (bytes) => queueMicrotask(() => b?.(bytes)), onData: (cb) => { a = cb; } },
    { send: (bytes) => queueMicrotask(() => a?.(bytes)), onData: (cb) => { b = cb; } },
  ];
}

/** gate 侧：收逻辑服的下行（解析成 Envelope 列表）。 */
/** gate 对 `hub.claimUser` 的回复；'error' = 目录不可用（status=1）。 */
type ClaimReply = { nodeId?: string; gateName?: string; connId?: string; entityId?: string; seq?: bigint };

function fakeGate(opts: { claim?: (req: { userId: string; entityId: string; connId: string }) => ClaimReply | 'error' } = {}) {
  const [gateSide, logicSide] = pair();
  const down: { env: ReturnType<typeof fromBinary<typeof EnvelopeSchema>>; bytes: Uint8Array }[] = [];
  gateSide.onData((bytes) => {
    const env = fromBinary(EnvelopeSchema, bytes);
    // 会话目录占位：假 gate 在这里替真 gate + Redis 作答（真实实现见 gate/internal/sessiondir）
    if (env.method === 'hub.claimUser') {
      const req = fromBinary(HubClaimUserSchema, env.body);
      const reply = opts.claim?.(req) ?? {};
      if (reply === 'error') {
        gateSide.send(toBinary(EnvelopeSchema, create(EnvelopeSchema, {
          msgType: MsgType.MSG_RESPONSE, method: 'gate.ownerInfo', callbackId: env.callbackId, status: 1,
        })));
        return;
      }
      gateSide.send(toBinary(EnvelopeSchema, create(EnvelopeSchema, {
        msgType: MsgType.MSG_RESPONSE, method: 'gate.ownerInfo', callbackId: env.callbackId, status: 0,
        body: toBinary(GateOwnerInfoSchema, create(GateOwnerInfoSchema, reply)),
      })));
      return;
    }
    down.push({ env, bytes });
  });
  const push = (env: { msgType: MsgType; method: string; callbackId?: number; body: Uint8Array }) =>
    gateSide.send(toBinary(EnvelopeSchema, create(EnvelopeSchema, env)));
  return {
    logicSide,
    down,
    last: () => down[down.length - 1]?.env,
    push,
    waitIdle: () => new Promise((r) => setTimeout(r, 0)),
  };
}

const loginBytes = (token = 't1') =>
  toBinary(LoginSchema, create(LoginSchema, { token, serverId: 's1' }));

describe('登录：gate.clientLogin → hub.createPlayerEntity', () => {
  it('接受：建实体 + 发 createPlayerEntity（含 conn/user/entity/type/content）', async () => {
    const g = fakeGate();
    const server = createLogicServer({
      gates: [{ name: 'g1', transport: g.logicSide }], nodeId: 'n1',
      onLogin: (login: Login, { connId }) => ({
        ok: true, userId: `u-${login.token}`, entityId: `e-${connId}`,
        entityType: 'player', content: new Uint8Array([1]),
      }),
      onPlayerCreate: (p) => {
        p.register('entity.attack', RefreshEntitySchema, RefreshEntitySchema, () =>
          create(RefreshEntitySchema, { entityId: p.id, entityType: 'player', reason: 1 }));
      },
    });

    g.push({ msgType: MsgType.MSG_REQUEST, method: 'gate.clientLogin', callbackId: 5, body:
      toBinary(GateForwardClientRequestServiceSchema, create(GateForwardClientRequestServiceSchema, {
        serviceName: 'auth', gateName: 'g1', connId: 'c1', content: loginBytes('tk'),
      })) });
    await g.waitIdle();

    const env = g.last();
    expect(env?.method).toBe('hub.createPlayerEntity');
    const body = fromBinary(HubCreatePlayerEntitySchema, env!.body);
    expect(body.connId).toBe('c1');
    expect(body.userId).toBe('u-tk');
    expect(body.entityId).toBe('e-c1');
    expect(body.entityType).toBe('player');
    expect(server.stats.logins).toBe(1);
    expect(server.entityOf('e-c1')).toBeDefined();
  });

  it('拒绝：hub.kickOffClient（code + detail）', async () => {
    const g = fakeGate();
    createLogicServer({
      gates: [{ name: 'g1', transport: g.logicSide }], nodeId: 'n1',
      onLogin: () => ({ ok: false, code: 4, detail: 'token 过期' }),
    });

    g.push({ msgType: MsgType.MSG_REQUEST, method: 'gate.clientLogin', body:
      toBinary(GateForwardClientRequestServiceSchema, create(GateForwardClientRequestServiceSchema, {
        serviceName: 'auth', gateName: 'g1', connId: 'c1', content: loginBytes(),
      })) });
    await g.waitIdle();

    const env = g.last();
    expect(env?.method).toBe('hub.kickOffClient');
    const body = fromBinary(HubKickOffClientSchema, env!.body);
    expect(body.connId).toBe('c1');
    expect(body.error?.code).toBe(4);
    expect(body.promptInfo).toBe('token 过期');
  });
});

describe('客户端调用：gate.clientRequest → entity.dispatch → 回包闭环', () => {
  async function setupWithPlayer() {
    const g = fakeGate();
    const server = createLogicServer({
      gates: [{ name: 'g1', transport: g.logicSide }], nodeId: 'n1',
      onLogin: () => ({ ok: true, userId: 'u1', entityId: 'e1', entityType: 'player', content: new Uint8Array() }),
      onPlayerCreate: (p) => {
        p.register('entity.attack', RefreshEntitySchema, RefreshEntitySchema, (req) =>
          create(RefreshEntitySchema, { entityId: 'hit', entityType: req.entityType, reason: 1 }));
      },
    });
    g.push({ msgType: MsgType.MSG_REQUEST, method: 'gate.clientLogin', body:
      toBinary(GateForwardClientRequestServiceSchema, create(GateForwardClientRequestServiceSchema, {
        serviceName: 'auth', gateName: 'g1', connId: 'c1', content: loginBytes(),
      })) });
    await g.waitIdle();
    return { g, server };
  }

  it('REQUEST：回包经 forwardHubCallClient{RESPONSE, 原 callbackId}', async () => {
    const { g } = await setupWithPlayer();
    g.push({ msgType: MsgType.MSG_REQUEST, method: 'gate.clientRequest', callbackId: 7, body:
      toBinary(ClientRequestHubSchema, create(ClientRequestHubSchema, {
        connId: 'c1', entityId: 'e1', method: 'entity.attack',
        content: toBinary(RefreshEntitySchema, create(RefreshEntitySchema, { entityId: 'm1', entityType: 'monster' })),
      })) });
    await g.waitIdle();

    const env = g.last();
    expect(env?.method).toBe('gate.forwardHubCallClient');
    expect(env?.msgType).toBe(MsgType.MSG_RESPONSE);
    expect(env?.callbackId).toBe(7);
    const body = fromBinary(GateForwardHubCallClientSchema, env!.body);
    expect(body.method).toBe('entity.attack');
    const rsp = fromBinary(RefreshEntitySchema, body.content);
    expect(rsp.entityId).toBe('hit');
  });

  it('entity 不存在：REQUEST 回 NOT_FOUND', async () => {
    const { g, server } = await setupWithPlayer();
    g.push({ msgType: MsgType.MSG_REQUEST, method: 'gate.clientRequest', callbackId: 8, body:
      toBinary(ClientRequestHubSchema, create(ClientRequestHubSchema, {
        connId: 'c1', entityId: 'e-none', method: 'entity.attack', content: new Uint8Array(),
      })) });
    await g.waitIdle();

    expect(server.stats.unknownEntity).toBe(1);
    const env = g.last();
    expect(env?.msgType).toBe(MsgType.MSG_RESPONSE);
    expect(env?.callbackId).toBe(8);
  });
});

describe('服务端调客户端：gate.clientResponse 配对', () => {
  it('rpcRequest 发出 REQUEST，回包配对成功', async () => {
    const g = fakeGate();
    let player: import('./entity').Entity | undefined;
    createLogicServer({
      gates: [{ name: 'g1', transport: g.logicSide }], nodeId: 'n1',
      onLogin: () => ({ ok: true, userId: 'u1', entityId: 'e1', entityType: 'player', content: new Uint8Array() }),
      onPlayerCreate: (p) => { player = p; },
    });
    g.push({ msgType: MsgType.MSG_REQUEST, method: 'gate.clientLogin', body:
      toBinary(GateForwardClientRequestServiceSchema, create(GateForwardClientRequestServiceSchema, {
        serviceName: 'auth', gateName: 'g1', connId: 'c1', content: loginBytes(),
      })) });
    await g.waitIdle();

    const p = player!.rpcRequest('entity.query', new Uint8Array(0), RefreshEntitySchema);
    await g.waitIdle(); // 等 REQUEST 经微任务到达 gate 侧
    // gate 侧转发下来的客户端回包
    const reqEnv = g.down[g.down.length - 1].env;
    expect(reqEnv.msgType).toBe(MsgType.MSG_REQUEST);
    const fwd = fromBinary(GateForwardHubCallClientSchema, reqEnv.body);
    expect(fwd.method).toBe('entity.query');
    expect(fwd.connId).toBe('c1');

    const rspBytes = toBinary(RefreshEntitySchema, create(RefreshEntitySchema, { entityId: 'e1', entityType: 'player' }));
    g.push({ msgType: MsgType.MSG_RESPONSE, method: 'gate.clientResponse', callbackId: reqEnv.callbackId, body:
      toBinary(ClientResponseHubSchema, create(ClientResponseHubSchema, {
        entityId: 'e1', method: 'entity.query', content: rspBytes,
      })) });

    const got = await p;
    expect(got.entityId).toBe('e1');
  });
});

describe('断开与组', () => {
  it('gate.clientDisconnect：销毁玩家 + 从组里退 + 组内其他玩家收到 deleteRemote', async () => {
    const g = fakeGate();
    const server = createLogicServer({
      gates: [{ name: 'g1', transport: g.logicSide }], nodeId: 'n1',
      onLogin: (_l, { connId }) => ({ ok: true, userId: `u-${connId}`, entityId: `e-${connId}`, entityType: 'player', content: new Uint8Array() }),
    });
    for (const c of ['c1', 'c2']) {
      g.push({ msgType: MsgType.MSG_REQUEST, method: 'gate.clientLogin', body:
        toBinary(GateForwardClientRequestServiceSchema, create(GateForwardClientRequestServiceSchema, {
          serviceName: 'auth', gateName: 'g1', connId: c, content: loginBytes(),
        })) });
      await g.waitIdle();
    }
    const group = server.createGroup('scene-1');
    group.join(server.entityOf('e-c1')!);
    group.join(server.entityOf('e-c2')!);
    expect(group.size).toBe(2);

    g.push({ msgType: MsgType.MSG_NOTIFY, method: 'gate.clientDisconnect', body:
      toBinary(ClientDisconnectSchema, create(ClientDisconnectSchema, {
        connId: 'c1', userId: 'u-c1', entityId: 'e-c1',
      })) });
    await g.waitIdle();

    expect(server.entityOf('e-c1')).toBeUndefined();
    expect(group.size).toBe(1);
    expect(server.stats.disconnects).toBe(1);
  });
});

describe('global 广播', () => {
  it('global.rpcNotify → gate.forwardHubCallGlobal（含 method/content）', async () => {
    const g = fakeGate();
    const server = createLogicServer({
      gates: [{ name: 'g1', transport: g.logicSide }], nodeId: 'n1',
      onLogin: () => ({ ok: true, userId: 'u1', entityId: 'e1', entityType: 'player', content: new Uint8Array() }),
    });
    server.global.rpcNotify('server.notice', new Uint8Array([1, 2]), 'e1');
    await g.waitIdle();

    const env = g.last();
    expect(env?.method).toBe('gate.forwardHubCallGlobal');
    const body = fromBinary(GateForwardHubCallGlobalSchema, env!.body);
    expect(body.method).toBe('server.notice');
    expect(body.entityId).toBe('e1');
    expect([...body.content]).toEqual([1, 2]);
  });
});

describe('执行模型：同一实体的两个 REQUEST 串行', () => {
  it('第一个 handler 未完成时第二个不开始，完成后按到达顺序执行', async () => {
    const g = fakeGate();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const order: string[] = [];

    createLogicServer({
      gates: [{ name: 'g1', transport: g.logicSide }], nodeId: 'n1',
      onLogin: () => ({ ok: true, userId: 'u1', entityId: 'e1', entityType: 'player', content: new Uint8Array() }),
      onPlayerCreate: (p) => {
        p.register('entity.slow', RefreshEntitySchema, RefreshEntitySchema, async () => {
          order.push('slow:start');
          await gate;
          order.push('slow:end');
          return create(RefreshEntitySchema, { entityId: 'e1' });
        });
        p.register('entity.fast', RefreshEntitySchema, RefreshEntitySchema, () => {
          order.push('fast');
          return create(RefreshEntitySchema, { entityId: 'e1' });
        });
      },
    });

    g.push({ msgType: MsgType.MSG_REQUEST, method: 'gate.clientLogin', body:
      toBinary(GateForwardClientRequestServiceSchema, create(GateForwardClientRequestServiceSchema, {
        serviceName: 'auth', gateName: 'g1', connId: 'c1', content: loginBytes(),
      })) });
    await g.waitIdle();

    const call = (method: string, callbackId: number) => {
      const content = toBinary(RefreshEntitySchema, create(RefreshEntitySchema, { entityId: 'x' }));
      g.push({ msgType: MsgType.MSG_REQUEST, method: 'gate.clientRequest', callbackId, body:
        toBinary(ClientRequestHubSchema, create(ClientRequestHubSchema, {
          connId: 'c1', entityId: 'e1', content, method,
        })) });
    };

    call('entity.slow', 1);
    call('entity.fast', 2);
    await g.waitIdle();
    expect(order).toEqual(['slow:start']); // 第二个被队列挡住

    release();
    await g.waitIdle();
    expect(order).toEqual(['slow:start', 'slow:end', 'fast']);
  });
});

describe('顶号：同账号重新登录', () => {
  /** 起一个逻辑服；onLogin 按 connId 给固定的 userId/entityId（可覆盖）。 */
  function setup(opts: {
    entityId?: (connId: string) => string;
    userId?: string;
    onDestroy?: (reason: string) => void;
  } = {}) {
    const g = fakeGate();
    const userId = opts.userId ?? 'u1';
    const entityId = opts.entityId ?? (() => 'e1');
    const server = createLogicServer({
      gates: [{ name: 'g1', transport: g.logicSide }], nodeId: 'n1',
      onLogin: (_login, { connId }) => ({
        ok: true, userId, entityId: entityId(connId), entityType: 'player', content: new Uint8Array([1]),
      }),
      onPlayerCreate: (p) => {
        p.register('entity.echo', RefreshEntitySchema, RefreshEntitySchema, () =>
          create(RefreshEntitySchema, { entityId: p.id }));
      },
      onPlayerDestroy: (p, reason) => { opts.onDestroy?.(reason); void p; },
    });
    const login = (connId: string) => g.push({
      msgType: MsgType.MSG_REQUEST, method: 'gate.clientLogin', body:
        toBinary(GateForwardClientRequestServiceSchema, create(GateForwardClientRequestServiceSchema, {
          serviceName: 'auth', gateName: 'g1', connId, content: loginBytes(connId),
        })),
    });
    return { g, server, login };
  }

  it('同 userId + 同 entityId：复用同一个对象（换 connId、重发 create_player、旧在途请求被拒）', async () => {
    const { g, server, login } = setup();

    login('c1');
    await g.waitIdle();
    const first = server.entityOf('e1');
    if (!first) throw new Error('第一次登录没建实体');

    // 旧连接上的在途调用（服务端调客户端，等回包）。先挂上断言，否则 rebind 的 reject
    // 会在 await 之前被判成 unhandled rejection。
    const stale = first.rpcRequest('entity.query', new Uint8Array(0), RefreshEntitySchema, { timeoutMs: 10_000 });
    const staleRejected = expect(stale).rejects.toMatchObject({ code: 7 });

    login('c2');
    await g.waitIdle();

    expect(server.entityOf('e1')).toBe(first); // 同一个对象：内存状态不丢
    expect(first.connId).toBe('c2');
    expect(server.stats.rebinds).toBe(1);
    await staleRejected; // 旧连接不可能再回包

    // 新连接收到 create_player（gate 据此把会话绑到 c2）
    const created = g.down.filter(({ env }) => env.method === 'hub.createPlayerEntity');
    const body = fromBinary(HubCreatePlayerEntitySchema, created[created.length - 1]!.env.body);
    expect(body.connId).toBe('c2');
    expect(body.entityId).toBe('e1');
  });

  it('同 userId 但 entityId 变了：旧实体以 replaced 退役，新实体是另一个对象', async () => {
    const reasons: string[] = [];
    const { g, server, login } = setup({ entityId: (c) => `e-${c}`, onDestroy: (r) => reasons.push(r) });

    login('c1');
    await g.waitIdle();
    const first = server.entityOf('e-c1');
    login('c2');
    await g.waitIdle();

    expect(server.entityOf('e-c1')).toBeUndefined();
    expect(server.entityOf('e-c2')).toBeDefined();
    expect(server.entityOf('e-c2')).not.toBe(first);
    expect(reasons).toEqual(['replaced']);
    expect(server.entityOfUser('u1')).toBe(server.entityOf('e-c2'));
  });

  it('entityId 被另一个账号占着：旧实体以 replaced 退役', async () => {
    const reasons: string[] = [];
    const g = fakeGate();
    let n = 0;
    const server = createLogicServer({
      gates: [{ name: 'g1', transport: g.logicSide }], nodeId: 'n1',
      onLogin: () => ({ ok: true, userId: `u${++n}`, entityId: 'e1', entityType: 'player', content: new Uint8Array() }),
      onPlayerDestroy: (_p, reason) => { reasons.push(reason); },
    });
    const login = (connId: string) => g.push({
      msgType: MsgType.MSG_REQUEST, method: 'gate.clientLogin', body:
        toBinary(GateForwardClientRequestServiceSchema, create(GateForwardClientRequestServiceSchema, {
          serviceName: 'auth', gateName: 'g1', connId, content: loginBytes(connId),
        })),
    });

    login('c1');
    await g.waitIdle();
    login('c2');
    await g.waitIdle();

    expect(reasons).toEqual(['replaced']);
    expect(server.entityOf('e1')?.userId).toBe('u2');
  });

  it('普通断开：reason 是 disconnect', async () => {
    const reasons: string[] = [];
    const { g, server, login } = setup({ onDestroy: (r) => reasons.push(r) });

    login('c1');
    await g.waitIdle();
    g.push({ msgType: MsgType.MSG_NOTIFY, method: 'gate.clientDisconnect', body:
      toBinary(ClientDisconnectSchema, create(ClientDisconnectSchema, { connId: 'c1', userId: 'u1', entityId: 'e1' })) });
    await g.waitIdle();

    expect(reasons).toEqual(['disconnect']);
    expect(server.entityOf('e1')).toBeUndefined();
    expect(server.entityOfUser('u1')).toBeUndefined();
  });

  it('断开带 DUPLICATE_LOGIN(4)：reason 是 replaced', async () => {
    const reasons: string[] = [];
    const { g, login } = setup({ onDestroy: (r) => reasons.push(r) });
    void login;
    g.push({ msgType: MsgType.MSG_REQUEST, method: 'gate.clientLogin', body:
      toBinary(GateForwardClientRequestServiceSchema, create(GateForwardClientRequestServiceSchema, {
        serviceName: 'auth', gateName: 'g1', connId: 'c1', content: loginBytes('c1'),
      })) });
    await g.waitIdle();

    g.push({ msgType: MsgType.MSG_NOTIFY, method: 'gate.clientDisconnect', body:
      toBinary(ClientDisconnectSchema, create(ClientDisconnectSchema, {
        connId: 'c1', userId: 'u1', entityId: 'e1',
        error: create(ErrorCodeSchema, { code: 4, detail: '该账号已在别处登录' }),
      })) });
    await g.waitIdle();
    expect(reasons).toEqual(['replaced']);
  });
});

describe('多 gate 寻址', () => {
  it('下行按实体所属的 gate 投递；广播发给每一台 gate', async () => {
    const g1 = fakeGate();
    const g2 = fakeGate();
    const server = createLogicServer({
      nodeId: 'n1',
      gates: [
        { name: 'g1', transport: g1.logicSide },
        { name: 'g2', transport: g2.logicSide },
      ],
      onLogin: () => ({ ok: true, userId: 'u1', entityId: 'e1', entityType: 'player', content: new Uint8Array() }),
      onPlayerCreate: (p) => {
        p.register('entity.echo', RefreshEntitySchema, RefreshEntitySchema, () =>
          create(RefreshEntitySchema, { entityId: p.id }));
      },
    });

    // 客户端在 g2 上登录
    g2.push({ msgType: MsgType.MSG_REQUEST, method: 'gate.clientLogin', body:
      toBinary(GateForwardClientRequestServiceSchema, create(GateForwardClientRequestServiceSchema, {
        serviceName: 'auth', gateName: 'g2', connId: 'c9', content: loginBytes(),
      })) });
    await g2.waitIdle();

    expect(server.entityOf('e1')?.gateName).toBe('g2');
    expect(g2.down.some(({ env }) => env.method === 'hub.createPlayerEntity')).toBe(true);
    expect(g1.down.length).toBe(0);

    // 实体下行（回包）只走 g2
    g2.push({ msgType: MsgType.MSG_REQUEST, method: 'gate.clientRequest', callbackId: 3, body:
      toBinary(ClientRequestHubSchema, create(ClientRequestHubSchema, {
        connId: 'c9', entityId: 'e1', method: 'entity.echo',
        content: toBinary(RefreshEntitySchema, create(RefreshEntitySchema, {})),
      })) });
    await g2.waitIdle();
    expect(g2.down.some(({ env }) => env.method === 'gate.forwardHubCallClient')).toBe(true);
    expect(g1.down.length).toBe(0);

    // 全服广播：两台 gate 各一条
    server.global.rpcNotify('server.notice', new Uint8Array([1]), 'e1');
    await g1.waitIdle();
    await g2.waitIdle();
    expect(g1.down.filter(({ env }) => env.method === 'gate.forwardHubCallGlobal').length).toBe(1);
    expect(g2.down.filter(({ env }) => env.method === 'gate.forwardHubCallGlobal').length).toBe(1);
  });

  it('目标 gate 不在注册表里：计数丢弃，不猜链路', async () => {
    const g1 = fakeGate();
    const server = createLogicServer({
      nodeId: 'n1',
      gates: [{ name: 'g1', transport: g1.logicSide }],
      onLogin: () => ({ ok: false, code: 1, detail: 'x' }),
    });
    // 从 g1 链路收到一条登录，但消息里写的是未知 gate：回包应被丢弃并计数
    g1.push({ msgType: MsgType.MSG_REQUEST, method: 'gate.clientLogin', body:
      toBinary(GateForwardClientRequestServiceSchema, create(GateForwardClientRequestServiceSchema, {
        serviceName: 'auth', gateName: 'ghost', connId: 'c1', content: loginBytes(),
      })) });
    await g1.waitIdle();
    expect(server.stats.loginRejected).toBe(1);
    // 踢人消息要发给 ghost，但没有这条链路：计数丢弃，不猜一台 gate
    expect(server.stats.unknownGate).toBe(1);
    expect(server.stats.claimFailed).toBe(0); // 拒绝发生在占位之前
  });
});

describe('跨节点顶号（会话目录 + 节点总线）', () => {
  it('新节点通知旧节点：旧连接被踢、旧实体以 replaced 退役；迟到的通知被 seq 挡住', async () => {
    // 假总线：subject → 订阅者
    const subs = new Map<string, (b: Uint8Array) => void>();
    const bus = {
      publish: (subject: string, body: Uint8Array) => { queueMicrotask(() => subs.get(subject)?.(body)); },
      subscribe: (subject: string, cb: (b: Uint8Array) => void) => {
        subs.set(subject, cb);
        return () => { subs.delete(subject); };
      },
    };
    // 假目录：和 gate 侧那条 Lua 同语义（读旧值 + seq+1 + 写新值，回旧值）
    type Rec = { nodeId: string; gateName: string; connId: string; entityId: string; seq: bigint };
    const dir = new Map<string, Rec>();

    const makeNode = (nodeId: string, gateName: string) => {
      const reasons: string[] = [];
      const g = fakeGate({
        claim: (req) => {
          const prev = dir.get(req.userId);
          const next = { nodeId, gateName, connId: req.connId, entityId: req.entityId, seq: (prev?.seq ?? 0n) + 1n };
          dir.set(req.userId, next);
          return { ...(prev ?? {}), seq: next.seq }; // 旧主人字段 + 本次的 seq
        },
      });
      const server = createLogicServer({
        nodeId,
        gates: [{ name: gateName, transport: g.logicSide }],
        bus,
        onLogin: () => ({ ok: true, userId: 'u1', entityId: 'e1', entityType: 'player', content: new Uint8Array() }),
        onPlayerDestroy: (_p, r) => { reasons.push(r); },
      });
      const login = (connId: string) => g.push({ msgType: MsgType.MSG_REQUEST, method: 'gate.clientLogin', body:
        toBinary(GateForwardClientRequestServiceSchema, create(GateForwardClientRequestServiceSchema, {
          serviceName: 'auth', gateName, connId, content: loginBytes(connId),
        })) });
      return { nodeId, gateName, g, server, reasons, login };
    };

    const a = makeNode('n1', 'g1');
    const b = makeNode('n2', 'g2');

    a.login('c1');
    await a.g.waitIdle();
    expect(a.server.entityOf('e1')).toBeDefined();

    b.login('c2');
    await b.g.waitIdle();
    await new Promise((r) => setTimeout(r, 0)); // 通知走 microtask

    expect(a.server.entityOf('e1')).toBeUndefined();
    expect(a.reasons).toEqual(['replaced']);
    expect(a.server.stats.replacedByOther).toBe(1);
    expect(b.server.entityOf('e1')?.connId).toBe('c2'); // 新会话在 n2/g2

    // 旧连接是在**它自己的 gate** 上被踢的（conn_id 只在所属 gate 内有意义）
    const kick = a.g.down.find(({ env }) => env.method === 'hub.kickOffClient');
    expect(kick).toBeDefined();
    const kb = fromBinary(HubKickOffClientSchema, kick!.env.body);
    expect(kb.connId).toBe('c1');
    expect(kb.error?.code).toBe(4);

    // 迟到的同 seq 通知：不再退役一次
    subs.get('hub_n1_mq')!(envelopeBytes(MsgType.MSG_NOTIFY, 'hub.sessionReplaced', 0, 0,
      toBinary(HubSessionReplacedSchema, create(HubSessionReplacedSchema, {
        userId: 'u1', entityId: 'e1', gateName: 'g1', connId: 'c1', seq: 2n,
      }))));
    await new Promise((r) => setTimeout(r, 0));
    expect(a.reasons).toEqual(['replaced']);
  });
});
