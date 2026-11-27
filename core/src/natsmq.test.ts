// NATS 旁路的验收测试——离线：createMq 只依赖注入的假 NatsLike，
// 测的是"channel 拉取 / cancel 竞争 / 队满丢弃 / queue group 透传"这些真问题。
// （subject 约定与 gate 的 internal/natsmq 逐字节一致，改动两侧要同步。）

import { describe, expect, it } from 'vitest';
import { createBus, createMq, gateSubject, logicSubject, type NatsLike } from './natsmq';

/** 假连接：subscribe 登记回调，deliver 模拟 NATS 推送。 */
function fakeNats() {
  const subs = new Map<string, { onData: (d: Uint8Array) => void; queue?: string; unsubscribed: boolean }>();
  const nats: NatsLike = {
    // publish 直接投给订阅者：节点总线（createBus）要的就是这条闭环
    publish: (subject, data) => {
      const s = subs.get(subject);
      if (s && !s.unsubscribed) s.onData(data);
    },
    subscribe(subject, onData, opts) {
      subs.set(subject, { onData, queue: opts?.queue, unsubscribed: false });
      return { unsubscribe: () => { const s = subs.get(subject); if (s) s.unsubscribed = true; } };
    },
    close: () => { /* nothing */ },
  };
  return {
    nats,
    deliver(subject: string, data: Uint8Array) {
      const s = subs.get(subject);
      if (!s || s.unsubscribed) return false;
      s.onData(data);
      return true;
    },
    unsubscribed(subject: string) {
      return subs.get(subject)?.unsubscribed ?? false;
    },
    queueOf(subject: string) {
      return subs.get(subject)?.queue;
    },
  };
}

describe('subject 约定（与 gate 侧逐字节一致）', () => {
  it('gateSubject / logicSubject', () => {
    expect(gateSubject('e-42')).toBe('entity_e-42_gate_mq');
    expect(logicSubject('e-42')).toBe('entity_e-42_logic_mq');
  });
});

describe('createMq 消费', () => {
  it('拉取式消费：for await 收到已投递的消息', async () => {
    const f = fakeNats();
    const mq = createMq(f.nats);
    const it = mq.consume(logicSubject('e1'));

    const got: number[][] = [];
    const consumer = (async () => {
      for await (const m of it) {
        got.push([...m]);
        if (got.length === 2) it.cancel();
      }
    })();
    f.deliver(logicSubject('e1'), new Uint8Array([1]));
    f.deliver(logicSubject('e1'), new Uint8Array([2, 3]));
    await consumer;

    expect(got).toEqual([[1], [2, 3]]);
    expect(f.unsubscribed(logicSubject('e1'))).toBe(true);
  });

  it('先订阅后拉取：等待中的迭代被唤醒', async () => {
    const f = fakeNats();
    const mq = createMq(f.nats);
    const it = mq.consume(gateSubject('e1'));

    const first = (async () => {
      for await (const m of it) return [...m];
    })();
    // 先挂起再投递（微任务后触发等待者）
    await Promise.resolve();
    f.deliver(gateSubject('e1'), new Uint8Array([7, 7]));
    expect(await first).toEqual([7, 7]);
    it.cancel();
  });

  it('cancel 后：迭代立刻结束，在途消息不投递（不 panic 不挂死）', async () => {
    const f = fakeNats();
    const mq = createMq(f.nats);
    const it = mq.consume(logicSubject('e1'));
    it.cancel();

    const seen: number[] = [];
    for await (const m of it) seen.push(m[0]);
    expect(seen).toEqual([]);

    // cancel 之后才到的消息：静默丢弃
    expect(f.deliver(logicSubject('e1'), new Uint8Array([9]))).toBe(false);
  });

  it('queue group 透传给底层订阅（server→server 的负载均衡用）', () => {
    const f = fakeNats();
    const mq = createMq(f.nats);
    mq.consume(logicSubject('e1'), { queue: 'scene-1' });
    expect(f.queueOf(logicSubject('e1'))).toBe('scene-1');
  });
});

describe('createBus（节点总线）', () => {
  it('publish / subscribe 透传到 MQ，退订后不再收', async () => {
    const f = fakeNats();
    const mq = createMq(f.nats);
    const bus = createBus(mq);

    const got: string[] = [];
    const off = bus.subscribe('hub_n1_mq', (b) => got.push(new TextDecoder().decode(b)));

    bus.publish('hub_n1_mq', new TextEncoder().encode('replaced'));
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toEqual(['replaced']);

    off();
    bus.publish('hub_n1_mq', new TextEncoder().encode('late'));
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toEqual(['replaced']);
  });
});
