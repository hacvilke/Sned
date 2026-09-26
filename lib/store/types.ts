import type { StoreKind } from '../config';

/** A transfer session. Two peers maximum: the host (sender) and one guest. */
export interface RoomRecord {
  code: string;
  createdAt: number;
  expiresAt: number;
  hostPeerId: string;
  hostName: string;
  guestPeerId?: string;
  guestName?: string;
  /** Set when either peer ends the session or the TTL passes. */
  closed?: boolean;
  closedAt?: number;
}

export type SignalKind = 'hello' | 'offer' | 'answer' | 'ice' | 'bye' | 'peer-info';

/**
 * One signalling message in a session log. Payloads are SDP descriptions and
 * ICE candidates; file bytes never touch the server.
 */
export interface SignalMessage {
  id: string;
  from: string;
  kind: SignalKind | string;
  data: unknown;
  at: number;
}

export interface ReadMessagesResult {
  messages: SignalMessage[];
  /** Opaque, store specific cursor to pass back on the next read. */
  cursor: string;
}

export interface SignalStore {
  readonly kind: StoreKind;
  /** Creates the room. Returns false when the code is already taken. */
  createRoom(room: RoomRecord): Promise<boolean>;
  /** Returns null when the room does not exist or has expired. */
  getRoom(code: string): Promise<RoomRecord | null>;
  /** Read-modify-write of a room record; returns null when the room is gone. */
  updateRoom(code: string, patch: Partial<RoomRecord>): Promise<RoomRecord | null>;
  appendMessage(code: string, message: SignalMessage): Promise<void>;
  readMessages(code: string, cursor: string | null, limit?: number): Promise<ReadMessagesResult>;
  /** Deletes expired state. Returns the number of items removed. */
  purgeExpired?(): Promise<number>;
}

export function isExpired(room: RoomRecord, now = Date.now()): boolean {
  return room.closed === true || room.expiresAt <= now;
}

/** Thrown when the backing store cannot be reached. Routes turn this into 503. */
export class StoreUnavailableError extends Error {
  constructor(message = 'Signalling store unavailable') {
    super(message);
    this.name = 'StoreUnavailableError';
  }
}
