import { describe, expect, it } from 'vitest';
import {
  accountIsDue,
  ANALYTICS_CADENCE,
  ANALYTICS_SWEEP_INTERVAL_MS,
  FRESH_POST_WINDOW_MS,
  nextAccountDueAt,
  nextPostDueAt,
  POST_POLL_TIERS,
  postIsDue,
  postPollInterval,
  POSTS_PER_CONNECTION_PER_SWEEP,
  selectPostsToSweep,
} from './analytics.js';

/**
 * Cadence rules (#9): a post is polled hourly for its first 48h and daily after that; accounts are
 * polled daily. Pure functions, driven by an injected `now` — no DB, no clock mocking.
 */

const now = new Date('2026-07-16T12:00:00Z');
const ago = (ms: number): Date => new Date(now.getTime() - ms);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('postIsDue', () => {
  it('is due when never swept, whatever its age', () => {
    expect(postIsDue({ publishAt: ago(5 * MINUTE), lastAnalyticsAt: null, now })).toBe(true);
    expect(postIsDue({ publishAt: ago(400 * DAY), lastAnalyticsAt: null, now })).toBe(true);
  });

  describe('fresh post (< 48h old) — hourly', () => {
    const publishAt = ago(2 * HOUR);

    it('uses hourly cadence for a publish-now post stamped when it went out', () => {
      expect(postIsDue({ publishAt: now, lastAnalyticsAt: ago(HOUR), now })).toBe(true);
      expect(postIsDue({ publishAt: now, lastAnalyticsAt: ago(59 * MINUTE), now })).toBe(false);
    });

    it('is due an hour after the last sweep', () => {
      expect(postIsDue({ publishAt, lastAnalyticsAt: ago(HOUR), now })).toBe(true);
      expect(postIsDue({ publishAt, lastAnalyticsAt: ago(HOUR + MINUTE), now })).toBe(true);
    });

    it('is not due before the hour is up', () => {
      expect(postIsDue({ publishAt, lastAnalyticsAt: ago(59 * MINUTE), now })).toBe(false);
      expect(postIsDue({ publishAt, lastAnalyticsAt: now, now })).toBe(false);
    });
  });

  describe('mature post (>= 48h old) — daily', () => {
    const publishAt = ago(10 * DAY);

    it('is not due merely because an hour has passed', () => {
      expect(postIsDue({ publishAt, lastAnalyticsAt: ago(2 * HOUR), now })).toBe(false);
      expect(postIsDue({ publishAt, lastAnalyticsAt: ago(23 * HOUR), now })).toBe(false);
    });

    it('is due after a day', () => {
      expect(postIsDue({ publishAt, lastAnalyticsAt: ago(DAY), now })).toBe(true);
      expect(postIsDue({ publishAt, lastAnalyticsAt: ago(DAY + HOUR), now })).toBe(true);
    });
  });

  it('flips from hourly to daily exactly at the 48h boundary', () => {
    const sweptAnHourAgo = ago(HOUR);
    // One minute inside the window: still hourly, so an hour-old sweep is due again.
    expect(
      postIsDue({
        publishAt: ago(FRESH_POST_WINDOW_MS - MINUTE),
        lastAnalyticsAt: sweptAnHourAgo,
        now,
      }),
    ).toBe(true);
    // One minute past it: daily now, so the same hour-old sweep is NOT due.
    expect(
      postIsDue({
        publishAt: ago(FRESH_POST_WINDOW_MS + MINUTE),
        lastAnalyticsAt: sweptAnHourAgo,
        now,
      }),
    ).toBe(false);
  });

  it('treats a post with no publishAt as mature (daily), not fresh', () => {
    // publishAt is nullable; an unknown age must not pin a post to the expensive hourly cadence.
    expect(postIsDue({ publishAt: null, lastAnalyticsAt: ago(2 * HOUR), now })).toBe(false);
    expect(postIsDue({ publishAt: null, lastAnalyticsAt: ago(2 * DAY), now })).toBe(true);
  });
});

describe('accountIsDue', () => {
  it('is due when never swept', () => {
    expect(accountIsDue({ lastAnalyticsAt: null, now })).toBe(true);
  });

  it('is due once a day has passed, and not before', () => {
    expect(accountIsDue({ lastAnalyticsAt: ago(23 * HOUR), now })).toBe(false);
    expect(accountIsDue({ lastAnalyticsAt: ago(DAY), now })).toBe(true);
  });
});

