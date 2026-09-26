import { handleRoute } from '@/lib/api';
import { getConfig, getPublicConfig } from '@/lib/config';
import { json } from '@/lib/http';
import { getStore } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/health
 * Deployment smoke test: confirms the signalling store is reachable.
 */
export async function GET() {
  return handleRoute(async () => {
    const config = getConfig();
    const store = getStore();

    let storeOk = true;
    let storeError: string | null = null;
    try {
      await store.getRoom('AAAAAA');
    } catch (error) {
      storeOk = false;
      storeError = error instanceof Error ? error.message : 'unknown error';
    }

    return json({
      ok: storeOk,
      version: process.env.npm_package_version ?? '1.0.0',
      store: store.kind,
      storeConfigured: config.storeConfigured,
      storeOk,
      storeError,
      rateLimitBackend: config.rateLimitBackend,
      roomTtlSeconds: config.roomTtlSeconds,
      maxFileBytes: config.maxFileBytes,
      limits: getPublicConfig(false).limits,
      time: Date.now(),
    });
  });
}
