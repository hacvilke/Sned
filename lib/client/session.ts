/**
 * PeerSession — the client side engine.
 *
 * Responsibilities:
 *   1. Signalling over plain HTTP polling against /api/rooms/:code/signal.
 *   2. One RTCPeerConnection plus an ordered data channel between two devices.
 *   3. A sequential send queue with backpressure, per-file accept/decline,
 *      cancellation, progress and server-side rate limit backoff.
 *   4. Receiving: stream straight to disk where the File System Access API
 *      exists, otherwise buffer and hand the browser a download.
 *
 * File bytes never touch the server. The server only relays SDP/ICE and
 * enforces per-IP budgets.
 */

import {
  BUFFER_HIGH_WATER,
  BUFFER_LOW_WATER,
  CHUNK_SIZE,
  DATA_CHANNEL_LABEL,
  type ByteChunk,
  GUEST_DIRECTION,
  HOST_DIRECTION,
  decodeFrame,
  encodeFrame,
  formatBytes,
  type ControlMessage,
  type Direction,
} from '../protocol';
import {
  ApiError,
  api,
  type ConfigResponse,
  type CreateRoomResponse,
  type JoinRoomResponse,
  type RoomView,
  type SignalResponse,
  type TransferResponse,
} from './api';
import {
  describeDevice,
  supportsStreamToDisk,
  type Budget,
  type IncomingFileView,
  type InStatus,
  type Notice,
  type OutgoingFileView,
  type OutStatus,
  type SessionHandlers,
  type SessionPhase,
  type SessionRole,
  type SessionSnapshot,
} from './types';

const POLL_ACTIVE_MS = 1000;
const POLL_CONNECTED_MS = 4000;
const CONNECT_TIMEOUT_MS = 45_000;
const READY_TIMEOUT_MS = 5 * 60_000;
const EMIT_THROTTLE_MS = 100;
const RATE_SAMPLE_MS = 400;
const STORAGE_KEY = 'ft.session.v1';

interface OutgoingRecord {
  id: string;
  index: number;
  file: File;
  name: string;
  size: number;
  type: string;
  status: OutStatus;
  sent: number;
  rate: number;
  error?: string;
  note?: string;
  resumeAt?: number;
  sampleAt: number;
  sampleBytes: number;
}

interface IncomingRecord {
  id: string;
  index: number;
  name: string;
  size: number;
  type: string;
  status: InStatus;
  received: number;
  rate: number;
  mode: 'stream' | 'memory' | null;
  error?: string;
  url?: string;
  savedName?: string;
  parts: ByteChunk[];
  writable: FileSystemWritableFileStream | null;
  writeChain: Promise<void>;
  sampleAt: number;
  sampleBytes: number;
}

export interface PersistedSession {
  code: string;
  peerId: string;
  role: SessionRole;
  name: string;
  expiresAt: number;
}

type Decision = 'ready' | 'declined' | 'timeout' | 'closed';

