"use client";

import { useEffect, useState } from "react";
import { formatBytes, formatDuration } from "@/lib/format";

type ListedFile = {
  id: string;
  name: string;
  path: string;
  size: number;
  type: string;
};

const POLL_MS = 3000;

export function DownloadPanel({
  code,
  status,
  expiresAt,
  initialFiles,
}: {
  code: string;
  status: "open" | "sealed";
  expiresAt: number;
  initialFiles: ListedFile[];
}) {
  const [files, setFiles] = useState<ListedFile[]>(initialFiles);
  const [sealed, setSealed] = useState(status === "sealed");
  const [remaining, setRemaining] = useState(() => expiresAt - Date.now());
  const [error, setError] = useState<string | null>(null);

  // While the sender's queue is still running, files land one at a time.
  useEffect(() => {
    if (sealed) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const response = await fetch(`/api/share/${code}`, { cache: "no-store" });
        const data = await response.json().catch(() => null);
        if (cancelled) return;
        if (response.ok && data) {
          setFiles(data.files ?? []);
          if (data.status === "sealed") setSealed(true);
        }
      } catch {
        // Transient network error; the next tick will catch up.
      }
    };

    const timer = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [code, sealed]);

  useEffect(() => {
    const timer = setInterval(() => setRemaining(expiresAt - Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted">
        <span>
          {sealed
            ? `All ${files.length} ${files.length === 1 ? "file" : "files"} received`
            : `${files.length} received so far — waiting for more`}
        </span>
        <span>Expires in {formatDuration(remaining)}</span>
      </div>

      {error ? (
        <p role="alert" className="rounded border border-bad/30 bg-bad-soft px-3 py-2 text-[13px] text-bad">
          {error}
        </p>
      ) : null}

      <ul className="divide-y divide-line rounded border border-line bg-surface">
        {files.map((file) => (
          <li key={file.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-ink" title={file.name}>
                {file.name}
              </p>
              {file.path && file.path !== file.name ? (
                <p className="truncate text-[11px] text-faint" title={file.path}>
                  {file.path}
                </p>
              ) : null}
              <p className="mt-0.5 text-[11px] text-faint">{formatBytes(file.size)}</p>
            </div>
            <a
              href={`/api/download/${code}?file=${encodeURIComponent(file.id)}`}
              className="shrink-0 rounded border border-brand bg-surface px-3 py-1.5 text-[12px] font-medium text-brand hover:bg-brand-soft"
            >
              Download
            </a>
          </li>
        ))}
        {files.length === 0 ? (
          <li className="px-4 py-6 text-center text-[13px] text-muted">
            Nothing has arrived yet. This page updates on its own.
          </li>
        ) : null}
      </ul>

      {files.length > 1 ? (
        <button
          type="button"
          onClick={() => {
            // Stagger the clicks: browsers drop simultaneous downloads past a
            // small parallelism budget.
            files.forEach((file, index) => {
              setTimeout(() => {
                const link = document.createElement("a");
                link.href = `/api/download/${code}?file=${encodeURIComponent(file.id)}`;
                link.rel = "noopener";
                document.body.appendChild(link);
                link.click();
                link.remove();
              }, index * 350);
            });
          }}
          className="rounded bg-brand px-4 py-2 text-[13px] font-medium text-white hover:bg-brand-dark"
        >
          Download all {files.length} files
        </button>
      ) : null}

      <p className="text-[12px] text-faint">
        Files are served directly from storage and are deleted when this link expires.
      </p>
    </div>
  );
}
