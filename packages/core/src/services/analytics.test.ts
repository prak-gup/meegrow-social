import { describe, expect, it } from 'vitest';
import { accountIsDue, FRESH_POST_WINDOW_MS, postIsDue } from './analytics.js';

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
