/**
 * Central application configuration.
 *
 * Everything here is driven by environment variables so the same build runs
 * locally, in preview, and on Vercel. See `.env.example` and README.md.
 */

export type StoreKind = 'redis' | 'blob' | 'memory';

export type BucketId =
  | 'rooms'
  | 'join'
  | 'signalWrite'
  | 'signalRead'
  | 'upload'
  | 'download'
  | 'close'
  | 'config';

export interface RateLimitRule {
  /** Maximum number of requests inside the window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

export type RateLimitPreset = 'strict' | 'balanced' | 'relaxed';

/** Rate limit presets. `balanced` is the default. */
const PRESETS: Record<RateLimitPreset, Record<BucketId, RateLimitRule>> = {
  strict: {
    rooms: { limit: 2, windowSeconds: 3600 },
    join: { limit: 8, windowSeconds: 3600 },
    signalWrite: { limit: 150, windowSeconds: 3600 },
    signalRead: { limit: 2700, windowSeconds: 3600 },
    upload: { limit: 8, windowSeconds: 3600 },
    download: { limit: 20, windowSeconds: 3600 },
    close: { limit: 8, windowSeconds: 3600 },
    config: { limit: 60, windowSeconds: 3600 },
  },
  balanced: {
    rooms: { limit: 5, windowSeconds: 3600 },
    join: { limit: 20, windowSeconds: 3600 },
    signalWrite: { limit: 300, windowSeconds: 3600 },
    signalRead: { limit: 5400, windowSeconds: 3600 },
    upload: { limit: 20, windowSeconds: 3600 },
    download: { limit: 60, windowSeconds: 3600 },
    close: { limit: 20, windowSeconds: 3600 },
    config: { limit: 120, windowSeconds: 3600 },
  },
  relaxed: {
    rooms: { limit: 20, windowSeconds: 3600 },
    join: { limit: 60, windowSeconds: 3600 },
    signalWrite: { limit: 900, windowSeconds: 3600 },
    signalRead: { limit: 10800, windowSeconds: 3600 },
    upload: { limit: 100, windowSeconds: 3600 },
    download: { limit: 300, windowSeconds: 3600 },
    close: { limit: 60, windowSeconds: 3600 },
    config: { limit: 300, windowSeconds: 3600 },
  },
};

/** Human readable description of each bucket, surfaced in the UI. */
export const BUCKET_LABELS: Record<BucketId, string> = {
  rooms: 'New sessions',
  join: 'Session joins',
  signalWrite: 'Signalling writes',
  signalRead: 'Signalling reads',
  upload: 'Files sent',
  download: 'Files received',
  close: 'Sessions closed',
  config: 'Configuration lookups',
};

export interface AppConfig {
  storeKind: StoreKind;
  /** False when falling back to the in-process memory store (development only). */
  storeConfigured: boolean;
  production: boolean;
  rateLimitBackend: 'redis' | 'memory';
  preset: RateLimitPreset;
  rules: Record<BucketId, RateLimitRule>;
  roomTtlSeconds: number;
  maxFileBytes: number;
  maxFilesPerSession: number;
  /** STUN/TURN servers handed to the browser. */
  iceServers: IceServer[];
  /** True when a TURN relay is configured (needed for some symmetric NATs). */
  hasTurn: boolean;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function byteEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i.exec(raw.trim());
  if (!match) return fallback;
  const value = Number.parseFloat(match[1]);
  const unit = (match[2] ?? 'b').toLowerCase();
  const factor = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }[unit] ?? 1;
  const result = Math.round(value * factor);
  return Number.isFinite(result) && result > 0 ? result : fallback;
}

function presetEnv(): RateLimitPreset {
  const raw = (process.env.RATE_LIMIT_PRESET ?? '').trim().toLowerCase();
  return raw === 'strict' || raw === 'relaxed' ? raw : 'balanced';
}

