import { handleRoute } from '@/lib/api';
import { apiError, json } from '@/lib/http';
import { getStore } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/cron/cleanup
 *
 * Invoked by Vercel Cron (see vercel.json). Deletes expired signalling
 * documents when the Blob store is in use; Redis relies on key TTLs and the
 * memory store prunes itself, so both are no-ops.
 *
 * Protected by CRON_SECRET. Vercel Cron sends `Authorization: Bearer <secret>`
 * automatically when the environment variable is set.
 */
export async function GET(request: Request) {
  return handleRoute(async () => {
    const secret = process.env.CRON_SECRET;
    const header = request.headers.get('authorization');

    if (secret) {
      if (header !== `Bearer ${secret}`) {
        return apiError(401, 'unauthorized', 'Invalid cron secret.');
      }
    } else if (process.env.VERCEL === '1') {
      // On Vercel without a secret configured, refuse rather than allow
      // anonymous callers to trigger store deletions.
      return apiError(401, 'unauthorized', 'CRON_SECRET is not configured.');
    }

    const store = getStore();
    const purged = (await store.purgeExpired?.()) ?? 0;
    return json({ ok: true, store: store.kind, purged, at: Date.now() });
  });
}
