// 存储模块的离线验收：只依赖两个假驱动（假 SQL / 假缓存），不需要 PG 与 Redis。
//
// 覆盖的是**编排语义**：缓存命中不回源、未命中回填、failFast 不回源、CAS 冲突、
// PG 写成功但缓存写失败不升级成存档失败、周期写盘只写登记的文档。
// 真 SQL 的语义在 `integration.test.ts`（需要 PG_URL + REDIS_URL，否则 skip）。

import { describe, expect, it } from 'vitest';

import { createDocumentStore } from './store';
import {
  StorageConflictError,
  StorageUnavailableError,
  defaultStorageConfig,
  type CacheClient,
  type SqlExecutor,
  type StorageConfig,
} from './types';

// ---------------- 假驱动 ----------------

interface Row {
  version: number;
  body: unknown;
}

/** 假 SQL：够模拟"文档表 + 版本 CAS"（真实 SQL 见 integration）。 */
function fakeSql(seed: Record<string, Row> = {}) {
  const docs = new Map<string, Row>(Object.entries(seed));
  const state = { queries: 0, texts: [] as string[] };

  const sql: SqlExecutor = {
    async query<R extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      state.queries++;
      state.texts.push(text.split(' ')[0] ?? '');
      const v = (values ?? []) as unknown[];
      const key = `${String(v[0])}:${String(v[1])}`;

      if (text.startsWith('select')) {
        const row = docs.get(key);
        return { rows: (row ? [{ version: String(row.version), body: row.body }] : []) as unknown as R[] };
      }
      if (text.startsWith('insert')) {
        const [, , next, body, expect] = v as [string, string, number, string, number];
        const cur = docs.get(key);
        if (cur === undefined) {
          if (next !== 1) return { rows: [] as unknown as R[] }; // 期望存在但其实没有 → 0 行
          docs.set(key, { version: 1, body: JSON.parse(body) });
          return { rows: [{ version: '1' }] as unknown as R[] };
        }
        if (cur.version !== expect) return { rows: [] as unknown as R[] };
        cur.version++;
        cur.body = JSON.parse(body);
        return { rows: [{ version: String(cur.version) }] as unknown as R[] };
      }
      if (text.startsWith('delete')) {
        docs.delete(key);
        return { rows: [] as unknown as R[] };
      }
      throw new Error(`假 SQL 不认识的语句: ${text}`);
    },
  };

  return { sql, docs, state };
}

function fakeCache(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed));
  const state = { failGet: false, failSet: false, failDel: false, sets: [] as string[], dels: 0, gets: 0 };

  const cache: CacheClient = {
    async get(key) {
      state.gets++;
      if (state.failGet) throw new Error('cache down');
      return map.get(key) ?? null;
    },
    async set(key, value) {
      if (state.failSet) throw new Error('cache set down');
      state.sets.push(key);
      map.set(key, value);
      return 'OK';
    },
    async del(key) {
      state.dels++;
      if (state.failDel) throw new Error('cache del down');
      map.delete(key);
      return 1;
    },
  };

  return { cache, map, state };
}

const CONFIG: StorageConfig = {
  ...defaultStorageConfig(),
  cache: { prefix: 'doc:', ttlMs: 60_000, failFast: true },
  flush: { cacheIntervalMs: 1000, pgIntervalMs: 5000 },
};

function setup(opts: { seed?: Record<string, Row>; cached?: Record<string, string>; config?: StorageConfig } = {}) {
  const sql = fakeSql(opts.seed);
  const cache = fakeCache(opts.cached);
  const warnings: string[] = [];
  let clock = 1_000;
  const store = createDocumentStore<{ hp: number }>({
    kind: 'player',
    sql: sql.sql,
    cache: cache.cache,
    config: opts.config ?? CONFIG,
    now: () => clock,
    onWarn: (m) => warnings.push(m),
  });
  return { store, sql, cache, warnings, advance: (ms: number) => { clock += ms; } };
}

// ---------------- 读 ----------------

