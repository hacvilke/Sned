'use client';

import { formatBytes, formatRate } from '@/lib/protocol';
import type { Budget, IncomingFileView } from '@/lib/client/types';
import { BudgetLine, InBadge, Progress } from './primitives';

interface ReceiveSectionProps {
  items: IncomingFileView[];
  connected: boolean;
  autoSave: boolean;
  canStreamToDisk: boolean;
  budget: Budget | null;
  onAutoSaveChange(value: boolean): void;
  onSave(id: string): void;
  onDownload(id: string): void;
  onDecline(id: string): void;
  onCancel(id: string): void;
}

export function ReceiveSection({
  items,
  connected,
  autoSave,
  canStreamToDisk,
  budget,
  onAutoSaveChange,
  onSave,
  onDownload,
  onDecline,
  onCancel,
}: ReceiveSectionProps) {
  const pending = items.filter((item) => item.status === 'awaiting-save').length;

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Receive files</span>
        <span className="small muted">
          {pending > 0 ? `${pending} waiting for you` : connected ? 'Ready' : 'Waiting for connection'}
        </span>
      </div>

      <div className="card-body">
        <label className="checkbox-row" htmlFor="auto-save">
          <input
            id="auto-save"
            type="checkbox"
            checked={autoSave}
            onChange={(event) => onAutoSaveChange(event.target.checked)}
          />
          <span>
            Download automatically without asking.
            <span className="hint">
              {' '}
              {canStreamToDisk
                ? 'Unticked, you choose a save location for each file (streamed straight to disk).'
                : 'This browser cannot choose a save location, so files are downloaded to your default folder.'}
            </span>
          </span>
        </label>
        {!canStreamToDisk ? (
          <p className="hint mt-8">
            Files are assembled in memory before the download starts on this browser. For transfers
            of several hundred megabytes, prefer a desktop browser with a save-location picker.
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
                  const ratio = item.size > 0 ? item.received / item.size : 0;
                  const active = item.status === 'receiving';
                  return (
                    <tr key={item.id} data-testid="in-row" data-file={item.name} data-status={item.status}>
                      <td>
                        <div className="file-name">{item.savedName ?? item.name}</div>
                        {item.error ? <div className="file-sub" data-testid="in-detail">{item.error}</div> : null}
                        {!item.error && item.mode === 'stream' && item.status === 'complete' ? (
                          <div className="file-sub">Written to disk.</div>
                        ) : null}
                      </td>
                      <td className="num">{formatBytes(item.size)}</td>
                      <td>
                        <Progress
                          value={ratio}
                          indeterminate={item.status === 'awaiting-save'}
                          label={`Receiving ${item.name}`}
                        />
                        <div className="file-sub num">
                          {formatBytes(item.received)} / {formatBytes(item.size)}
                        </div>
                      </td>
                      <td className="num">{active ? formatRate(item.rate) : '—'}</td>
                      <td>
                        <InBadge status={item.status} />
                      </td>
                      <td className="right nowrap">
                        {item.status === 'awaiting-save' ? (
                          <span className="row" style={{ justifyContent: 'flex-end' }}>
                            {canStreamToDisk ? (
                              <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                onClick={() => onSave(item.id)}
                              >
                                Save…
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="btn btn-quiet btn-sm"
                              onClick={() => onDownload(item.id)}
                            >
                              {canStreamToDisk ? 'Download' : 'Accept'}
                            </button>
                            <button
                              type="button"
                              className="btn btn-quiet btn-sm"
                              onClick={() => onDecline(item.id)}
                            >
                              Decline
                            </button>
                          </span>
                        ) : null}
                        {item.status === 'receiving' ? (
                          <button
                            type="button"
                            className="btn btn-quiet btn-sm"
                            onClick={() => onCancel(item.id)}
                          >
                            Stop
                          </button>
                        ) : null}
                        {item.status === 'complete' && item.url ? (
                          <a className="btn btn-quiet btn-sm" href={item.url} download={item.name}>
                            Save again
                          </a>
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
          <p className="table-empty">
            {connected
              ? 'Nothing received yet. Files sent by the other device appear here.'
              : 'Nothing received yet.'}
          </p>
        </div>
      )}

      <div className="card-foot row-between">
        {budget ? (
          <BudgetLine
            label="Receive budget"
            limit={budget.limit}
            remaining={budget.remaining}
            resetAt={budget.resetAt}
          />
        ) : (
          <span className="small muted">
            Each accepted file is counted against the server-side receive limit.
          </span>
        )}
      </div>
    </div>
  );
}
