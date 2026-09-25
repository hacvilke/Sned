/**
 * Every tunable limit in the app lives here, with an env override.
 * Keep this file free of side effects so it can be imported anywhere.
 */

const num = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export const LIMITS = {
  /** Largest single file accepted. Vercel Blob allows 500 MB per file on Hobby. */
  maxFileBytes: num(process.env.MAX_FILE_BYTES, 250 * MiB),
  /** Largest combined size of one transfer batch. */
  maxBatchBytes: num(process.env.MAX_BATCH_BYTES, 1 * GiB),
  /** How many files one batch may contain. */
  maxFilesPerBatch: num(process.env.MAX_FILES_PER_BATCH, 50),

  /** Per-IP: transfer batches that may be created per minute. */
  batchesPerMinute: num(process.env.BATCHES_PER_MINUTE, 8),
  /** Per-IP: individual file uploads that may be started per minute. */
  uploadsPerMinute: num(process.env.UPLOADS_PER_MINUTE, 20),
  /** Per-IP: individual file uploads per rolling day. */
  uploadsPerDay: num(process.env.UPLOADS_PER_DAY, 300),
  /** Per-IP: total bytes that may be uploaded per rolling day. */
  bytesPerDay: num(process.env.BYTES_PER_DAY, 5 * GiB),
  /** Per-IP: download redirects per minute. */
  downloadsPerMinute: num(process.env.DOWNLOADS_PER_MINUTE, 60),
  /** Per-IP: metadata reads of a share page per minute. */
  shareReadsPerMinute: num(process.env.SHARE_READS_PER_MINUTE, 120),

  /** How long a transfer stays reachable. */
  ttlHours: num(process.env.TTL_HOURS, 24),
  /** Lifetime of a browser->Blob direct-upload token, in seconds. */
  uploadTokenSeconds: num(process.env.UPLOAD_TOKEN_SECONDS, 60 * 30),
  /** Largest file the in-process dev store will accept (no Blob token configured). */
  maxDevFileBytes: num(process.env.MAX_DEV_FILE_BYTES, 25 * MiB),
} as const;

export const CONCURRENCY = num(process.env.UPLOAD_CONCURRENCY, 2);

export const CODE_LENGTH = num(process.env.CODE_LENGTH, 6);

export const hasBlob = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
export const hasRedis = Boolean(
  (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) ||
    process.env.KV_REST_API_URL,
);

/** The public subset of the limits, safe to ship to the browser. */
export const publicLimits = {
  maxFileBytes: LIMITS.maxFileBytes,
  maxBatchBytes: LIMITS.maxBatchBytes,
  maxFilesPerBatch: LIMITS.maxFilesPerBatch,
  ttlHours: LIMITS.ttlHours,
  concurrency: CONCURRENCY,
  codeLength: CODE_LENGTH,
  storageMode: (hasBlob ? "blob" : "memory") as "blob" | "memory",
  maxDevFileBytes: LIMITS.maxDevFileBytes,
};

export type PublicLimits = typeof publicLimits;
