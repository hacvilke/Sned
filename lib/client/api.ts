/**
 * Typed fetch helpers for the client. All API errors are normalised into
 * `ApiError` so the UI can react to 429 (back off) and 410 (session over).
 */

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    retryAfterSeconds?: number;
    details?: unknown;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds: number;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, retryAfterSeconds = 0, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.details = details;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }

  get isGone(): boolean {
    return this.status === 404 || this.status === 410;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'network_error', 'Cannot reach the server. Check your connection.');
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const body = payload as ApiErrorBody | null;
    const retryHeader = Number(response.headers.get('retry-after') ?? 0) || 0;
    throw new ApiError(
      response.status,
      body?.error?.code ?? 'request_failed',
      body?.error?.message ?? `Request failed (${response.status}).`,
      body?.error?.retryAfterSeconds ?? retryHeader,
      body?.error?.details,
    );
  }

  return payload as T;
}

export interface RoomView {
  code: string;
  createdAt: number;
  expiresAt: number;
  hostPeerId: string;
  hostName: string;
  guestPeerId: string | null;
  guestName: string | null;
  closed: boolean;
  secondsRemaining: number;
}

export interface CreateRoomResponse {
  role: 'host';
  peerId: string;
  room: RoomView;
}

export interface JoinRoomResponse {
  role: 'guest';
  peerId: string;
  room: RoomView;
}

export interface SignalResponse {
  messages: { id: string; from: string; kind: string; data: unknown; at: number }[];
  cursor: string;
  room: RoomView;
}

export interface TransferResponse {
  ok: boolean;
  direction: 'upload' | 'download';
  limit: number;
  remaining: number;
  windowSeconds: number;
  resetAt: number;
  backend: string;
}

export interface ConfigResponse {
  store: 'redis' | 'blob' | 'memory';
  storeConfigured: boolean;
  production: boolean;
  vercel: boolean;
  rateLimitPreset: string;
  rateLimitBackend: string;
  roomTtlSeconds: number;
  maxFileBytes: number;
  maxFilesPerSession: number;
  hasTurn: boolean;
  iceServers: { urls: string | string[]; username?: string; credential?: string }[];
  limits: { bucket: string; label: string; limit: number; windowSeconds: number }[];
}
