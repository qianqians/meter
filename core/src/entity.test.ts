// 实体层验收测试——离线：Downlink 用收集器，客户端方向的回包由测试直接喂 onClientResponse。
//
// 测的是真问题：register 分派 / REQUEST 回包装配 / rpcRequest 配对与超时 /
// 非玩家实体拒绝下行 / 视图同步三原语的线上形状。

import { describe, expect, it } from 'vitest';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { EnvelopeSchema, MsgType } from './gen/envelope_pb';
import { GateForwardHubCallClientSchema, HubCreateRemoteEntitySchema } from './gen/gate_logic_pb';
import { ErrorCodeSchema } from './gen/common_pb';
import { RefreshEntitySchema } from './gen/client_pb';
import { Entity, forwardCallClient, ERR, RpcError, type Downlink } from './entity';

/** 收集下行 Envelope 字节的假通道。 */
function collector() {
  const sent: Uint8Array[] = [];
  const down: Downlink = { send: (b) => sent.push(b) };
  const last = () => {
    const b = sent[sent.length - 1];
    if (!b) throw new Error('没有下行消息');
    return fromBinary(EnvelopeSchema, b);
  };
  return { sent, down, last };
}

const player = (down: Downlink) =>
  new Entity('e-player', 'player', down, { connId: 'c1', userId: 'u1' });

describe('register：客户端 → 实体', () => {
  it('REQUEST 分派到 handler，回包装配为 forwardHubCallClient{RESPONSE, 原 callbackId}', async () => {
    const { down, last } = collector();
    const e = player(down);
    e.register('entity.attack', RefreshEntitySchema, RefreshEntitySchema, (req) =>
      create(RefreshEntitySchema, { entityId: 'hit', entityType: 'player', content: req.content, reason: 1 }));

    await e.dispatch('entity.attack', toBinary(RefreshEntitySchema,
      create(RefreshEntitySchema, { entityId: 'm1', entityType: 'monster', reason: 2 })),
      { connId: 'c1' }, true, 7);

    const env = last();
    expect(env.method).toBe('gate.forwardHubCallClient');
    expect(env.msgType).toBe(MsgType.MSG_RESPONSE);
    expect(env.callbackId).toBe(7);
    const body = fromBinary(GateForwardHubCallClientSchema, env.body);
    expect(body.method).toBe('entity.attack');
    expect(body.connId).toBe('c1');
    expect(body.entityId).toBe('e-player');
  });

  it('NOTIFY 分派但不回包', async () => {
    const { down, sent } = collector();
    const e = player(down);
    let seen = 0;
    e.registerNotify('op.move', RefreshEntitySchema, () => { seen++; });

    await e.dispatch('op.move', toBinary(RefreshEntitySchema,
      create(RefreshEntitySchema, { entityId: 'x' })), { connId: 'c1' }, false);

    expect(seen).toBe(1);
    expect(sent.length).toBe(0);
  });

  it('未知方法：REQUEST 回 NOT_FOUND，NOTIFY 只计数', async () => {
    const { down, last, sent } = collector();
    const e = player(down);

    await e.dispatch('nope', new Uint8Array(0), { connId: 'c1' }, true, 9);
    expect(e.stats.unknownMethod).toBe(1);
    const env = last();
    expect(env.msgType).toBe(MsgType.MSG_RESPONSE);
    expect(fromBinary(GateForwardHubCallClientSchema, env.body).method).toBe('nope');

    const before = sent.length;
    await e.dispatch('nope2', new Uint8Array(0), { connId: 'c1' }, false);
    expect(sent.length).toBe(before);
    expect(e.stats.unknownMethod).toBe(2);
  });

  it('handler 抛错：REQUEST 回 UNKNOWN + detail', async () => {
    const { down, last } = collector();
    const e = player(down);
    e.register('bad', RefreshEntitySchema, RefreshEntitySchema, () => { throw new Error('boom'); });
    await e.dispatch('bad', new Uint8Array(0), { connId: 'c1' }, true, 3);
    const env = last();
    const body = fromBinary(GateForwardHubCallClientSchema, env.body);
    expect(body.method).toBe('bad');
    expect(fromBinary(ErrorCodeSchema, body.content).code).toBe(ERR.UNKNOWN);
  });
});

