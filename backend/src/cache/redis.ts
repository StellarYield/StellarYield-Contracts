import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";

let client: Redis | null = null;

function getClient(): Redis | null {
  if (client) return client;
  const url = process.env["REDIS_URL"];
  if (!url) return null;
  client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
  client.on("error", (err: Error) => logger.error({ err }, "redis error"));
  return client;
}

/**
 * Close the Redis client if one was ever created (#1294).
 *
 * Idempotent and safe when `REDIS_URL` is unset (no client was created) or when
 * the client never connected (`lazyConnect`): `quit()` is attempted first so an
 * established connection closes cleanly, falling back to `disconnect()` for a
 * lazy client that was never connected.
 */
export async function closeRedis(): Promise<void> {
  const redis = client;
  client = null;
  if (!redis) return;
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}

export async function cacheGet<T>(key: string): Promise<T | null> {  try {
    const redis = getClient();
    if (!redis) return null;
    const val = await redis.get(key);
    return val ? (JSON.parse(val) as T) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  try {
    const redis = getClient();
    if (!redis) return;
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch {
    // cache is best-effort
  }
}

/**
 * Atomically increment an integer counter and, on first creation, attach a TTL.
 * Returns the post-increment value, or `null` when Redis is unavailable so
 * callers can decide how to degrade (see {@link isWebhookThrottled}).
 */
export async function incrementCounter(key: string, ttlSeconds: number): Promise<number | null> {
  try {
    const redis = getClient();
    if (!redis) return null;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, ttlSeconds);
    return count;
  } catch {
    return null;
  }
}

export async function cacheDel(pattern: string): Promise<void> {
  try {
    const redis = getClient();
    if (!redis) return;
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(...keys);
  } catch {
    // cache is best-effort
  }
}

const API_KEY_USAGE_WINDOW_SECONDS = 24 * 60 * 60;
const API_KEY_USAGE_KEY_PREFIX = "api_key_usage:";

export async function recordApiKeyUsage(apiKeyId: number, path: string, now = Date.now()): Promise<void> {
  try {
    const redis = getClient();
    if (!redis) return;
    const key = `${API_KEY_USAGE_KEY_PREFIX}${apiKeyId}`;
    await redis.zadd(
      key,
      now,
      JSON.stringify({ path, usedAt: new Date(now).toISOString(), id: randomUUID() }),
    );
    await redis.expire(key, API_KEY_USAGE_WINDOW_SECONDS * 2);
  } catch {
    // Usage statistics are best-effort and must not affect authenticated traffic.
  }
}

export async function getApiKeyUsage(apiKeyId: number, now = Date.now()): Promise<{
  requestCount24h: number;
  lastUsedAt: string | null;
  topRoutes: Array<{ path: string; count: number }>;
}> {
  const empty = { requestCount24h: 0, lastUsedAt: null, topRoutes: [] };
  try {
    const redis = getClient();
    if (!redis) return empty;
    const key = `${API_KEY_USAGE_KEY_PREFIX}${apiKeyId}`;
    await redis.zremrangebyscore(key, 0, now - API_KEY_USAGE_WINDOW_SECONDS * 1000);
    const entries = await redis.zrange(key, 0, -1, "WITHSCORES");
    const counts = new Map<string, number>();
    let lastUsedAt: string | null = null;
    for (let index = 0; index < entries.length; index += 2) {
      const entry = JSON.parse(entries[index] ?? "{}") as { path?: string };
      const score = Number(entries[index + 1]);
      if (entry.path) counts.set(entry.path, (counts.get(entry.path) ?? 0) + 1);
      if (Number.isFinite(score)) lastUsedAt = new Date(score).toISOString();
    }
    const topRoutes = [...counts.entries()]
      .map(([path, count]) => ({ path, count }))
      .sort((left, right) => right.count - left.count || left.path.localeCompare(right.path))
      .slice(0, 5);
    return { requestCount24h: entries.length / 2, lastUsedAt, topRoutes };
  } catch {
    return empty;
  }
}
