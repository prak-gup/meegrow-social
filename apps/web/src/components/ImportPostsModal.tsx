import { useRef, useState } from 'react';
import type { ConnectionView } from '@meegrow-social/contracts';
import { api } from '../lib/api';
import { cn } from '../lib/cn';
import { platformMeta } from '../lib/platforms';
import {
  DEFAULT_IMPORT_WINDOW,
  IMPORT_WINDOWS,
  importBusy,
  importSummary,
  type ImportWindowDays,
} from '../lib/postImport';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';

const TONE = {
  neutral: 'border-hairline bg-surface-soft',
  warn: 'border-status-warn/40 bg-surface-soft',
  bad: 'border-status-bad/40 bg-surface-soft',
} as const;

/**
 * "Import past posts" for one connected account: pick how far back, read what will happen, see
 * the last import and its result. Starting it only queues the work — the worker reads the platform
 * in the background — so the dialog closes at once and the row shows the progress.
 * Usage: <ImportPostsModal connection={c} onStarted={reload} onClose={close} />
 */
export function ImportPostsModal({
  connection,
  onStarted,
  onClose,
}: {
  connection: ConnectionView;
  /** The import was queued; re-read the connections to show it. */
  onStarted: () => void;
  onClose: () => void;
}) {
  const [days, setDays] = useState<ImportWindowDays>(DEFAULT_IMPORT_WINDOW);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const platform = platformMeta({
    identifier: connection.provider,
    displayName: connection.provider,
  }).label;
  const summary = importSummary(connection.import);
  const running = importBusy(connection.import);

  const start = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.importPastPosts(connection.id, days);
      onStarted();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the import.');
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Import past posts"
      onClose={() => {
        if (!inFlight.current) onClose();
      }}
    >
      <p className="text-sm text-body-ink">
        Brings in the posts <b className="font-semibold text-ink">{connection.displayName}</b>{' '}
        already has on {platform} — published there or with another tool — so they show in Content,
        Calendar and Analytics.
      </p>

      <fieldset className="mt-4" disabled={busy || running}>
        <legend className="mb-1.5 text-sm font-medium text-ink">How far back</legend>
        <div className="grid grid-cols-2 gap-1.5">
          {IMPORT_WINDOWS.map((w) => (
            <label
              key={w.days}
              className={cn(
                'flex min-h-11 cursor-pointer items-center gap-2 rounded-sm border px-3 text-sm md:min-h-9',
                days === w.days ? 'border-ink bg-surface-strong font-medium' : 'border-hairline',
                (busy || running) && 'cursor-default opacity-60',
              )}
            >
              <input
                type="radio"
                name="import-window"
                className="accent-ink"
                checked={days === w.days}
                onChange={() => setDays(w.days)}
              />
              {w.label}
            </label>
          ))}
        </div>
      </fieldset>

      <ul className="mt-4 list-disc space-y-1 pl-4 text-caption text-muted">
        <li>Nothing is posted, edited or deleted on {platform}. This only reads.</li>
        <li>Posts you published from here are recognised, not duplicated.</li>
        <li>
          Imported posts are marked “Imported”. They can be viewed and duplicated as a draft, never
          edited or republished.
        </li>
        <li>
          Up to 500 posts per import, newest first. Their numbers are collected over the following
          hours.
        </li>
      </ul>

      <div
        className={cn('mt-4 rounded-sm border px-3 py-2 text-caption', TONE[summary.tone])}
        aria-live="polite"
      >
        <p className="font-medium text-ink">{summary.heading}</p>
        {summary.detail && <p className="tnum text-muted">{summary.detail}</p>}
        {summary.message && <p className="mt-1 break-words text-body-ink">{summary.message}</p>}
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm text-error">
          {error}
        </p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          {running ? 'Close' : 'Cancel'}
        </Button>
        <Button onClick={() => void start()} disabled={busy || running}>
          {busy ? 'Starting…' : running ? 'Import in progress' : 'Import'}
        </Button>
      </div>
    </Modal>
  );
}
