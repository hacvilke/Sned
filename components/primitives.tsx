'use client';

import { useEffect, useState } from 'react';

import { formatBytes } from '@/lib/protocol';
import type { InStatus, OutStatus } from '@/lib/client/types';

/** Copy-to-clipboard button with a transient "Copied" state. */
export function CopyButton({
  value,
  label = 'Copy',
  copiedLabel = 'Copied',
  variant = 'quiet',
  onCopied,
}: {
  value: string | null;
  label?: string;
  copiedLabel?: string;
  variant?: 'quiet' | 'default';
  onCopied?: (field: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy() {
    if (!value) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const area = document.createElement('textarea');
        area.value = value;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        area.remove();
      }
      setCopied(true);
      onCopied?.(value);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      className={variant === 'quiet' ? 'btn btn-quiet btn-sm' : 'btn btn-sm'}
      onClick={copy}
      disabled={!value}
      aria-live="polite"
    >
      {copied ? copiedLabel : label}
    </button>
  );
}

export function Progress({
  value,
  indeterminate = false,
  label,
}: {
  value: number;
  indeterminate?: boolean;
  label?: string;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div className="progress-meta">
      <div
        className="progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : pct}
        aria-label={label}
      >
        <div
          className={indeterminate ? 'progress-fill is-indeterminate' : 'progress-fill'}
          style={indeterminate ? undefined : { width: `${pct}%` }}
        />
      </div>
      <span className="progress-pct">{indeterminate ? '—' : `${pct}%`}</span>
    </div>
  );
}

const OUT_BADGES: Record<OutStatus, { label: string; className: string }> = {
  queued: { label: 'Queued', className: 'badge badge-muted' },
  'awaiting-accept': { label: 'Waiting', className: 'badge badge-hold' },
  sending: { label: 'Sending', className: 'badge badge-active' },
  sent: { label: 'Sent', className: 'badge badge-active' },
  confirmed: { label: 'Delivered', className: 'badge badge-done' },
  skipped: { label: 'Declined', className: 'badge badge-muted' },
  cancelled: { label: 'Cancelled', className: 'badge badge-muted' },
  failed: { label: 'Failed', className: 'badge badge-failed' },
  'rate-limited': { label: 'Rate limited', className: 'badge badge-hold' },
};

const IN_BADGES: Record<InStatus, { label: string; className: string }> = {
  'awaiting-save': { label: 'Action needed', className: 'badge badge-hold' },
  receiving: { label: 'Receiving', className: 'badge badge-active' },
  complete: { label: 'Saved', className: 'badge badge-done' },
  failed: { label: 'Failed', className: 'badge badge-failed' },
  declined: { label: 'Declined', className: 'badge badge-muted' },
  cancelled: { label: 'Cancelled', className: 'badge badge-muted' },
};

export function OutBadge({ status }: { status: OutStatus }) {
  const badge = OUT_BADGES[status] ?? { label: status, className: 'badge' };
  return <span className={badge.className}>{badge.label}</span>;
}

export function InBadge({ status }: { status: InStatus }) {
  const badge = IN_BADGES[status] ?? { label: status, className: 'badge' };
  return <span className={badge.className}>{badge.label}</span>;
}

export function StatusCell({
  label,
  value,
  mono = false,
  testId,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  testId?: string;
}) {
  return (
    <div className="status-cell">
      <div className="status-label">{label}</div>
      <div className={mono ? 'status-value mono' : 'status-value'} data-testid={testId}>
        {value}
      </div>
    </div>
  );
}

export function BudgetLine({
  label,
  limit,
  remaining,
  resetAt,
}: {
  label: string;
  limit: number;
  remaining: number;
  resetAt?: number;
}) {
  return (
    <span className="small muted">
      {label}: {remaining} of {limit} remaining
      {resetAt && remaining === 0 ? ` · resets ${formatClockDate(resetAt)}` : ''}
    </span>
  );
}

export function formatClockDate(ms: number): string {
  const date = new Date(ms);
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const suffix = hours >= 12 ? 'pm' : 'am';
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${minutes}${suffix}`;
}

export function sizeOrUnknown(bytes: number): string {
  return bytes > 0 ? formatBytes(bytes) : '—';
}
