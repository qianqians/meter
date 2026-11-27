// PostgreSQL 适配：一张通用的文档表 + 一条带版本 CAS 的 upsert。
//
// 为什么是 jsonb 一张表而不是每类文档一张表：本模块只提供**存储原语**，业务表的形状属于业务；
// `Document<T>` 的全部内容就是一段 JSON，PG 只需要（kind, id）做键、version 做乐观锁。
// 业务要索引某个字段时，自己在这张表上加表达式索引（例如 `((body->>'level')::int)`）。

import { Pool, type PoolConfig } from 'pg';

import type { SqlExecutor } from './types';

/** 建表 SQL：与 `store.ts` 里的语句一一对应。迁移工具还没接，先手动执行。 */
export const SCHEMA_SQL = `
create table if not exists documents (
  kind       text        not null,
  doc_id     text        not null,
  version    bigint      not null,
  body       jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (kind, doc_id)
);
`;

export interface PgOptions extends PoolConfig {
  /** 启动时跑一次建表 SQL（默认 false：生产由迁移流程负责）。 */
  migrate?: boolean;
}

/**
 * 建一个连接池并包成 `SqlExecutor`。
 *
 * 注意 `pg` 把 bigint 返回成字符串——store 里统一 `Number(...)`，因为文档版本远小于 2^53。
 */
export function createPgExecutor(opts: PgOptions): { sql: SqlExecutor; pool: Pool; migrate(): Promise<void>; close(): Promise<void> } {
  const { migrate, ...poolConfig } = opts;
  const pool = new Pool(poolConfig);

  const sql: SqlExecutor = {
    async query<R extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      const res = await pool.query(text, values as unknown[] | undefined);
      return { rows: res.rows as R[] };
    },
  };

  return {
    sql,
    pool,
    /** 建表（幂等）。迁移工具的替代品，见 SCHEMA_SQL。 */
    async migrate() {
      await pool.query(SCHEMA_SQL);
    },
    close: () => pool.end(),
  };
}
