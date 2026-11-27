// 存储模块：文档类型 + 仓库 + 两个真实适配器。
// 设计取舍（go-zero 的对照）见 `types.ts` 头部与 `core/SPEC.md`「存储」。

export {
  StorageConflictError,
  StorageUnavailableError,
  STORAGE_ERR,
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
export { createDocumentStore, type DocumentStoreOptions } from './store';
export { startAutoFlush, type AutoFlushOptions } from './flusher';
export { createPgExecutor, SCHEMA_SQL, type PgOptions } from './pg';
export { createRedisCache, type RedisCache, type RedisOptions } from './redis';