function resolveRules(): { preset: RateLimitPreset; rules: Record<BucketId, RateLimitRule> } {
  const preset = presetEnv();
  const rules: Record<BucketId, RateLimitRule> = {} as Record<BucketId, RateLimitRule>;
  for (const [key, base] of Object.entries(PRESETS[preset]) as [BucketId, RateLimitRule][]) {
    const override = process.env[`RATE_LIMIT_${key.toUpperCase()}`];
    const limit = override ? intEnv(`RATE_LIMIT_${key.toUpperCase()}`, base.limit) : base.limit;
    const windowSeconds = intEnv(
      `RATE_LIMIT_${key.toUpperCase()}_WINDOW`,
      base.windowSeconds,
    );
    rules[key] = { limit, windowSeconds };
  }
  return { preset, rules };
}

function redisConfigured(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

function blobConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

export function getStoreKind(): StoreKind {
  const forced = (process.env.SIGNAL_STORE ?? '').trim().toLowerCase();
  if (forced === 'memory') return 'memory';
  if (forced === 'redis' && redisConfigured()) return 'redis';
  if (forced === 'blob' && blobConfigured()) return 'blob';
  if (redisConfigured()) return 'redis';
  if (blobConfigured()) return 'blob';
  return 'memory';
}

function resolveIceServers(): IceServer[] {
  const servers: IceServer[] = [];
  const stun = (process.env.STUN_URL ?? 'stun:stun.l.google.com:19302')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (stun.length > 0) servers.push({ urls: stun });

  const turnUrls = (process.env.TURN_URL ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (turnUrls.length > 0) {
    servers.push({
      urls: turnUrls,
      username: process.env.TURN_USERNAME ?? undefined,
      credential: process.env.TURN_CREDENTIAL ?? undefined,
    });
  }
  return servers;
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached) return cached;
  const storeKind = getStoreKind();
  const { preset, rules } = resolveRules();
  const iceServers = resolveIceServers();

  cached = {
    storeKind,
    storeConfigured: storeKind !== 'memory',
    production: process.env.NODE_ENV === 'production' || process.env.VERCEL === '1',
    rateLimitBackend: redisConfigured() ? 'redis' : 'memory',
    preset,
    rules,
    roomTtlSeconds: intEnv('ROOM_TTL_SECONDS', 3600),
    maxFileBytes: byteEnv('MAX_FILE_BYTES', 1024 ** 3),
    maxFilesPerSession: intEnv('MAX_FILES_PER_SESSION', 50),
    iceServers,
    hasTurn: iceServers.some((server) => String(server.urls).includes('turn')),
  };
  return cached;
}

/** Configuration safe to send to a browser (never includes TURN credentials). */
export function getPublicConfig(withTurn = false) {
  const config = getConfig();
  const iceServers = config.iceServers.map((server) => {
    const isTurn = String(server.urls).includes('turn');
    if (isTurn && !withTurn) {
      return { urls: server.urls };
    }
    return server;
  });

  return {
    store: config.storeKind,
    storeConfigured: config.storeConfigured,
    production: config.production,
    vercel: process.env.VERCEL === '1',
    rateLimitPreset: config.preset,
    rateLimitBackend: config.rateLimitBackend,
    roomTtlSeconds: config.roomTtlSeconds,
    maxFileBytes: config.maxFileBytes,
    maxFilesPerSession: config.maxFilesPerSession,
    hasTurn: config.hasTurn,
    iceServers: iceServers.filter((server) => {
      // Without credentials a TURN entry is useless to the client, so drop it.
      if (!String(server.urls).includes('turn')) return true;
      return withTurn && Boolean(server.username && server.credential);
    }),
    limits: Object.entries(config.rules).map(([bucket, rule]) => ({
      bucket,
      label: BUCKET_LABELS[bucket as BucketId],
      limit: rule.limit,
      windowSeconds: rule.windowSeconds,
    })),
  };
}

export type PublicConfig = ReturnType<typeof getPublicConfig>;
