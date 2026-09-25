"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// `put` (not `upload`) is the client call that takes a pre-issued client token.
// `upload` instead wants a handleUploadUrl route, which we deliberately avoid:
// our /api/upload/start already does the auth, limits and rate limiting.
import { put } from "@vercel/blob/client";
import { formatBytes } from "@/lib/format";
import { preflight, type PreflightLimits } from "@/lib/preflight";
import type { DroppedFile } from "@/lib/dropfiles";
import type { PublicLimits } from "@/lib/limits";
import { DropZone } from "./DropZone";
import { FileRow, SETTLED, type JobStatus } from "./FileRow";
import { ShareLinkCard } from "./ShareLinkCard";

type Job = {
  key: string;
  file: File;
  path: string;
  status: JobStatus;
  progress: number;
  error?: string;
};

type Batch = { code: string; expiresAt: number };

/** Above this size the Blob client switches to multipart, which survives flaky links. */
const MULTIPART_THRESHOLD = 5 * 1024 * 1024;

export function TransferPanel({ limits }: { limits: PublicLimits }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [notice, setNotice] = useState<{ kind: "bad" | "warn"; text: string } | null>(null);

  const jobsRef = useRef<Job[]>([]);
  const batchRef = useRef<Batch | null>(null);
  const runningRef = useRef(false);
  const pausedRef = useRef(false);
  /** The server told us to back off; pick up no new work until this passes. */
  const backoffUntilRef = useRef(0);
  const sealLockRef = useRef(false);
  const aborters = useRef<Map<string, () => void> | null>(null);
  if (!aborters.current) aborters.current = new Map();
  const cancelOf = aborters.current;

  const sync = useCallback(() => setJobs([...jobsRef.current]), []);

  const patch = useCallback(
    (key: string, changes: Partial<Job>) => {
      const job = jobsRef.current.find((candidate) => candidate.key === key);
      if (!job) return;
      Object.assign(job, changes);
      sync();
    },
    [sync],
  );

  const localOnly = limits.storageMode === "memory";
  const effectiveMaxFileBytes = localOnly
    ? Math.min(limits.maxFileBytes, limits.maxDevFileBytes)
    : limits.maxFileBytes;

  const preflightLimits: PreflightLimits = useMemo(
    () => ({
      maxFileBytes: limits.maxFileBytes,
      maxBatchBytes: limits.maxBatchBytes,
      maxFilesPerBatch: limits.maxFilesPerBatch,
      effectiveMaxFileBytes,
      localOnly,
    }),
    [limits, effectiveMaxFileBytes, localOnly],
  );

  /** Bytes and slots already committed to the current batch. Cancelled jobs do not count. */
  const countLive = useCallback(
    () => jobsRef.current.filter((job) => job.status !== "cancelled"),
    [],
  );

  /* ------------------------------------------------------------------ */
  /* Execution                                                           */
  /* ------------------------------------------------------------------ */

  const ensureBatch = useCallback(async (): Promise<Batch> => {
    if (batchRef.current) return batchRef.current;
    const response = await fetch("/api/share", { method: "POST" });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new ApiError(
        data?.error ?? "Could not open a transfer.",
        response.status,
        data?.retryAfterSeconds,
      );
    }
    const created: Batch = { code: data.code, expiresAt: data.expiresAt };
    batchRef.current = created;
    setBatch(created);
    return created;
  }, []);

  /** Block while paused or inside a server-imposed backoff window. */
  const waitForGate = useCallback(async () => {
    for (;;) {
      if (pausedRef.current) throw new Cancelled();
      const backoff = backoffUntilRef.current - Date.now();
      if (backoff <= 0) return;
      await sleep(Math.min(backoff, 500));
    }
  }, []);

  const runJob = useCallback(
    async (job: Job, shareCode: string) => {
      const controller = new AbortController();
      const cancelKey = `${job.key}:abort`;
      cancelOf.set(cancelKey, () => controller.abort());

      try {
        patch(job.key, { status: "preparing", progress: 0, error: undefined });

        const started = await postJson("/api/upload/start", {
          shareCode,
          name: job.file.name,
          path: job.path,
          size: job.file.size,
          type: job.file.type || "application/octet-stream",
        });

        if (started.mode !== "blob") {
          // Local dev store: the endpoint buffers and attaches in one step.
          patch(job.key, { status: "uploading" });
          const response = await fetch("/api/upload/put", {
            method: "POST",
            headers: {
              "x-upload-id": started.uploadId,
              "content-type": job.file.type || "application/octet-stream",
            },
            body: job.file,
            signal: controller.signal,
          });
          if (!response.ok) throw await toApiError(response);
          patch(job.key, { status: "done", progress: 1 });
          return;
        }

        patch(job.key, { status: "uploading" });
        let lastPercent = -1;
        await put(started.pathname, job.file, {
          access: "public",
          token: started.clientToken,
          contentType: job.file.type || "application/octet-stream",
          multipart: job.file.size > MULTIPART_THRESHOLD,
          abortSignal: controller.signal,
          onUploadProgress: (event) => {
            const fraction =
              event.total > 0 ? event.loaded / event.total : (event.percentage ?? 0);
            // Re-render at most once per percentage point, not once per chunk.
            const percent = Math.floor(Math.min(1, Math.max(0, fraction)) * 100);
            if (percent === lastPercent) return;
            lastPercent = percent;
            patch(job.key, { progress: percent / 100 });
          },
        });

        // Server reads the object back from Blob and attaches it to the batch.
        patch(job.key, { status: "finishing", progress: 1 });
        await postJson("/api/upload/complete", { uploadId: started.uploadId });
        patch(job.key, { status: "done", progress: 1 });
      } catch (error) {
        if (error instanceof Cancelled || controller.signal.aborted) {
          patch(job.key, { status: "cancelled" });
        } else if (error instanceof ApiError) {
          patch(job.key, { status: "failed", error: error.message });
          if (error.status === 429 && error.retryAfterSeconds) {
            backoffUntilRef.current = Date.now() + error.retryAfterSeconds * 1000;
          }
        } else {
          patch(job.key, {
            status: "failed",
            error: error instanceof Error ? error.message : "Upload failed.",
          });
        }
      } finally {
        cancelOf.delete(cancelKey);
      }
    },
    [cancelOf, patch],
  );

  const worker = useCallback(
    async (shareCode: string) => {
      for (;;) {
        if (pausedRef.current) return;
        const next = jobsRef.current.find((job) => job.status === "queued");
        if (!next) return;
        try {
          await waitForGate();
        } catch {
          return;
        }
        await runJob(next, shareCode);
      }
    },
    [runJob, waitForGate],
  );

  const maybeSeal = useCallback(async () => {
    if (sealLockRef.current || !batchRef.current) return;
    const list = jobsRef.current;
    if (list.length === 0) return;
    if (!list.every((job) => SETTLED.includes(job.status))) return;
    if (!list.some((job) => job.status === "done")) return;
    sealLockRef.current = true;
    try {
      await fetch(`/api/share/${batchRef.current.code}/seal`, { method: "POST" });
    } catch {
      // Non-fatal: the download page falls back to polling while unsealed.
    } finally {
      sealLockRef.current = false;
    }
  }, []);

  const pump = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    try {
      const share = await ensureBatch();
      const lanes = Math.max(1, Math.min(limits.concurrency, 4));
      await Promise.all(Array.from({ length: lanes }, () => worker(share.code)));
    } catch (error) {
      const message =
        error instanceof ApiError ? error.message : "Could not open a transfer. Please retry.";
      setNotice({ kind: "bad", text: message });
      if (error instanceof ApiError && error.status === 429 && error.retryAfterSeconds) {
        backoffUntilRef.current = Date.now() + error.retryAfterSeconds * 1000;
      }
      for (const job of jobsRef.current) {
        if (job.status === "queued") Object.assign(job, { status: "failed", error: message });
      }
      sync();
    } finally {
      runningRef.current = false;
      setRunning(false);
      pausedRef.current = false;
      setPaused(false);
      void maybeSeal();
    }
  }, [ensureBatch, limits.concurrency, maybeSeal, sync, worker]);

  /* ------------------------------------------------------------------ */
  /* Intake                                                              */
  /* ------------------------------------------------------------------ */

  const enqueue = useCallback(
    (incoming: DroppedFile[]) => {
      if (incoming.length === 0) return;
      const live = countLive();
      const { accepted, rejected } = preflight(
        incoming.map((entry) => ({ ...entry, name: entry.file.name, size: entry.file.size })),
        preflightLimits,
        {
          count: live.length,
          bytes: live.reduce((sum, job) => sum + job.file.size, 0),
        },
      );

      setNotice(
        rejected.length === 0
          ? null
          : {
              kind: "warn",
              text:
                rejected.length === 1
                  ? `Skipped ${rejected[0].name}: ${rejected[0].reason}`
                  : `Skipped ${rejected.length} files. First: ${rejected[0].name} - ${rejected[0].reason}`,
            },
      );

      if (accepted.length === 0) return;

      jobsRef.current.push(
        ...accepted.map((entry) => ({
          key: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
          file: entry.file,
          path: entry.path,
          status: "queued" as JobStatus,
          progress: 0,
        })),
      );
      sync();
      void pump();
    },
    [countLive, preflightLimits, pump, sync],
  );

  /* ------------------------------------------------------------------ */
  /* Controls                                                            */
  /* ------------------------------------------------------------------ */

  const togglePause = () => {
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    if (!next) void pump();
  };

  const cancelAll = () => {
    pausedRef.current = true;
    setPaused(true);
    for (const cancel of cancelOf.values()) cancel();
    for (const job of jobsRef.current) {
      if (!SETTLED.includes(job.status)) Object.assign(job, { status: "cancelled" });
    }
    sync();
  };

  const retryFailed = () => {
    let touched = 0;
    for (const job of jobsRef.current) {
      if (job.status === "failed") {
        Object.assign(job, { status: "queued", progress: 0, error: undefined });
        touched += 1;
      }
    }
    if (touched === 0) return;
    pausedRef.current = false;
    setPaused(false);
    sync();
    void pump();
  };

  const clearFinished = () => {
    jobsRef.current = jobsRef.current.filter((job) => !SETTLED.includes(job.status));
    sync();
  };

  const resetAll = () => {
    cancelAll();
    jobsRef.current = [];
    batchRef.current = null;
    setBatch(null);
    setNotice(null);
    backoffUntilRef.current = 0;
    sync();
  };

  useEffect(
    () => () => {
      for (const cancel of cancelOf.values()) cancel();
    },
    [cancelOf],
  );

  /* ------------------------------------------------------------------ */
  /* Render                                                              */
  /* ------------------------------------------------------------------ */

  const doneCount = jobs.filter((job) => job.status === "done").length;
  const failedCount = jobs.filter((job) => job.status === "failed").length;
  const activeCount = jobs.filter((job) => !SETTLED.includes(job.status)).length;
  const queuedBytes = countLive().reduce((sum, job) => sum + job.file.size, 0);
  const bytesDone = jobs
    .filter((job) => job.status === "done")
    .reduce((sum, job) => sum + job.file.size, 0);

  return (
    <div className="space-y-5">
      <DropZone onFiles={enqueue} effectiveMaxFileBytes={effectiveMaxFileBytes} />

      {notice ? (
        <div
          role="status"
          className={`rounded border px-3 py-2 text-[13px] ${
            notice.kind === "bad"
              ? "border-bad/30 bg-bad-soft text-bad"
              : "border-warn/30 bg-warn-soft text-warn"
          }`}
        >
          {notice.text}
        </div>
      ) : null}

      {batch ? (
        <ShareLinkCard
          code={batch.code}
          expiresAt={batch.expiresAt}
          fileCount={jobs.length}
          doneCount={doneCount}
          activeCount={activeCount}
        />
      ) : null}

      {jobs.length > 0 ? (
        <section aria-label="Transfer queue" className="rounded border border-line bg-surface">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
            <p className="text-[13px]">
              <span className="font-semibold">
                {jobs.length} {jobs.length === 1 ? "file" : "files"}
              </span>
              <span className="text-muted">
                {" · "}
                {formatBytes(queuedBytes)} total
                {doneCount > 0 ? ` · ${formatBytes(bytesDone)} transferred` : ""}
                {failedCount > 0 ? ` · ${failedCount} failed` : ""}
                {paused && activeCount > 0 ? " · paused" : ""}
              </span>
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <ControlButton onClick={togglePause} disabled={activeCount === 0}>
                {paused ? "Resume" : "Pause"}
              </ControlButton>
              {failedCount > 0 ? (
                <ControlButton onClick={retryFailed} disabled={activeCount > 0}>
                  Retry failed
                </ControlButton>
              ) : null}
              <ControlButton onClick={clearFinished} disabled={activeCount > 0}>
                Clear finished
              </ControlButton>
              <ControlButton onClick={resetAll} tone="danger" disabled={activeCount === 0 && jobs.length === 0}>
                Cancel all
              </ControlButton>
            </div>
          </header>

          <ul className="divide-y divide-line">
            {jobs.map((job) => (
              <FileRow
                key={job.key}
                name={job.file.name}
                path={job.path}
                size={job.file.size}
                status={job.status}
                progress={job.progress}
                error={job.error}
                onCancel={() => {
                  cancelOf.get(`${job.key}:abort`)?.();
                  if (job.status === "queued") patch(job.key, { status: "cancelled" });
                }}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function ControlButton({
  children,
  onClick,
  disabled,
  tone = "default",
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: "default" | "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded border px-2.5 py-1.5 text-[12px] font-medium disabled:cursor-not-allowed disabled:opacity-40 ${
        tone === "danger"
          ? "border-line text-bad hover:border-bad/40 hover:bg-bad-soft"
          : "border-line text-ink hover:border-line-strong hover:bg-surface-alt"
      }`}
    >
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------------- */

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

class Cancelled extends Error {}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function toApiError(response: Response): Promise<ApiError> {
  const data = await response.json().catch(() => null);
  return new ApiError(
    data?.error ?? `Request failed (${response.status}).`,
    response.status,
    data?.retryAfterSeconds,
  );
}

async function postJson(path: string, body: unknown): Promise<any> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await toApiError(response);
  return response.json().catch(() => null);
}
