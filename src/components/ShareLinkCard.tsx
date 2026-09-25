"use client";

import { useEffect, useState } from "react";
import { formatDuration } from "@/lib/format";

export function ShareLinkCard({
  code,
  expiresAt,
  fileCount,
  doneCount,
  activeCount,
}: {
  code: string;
  expiresAt: number;
  fileCount: number;
  doneCount: number;
  activeCount: number;
}) {
  const [copied, setCopied] = useState(false);
  const [remaining, setRemaining] = useState(() => expiresAt - Date.now());

  const url = typeof window === "undefined" ? `/d/${code}` : `${window.location.origin}/d/${code}`;

  useEffect(() => {
    const timer = setInterval(() => setRemaining(expiresAt - Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard blocked (insecure context or permission denied). The URL is
      // still visible and selectable in the field below.
      setCopied(false);
    }
  }

  return (
    <section
      aria-label="Transfer link"
      className="rounded border border-brand/30 bg-brand-soft px-4 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] font-semibold text-brand-dark">
          Open this on the other device
        </p>
        <p className="text-[12px] text-muted">
          Expires in {formatDuration(remaining)}
        </p>
      </div>

      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <code className="flex-1 truncate rounded border border-line bg-surface px-3 py-2 font-mono text-[13px] text-ink">
          {url}
        </code>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={copy}
            className="rounded border border-brand bg-surface px-3 py-2 text-[13px] font-medium text-brand hover:bg-brand-soft"
          >
            {copied ? "Copied" : "Copy link"}
          </button>
          <a
            href={`/d/${code}`}
            className="rounded bg-brand px-3 py-2 text-[13px] font-medium text-white hover:bg-brand-dark"
          >
            Open
          </a>
        </div>
      </div>

      <p className="mt-2 text-[12px] text-muted">
        Or enter code{" "}
        <strong className="font-mono font-semibold tracking-[0.15em] text-brand-dark">{code}</strong>
        {activeCount > 0
          ? ` · ${doneCount} of ${fileCount} files ready, more arriving`
          : ` · ${doneCount} ${doneCount === 1 ? "file" : "files"} ready`}
      </p>
    </section>
  );
}