const DECISION_TEXT: Record<Decision, string> = {
  ready: '',
  declined: 'The other device declined this file.',
  timeout: 'The other device did not respond in time.',
  closed: 'The connection closed before this file could be sent.',
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function randomId(prefix: string): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return `${prefix}_${out}`;
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function triggerDownload(url: string, name: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

const STATUS_TEXT: Record<SessionPhase, string> = {
  idle: 'No session',
  starting: 'Working…',
  waiting: 'Waiting for the other device',
  signalling: 'Negotiating connection',
  connecting: 'Connecting',
  connected: 'Connected',
  closed: 'Session ended',
  failed: 'Not connected',
};

export class PeerSession {
  private readonly handlers: SessionHandlers;
  private config: ConfigResponse | null = null;

  private phase: SessionPhase = 'idle';
  private statusDetail: string | null = null;
  private role: SessionRole | null = null;
  private code: string | null = null;
  private peerId: string | null = null;
  private room: RoomView | null = null;
  private selfName = describeDevice();
  private peerName: string | null = null;
  private busy = false;

  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private connectionType: string | null = null;
  private connectTimer: number | null = null;
  private negotiating = false;

  private cursor = '';
  /** Ignore signalling messages written before this session attached. */
  private sinceAt = 0;
  private pollGeneration = 0;
  private destroyed = false;

  private outgoing = new Map<string, OutgoingRecord>();
  private outgoingOrder: string[] = [];
  private nextOutIndex = 0;
  private queueRunning = false;
  /** Files the user (or the peer) cancelled; survives status narrowing. */
  private cancelledIds = new Set<string>();
  private decisions = new Map<string, (decision: Decision) => void>();
  private confirmations = new Map<string, (ok: boolean, error?: string) => void>();

  private incoming = new Map<string, IncomingRecord>();
  private incomingByIndex = new Map<number, string>();
  private autoSave = !supportsStreamToDisk();

  private notices: Notice[] = [];
  private budgets: { upload: Budget | null; download: Budget | null } = {
    upload: null,
    download: null,
  };

  private emitScheduled = false;
  private lastEmit = 0;

  constructor(handlers: SessionHandlers, initialConfig?: ConfigResponse | null) {
    this.handlers = handlers;
    this.config = initialConfig ?? null;
    this.autoSave = !supportsStreamToDisk();
  }

  /** Current state, for the first render before any event has fired. */
  current(): SessionSnapshot {
    return this.snapshot();
  }

  // ---------------------------------------------------------------- lifecycle

  static readPersisted(): PersistedSession | null {
    if (typeof window === 'undefined') return null;
    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as PersistedSession;
      if (!parsed?.code || !parsed?.peerId || parsed.expiresAt < Date.now()) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  static clearPersisted(): void {
    if (typeof window === 'undefined') return;
    try {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  private persist(): void {
    if (typeof window === 'undefined') return;
    if (!this.code || !this.peerId || !this.role || !this.room) return;
    const record: PersistedSession = {
      code: this.code,
      peerId: this.peerId,
      role: this.role,
      name: this.selfName,
      expiresAt: this.room.expiresAt,
    };
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(record));
    } catch {
      /* ignore */
    }
  }

  /** Create a session. Either device may then queue files. */
  async startHost(name?: string): Promise<void> {
    if (name) this.selfName = name;
    this.setBusy(true);
    this.setPhase('starting', 'Creating a session…');
    try {
      const created = await api<CreateRoomResponse>('/api/rooms', {
        method: 'POST',
        body: JSON.stringify({ name: this.selfName }),
      });
      this.role = created.role;
      this.code = created.room.code;
      this.peerId = created.peerId;
      this.room = created.room;
      this.cursor = '';
      this.sinceAt = Date.now();
      await this.refreshConfig();
      this.persist();
      this.setPhase('waiting', `Share code ${created.room.code} with the other device.`);
      this.startPolling();
    } catch (error) {
      this.fail(error, 'Could not create a session.');
    } finally {
      this.setBusy(false);
    }
  }

  /** Join a session created by another device. */
  async joinAsGuest(code: string, name?: string, reclaimPeerId?: string): Promise<void> {
    if (name) this.selfName = name;
    this.setBusy(true);
    this.setPhase('starting', `Joining session ${code}…`);
    try {
      const joined = await api<JoinRoomResponse>(`/api/rooms/${code}/join`, {
        method: 'POST',
        body: JSON.stringify({ name: this.selfName, peerId: reclaimPeerId }),
      });
      this.role = joined.role;
      this.code = joined.room.code;
      this.peerId = joined.peerId;
      this.room = joined.room;
      this.peerName = joined.room.hostName;
      this.cursor = '';
      // Only act on signalling written from now on: an earlier connection
      // attempt may have left stale offers in the log.
      this.sinceAt = Date.now();
      await this.refreshConfig();
      this.persist();
      this.setPhase('signalling', 'Joined. Establishing a direct connection…');
      this.startPolling();
    } catch (error) {
      this.fail(error, 'Could not join that session.');
    } finally {
      this.setBusy(false);
    }
  }

  /** Re-attach to a session kept in sessionStorage after a page reload. */
  async resume(persisted: PersistedSession): Promise<void> {
    this.selfName = persisted.name || this.selfName;
    this.sinceAt = Date.now();
    if (persisted.role === 'guest') {
      await this.joinAsGuest(persisted.code, persisted.name, persisted.peerId);
      return;
    }

    this.setBusy(true);
    this.setPhase('starting', 'Resuming session…');
    try {
      this.role = 'host';
      this.code = persisted.code;
      this.peerId = persisted.peerId;
      await this.refreshConfig();
      const probe = await api<SignalResponse>(
        `/api/rooms/${this.code}/signal?peerId=${encodeURIComponent(this.peerId)}&cursor=`,
      );
      this.room = probe.room;
      this.cursor = probe.cursor;
      this.peerName = probe.room.guestName;
      this.persist();
      this.startPolling();
      if (probe.room.guestPeerId) {
        this.setPhase('signalling', 'Reconnecting to the other device…');
        await this.hostOffer(true);
      } else {
        this.setPhase('waiting', 'Waiting for the other device to enter the code.');
      }
    } catch (error) {
      PeerSession.clearPersisted();
      this.fail(error, 'That session is no longer active.');
    } finally {
      this.setBusy(false);
    }
  }

  /** Re-negotiate the connection without creating a new session. */
  async reconnect(): Promise<void> {
    if (!this.code || !this.peerId) return;
    this.setBusy(true);
    this.closePeerConnection();
    this.pendingCandidates = [];
    try {
      if (this.role === 'host') {
        await this.hostOffer(true);
      } else {
        this.setPhase('signalling', 'Waiting for the sending device to reconnect…');
        await this.postSignal('peer-info', { name: this.selfName, reconnect: true });
      }
    } finally {
      this.setBusy(false);
    }
  }

  async endSession(reason = 'Session ended.'): Promise<void> {
    if (this.code && this.peerId && this.phase !== 'idle') {
      try {
        await api(`/api/rooms/${this.code}/close`, {
          method: 'POST',
          body: JSON.stringify({ peerId: this.peerId }),
        });
      } catch {
        /* best effort */
      }
    }
    this.teardown(reason);
    PeerSession.clearPersisted();
  }

  destroy(): void {
    this.destroyed = true;
    this.pollGeneration += 1;
    this.teardown('');
    for (const record of this.incoming.values()) {
      if (record.url) URL.revokeObjectURL(record.url);
    }
  }

  // ------------------------------------------------------------------- config

  private async refreshConfig(): Promise<void> {
    try {
      this.config = await api<ConfigResponse>(
        `/api/config${this.code ? `?code=${encodeURIComponent(this.code)}` : ''}`,
      );
    } catch {
      this.config = null;
    }
  }

  private iceServers(): RTCIceServer[] {
    const servers = this.config?.iceServers;
    if (servers && servers.length > 0) return servers as RTCIceServer[];
    return [{ urls: 'stun:stun.l.google.com:19302' }];
  }

  // --------------------------------------------------------------- signalling

  private get direction(): Direction {
    return this.role === 'host' ? HOST_DIRECTION : GUEST_DIRECTION;
  }

  private peerDirection(): Direction {
    return this.direction === HOST_DIRECTION ? GUEST_DIRECTION : HOST_DIRECTION;
  }

  private startPolling(): void {
    this.pollGeneration += 1;
    void this.pollLoop(this.pollGeneration);
  }

  private async pollLoop(generation: number): Promise<void> {
    while (!this.destroyed && generation === this.pollGeneration && this.code && this.peerId) {
      await sleep(this.phase === 'connected' ? POLL_CONNECTED_MS : POLL_ACTIVE_MS);
      if (this.destroyed || generation !== this.pollGeneration) return;
      try {
        const result = await api<SignalResponse>(
          `/api/rooms/${this.code}/signal?peerId=${encodeURIComponent(this.peerId)}&cursor=${encodeURIComponent(this.cursor)}`,
        );
        this.cursor = result.cursor;
        this.applyRoom(result.room);
        for (const message of result.messages) {
          if (message.at < this.sinceAt - 2000) continue;
          await this.handleSignal(message.kind, message.data);
        }
      } catch (error) {
        if (error instanceof ApiError) {
          if (error.isRateLimited) {
            const wait = Math.min(error.retryAfterSeconds || 5, 30);
            this.pushNotice('warn', `Signalling rate limited. Retrying in ${wait}s.`, 8000);
            await sleep(wait * 1000);
            continue;
          }
          if (error.isGone) {
            this.teardown(error.message);
            return;
          }
        }
        // Transient network problem: keep polling, the session may recover.
      }
    }
  }

  private applyRoom(room: RoomView): void {
    this.room = room;
    if (this.role === 'host' && room.guestName) this.peerName = room.guestName;
    if (room.closed && this.phase !== 'closed') this.teardown('The session was closed.');
  }

  private async postSignal(kind: string, data: unknown): Promise<boolean> {
    if (!this.code || !this.peerId) return false;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (this.destroyed) return false;
      try {
        await api(`/api/rooms/${this.code}/signal`, {
          method: 'POST',
          body: JSON.stringify({ peerId: this.peerId, kind, data }),
        });
        return true;
      } catch (error) {
        if (error instanceof ApiError && error.isRateLimited) {
          const wait = Math.min(error.retryAfterSeconds || 5, 30);
          this.pushNotice('warn', `Signalling rate limited. Waiting ${wait}s.`, 8000);
          await sleep(wait * 1000);
          continue;
        }
        if (error instanceof ApiError && error.isGone) {
          this.teardown(error.message);
          return false;
        }
        await sleep(500 * (attempt + 1));
      }
    }
    this.pushNotice('error', 'Could not deliver a signalling message after several attempts.');
    return false;
  }

  private async handleSignal(kind: string, data: unknown): Promise<void> {
    try {
      switch (kind) {
        case 'hello': {
          const name = (data as { name?: string } | null)?.name;
          if (name) this.peerName = name;
          const channelDead = !this.channel || this.channel.readyState !== 'open';
          if (this.role === 'host' && channelDead && !this.negotiating) {
            this.setPhase('signalling', 'Device joined. Establishing a direct connection…');
            await this.hostOffer();
          }
          this.emit(true);
          break;
        }
        case 'offer':
          if (this.role === 'guest') await this.guestAnswer(data as RTCSessionDescriptionInit);
          break;
        case 'answer':
          await this.acceptAnswer(data as RTCSessionDescriptionInit);
          break;
        case 'ice':
          await this.addRemoteCandidate(data as RTCIceCandidateInit);
          break;
        case 'bye':
          this.teardown('The other device ended the session.');
          break;
        default:
          break;
      }
    } catch (error) {
      this.pushNotice('error', `Signalling error: ${describeError(error)}`);
    }
  }

  // ------------------------------------------------------------------- WebRTC

  private newPeerConnection(): RTCPeerConnection {
    this.closePeerConnection();
    const pc = new RTCPeerConnection({ iceServers: this.iceServers() });
    this.pendingCandidates = [];
    this.connectionType = null;

    pc.onicecandidate = (event) => {
      if (event.candidate) void this.postSignal('ice', event.candidate.toJSON());
    };
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') {
        this.clearConnectTimer();
        if (this.phase !== 'connected') {
          this.setPhase('connected', 'Connected directly to the other device.');
        }
        void this.refreshConnectionType();
      } else if (state === 'failed') {
        this.pushNotice(
          'error',
          'The direct connection failed. Both devices may sit behind restrictive NATs — configure a TURN relay (TURN_URL, TURN_USERNAME, TURN_CREDENTIAL) or switch network.',
        );
        this.setPhase('failed', 'Connection failed.');
      } else if (state === 'disconnected' && this.phase === 'connected') {
        this.setPhase('connecting', 'Connection interrupted, waiting for it to recover…');
      }
    };
    pc.ondatachannel = (event) => this.bindChannel(event.channel);
    return pc;
  }

  private closePeerConnection(): void {
    if (this.channel) {
      this.channel.onopen = null;
      this.channel.onclose = null;
      this.channel.onerror = null;
      this.channel.onmessage = null;
      try {
        this.channel.close();
      } catch {
        /* ignore */
      }
      this.channel = null;
    }
    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.onconnectionstatechange = null;
      this.pc.ondatachannel = null;
      try {
        this.pc.close();
      } catch {
        /* ignore */
      }
      this.pc = null;
    }
  }

  private async hostOffer(restart = false): Promise<void> {
    if (this.negotiating) return;
    this.negotiating = true;
    try {
      this.pc = this.newPeerConnection();
      const channel = this.pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true });
      this.bindChannel(channel);
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.setPhase('signalling', restart ? 'Reconnecting…' : 'Negotiating a direct connection…');
      this.armConnectTimer();
      await this.postSignal('offer', {
        type: this.pc.localDescription?.type,
        sdp: this.pc.localDescription?.sdp,
      });
    } catch (error) {
      this.setPhase('failed', `Could not start the connection: ${describeError(error)}`);
    } finally {
      this.negotiating = false;
    }
  }

  private async guestAnswer(offer: RTCSessionDescriptionInit): Promise<void> {
    if (this.negotiating) return;
    this.negotiating = true;
    try {
      this.pc = this.newPeerConnection();
      await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
      await this.flushCandidates();
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.setPhase('connecting', 'Answering…');
      this.armConnectTimer();
      await this.postSignal('answer', {
        type: this.pc.localDescription?.type,
        sdp: this.pc.localDescription?.sdp,
      });
    } catch (error) {
      this.setPhase('failed', `Could not answer the connection request: ${describeError(error)}`);
    } finally {
      this.negotiating = false;
    }
  }

  private async acceptAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    if (!this.pc) return;
    try {
      await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
      await this.flushCandidates();
      this.setPhase('connecting', 'Connecting…');
    } catch (error) {
      this.pushNotice('error', `Could not apply the answer: ${describeError(error)}`);
    }
  }

  private async addRemoteCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.pc || !candidate) return;
    if (!this.pc.remoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      this.pushNotice('warn', `Ignored an ICE candidate: ${describeError(error)}`, 6000);
    }
  }

  private async flushCandidates(): Promise<void> {
    if (!this.pc) return;
    const queued = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of queued) {
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        /* ignore stale candidates */
      }
    }
  }

  private armConnectTimer(): void {
    this.clearConnectTimer();
    this.connectTimer = window.setTimeout(() => {
      if (this.phase !== 'connected') {
        this.setPhase(
          'failed',
          'No direct connection within 45 seconds. Make sure both devices are online; on restrictive networks a TURN relay is required.',
        );
      }
    }, CONNECT_TIMEOUT_MS);
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      window.clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private async refreshConnectionType(): Promise<void> {
    try {
      if (!this.pc) return;
      const stats = await this.pc.getStats();
      let selectedPair: Record<string, unknown> | null = null;
      stats.forEach((report: unknown) => {
        const entry = report as Record<string, unknown>;
        if (entry.type === 'candidate-pair' && (entry.selected || entry.nominated)) {
          selectedPair = entry;
        }
      });
      const pair = selectedPair as Record<string, unknown> | null;
      if (!pair) return;
      const localId = pair.localCandidateId as string | undefined;
      const local = localId ? (stats.get(localId) as Record<string, unknown> | undefined) : undefined;
      const kind = local?.candidateType as string | undefined;
      this.connectionType =
        kind === 'relay'
          ? 'Relayed (TURN)'
          : kind === 'srflx' || kind === 'prflx'
            ? 'Direct (over the internet)'
            : kind === 'host'
              ? 'Direct (local network)'
              : 'Direct';
      this.emit();
    } catch {
      /* stats are best effort */
    }
  }

  // ------------------------------------------------------------- data channel

  private bindChannel(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = BUFFER_LOW_WATER;

    channel.onopen = () => {
      this.clearConnectTimer();
      this.setPhase('connected', 'Connected directly to the other device.');
      void this.refreshConnectionType();
      this.sendControl({
        v: 1,
        t: 'peer-info',
        dir: this.direction,
        name: this.selfName,
        platform: describeDevice(),
        caps: { streamToDisk: supportsStreamToDisk() },
      });
      // Anything queued before the link came up starts now.
      void this.processQueue();
    };
    channel.onclose = () => {
      if (this.phase === 'connected' || this.phase === 'connecting') {
        this.abortTransfers('The connection closed.');
        this.setPhase('closed', 'The other device disconnected.');
      }
    };
    channel.onerror = () => {
      this.pushNotice('error', 'Data channel error — the transfer may have been interrupted.');
    };
    channel.onmessage = (event) => this.onChannelMessage(event);
  }

  private sendControl(message: ControlMessage): void {
    if (!this.channel || this.channel.readyState !== 'open') return;
    try {
      this.channel.send(JSON.stringify(message));
    } catch (error) {
      this.pushNotice('error', `Could not send a control message: ${describeError(error)}`);
    }
  }

  private onChannelMessage(event: MessageEvent): void {
    if (typeof event.data === 'string') {
      let message: ControlMessage;
      try {
        message = JSON.parse(event.data) as ControlMessage;
      } catch {
        return;
      }
      this.handleControl(message);
      return;
    }
    const frame = new Uint8Array(event.data as ArrayBuffer);
    const { dir, fileIndex, payload } = decodeFrame(frame);
    if (dir === this.direction) return;
    const id = this.incomingByIndex.get(fileIndex);
    if (!id) return;
    const record = this.incoming.get(id);
    if (!record) return;
    void this.writeChunk(record, payload);
  }

  private handleControl(message: ControlMessage): void {
    switch (message.t) {
      case 'peer-info': {
        if (message.name) this.peerName = message.name;
        this.emit(true);
        break;
      }
      case 'meta': {
        if (message.dir === this.direction) return;
        void this.announceIncoming(message);
        break;
      }
      case 'ready': {
        if (message.dir !== this.direction) return;
        this.resolveDecision(message.fileId, 'ready');
        break;
      }
      case 'decline': {
        if (message.dir !== this.direction) return;
        const record = this.outgoing.get(message.fileId);
        if (record) {
          record.status = 'skipped';
          record.note =
            message.reason === 'rate-limited'
              ? 'Declined: the receiving device hit its download limit.'
              : `Declined by the other device (${message.reason}).`;
        }
        this.resolveDecision(message.fileId, 'declined');
        this.emit(true);
        break;
      }
      case 'done': {
        if (message.dir === this.direction) return;
        void this.finishIncoming(message.fileId);
        break;
      }
      case 'received': {
        if (message.dir !== this.direction) return;
        const record = this.outgoing.get(message.fileId);
        if (record && record.status !== 'cancelled') {
          record.status = message.ok ? 'confirmed' : 'failed';
          record.rate = 0;
          if (message.ok) record.note = 'Received and written on the other device.';
          else record.error = message.error ?? 'The receiving device reported a problem.';
        }
        const resolve = this.confirmations.get(message.fileId);
        this.confirmations.delete(message.fileId);
        resolve?.(message.ok, message.error);
        this.emit(true);
        break;
      }
      case 'cancel': {
        if (message.dir !== this.direction) {
          void this.cancelIncomingRemote(message.fileId, message.reason);
          return;
        }
        const record = this.outgoing.get(message.fileId);
        if (record && (record.status === 'sending' || record.status === 'awaiting-accept')) {
          this.cancelledIds.add(record.id);
          record.status = 'cancelled';
          record.note = 'Cancelled by the receiving device.';
          this.resolveDecision(message.fileId, 'declined');
          this.emit(true);
        }
        break;
      }
      case 'all-done': {
        if (message.dir === this.direction) return;
        this.pushNotice(
          'info',
          message.failed > 0
            ? `The other device finished its queue: ${message.sent} sent, ${message.failed} not sent.`
            : `The other device finished sending ${message.sent} file${message.sent === 1 ? '' : 's'}.`,
          8000,
        );
        break;
      }
      default:
        break;
    }
  }

  private resolveDecision(fileId: string, decision: Decision): void {
    const resolve = this.decisions.get(fileId);
    if (!resolve) return;
    this.decisions.delete(fileId);
    resolve(decision);
  }

  private waitForDecision(fileId: string, timeoutMs: number): Promise<Decision> {
    return new Promise<Decision>((resolve) => {
      this.decisions.set(fileId, resolve);
      window.setTimeout(() => {
        if (this.decisions.has(fileId)) {
          this.decisions.delete(fileId);
          resolve('timeout');
        }
      }, timeoutMs);
    });
  }

  private waitForConfirmation(fileId: string, timeoutMs: number): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      this.confirmations.set(fileId, (ok, error) => resolve({ ok, error }));
      window.setTimeout(() => {
        if (this.confirmations.has(fileId)) {
          this.confirmations.delete(fileId);
          resolve({ ok: true });
        }
      }, timeoutMs);
    });
  }

  // ------------------------------------------------------------------ sending

  enqueue(files: File[]): { added: number; rejected: string[] } {
    const maxFiles = this.config?.maxFilesPerSession ?? 50;
    const maxBytes = this.config?.maxFileBytes ?? 1024 ** 3;
    const rejected: string[] = [];
    let added = 0;

    for (const file of files) {
      if (this.outgoingOrder.length >= maxFiles) {
        rejected.push(`${file.name} (session limit is ${maxFiles} files)`);
        continue;
      }
      if (file.size > maxBytes) {
        rejected.push(`${file.name} (over the ${formatBytes(maxBytes)} limit)`);
        continue;
      }
      if (file.size === 0) {
        rejected.push(`${file.name} (empty file)`);
        continue;
      }
      const id = randomId('out');
      this.outgoing.set(id, {
        id,
        index: this.nextOutIndex++,
        file,
        name: file.name,
        size: file.size,
        type: file.type || 'application/octet-stream',
        status: 'queued',
        sent: 0,
        rate: 0,
        sampleAt: 0,
        sampleBytes: 0,
      });
      this.outgoingOrder.push(id);
      added += 1;
    }

    if (rejected.length > 0) this.pushNotice('warn', `Not queued: ${rejected.join(', ')}.`);
    this.emit(true);
    return { added, rejected };
  }

  removeQueued(id: string): void {
    const record = this.outgoing.get(id);
    if (!record || record.status !== 'queued') return;
    this.cancelledIds.delete(id);
    this.outgoing.delete(id);
    this.outgoingOrder = this.outgoingOrder.filter((entry) => entry !== id);
    this.emit(true);
  }

  cancelOutgoing(id: string): void {
    const record = this.outgoing.get(id);
    if (!record) return;
    if (record.status === 'queued') {
      this.removeQueued(id);
      return;
    }
    if (record.status === 'sending' || record.status === 'awaiting-accept') {
      record.status = 'cancelled';
      record.note = 'Cancelled by you.';
      record.rate = 0;
      this.sendControl({ v: 1, t: 'cancel', dir: this.direction, fileId: id, reason: 'user' });
      this.resolveDecision(id, 'declined');
      const confirm = this.confirmations.get(id);
      this.confirmations.delete(id);
      confirm?.(false, 'cancelled');
    }
    this.emit(true);
  }

  retryOutgoing(id: string): void {
    const record = this.outgoing.get(id);
    if (!record) return;
    const retryable: OutStatus[] = ['failed', 'skipped', 'cancelled', 'rate-limited', 'sent'];
    if (!retryable.includes(record.status)) return;
    this.cancelledIds.delete(id);
    record.status = 'queued';
    record.sent = 0;
    record.rate = 0;
    record.error = undefined;
    record.note = undefined;
    record.resumeAt = undefined;
    record.index = this.nextOutIndex++;
    this.emit(true);
    void this.processQueue();
  }

  clearFinished(): void {
    const keep: string[] = [];
    for (const id of this.outgoingOrder) {
      const record = this.outgoing.get(id);
      if (!record) continue;
      const done: OutStatus[] = ['confirmed', 'sent', 'skipped', 'cancelled', 'failed'];
      if (done.includes(record.status)) this.outgoing.delete(id);
      else keep.push(id);
    }
    this.outgoingOrder = keep;
    this.emit(true);
  }

  setAutoSave(value: boolean): void {
    this.autoSave = value;
    this.emit(true);
  }

  /** Start (or resume) processing the send queue. Safe to call repeatedly. */
  startQueue(): void {
    void this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.queueRunning) return;
    if (!this.channel || this.channel.readyState !== 'open') {
      const pending = this.outgoingOrder.some((id) => this.outgoing.get(id)?.status === 'queued');
      if (pending) this.pushNotice('warn', 'Files are queued and will send once the devices connect.', 6000);
      return;
    }

    this.queueRunning = true;
    let sent = 0;
    let failed = 0;

    try {
      for (const id of [...this.outgoingOrder]) {
        const record = this.outgoing.get(id);
        if (!record || record.status !== 'queued') continue;
        if (this.destroyed) break;
        if (!this.channel || this.channel.readyState !== 'open') {
          record.status = 'failed';
          record.error = 'The connection closed before this file could be sent.';
          failed += 1;
          break;
        }

        record.status = 'awaiting-accept';
        record.error = undefined;
        record.note = 'Waiting for the other device to accept this file.';
        this.emit(true);

        const budget = await this.declareTransfer('upload', record);
        if (budget === 'gone') {
          record.status = 'failed';
          record.error = 'The session expired.';
          failed += 1;
          break;
        }
        if (budget === 'limited' && !(await this.waitOutRateLimit(record))) {
          failed += 1;
          continue;
        }

        this.sendControl({
          v: 1,
          t: 'meta',
          dir: this.direction,
          fileId: record.id,
          index: record.index,
          count: this.outgoingOrder.length,
          name: record.name,
          size: record.size,
          type: record.type,
        });

        const decision = await this.waitForDecision(record.id, READY_TIMEOUT_MS);
        if (decision !== 'ready') {
          if (!this.cancelledIds.has(record.id)) {
            record.status = decision === 'declined' ? 'skipped' : 'failed';
            record.error = record.note ?? DECISION_TEXT[decision];
            record.note = undefined;
          }
          failed += 1;
          this.emit(true);
          continue;
        }

        record.status = 'sending';
        record.note = undefined;
        record.sampleAt = Date.now();
        record.sampleBytes = 0;
        this.emit(true);

        try {
          await this.streamFile(record);
          this.sendControl({
            v: 1,
            t: 'done',
            dir: this.direction,
            fileId: record.id,
            size: record.size,
          });
          record.status = 'sent';
          record.rate = 0;
          record.note = 'Waiting for the other device to finish writing.';
          sent += 1;
          this.emit(true);

          const confirmation = await this.waitForConfirmation(record.id, READY_TIMEOUT_MS);
          if (record.status === 'sent') {
            record.status = confirmation.ok ? 'confirmed' : 'failed';
            if (!confirmation.ok && confirmation.error !== 'cancelled') {
              record.error = confirmation.error ?? 'The receiving device reported a problem.';
            }
          }
        } catch (error) {
          if (!this.cancelledIds.has(record.id)) {
            record.status = 'failed';
            record.error = describeError(error);
            this.sendControl({
              v: 1,
              t: 'cancel',
              dir: this.direction,
              fileId: record.id,
              reason: 'send-error',
            });
          }
          record.rate = 0;
          failed += 1;
        }
        this.emit(true);
      }
    } finally {
      this.queueRunning = false;
      if (sent > 0 || failed > 0) {
        this.sendControl({ v: 1, t: 'all-done', dir: this.direction, sent, failed });
      }
      this.emit(true);
    }
  }

  private async streamFile(record: OutgoingRecord): Promise<void> {
    const file = record.file;
    let offset = 0;

    while (offset < file.size) {
      if (this.cancelledIds.has(record.id)) throw new Error('Cancelled.');
      const channel = this.channel;
      if (!channel || channel.readyState !== 'open') {
        throw new Error('The connection closed mid-transfer.');
      }
      if (channel.bufferedAmount > BUFFER_HIGH_WATER) {
        await this.waitForBufferDrain(channel);
        continue;
      }

      const end = Math.min(offset + CHUNK_SIZE, file.size);
      const chunk = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      channel.send(encodeFrame(this.direction, record.index, chunk));
      offset += chunk.byteLength;
      record.sent = offset;
      this.sampleRate(record);
      this.emit();
    }
  }

  private waitForBufferDrain(channel: RTCDataChannel): Promise<void> {
    return new Promise<void>((resolve) => {
      const onLow = () => {
        channel.removeEventListener('bufferedamountlow', onLow);
        window.clearTimeout(timer);
        resolve();
      };
      channel.addEventListener('bufferedamountlow', onLow);
      // Safety net in case the event is missed.
      const timer = window.setTimeout(() => {
        channel.removeEventListener('bufferedamountlow', onLow);
        resolve();
      }, 5000);
    });
  }

  /**
   * Tell the server a transfer is starting so the per-IP budget is consumed.
   * Returns 'ok', 'limited' or 'gone'.
   */
  private async declareTransfer(
    direction: 'upload' | 'download',
    record: { name: string; size: number },
  ): Promise<'ok' | 'limited' | 'gone'> {
    if (!this.code || !this.peerId) return 'gone';
    try {
      const result = await api<TransferResponse>(`/api/rooms/${this.code}/transfers`, {
        method: 'POST',
        body: JSON.stringify({
          peerId: this.peerId,
          direction,
          fileName: record.name,
          fileSize: record.size,
        }),
      });
      this.budgets[direction] = {
        limit: result.limit,
        remaining: result.remaining,
        resetAt: result.resetAt,
        windowSeconds: result.windowSeconds,
      };
      this.emit(true);
      return 'ok';
    } catch (error) {
      if (error instanceof ApiError && error.isRateLimited) {
        const retryAfter = error.retryAfterSeconds || 60;
        this.budgets[direction] = {
          limit: 0,
          remaining: 0,
          resetAt: Date.now() + retryAfter * 1000,
          windowSeconds: retryAfter,
        };
        this.emit(true);
        return 'limited';
      }
      if (error instanceof ApiError && error.isGone) {
        this.teardown(error.message);
        return 'gone';
      }
      this.pushNotice(
        'warn',
        `Could not reach the server to record this ${direction}. Continuing, since the bytes go device-to-device anyway.`,
        6000,
      );
      return 'ok';
    }
  }

  private async waitOutRateLimit(record: OutgoingRecord): Promise<boolean> {
    const resetAt = this.budgets.upload?.resetAt ?? Date.now() + 60_000;
    const waitMs = Math.max(1000, resetAt - Date.now());
    const sessionLeft = this.room ? this.room.expiresAt - Date.now() : 0;

    record.status = 'rate-limited';
    record.resumeAt = resetAt;
    record.note = `Send limit reached. Retrying in ${Math.ceil(waitMs / 1000)}s.`;
    this.pushNotice(
      'warn',
      `Server send limit reached. The queue pauses for ${Math.ceil(waitMs / 1000)}s and then retries.`,
      Math.min(waitMs, 15000),
    );
    this.emit(true);

    if (sessionLeft > 0 && waitMs > sessionLeft) {
      record.status = 'failed';
      record.error = 'Send limit reached, and this session expires before the limit resets.';
      record.note = undefined;
      this.emit(true);
      return false;
    }

    await this.sleepInterruptible(waitMs);
    if (this.destroyed || this.phase === 'closed') return false;

    record.status = 'awaiting-accept';
    record.note = 'Waiting for the other device to accept this file.';
    const retry = await this.declareTransfer('upload', record);
    if (retry === 'ok') return true;
    if (retry === 'gone') return false;
    record.status = 'rate-limited';
    record.error = 'Still rate limited after waiting. Try again later or start a new session.';
    record.note = undefined;
    this.emit(true);
    return false;
  }

  private async sleepInterruptible(ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !this.destroyed) {
      await sleep(Math.min(250, deadline - Date.now()));
    }
  }

  // ---------------------------------------------------------------- receiving

  private async announceIncoming(message: Extract<ControlMessage, { t: 'meta' }>): Promise<void> {
    const record: IncomingRecord = {
      id: message.fileId,
      index: message.index,
      name: message.name,
      size: message.size,
      type: message.type || 'application/octet-stream',
      status: 'awaiting-save',
      received: 0,
      rate: 0,
      mode: null,
      parts: [],
      writable: null,
      writeChain: Promise.resolve(),
      sampleAt: Date.now(),
      sampleBytes: 0,
    };
    this.incoming.set(record.id, record);
    this.incomingByIndex.set(record.index, record.id);
    this.pushNotice('info', `Incoming: ${record.name} (${formatBytes(record.size)}).`, 5000);
    this.emit(true);

    if (this.autoSave) await this.acceptInMemory(record.id);
  }

  /** Buffer in memory and hand the browser a download when complete. */
  async acceptInMemory(id: string): Promise<void> {
    const record = this.incoming.get(id);
    if (!record || record.status !== 'awaiting-save') return;

    const budget = await this.declareTransfer('download', record);
    if (budget === 'gone') return;
    if (budget === 'limited') {
      await this.decline(id, 'rate-limited');
      const resetAt = this.budgets.download?.resetAt ?? Date.now() + 60_000;
      const seconds = Math.max(1, Math.round((resetAt - Date.now()) / 1000));
      record.error = `Receive limit reached. Limit resets in ${seconds}s.`;
      this.pushNotice('warn', record.error, 12000);
      this.emit(true);
      return;
    }

    record.mode = 'memory';
    record.status = 'receiving';
    this.sendControl({
      v: 1,
      t: 'ready',
      dir: this.peerDirection(),
      fileId: id,
      mode: 'memory',
    });
    this.emit(true);
  }

  /** Stream straight to disk via the File System Access API (Chromium). */
  async saveToDisk(id: string): Promise<void> {
    const record = this.incoming.get(id);
    if (!record || record.status !== 'awaiting-save') return;
    if (!supportsStreamToDisk() || !window.showSaveFilePicker) {
      await this.acceptInMemory(id);
      return;
    }

    const budget = await this.declareTransfer('download', record);
    if (budget === 'gone') return;
    if (budget === 'limited') {
      await this.decline(id, 'rate-limited');
      record.error = 'Receive limit reached, so the file was declined.';
      this.pushNotice('warn', record.error, 12000);
      this.emit(true);
      return;
    }

    try {
      const handle = await window.showSaveFilePicker({ suggestedName: record.name });
      record.writable = await handle.createWritable();
      record.savedName = handle.name;
      record.mode = 'stream';
      record.status = 'receiving';
      this.sendControl({
        v: 1,
        t: 'ready',
        dir: this.peerDirection(),
        fileId: id,
        mode: 'stream',
      });
      this.emit(true);
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') {
        this.pushNotice('info', 'Save location dismissed. The other device is still waiting.', 6000);
        return;
      }
      record.status = 'failed';
      record.error = describeError(error);
      this.emit(true);
      await this.decline(id, 'save-failed');
    }
  }

  async decline(id: string, reason: string): Promise<void> {
    const record = this.incoming.get(id);
    if (!record) return;
    this.sendControl({ v: 1, t: 'decline', dir: this.peerDirection(), fileId: id, reason });
    record.status = 'declined';
    record.parts = [];
    record.rate = 0;
    await this.closeWritable(record);
    this.emit(true);
  }

  async cancelIncoming(id: string): Promise<void> {
    const record = this.incoming.get(id);
    if (!record) return;
    this.sendControl({ v: 1, t: 'cancel', dir: this.peerDirection(), fileId: id, reason: 'user' });
    await this.abortIncoming(record, 'Cancelled by you.');
  }

  private async cancelIncomingRemote(id: string, reason: string): Promise<void> {
    const record = this.incoming.get(id);
    if (!record) return;
    await this.abortIncoming(record, reason === 'user' ? 'Cancelled by the sender.' : 'Stopped by the sender.');
  }

  private async abortIncoming(record: IncomingRecord, message: string): Promise<void> {
    record.status = 'cancelled';
    record.error = message;
    record.parts = [];
    record.rate = 0;
    await this.closeWritable(record);
    this.emit(true);
  }

  private async writeChunk(record: IncomingRecord, payload: ByteChunk): Promise<void> {
    if (record.status === 'cancelled' || record.status === 'declined' || record.status === 'complete') {
      return;
    }
    record.received += payload.byteLength;
    this.sampleRate(record);

    if (record.writable) {
      const writable = record.writable;
      record.writeChain = record.writeChain
        .then(() => writable.write(payload))
        .catch(() => undefined);
    } else {
      record.parts.push(payload);
    }
    this.emit();
  }

  private async finishIncoming(fileId: string): Promise<void> {
    const record = this.incoming.get(fileId);
    if (!record || record.status === 'complete') return;

    try {
      await record.writeChain;
      if (record.writable) {
        await record.writable.close();
        record.writable = null;
      } else {
        const blob = new Blob(record.parts, { type: record.type });
        record.parts = [];
        record.url = URL.createObjectURL(blob);
        triggerDownload(record.url, record.name);
      }
      const ok = record.received === record.size;
      record.status = ok ? 'complete' : 'failed';
      record.rate = 0;
      if (!ok) record.error = `Size mismatch: received ${record.received} of ${record.size} bytes.`;
      this.sendControl({
        v: 1,
        t: 'received',
        dir: this.peerDirection(),
        fileId,
        size: record.received,
        ok,
        error: ok ? undefined : record.error,
      });
    } catch (error) {
      record.status = 'failed';
      record.error = describeError(error);
      record.rate = 0;
      await this.closeWritable(record);
      this.sendControl({
        v: 1,
        t: 'received',
        dir: this.peerDirection(),
        fileId,
        size: record.received,
        ok: false,
        error: describeError(error),
      });
    }
    this.emit(true);
  }

  private async closeWritable(record: IncomingRecord): Promise<void> {
    if (!record.writable) return;
    const writable = record.writable;
    record.writable = null;
    try {
      await record.writeChain;
      await writable.close();
    } catch {
      try {
        await writable.abort();
      } catch {
        /* ignore */
      }
    }
  }

  private abortTransfers(reason: string): void {
    for (const record of this.outgoing.values()) {
      if (record.status === 'sending' || record.status === 'awaiting-accept') {
        record.status = 'failed';
        record.error = reason;
        record.rate = 0;
        this.resolveDecision(record.id, 'closed');
      }
    }
    for (const record of this.incoming.values()) {
      if (record.status === 'receiving' || record.status === 'awaiting-save') {
        record.status = 'failed';
        record.error = reason;
        record.parts = [];
        record.rate = 0;
        void this.closeWritable(record);
      }
    }
    this.emit(true);
  }

  private sampleRate(record: OutgoingRecord | IncomingRecord): void {
    const now = Date.now();
    const elapsed = now - record.sampleAt;
    if (elapsed < RATE_SAMPLE_MS) return;
    const total = 'sent' in record ? record.sent : record.received;
    const delta = total - record.sampleBytes;
    record.rate = Math.max(0, Math.round((delta * 1000) / elapsed));
    record.sampleAt = now;
    record.sampleBytes = total;
  }

  // -------------------------------------------------------------------- state

  private setPhase(phase: SessionPhase, detail: string | null = null): void {
    this.phase = phase;
    this.statusDetail = detail;
    this.emit(true);
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.emit(true);
  }

  private fail(error: unknown, fallback: string): void {
    if (error instanceof ApiError) {
      if (error.isRateLimited) {
        this.setPhase('failed', `${fallback} ${error.message}`.trim());
        this.pushNotice('warn', `Rate limited: ${error.message}`, 15000);
        return;
      }
      this.setPhase('failed', `${fallback} ${error.message}`.trim());
      this.pushNotice('error', error.message);
      return;
    }
    this.setPhase('failed', `${fallback} ${describeError(error)}`.trim());
    this.pushNotice('error', describeError(error));
  }

  private teardown(reason: string): void {
    this.pollGeneration += 1;
    this.clearConnectTimer();
    this.closePeerConnection();
    this.abortTransfers(reason || 'The session ended.');
    for (const [id, resolve] of [...this.decisions]) {
      this.decisions.delete(id);
      resolve('closed');
    }
    if (reason) this.phase = 'closed';
    this.statusDetail = reason || null;
    this.queueRunning = false;
    this.emit(true);
  }

  private pushNotice(level: Notice['level'], text: string, ttlMs = 0): void {
    const existing = this.notices.find((notice) => notice.text === text);
    if (existing) return;
    const notice: Notice = { id: randomId('n'), level, text, at: Date.now() };
    this.notices = [...this.notices, notice].slice(-6);
    this.emit(true);
    if (ttlMs > 0) window.setTimeout(() => this.dismissNotice(notice.id), ttlMs);
  }

  dismissNotice(id: string): void {
    this.notices = this.notices.filter((notice) => notice.id !== id);
    this.emit(true);
  }

  clearNotices(): void {
    this.notices = [];
    this.emit(true);
  }

  private emit(force = false): void {
    if (this.destroyed) return;
    const now = Date.now();
    if (!force && now - this.lastEmit < EMIT_THROTTLE_MS) {
      if (this.emitScheduled) return;
      this.emitScheduled = true;
      window.setTimeout(() => {
        this.emitScheduled = false;
        this.emit();
      }, EMIT_THROTTLE_MS);
      return;
    }
    this.lastEmit = now;
    this.handlers.onSnapshot(this.snapshot());
  }

  private snapshot(): SessionSnapshot {
    const outgoing: OutgoingFileView[] = this.outgoingOrder
      .map((id) => this.outgoing.get(id))
      .filter((record): record is OutgoingRecord => Boolean(record))
      .map((record) => ({
        id: record.id,
        index: record.index,
        name: record.name,
        size: record.size,
        type: record.type,
        status: record.status,
        sent: record.sent,
        rate: record.rate,
        error: record.error,
        note: record.note,
        resumeAt: record.resumeAt,
      }));

    const incoming: IncomingFileView[] = [...this.incoming.values()]
      .sort((a, b) => a.index - b.index)
      .map((record) => ({
        id: record.id,
        index: record.index,
        name: record.name,
        size: record.size,
        type: record.type,
        status: record.status,
        received: record.received,
        rate: record.rate,
        mode: record.mode,
        error: record.error,
        url: record.url,
        savedName: record.savedName,
      }));

    return {
      phase: this.phase,
      role: this.role,
      code: this.code,
      link:
        this.code && typeof window !== 'undefined'
          ? `${window.location.origin}/?r=${this.code}`
          : null,
      peerId: this.peerId,
      selfName: this.selfName,
      peerName: this.peerName,
      expiresAt: this.room?.expiresAt ?? null,
      statusText: STATUS_TEXT[this.phase],
      statusDetail: this.statusDetail,
      outgoing,
      incoming,
      notices: [...this.notices],
      budgets: {
        upload: this.budgets.upload ? { ...this.budgets.upload } : null,
        download: this.budgets.download ? { ...this.budgets.download } : null,
      },
      queueRunning: this.queueRunning,
      autoSave: this.autoSave,
      canStreamToDisk: supportsStreamToDisk(),
      connectionType: this.connectionType,
      busy: this.busy,
    };
  }
}
