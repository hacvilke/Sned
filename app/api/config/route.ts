import { guard, handleRoute, loadRoom } from '@/lib/api';
import { normalizeCode } from '@/lib/codes';
import { getPublicConfig } from '@/lib/config';
import { json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/config[?code=ABCDEF]
 *
 * Public client configuration. ICE servers are included, but TURN credentials
 * are only released for a valid, active session code so they cannot be scraped
 * by drive-by visitors.
 */
export async function GET(request: Request) {
  return handleRoute(async () => {
    const { blocked } = await guard('config', request);
    if (blocked) return blocked;

    const url = new URL(request.url);
    const code = normalizeCode(url.searchParams.get('code') ?? '');

    let withTurn = false;
    if (code) {
      const loaded = await loadRoom(code);
      withTurn = !('error' in loaded);
    }

    return json(getPublicConfig(withTurn));
  });
}