describe('rpcRequest / rpcNotify：实体 → 客户端', () => {
  it('rpcNotify 装配 NOTIFY，无需回包', () => {
    const { down, last } = collector();
    const e = player(down);
    e.rpcNotify('entity.move', new Uint8Array([1, 2]));

    const env = last();
    expect(env.msgType).toBe(MsgType.MSG_NOTIFY);
    expect(env.callbackId).toBe(0);
    expect(fromBinary(GateForwardHubCallClientSchema, env.body).method).toBe('entity.move');
  });

  it('rpcRequest 发 REQUEST；onClientResponse 配对成功并解码回包', async () => {
    const { down, last } = collector();
    const e = player(down);

    const p = e.rpcRequest('entity.query', new Uint8Array(0), RefreshEntitySchema);
    const env = last();
    expect(env.msgType).toBe(MsgType.MSG_REQUEST);
    expect(env.callbackId).toBe(1);

    const cb = env.callbackId;
    const rsp = create(RefreshEntitySchema, { entityId: 'e-player', entityType: 'player' });
    e.onClientResponse(cb, ERR.OK, toBinary(RefreshEntitySchema, rsp));
    const got = await p;
    expect(got.entityId).toBe('e-player');
  });

  it('rpcRequest 的回包带错误 status：reject 出 RpcError', async () => {
    const { down, last } = collector();
    const e = player(down);
    const p = e.rpcRequest('entity.query', new Uint8Array(0), RefreshEntitySchema);
    const env = last();
    e.onClientResponse(env.callbackId, ERR.NOT_FOUND,
      toBinary(ErrorCodeSchema, create(ErrorCodeSchema, { code: ERR.NOT_FOUND, detail: 'not found' })));
    await expect(p).rejects.toBeInstanceOf(RpcError);
  });

  it('rpcRequest 超时：reject TIMEOUT，在途清空', async () => {
    const { down } = collector();
    const e = player(down);
    const p = e.rpcRequest('entity.query', new Uint8Array(0), RefreshEntitySchema, { timeoutMs: 10 });
    await expect(p).rejects.toMatchObject({ code: ERR.TIMEOUT });
    expect(e.stats.timeout).toBe(1);
  });

  it('怪实体（无连接）主动下行被拒绝', () => {
    const { down } = collector();
    const monster = new Entity('e-monster', 'monster', down);
    expect(monster.isPlayer).toBe(false);

    expect(() => monster.rpcNotify('m', new Uint8Array())).toThrow(RpcError);
    expect(monster.rpcRequest('m', new Uint8Array(), RefreshEntitySchema)).rejects.toBeInstanceOf(RpcError);
  });

  it('destroy：在途请求全部拒绝 + 清 handler + onDestroy 钩子', async () => {
    const { down } = collector();
    const e = player(down);
    let destroyed = false;
    e.onDestroy = () => { destroyed = true; };
    const p = e.rpcRequest('entity.query', new Uint8Array(0), RefreshEntitySchema, { timeoutMs: 10_000 });
    e.register('entity.attack', RefreshEntitySchema, RefreshEntitySchema, () =>
      create(RefreshEntitySchema, {}));

    e.destroy();
    await expect(p).rejects.toMatchObject({ code: ERR.NOT_FOUND });
    expect(destroyed).toBe(true);
    // 已销毁：新调用在入队前就被挡掉（不再走 handler 表）
    await e.dispatch('entity.attack', new Uint8Array(0), { connId: 'c1' }, false);
    expect(e.stats.closed).toBe(1);
    expect(e.stats.unknownMethod).toBe(0);
  });
});

