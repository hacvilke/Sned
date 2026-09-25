import { randomInt } from "node:crypto";
import { kv } from "./kv";
import { CODE_LENGTH, LIMITS } from "./limits";
import { deleteStored } from "./storage";

export type StoredFile = {
  id: string;
  name: string;
  /** Original relative path when a folder was dropped; equal to `name` otherwise. */
  path: string;
  size: number;
  type: string;
  /** Canonical object URL. Used for cleanup. */
  url: string;
  /** URL that forces a browser download rather than an inline preview. */
  downloadUrl: string;
  createdAt: number;
};

export type Share = {
  code: string;
  files: StoredFile[];
  /** `open` while the sender's queue is still running, `sealed` once finished. */
  status: "open" | "sealed";
  createdAt: number;
  expiresAt: number;
  ownerId: string;
  totalBytes: number;
  sealedAt?: number;
};

export type PendingUpload = {
  id: string;
  shareCode: string;
  name: string;
  path: string;
  size: number;
  type: string;
  ownerId: string;
  createdAt: number;
  expiresAt: number;
};

const SHARE_PREFIX = "sned:share:";
const PENDING_PREFIX = "sned:pending:";
const EXPIRING_ZSET = "sned:expiring";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function newCode(length = CODE_LENGTH): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export function isPlausibleCode(code: string): boolean {
  // Case-insensitive on purpose: the route upper-cases before lookup, and a
  // user typing a code by hand should not be rejected for a lowercase "a".
  // Ambiguous glyphs (0, 1, I, O) are never issued, so never accepted either.
  return /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4,12}$/i.test(code);
}

function shareKey(code: string) {
  return `${SHARE_PREFIX}${code.toUpperCase()}`;
}

function pendingKey(id: string) {
  return `${PENDING_PREFIX}${id}`;
}

function ttlSeconds(expiresAt: number): number {
  return Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
}

/* -------------------------------------------------------------------------- */
/* Shares                                                                      */
/* -------------------------------------------------------------------------- */

export async function createShare(ownerId: string, codeHint?: string): Promise<Share> {
  const now = Date.now();
  const expiresAt = now + LIMITS.ttlHours * 3_600_000;
  const ttl = ttlSeconds(expiresAt);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = codeHint?.toUpperCase() ?? newCode();
    if (await kv().get(shareKey(code))) continue;
    const share: Share = {
      code,
      files: [],
      status: "open",
      createdAt: now,
      expiresAt,
      ownerId,
      totalBytes: 0,
    };
    await kv().set(shareKey(code), JSON.stringify(share), ttl);
    return share;
  }
  throw new Error("could not allocate a free share code");
}

export async function getShare(code: string): Promise<Share | null> {
  const raw = await kv().get(shareKey(code));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Share;
  } catch {
    return null;
  }
}

export async function saveShare(share: Share): Promise<void> {
  const ttl = ttlSeconds(share.expiresAt);
  await kv().set(shareKey(share.code), JSON.stringify(share), ttl);
}

export async function attachFile(code: string, file: StoredFile): Promise<Share> {
  const share = await getShare(code);
  if (!share) throw new ShareError("This transfer link no longer exists.");
  if (Date.now() > share.expiresAt) throw new ShareError("This transfer has expired.");
  if (share.files.length >= LIMITS.maxFilesPerBatch) {
    throw new ShareError(`A transfer can hold at most ${LIMITS.maxFilesPerBatch} files.`);
  }
  if (share.totalBytes + file.size > LIMITS.maxBatchBytes) {
    throw new ShareError("That would exceed the size limit for one transfer.");
  }
  if (share.files.some((existing) => existing.id === file.id)) return share;

  share.files.push(file);
  share.totalBytes += file.size;
  await saveShare(share);
  // Index the blob URL itself, not a reference to the share record: the share
  // record has the same TTL as this entry, so by the time cleanup runs the
  // record is already gone and a lookup would find nothing to delete.
  await kv().zadd(EXPIRING_ZSET, share.expiresAt, file.url);
  return share;
}

export async function sealShare(code: string): Promise<Share> {
  const share = await getShare(code);
  if (!share) throw new ShareError("This transfer link no longer exists.");
  if (share.status === "sealed") return share;
  share.status = "sealed";
  share.sealedAt = Date.now();
  await saveShare(share);
  return share;
}

/* -------------------------------------------------------------------------- */
/* Pending uploads                                                             */
/* -------------------------------------------------------------------------- */

export async function savePending(pending: PendingUpload): Promise<void> {
  await kv().set(
    pendingKey(pending.id),
    JSON.stringify(pending),
    ttlSeconds(pending.expiresAt),
  );
}

/**
 * Readers must check `expiresAt` themselves rather than lean on the KV TTL:
 * an already-expired reservation still clamps to a 1-second TTL, so it stays
 * readable for up to a second after it should have died.
 */
function isLive<T extends { expiresAt: number }>(record: T): boolean {
  return record.expiresAt > Date.now();
}

export async function takePending(id: string): Promise<PendingUpload | null> {
  const raw = await kv().get(pendingKey(id));
  if (!raw) return null;
  await kv().del(pendingKey(id));
  try {
    const pending = JSON.parse(raw) as PendingUpload;
    return isLive(pending) ? pending : null;
  } catch {
    return null;
  }
}

export async function peekPending(id: string): Promise<PendingUpload | null> {
  const raw = await kv().get(pendingKey(id));
  if (!raw) return null;
  try {
    const pending = JSON.parse(raw) as PendingUpload;
    return isLive(pending) ? pending : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Expiry cleanup                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Blob URLs whose transfer has expired, ready for deletion.
 *
 * Members are the blob URLs themselves, so this works even after the share
 * record has been evicted by its TTL - which is the normal case, since the
 * cleanup cron runs on its own schedule rather than at the instant of expiry.
 */
export async function collectExpired(now = Date.now(), limit = 200): Promise<string[]> {
  const urls = await kv().zrangeByScore(EXPIRING_ZSET, 0, now, limit);
  for (const url of urls) await kv().zrem(EXPIRING_ZSET, url);
  return urls;
}

/** Purge every file in a share right now. */
export async function destroyShare(code: string): Promise<number> {
  const share = await getShare(code);
  if (!share) return 0;
  for (const file of share.files) {
    await deleteStored(file.url);
    await kv().zrem(EXPIRING_ZSET, file.url);
  }
  await kv().del(shareKey(share.code));
  return share.files.length;
}

export class ShareError extends Error {}
