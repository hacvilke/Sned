import { publicLimits } from "@/lib/limits";
import { formatBytes } from "@/lib/format";
import { TransferPanel } from "@/components/TransferPanel";

export default function HomePage() {
  const limits = publicLimits;
  const localOnly = limits.storageMode === "memory";

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="max-w-2xl">
        <h1 className="text-[26px] font-semibold tracking-tight text-ink sm:text-[32px]">
          Send files between your devices
        </h1>
        <p className="mt-2 text-[15px] leading-relaxed text-muted">
          Queue files here, get one link, open it on the other device. Any file type, no account,
          no software to install. Files are deleted automatically after {limits.ttlHours} hours.
        </p>
      </header>

      {localOnly ? (
        <div className="mt-6 rounded border border-warn/30 bg-warn-soft px-3 py-2 text-[13px] text-warn">
          This deployment has no Blob store configured, so uploads are held in server memory and
          capped at {formatBytes(limits.maxDevFileBytes, 0)}. Set{" "}
          <code className="font-mono">BLOB_READ_WRITE_TOKEN</code> to enable real transfers.
        </div>
      ) : null}

      <div className="mt-6">
        <TransferPanel limits={limits} />
      </div>

      <section id="how-it-works" className="mt-14 scroll-mt-20">
        <h2 className="text-[17px] font-semibold text-ink">How it works</h2>
        <ol className="mt-4 grid gap-4 sm:grid-cols-3">
          <Step n={1} title="Add files">
            Drop as many files or whole folders as you like. They queue up and upload two at a
            time, so you can keep working.
          </Step>
          <Step n={2} title="Share the link">
            One link covers the whole batch. It exists before the first file finishes, so the
            receiving device can start pulling immediately.
          </Step>
          <Step n={3} title="Download">
            Open the link on the phone or computer. Every file downloads with its original name,
            in its original format.
          </Step>
        </ol>
      </section>

      <section id="limits" className="mt-14 scroll-mt-20">
        <h2 className="text-[17px] font-semibold text-ink">Limits</h2>
        <p className="mt-1 text-[13px] text-muted">
          Applied per IP address over a rolling window. Exceeding one returns HTTP 429 with a
          retry time; the queue backs off automatically rather than failing your files.
        </p>
        <dl className="mt-4 overflow-hidden rounded border border-line bg-surface">
          <Row label="Maximum file size" value={formatBytes(limits.maxFileBytes, 0)} />
          <Row label="Maximum per transfer" value={formatBytes(limits.maxBatchBytes, 0)} />
          <Row label="Files per transfer" value={String(limits.maxFilesPerBatch)} />
          <Row label="Uploads per minute" value={envOr("UPLOADS_PER_MINUTE", "20")} />
          <Row label="Uploads per day" value={envOr("UPLOADS_PER_DAY", "300")} />
          <Row label="Data per day" value={formatBytes(bytesPerDay(), 0)} />
          <Row label="Link lifetime" value={`${limits.ttlHours} hours`} />
          <Row label="Concurrent uploads" value={String(limits.concurrency)} last />
        </dl>
      </section>

      <section className="mt-14 border-t border-line pt-6">
        <h2 className="text-[17px] font-semibold text-ink">Already have a link?</h2>
        <p className="mt-1 text-[13px] text-muted">
          <a href="/d" className="text-brand underline underline-offset-2 hover:text-brand-dark">
            Enter your transfer code
          </a>{" "}
          to open a transfer from this device.
        </p>
      </section>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="rounded border border-line bg-surface p-4">
      <span className="inline-flex h-6 w-6 items-center justify-center rounded-sm bg-brand text-[12px] font-semibold text-white">
        {n}
      </span>
      <h3 className="mt-2 text-[14px] font-semibold text-ink">{title}</h3>
      <p className="mt-1 text-[13px] leading-relaxed text-muted">{children}</p>
    </li>
  );
}

function Row({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <div
      className={`flex items-center justify-between px-4 py-2.5 text-[13px] ${
        last ? "" : "border-b border-line"
      }`}
    >
      <dt className="text-muted">{label}</dt>
      <dd className="font-medium text-ink">{value}</dd>
    </div>
  );
}

/** These are server-only reads; the values are baked in at build time. */
function envOr(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function bytesPerDay(): number {
  const raw = Number(process.env.BYTES_PER_DAY);
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 1024 * 1024 * 1024;
}
