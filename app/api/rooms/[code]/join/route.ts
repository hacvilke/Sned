import { guard, handleRoute, loadRoom, rateLimitHeaders, roomView } from '@/lib/api';
import { generateId, normalizeCode } from '@/lib/codes';
import { apiError, asString, json, readJsonBody } from '@/lib/http';
import { getStore } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ code: string }>;
}

/**
 * POST /api/rooms/:code/join
 * Second device joins a session. Body: { name?: string, peerId?: string }
 *
 * Sessions hold one guest. Passing the peerId from a previous join reclaims
 * that slot, which is what makes a page reload recoverable.
 */
export async function POST(request: Request, context: RouteContext) {
  return handleRoute(async () => {
    const { code: rawCode } = await context.params;
    const code = normalizeCode(rawCode);
    if (!code) return apiError(400, 'invalid_code', 'Session codes are six characters.');

    const { blocked, outcome } = await guard('join', request, code);
    if (blocked) return blocked;

    const body = await readJsonBody<{ name?: string; peerId?: string }>(request);
    const guestName = asString(body?.name, 64) ?? 'This device';
    const requestedPeerId = asString(body?.peerId, 64);

    const loaded = await loadRoom(code);
    if ('error' in loaded) return loaded.error;
    const { room } = loaded;

    if (requestedPeerId && requestedPeerId === room.hostPeerId) {
      return apiError(409, 'invalid_peer', 'That peer id belongs to the sending device.');
    }
    const reclaiming = Boolean(requestedPeerId) && requestedPeerId === room.guestPeerId;
    if (room.guestPeerId && !reclaiming) {
      return apiError(
        409,
        'session_busy',
        'Another device already joined this session. Ask the sender to start a new one.',
      );
    }

    const guestPeerId = reclaiming ? (room.guestPeerId as string) : generateId('peer');
    const updated = await getStore().updateRoom(code, { guestPeerId, guestName });
    if (!updated) return apiError(410, 'session_expired', 'That session ended while joining.');

    // Tells the sender, via its signalling poll, that a device has arrived.
    await getStore().appendMessage(code, {
      id: generateId('msg'),
      from: guestPeerId,
      kind: 'hello',
      data: { name: guestName },
      at: Date.now(),
    });

    return json(
      { role: 'guest', peerId: guestPeerId, room: roomView(updated) },
      { headers: rateLimitHeaders(outcome, 'join') },
    );
  });
}
