import { getStoreKind } from '../config';
import { BlobStore } from './blob';
import { MemoryStore } from './memory';
import { RedisStore } from './redis';
import type { SignalStore } from './types';

export * from './types';

let cached: SignalStore | null = null;

/**
 * Returns the signalling store selected by configuration:
 *   1. Upstash Redis  (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)
 *   2. Vercel Blob    (BLOB_READ_WRITE_TOKEN)
 *   3. In-process memory (development fallback)
 *
 * Override with SIGNAL_STORE=redis|blob|memory.
 */
export function getStore(): SignalStore {
  if (cached) return cached;
  const kind = getStoreKind();
  cached =
    kind === 'redis' ? new RedisStore() : kind === 'blob' ? new BlobStore() : new MemoryStore();
  return cached;
}
