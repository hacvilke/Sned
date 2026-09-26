import type { NextResponse } from 'next/server';

import type { BucketId } from './config';
import { apiError, clientIp } from './http';
import { rateLimit, type RateLimitOutcome } from './ratelimit';
import { getStore, StoreUnavailableError, type RoomRecord } from './store';
import { isExpired } from './store';

/**
 * Wraps a route handler so store failures become a clean 503 instead of an
 * unhandled exception.
 */
export async function handleRoute(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof StoreUnavailableError) {
      return apiError(
        503,
        'store_unavailable',
        'The signalling store is not reachable. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or BLOB_READ_WRITE_TOKEN) and redeploy.',
      );
    }
    console.error('[api] unexpected error', error);
    return apiError(500, 'internal_error', 'Unexpected server error.');
  }
}

/** Returns a 429 response when the bucket is exhausted, otherwise null. */
export async function guard(
  bucket: BucketId,
  request: Request,
  scope?: string,
): Promise<{ blocked: NextResponse | null; outcome: RateLimitOutcome }> {
  const outcome = await rateLimit(bucket, clientIp(request), scope);
  if (outcome.ok) return { blocked: null, outcome };
  const blocked = apiError(
    429,
    'rate_limited',
    `Rate limit reached for ${bucket}. Try again in ${outcome.retryAfterSeconds}s.`,
    {
      retryAfterSeconds: outcome.retryAfterSeconds,
      details: {
        bucket,
        limit: outcome.limit,
        remaining: 0,
        resetAt: outcome.resetAt,
      },
    },
  );
  return { blocked, outcome };
}

export function rateLimitHeaders(outcome: RateLimitOutcome, bucket: BucketId): Record<string, string> {
  return {
    'x-ratelimit-bucket': bucket,
    'x-ratelimit-limit': String(outcome.limit),
    'x-ratelimit-remaining': String(outcome.remaining),
    'x-ratelimit-reset': String(Math.ceil(outcome.resetAt / 1000)),
  };
}

/** Loads a room, returning a typed error response when it is missing or over. */
export async function loadRoom(
  code: string,
): Promise<{ room: RoomRecord } | { error: NextResponse }> {
  const store = getStore();
  const room = await store.getRoom(code);
  if (!room) {
    return {
      error: apiError(404, 'session_not_found', 'No active session with that code.'),
    };
  }
  if (isExpired(room)) {
    return {
      error: apiError(410, 'session_expired', 'That session has ended or expired.'),
    };
  }
  return { room };
}

export function isRoomPeer(room: RoomRecord, peerId: string | undefined): boolean {
  return Boolean(peerId) && (peerId === room.hostPeerId || peerId === room.guestPeerId);
}

export function roomView(room: RoomRecord) {
  return {
    code: room.code,
    createdAt: room.createdAt,
    expiresAt: room.expiresAt,
    hostPeerId: room.hostPeerId,
    hostName: room.hostName,
    guestPeerId: room.guestPeerId ?? null,
    guestName: room.guestName ?? null,
    closed: room.closed ?? false,
    secondsRemaining: Math.max(0, Math.round((room.expiresAt - Date.now()) / 1000)),
  };
}
