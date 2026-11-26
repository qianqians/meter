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
} from './gen/logic_gate_pb';
import {
  GateForwardHubCallGlobalSchema,
  HubCreatePlayerEntitySchema,
  HubKickOffClientSchema,
  GateForwardHubCallClientSchema,
} from './gen/gate_logic_pb';
import { RefreshEntitySchema } from './gen/client_pb';
import { createLogicServer, type Transport } from './server';

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
function fakeGate() {
  const [gateSide, logicSide] = pair();
  const down: { env: ReturnType<typeof fromBinary<typeof EnvelopeSchema>>; bytes: Uint8Array }[] = [];
  gateSide.onData((bytes) => down.push({ env: fromBinary(EnvelopeSchema, bytes), bytes }));
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
      transport: g.logicSide, nodeId: 'n1',
      onLogin: (login: Login, connId) => ({
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
      transport: g.logicSide, nodeId: 'n1',
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
      transport: g.logicSide, nodeId: 'n1',
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
      transport: g.logicSide, nodeId: 'n1',
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
      transport: g.logicSide, nodeId: 'n1',
      onLogin: (_l, connId) => ({ ok: true, userId: `u-${connId}`, entityId: `e-${connId}`, entityType: 'player', content: new Uint8Array() }),
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
      transport: g.logicSide, nodeId: 'n1',
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
