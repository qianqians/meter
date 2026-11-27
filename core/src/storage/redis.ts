// Redis 适配：缓存里就是一份 JSON（`{v, d}`），带毫秒级过期。
//
// 只用到 GET / SET PX / DEL 三条命令——`CacheClient` 就这三条，所以测试里的假实现可以很小。

import { createClient, type RedisClientType } from 'redis';

import type { CacheClient } from './types';

export interface RedisOptions {
  /** 形如 `redis://127.0.0.1:6379/0`。 */
  url: string;
  /** 连接超时（毫秒），默认 3s。 */
  connectTimeoutMs?: number;
}

export interface RedisCache {
  cache: CacheClient;
  client: RedisClientType;
  close(): Promise<void>;
}

/**
 * 连上 Redis 并包成 `CacheClient`。
 *
 * 连不上直接抛：缓存是本模块的一部分，启动阶段就该知道（和 gate 的会话目录同一取舍）。
 */
export async function createRedisCache(opts: RedisOptions): Promise<RedisCache> {
  const client: RedisClientType = createClient({
    url: opts.url,
    socket: { connectTimeout: opts.connectTimeoutMs ?? 3000 },
  });
  // 不挂 error 监听会让 node-redis 在断线时把未处理事件抛到进程上。
  client.on('error', () => {});
  await client.connect();

  const cache: CacheClient = {
    get: (key) => client.get(key),
    set: (key, value, options) => client.set(key, value, { expiration: { type: 'PX', value: options.PX } }),
    del: (key) => client.del(key),
  };

  return { cache, client, close: () => client.quit().then(() => undefined) };
}
