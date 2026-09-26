'use client';

import { formatBytes, formatDuration } from '@/lib/protocol';

interface StartPanelProps {
  deviceName: string;
  onDeviceNameChange(value: string): void;
  codeInput: string;
  onCodeInputChange(value: string): void;
  codeError: string | null;
  busy: boolean;
  maxFileBytes: number;
  roomTtlSeconds: number;
  onStart(): void;
  onJoin(): void;
}

const CODE_MAX = 6;

export function StartPanel({
  deviceName,
  onDeviceNameChange,
  codeInput,
  onCodeInputChange,
  codeError,
  busy,
  maxFileBytes,
  roomTtlSeconds,
  onStart,
  onJoin,
}: StartPanelProps) {
  const cleaned = codeInput.toUpperCase().replace(/[^A-Z2-9]/g, '');
  const canJoin = cleaned.length === CODE_MAX && !busy;

  function handleCodeChange(value: string) {
    const next = value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, CODE_MAX);
    onCodeInputChange(next);
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <span className="card-title">This device</span>
        </div>
        <div className="card-body">
          <div className="field">
            <label className="label" htmlFor="device-name">
              Device name shown to the other device
            </label>
            <input
              id="device-name"
              className="input"
              value={deviceName}
              maxLength={64}
              onChange={(event) => onDeviceNameChange(event.target.value)}
              placeholder="For example: Office desktop"
              autoComplete="off"
            />
            <span className="hint">
              Optional. It is only sent to the device you connect to, never stored.
            </span>
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <span className="card-title">1 · Start a session</span>
          </div>
          <div className="card-body stack">
            <p className="small muted mt-0">
              Creates a six-character code. Give the code (or the link) to the other device. When it
              joins, the two devices connect directly to each other.
            </p>
            <button
              type="button"
              className="btn btn-primary btn-block"
              data-testid="start-session"
              onClick={onStart}
              disabled={busy}
            >
              {busy ? 'Working…' : 'Start session'}
            </button>
            <span className="hint">
              Sessions last {formatDuration(roomTtlSeconds)} and close when either device leaves.
            </span>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <span className="card-title">2 · Join a session</span>
          </div>
          <div className="card-body stack">
            <p className="small muted mt-0">
              Enter the code displayed on the other device to connect to it.
            </p>
            <div className="field">
              <label className="label" htmlFor="join-code">
                Session code
              </label>
              <input
                id="join-code"
                className="input input-mono"
                value={codeInput}
                onChange={(event) => handleCodeChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && canJoin) onJoin();
                }}
                placeholder="ABC DEF"
                inputMode="text"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={Boolean(codeError)}
                aria-describedby={codeError ? 'join-code-error' : undefined}
                maxLength={CODE_MAX + 2}
              />
              {codeError ? (
                <span className="hint strong" id="join-code-error">
                  {codeError}
                </span>
              ) : (
                <span className="hint">Six characters, no spaces needed.</span>
              )}
            </div>
            <button
              type="button"
              className="btn btn-primary btn-block"
              data-testid="join-session"
              onClick={onJoin}
              disabled={!canJoin}
            >
              {busy ? 'Working…' : 'Connect'}
            </button>
          </div>
        </div>
      </div>

      <p className="small muted mt-0">
        Either device can send once connected. Up to {formatBytes(maxFileBytes)} per file, any file
        type, transferred in a queue with per-file progress.
      </p>
    </div>
  );
}
