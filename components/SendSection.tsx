'use client';

import { useRef, useState } from 'react';

import { formatBytes, formatRate } from '@/lib/protocol';
import type { Budget, OutgoingFileView } from '@/lib/client/types';
import { BudgetLine, OutBadge, Progress } from './primitives';

interface SendSectionProps {
  items: OutgoingFileView[];
  connected: boolean;
  queueRunning: boolean;
  maxFileBytes: number;
  budget: Budget | null;
  onFiles(files: File[]): void;
  onCancel(id: string): void;
  onRetry(id: string): void;
  onRemove(id: string): void;
  onClearFinished(): void;
}

export function SendSection({
  items,
  connected,
  queueRunning,
  maxFileBytes,
  budget,
  onFiles,
  onCancel,
  onRetry,
  onRemove,
  onClearFinished,
}: SendSectionProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const queued = items.filter((item) => item.status === 'queued').length;
  const finished = items.filter((item) =>
    ['confirmed', 'sent', 'skipped', 'cancelled', 'failed'].includes(item.status),
  ).length;

  function pickFiles() {
    inputRef.current?.click();
  }

  function handleFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    onFiles(Array.from(list));
  }

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Send files</span>
        <span className="small muted">
          {queueRunning ? 'Transferring…' : connected ? 'Ready' : 'Waiting for connection'}
        </span>
      </div>

      <div className="card-body">
        <div
          className={`dropzone${dragOver ? ' is-over' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(false);
            handleFiles(event.dataTransfer?.files ?? null);
          }}
          onClick={pickFiles}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              pickFiles();
            }
          }}
          role="button"
          tabIndex={0}
          aria-label="Add files to the send queue"
        >
          <div className="dropzone-title">Drop files here, or click to choose</div>
          <div className="dropzone-sub">
            Any file type, up to {formatBytes(maxFileBytes)} each. Files queue and transfer one at a
            time{connected ? '' : ' as soon as the devices connect'}.
          </div>
          <input
            ref={inputRef}
            type="file"
            multiple
            data-testid="file-input"
            className="sr-only"
            onChange={(event) => {
              handleFiles(event.target.files);
              event.target.value = '';
            }}
          />
        </div>

        {queued > 0 && !connected ? (
          <p className="hint mt-12">
            {queued} file{queued === 1 ? '' : 's'} queued. The transfer starts automatically once the
            other device connects.
          </p>
        ) : null}
      </div>

      {items.length > 0 ? (
        <div className="card-body">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col">Size</th>
                  <th scope="col" style={{ minWidth: 160 }}>
                    Progress
                  </th>
                  <th scope="col">Speed</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="right">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const ratio = item.size > 0 ? item.sent / item.size : 0;
                  const active = item.status === 'sending';
                  return (
                    <tr key={item.id} data-testid="out-row" data-file={item.name} data-status={item.status}>
                      <td>
                        <div className="file-name">{item.name}</div>
                        {item.error ? (
                          <div className="file-sub" data-testid="out-detail">
                            {item.error}
                          </div>
                        ) : item.note ? (
                          <div className="file-sub" data-testid="out-detail">
                            {item.note}
                          </div>
                        ) : null}
                      </td>
                      <td className="num">{formatBytes(item.size)}</td>
                      <td>
                        <Progress
                          value={ratio}
                          indeterminate={item.status === 'awaiting-accept'}
                          label={`Sending ${item.name}`}
                        />
                        <div className="file-sub num">
                          {formatBytes(item.sent)} / {formatBytes(item.size)}
                        </div>
                      </td>
                      <td className="num">{active ? formatRate(item.rate) : '—'}</td>
                      <td>
                        <OutBadge status={item.status} />
                      </td>
                      <td className="right nowrap">
                        {item.status === 'queued' ? (
                          <button
                            type="button"
                            className="btn btn-quiet btn-sm"
                            onClick={() => onRemove(item.id)}
                          >
                            Remove
                          </button>
                        ) : null}
                        {item.status === 'sending' || item.status === 'awaiting-accept' ? (
                          <button
                            type="button"
                            className="btn btn-quiet btn-sm"
                            onClick={() => onCancel(item.id)}
                          >
                            Cancel
                          </button>
                        ) : null}
                        {['failed', 'skipped', 'cancelled', 'rate-limited'].includes(item.status) ? (
                          <button
                            type="button"
                            className="btn btn-quiet btn-sm"
                            onClick={() => onRetry(item.id)}
                          >
                            Retry
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="card-body">
          <p className="table-empty">No files queued.</p>
        </div>
      )}

      <div className="card-foot row-between">
        {budget ? (
          <BudgetLine
            label="Send budget"
            limit={budget.limit}
            remaining={budget.remaining}
            resetAt={budget.resetAt}
          />
        ) : (
          <span className="small muted">Send budget is checked against the server for each file.</span>
        )}
        {finished > 0 ? (
          <button type="button" className="btn btn-quiet btn-sm" onClick={onClearFinished}>
            Clear finished ({finished})
          </button>
        ) : null}
      </div>
    </div>
  );
}
