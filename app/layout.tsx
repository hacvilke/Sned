import type { Metadata } from 'next';

import { getPublicConfig } from '@/lib/config';
import { formatDuration } from '@/lib/protocol';

import './globals.css';

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%231a1a1a'/%3E%3Cpath d='M7 16h13m0 0-4.5-4.5M20 16l-4.5 4.5' stroke='%23ffffff' stroke-width='2' fill='none'/%3E%3C/svg%3E";

export const metadata: Metadata = {
  title: 'File Transfer',
  description:
    'Transfer files directly between computers and phones over a peer-to-peer connection. Files are never uploaded to a server.',
  icons: { icon: FAVICON },
};

export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const config = getPublicConfig(false);

  const storeLabel =
    config.store === 'redis'
      ? 'Upstash Redis'
      : config.store === 'blob'
        ? 'Vercel Blob'
        : 'In-process memory (this instance only)';

  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <div className="shell topbar-inner">
            <span className="wordmark">File Transfer</span>
            <span className="topbar-note">
              Peer-to-peer · file bytes never touch the server · sessions last{' '}
              {formatDuration(config.roomTtlSeconds)}
            </span>
          </div>
        </header>

        <main className="shell">{children}</main>

        <footer className="footer">
          <div className="shell">
            <div className="footer-grid">
              <div>
                <h2>How it works</h2>
                <ul>
                  <li>1. One device starts a session and gets a six-character code.</li>
                  <li>2. The other device enters that code.</li>
                  <li>3. The server introduces them, then steps out of the way.</li>
                  <li>4. Files travel directly between the two devices, encrypted in transit.</li>
                </ul>
              </div>

              <div>
                <h2>Limits</h2>
                <ul>
                  {config.limits
                    .filter((limit) =>
                      ['rooms', 'join', 'upload', 'download'].includes(limit.bucket),
                    )
                    .map((limit) => (
                      <li key={limit.bucket}>
                        {limit.label}: {limit.limit} per{' '}
                        {limit.windowSeconds >= 3600
                          ? `${limit.windowSeconds / 3600} hour${limit.windowSeconds === 3600 ? '' : 's'}`
                          : `${limit.windowSeconds} seconds`}
                      </li>
                    ))}
                  <li>
                    Session length: {formatDuration(config.roomTtlSeconds)} · max{' '}
                    {config.maxFilesPerSession} files queued
                  </li>
                </ul>
              </div>

              <div>
                <h2>Requirements</h2>
                <ul>
                  <li>A modern browser on both devices (Chrome, Edge, Safari, Firefox).</li>
                  <li>Both devices online at the same time — nothing is stored for later.</li>
                  <li>
                    On restrictive networks a TURN relay is needed:{' '}
                    {config.hasTurn ? 'configured.' : 'not configured.'}
                  </li>
                  <li>
                    Large files are best received in a desktop browser that can stream straight to
                    disk.
                  </li>
                </ul>
              </div>
            </div>

            <div className="footer-bottom">
              <span>Signalling store: {storeLabel}</span>
              <span>
                Rate limiting: {config.rateLimitBackend === 'redis' ? 'Redis' : 'in-process'} ·
                preset “{config.rateLimitPreset}”
              </span>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
