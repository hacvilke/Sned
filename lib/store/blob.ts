import { del, get, list, put } from '@vercel/blob';

import type { ReadMessagesResult, RoomRecord, SignalMessage, SignalStore } from './types';
import { StoreUnavailableError, isExpired } from './types';

/**
 * Vercel Blob signalling store.
 *
 * For deployments that want to stay entirely inside Vercel (no Upstash
 * account). Only tiny JSON documents are written — SDP descriptions and ICE
 * candidates — never file bytes:
 *
 *   ft-signalling/rooms/{code}.json                       room record
 *   ft-signalling/signal/{code}/{ms}-{rand}.json           one message each
 *
 * Reads poll `list()` with a prefix and fetch only messages newer than the
 * caller's cursor, so writes never race (there is no shared mutable document).
 */

const ROOT = 'ft-signalling';
const ROOM_PREFIX = `${ROOT}/rooms`;
const SIGNAL_PREFIX = `${ROOT}/signal`;
const ACCESS = (process.env.BLOB_SIGNALLING_ACCESS === 'public' ? 'public' : 'private') as
  | 'public'
  | 'private';

function roomPathname(code: string): string {
  return `${ROOM_PREFIX}/${code}.json`;
}

function messagePathname(code: string, message: SignalMessage): string {
  const stamp = String(message.at).padStart(13, '0');
  return `${SIGNAL_PREFIX}/${code}/${stamp}-${message.id}.json`;
}

async function readJson<T>(pathname: string): Promise<T | null> {
  try {
    const result = await get(pathname, { access: ACCESS, useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    const text = await new Response(result.stream).text();
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function writeJson(pathname: string, value: unknown, overwrite: boolean): Promise<void> {
  await put(pathname, JSON.stringify(value), {
    access: ACCESS,
    allowOverwrite: overwrite,
    addRandomSuffix: false,
    contentType: 'application/json',
    // Minimum allowed; signalling documents are disposable.
    cacheControlMaxAge: 60,
  });
}

export class BlobStore implements SignalStore {
  readonly kind = 'blob' as const;

  async createRoom(room: RoomRecord): Promise<boolean> {
    const existing = await this.getRoom(room.code);
    if (existing) return false;
    try {
      await writeJson(roomPathname(room.code), room, false);
      return true;
    } catch (error) {
      // A concurrent create with the same code surfaces as an overwrite error.
      if (error instanceof Error && /overwrite|exist/i.test(error.message)) return false;
      throw new StoreUnavailableError();
    }
  }

  async getRoom(code: string): Promise<RoomRecord | null> {
    const room = await readJson<RoomRecord>(roomPathname(code));
    if (!room || typeof room.code !== 'string') return null;
    if (isExpired(room)) {
      await this.deleteRoom(code).catch(() => undefined);
      return null;
    }
    return room;
  }

  async updateRoom(code: string, patch: Partial<RoomRecord>): Promise<RoomRecord | null> {
    const current = await readJson<RoomRecord>(roomPathname(code));
    if (!current) return null;
    const next: RoomRecord = { ...current, ...patch, code };
    try {
      await writeJson(roomPathname(code), next, true);
    } catch {
      throw new StoreUnavailableError();
    }
    return next;
  }

  async appendMessage(code: string, message: SignalMessage): Promise<void> {
    try {
      await writeJson(messagePathname(code, message), message, true);
    } catch {
      throw new StoreUnavailableError();
    }
  }

  async readMessages(
    code: string,
    cursor: string | null,
    limit = 100,
  ): Promise<ReadMessagesResult> {
    const prefix = `${SIGNAL_PREFIX}/${code}/`;
    const pathnames: string[] = [];
    let listCursor: string | undefined;

    for (let page = 0; page < 5; page += 1) {
      let result;
      try {
        result = await list({ prefix, limit: 1000, cursor: listCursor });
      } catch {
        throw new StoreUnavailableError();
      }
      for (const blob of result.blobs) pathnames.push(blob.pathname);
      listCursor = result.cursor ?? undefined;
      if (!result.hasMore || !listCursor) break;
    }

    pathnames.sort();
    const fresh = cursor ? pathnames.filter((pathname) => pathname > cursor) : pathnames;
    const wanted = fresh.slice(0, limit);

    const messages: SignalMessage[] = [];
    for (const pathname of wanted) {
      const message = await readJson<SignalMessage>(pathname);
      if (message && typeof message.id === 'string') messages.push(message);
    }

    const lastRead = wanted[wanted.length - 1];
    return {
      messages,
      cursor: lastRead ?? cursor ?? '',
    };
  }

  async purgeExpired(): Promise<number> {
    const now = Date.now();
    const cutoff = now - 2 * 60 * 60 * 1000;
    const stale: string[] = [];

    // Signalling messages carry their timestamp in the pathname.
    let listCursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      let result;
      try {
        result = await list({ prefix: `${SIGNAL_PREFIX}/`, limit: 1000, cursor: listCursor });
      } catch {
        break;
      }
      for (const blob of result.blobs) {
        const uploaded = blob.uploadedAt instanceof Date ? blob.uploadedAt.getTime() : now;
        if (uploaded < cutoff) stale.push(blob.url);
      }
      listCursor = result.cursor ?? undefined;
      if (!result.hasMore || !listCursor) break;
    }

    // Rooms are small in number; delete the expired ones by content.
    let roomCursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      let result;
      try {
        result = await list({ prefix: `${ROOM_PREFIX}/`, limit: 1000, cursor: roomCursor });
      } catch {
        break;
      }
      for (const blob of result.blobs) {
        const room = await readJson<RoomRecord>(blob.pathname);
        const expired = !room || isExpired(room) || room.expiresAt < now;
        if (expired) stale.push(blob.url);
      }
      roomCursor = result.cursor ?? undefined;
      if (!result.hasMore || !roomCursor) break;
    }

    if (stale.length === 0) return 0;
    for (let index = 0; index < stale.length; index += 100) {
      await del(stale.slice(index, index + 100)).catch(() => undefined);
    }
    return stale.length;
  }

  private async deleteRoom(code: string): Promise<void> {
    const prefix = `${SIGNAL_PREFIX}/${code}/`;
    const urls: string[] = [roomPathname(code)];
    let listCursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = await list({ prefix, limit: 1000, cursor: listCursor });
      for (const blob of result.blobs) urls.push(blob.pathname);
      listCursor = result.cursor ?? undefined;
      if (!result.hasMore || !listCursor) break;
    }
    for (let index = 0; index < urls.length; index += 100) {
      await del(urls.slice(index, index + 100));
    }
  }
}