describe('视图同步原语', () => {
  it('createRemoteTo：hub.createRemoteEntity，带目标连接', () => {
    const { down, last } = collector();
    const monster = new Entity('e-monster', 'monster', down);
    monster.createRemoteTo(player(down), new Uint8Array([9]));

    const env = last();
    expect(env.method).toBe('hub.createRemoteEntity');
    const body = fromBinary(HubCreateRemoteEntitySchema, env.body);
    expect(body.connId).toBe('c1');
    expect(body.entityId).toBe('e-monster');
    expect(body.entityType).toBe('monster');
    expect([...body.content]).toEqual([9]);
  });

  it('deleteRemoteFrom / refreshTo 的路由方法对应', () => {
    const { down, last } = collector();
    const e = player(down);
    const target = player(down);

    e.deleteRemoteFrom(target);
    expect(last().method).toBe('hub.deleteRemoteEntity');

    e.refreshTo(target, new Uint8Array(0));
    expect(last().method).toBe('hub.refreshEntity');
  });

  it('目标不是玩家（无连接）：静默跳过', () => {
    const { down, sent } = collector();
    const e = player(down);
    e.createRemoteTo(new Entity('e-m', 'monster', down), new Uint8Array());
    expect(sent.length).toBe(0);
  });
});

describe('forwardCallClient 工具', () => {
  it('与 Entity 内部装配一致（供 group/global 复用）', () => {
    const b = forwardCallClient(MsgType.MSG_REQUEST, 'c9', 'e1', 'm', 42, new Uint8Array([1]));
    const env = fromBinary(EnvelopeSchema, b);
    expect(env.method).toBe('gate.forwardHubCallClient');
    const body = fromBinary(GateForwardHubCallClientSchema, env.body);
    expect(body.connId).toBe('c9');
    expect(body.entityId).toBe('e1');
    expect(body.method).toBe('m');
  });
});

// ---------------- 执行模型：每实体串行（actor.ts） ----------------

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('执行模型：同一实体串行', () => {
  it('第一个调用在等外部事件时，第二个不许开始；完成后按到达顺序继续', async () => {
    const { down, sent } = collector();
    const e = player(down);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const order: string[] = [];

    e.registerNotify('op.slow', RefreshEntitySchema, async () => {
      order.push('slow:start');
      await gate;
      order.push('slow:end');
    });
    e.registerNotify('op.fast', RefreshEntitySchema, () => { order.push('fast'); });

    const req = toBinary(RefreshEntitySchema, create(RefreshEntitySchema, { entityId: 'x' }));
    void e.dispatch('op.slow', req, { connId: 'c1' }, false);
    void e.dispatch('op.fast', req, { connId: 'c1' }, false);

    await tick();
    expect(order).toEqual(['slow:start']); // 第一条没完成，第二条排队

    release();
    await e.fence();
    expect(order).toEqual(['slow:start', 'slow:end', 'fast']);
    expect(sent.length).toBe(0);
  });

  it('fence 等到已入队的调用跑完', async () => {
    const { down } = collector();
    const e = player(down);
    let done = false;
    e.registerNotify('op.a', RefreshEntitySchema, async () => {
      await new Promise<void>((r) => setTimeout(r, 5));
      done = true;
    });

    void e.dispatch('op.a', toBinary(RefreshEntitySchema, create(RefreshEntitySchema, {})), { connId: 'c1' }, false);
    expect(done).toBe(false);

    await e.fence();
    expect(done).toBe(true);
    expect(e.pendingJobs).toBe(0);
  });

  it('destroy：丢弃排队中的调用（不回包），之后到达的调用只计数', async () => {
    const { down, sent } = collector();
    const e = player(down);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    e.registerNotify('op.a', RefreshEntitySchema, async () => { await gate; });
    e.register('op.b', RefreshEntitySchema, RefreshEntitySchema, () =>
      create(RefreshEntitySchema, { entityId: 'b' }));

    const req = toBinary(RefreshEntitySchema, create(RefreshEntitySchema, {}));
    void e.dispatch('op.a', req, { connId: 'c1' }, false);
    const queued = e.dispatch('op.b', req, { connId: 'c1' }, true, 3); // 排队中

    e.destroy();

    await expect(queued).resolves.toBeUndefined(); // dispatch 永不 reject
    expect(e.isClosed).toBe(true);
    expect(e.pendingJobs).toBe(0);
    expect(sent.length).toBe(0); // 被丢弃的 REQUEST 不回包

    void e.dispatch('op.b', req, { connId: 'c1' }, true, 4);
    await e.fence().catch(() => {}); // 已关闭：fence reject（这里吞掉）
    expect(e.stats.closed).toBe(1);

    release();
  });
});
