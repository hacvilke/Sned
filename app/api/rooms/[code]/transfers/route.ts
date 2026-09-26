import { guard, handleRoute, isRoomPeer, loadRoom } from '@/lib/api';
import { normalizeCode } from '@/lib/codes';
import { getConfig, type BucketId } from '@/lib/config';
import { apiError, asString, json, readJsonBody } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ code: string }>;
}

/**
 * POST /api/rooms/:code/transfers
 * Body: { peerId, direction: 'upload' | 'download', fileName?, fileSize? }
 *
 * File bytes travel peer-to-peer and never reach this server, so per-file
 * budgets are enforced at the point where the client declares the transfer.
 * The client refuses to send (or receive) when this endpoint returns 429, and
 * the queue backs off until the window resets.
 */
export async function POST(request: Request, context: RouteContext) {
  return handleRoute(async () => {
    const { code: rawCode } = await context.params;
    const code = normalizeCode(rawCode);
    if (!code) return apiError(400, 'invalid_code', 'Session codes are six characters.');

    const body = await readJsonBody<{
      peerId?: string;
      direction?: string;
      fileName?: string;
      fileSize?: number;
    }>(request);

    const direction = body?.direction === 'download' ? 'download' : 'upload';
    const bucket: BucketId = direction === 'download' ? 'download' : 'upload';

    // Deliberately unscoped: this is a per-IP budget, not per-session.
    const { blocked, outcome } = await guard(bucket, request);
    if (blocked) return blocked;

    const loaded = await loadRoom(code);
    if ('error' in loaded) return loaded.error;
    const { room } = loaded;
    if (!isRoomPeer(room, asString(body?.peerId, 64))) {
      return apiError(403, 'not_a_peer', 'Unknown peer for this session.');
    }

    const declaredSize = typeof body?.fileSize === 'number' ? body.fileSize : undefined;
    if (declaredSize !== undefined && declaredSize > getConfig().maxFileBytes) {
      return apiError(413, 'file_too_large', 'File exceeds the configured maximum size.');
    }

    return json({
      ok: true,
      direction,
      limit: outcome.limit,
      remaining: outcome.remaining,
      windowSeconds: outcome.windowSeconds,
      resetAt: outcome.resetAt,
      backend: outcome.backend,
    });
  });
}