describe('nextPostDueAt', () => {
  it('is now for a post that has never been swept', () => {
    expect(nextPostDueAt({ publishAt: ago(HOUR), lastAnalyticsAt: null, now })).toEqual(now);
  });

  it('is an hour after the last sweep while the post is fresh', () => {
    const last = ago(20 * MINUTE);
    expect(nextPostDueAt({ publishAt: ago(3 * HOUR), lastAnalyticsAt: last, now })).toEqual(
      new Date(last.getTime() + HOUR),
    );
  });

  it('is a day after the last sweep once the post is past the fresh window, or has no publish time', () => {
    const last = ago(2 * HOUR);
    const daily = new Date(last.getTime() + DAY);
    expect(nextPostDueAt({ publishAt: ago(10 * DAY), lastAnalyticsAt: last, now })).toEqual(daily);
    expect(nextPostDueAt({ publishAt: null, lastAnalyticsAt: last, now })).toEqual(daily);
  });

  it('is daily for a post that leaves the fresh window before its hourly poll comes round', () => {
    const publishAt = ago(FRESH_POST_WINDOW_MS - 10 * MINUTE);
    const last = ago(30 * MINUTE);
    expect(nextPostDueAt({ publishAt, lastAnalyticsAt: last, now })).toEqual(
      new Date(last.getTime() + DAY),
    );
  });

  it('agrees with postIsDue: not due a millisecond before, due at the instant it names', () => {
    const publishAges = [
      0,
      5 * MINUTE,
      47 * HOUR,
      FRESH_POST_WINDOW_MS - MINUTE,
      49 * HOUR,
      9 * DAY,
      // Either side of the weekly and four-weekly boundaries.
      30 * DAY - HOUR,
      31 * DAY,
      85 * DAY,
      90 * DAY - MINUTE,
      200 * DAY,
    ];
    const sweepAges = [0, MINUTE, 59 * MINUTE, 5 * HOUR, 3 * DAY, 20 * DAY];
    for (const publishAge of [...publishAges, null]) {
      for (const sweepAge of sweepAges) {
        const publishAt = publishAge === null ? null : ago(publishAge);
        const lastAnalyticsAt = ago(sweepAge);
        const due = nextPostDueAt({ publishAt, lastAnalyticsAt, now });
        const before = new Date(due.getTime() - 1);
        expect(postIsDue({ publishAt, lastAnalyticsAt, now: due })).toBe(true);
        expect(postIsDue({ publishAt, lastAnalyticsAt, now: before })).toBe(false);
      }
    }
  });
});

describe('nextAccountDueAt', () => {
  it('is now when never swept, else a day after the last sweep — where accountIsDue turns true', () => {
    expect(nextAccountDueAt({ lastAnalyticsAt: null, now })).toEqual(now);
    const lastAnalyticsAt = ago(3 * HOUR);
    const due = nextAccountDueAt({ lastAnalyticsAt, now });
    expect(due).toEqual(new Date(lastAnalyticsAt.getTime() + DAY));
    expect(accountIsDue({ lastAnalyticsAt, now: due })).toBe(true);
    expect(accountIsDue({ lastAnalyticsAt, now: new Date(due.getTime() - 1) })).toBe(false);
  });
});

describe('ANALYTICS_CADENCE', () => {
  it('states the rules the due checks apply, and a sweep no coarser than the finest of them', () => {
    expect(ANALYTICS_CADENCE).toEqual({
      sweepIntervalMs: HOUR,
      freshPostWindowMs: 48 * HOUR,
      freshPostIntervalMs: HOUR,
      postIntervalMs: DAY,
      accountIntervalMs: DAY,
    });
    expect(ANALYTICS_SWEEP_INTERVAL_MS).toBeLessThanOrEqual(ANALYTICS_CADENCE.freshPostIntervalMs);
  });
});

