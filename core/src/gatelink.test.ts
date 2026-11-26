// gatelink 验收测试：
//   离线部分——createLinkTransport 的帧编解码（半包/多帧/粘包）与握手装配；
//   本机 TCP 部分——起一个"假 gate"（net server），验 connectGate 的握手时序与双向透传。

import { describe, expect, it } from 'vitest';
import net from 'node:net';
import { fromBinary, toBinary, create } from '@bufbuild/protobuf';
import { EnvelopeSchema, MsgType } from './gen/envelope_pb';
import { encodeFrame } from './frame';
import { connectGate, createLinkTransport } from './gatelink';

const envBytes = (method: string, body = new Uint8Array()) =>
  toBinary(EnvelopeSchema, create(EnvelopeSchema, { msgType: MsgType.MSG_NOTIFY, method, body }));

describe('createLinkTransport（离线）', () => {
  it('feed 半包：帧不完整时缓冲，完整后投递 payload', () => {
    const written: Uint8Array[] = [];
    const link = createLinkTransport({ write: (d) => { written.push(d); return true; } }, { now: () => 42 });

    const received: Uint8Array[] = [];
    link.onData((b) => received.push(b));

    const frame = encodeFrame({ flags: 0, ts: 1, payload: envBytes('m1') });
    link.feed(frame.slice(0, 4)); // 半包
    expect(received.length).toBe(0);
    link.feed(frame.slice(4));
    expect(received.length).toBe(1);
    expect(fromBinary(EnvelopeSchema, received[0]).method).toBe('m1');
  });

  it('feed 多帧粘包：一条字节流里解出多条', () => {
    const link = createLinkTransport({ write: () => true }, { now: () => 0 });
    const received: string[] = [];
    link.onData((b) => received.push(fromBinary(EnvelopeSchema, b).method));

    const both = new Uint8Array([
      ...encodeFrame({ flags: 0, ts: 1, payload: envBytes('a') }),
      ...encodeFrame({ flags: 0, ts: 2, payload: envBytes('b') }),
    ]);
    link.feed(both);
    expect(received).toEqual(['a', 'b']);
  });

  it('send：带帧头写出（对端能解回 payload）', () => {
    const written: Uint8Array[] = [];
    const link = createLinkTransport({ write: (d) => { written.push(d); return true; } }, { now: () => 7 });

    link.send(envBytes('out'));
    expect(written.length).toBe(1);

    const back: string[] = [];
    const peer = createLinkTransport({ write: () => true }, { now: () => 0 });
    peer.onData((b) => back.push(fromBinary(EnvelopeSchema, b).method));
    peer.feed(written[0]);
    expect(back).toEqual(['out']);
  });
});

describe('connectGate（本机 TCP，假 gate）', () => {
  it('握手：hello 写出即就绪；双向透传', async () => {
    // 假 gate：收到首帧记录；回发一条"就绪"消息；之后回显
    const srv = net.createServer((sock) => {
      let announced = false;
      const link = createLinkTransport(sock, { now: () => 0 });
      link.onData((payload) => {
        if (!announced) {
          announced = true;
          link.send(envBytes('gate.ready'));
          return;
        }
        link.send(payload); // 回显
      });
      sock.on('data', (c: Buffer) => link.feed(c));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const addr = srv.address() as net.AddressInfo;

    const transport = await connectGate({ host: '127.0.0.1', port: addr.port, nodeId: 'n-test' });
    expect(transport).toBeDefined();

    // 调用方 onData（就绪即注册，赶在任何业务帧之前）+ 回显闭环
    const got: string[] = [];
    await new Promise<void>((resolve) => {
      transport.onData((b) => {
        got.push(fromBinary(EnvelopeSchema, b).method);
        resolve();
      });
      transport.send(envBytes('echo.me'));
    });
    expect(got).toContain('echo.me');
    srv.close();
  }, 10_000);

  it('握手帧内容：logic.hello + body=node_id', async () => {
    let hello: Uint8Array | undefined;
    const srv = net.createServer((sock) => {
      const link = createLinkTransport(sock, { now: () => 0 });
      link.onData((payload) => {
        if (!hello) {
          hello = payload;
          link.send(envBytes('gate.ready'));
        }
      });
      sock.on('data', (c: Buffer) => link.feed(c));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const addr = srv.address() as net.AddressInfo;

    const transport = await connectGate({ host: '127.0.0.1', port: addr.port, nodeId: 'node-xyz' });
    await new Promise((r) => setTimeout(r, 100)); // 等 hello 到达假 gate（写出即就绪，不含对端确认）
    const env = fromBinary(EnvelopeSchema, hello!);
    expect(env.method).toBe('logic.hello');
    expect(new TextDecoder().decode(env.body)).toBe('node-xyz');
    transport.send(envBytes('bye')); // 保活，等断开
    srv.close();
  }, 10_000);

  it('连不上：reject', async () => {
    // 占一个空闲端口再关掉，保证连接被拒
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const addr = probe.address() as net.AddressInfo;
    probe.close();
    await new Promise<void>((r) => setTimeout(r, 50));

    await expect(connectGate({ host: '127.0.0.1', port: addr.port, nodeId: 'n' }))
      .rejects.toThrow();
  }, 10_000);
});
