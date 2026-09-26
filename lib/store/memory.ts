import type { ReadMessagesResult, RoomRecord, SignalMessage, SignalStore } from './types';
import { isExpired } from './types';

/**
 * In-process signalling store.
 *
 * Exact on a single long-lived process (local development, `next start`) and
 * best-effort on Vercel, where each invocation may land on a fresh instance.
 * Configure Redis or Blob for anything real — see README.md.
 */

interface MemoryRoom {
  room: RoomRecord;
  messages: SignalMessage[];
}

const globalRef = globalThis as unknown as { __ftMemoryRooms?: Map<string, MemoryRoom> };
const rooms: Map<string, MemoryRoom> = (globalRef.__ftMemoryRooms ??= new Map());

function prune(): void {
  const now = Date.now();
  for (const [code, entry] of rooms) {
    // Keep expired rooms around for a further 5 minutes so clients get a clean
    // "session expired" response instead of "not found".
    if (entry.room.expiresAt + 5 * 60_000 <= now) rooms.delete(code);
  }
}

export class MemoryStore implements SignalStore {
  readonly kind = 'memory' as const;

  async createRoom(room: RoomRecord): Promise<boolean> {
    prune();
    const existing = rooms.get(room.code);
    if (existing && !isExpired(existing.room)) return false;
    rooms.set(room.code, { room: { ...room }, messages: [] });
    return true;
  }

  async getRoom(code: string): Promise<RoomRecord | null> {
    prune();
    const entry = rooms.get(code);
    if (!entry) return null;
    return { ...entry.room };
  }

  async updateRoom(code: string, patch: Partial<RoomRecord>): Promise<RoomRecord | null> {
    prune();
    const entry = rooms.get(code);
    if (!entry) return null;
    entry.room = { ...entry.room, ...patch, code };
    return { ...entry.room };
  }

  async appendMessage(code: string, message: SignalMessage): Promise<void> {
    const entry = rooms.get(code);
    if (!entry) return;
    entry.messages.push(message);
    if (entry.messages.length > 500) entry.messages.splice(0, entry.messages.length - 500);
  }

  async readMessages(
    code: string,
    cursor: string | null,
    limit = 100,
  ): Promise<ReadMessagesResult> {
    const entry = rooms.get(code);
    if (!entry) return { messages: [], cursor: cursor ?? '0' };
    const start = Math.max(0, Number.parseInt(cursor ?? '0', 10) || 0);
    const slice = entry.messages.slice(start, start + limit);
    return { messages: slice, cursor: String(start + slice.length) };
  }

  async purgeExpired(): Promise<number> {
    const before = rooms.size;
    const now = Date.now();
    for (const [code, entry] of rooms) {
      if (entry.room.expiresAt <= now) rooms.delete(code);
    }
    return before - rooms.size;
  }
}
