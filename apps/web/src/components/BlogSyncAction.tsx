import { useEffect, useRef, useState } from 'react';
import type { ConnectionView } from '@meegrow-social/contracts';
import { api, ApiError } from '../lib/api';
import { DEFAULT_IMPORT_WINDOW, IMPORT_POLL_MS, importBusy } from '../lib/postImport';
import { syncFinished, syncMoving, syncShouldPoll, syncSites, syncStatus } from '../lib/blogSync';
import { Button } from './ui/Button';

export function BlogSyncAction({
  connections,
  site = '',
  onFinished,
}: {
  connections: ConnectionView[];
  site?: string;
  onFinished: () => void;
}) {
  const [current, setCurrent] = useState(connections);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const finished = useRef(onFinished);
  finished.current = onFinished;
  useEffect(() => setCurrent(connections), [connections]);
  const selected = syncSites(current, site);
  const poll = syncShouldPoll(syncSites(current));
  useEffect(() => {
    if (!poll) return;
    let stale = false;
    let pending = false;
    const timer = window.setInterval(() => {
      if (pending) return;
      pending = true;
      void api
        .listConnections()
        .then(({ connections: next }) => {
          if (stale) return;
          if (syncFinished(syncSites(current), next)) finished.current();
          setCurrent(next);
          setError(null);
        })
        .catch((e: unknown) => {
          if (!stale) setError(e instanceof Error ? e.message : 'Could not check sync progress.');
        })
        .finally(() => {
          pending = false;
        });
    }, IMPORT_POLL_MS);
    return () => {
      stale = true;
      window.clearInterval(timer);
    };
  }, [poll, current]);
  const start = async () => {
    if (lock.current || syncShouldPoll(selected)) return;
    lock.current = true;
    setStarting(true);
    setError(null);
    try {
      const results = await Promise.all(
        selected
          .filter((c) => !importBusy(c.import))
          .map(async (c) => {
            try {
              const result = await api.importPastPosts(c.id, DEFAULT_IMPORT_WINDOW);
              return { ...c, import: result.import };
            } catch (e) {
              if (!(e instanceof ApiError && e.status === 409)) {
                setError(
                  `${c.displayName}: ${e instanceof Error ? e.message : 'Could not start sync.'}`,
                );
              }
              return c;
            }
          }),
      );
      setCurrent((prev) => prev.map((c) => results.find((r) => r.id === c.id) ?? c));
      // Includes a concurrent run reported by a conflict response.
      const next = await api.listConnections();
      if (syncFinished(results, next.connections)) finished.current();
      setCurrent(next.connections);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check sync progress.');
    } finally {
      lock.current = false;
      setStarting(false);
    }
  };
  if (!selected.length) return null;
  const moving = starting || syncMoving(selected);
  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
      <Button
        variant="outline"
        onClick={() => void start()}
        disabled={starting || syncShouldPoll(selected)}
      >
        {moving && (
          <span
            aria-hidden="true"
            className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
          />
        )}
        {moving ? 'Syncing…' : 'Sync now'}
      </Button>
      <p aria-live="polite" role="status" className="min-w-0 break-words text-caption text-muted">
        {syncStatus(selected)}
        {error ? ` · ${error}` : ''}
      </p>
    </div>
  );
}
