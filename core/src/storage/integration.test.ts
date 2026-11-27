// 真 PostgreSQL + Redis 的集成测试：**默认跳过**，两个环境变量都设置时才跑。
//
//   PG_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
//   REDIS_URL=redis://127.0.0.1:6379/0 \
//   npm test -- src/storage/integration
//
// 它验的是 store.test.ts 覆盖不到的那部分：真实 SQL（含 `insert ... on conflict ... where` 的
// CAS 语义）、jsonb 往返、以及缓存的毫秒级过期。

import { describe, expect, it, beforeAll, afterAll } from 'vitest';

import { createPgExecutor, type PgOptions } from './pg';
import { createRedisCache, type RedisCache } from './redis';
import { createDocumentStore } from './store';
import { StorageConflictError, defaultStorageConfig, type DocumentStore } from './types';

const PG_URL = process.env.PG_URL;
const REDIS_URL = process.env.REDIS_URL;

const enabled = Boolean(PG_URL && REDIS_URL);

describe.skipIf(!enabled)('真 PG + Redis', () => {
  let pg: ReturnType<typeof createPgExecutor>;
  let redis: RedisCache;
  let store: DocumentStore<{ hp: number; bag: string[] }>;
  const kind = `it-${Date.now()}`;
  const config = {
    ...defaultStorageConfig(),
    cache: { ...defaultStorageConfig().cache, ttlMs: 60_000 },
  };

  beforeAll(async () => {
    pg = createPgExecutor({ ...(PG_URL ? { connectionString: PG_URL } : ({} as PgOptions)), migrate: true });
    await pg.migrate();
    redis = await createRedisCache({ url: REDIS_URL! });
    store = createDocumentStore({ kind, sql: pg.sql, cache: redis.cache, config });
  });

  afterAll(async () => {
    await redis?.close();
    await pg?.close();
  });

  it('存 → 读（命中缓存）→ 改（删键）→ 读（回源拿到新值）', async () => {
    const saved = await store.save({ kind, id: 'e1', value: { hp: 100, bag: ['a'] }, version: 0, dirty: true, savedAt: 0 });
    expect(saved.version).toBe(1);

    const hit = await store.load('e1');
    expect(hit?.value).toEqual({ hp: 100, bag: ['a'] });
    expect(hit?.version).toBe(1);
    expect(await redis.client.pTTL(`doc:${kind}:e1`)).toBeGreaterThan(0); // 缓存带过期

    const updated = await store.save({ ...hit!, value: { hp: 80, bag: ['a', 'b'] }, dirty: true });
    expect(updated.version).toBe(2);
    expect((await store.load('e1'))?.value).toEqual({ hp: 80, bag: ['a', 'b'] });
  });

  it('版本冲突：拿旧版本写被拒，库里不变', async () => {
    await expect(store.save({ kind, id: 'e1', value: { hp: 1, bag: [] }, version: 1, dirty: true, savedAt: 0 }))
      .rejects.toBeInstanceOf(StorageConflictError);
    expect((await store.load('e1'))?.value.hp).toBe(80);
  });

  it('删档：两边都没了', async () => {
    await store.delete('e1');
    expect(await store.load('e1')).toBeUndefined();
    expect(await redis.client.get(`doc:${kind}:e1`)).toBeNull();
  });

  it('"以为存在但其实没有"：冲突而不是静默新建', async () => {
    await expect(store.save({ kind, id: 'ghost', value: { hp: 1, bag: [] }, version: 5, dirty: true, savedAt: 0 }))
      .rejects.toBeInstanceOf(StorageConflictError);
  });
});
