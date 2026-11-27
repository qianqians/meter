// 文档仓库：PG 是真相，Redis 是它的一份 JSON 副本。
//
// 一次 `save` 的顺序是**先库后缓存**，不是反过来：
//   · 库写失败 → 直接抛（缓存里不会出现一个库上没有的版本）；
//   · 库写成功、缓存写失败 → PG 已经是新的，旧缓存会在 TTL 后自己烂掉；这里再试一次 `DEL`，
//     让下一次读立刻回源（不把"缓存写失败"升级成"存档失败"）。
//
// 读的顺序是 **Redis → PG → 回填**：命中就当版本一起拿到（缓存里存的就是 `{v, d}`，
// 少了版本就没法给 CAS 当期望值）。

import {
  StorageConflictError,
  StorageUnavailableError,
  cacheKey,
  defaultStorageConfig,
  validateStorageConfig,
  type CacheClient,
  type CachedDocument,
  type Document,
  type DocumentStore,
  type SqlExecutor,
  type StorageConfig,
  type StorageStats,
} from './types';

export interface DocumentStoreOptions {
  /** 文档类型；同一个 store 只服务一类文档。 */
  kind: string;
  sql: SqlExecutor;
  cache: CacheClient;
  config?: StorageConfig;
  /** 毫秒时钟（默认 `Date.now`），测试注入。 */
  now?: () => number;
  /** 非致命问题（缓存写失败、缓存内容解不开）。默认静默，由调用方决定是否打日志。 */
  onWarn?: (message: string, err?: unknown) => void;
}

