'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ConfigResponse } from '@/lib/client/api';
import { PeerSession, type PersistedSession } from '@/lib/client/session';
import { describeDevice, type SessionSnapshot } from '@/lib/client/types';
import { formatCode } from '@/lib/protocol';

import { Notices } from './Notices';
import { ReceiveSection } from './ReceiveSection';
import { SendSection } from './SendSection';
import { SessionHeader } from './SessionHeader';
import { StartPanel } from './StartPanel';

interface TransferConsoleProps {
  config: ConfigResponse;
  /** Session code from a `/?r=CODE` share link. */
  initialCode: string | null;
}

function normalizeCodeInput(input: string): string {
  return input.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 6);
}

export function TransferConsole({ config, initialCode }: TransferConsoleProps) {
  const sessionRef = useRef<PeerSession | null>(null);
  const autoJoinDone = useRef(false);

  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [resetToken, setResetToken] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [deviceName, setDeviceName] = useState('');
  const [codeInput, setCodeInput] = useState(() => (initialCode ? normalizeCodeInput(initialCode) : ''));
  const [codeError, setCodeError] = useState<string | null>(null);
  const [resumable, setResumable] = useState<PersistedSession | null>(null);

  const effectiveName = deviceName.trim() || describeDevice();
  const phase = snapshot?.phase ?? 'idle';
  const inSession = phase !== 'idle';
  const connected = phase === 'connected';

  // ---------------------------------------------------------------- engine
  useEffect(() => {
    const session = new PeerSession({ onSnapshot: setSnapshot }, config);
    sessionRef.current = session;

    let cancelled = false;
    if (resetToken === 0) {
      // sessionStorage only exists in the browser, so an unfinished session is
      // picked up right after mount rather than during the first render.
      queueMicrotask(() => {
        if (cancelled) return;
        const persisted = PeerSession.readPersisted();
        if (persisted) setResumable(persisted);
        setDeviceName(persisted?.name ?? describeDevice());
      });
    }

    return () => {
      cancelled = true;
      session.destroy();
      sessionRef.current = null;
    };
    // `config` comes from the server component and never changes identity.
  }, [config, resetToken]);

  // ---------------------------------------------------------------- ticker
  useEffect(() => {
    if (!snapshot?.expiresAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [snapshot?.expiresAt]);

  // ------------------------------------------------- auto-join from a link
  useEffect(() => {
    if (autoJoinDone.current) return;
    const code = initialCode ? normalizeCodeInput(initialCode) : '';
    if (!code || code.length !== 6) return;
    autoJoinDone.current = true;

    // Never auto-join our own session, and prefer resuming an unfinished one.
    if (resumable && resumable.code === code) return;
    if (resumable) return;
    void sessionRef.current?.joinAsGuest(code, effectiveName);
    // Runs once, after the engine effect above has created the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCode, resumable]);

  // --------------------------------------------------------------- actions
  const handleStart = useCallback(() => {
    setCodeError(null);
    setResumable(null);
    void sessionRef.current?.startHost(effectiveName);
  }, [effectiveName]);

  const handleJoin = useCallback(() => {
    const code = normalizeCodeInput(codeInput);
    if (code.length !== 6) {
      setCodeError('Enter the full six-character code.');
      return;
    }
    setCodeError(null);
    setResumable(null);
    void sessionRef.current?.joinAsGuest(code, effectiveName);
  }, [codeInput, effectiveName]);

  const handleResume = useCallback(() => {
    const persisted = resumable;
    setResumable(null);
    if (!persisted) return;
    setDeviceName(persisted.name);
    void sessionRef.current?.resume(persisted);
  }, [resumable]);

  const handleDiscardResume = useCallback(() => {
    PeerSession.clearPersisted();
    setResumable(null);
  }, []);

  const handleEnd = useCallback(() => {
    setResumable(null);
    void sessionRef.current?.endSession('You ended the session.');
  }, []);

  const handleReset = useCallback(() => {
    PeerSession.clearPersisted();
    setResumable(null);
    setSnapshot(null);
    setCodeInput('');
    setCodeError(null);
    autoJoinDone.current = true; // do not re-join the old link after a reset
    setResetToken((token) => token + 1);
  }, []);

  const handleReconnect = useCallback(() => {
    void sessionRef.current?.reconnect();
  }, []);

  const handleFiles = useCallback((files: File[]) => {
    const session = sessionRef.current;
    if (!session) return;
    const { added } = session.enqueue(files);
    if (added > 0) session.startQueue();
  }, []);

  const busy = snapshot?.busy ?? false;
  const ended = phase === 'closed' || phase === 'failed';

  return (
    <div className="stack" style={{ gap: 20 }}>
      {!config.storeConfigured && config.vercel ? (
        <div className="notice notice-error">
          <span className="notice-label">Setup</span>
          <span className="notice-text">
            No signalling store is configured, so sessions cannot be shared between requests on
            Vercel. Set <span className="mono">UPSTASH_REDIS_REST_URL</span> and{' '}
            <span className="mono">UPSTASH_REDIS_REST_TOKEN</span> (or{' '}
            <span className="mono">BLOB_READ_WRITE_TOKEN</span>) and redeploy. See README.md.
          </span>
        </div>
      ) : null}

      {resumable && !inSession ? (
        <div className="card">
          <div className="card-body row-between">
            <span className="small">
              An unfinished session <span className="mono strong">{formatCode(resumable.code)}</span>{' '}
              is still active on this device.
            </span>
            <span className="row">
              <button type="button" className="btn btn-primary btn-sm" onClick={handleResume}>
                Resume
              </button>
              <button type="button" className="btn btn-quiet btn-sm" onClick={handleDiscardResume}>
                Discard
              </button>
            </span>
          </div>
        </div>
      ) : null}

      <Notices
        notices={snapshot?.notices ?? []}
        onDismiss={(id) => sessionRef.current?.dismissNotice(id)}
      />

      {inSession && snapshot ? (
        <>
          <SessionHeader
            snapshot={snapshot}
            now={now}
            busy={busy}
            onEnd={handleEnd}
            onReconnect={handleReconnect}
          />

          {ended ? (
            <div className="card">
              <div className="card-body row-between">
                <span className="small muted">
                  {phase === 'failed'
                    ? 'This session is not connected. Reconnect, or start a new session.'
                    : 'This session has ended. Start a new one to transfer more files.'}
                </span>
                <span className="row">
                  {phase === 'failed' ? (
                    <button type="button" className="btn btn-sm" onClick={handleReconnect}>
                      Reconnect
                    </button>
                  ) : null}
                  <button type="button" className="btn btn-primary btn-sm" onClick={handleReset}>
                    Start a new session
                  </button>
                </span>
              </div>
            </div>
          ) : null}

          <SendSection
            items={snapshot.outgoing}
            connected={connected}
            queueRunning={snapshot.queueRunning}
            maxFileBytes={config.maxFileBytes}
            budget={snapshot.budgets.upload}
            onFiles={handleFiles}
            onCancel={(id) => sessionRef.current?.cancelOutgoing(id)}
            onRetry={(id) => sessionRef.current?.retryOutgoing(id)}
            onRemove={(id) => sessionRef.current?.removeQueued(id)}
            onClearFinished={() => sessionRef.current?.clearFinished()}
          />

          <ReceiveSection
            items={snapshot.incoming}
            connected={connected}
            autoSave={snapshot.autoSave}
            canStreamToDisk={snapshot.canStreamToDisk}
            budget={snapshot.budgets.download}
            onAutoSaveChange={(value) => sessionRef.current?.setAutoSave(value)}
            onSave={(id) => void sessionRef.current?.saveToDisk(id)}
            onDownload={(id) => void sessionRef.current?.acceptInMemory(id)}
            onDecline={(id) => void sessionRef.current?.decline(id, 'user')}
            onCancel={(id) => void sessionRef.current?.cancelIncoming(id)}
          />
        </>
      ) : (
        <StartPanel
          deviceName={deviceName}
          onDeviceNameChange={setDeviceName}
          codeInput={codeInput}
          onCodeInputChange={(value) => {
            setCodeInput(normalizeCodeInput(value));
            setCodeError(null);
          }}
          codeError={codeError}
          busy={busy}
          maxFileBytes={config.maxFileBytes}
          roomTtlSeconds={config.roomTtlSeconds}
          onStart={handleStart}
          onJoin={handleJoin}
        />
      )}
    </div>
  );
}
