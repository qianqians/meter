// 存储模块的**类型与接口**：一份文档 = 一个 JSON。
//
// 形状参考 zeromicro/go-zero 的 `sqlc.CachedConn` + `cache.cacheNode`，但按本项目的取舍改了三点：
//
//   1. **文档粒度，不是字段粒度**：go-zero 的 model 给每个字段一个缓存键（主键键 + 每个唯一索引键），
//      因此要有"索引键与主键键之间 5s 安全间隙"来兜不同步；我们一条记录就是一个 `Document<T>`
//      （`JSON.stringify` 整个值），一个键，天然没有这个问题。
//   2. **写穿，不是写后删键**：事件路径（迁移/顶号/下线）把同一份 JSON 全量写 PG 与 Redis；
//      缓存靠 `cache.ttlMs` 自然淘汰。go-zero 是"写后删键 + 下次读回源"。
//   3. **周期性写盘由配置给的两个间隔控制**（`flush.cacheIntervalMs` / `flush.pgIntervalMs`），
//      而不是每个 model 各调各的。
//
// 只依赖两个极小的驱动接口（`SqlExecutor` / `CacheClient`），`pg.Pool` 与 node-redis 的客户端
// 结构上都满足它们——所以这一层能完全离线单测。

/** 一份文档的元信息 + 值。`version` 是乐观锁（新建为 0，每次成功保存 +1）。 */
export interface Document<T> {
  /** 文档类型（决定缓存键前缀与反序列化目标）。 */
  readonly kind: string;
  /** 业务主键（例如 entity_id）。 */
  readonly id: string;
  value: T;
  /** 加载/保存时的版本；`save` 用它做 CAS 期望值。 */
  version: number;
  /** 上次成功落库后是否改过。周期性写盘只看它。 */
  dirty: boolean;
  /** 最近一次成功写入的时间（毫秒，由注入的 `now` 提供）。 */
  savedAt: number;
}

/**
 * 文档仓库。错误只有两类，都能被业务可靠区分：
 *   · `StorageConflictError`（错误码 12）：版本 CAS 失败——别处已经改过这份文档；
 *   · `StorageUnavailableError`：存储读不通（缓存快速失败 / PG 连不上）。
 * 其余都是驱动层的原始错误，原样上抛。
 */
export interface DocumentStore<T> {
  /** Redis → PG → 回填 Redis。没有这份文档时返回 undefined（不是错误）。 */
  load(id: string): Promise<Document<T> | undefined>;
  /**
   * 全量写：先 PG（带版本 CAS），成功后写 Redis（`SET ... PX ttl`）。
   * 返回新版本（`doc` 本身不被就地修改）。
   */
  save(doc: Document<T>): Promise<Document<T>>;
  /** 两边都删（删档 / 离线回收）。删不存在的文档不是错误。 */
  delete(id: string): Promise<void>;
  /** 登记一份脏文档（周期性写盘只看登记过的）。 */
  track(doc: Document<T>): void;
  /**
   * 按配置的两个间隔（`flush.cacheIntervalMs` / `flush.pgIntervalMs`）把登记的文档写出去。
   * 返回这一轮各目标实际写了多少份。没到点就什么都不做。
   */
  flushDirty(nowMs?: number): Promise<{ cache: number; pg: number }>;
  /** 还等着周期写盘的文档数。 */
  readonly dirtyCount: number;
  readonly stats: StorageStats;
}

/** 驱动接口：只要能执行参数化 SQL。`pg.Pool` / `pg.Client` 结构上满足它。 */
export interface SqlExecutor {
  query<R extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: R[] }>;
}

/** 驱动接口：只要能存取字符串并带毫秒级过期。node-redis 的客户端结构上满足它。 */
export interface CacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { PX: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/** 存储配置。默认值就是"能跑但别上生产"的那一档，见 `defaultStorageConfig`。 */
export interface StorageConfig {
  /** 文档表名（`documents` 是建表 SQL 里的默认值）。 */
  table: string;
  cache: {
    /** 缓存键前缀：`{prefix}{kind}:{id}`。 */
    prefix: string;
    /** Redis 淘汰时间（毫秒）——也是"一段时间不管它就忘掉"的实现方式。 */
    ttlMs: number;
    /**
     * Redis 读失败时是否直接失败（默认 true）。
     * go-zero 的理由同样成立：缓存挂了要快速失败，不能让它变成 DB 的流量洪峰。
     */
    failFast: boolean;
  };
  flush: {
    /** 周期性把 dirty 文档写进 Redis 的间隔；0 = 不周期写缓存。 */
    cacheIntervalMs: number;
    /** 周期性把 dirty 文档写进 PG 的间隔；0 = 不周期写库。 */
    pgIntervalMs: number;
  };
}

export function defaultStorageConfig(): StorageConfig {
  return {
    table: 'documents',
    cache: { prefix: 'doc:', ttlMs: 15 * 60_000, failFast: true },
    // 缓存比库写得勤：缓存是重建成本低的那一层，库要攒批。
    flush: { cacheIntervalMs: 30_000, pgIntervalMs: 120_000 },
  };
}

/** 启动即校验：配置错了在这里炸，不要等到第一次存档。 */
export function validateStorageConfig(cfg: StorageConfig): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(cfg.table)) {
    throw new Error(`storage.table 不是合法标识符: ${JSON.stringify(cfg.table)}`);
  }
  if (cfg.cache.ttlMs <= 0) {
    throw new Error('storage.cache.ttlMs 必须大于 0（否则缓存写进去就过期）');
  }
  for (const [name, ms] of Object.entries(cfg.flush)) {
    if (ms < 0) {
      throw new Error(`storage.flush.${name} 不能为负`);
    }
  }
}

/** 缓存键：`{prefix}{kind}:{id}`。 */
export function cacheKey(cfg: StorageConfig, kind: string, id: string): string {
  return `${cfg.cache.prefix}${kind}:${id}`;
}

/** 存储错误码，与 `schema/pb/common.proto` 的约定一致。 */
export const STORAGE_ERR = {
  UNKNOWN: 1,
  /** STORAGE_CONFLICT：乐观锁版本不匹配。 */
  CONFLICT: 12,
} as const;

export class StorageConflictError extends Error {
  readonly code = STORAGE_ERR.CONFLICT;
  constructor(
    readonly kind: string,
    readonly id: string,
    readonly expected: number,
  ) {
    super(`存储版本冲突: ${kind}/${id} 期望 version=${expected}`);
    this.name = 'StorageConflictError';
  }
}

export class StorageUnavailableError extends Error {
  readonly code = STORAGE_ERR.UNKNOWN;
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'StorageUnavailableError';
  }
}

/** 缓存里存的东西：值和版本一起——否则命中缓存时拿不到 CAS 期望值。 */
export interface CachedDocument<T> {
  v: number;
  d: T;
}

/** 存储模块的计数器（接 metrics 时直接读它）。 */
export interface StorageStats {
  cacheHit: number;
  cacheMiss: number;
  cacheError: number;
  /** 缓存里的 JSON 解不开（当作未命中回源，不把异常抛给业务）。 */
  cacheBad: number;
  pgLoad: number;
  pgSave: number;
  conflict: number;
  /** PG 写成功但 Redis 写失败（已尝试 DEL 兜底）。 */
  cacheWriteFailed: number;
  deletes: number;
}
