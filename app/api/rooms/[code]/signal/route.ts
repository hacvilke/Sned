import { guard, handleRoute, isRoomPeer, loadRoom, rateLimitHeaders, roomView } from '@/lib/api';
import { generateId, normalizeCode } from '@/lib/codes';
import { apiError, asString, json, readJsonBody } from '@/lib/http';
import { getStore } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ code: string }>;
}

const ALLOWED_KINDS = new Set(['hello', 'offer', 'answer', 'ice', 'bye', 'peer-info']);
const MAX_PAYLOAD_BYTES = 12 * 1024;

/**
 * GET /api/rooms/:code/signal?peerId=...&cursor=...
 * Long-poll style read: returns signalling messages newer than `cursor`.
 * Messages sent by the caller are filtered out.
 */
export async function GET(request: Request, context: RouteContext) {
  return handleRoute(async () => {
    const { code: rawCode } = await context.params;
    const code = normalizeCode(rawCode);
    if (!code) return apiError(400, 'invalid_code', 'Session codes are six characters.');

    const { blocked, outcome } = await guard('signalRead', request, code);
    if (blocked) return blocked;

    const url = new URL(request.url);
    const peerId = asString(url.searchParams.get('peerId'), 64);
    const cursor = url.searchParams.get('cursor');

    const loaded = await loadRoom(code);
    if ('error' in loaded) return loaded.error;
    const { room } = loaded;
    if (!isRoomPeer(room, peerId)) return apiError(403, 'not_a_peer', 'Unknown peer for this session.');

    const result = await getStore().readMessages(code, cursor, 100);
    const messages = result.messages
      .filter((message) => message.from !== peerId)
      .map(({ id, from, kind, data, at }) => ({ id, from, kind, data, at }));

    return json(
      { messages, cursor: result.cursor, room: roomView(room) },
      { headers: rateLimitHeaders(outcome, 'signalRead') },
    );
  });
}

/**
 * POST /api/rooms/:code/signal
 * Body: { peerId, kind, data }
 */
export async function POST(request: Request, context: RouteContext) {
  return handleRoute(async () => {
    const { code: rawCode } = await context.params;
    const code = normalizeCode(rawCode);
    if (!code) return apiError(400, 'invalid_code', 'Session codes are six characters.');

    const { blocked, outcome } = await guard('signalWrite', request, code);
    if (blocked) return blocked;

    const body = await readJsonBody<{ peerId?: string; kind?: string; data?: unknown }>(request);
    const peerId = asString(body?.peerId, 64);
    const kind = asString(body?.kind, 32);
    if (!kind || !ALLOWED_KINDS.has(kind)) {
      return apiError(400, 'invalid_kind', `Unsupported signalling kind: ${kind ?? '(none)'}.`);
    }

    const serialized = JSON.stringify(body?.data ?? null);
    if (serialized.length > MAX_PAYLOAD_BYTES) {
      return apiError(413, 'payload_too_large', 'Signalling payload is too large.');
    }

    const loaded = await loadRoom(code);
    if ('error' in loaded) return loaded.error;
    const { room } = loaded;
    if (!isRoomPeer(room, peerId)) return apiError(403, 'not_a_peer', 'Unknown peer for this session.');

    await getStore().appendMessage(code, {
      id: generateId('msg'),
      from: peerId as string,
      kind,
      data: JSON.parse(serialized),
      at: Date.now(),
    });

    return json({ ok: true }, { headers: rateLimitHeaders(outcome, 'signalWrite') });
  });
}
