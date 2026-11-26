// 逻辑服 ↔ gate 的真连接：node net TCP + 8 字节帧 + `logic.hello` 握手，包成 rpc.ts 形状的 Transport。
//
// 方向是**逻辑服主动连 gate**（gate 是接入层，consul 里注册的是它；扩容 gate 不用改逻辑服配置）。
// 握手：连接建立后第一帧必须是 `Envelope{method:"logic.hello", body=utf8(node_id)}`；
// 之后每帧 payload 都是 marshal 后的 Envelope——帧头只在 TCP 流上负责"切帧"，语义全在信封里。
//
// 握手完成信号：**hello 写出即就绪**——gate 对新连入的逻辑节点不回任何帧（它只是
// 登记 AddLogic 后开始收发），而 TCP 有序保证后续消息一定排在 hello 之后。
// hello 不合法时 gate 会直接断连（onClose）。
//
// 断线重连：P0 只把错误交给 onClose（进程级守护重启逻辑服也行——gate 侧会话在
// ClientDisconnect 后自然收敛，不重放）。

import net from 'node:net';
import { create, toBinary, fromBinary } from '@bufbuild/protobuf';

import { EnvelopeSchema, MsgType } from './gen/envelope_pb';
import { decodeFrames, encodeFrame, type Frame } from './frame';
import type { Transport } from './rpc';

export interface GateLinkOptions {
  host: string;
  port: number;
  /** 节点 id（logic.hello 的 body；gate 用它登记 logics 表）。 */
  nodeId: string;
  /** 单调毫秒，帧头 ts 用（测试注入假时钟）。 */
  now?: () => number;
  onClose?: (err: Error | undefined) => void;
}

/**
 * 把"能写字节的东西"包成 Transport：出向加帧，入向靠 feed() 喂 TCP 字节流解帧。
 * 与连接解耦是为了离线测试（喂假字节流就能验帧编解码与握手装配）。
 */
export function createLinkTransport(
  socket: { write(data: Uint8Array): boolean },
  opts: { now: () => number },
): Transport & { feed(chunk: Uint8Array): void } {
  let sink: ((bytes: Uint8Array) => void) | undefined;
  let pending = new Uint8Array(0);

  const link: Transport & { feed(chunk: Uint8Array): void } = {
    send(bytes) {
      socket.write(encodeFrame({ flags: 0, ts: opts.now() & 0xffffffff, payload: bytes }));
    },
    onData(cb) {
      sink = cb;
    },
    feed(chunk: Uint8Array) {
      const merged = new Uint8Array(pending.length + chunk.length);
      merged.set(pending);
      merged.set(chunk, pending.length);
      const consumed = decodeFrames(merged, (f: Frame) => sink?.(f.payload));
      pending = merged.slice(consumed);
    },
  };
  return link;
}

/** 连 gate：握手（发 logic.hello + 收到首帧）后 resolve 出 Transport。 */
export function connectGate(opts: GateLinkOptions): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const now = opts.now ?? (() => Date.now());
    let settled = false;
    let closed = false;

    const socket = net.createConnection({ host: opts.host, port: opts.port }, () => {
      // 握手：首帧 logic.hello，body = node_id 的 utf8 字节。写出即就绪（见文件头注释）
      const hello = toBinary(EnvelopeSchema, create(EnvelopeSchema, {
        msgType: MsgType.MSG_NOTIFY,
        method: 'logic.hello',
        body: new TextEncoder().encode(opts.nodeId),
      }));
      socket.write(encodeFrame({ flags: 0, ts: now() & 0xffffffff, payload: hello }));
      settled = true;
      resolve(transport);
    });

    const transport = createLinkTransport(socket, { now });

    socket.on('data', (chunk: Buffer) => {
      transport.feed(chunk);
    });
    socket.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    socket.on('close', () => {
      if (!settled) {
        settled = true;
        reject(new Error(`连 gate ${opts.host}:${opts.port} 在握手前被关闭`));
      }
      if (!closed) {
        closed = true;
        opts.onClose?.(undefined);
      }
    });
  });
}

/** 解出 Envelope（测试/诊断用）。 */
export function parseEnvelope(bytes: Uint8Array) {
  return fromBinary(EnvelopeSchema, bytes);
}
