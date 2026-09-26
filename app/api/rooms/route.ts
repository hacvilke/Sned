import { guard, handleRoute, rateLimitHeaders } from '@/lib/api';
import { generateCode, generateId } from '@/lib/codes';
import { getConfig } from '@/lib/config';
import { apiError, asString, json, readJsonBody } from '@/lib/http';
import { getStore, type RoomRecord } from '@/lib/store';
import { roomView } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/rooms
 * Creates a transfer session and returns the shareable code.
 * Body: { name?: string }
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const { blocked, outcome } = await guard('rooms', request);
    if (blocked) return blocked;

    const body = await readJsonBody<{ name?: string }>(request);
    const hostName = asString(body?.name, 64) ?? 'This device';

    const store = getStore();
    const ttlSeconds = getConfig().roomTtlSeconds;
    let room: RoomRecord | null = null;

    for (let attempt = 0; attempt < 5 && !room; attempt += 1) {
      const now = Date.now();
      const candidate: RoomRecord = {
        code: generateCode(),
        createdAt: now,
        expiresAt: now + ttlSeconds * 1000,
        hostPeerId: generateId('peer'),
        hostName,
      };
      const created = await store.createRoom(candidate);
      if (created) room = candidate;
    }

    if (!room) {
      return apiError(503, 'code_unavailable', 'Could not allocate a session code. Try again.');
    }

    return json(
      {
        role: 'host',
        peerId: room.hostPeerId,
        room: roomView(room),
      },
      { headers: rateLimitHeaders(outcome, 'rooms') },
    );
  });
}
