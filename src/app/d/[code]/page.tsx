import type { Metadata } from "next";
import { getShare, isPlausibleCode } from "@/lib/share";
import { formatBytes } from "@/lib/format";
import { DownloadPanel } from "@/components/DownloadPanel";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Transfer",
  // A transfer code is a bearer secret; it must never be indexed.
  robots: { index: false, follow: false },
};

export default async function TransferPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const normalised = code.toUpperCase();

  if (!isPlausibleCode(normalised)) return <InvalidState />;

  const share = await getShare(normalised);
  const expired = share ? Date.now() > share.expiresAt : false;

  if (!share || expired) {
    return (
      <Shell>
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">
          {expired ? "This transfer has expired" : "Transfer not found"}
        </h1>
        <p className="mt-2 text-[14px] leading-relaxed text-muted">
          {expired
            ? "Files are deleted automatically once their link expires. Ask the sender to send them again."
            : "Check the code and try again. Codes are case-sensitive but we accept either case."}
        </p>
        <p className="mt-6 text-[13px]">
          <a href="/" className="text-brand underline underline-offset-2 hover:text-brand-dark">
            Send files instead
          </a>
        </p>
      </Shell>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">
          {share.files.length} {share.files.length === 1 ? "file" : "files"}
        </h1>
        <p className="mt-1 text-[13px] text-muted">
          {formatBytes(share.totalBytes)} · code{" "}
          <strong className="font-mono tracking-[0.15em] text-ink">{share.code}</strong>
        </p>
      </header>

      <div className="mt-6">
        <DownloadPanel
          code={share.code}
          status={share.status}
          expiresAt={share.expiresAt}
          initialFiles={share.files.map((file) => ({
            id: file.id,
            name: file.name,
            path: file.path,
            size: file.size,
            type: file.type,
          }))}
        />
      </div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-md px-4 py-14 sm:px-6">{children}</div>;
}

function InvalidState() {
  return (
    <Shell>
      <h1 className="text-[22px] font-semibold tracking-tight text-ink">That code is not valid</h1>
      <p className="mt-2 text-[14px] text-muted">
        Transfer codes are 6 characters long and use letters and digits.
      </p>
    </Shell>
  );
}