describe('load：Redis → PG → 回填', () => {
  it('命中缓存：不回源，版本一起拿到', async () => {
    const { store, sql, cache } = setup({ cached: { 'doc:player:e1': JSON.stringify({ v: 7, d: { hp: 42 } }) } });

    const doc = await store.load('e1');
    expect(doc).toMatchObject({ kind: 'player', id: 'e1', value: { hp: 42 }, version: 7, dirty: false });
    expect(sql.state.queries).toBe(0);
    expect(cache.state.gets).toBe(1);
    expect(store.stats.cacheHit).toBe(1);
  });

  it('未命中：回源 PG 并回填缓存（带 TTL）', async () => {
    const { store, sql, cache } = setup({ seed: { 'player:e1': { version: 3, body: { hp: 10 } } } });

    const doc = await store.load('e1');
    expect(doc?.version).toBe(3);
    expect(doc?.value).toEqual({ hp: 10 });
    expect(sql.state.queries).toBe(1);
    expect(cache.map.get('doc:player:e1')).toBe(JSON.stringify({ v: 3, d: { hp: 10 } }));
    expect(store.stats.cacheMiss).toBe(1);
    expect(store.stats.pgLoad).toBe(1);
  });

  it('两边都没有：undefined，不回填', async () => {
    const { store, cache } = setup();
    expect(await store.load('nope')).toBeUndefined();
    expect(cache.state.sets).toEqual([]);
  });

  it('缓存内容是坏 JSON：当作未命中回源，不抛给业务', async () => {
    const { store, warnings } = setup({
      cached: { 'doc:player:e1': '{not json' },
      seed: { 'player:e1': { version: 1, body: { hp: 1 } } },
    });
    const doc = await store.load('e1');
    expect(doc?.value).toEqual({ hp: 1 });
    expect(store.stats.cacheBad).toBe(1);
    expect(warnings.some((w) => w.includes('解不开'))).toBe(true);
  });

  it('failFast=true（默认）：缓存读失败直接抛，不回源', async () => {
    const { store, sql, cache } = setup({ seed: { 'player:e1': { version: 1, body: { hp: 1 } } } });
    cache.state.failGet = true;

    await expect(store.load('e1')).rejects.toBeInstanceOf(StorageUnavailableError);
    expect(sql.state.queries).toBe(0); // 关键：一次 Redis 故障不能变成一次 DB 洪峰
  });

  it('failFast=false：缓存读失败回源 PG', async () => {
    const { store, sql, cache } = setup({
      seed: { 'player:e1': { version: 2, body: { hp: 2 } } },
      config: { ...CONFIG, cache: { ...CONFIG.cache, failFast: false } },
    });
    cache.state.failGet = true;

    const doc = await store.load('e1');
    expect(doc?.version).toBe(2);
    expect(sql.state.queries).toBe(1);
  });
});

// ---------------- 写 ----------------

describe('save：先库后缓存', () => {
  it('新建：PG 版本 1，缓存写同一份 JSON', async () => {
    const { store, cache } = setup();
    const saved = await store.save({ kind: 'player', id: 'e1', value: { hp: 5 }, version: 0, dirty: true, savedAt: 0 });

    expect(saved.version).toBe(1);
    expect(saved.dirty).toBe(false);
    expect(cache.map.get('doc:player:e1')).toBe(JSON.stringify({ v: 1, d: { hp: 5 } }));
    expect(store.stats.pgSave).toBe(1);
  });

  it('按版本 CAS 更新：成功 +1', async () => {
    const { store } = setup({ seed: { 'player:e1': { version: 4, body: { hp: 1 } } } });
    const saved = await store.save({ kind: 'player', id: 'e1', value: { hp: 2 }, version: 4, dirty: true, savedAt: 0 });
    expect(saved.version).toBe(5);
  });

  it('版本过期：抛 StorageConflictError（错误码 12），不碰缓存', async () => {
    const { store, cache } = setup({ seed: { 'player:e1': { version: 4, body: { hp: 1 } } } });

    await expect(store.save({ kind: 'player', id: 'e1', value: { hp: 2 }, version: 3, dirty: true, savedAt: 0 }))
      .rejects.toMatchObject({ name: 'StorageConflictError', code: 12 });
    expect(store.stats.conflict).toBe(1);
    expect(cache.state.sets).toEqual([]);
  });

  it('"我以为它存在，但它没了"：也是冲突，不是静默新建', async () => {
    const { store } = setup();
    await expect(store.save({ kind: 'player', id: 'gone', value: { hp: 1 }, version: 9, dirty: true, savedAt: 0 }))
      .rejects.toBeInstanceOf(StorageConflictError);
  });

  it('PG 写成功但缓存写失败：不升级成存档失败，并尝试 DEL 掉旧值', async () => {
    const { store, cache, warnings } = setup({ seed: { 'player:e1': { version: 1, body: { hp: 1 } } } });
    cache.map.set('doc:player:e1', JSON.stringify({ v: 1, d: { hp: 1 } }));
    cache.state.failSet = true;

    const saved = await store.save({ kind: 'player', id: 'e1', value: { hp: 9 }, version: 1, dirty: true, savedAt: 0 });

    expect(saved.version).toBe(2); // 存档成功
    expect(cache.state.dels).toBe(1); // 旧值被删掉，下次读回源
    expect(cache.map.has('doc:player:e1')).toBe(false);
    expect(store.stats.cacheWriteFailed).toBe(1);
    expect(warnings.some((w) => w.includes('写缓存失败'))).toBe(true);
  });
});

