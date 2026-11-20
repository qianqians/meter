// RPC 三函数（docs/protocol-map.md §4.7）：callEntity / callGroup / register。
//
// 线上形状（全部由 schema 定义，这里只做装配）：
//   Envelope{ msg_type, method, callback_id, status, body = <业务消息字节> }
//
// 三条不变量：
//   1. **要回包**：msg_type=REQUEST，callback_id>0；回包 msg_type=RESPONSE，callback_id 原样带回。
//   2. **不回包**：msg_type=NOTIFY，callback_id=0（callGroup 也走这条）。
//   3. **失败**：RESPONSE 的 status≠0，包体为空；错误码见 common.proto 的 ErrorCode。
//
// 类型与 schema 绑在一起：`callEntity(method, req, RspSchema)` 的返回类型由 schema **推出来**，
// 不需要写 `<Rsp>`（TypeScript 的类型参数在运行时不存在，回包必须有一个 schema 值才能解码）。

import {
  create,
  fromBinary,
  toBinary,
  type DescMessage,
  type MessageShape,
} from '@bufbuild/protobuf';
import { EnvelopeSchema, MsgType } from './gen/envelope_pb';
import { ErrorCodeSchema } from './gen/common_pb';

/** 传输层：只搬运字节，不认识 Envelope（gate 也是这样）。 */
export interface Transport {
  send(bytes: Uint8Array): void;
  onData(cb: (bytes: Uint8Array) => void): void;
}

export interface RpcOptions {
  transport: Transport;
  /** 单调毫秒（测试里注入假时钟）。 */
  now?: () => number;
  /** 单次调用的默认超时。 */
  timeoutMs?: number;
  /** 未注册的方法被调用时的回调（框架只负责计数，业务可以打日志）。 */
  onUnknownMethod?: (method: string) => void;
}

