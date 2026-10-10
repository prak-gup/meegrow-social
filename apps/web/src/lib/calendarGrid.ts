import type { CalendarDay, PostView } from '@meegrow-social/contracts';
import { parsePublishAt } from './postDate';

/** The calendar API accepts years 2000–2100 (contracts/posts.ts calendarPostsQuery). */
export const MIN_YEAR = 2000;
export const MAX_YEAR = 2100;

/** 0 = Sunday, 1 = Monday. */
export type WeekStart = 0 | 1;

export interface GridDay {
  /** YYYY-MM-DD, the same key the calendar API buckets posts under. */
  date: string;
  /** Day of the month, 1–31. */
  day: number;
  /** False for the leading/trailing days borrowed from the adjacent months. */
  inMonth: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');

function keyOf(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Weeks (rows) of a month grid. `month` is 1–12. Only as many weeks as the month needs (4–6). */
export function buildMonthGrid(year: number, month: number, weekStart: WeekStart = 1): GridDay[][] {
  // UTC arithmetic keeps DST shifts from nudging a day across midnight.
  const leading = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() - weekStart + 7) % 7;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const weekCount = Math.ceil((leading + daysInMonth) / 7);
  return Array.from({ length: weekCount }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => {
      const cell = new Date(Date.UTC(year, month - 1, 1 + w * 7 + d - leading));
      return {
        date: keyOf(cell),
        day: cell.getUTCDate(),
        inMonth: cell.getUTCMonth() === month - 1,
      };
    }),
  );
}

/** Move a (year, month) cursor by whole months, rolling over the year in either direction. */
export function shiftMonth(year: number, month: number, delta: number) {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** Whether shifting by `delta` months stays inside the range the API accepts. */
export function canShiftMonth(year: number, month: number, delta: number): boolean {
  const next = shiftMonth(year, month, delta);
  return next.year >= MIN_YEAR && next.year <= MAX_YEAR;
}

/** Today's YYYY-MM-DD in the browser's timezone — the timezone the calendar is requested in. */
export function todayKey(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A YYYY-MM-DD key as a local date (at noon, so formatting never slips a day). */
export function parseDateKey(key: string): Date {
  const [y = 0, m = 1, d = 1] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

/**
 * Shape the API's days for display: drop posts the viewer may not see (dev providers) and posts
 * with no real date, drop days left empty, and order days and the posts within them by time.
 */
export function prepareDays(
  days: CalendarDay[],
  isVisible: (provider: string) => boolean,
): CalendarDay[] {
  const time = (p: PostView) => parsePublishAt(p.publishAt)?.getTime() ?? 0;
  return days
    .map((day) => ({
      ...day,
      posts: day.posts
        .filter((p) => isVisible(p.provider) && parsePublishAt(p.publishAt) !== null)
        .sort((a, b) => time(a) - time(b)),
    }))
    .filter((day) => day.posts.length > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}
