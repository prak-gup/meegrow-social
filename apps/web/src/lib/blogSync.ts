import type { ConnectionView } from '@meegrow-social/contracts';
import { importBusy, importMoving } from './postImport';

type Site = Pick<ConnectionView, 'id' | 'provider' | 'displayName' | 'import'>;
export function syncSites<T extends Site>(connections: readonly T[], site = ''): T[] {
  return connections.filter((c) => c.provider === 'wordpress' && (!site || c.id === site));
}
export const syncShouldPoll = (sites: readonly Site[]) => sites.some((c) => importBusy(c.import));
export const syncMoving = (sites: readonly Site[]) => sites.some((c) => importMoving(c.import));
export function syncFinished(before: readonly Site[], after: readonly Site[]): boolean {
  return before.some(
    (c) =>
      importBusy(c.import) && after.some((next) => next.id === c.id && !importBusy(next.import)),
  );
}
const dateText = (value: Date | string) =>
  new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
export function syncResult(sites: readonly Site[]): string | null {
  const done = sites.filter((c) => c.import?.status === 'done');
  if (!done.length) return null;
  const imported = done.reduce((n, c) => n + c.import!.imported, 0);
  const removed = done.reduce((n, c) => n + c.import!.removed, 0);
  // matched counts recognised articles, including unchanged ones; it is not an update count.
  return imported || removed
    ? [`${imported} new`, ...(removed ? [`${removed} removed on platform`] : [])].join(', ')
    : 'Up to date';
}
export function syncStatus(sites: readonly Site[]): string {
  return sites
    .map((c) => {
      const view = c.import;
      const last = view?.lastSyncedAt
        ? `Last synced ${dateText(view.lastSyncedAt)}`
        : 'Not synced yet';
      const state =
        view?.status === 'paused'
          ? `Paused${view.resumeAt ? ` · resumes ${dateText(view.resumeAt)}` : ' · resumes automatically'}`
          : view?.status === 'failed'
            ? 'Sync failed'
            : view?.status === 'queued'
              ? 'Sync queued'
              : view?.status === 'running'
                ? 'Syncing…'
                : syncResult([c]);
      return [
        sites.length > 1 ? `${c.displayName}: ${last}` : last,
        'syncs automatically every 6 hours',
        state,
        view?.message && (view.status === 'failed' || view.status === 'paused' || view.capped)
          ? view.message
          : null,
      ]
        .filter(Boolean)
        .join(' · ');
    })
    .join(' | ');
}
