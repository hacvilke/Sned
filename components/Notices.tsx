'use client';

import type { Notice } from '@/lib/client/types';

const LABELS: Record<Notice['level'], string> = {
  info: 'Note',
  warn: 'Warning',
  error: 'Error',
};

export function Notices({
  notices,
  onDismiss,
}: {
  notices: Notice[];
  onDismiss(id: string): void;
}) {
  if (notices.length === 0) return null;
  return (
    <div className="notices" role="status" aria-live="polite">
      {notices.map((notice) => (
        <div key={notice.id} className={`notice notice-${notice.level}`}>
          <span className="notice-label">{LABELS[notice.level]}</span>
          <span className="notice-text">{notice.text}</span>
          <button
            type="button"
            className="notice-dismiss"
            onClick={() => onDismiss(notice.id)}
            aria-label="Dismiss message"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
