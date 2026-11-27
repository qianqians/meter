// 自动写盘的调度语义：ticker 的粒度 ≠ 落盘间隔（后者由 store 内的配置判断）。

import { describe, expect, it } from 'vitest';
import { startAutoFlush } from './flusher';

describe('startAutoFlush', () => {
  it('ticker 到点调用每个 store 的 flushDirty；stop 后不再调用', async () => {
    let tick: (() => void) | undefined;
    let cleared = false;
    const calls: number[] = [];
    const stores = [
      { flushDirty: async (now?: number) => { calls.push(now ?? 0); return { cache: 0, pg: 0 }; } },
    ];

    const stop = startAutoFlush(stores, {
      intervalMs: 100,
      setInterval: (fn) => { tick = fn; return 7; },
      clearInterval: (h) => { cleared = h === 7; },
    });

    tick!();
    tick!();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.length).toBe(2);

    stop();
    expect(cleared).toBe(true);
  });

  it('一个 store 抛错不影响其它 store，也不炸 ticker', async () => {
    let tick: (() => void) | undefined;
    const errors: unknown[] = [];
    let okCalls = 0;
    const stores = [
      { flushDirty: async () => { throw new Error('pg down'); } },
      { flushDirty: async () => { okCalls++; return { cache: 0, pg: 0 }; } },
    ];

    startAutoFlush(stores, {
      intervalMs: 100,
      setInterval: (fn) => { tick = fn; return 1; },
      clearInterval: () => {},
      onError: (e) => errors.push(e),
    });

    tick!();
    await new Promise((r) => setTimeout(r, 0));
    expect(okCalls).toBe(1);
    expect(errors.length).toBe(1);
  });

  it('intervalMs <= 0 或没有 store：直接返回空 stop', () => {
    expect(typeof startAutoFlush([], { intervalMs: 100 })).toBe('function');
    expect(typeof startAutoFlush([{ flushDirty: async () => ({ cache: 0, pg: 0 }) }], { intervalMs: 0 })).toBe('function');
  });
});
