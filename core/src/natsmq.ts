// 消息队列层（NATS 旁路）—— TS 侧（core = 逻辑层运行时）。
//
// 约定与 gate 的 `gate/internal/natsmq` 一一对应（两层 IPC 里的"第二层"，主通道仍是 TCP 直连）：
//
//   entity_{id}_logic_mq —— 服务器 → 服务器：entity 所在的服务器监听（本侧 consume）
//   entity_{id}_gate_mq  —— 服务器 → gate：玩家所在 gate 监听，逻辑层往这里 publish
//
// 消息体 = `toBinary(Envelope)`，**无帧头**——帧头是给 TCP 流切帧用的，MQ 自带消息边界。
// 只用核心 NATS（at-most-once，断线期间消息不补）；要可靠性再上 JetStream，接口不变。
//
// 与 rpc.ts 同一个套路：`createMq` 只依赖注入的 NatsLike（离线可测），
// 真连接由 `connectMq` 用 nats 官方客户端装配。

import { connect, type NatsConnection } from 'nats';

/** 投递给"玩家所在 gate"的 subject（逻辑侧 publish、gate 侧 subscribe）。 */
export function gateSubject(entityId: string): string {
  return `entity_${entityId}_gate_mq`;
}

/** 投递给"entity 所在服务器"的 subject（逻辑侧互相 subscribe）。 */
export function logicSubject(entityId: string): string {
  return `entity_${entityId}_logic_mq`;
}

/** 消费句柄：async iterable 拉取（TS 版的"channel 拉取"），cancel 后迭代自然结束。 */
export interface MqConsume {
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>;
  /** 退订：返回后迭代器立刻结束（在途消息不再投递）。 */
  cancel(): void;
}

export interface Mq {
  publish(subject: string, body: Uint8Array): void;
  consume(subject: string, opts?: { queue?: string }): MqConsume;
  close(): void;
}

/** NatsLike 是 createMq 需要的最小能力（真连接/测试假连接都实现它）。 */
export interface NatsLike {
  publish(subject: string, data: Uint8Array): void;
  subscribe(
    subject: string,
    onData: (data: Uint8Array) => void,
    opts?: { queue?: string },
  ): { unsubscribe(): void };
  close(): void;
}

/** 慢消费者的缓冲上限：满了丢弃（旁路 at-most-once，慢消费者不反压 NATS 的分发线程）。 */
const QUEUE_LIMIT = 128;

export function createMq(nats: NatsLike): Mq {
  return {
    publish(subject, body) {
      nats.publish(subject, body);
    },

    consume(subject, opts) {
      const queue: Uint8Array[] = [];
      const waiters: Array<(r: IteratorResult<Uint8Array>) => void> = [];
      let dropped = 0;
      let done = false;

      const sub = nats.subscribe(subject, (data) => {
        if (done) return; // cancel 已调用：在途消息直接丢弃
        const w = waiters.shift();
        if (w) {
          w({ value: data, done: false });
        } else if (queue.length < QUEUE_LIMIT) {
          queue.push(data);
        } else {
          dropped++;
          if (dropped === 1 || dropped % 100 === 0) {
            console.warn(`natsmq: ${subject} 消费过慢，已丢弃 ${dropped} 条消息`);
          }
        }
      }, { queue: opts?.queue });

      const consume: MqConsume = {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<Uint8Array>> {
              const buffered = queue.shift();
              if (buffered !== undefined) {
                return { value: buffered, done: false };
              }
              if (done) {
                return { value: undefined, done: true };
              }
              return new Promise((resolve) => waiters.push(resolve));
            },
          };
        },
        cancel() {
          if (done) return;
          done = true;
          sub.unsubscribe();
          queue.length = 0;
          for (const w of waiters.splice(0)) {
            w({ value: undefined, done: true });
          }
        },
      };
      return consume;
    },

    close() {
      nats.close();
    },
  };
}

/** 建真连接（nats 官方客户端；断线自动无限重连，订阅重连后自动恢复）。 */
export async function connectMq(opts: { url: string; name?: string }): Promise<Mq> {
  const nc: NatsConnection = await connect({
    servers: opts.url,
    name: opts.name,
    reconnect: true, // 默认就无限重连；显式写出来给读者一个信号
    reconnectTimeWait: 2000,
  });
  return createMq(wrapNats(nc));
}

/** 把 nats 客户端的订阅回调形状对齐到 NatsLike。 */
function wrapNats(nc: NatsConnection): NatsLike {
  return {
    publish(subject, data) {
      nc.publish(subject, data);
    },
    subscribe(subject, onData, opts) {
      const sub = nc.subscribe(subject, {
        queue: opts?.queue,
        callback: (_err, msg) => onData(msg.data),
      });
      return { unsubscribe: () => sub.unsubscribe() };
    },
    close() {
      void nc.close();
    },
  };
}
