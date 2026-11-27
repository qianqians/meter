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
import { GateHelloSchema } from './gen/gate_logic_pb';
import { decodeFrames, encodeFrame, type Frame } from './frame';
import type { Transport } from './rpc';

/** 握手方法名（与 gate 的 `internal/logiclink` 约定一致）。 */
export const HELLO_METHOD = 'logic.hello';
/** gate 的握手回包：用来告诉逻辑节点"这条链路是哪台 gate"。 */
export const HELLO_ACK_METHOD = 'logic.hello.ack';

export interface GateLinkOptions {
  host: string;
  port: number;
  /** 节点 id（logic.hello 的 body；gate 用它登记 logics 表）。 */
  nodeId: string;
  /** 单调毫秒，帧头 ts 用（测试注入假时钟）。 */
  now?: () => number;
  onClose?: (err: Error | undefined) => void;
  /** 等 gate 回 hello.ack 的超时；默认 5s。 */
  handshakeTimeoutMs?: number;
}

/**
 * 一条已握手的 gate 链路：逻辑层用它做下行寻址（`name` 来自 gate 的握手回包）。
 */
export interface GateHandshake {
  name: string;
  transport: Transport;
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

/**
 * 连 gate 并完成握手：发 `logic.hello`（body = node_id），等 gate 回 `logic.hello.ack`
 * （body = `GateHello{gate_name, proto_ver}`），**拿到 gate 名字之后**才 resolve。
 *
 * 为什么必须等回包：逻辑节点可以连多台 gate，而它必须知道每条链路对面是哪台——
 * 实体记住自己在哪台 gate 上（跨 gate 顶号时靠它把踢人消息发回旧连接那台）。
 * 握手期间到达的业务帧先缓冲，等调用方 `onData` 注册后按序喂进去。
 */
export function connectGate(opts: GateLinkOptions): Promise<GateHandshake> {
  return new Promise((resolve, reject) => {
    const now = opts.now ?? (() => Date.now());
    const timeoutMs = opts.handshakeTimeoutMs ?? 5000;
    let settled = false;
    let closed = false;
    let sink: ((bytes: Uint8Array) => void) | undefined;
    const buffered: Uint8Array[] = [];

    const socket = net.createConnection({ host: opts.host, port: opts.port }, () => {
      const hello = toBinary(EnvelopeSchema, create(EnvelopeSchema, {
        msgType: MsgType.MSG_NOTIFY,
        method: HELLO_METHOD,
        body: new TextEncoder().encode(opts.nodeId),
      }));
      socket.write(encodeFrame({ flags: 0, ts: now() & 0xffffffff, payload: hello }));
    });

    const link = createLinkTransport(socket, { now });
    socket.on('data', (chunk: Buffer) => {
      link.feed(chunk);
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`连 gate ${opts.host}:${opts.port} 等 hello.ack 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    timer.unref?.();

    const transport: Transport = {
      send: (bytes) => link.send(bytes),
      onData: (cb) => {
        sink = cb;
        for (const b of buffered.splice(0)) cb(b);
      },
    };

    link.onData((bytes) => {
      if (!settled) {
        try {
          const env = fromBinary(EnvelopeSchema, bytes);
          if (env.method === HELLO_ACK_METHOD) {
            const hello = fromBinary(GateHelloSchema, env.body);
            if (!hello.gateName) {
              settled = true;
              clearTimeout(timer);
              socket.destroy();
              reject(new Error('gate 的 hello.ack 里没有 gate_name'));
              return;
            }
            settled = true;
            clearTimeout(timer);
            resolve({ name: hello.gateName, transport });
            return;
          }
        } catch {
          // 不是握手回包：当作业务帧缓冲（下面统一处理）
        }
        if (!settled) {
          buffered.push(bytes);
          return;
        }
      }
      sink?.(bytes);
    });

    socket.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    socket.on('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
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
