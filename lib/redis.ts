/**
 * Minimal Upstash Redis REST client (no SDK dependency).
 *
 * Used for signalling state and rate limit counters when
 * `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` are configured.
 * Everything goes through the `/pipeline` endpoint so command arguments live in
 * the request body rather than the URL (no escaping or length limits).
 *
 * Every call fails soft: on error it returns null and the caller decides what
 * to do (usually fall back to the in-process implementation).
 */

interface RedisRestResponse<T> {
  result?: T;
  error?: string;
}

export interface RedisConnection {
  url: string;
  token: string;
}

export type RedisCommand = (string | number)[];

export function getRedisConnection(): RedisConnection | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ''), token };
}

export function isRedisConfigured(): boolean {
  return getRedisConnection() !== null;
}

/** Pipelined multi-command request; returns one entry per command. */
export async function redisPipeline(commands: RedisCommand[]): Promise<unknown[] | null> {
  const connection = getRedisConnection();
  if (!connection || commands.length === 0) return null;
  try {
    const response = await fetch(`${connection.url}/pipeline`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(6000),
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as RedisRestResponse<unknown[]>;
    if (payload.error) return null;
    return payload.result ?? null;
  } catch {
    return null;
  }
}

/** Single command, executed through the pipeline endpoint. */
export async function redisCommand(command: RedisCommand): Promise<unknown | null> {
  const results = await redisPipeline([command]);
  return results ? (results[0] ?? null) : null;
}
