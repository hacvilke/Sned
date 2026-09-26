/** Client-facing state shapes shared between the session engine and the UI. */

export type SessionRole = 'host' | 'guest';

export type SessionPhase =
  | 'idle'
  | 'starting'
  | 'waiting'
  | 'signalling'
  | 'connecting'
  | 'connected'
  | 'closed'
  | 'failed';

export type OutStatus =
  | 'queued'
  | 'awaiting-accept'
  | 'sending'
  | 'sent'
  | 'confirmed'
  | 'skipped'
  | 'cancelled'
  | 'failed'
  | 'rate-limited';

export interface OutgoingFileView {
  id: string;
  index: number;
  name: string;
  size: number;
  type: string;
  status: OutStatus;
  sent: number;
  /** Bytes per second, smoothed over the last sample window. */
  rate: number;
  error?: string;
  note?: string;
  /** Epoch ms when a rate limited item may be retried. */
  resumeAt?: number;
}

export type InStatus = 'awaiting-save' | 'receiving' | 'complete' | 'failed' | 'declined' | 'cancelled';

export interface IncomingFileView {
  id: string;
  index: number;
  name: string;
  size: number;
  type: string;
  status: InStatus;
  received: number;
  /** Bytes per second, smoothed over the last sample window. */
  rate: number;
  mode: 'stream' | 'memory' | null;
  error?: string;
  /** Object URL for a completed in-memory download. */
  url?: string;
  savedName?: string;
}

export interface Notice {
  id: string;
  level: 'info' | 'warn' | 'error';
  text: string;
  at: number;
}

export interface Budget {
  limit: number;
  remaining: number;
  resetAt: number;
  windowSeconds: number;
}

export interface SessionSnapshot {
  phase: SessionPhase;
  role: SessionRole | null;
  code: string | null;
  link: string | null;
  peerId: string | null;
  selfName: string;
  peerName: string | null;
  expiresAt: number | null;
  /** Short human readable line describing what is happening. */
  statusText: string;
  statusDetail: string | null;
  outgoing: OutgoingFileView[];
  incoming: IncomingFileView[];
  notices: Notice[];
  budgets: { upload: Budget | null; download: Budget | null };
  queueRunning: boolean;
  autoSave: boolean;
  canStreamToDisk: boolean;
  connectionType: string | null;
  busy: boolean;
}

export interface SessionHandlers {
  onSnapshot(snapshot: SessionSnapshot): void;
}

/** Rough, privacy-preserving device label derived from the user agent. */
export function describeDevice(ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : /Firefox\//.test(ua)
            ? 'Firefox'
            : 'Browser';
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'Unknown OS';
  return `${os} · ${browser}`;
}

export function supportsStreamToDisk(): boolean {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
}
