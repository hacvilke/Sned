import { getConfig, type BucketId, type RateLimitRule } from './config';
import { getRedisConnection, redisPipeline } from './redis';

/**
 * Rate limiting.
 *
 * Backed by Upstash Redis (sliding window log) when `UPSTASH_REDIS_REST_URL`
 * and `UPSTASH_REDIS_REST_TOKEN` are set, which is what you want on Vercel
 * because serverless functions do not share memory between invocations.
 *
 * Without Redis it falls back to an in-process sliding window. That is exact on
 * a single dev server and best-effort (per instance) on Vercel.
 */

export interface RateLimitOutcome {
  ok: boolean;
  limit: number;
  remaining: number;
  windowSeconds: number;
  retryAfterSeconds: number;
  /** Milliseconds since epoch when the oldest counted request leaves the window. */
  resetAt: number;
  backend: 'redis' | 'memory';
}

/** key -> request timestamps, used only when Redis is not configured. */
const memoryWindows = new Map<string, number[]>();

function slidingWindowMemory(key: string, rule: RateLimitRule): RateLimitOutcome {
  const now = Date.now();
  const windowMs = rule.windowSeconds * 1000;
  const cutoff = now - windowMs;
  const hits = (memoryWindows.get(key) ?? []).filter((timestamp) => timestamp > cutoff);

  const exceeded = hits.length >= rule.limit;
  if (!exceeded) hits.push(now);
  memoryWindows.set(key, hits);

  // Opportunistic cleanup so a long-lived dev server does not grow unbounded.
  if (memoryWindows.size > 5000) {
    for (const [mapKey, timestamps] of memoryWindows) {
      const fresh = timestamps.filter((timestamp) => timestamp > cutoff);
      if (fresh.length === 0) memoryWindows.delete(mapKey);
      else memoryWindows.set(mapKey, fresh);
    }
  }

  const oldest = hits[0] ?? now;
  const resetAt = oldest + windowMs;
  return {
    ok: !exceeded,
    limit: rule.limit,
    remaining: Math.max(0, rule.limit - hits.length),
    windowSeconds: rule.windowSeconds,
    retryAfterSeconds: exceeded ? Math.max(1, Math.ceil((resetAt - now) / 1000)) : 0,
    resetAt,
    backend: 'memory',
  };
}

async function slidingWindowRedis(
  key: string,
  rule: RateLimitRule,
): Promise<RateLimitOutcome | null> {
  const now = Date.now();
  const windowMs = rule.windowSeconds * 1000;
  const cutoff = now - windowMs;
  const member = `${now}:${Math.random().toString(36).slice(2, 10)}`;
  const fullKey = `ft:rl:${key}`;

  const result = await redisPipeline([
    ['ZREMRANGEBYSCORE', fullKey, '-inf', cutoff],
    ['ZADD', fullKey, now, member],
    ['ZCARD', fullKey],
    ['ZRANGE', fullKey, 0, 0, 'WITHSCORES'],
    ['EXPIRE', fullKey, rule.windowSeconds + 1],
  ]);
  if (!result) return null;

  const count = Number(result[2] ?? 0);
  const oldestRaw = Array.isArray(result[3]) ? result[3] : [];
  const oldest = Number(oldestRaw[1] ?? now) || now;
  const exceeded = count > rule.limit;
  const resetAt = oldest + windowMs;

  if (exceeded) {
    // Do not let rejected requests keep the member in the window.
    await redisPipeline([['ZREM', fullKey, member]]);
  }

  return {
    ok: !exceeded,
    limit: rule.limit,
    remaining: Math.max(0, rule.limit - count),
    windowSeconds: rule.windowSeconds,
    retryAfterSeconds: exceeded ? Math.max(1, Math.ceil((resetAt - now) / 1000)) : 0,
    resetAt,
    backend: 'redis',
  };
}

/**
 * Consume one unit from `bucket` for `identity` (normally an IP address).
 */
export async function rateLimit(
  bucket: BucketId,
  identity: string,
  scope?: string,
): Promise<RateLimitOutcome> {
  const rule = getConfig().rules[bucket];
  const key = scope ? `${bucket}:${scope}:${identity}` : `${bucket}:${identity}`;

  if (getRedisConnection()) {
    const outcome = await slidingWindowRedis(key, rule);
    if (outcome) return outcome;
    // Redis failed: fall through to the in-process limiter rather than
    // blocking legitimate users.
  }
  return slidingWindowMemory(key, rule);
}

/** The configured budget for a bucket, without consuming anything. */
export function bucketRule(bucket: BucketId): RateLimitRule {
  return getConfig().rules[bucket];
}