export function createDocumentStore<T>(opts: DocumentStoreOptions): DocumentStore<T> {
  const { kind, sql, cache, now = () => Date.now(), onWarn } = opts;
  const config = opts.config ?? defaultStorageConfig();
  validateStorageConfig(config);
  const table = config.table;
  const ttlMs = config.cache.ttlMs;

  const stats: StorageStats = {
    cacheHit: 0, cacheMiss: 0, cacheError: 0, cacheBad: 0,
    pgLoad: 0, pgSave: 0, conflict: 0, cacheWriteFailed: 0, deletes: 0,
  };

  /** 等待周期写盘的文档：`kind:id` → 文档（同一个键只留最新的一份）。 */
  const dirty = new Map<string, Document<T>>();
  let lastCacheFlush = now();
  let lastPgFlush = now();

  const warn = (msg: string, err?: unknown) => {
    onWarn?.(msg, err);
  };

  // ---------------- 缓存 ----------------

  function parseCached(raw: string): { value: T; version: number } | undefined {
    try {
      const parsed = JSON.parse(raw) as Partial<CachedDocument<T>>;
      // 只挡"形状不像"，不做 T 的运行时校验（T 只承诺可 JSON 序列化）。
      if (typeof parsed !== 'object' || parsed === null || typeof parsed.v !== 'number' || !('d' in parsed)) {
        return undefined;
      }
      return { value: parsed.d as T, version: parsed.v };
    } catch {
      return undefined;
    }
  }

  /** 写缓存；失败只记账并尝试 DEL（别让旧值留到 TTL）。 */
  async function writeCache(doc: Document<T>): Promise<void> {
    const key = cacheKey(config, kind, doc.id);
    const payload: CachedDocument<T> = { v: doc.version, d: doc.value };
    try {
      await cache.set(key, JSON.stringify(payload), { PX: ttlMs });
    } catch (err) {
      stats.cacheWriteFailed++;
      warn(`写缓存失败，尝试删除 ${key}`, err);
      try {
        await cache.del(key);
      } catch (delErr) {
        warn(`删除失败（旧值会留到 TTL）${key}`, delErr);
        return;
      }
      return;
    }
  }

  /** 回填缓存：失败不影响这次读（PG 已经拿到值了）。 */
  async function backfill(doc: Document<T>): Promise<void> {
    await writeCache(doc);
  }

  // ---------------- 库 ----------------

  const loadSql = `select version, body from ${table} where kind = $1 and doc_id = $2`;

  // 一条语句同时处理"新建"与"按版本更新"：
  //   $3 = 期望版本 + 1。
  //   · $3 = 1（期望 0）才允许插入 —— 所以"我以为它存在（expect > 0），但其实没有"会返回 0 行 = 冲突；
  //   · 冲突时 `where version = $3 - 1` 才做更新，否则 0 行 = 冲突。
  const upsertSql = `insert into ${table} (kind, doc_id, version, body, updated_at)
select $1, $2, $3, $4::jsonb, now()
 where $3 = 1
on conflict (kind, doc_id) do update
   set version = ${table}.version + 1, body = excluded.body, updated_at = now()
 where ${table}.version = $3 - 1
returning version`;

  /** PG 的 jsonb 由驱动解析成对象；测试里的假实现可能给字符串，两种都接。 */
  function normalizeValue(raw: unknown): T {
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw) as T;
      } catch {
        return raw as T;
      }
    }
    return raw as T;
  }

  async function persistPg(doc: Document<T>): Promise<Document<T>> {
    const expected = doc.version;
    const next = expected + 1;
    const { rows } = await sql.query<{ version: string | number }>(upsertSql, [
      kind, doc.id, next, JSON.stringify(doc.value), expected,
    ]);
    if (rows.length === 0) {
      stats.conflict++;
      throw new StorageConflictError(kind, doc.id, expected);
    }
    stats.pgSave++;
    return {
      kind, id: doc.id, value: doc.value,
      version: Number(rows[0].version), dirty: false, savedAt: now(),
    };
  }

  // ---------------- 对外 ----------------

  async function load(id: string): Promise<Document<T> | undefined> {
    const key = cacheKey(config, kind, id);

    try {
      const raw = await cache.get(key);
      if (raw !== null) {
        const hit = parseCached(raw);
        if (hit) {
          stats.cacheHit++;
          return { kind, id, value: hit.value, version: hit.version, dirty: false, savedAt: now() };
        }
        // 缓存内容坏了：当成未命中回源，不把解析异常抛给业务。
        stats.cacheBad++;
        warn(`缓存内容解不开，回源 ${key}`);
      } else {
        stats.cacheMiss++;
      }
    } catch (err) {
      stats.cacheError++;
      if (config.cache.failFast) {
        // 缓存挂掉时绝不回源：否则一次 Redis 故障会变成一次 DB 流量洪峰（go-zero 同款理由）。
        throw new StorageUnavailableError(`缓存读失败（failFast）: ${key}`, err);
      }
      warn(`缓存读失败，回源 ${key}`, err);
    }

    const { rows } = await sql.query<{ version: string | number; body: unknown }>(loadSql, [kind, id]);
    stats.pgLoad++;
    if (rows.length === 0) {
      return undefined;
    }
    const doc: Document<T> = {
      kind, id, value: normalizeValue(rows[0].body),
      version: Number(rows[0].version), dirty: false, savedAt: now(),
    };
    await backfill(doc);
    return doc;
  }

  async function save(doc: Document<T>): Promise<Document<T>> {
    const saved = await persistPg(doc);
    await writeCache(saved);
    return saved;
  }

  async function del(id: string): Promise<void> {
    const key = cacheKey(config, kind, id);
    // 先删缓存再删库：反过来的话，库删成功、缓存删失败，就会继续拿 TTL 之内的旧值。
    try {
      await cache.del(key);
    } catch (err) {
      // 缓存删不掉不阻塞删档：TTL 会兜住（下次读之前它可能还是旧的，这是已知取舍）。
      stats.cacheWriteFailed++;
      warn(`删缓存失败 ${key}`, err);
    }
    await sql.query(`delete from ${table} where kind = $1 and doc_id = $2`, [kind, id]);
    stats.deletes++;
    dirty.delete(`${kind}:${id}`);
  }

  function track(doc: Document<T>): void {
    if (!doc.dirty) return;
    dirty.set(`${kind}:${doc.id}`, doc);
  }

  /** 按配置的两个间隔把 dirty 文档写出去；返回这一轮各目标写了多少份。 */
  async function flushDirty(nowMs = now()): Promise<{ cache: number; pg: number }> {
    const dueCache = config.flush.cacheIntervalMs > 0 && nowMs - lastCacheFlush >= config.flush.cacheIntervalMs;
    const duePg = config.flush.pgIntervalMs > 0 && nowMs - lastPgFlush >= config.flush.pgIntervalMs;
    if (!dueCache && !duePg) {
      return { cache: 0, pg: 0 };
    }
    if (dueCache) lastCacheFlush = nowMs;
    if (duePg) lastPgFlush = nowMs;

    let wroteCache = 0;
    let wrotePg = 0;
    for (const [key, doc] of [...dirty]) {
      let current = doc;
      if (duePg) {
        try {
          current = await persistPg(current);
          wrotePg++;
        } catch (err) {
          // 周期写盘撞版本冲突：说明别处已经改过这份文档（顶号 / 另一个节点）。
          // 这里没有"重读合并"的语义，只能丢掉这一份并记账——业务下次 load 会拿到新版本。
          dirty.delete(key);
          warn(`周期写盘版本冲突，丢弃脏数据 ${key}`, err);
          continue;
        }
      }
      if (dueCache) {
        await writeCache(current);
        wroteCache++;
      }
      if (duePg) {
        // 落库了才算干净：从队列里摘掉，下次 track 会重新登记。
        dirty.delete(key);
        current.dirty = false;
      } else {
        // 只写了缓存：**必须留在队列里**，否则这份改动永远等不到落库（缓存比库写得勤时必踩）。
        dirty.set(key, current);
      }
    }
    return { cache: wroteCache, pg: wrotePg };
  }

  return {
    load,
    save,
    delete: del,
    track,
    flushDirty,
    get dirtyCount() {
      return dirty.size;
    },
    stats,
  };
}
