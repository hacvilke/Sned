import { del } from "@vercel/blob";
import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";
import { hasBlob, LIMITS } from "./limits";

/**
 * Storage abstraction.
 *
 * Production (Vercel): Vercel Blob. The browser uploads straight to Blob with
 * a short-lived client token pinned to one exact pathname, so file bytes never
 * pass through a serverless function. That matters: Vercel caps function
 * request bodies at 4.5 MB and Hobby functions at 60s, so proxying bytes
 * through an API route cannot carry a large transfer.
 *
 * Local dev without BLOB_READ_WRITE_TOKEN: an in-process buffer store, capped
 * at MAX_DEV_FILE_BYTES. Those uploads vanish when the dev server restarts.
 */
export type StorageMode = "blob" | "memory";

export type PreparedUpload =
  | { mode: "blob"; clientToken: string; pathname: string }
  | { mode: "memory" };

export function storageMode(): StorageMode {
  return hasBlob ? "blob" : "memory";
}

/**
 * Issue a browser-scoped upload credential. The token is bound to `pathname`,
 * so a leaked token can only ever write that one object, and only up to
 * `maxBytes`.
 */
export async function prepareUpload(
  pathname: string,
  maxBytes: number,
  validForSeconds: number,
): Promise<PreparedUpload> {
  if (!hasBlob) return { mode: "memory" };
  const clientToken = await generateClientTokenFromReadWriteToken({
    token: process.env.BLOB_READ_WRITE_TOKEN!,
    pathname,
    maximumSizeInBytes: maxBytes,
    validUntil: Date.now() + validForSeconds * 1000,
    addRandomSuffix: false,
    allowOverwrite: false,
    cacheControlMaxAge: 60,
  });
  return { mode: "blob", clientToken, pathname };
}

/* -------------------------------------------------------------------------- */
/* In-process dev store                                                        */
/* -------------------------------------------------------------------------- */

type MemoryBlob = { data: Buffer; at: number };

/** See the note in kv.ts: globalThis keeps this shared across Next's bundles. */
const globalBlob = globalThis as unknown as { __snedBlobs?: Map<string, MemoryBlob> };
if (!globalBlob.__snedBlobs) globalBlob.__snedBlobs = new Map();
const memoryStore = globalBlob.__snedBlobs;

export async function putMemory(key: string, data: Uint8Array): Promise<void> {
  memoryStore.set(key, { data: Buffer.from(data), at: Date.now() });
}

export function getMemory(key: string): { data: Buffer; at: number } | null {
  return memoryStore.get(key) ?? null;
}

export function deleteMemory(key: string): void {
  memoryStore.delete(key);
}

export function memoryStoreSize(): number {
  let total = 0;
  for (const { data } of memoryStore.values()) total += data.byteLength;
  return total;
}

/** `memory:` pseudo-URLs identify objects held in the dev store. */
export function memoryKey(url: string): string | null {
  return url.startsWith("memory:") ? url.slice("memory:".length) : null;
}

export function toMemoryUrl(key: string): string {
  return `memory:${key}`;
}

/* -------------------------------------------------------------------------- */

export async function deleteStored(url: string): Promise<void> {
  const key = memoryKey(url);
  if (key) {
    deleteMemory(key);
    return;
  }
  if (!hasBlob) return;
  try {
    await del(url, { token: process.env.BLOB_READ_WRITE_TOKEN! });
  } catch (error) {
    console.error("[sned] failed to delete blob", url, error);
  }
}

export function devStoreCap(): number {
  return LIMITS.maxDevFileBytes;
}

export function __resetStorageForTests() {
  memoryStore.clear();
}
