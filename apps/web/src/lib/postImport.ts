import type { ConnectionImportView, ConnectionView } from '@meegrow-social/contracts';
import { shortDateTime } from './postGroups';

/**
 * Pure logic for "Import past posts" on Connections, and for what the other screens say while an
 * import is under way. Everything is read from `connection.import` as the API reports it.
 */

type Import = ConnectionImportView | undefined;

/**
 * The windows the API accepts — `IMPORT_WINDOW_DAYS` in contracts, repeated here because the
 * contracts root is not imported at runtime (it would bundle the zod schemas). postImport.test.ts
 * holds the two equal.
 */
export const IMPORT_WINDOWS = [
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
  { days: 180, label: 'Last 6 months' },
  { days: 365, label: 'Last 12 months' },
] as const;
export type ImportWindowDays = (typeof IMPORT_WINDOWS)[number]['days'];
export const DEFAULT_IMPORT_WINDOW: ImportWindowDays = 90;

/** How often to re-read the connections while an import is under way. */
export const IMPORT_POLL_MS = 5_000;

/** Can this account's past posts be imported at all? */
export const canImport = (c: Pick<ConnectionView, 'import'>): boolean =>
  c.import?.supported === true;

/** An import has been asked for and has not finished: queued, reading, or waiting out a limit. */
export function importBusy(view: Import): boolean {
  return view?.status === 'queued' || view?.status === 'running' || view?.status === 'paused';
}

/** Worth polling for: `paused` can sit for half an hour, so only the two that move soon. */
export function importMoving(view: Import): boolean {
  return view?.status === 'queued' || view?.status === 'running';
}

const at = (value: Date | string | null | undefined): Date | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * The one line under an account's name while its import is under way; null otherwise, so a
 * finished import leaves the row as it was.
 */
export function importRowNote(view: Import, now: Date = new Date()): string | null {
  switch (view?.status) {
    case 'queued':
      return 'Past posts: import queued';
    case 'running':
      return 'Importing past posts…';
    case 'paused': {
      const resume = at(view.resumeAt);
      return resume
        ? `Import paused · continues ${shortDateTime(resume, now)}`
        : 'Import paused · continues by itself';
    }
    default:
      return null;
  }
}

/** What the last run did, as counts: "42 imported · 3 already here · 1 removed on platform". */
export function importCounts(view: ConnectionImportView): string {
  const parts = [`${view.imported.toLocaleString()} imported`];
  if (view.matched > 0) parts.push(`${view.matched.toLocaleString()} already here`);
  if (view.removed > 0) parts.push(`${view.removed.toLocaleString()} removed on platform`);
  return parts.join(' · ');
}

export interface ImportSummary {
  /** "Last import", "Importing now", … */
  heading: string;
  /** When and what, in one line; null when there is nothing to say yet. */
  detail: string | null;
  /** Why it paused or failed, or what was left out. */
  message: string | null;
  tone: 'neutral' | 'warn' | 'bad';
}

/** The "last import" block of the dialog: state, time and result, and anything that needs a person. */
export function importSummary(view: Import, now: Date = new Date()): ImportSummary {
  if (!view?.status) {
    return {
      heading: 'Not imported yet',
      detail: null,
      message: null,
      tone: 'neutral',
    };
  }
  const window = view.windowDays ? `last ${view.windowDays} days` : null;
  switch (view.status) {
    case 'queued':
      return {
        heading: 'Import queued',
        detail: [window, 'starts within a minute'].filter(Boolean).join(' · '),
        message: null,
        tone: 'neutral',
      };
    case 'running':
      return {
        heading: 'Importing now',
        detail: [window, importCounts(view) + ' so far'].filter(Boolean).join(' · '),
        message: null,
        tone: 'neutral',
      };
    case 'paused': {
      const resume = at(view.resumeAt);
      return {
        heading: resume ? `Paused · continues ${shortDateTime(resume, now)}` : 'Paused',
        detail: importCounts(view) + ' so far',
        message: view.message,
        tone: 'warn',
      };
    }
    case 'failed': {
      const finished = at(view.finishedAt);
      return {
        heading: finished
          ? `Last import failed · ${shortDateTime(finished, now)}`
          : 'Last import failed',
        detail: importCounts(view),
        message: view.message,
        tone: 'bad',
      };
    }
    case 'done': {
      const finished = at(view.finishedAt) ?? at(view.lastSyncedAt);
      return {
        heading: finished ? `Last import · ${shortDateTime(finished, now)}` : 'Last import',
        detail: importCounts(view),
        // A capped run is complete but partial: that has to be seen, not buried in a count.
        message: view.capped ? view.message : null,
        tone: view.capped ? 'warn' : 'neutral',
      };
    }
  }
}

/** Accounts whose past posts are still being brought in. */
export function importingAccounts<C extends Pick<ConnectionView, 'import' | 'displayName'>>(
  connections: readonly C[],
): C[] {
  return connections.filter((c) => importBusy(c.import));
}

/**
 * What an empty Content, Calendar or Analytics screen says while an import is under way, so a
 * newly connected account does not read as "nothing here". Null when no import is running — the
 * screen's own empty state stands.
 */
export function importingNote(
  connections: readonly Pick<ConnectionView, 'import' | 'displayName'>[],
): string | null {
  const busy = importingAccounts(connections);
  if (busy.length === 0) return null;
  const who = busy.length === 1 ? busy[0]!.displayName : `${plural(busy.length, 'account')}`;
  return `Past posts from ${who} are being imported. They appear here as they arrive — usually within a few minutes.`;
}

/** The same, for Analytics, where the posts arriving is not yet the numbers arriving. */
export function importingAnalyticsNote(
  connections: readonly Pick<ConnectionView, 'import' | 'displayName'>[],
): string | null {
  const note = importingNote(connections);
  return note
    ? `${note} Their numbers are collected over the following hours, newest posts first.`
    : null;
}