describe('delete：先缓存后库', () => {
  it('两边都删，并清掉脏登记', async () => {
    const { store, sql, cache } = setup({ seed: { 'player:e1': { version: 1, body: { hp: 1 } } } });
    cache.map.set('doc:player:e1', JSON.stringify({ v: 1, d: { hp: 1 } }));
    store.track({ kind: 'player', id: 'e1', value: { hp: 1 }, version: 1, dirty: true, savedAt: 0 });

    await store.delete('e1');
    expect(cache.map.has('doc:player:e1')).toBe(false);
    expect(sql.docs.has('player:e1')).toBe(false);
    expect(store.dirtyCount).toBe(0);
  });

  it('缓存删失败不阻塞删档（TTL 兜底）', async () => {
    const { store, sql, cache } = setup({ seed: { 'player:e1': { version: 1, body: { hp: 1 } } } });
    cache.state.failDel = true;

    await store.delete('e1');
    expect(sql.docs.has('player:e1')).toBe(false);
    expect(store.stats.cacheWriteFailed).toBe(1);
  });
});

// ---------------- 周期写盘 ----------------

describe('flushDirty：两个间隔各管一边', () => {
  function seedDirty() {
    const s = setup({ seed: { 'player:e1': { version: 1, body: { hp: 1 } } } });
    s.store.track({ kind: 'player', id: 'e1', value: { hp: 2 }, version: 1, dirty: true, savedAt: 0 });
    return s;
  }

  it('没到点：什么都不做', async () => {
    const s = seedDirty();
    const r = await s.store.flushDirty(1_000 + 10);
    expect(r).toEqual({ cache: 0, pg: 0 });
    expect(s.store.dirtyCount).toBe(1);
  });

  it('只到缓存间隔：只写 Redis，**文档留在队列里等落库**', async () => {
    const s = seedDirty();
    const r = await s.store.flushDirty(1_000 + 1_000);
    expect(r).toEqual({ cache: 1, pg: 0 });
    expect(s.sql.docs.get('player:e1')?.body).toEqual({ hp: 1 }); // 库还是旧值
    expect(JSON.parse(s.cache.map.get('doc:player:e1')!)).toEqual({ v: 1, d: { hp: 2 } });
    // 没落库就不能摘：否则这份改动永远等不到 PG 写
    expect(s.store.dirtyCount).toBe(1);

    // 到 PG 间隔后补上落库
    const r2 = await s.store.flushDirty(1_000 + 5_000);
    expect(r2).toEqual({ cache: 1, pg: 1 });
    expect(s.sql.docs.get('player:e1')).toMatchObject({ version: 2, body: { hp: 2 } });
    expect(s.store.dirtyCount).toBe(0);
  });

  it('两个间隔都到：先写库（版本 +1）再写缓存', async () => {
    const s = seedDirty();
    const r = await s.store.flushDirty(1_000 + 5_000);
    expect(r).toEqual({ cache: 1, pg: 1 });
    expect(s.sql.docs.get('player:e1')).toMatchObject({ version: 2, body: { hp: 2 } });
    expect(JSON.parse(s.cache.map.get('doc:player:e1')!)).toEqual({ v: 2, d: { hp: 2 } });
  });

  it('周期写库撞版本冲突：丢弃这份脏数据并告警，不重试', async () => {
    const s = seedDirty();
    s.sql.docs.set('player:e1', { version: 9, body: { hp: 99 } }); // 别处已经改过

    const r = await s.store.flushDirty(1_000 + 5_000);
    expect(r.pg).toBe(0);
    expect(s.store.dirtyCount).toBe(0);
    expect(s.store.stats.conflict).toBe(1);
    expect(s.warnings.some((w) => w.includes('版本冲突'))).toBe(true);
  });
});
