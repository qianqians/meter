// 8 字节帧头编解码（规格见 docs/protocol-map.md §4.2–§4.5）。
//
//   off  size  field
//   0    1     flags   bit0 = zstd；bit1-7 必须为 0（未知位 → 报错断开）
//   1    3     len     payload 字节数（u24 LE，硬上限 1 MB）
//   4    4     ts      发送时刻（u32 LE，单调毫秒，逐跳覆盖）
//   8    ...   payload
//
// 这里只做"分帧 + 校验"，不做压缩（压缩在传输层按 flags 决定）。

export const HEADER_SIZE = 8;
export const MAX_PAYLOAD = 1 << 20; // 1 MB
export const FLAG_ZSTD = 0b0001;
const KNOWN_FLAGS = FLAG_ZSTD;

export interface Frame {
  flags: number;
  /** 单调毫秒，低 32 位 */
  ts: number;
  payload: Uint8Array;
}

export class FrameError extends Error {
  constructor(
    message: string,
    readonly code: 'BAD_FLAGS' | 'PAYLOAD_TOO_LARGE' | 'BAD_LENGTH',
  ) {
    super(message);
    this.name = 'FrameError';
  }
}

/** 编码一帧。`ts` 由调用方给（通常是本进程单调钟的低 32 位）。 */
export function encodeFrame(frame: Frame): Uint8Array {
  const { flags, ts, payload } = frame;
  if ((flags & ~KNOWN_FLAGS) !== 0) {
    throw new FrameError(`未知 flags 位: 0b${flags.toString(2)}`, 'BAD_FLAGS');
  }
  if (payload.length > MAX_PAYLOAD) {
    throw new FrameError(`payload 超过 1 MB: ${payload.length}`, 'PAYLOAD_TOO_LARGE');
  }
  const out = new Uint8Array(HEADER_SIZE + payload.length);
  out[0] = flags;
  // len: u24 LE（payload 长度）
  const len = payload.length;
  out[1] = len & 0xff;
  out[2] = (len >>> 8) & 0xff;
  out[3] = (len >>> 16) & 0xff;
  // ts: u32 LE
  out[4] = ts & 0xff;
  out[5] = (ts >>> 8) & 0xff;
  out[6] = (ts >>> 16) & 0xff;
  out[7] = (ts >>> 24) & 0xff;
  out.set(payload, HEADER_SIZE);
  return out;
}

/**
 * 从字节流里切帧。
 *
 * 半包时**不报错**——返回已消费的字节数，剩下的等下次数据到来（TCP 的正常现象）。
 * 只有语义错误（未知 flags 位、len 超上限）才抛 FrameError。
 *
 * @returns 消费的字节数（调用方应把 `buf.slice(consumed)` 留作下次的头部）
 */
export function decodeFrames(buf: Uint8Array, onFrame: (f: Frame) => void): number {
  let off = 0;
  while (buf.length - off >= HEADER_SIZE) {
    const flags = buf[off];
    if ((flags & ~KNOWN_FLAGS) !== 0) {
      throw new FrameError(`未知 flags 位: 0b${flags.toString(2)}`, 'BAD_FLAGS');
    }
    const len = buf[off + 1] | (buf[off + 2] << 8) | (buf[off + 3] << 16);
    if (len > MAX_PAYLOAD) {
      throw new FrameError(`len 超过 1 MB: ${len}`, 'PAYLOAD_TOO_LARGE');
    }
    if (buf.length - off < HEADER_SIZE + len) break; // 半包：等更多数据
    const ts = (buf[off + 4] | (buf[off + 5] << 8) | (buf[off + 6] << 16) | (buf[off + 7] << 24)) >>> 0;
    onFrame({ flags, ts, payload: buf.subarray(off + HEADER_SIZE, off + HEADER_SIZE + len) });
    off += HEADER_SIZE + len;
  }
  return off;
}

/**
 * 计算"该跳的单向延迟"：`接收方单调时间 - ts`，用有符号 32 位差值处理 49.7 天回绕。
 * 越界（负数 / > 60 s）视为异常时钟，clamp 到边界并返回 `suspect: true`（只做统计，不参与业务判定）。
 */
export function oneWayDelayMs(recvTs: number, frameTs: number): { ms: number; suspect: boolean } {
  const raw = ((recvTs - frameTs) | 0) >>> 0; // 先按无符号取低 32 位
  const ms = raw > 0x7fffffff ? raw - 0x100000000 : raw; // 再解释为有符号
  if (ms < 0 || ms > 60_000) return { ms: Math.max(0, Math.min(ms, 60_000)), suspect: true };
  return { ms, suspect: false };
}
