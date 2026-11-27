// 周期性写盘：把「什么时候写 Redis / 什么时候写 PG」从业务里收走。
//
// 两个间隔由配置给（见 `StorageConfig.flush`），一个 ticker 同时驱动所有 store：
// 每个 store 自己判断这一个周期里哪个目标到点了（缓存通常比库写得勤）。
//
// 事件路径（迁移 / 顶号 / 下线）不走这里——那些是 `save()`，立即两边全量写。

import type { DocumentStore } from './types';

export interface AutoFlushOptions {
  /** ticker 的步进；默认取两个间隔里较小的那个（再兜底 5s）。 */
  intervalMs?: number;
  /** ticker 用（默认 `setInterval`），测试注入假实现。 */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** 单轮出错（某个 store 抛错）时的回调；默认静默，不打断其它 store。 */
  onError?: (err: unknown) => void;
}

/**
 * 启动自动写盘；返回 `stop()`。
 *
 * `intervalMs` 只是 ticker 的粒度，不是落盘间隔——真正决定"这次该不该写"的是每个 store 的
 * `flushDirty`（它按配置的两个间隔判断）。
 */
export function startAutoFlush(
  stores: Array<Pick<DocumentStore<unknown>, 'flushDirty'>>,
  opts: AutoFlushOptions = {},
): () => void {
  const interval = opts.intervalMs ?? 5000;
  if (interval <= 0 || stores.length === 0) {
    return () => {};
  }
  const set = opts.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clear = opts.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  const now = () => Date.now();

  const handle = set(() => {
    for (const store of stores) {
      void store.flushDirty(now()).catch((err: unknown) => opts.onError?.(err));
    }
  }, interval);

  return () => clear(handle);
}
