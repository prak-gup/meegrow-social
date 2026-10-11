import type { AnalyticsStatusView } from '@meegrow-social/contracts';

/**
 * What the Analytics and Content screens say about collection and roles: the sync line's wording,
 * a metric name made readable, and who counts as a client. The numbers themselves are computed in
 * core (`GET /v1/analytics/report`); the helpers for showing them are in `analyticsReport.ts`.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** "hourly", "daily", or "every N hours" — an interval as the API reports it, in words. */
export function cadenceWord(ms: number): string {
  if (ms === HOUR_MS) return 'hourly';
  if (ms === DAY_MS) return 'daily';
  if (ms === 7 * DAY_MS) return 'weekly';
  if (ms > DAY_MS && ms % DAY_MS === 0) return `every ${ms / DAY_MS} days`;
  const hours = ms / HOUR_MS;
  return Number.isInteger(hours)
    ? `every ${hours} hours`
    : `every ${Math.round(ms / 60_000)} minutes`;
}

/**
 * The collection rules as one line, from the cadence the API reports — never from text written
 * here. e.g. "posts refresh hourly for 48 h, then daily · followers daily".
 */
export function cadenceText(cadence: AnalyticsStatusView['cadence']): string {
  const fresh = Math.round(cadence.freshPostWindowMs / HOUR_MS);
  // Old posts are asked about less often; say so, or "then daily" overstates it.
  const older = (cadence.olderPosts ?? [])
    .map((o) => `, ${cadenceWord(o.intervalMs)} after ${Math.round(o.afterMs / DAY_MS)} days`)
    .join('');
  return (
    `posts refresh ${cadenceWord(cadence.freshPostIntervalMs)} for ${fresh} h, ` +
    `then ${cadenceWord(cadence.postIntervalMs)}${older} · followers ${cadenceWord(cadence.accountIntervalMs)}`
  );
}

export type NextRefresh =
  /** Nothing can be polled: no account with a working connection. */
  | { kind: 'none' }
  /** Something is already due; it is collected at the next run. */
  | { kind: 'due' }
  /** Nothing is due before `at` (epoch ms); the first run at or after it collects. */
  | { kind: 'at'; at: number };

/** When the next collection falls due, from `GET /v1/analytics/status`. */
export function nextRefresh(
  status: Pick<AnalyticsStatusView, 'nextDueAt'>,
  now: number,
): NextRefresh {
  if (status.nextDueAt === null) return { kind: 'none' };
  const at = new Date(status.nextDueAt).getTime();
  if (Number.isNaN(at)) return { kind: 'none' };
  return at <= now ? { kind: 'due' } : { kind: 'at', at };
}

/** Cosmetic only — underscores to spaces, first letter capitalised. Never a rename map. */
export function humanizeMetric(name: string): string {
  const spaced = name.replace(/_/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Is this membership role a client's? Clients get the same screen without operator affordances.
 * `viewer` counts until the roles matrix (#20) adds `client`. Cosmetic only: the API does not
 * enforce the role yet.
 */
export function isClientRole(role: string | null | undefined): boolean {
  return role === 'client' || role === 'viewer';
}
