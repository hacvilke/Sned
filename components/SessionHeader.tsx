'use client';

import { formatClock, formatCode } from '@/lib/protocol';
import type { SessionSnapshot } from '@/lib/client/types';
import { CopyButton, StatusCell } from './primitives';

interface SessionHeaderProps {
  snapshot: SessionSnapshot;
  now: number;
  busy: boolean;
  onEnd(): void;
  onReconnect(): void;
}

const PHASE_LABEL: Record<SessionSnapshot['phase'], string> = {
  idle: 'Idle',
  starting: 'Starting',
  waiting: 'Waiting for peer',
  signalling: 'Negotiating',
  connecting: 'Connecting',
  connected: 'Connected',
  closed: 'Ended',
  failed: 'Not connected',
};

export function SessionHeader({ snapshot, now, busy, onEnd, onReconnect }: SessionHeaderProps) {
  const secondsLeft = snapshot.expiresAt ? Math.max(0, (snapshot.expiresAt - now) / 1000) : null;
  const ended = snapshot.phase === 'closed' || snapshot.phase === 'failed';
  const canReconnect = Boolean(snapshot.code) && !busy && snapshot.phase !== 'closed';

  return (
    <div className="card" data-testid="session-card" data-phase={snapshot.phase}>
      <div className="card-head">
        <span className="card-title">
          Session {snapshot.role === 'host' ? 'started by you' : 'joined by you'}
        </span>
        <div className="row">
          <button
            type="button"
            className="btn btn-quiet btn-sm"
            onClick={onReconnect}
            disabled={!canReconnect}
          >
            Reconnect
          </button>
          <button type="button" className="btn btn-sm" onClick={onEnd} disabled={busy}>
            End session
          </button>
        </div>
      </div>

      <div className="card-body">
        <div className="code-box">
          <div>
            <div className="code-caption">Session code</div>
            <div className="code-value" data-testid="session-code">
              {snapshot.code ? formatCode(snapshot.code) : '——————'}
            </div>
          </div>
          <div className="row">
            <CopyButton value={snapshot.code} label="Copy code" />
            <CopyButton value={snapshot.link} label="Copy link" />
          </div>
        </div>

        <div className="status-grid mt-16">
          <StatusCell label="Status" value={PHASE_LABEL[snapshot.phase]} testId="phase" />
          <StatusCell
            label="Other device"
            value={snapshot.peerName ?? (ended ? '—' : 'Waiting…')}
          />
          <StatusCell label="Connection" value={snapshot.connectionType ?? 'Not established'} />
          <StatusCell
            label="Expires in"
            value={secondsLeft === null ? '—' : formatClock(secondsLeft)}
            mono
          />
        </div>

        {snapshot.statusDetail ? (
          <p className="small muted mt-12">{snapshot.statusDetail}</p>
        ) : null}
        {snapshot.phase === 'waiting' && snapshot.link ? (
          <p className="small muted mt-8">
            On the other device, open{' '}
            <span className="mono">{snapshot.link.replace(/^https?:\/\//, '')}</span> or enter the
            code above.
          </p>
        ) : null}
      </div>
    </div>
  );
}
