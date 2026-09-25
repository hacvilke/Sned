import { Redis } from "@upstash/redis";
import { hasRedis } from "./limits";

/**
 * Minimal key/value surface the app needs.
 *
 * On Vercel this is backed by Upstash Redis (Vercel KV / Upstash for Redis).
 * Without credentials it falls back to a process-local Map so `npm run dev`
 * works with zero configuration. The memory driver does NOT survive restarts
 * and is NOT shared between serverless instances - never rely on it in
 * production.
 */
export interface KvDriver {
  readonly kind: "redis" | "memory";
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  zadd(key: string, score: number, member: string): Promise<void>;
  zrangeByScore(key: string, min: number, max: number, limit: number): Promise<string[]>;
  zrem(key: string, member: string): Promise<void>;
}

let redis: Redis | null | undefined;

function getRedis(): Redis | null {
  if (redis !== undefined) return redis;
  if (!hasRedis) {
    redis = null;
    return redis;
  }
  try {
    redis = Redis.fromEnv();
  } catch {
    console.warn("[sned] Upstash credentials present but unusable; using memory KV.");
    redis = null;
  }
  return redis;
}

const redisDriver: KvDriver = {
  kind: "redis",
  async get(key) {
    const value = await getRedis()!.get<string>(key);
    return value ?? null;
  },
  async set(key, value, ttlSeconds) {
    const client = getRedis()!;
    if (ttlSeconds > 0) await client.set(key, value, { ex: ttlSeconds });
    else await client.set(key, value);
  },
  async del(key) {
    await getRedis()!.del(key);
  },
  async zadd(key, score, member) {
    await getRedis()!.zadd(key, { score, member });
  },
  async zrangeByScore(key, min, max, limit) {
    const rows = await getRedis()!.zrange(key, min, max, { byScore: true, offset: 0, count: limit });
    return rows.map((row) => (typeof row === "string" ? row : String(row)));
  },
  async zrem(key, member) {
    await getRedis()!.zrem(key, member);
  },
};

type MemoryRow = { value: string; expiresAt: number };

/**
 * Next.js bundles the RSC layer and the route handlers separately, so a plain
 * module-level Map is NOT shared between them: a page render would not see
 * what an API route wrote. Anchoring the maps on globalThis keeps every
 * module instance in the process looking at the same store.
 */
const globalKv = globalThis as unknown as {
  __snedKv?: { store: Map<string, MemoryRow>; zsets: Map<string, Map<string, number>> };
};
if (!globalKv.__snedKv) globalKv.__snedKv = { store: new Map(), zsets: new Map() };
const memStore = globalKv.__snedKv.store;
const memZsets = globalKv.__snedKv.zsets;

function sweep(now = Date.now()) {
  for (const [key, row] of memStore) {
    if (row.expiresAt !== 0 && row.expiresAt <= now) memStore.delete(key);
  }
}

const memoryDriver: KvDriver = {
  kind: "memory",
  async get(key) {
    sweep();
    const row = memStore.get(key);
    if (!row) return null;
    if (row.expiresAt !== 0 && row.expiresAt <= Date.now()) {
      memStore.delete(key);
      return null;
    }
    return row.value;
  },
  async set(key, value, ttlSeconds) {
    memStore.set(key, { value, expiresAt: ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : 0 });
  },
  async del(key) {
    memStore.delete(key);
  },
  async zadd(key, score, member) {
    let set = memZsets.get(key);
    if (!set) {
      set = new Map();
      memZsets.set(key, set);
    }
    set.set(member, score);
  },
  async zrangeByScore(key, min, max, limit) {
    const set = memZsets.get(key);
    if (!set) return [];
    return [...set.entries()]
      .filter(([, score]) => score >= min && score <= max)
      .sort((a, b) => a[1] - b[1])
      .slice(0, limit)
      .map(([member]) => member);
  },
  async zrem(key, member) {
    memZsets.get(key)?.delete(member);
  },
};

let driver: KvDriver | null = null;

export function kv(): KvDriver {
  if (!driver) driver = getRedis() ? redisDriver : memoryDriver;
  return driver;
}

/** Test helper: wipe the in-process drivers. */
export function __resetKvForTests() {
  driver = null;
  redis = undefined;
  memStore.clear();
  memZsets.clear();
}
