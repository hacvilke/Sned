import { redisCommand, redisPipeline } from '../redis';
import type { ReadMessagesResult, RoomRecord, SignalMessage, SignalStore } from './types';
import { StoreUnavailableError, isExpired } from './types';

/**
 * Upstash Redis signalling store — the recommended backend on Vercel.
 *
 * Layout:
 *   ft:room:{code}   STRING  room JSON, TTL = session lifetime
 *   ft:log:{code}    LIST    signalling messages in arrival order, same TTL
 */

const ROOM_PREFIX = 'ft:room:';
const LOG_PREFIX = 'ft:log:';

function ttlSeconds(room: RoomRecord): number {
  return Math.max(30, Math.ceil((room.expiresAt - Date.now()) / 1000));
}

function parseRoom(raw: unknown): RoomRecord | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as RoomRecord;
    return parsed && typeof parsed.code === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function parseMessage(raw: unknown): SignalMessage | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as SignalMessage;
    return parsed && typeof parsed.id === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export class RedisStore implements SignalStore {
  readonly kind = 'redis' as const;

  async createRoom(room: RoomRecord): Promise<boolean> {
    const result = await redisCommand([
      'SET',
      `${ROOM_PREFIX}${room.code}`,
      JSON.stringify(room),
      'EX',
      ttlSeconds(room),
      'NX',
    ]);
    if (result === null) throw new StoreUnavailableError();
    return result === 'OK';
  }

  async getRoom(code: string): Promise<RoomRecord | null> {
    const raw = await redisCommand(['GET', `${ROOM_PREFIX}${code}`]);
    if (raw === null) {
      // A missing key and an unreachable Redis both surface as null, so probe
      // with PING before deciding which one it was.
      const ping = await redisCommand(['PING']);
      if (ping === null) throw new StoreUnavailableError();
      return null;
    }
    const room = parseRoom(raw);
    if (!room) return null;
    if (isExpired(room)) {
      await this.deleteRoom(code);
      return null;
    }
    return room;
  }

  async updateRoom(code: string, patch: Partial<RoomRecord>): Promise<RoomRecord | null> {
    const current = await this.getRoom(code);
    if (!current) return null;
    const next: RoomRecord = { ...current, ...patch, code };
    const result = await redisCommand([
      'SET',
      `${ROOM_PREFIX}${code}`,
      JSON.stringify(next),
      'EX',
      ttlSeconds(next),
      'XX',
    ]);
    if (result === null) throw new StoreUnavailableError();
    return result === 'OK' ? next : null;
  }

  async appendMessage(code: string, message: SignalMessage): Promise<void> {
    const room = await this.getRoom(code);
    if (!room) return;
    const result = await redisPipeline([
      ['RPUSH', `${LOG_PREFIX}${code}`, JSON.stringify(message)],
      ['LTRIM', `${LOG_PREFIX}${code}`, -500, -1],
      ['EXPIRE', `${LOG_PREFIX}${code}`, ttlSeconds(room)],
    ]);
    if (result === null) throw new StoreUnavailableError();
  }

  async readMessages(
    code: string,
    cursor: string | null,
    limit = 100,
  ): Promise<ReadMessagesResult> {
    const start = Math.max(0, Number.parseInt(cursor ?? '0', 10) || 0);
    const result = await redisCommand([
      'LRANGE',
      `${LOG_PREFIX}${code}`,
      start,
      start + limit - 1,
    ]);
    if (result === null) {
      const ping = await redisCommand(['PING']);
      if (ping === null) throw new StoreUnavailableError();
      return { messages: [], cursor: String(start) };
    }
    const entries = Array.isArray(result) ? result : [];
    const messages = entries
      .map(parseMessage)
      .filter((message): message is SignalMessage => message !== null);
    return { messages, cursor: String(start + entries.length) };
  }

  /** Redis TTLs handle expiry; this exists so the cron route can report 0. */
  async purgeExpired(): Promise<number> {
    return 0;
  }

  private async deleteRoom(code: string): Promise<void> {
    await redisPipeline([
      ['DEL', `${ROOM_PREFIX}${code}`],
      ['DEL', `${LOG_PREFIX}${code}`],
    ]);
  }
}
