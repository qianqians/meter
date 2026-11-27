// Actor 验收测试——离线，无协议、无网络：只测队列语义本身。
//
// 四条硬断言来自 docs/abelkhan-core-gap.md §2.1：FIFO / 异常隔离 / 可重入 / 并发恰好一次。
// 外加 fence（迁移的切割点）与 close（实体销毁）的语义。

import { describe, expect, it } from 'vitest';
import { Actor, ActorClosedError } from './actor';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('Actor', () => {
  it('FIFO：先入队的先执行完，即使后面的 job 更快', async () => {
    const a = new Actor();
    const done: string[] = [];
    a.post(async () => { await sleep(20); done.push('slow'); });
    a.post(async () => { await sleep(1); done.push('fast'); });
    a.post(() => { done.push('sync'); });

    await a.fence();
    expect(done).toEqual(['slow', 'fast', 'sync']);
  });

  it('并发恰好一次：任何时刻 ≤1 个 job 在跑，且队列非空必有人跑', async () => {
    const a = new Actor();
    let running = 0;
    let maxRunning = 0;
    let ran = 0;
    const job = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await tick();
      ran++;
      running--;
    };

    for (let i = 0; i < 20; i++) a.post(job);
    // 运行中再入队：不能漏跑
    a.post(() => {
      a.post(job);
    });

    await a.fence();
    expect(ran).toBe(20); // fence 只覆盖调用那一刻已入队的
    await a.fence();
    expect(ran).toBe(21);
    expect(maxRunning).toBe(1);
  });

  it('异常隔离：job 抛错只进 onError，后续 job 照常执行', async () => {
    const errors: unknown[] = [];
    const a = new Actor({ onError: (e) => errors.push(e) });
    const done: number[] = [];

    a.post(() => { done.push(1); });
    a.post(() => { throw new Error('boom'); });
    a.post(() => { done.push(3); });

    await a.fence();
    expect(done).toEqual([1, 3]);
    expect(errors.length).toBe(1);
  });

  it('onError 自己抛错也不打死队列', async () => {
    const a = new Actor({
      onError: () => {
        throw new Error('logger 也炸了');
      },
    });
    const done: number[] = [];

    a.post(() => { throw new Error('业务炸'); });
    a.post(() => { done.push(2); });

    await a.fence();
    expect(done).toEqual([2]);
  });

  it('可重入：job 等外部事件时第二条必须排队；外部 resolve 后继续（模拟等客户端回包）', async () => {
    const a = new Actor();
    let answer!: (v: string) => void;
    const rsp = new Promise<string>((r) => { answer = r; });
    const order: string[] = [];

    a.post(async () => {
      const v = await rsp; // 队列外（onClientResponse）resolve
      order.push(v);
    });
    a.post(() => { order.push('second'); });

    await tick();
    expect(order).toEqual([]); // 第一条没完成，第二条不许开始

    answer('client-rsp');
    await a.fence();
    expect(order).toEqual(['client-rsp', 'second']);
  });

  it('fence：只覆盖调用这一刻已入队的 job', async () => {
    const a = new Actor();
    const done: string[] = [];
    a.post(async () => { await sleep(5); done.push('before'); });

    const fenced = a.fence();
    a.post(() => { done.push('after'); });

    await fenced;
    expect(done).toEqual(['before']); // 'after' 不在 fence 的范围内
    await a.fence();
    expect(done).toEqual(['before', 'after']);
  });

  it('fence：空队列立即 resolve，pending 归零', async () => {
    const a = new Actor();
    await a.fence();
    expect(a.pending).toBe(0);
  });

  it('pending 只数排队中的（正在执行的那条不算）', async () => {
    const a = new Actor();
    a.post(async () => { await sleep(5); });
    a.post(() => {});
    a.post(() => {});

    expect(a.pending).toBe(2); // 一条在跑，两条排队

    await a.fence();
    expect(a.pending).toBe(0);
  });

  it('call：返回值透传；抛错时调用方 reject 且 onError 也收到一次', async () => {
    const errors: unknown[] = [];
    const a = new Actor({ onError: (e) => errors.push(e) });

    expect(await a.call(() => 42)).toBe(42);
    expect(await a.call(async () => 'x')).toBe('x');

    await expect(a.call(async () => { throw new Error('bad'); })).rejects.toThrow('bad');
    expect(errors.length).toBe(1);
  });

  it('close：丢排队、reject 等待方、拒新 job，正在执行的不打断', async () => {
    const a = new Actor();
    const ran: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    a.post(async () => { await gate; ran.push('running'); });
    const queued = a.call(() => { ran.push('queued'); });
    expect(a.pending).toBe(1);

    a.close();

    await expect(queued).rejects.toBeInstanceOf(ActorClosedError);
    expect(a.post(() => { ran.push('late'); })).toBe(false);
    expect(a.droppedCount).toBe(1);

    release(); // 在途那一条跑完
    await sleep(1);
    expect(ran).toEqual(['running']);
    expect(a.pending).toBe(0);

    a.close(); // 幂等
    expect(a.closed).toBe(true);
  });

  it('close 之后的 fence 快速 reject，不 hang', async () => {
    const a = new Actor();
    a.close();
    await expect(a.fence()).rejects.toBeInstanceOf(ActorClosedError);
  });
});
