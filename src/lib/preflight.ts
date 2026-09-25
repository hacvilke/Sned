/**
 * Pure validation of a prospective queue against the deployment's limits.
 * Kept free of DOM types so it can be unit tested in plain node.
 */

export type FileLike = { name: string; size: number };

export type QueueTotals = { count: number; bytes: number };

export type PreflightLimits = {
  maxFileBytes: number;
  maxBatchBytes: number;
  maxFilesPerBatch: number;
  /** Effective per-file cap: tightened when there is no Blob store. */
  effectiveMaxFileBytes: number;
  localOnly: boolean;
};

export type PreflightOutcome<T> = {
  accepted: T[];
  rejected: { name: string; reason: string }[];
};

export function preflight<T extends FileLike>(
  entries: T[],
  limits: PreflightLimits,
  totals: QueueTotals,
): PreflightOutcome<T> {
  const accepted: T[] = [];
  const rejected: { name: string; reason: string }[] = [];

  let count = totals.count;
  let bytes = totals.bytes;

  for (const entry of entries) {
    if (entry.size <= 0) {
      rejected.push({ name: entry.name, reason: "This file is empty." });
      continue;
    }
    if (entry.size > limits.effectiveMaxFileBytes) {
      rejected.push({
        name: entry.name,
        reason: limits.localOnly
          ? `Larger than the ${formatMb(limits.effectiveMaxFileBytes)} local-storage cap.`
          : `Larger than the ${formatMb(limits.effectiveMaxFileBytes)} per-file limit.`,
      });
      continue;
    }
    if (count >= limits.maxFilesPerBatch) {
      rejected.push({ name: entry.name, reason: `Batch is full (${limits.maxFilesPerBatch} files).` });
      continue;
    }
    if (bytes + entry.size > limits.maxBatchBytes) {
      rejected.push({
        name: entry.name,
        reason: `Would exceed the ${formatMb(limits.maxBatchBytes)} batch limit.`,
      });
      continue;
    }
    accepted.push(entry);
    count += 1;
    bytes += entry.size;
  }

  return { accepted, rejected };
}

function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}
