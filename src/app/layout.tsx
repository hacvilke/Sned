import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Sned — send files between your devices",
    template: "%s — Sned",
  },
  description:
    "Move any file between computers and phones. Queue multiple files, get one link, no account required. Files expire automatically.",
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#1a4f9c",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:text-brand"
        >
          Skip to content
        </a>
        <div className="flex min-h-screen flex-col">
          <SiteHeader />
          <main id="main" className="flex-1">
            {children}
          </main>
          <SiteFooter />
        </div>
      </body>
    </html>
  );
}

function SiteHeader() {
  return (
    <header className="border-b border-line bg-surface">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-4 sm:px-6">
        <a href="/" className="flex items-center gap-2.5">
          <Mark />
          <span className="text-[15px] font-semibold tracking-tight text-ink">Sned</span>
        </a>
        <nav className="flex items-center gap-5 text-[13px] text-muted">
          <a href="/#how-it-works" className="hover:text-ink">
            How it works
          </a>
          <a href="/#limits" className="hover:text-ink">
            Limits
          </a>
          <a href="/api/health" className="hover:text-ink">
            Status
          </a>
        </nav>
      </div>
    </header>
  );
}

function SiteFooter() {
  return (
    <footer className="border-t border-line bg-surface">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-2 px-4 py-6 text-[12px] text-faint sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>Files are held temporarily and deleted automatically. Do not send anything you would not email.</p>
        <p>No account required. No tracking scripts.</p>
      </div>
    </footer>
  );
}

function Mark() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="1.5" y="1.5" width="21" height="21" rx="4" fill="#1a4f9c" />
      <path
        d="M7 12.4h7.2l-2.6-2.6 1.2-1.2 4.6 4.6-4.6 4.6-1.2-1.2 2.6-2.6H7z"
        fill="#ffffff"
      />
    </svg>
  );
}
