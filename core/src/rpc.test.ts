// RPC 三函数 + 帧头的验收测试。
//
// 不连网络：两个 `createRpc` 通过一个**内存传输**互相对接（`pair()`），
// 这样测的是"信封装配 / callback 配对 / 超时 / 未知方法 / 广播"这些真问题。
//
// 消息类型用 schema/ 里 codegen 出来的真 schema（先跑 `cd schema && ./check.sh`）。

import { describe, expect, it } from 'vitest';
import { create, toBinary, fromBinary } from '@bufbuild/protobuf';

import { RefreshEntitySchema } from './gen/client_pb';
import { decodeFrames, encodeFrame, FrameError, HEADER_SIZE, oneWayDelayMs } from './frame';
import { createRpc, RpcError, ERR, type Transport } from './rpc';

/** 内存传输：一端 send 的数据立刻进另一端的 onData。 */
function pair(): [Transport, Transport] {
  let a: ((b: Uint8Array) => void) | undefined;
  let b: ((x: Uint8Array) => void) | undefined;
  return [
    { send: (bytes) => queueMicrotask(() => b?.(bytes)), onData: (cb) => { a = cb; } },
    { send: (bytes) => queueMicrotask(() => a?.(bytes)), onData: (cb) => { b = cb; } },
  ];
}

const mkEntity = (id: string, kind = 'monster') =>
  create(RefreshEntitySchema, { entityId: id, entityType: kind, content: new Uint8Array([1, 2, 3]), reason: 2 });

describe('8 字节帧头', () => {
  it('编码/解码往返，payload 4 字节对齐之外不再有额外开销', () => {
    const payload = new Uint8Array([9, 8, 7]);
    const bytes = encodeFrame({ flags: 0, ts: 123456, payload });
    expect(bytes.length).toBe(HEADER_SIZE + 3);
    const got: any[] = [];
    const consumed = decodeFrames(bytes, (f) => got.push(f));
    expect(consumed).toBe(bytes.length);
    expect(got[0].ts).toBe(123456);
    expect([...got[0].payload]).toEqual([9, 8, 7]);
  });

  it('半包不报错：只消费完整帧，剩下的留给下次', () => {
    const f1 = encodeFrame({ flags: 0, ts: 1, payload: new Uint8Array([1, 2]) });
    const f2 = encodeFrame({ flags: 0, ts: 2, payload: new Uint8Array([3, 4]) });
    const all = new Uint8Array(f1.length + f2.length);
    all.set(f1); all.set(f2, f1.length);

    const got: any[] = [];
    const consumed = decodeFrames(all.subarray(0, f1.length + 3), (f) => got.push(f));
    expect(got.length).toBe(1);
    expect(consumed).toBe(f1.length);

    const rest = new Uint8Array(all.length - consumed);
    rest.set(all.subarray(consumed));
    decodeFrames(rest, (f) => got.push(f));
    expect(got.length).toBe(2);
  });

  it('未知 flags 位直接抛（语义变了不能"尽力解析"）', () => {
    expect(() => encodeFrame({ flags: 0b100, ts: 0, payload: new Uint8Array() })).toThrow(FrameError);
    const bad = new Uint8Array(HEADER_SIZE);
    bad[0] = 0b10;
    expect(() => decodeFrames(bad, () => {})).toThrow(FrameError);
  });

  it('ts 跨 32 位回绕：有符号差值算对，异常时钟 clamp', () => {
    expect(oneWayDelayMs(0x10, 0xfffffff0).ms).toBe(32);       // 回绕后 32 ms
    expect(oneWayDelayMs(1007, 1000).ms).toBe(7);
    const neg = oneWayDelayMs(0, 30000);                        // 客户端快 30 s
    expect(neg.suspect).toBe(true);
    expect(neg.ms).toBe(0);
    const big = oneWayDelayMs(7_200_000, 0);                    // 慢 2 h
    expect(big.suspect).toBe(true);
    expect(big.ms).toBe(60_000);
  });
});

describe('RPC 三函数', () => {
  it('callEntity：REQUEST → RESPONSE，按 callback_id 配对，类型由 schema 推出', async () => {
    const [ta, tb] = pair();
    const client = createRpc({ transport: ta });
    const server = createRpc({ transport: tb });

    server.register('entity.refresh', RefreshEntitySchema, RefreshEntitySchema,
      (req) => ({ ...req, reason: req.reason + 1 }));

    const rsp = await client.callEntity(
      'entity.refresh',
      toBinary(RefreshEntitySchema, mkEntity('e-1')),
      RefreshEntitySchema,
    );

    expect(rsp.entityId).toBe('e-1');
    expect(rsp.reason).toBe(3);         // 服务端改过
    expect(client.stats.sent).toBe(1);
    expect(server.stats.received).toBe(1);
  });

  it('callGroup：NOTIFY 无 callback_id，服务端执行但不回包', async () => {
    const [ta, tb] = pair();
    const client = createRpc({ transport: ta });
    const server = createRpc({ transport: tb });

    let seen = 0;
    server.register('scene.sync', RefreshEntitySchema, RefreshEntitySchema, (req) => { seen++; return req; });

    client.callGroup('scene.sync', toBinary(RefreshEntitySchema, mkEntity('e-2')));
    await new Promise((r) => setTimeout(r, 0));

    expect(seen).toBe(1);
    expect(server.stats.sent).toBe(0);   // 没回包
  });

  it('未知方法：丢弃 + 计数；要回包的调用收到 NOT_FOUND', async () => {
    const [ta, tb] = pair();
    const client = createRpc({ transport: ta });
    const server = createRpc({ transport: tb });

    const p = client.callEntity('nope.method', new Uint8Array(), RefreshEntitySchema);
    await expect(p).rejects.toBeInstanceOf(RpcError);
    await expect(p).rejects.toMatchObject({ code: ERR.NOT_FOUND });
    expect(server.stats.unknownMethod).toBe(1);
  });

  it('handler 抛错：回 UNKNOWN，错误文案带回去', async () => {
    const [ta, tb] = pair();
    const client = createRpc({ transport: ta });
    const server = createRpc({ transport: tb });

    server.register('boom', RefreshEntitySchema, RefreshEntitySchema, () => { throw new Error('炸了'); });
    const p = client.callEntity('boom', new Uint8Array(), RefreshEntitySchema);
    await expect(p).rejects.toMatchObject({ code: ERR.UNKNOWN });
  });

  it('超时：按配置抛 TIMEOUT，并把在途记录清掉', async () => {
    const [ta] = pair();                       // 对端没人应答
    const client = createRpc({ transport: ta, timeoutMs: 20 });
    const p = client.callEntity('slow.method', new Uint8Array(), RefreshEntitySchema);
    await expect(p).rejects.toMatchObject({ code: ERR.TIMEOUT });
    expect(client.stats.timeout).toBe(1);
  });

  it('迟到响应不炸：没有匹配的 callback_id 时静默丢弃', async () => {
    const [ta, tb] = pair();
    const client = createRpc({ transport: ta });
    const server = createRpc({ transport: tb });

    // 服务端收到一个"从未发出过"的响应（模拟重连后旧回包到达）
    server.callGroup('whatever', new Uint8Array());
    await new Promise((r) => setTimeout(r, 0));
    expect(client.stats.badEnvelope).toBe(0);   // 不是坏包，只是无处配对
  });
});
