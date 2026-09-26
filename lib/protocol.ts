/**
 * Wire protocol for the WebRTC data channel.
 *
 * Both directions are symmetric: either device may queue files, and every
 * message and binary frame carries the direction bit of the device that owns
 * the file (host = 0, guest = 1). A peer ignores frames carrying its own bit
 * and treats everything else as inbound.
 */

export const PROTOCOL_VERSION = 1;
export const DATA_CHANNEL_LABEL = 'ft-files';

export const HOST_DIRECTION = 0;
export const GUEST_DIRECTION = 1;

/** 64 KiB payload per binary frame. */
export const CHUNK_SIZE = 64 * 1024;
/** 1 byte direction + 4 bytes file index. */
export const FRAME_HEADER_BYTES = 5;
/** Pause sending above this many queued bytes; resume below the low water mark. */
export const BUFFER_HIGH_WATER = 4 * 1024 * 1024;
export const BUFFER_LOW_WATER = 512 * 1024;

export type Direction = 0 | 1;

/**
 * A byte chunk backed by a plain ArrayBuffer. TypeScript 5.7+ distinguishes
 * `Uint8Array<ArrayBuffer>` from `Uint8Array<ArrayBufferLike>`, and the DOM
 * APIs used here (Blob parts, FileSystemWritableFileStream.write) want the
 * former.
 */
export type ByteChunk = Uint8Array<ArrayBuffer>;

/**
 * Control messages. `dir` is the direction bit of the device that owns the
 * referenced file, not of the device sending the message.
 */
export type ControlMessage =
  | { v: 1; t: 'peer-info'; dir: Direction; name: string; platform: string; caps: PeerCaps }
  | { v: 1; t: 'meta'; dir: Direction; fileId: string; index: number; count: number; name: string; size: number; type: string }
  | { v: 1; t: 'ready'; dir: Direction; fileId: string; mode: 'stream' | 'memory' }
  | { v: 1; t: 'decline'; dir: Direction; fileId: string; reason: string }
  | { v: 1; t: 'done'; dir: Direction; fileId: string; size: number }
  | { v: 1; t: 'received'; dir: Direction; fileId: string; size: number; ok: boolean; error?: string }
  | { v: 1; t: 'cancel'; dir: Direction; fileId: string; reason: string }
  | { v: 1; t: 'all-done'; dir: Direction; sent: number; failed: number };

export interface PeerCaps {
  /** File System Access API is available: can stream straight to disk. */
  streamToDisk: boolean;
}

export function encodeFrame(dir: Direction, fileIndex: number, payload: Uint8Array): ByteChunk {
  const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint8(0, dir);
  view.setUint32(1, fileIndex, false);
  frame.set(payload, FRAME_HEADER_BYTES);
  return frame;
}

export function decodeFrame(frame: Uint8Array): {
  dir: Direction;
  fileIndex: number;
  payload: ByteChunk;
} {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return {
    dir: view.getUint8(0) as Direction,
    fileIndex: view.getUint32(1, false),
    payload: frame.subarray(FRAME_HEADER_BYTES) as ByteChunk,
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** "ABCDEF" -> "ABC DEF" for display. */
export function formatCode(code: string): string {
  if (code.length !== 6) return code;
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

export function formatClock(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(value / 60);
  const rest = value % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}
