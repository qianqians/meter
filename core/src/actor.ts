// 串行任务队列（Actor / mailbox）：**一个实体同一时刻只有一个 job 在跑**。
//
// 语义（FIFO / 异常隔离 / fence / close）与它们为什么长这样，见 core/SPEC.md「执行模型」。
// ⚠️ 这里只需要一个 `draining` 布尔，**不要照搬 abelkhan 的 CAS claim**：它的 claim+复查
// 是 C# 多线程的要求；JS 单线程下「队列空 → 释放 draining」之间没有 await，post 插不进来。

/** 一个 job：同步或异步，返回值被忽略（要返回值用 `call`）。 */
export type Job = () => void | Promise<void>;

export interface ActorOptions {
  /** job 抛错时的回调。它自己抛错也不会打断队列。默认静默（由持有者计数）。 */
  onError?: (err: unknown) => void;
}

/** 队列已关闭（实体销毁 / 迁移交出）时，排队中与被丢弃的 job 收到的错误。 */
export class ActorClosedError extends Error {
  constructor() {
    super('actor 已关闭：job 不再执行');
    this.name = 'ActorClosedError';
  }
}

interface Entry {
  run: () => void | Promise<void>;
  /** 队列被关闭时如何通知等待方（`post` 的 job 没有等待方，就是 `undefined`）。 */
  cancel?: (err: Error) => void;
}

export class Actor {
  /** 待执行区。用 head 下标出队而不是 `shift()`：这是消息热路径，shift 是 O(n)。 */
  private q: Entry[] = [];
  private head = 0;
  private draining = false;
  private shutdown = false;
  private dropped = 0;

  private readonly onError: (err: unknown) => void;

  constructor(opts: ActorOptions = {}) {
    this.onError = opts.onError ?? (() => {});
  }

  get closed(): boolean {
    return this.shutdown;
  }

  /** 还没开始执行的 job 数（正在执行的那一条不算，同 abelkhan 的 `PendingCount`）。 */
  get pending(): number {
    return this.q.length - this.head;
  }

  /** 被 close/丢弃的 job 数（诊断用）。 */
  get droppedCount(): number {
    return this.dropped;
  }

  /** 入队，不等待。返回 false 表示队列已关闭、这条 job 没有入队。 */
  post(job: Job): boolean {
    return this.push({ run: job });
  }

  /**
   * 入队并拿到这条 job 的结果。
   *
   * job 抛错时**同时**通知调用方（reject）与 `onError`——两者用途不同：调用方要处理失败，
   * onError 负责计数/日志。已关闭时同步 reject（`ActorClosedError`）。
   */
  call<T>(job: () => T | Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.push({
        run: async () => {
          let value: T;
          try {
            value = await job();
          } catch (err) {
            reject(err);
            throw err; // 交给 drain 记一次 onError
          }
          resolve(value);
        },
        cancel: reject,
      });
    });
  }

  /**
   * 切割点：排在**调用这一刻**已入队的 job 之后，它们全部完成后 resolve。
   *
   * 只能在队列外调用——在 job 里 fence 自己会自锁（它在等包含自己的队列跑空）。
   */
  fence(): Promise<void> {
    return this.call(() => {});
  }

  /**
   * 关掉队列：不再收新 job，排队中的全部丢弃（`call` 的等待方收到 `ActorClosedError`）。
   * **正在执行的那一条不打断**——JS 没有取消，它会跑完，之后队列才真正空闲。
   */
  close(): void {
    if (this.shutdown) {
      return;
    }
    this.shutdown = true;
    const rest = this.q.slice(this.head);
    this.q = [];
    this.head = 0;
    this.dropped += rest.length;
    for (const entry of rest) {
      entry.cancel?.(new ActorClosedError());
    }
  }

  // ---------------- 内部 ----------------

  private push(entry: Entry): boolean {
    if (this.shutdown) {
      entry.cancel?.(new ActorClosedError());
      return false;
    }
    this.q.push(entry);
    // 单线程：这里到 drain 里"释放 draining"之间没有 await，不需要复查/抢占。
    if (!this.draining) {
      this.draining = true;
      void this.drain();
    }
    return true;
  }

  private async drain(): Promise<void> {
    try {
      while (this.head < this.q.length) {
        const entry = this.q[this.head]!;
        this.head++;
        try {
          await entry.run();
        } catch (err) {
          this.report(err);
        }
      }
      // 队列真的跑空了：回收数组（长连接活很久，别让 head 一直涨）。
      this.q = [];
      this.head = 0;
    } finally {
      this.draining = false;
      // 正常路径下队列已空；若 drain 自身出了意外（理论上不会），队列与 head 保持原样，
      // 下一次 post 会从这里继续——不丢 job、不永久停摆。
    }
  }

  private report(err: unknown): void {
    try {
      this.onError(err);
    } catch {
      // onError 是记日志的钩子；它自己抛错不该打死这个实体的队列。
    }
  }
}
