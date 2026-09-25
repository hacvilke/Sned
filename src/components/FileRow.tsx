"use client";

import { formatBytes } from "@/lib/format";

export type JobStatus =
  | "queued"
  | "preparing"
  | "uploading"
  | "finishing"
  | "done"
  | "failed"
  | "cancelled";

export const SETTLED: JobStatus[] = ["done", "failed", "cancelled"];

const LABEL: Record<JobStatus, string> = {
  queued: "Queued",
  preparing: "Preparing",
  uploading: "Uploading",
  finishing: "Verifying",
  done: "Sent",
  failed: "Failed",
  cancelled: "Cancelled",
};

const TONE: Record<JobStatus, string> = {
  queued: "text-muted",
  preparing: "text-muted",
  uploading: "text-brand",
  finishing: "text-brand",
  done: "text-ok",
  failed: "text-bad",
  cancelled: "text-faint",
};

export function FileRow({
  name,
  path,
  size,
  status,
  progress,
  error,
  onCancel,
}: {
  name: string;
  path: string;
  size: number;
  status: JobStatus;
  progress: number;
  error?: string;
  onCancel: () => void;
}) {
  const active = !SETTLED.includes(status);
  const showBar = status === "uploading" || status === "finishing";
  const percent = Math.round(Math.min(1, Math.max(0, progress)) * 100);

  return (
    <li className="px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-ink" title={name}>
            {name}
          </p>
          {path && path !== name ? (
            <p className="truncate text-[11px] text-faint" title={path}>
              {path}
            </p>
          ) : null}
          <p className={`mt-0.5 text-[11px] ${TONE[status]}`}>
            {LABEL[status]}
            {showBar ? ` · ${percent}%` : ""}
            <span className="text-faint"> · {formatBytes(size)}</span>
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {status === "done" ? <Tick /> : null}
          {status === "failed" ? <Cross /> : null}
          {active ? (
            <button
              type="button"
              onClick={onCancel}
              className="rounded border border-line px-2 py-1 text-[11px] text-muted hover:border-line-strong hover:text-ink"
            >
              Cancel
            </button>
          ) : null}
        </div>
      </div>

      {showBar ? (
        <div
          className="progress-track mt-2 h-1 w-full overflow-hidden rounded-sm"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Uploading ${name}`}
        >
          <div className="progress-fill h-full" style={{ width: `${percent}%` }} />
        </div>
      ) : null}

      {status === "failed" && error ? (
        <p className="mt-1.5 text-[11px] text-bad">{error}</p>
      ) : null}
    </li>
  );
}

function Tick() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className="text-ok">
      <path
        d="M13.3 4.3 6.4 11.2 2.7 7.5l1.1-1.1 2.6 2.6 5.8-5.8z"
        fill="currentColor"
      />
    </svg>
  );
}

function Cross() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className="text-bad">
      <path d="M12.7 4.4 11.6 3.3 8 6.9 4.4 3.3 3.3 4.4 6.9 8l-3.6 3.6 1.1 1.1L8 9.1l3.6 3.6 1.1-1.1L9.1 8z" fill="currentColor" />
    </svg>
  );
}