export interface RpcStats {
  unknownMethod: number;
  timeout: number;
  badEnvelope: number;
  sent: number;
  received: number;
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

interface Pending {
  resolve: (body: Uint8Array) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  method: string;
}

type Handler = (req: Uint8Array, callbackId: number) => Uint8Array | Promise<Uint8Array>;

/** 错误码：与 common.proto 里 ErrorCode 的约定一致。 */
export const ERR = {
  OK: 0,
  UNKNOWN: 1,
  TIMEOUT: 2,
  NOT_FOUND: 7,
  BAD_FRAME: 10,
} as const;

export function createRpc(opts: RpcOptions) {
  const { transport, timeoutMs = 10_000 } = opts;
  const now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));

  const pending = new Map<number, Pending>();
  const handlers = new Map<string, Handler>();
  let nextCallbackId = 1;

  const stats: RpcStats = { unknownMethod: 0, timeout: 0, badEnvelope: 0, sent: 0, received: 0 };

  function envelope(msgType: MsgType, method: string, callbackId: number, status: number, body: Uint8Array) {
    return toBinary(EnvelopeSchema, create(EnvelopeSchema, { msgType, method, callbackId, status, body }));
  }

  function send(bytes: Uint8Array) {
    stats.sent++;
    transport.send(bytes);
  }

  /**
   * 要回包的调用：`callEntity(method, reqBytes, RspSchema)`。
   *
   * - `req` 是**已用请求 schema 编码好的字节**（调用点用 `toBinary(ReqSchema, req)`）；
   * - 返回类型由 `RspSchema` **推出**，不需要写 `<Rsp>`——类型参数在运行时不存在，
   *   回包必须有 schema 值才能解码。
   */
  function callEntity<Desc extends DescMessage>(
    method: string,
    req: Uint8Array,
    rsp: Desc,
    options: { timeoutMs?: number } = {},
  ): Promise<MessageShape<Desc>> {
    const id = nextCallbackId++;
    if (nextCallbackId > 0xffffffff) nextCallbackId = 1; // 回绕后不复用 0
    return sendRequest(method, req, id, options.timeoutMs ?? timeoutMs).then((bytes) =>
      fromBinary(rsp, bytes),
    );
  }

  /**
   * 内部：发 REQUEST 并等 RESPONSE。
   * 注意 `body` 的类型与 rsp 无关——调用点负责用**请求**的 schema 编码，这里只搬字节。
   */
  function sendRequest(method: string, body: Uint8Array, id: number, timeout: number): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer =
        timeout > 0
          ? setTimeout(() => {
              pending.delete(id);
              stats.timeout++;
              reject(new RpcError(`调用超时: ${method}`, ERR.TIMEOUT));
            }, timeout)
          : undefined;
      pending.set(id, { resolve, reject, timer, method });
      send(envelope(MsgType.MSG_REQUEST, method, id, 0, body));
    });
  }

  /** 组播 / 广播：不回包，没有 callback_id。 */
  function callGroup(method: string, req: Uint8Array): void {
    send(envelope(MsgType.MSG_NOTIFY, method, 0, 0, req));
  }

  /** 注册处理器。同一个方法同时服务单播（REQUEST）与广播（NOTIFY）。 */
  function register<Req extends DescMessage, Rsp extends DescMessage>(
    method: string,
    reqSchema: Req,
    rspSchema: Rsp,
    handler: (req: MessageShape<Req>, callbackId: number) => MessageShape<Rsp> | Promise<MessageShape<Rsp>>,
  ): void {
    handlers.set(method, async (reqBytes, callbackId) => {
      const req = fromBinary(reqSchema, reqBytes);
      const rsp = await handler(req, callbackId);
      return toBinary(rspSchema, rsp);
    });
  }

  async function dispatch(bytes: Uint8Array): Promise<void> {
    stats.received++;
    let env;
    try {
      env = fromBinary(EnvelopeSchema, bytes);
    } catch {
      stats.badEnvelope++;
      return;
    }

    // ---- 回包：配对在途请求 ----
    if (env.msgType === MsgType.MSG_RESPONSE) {
      const p = pending.get(env.callbackId);
      if (!p) return; // 迟到 / 已超时：直接丢弃（不能当错误抛给业务）
      pending.delete(env.callbackId);
      if (p.timer) clearTimeout(p.timer);
      if (env.status !== ERR.OK) {
        let detail = '';
        try {
          detail = fromBinary(ErrorCodeSchema, env.body).detail;
        } catch {
          /* 包体可能为空 */
        }
        p.reject(new RpcError(detail || `status=${env.status}`, env.status));
      } else {
        p.resolve(env.body);
      }
      return;
    }

    // ---- 请求 / 广播：交给 handler ----
    const needsReply = env.msgType === MsgType.MSG_REQUEST;
    const h = handlers.get(env.method);
    if (!h) {
      stats.unknownMethod++;
      opts.onUnknownMethod?.(env.method);
      if (needsReply) {
        const err = toBinary(ErrorCodeSchema, create(ErrorCodeSchema, { code: ERR.NOT_FOUND, detail: `unknown method: ${env.method}` }));
        send(envelope(MsgType.MSG_RESPONSE, env.method, env.callbackId, ERR.NOT_FOUND, err));
      }
      return;
    }

    try {
      const rspBytes = await h(env.body, env.callbackId);
      if (needsReply) send(envelope(MsgType.MSG_RESPONSE, env.method, env.callbackId, ERR.OK, rspBytes));
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      const err = toBinary(ErrorCodeSchema, create(ErrorCodeSchema, { code: ERR.UNKNOWN, detail }));
      if (needsReply) send(envelope(MsgType.MSG_RESPONSE, env.method, env.callbackId, ERR.UNKNOWN, err));
    }
  }

  transport.onData((bytes) => {
    void dispatch(bytes);
  });

  return { callEntity, callGroup, register, stats, now };
}

export type Rpc = ReturnType<typeof createRpc>;
