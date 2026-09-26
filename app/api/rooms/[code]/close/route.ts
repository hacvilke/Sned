import { guard, handleRoute, isRoomPeer, loadRoom, roomView } from '@/lib/api';
import { generateId, normalizeCode } from '@/lib/codes';
import { apiError, asString, json, readJsonBody } from '@/lib/http';
import { getStore } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ code: string }>;
}

/**
 * POST /api/rooms/:code/close
 * Ends a session for both devices. Body: { peerId }
 */
export async function POST(request: Request, context: RouteContext) {
  return handleRoute(async () => {
    const { code: rawCode } = await context.params;
    const code = normalizeCode(rawCode);
    if (!code) return apiError(400, 'invalid_code', 'Session codes are six characters.');

    const { blocked } = await guard('close', request, code);
    if (blocked) return blocked;

    const body = await readJsonBody<{ peerId?: string }>(request);
    const peerId = asString(body?.peerId, 64);

    const loaded = await loadRoom(code);
    if ('error' in loaded) return loaded.error;
    const { room } = loaded;
    if (!isRoomPeer(room, peerId)) return apiError(403, 'not_a_peer', 'Unknown peer for this session.');

    const updated = await getStore().updateRoom(code, { closed: true, closedAt: Date.now() });
    await getStore().appendMessage(code, {
      id: generateId('msg'),
      from: peerId as string,
      kind: 'bye',
      data: null,
      at: Date.now(),
    });

    return json({ ok: true, room: updated ? roomView(updated) : roomView(room) });
  });
}
