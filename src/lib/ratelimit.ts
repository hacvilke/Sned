import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { hasRedis, LIMITS } from "./limits";

export type Bucket =
  | "batch"
  | "upload-minute"
  | "upload-day"
  | "download"
  | "share-read";

type Spec = { limit: number; window: `${number} ${"s" | "m" | "h" | "d"}` };

const SPECS: Record<Bucket, Spec> = {
  batch: { limit: LIMITS.batchesPerMinute, window: "1 m" },
  "upload-minute": { limit: LIMITS.uploadsPerMinute, window: "1 m" },
  "upload-day": { limit: LIMITS.uploadsPerDay, window: "1 d" },
  download: { limit: LIMITS.downloadsPerMinute, window: "1 m" },
  "share-read": { limit: LIMITS.shareReadsPerMinute, window: "1 m" },
};

let redis: Redis | null | undefined;
const limiters = new Map<Bucket, Ratelimit>();

function getRedis(): Redis | null {
  if (redis !== undefined) return redis;
  if (!hasRedis) {
    redis = null;
    return redis;
  }
  try {
    redis = Redis.fromEnv();
  } catch {
    redis = null;
  }
  return redis;
}

function limiterFor(bucket: Bucket): Ratelimit {
  const existing = limiters.get(bucket);
  if (existing) return existing;
  const { limit, window } = SPECS[bucket];
  const created = new Ratelimit({
    redis: getRedis()!,
    limiter: Ratelimit.slidingWindow(limit, window),
    prefix: `sned:rl:${bucket}`,
    analytics: false,
  });
  limiters.set(bucket, created);
  return created;
}

/* -------------------------------------------------------------------------- */
/* In-process fallback limiter (sliding window over a timestamp log)           */
/* -------------------------------------------------------------------------- */

type Entry = { hits: number[] };

/** globalThis so every Next.js bundle in the process shares one counter set. */
const globalRl = globalThis as unknown as {
  __snedRateLimit?: { hits: Map<string, Entry>; lastSweep: number };
};
if (!globalRl.__snedRateLimit) globalRl.__snedRateLimit = { hits: new Map(), lastSweep: 0 };
const rlState = globalRl.__snedRateLimit;
const localHits = rlState.hits;

function localCheck(
  key: string,
  spec: Spec,
): { allowed: boolean; resetMs: number; remaining: number } {
  const now = Date.now();
  if (now - rlState.lastSweep > 60_000) {
    rlState.lastSweep = now;
    for (const [k, entry] of localHits) {
      if (entry.hits.every((t) => now - t > windowMs(spec.window))) localHits.delete(k);
    }
  }
  const windowSize = windowMs(spec.window);
  let entry = localHits.get(key);
  if (!entry) {
    entry = { hits: [] };
    localHits.set(key, entry);
  }
  entry.hits = entry.hits.filter((t) => now - t < windowSize);
  if (entry.hits.length >= spec.limit) {
    const oldest = entry.hits[0] ?? now;
    return { allowed: false, resetMs: Math.max(1, windowSize - (now - oldest)), remaining: 0 };
  }
  entry.hits.push(now);
  return { allowed: true, resetMs: windowSize, remaining: spec.limit - entry.hits.length };
}

function windowMs(window: Spec["window"]): number {
  const [amount, unit] = window.split(" ") as [string, string];
  const n = Number(amount);
  const mult = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 1_000;
  return n * mult;
}

/* -------------------------------------------------------------------------- */

export type RateResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetMs: number;
  /** True when the decision came from a process-local counter instead of Redis. */
  degraded: boolean;
};

export async function checkRate(bucket: Bucket, identifier: string): Promise<RateResult> {
  const spec = SPECS[bucket];
  const key = `${bucket}:${identifier}`;

  if (!getRedis()) {
    const local = localCheck(key, spec);
    return {
      allowed: local.allowed,
      limit: spec.limit,
      remaining: local.remaining,
      resetMs: local.resetMs,
      degraded: true,
    };
  }

  try {
    const result = await limiterFor(bucket).limit(identifier);
    return {
      allowed: result.success,
      limit: result.limit,
      remaining: result.remaining,
      resetMs: Math.max(1, result.reset - Date.now()),
      degraded: false,
    };
  } catch (error) {
    // Fail open, but loudly: a rate limiter that silently blocks on a Redis
    // blip is worse than one that degrades for a few seconds.
    console.error("[sned] rate limiter failed, failing open", error);
    return { allowed: true, limit: spec.limit, remaining: spec.limit, resetMs: 1_000, degraded: true };
  }
}

export function rateHeaders(result: RateResult): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(Math.max(0, result.remaining)),
    "X-RateLimit-Reset": String(Math.ceil(result.resetMs / 1000)),
  };
  if (!result.allowed) headers["Retry-After"] = String(Math.max(1, Math.ceil(result.resetMs / 1000)));
  return headers;
}

export function __resetRateForTests() {
  limiters.clear();
  localHits.clear();
  redis = undefined;
  rlState.lastSweep = 0;
}
