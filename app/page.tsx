import type { ConfigResponse } from '@/lib/client/api';
import { getPublicConfig } from '@/lib/config';
import { formatBytes } from '@/lib/protocol';
import { TransferConsole } from '@/components/TransferConsole';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function Page({ searchParams }: PageProps) {
  const params = await searchParams;
  const rawCode = typeof params.r === 'string' ? params.r : '';
  const config = getPublicConfig(false) as unknown as ConfigResponse;

  return (
    <>
      <div className="page-head">
        <h1>Transfer files between computers and phones</h1>
        <p>
          Start a session on one device, enter the code on the other, and files move directly between
          them — any file type, up to {formatBytes(config.maxFileBytes)} each. Nothing is uploaded to
          a server and nothing is kept after the session ends. Transfers run as a queue with
          per-file progress, and the server rate limits how many sessions and files each address can
          push through.
        </p>
      </div>

      <section className="section">
        <TransferConsole config={config} initialCode={rawCode || null} />
      </section>
    </>
  );
}