describe('poll cadence by age — old posts are asked about rarely', () => {
  it('is hourly for 48h, daily to 30 days, weekly to 90 days, then every four weeks', () => {
    expect(postPollInterval(0)).toBe(HOUR);
    expect(postPollInterval(47 * HOUR)).toBe(HOUR);
    expect(postPollInterval(48 * HOUR)).toBe(DAY);
    expect(postPollInterval(29 * DAY)).toBe(DAY);
    expect(postPollInterval(30 * DAY)).toBe(7 * DAY);
    expect(postPollInterval(89 * DAY)).toBe(7 * DAY);
    expect(postPollInterval(90 * DAY)).toBe(28 * DAY);
    expect(postPollInterval(900 * DAY)).toBe(28 * DAY);
  });

  it('only ever gets slower with age, and never slower than the 30-day metric retention', () => {
    const intervals = POST_POLL_TIERS.map((t) => t.intervalMs);
    expect([...intervals].sort((a, b) => a - b)).toEqual(intervals);
    expect(Math.max(...intervals)).toBeLessThan(30 * DAY);
    expect(POST_POLL_TIERS.at(-1)!.maxAgeMs).toBe(Infinity);
  });

  it('does not poll a two-month-old post daily, nor a year-old one weekly', () => {
    const twoMonths = ago(60 * DAY);
    expect(postIsDue({ publishAt: twoMonths, lastAnalyticsAt: ago(2 * DAY), now })).toBe(false);
    expect(postIsDue({ publishAt: twoMonths, lastAnalyticsAt: ago(7 * DAY), now })).toBe(true);
    const aYear = ago(365 * DAY);
    expect(postIsDue({ publishAt: aYear, lastAnalyticsAt: ago(8 * DAY), now })).toBe(false);
    expect(postIsDue({ publishAt: aYear, lastAnalyticsAt: ago(28 * DAY), now })).toBe(true);
  });
});

describe('selectPostsToSweep — the per-sweep budget', () => {
  const post = (connectionId: string, n: number, publishedAgo: number) => ({
    id: `${connectionId}-${n}`,
    connectionId,
    publishedAt: ago(publishedAgo),
  });

  it('takes everything when the due posts fit the budget', () => {
    const due = [post('fb', 1, DAY), post('ig', 1, 2 * DAY)];
    expect(selectPostsToSweep(due)).toEqual({ selected: due, deferred: 0 });
  });

  it('polls at most the budget of one account when an import adds hundreds at once', () => {
    const imported = Array.from({ length: 400 }, (_, n) => post('fb', n, (n + 1) * HOUR));
    const { selected, deferred } = selectPostsToSweep(imported);
    expect(selected).toHaveLength(POSTS_PER_CONNECTION_PER_SWEEP);
    expect(deferred).toBe(400 - POSTS_PER_CONNECTION_PER_SWEEP);
    // 25 posts × at most 6 metric calls: a sweep is bounded however much was imported.
    expect(POSTS_PER_CONNECTION_PER_SWEEP * 6).toBeLessThanOrEqual(150);
  });

  it('takes the newest first, so the posts still moving are never the ones left waiting', () => {
    const due = [post('fb', 1, 80 * DAY), post('fb', 2, HOUR), post('fb', 3, 10 * DAY)];
    expect(selectPostsToSweep(due, 2).selected.map((p) => p.id)).toEqual(['fb-2', 'fb-3']);
  });

  it('budgets each account on its own: one busy account never starves another', () => {
    const due = [
      ...Array.from({ length: 50 }, (_, n) => post('fb', n, (n + 1) * HOUR)),
      post('ig', 1, 300 * DAY),
    ];
    const { selected, deferred } = selectPostsToSweep(due, 10);
    expect(selected.filter((p) => p.connectionId === 'fb')).toHaveLength(10);
    expect(selected.some((p) => p.id === 'ig-1')).toBe(true);
    expect(deferred).toBe(40);
  });

  it('works the whole backlog off over successive sweeps', () => {
    let waiting = Array.from({ length: 60 }, (_, n) => post('fb', n, (n + 1) * HOUR));
    let sweeps = 0;
    while (waiting.length > 0) {
      const taken = new Set(selectPostsToSweep(waiting).selected.map((p) => p.id));
      waiting = waiting.filter((p) => !taken.has(p.id));
      sweeps += 1;
    }
    expect(sweeps).toBe(Math.ceil(60 / POSTS_PER_CONNECTION_PER_SWEEP));
  });
});
