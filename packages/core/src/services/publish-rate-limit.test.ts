import { describe, expect, it, vi } from 'vitest';
import { ProviderRateLimitError, RATE_LIMIT_MAX_MS } from '../errors.js';
import {
  nextRateLimitWait,
  rateLimitWaitMessage,
  readRateLimitWait,
  RATE_LIMIT_DEADLINE_MS,
} from './publish-rate-limit.js';
import { decideOverduePublish } from './publish-sweep.js';
import { mapMetaError } from '../providers/meta/client.js';
import { rateLimited, retryAfterHeader } from '../providers/shared/http.js';
import type { SafeResponse } from '../net/safe-fetch.js';

const due = new Date('2026-10-12T00:00:00Z');
const now = new Date(due.getTime() + 60_000);

describe('publish rate limits', () => {
  it('bounds platform delays between 30 seconds and 6 hours', () => {
    expect(new ProviderRateLimitError('limited', 0).retryAfterMs).toBe(30_000);
    expect(new ProviderRateLimitError('limited', 1000).retryAfterMs).toBe(30_000);
    expect(new ProviderRateLimitError('limited', 900_000).retryAfterMs).toBe(900_000);
    expect(new ProviderRateLimitError('limited', 48 * 3600_000).retryAfterMs).toBe(
      RATE_LIMIT_MAX_MS,
    );
  });
  it('escalates missing or invalid hints and eventually caps them', () => {
    for (const hint of [undefined, NaN, Infinity, -1]) {
      const err = new ProviderRateLimitError('limited', hint);
      expect(err.delayForPause(1)).toBe(120_000);
      expect(err.delayForPause(2)).toBe(240_000);
      expect(err.delayForPause(20)).toBe(RATE_LIMIT_MAX_MS);
    }
  });
  it('uses the original due time, round trips the durable note, and keeps its deadline', () => {
    const err = new ProviderRateLimitError('limited', 3600_000);
    const first = nextRateLimitWait(err, due, null, now)!;
    expect(first.retryAt.getTime()).toBe(now.getTime() + 3600_000);
    expect(first.deadline.getTime()).toBe(due.getTime() + RATE_LIMIT_DEADLINE_MS);
    expect(readRateLimitWait(rateLimitWaitMessage('telegram', first))).toEqual(first);
    const next = nextRateLimitWait(err, now, first, first.retryAt)!;
    expect(next.deadline).toEqual(first.deadline);
    expect(next.pauses).toBe(2);
    expect(readRateLimitWait('Some other failure')).toBeNull();
  });
  it('stops at the deadline and never shortens a requested window to fit', () => {
    const err = new ProviderRateLimitError('limited', 3600_000);
    expect(
      nextRateLimitWait(err, due, null, new Date(due.getTime() + RATE_LIMIT_DEADLINE_MS)),
    ).toBeNull();
    expect(
      nextRateLimitWait(err, due, null, new Date(due.getTime() + RATE_LIMIT_DEADLINE_MS - 1000)),
    ).toBeNull();
    expect(
      nextRateLimitWait(
        err,
        due,
        null,
        new Date(due.getTime() + RATE_LIMIT_DEADLINE_MS - 3600_000),
      )?.retryAt.getTime(),
    ).toBe(due.getTime() + RATE_LIMIT_DEADLINE_MS);
  });
  it('leaves live delayed jobs alone and recovers a missing waiting timer instead of failing it', () => {
    const wait = nextRateLimitWait(
      new ProviderRateLimitError('limited', 2 * 3600_000),
      due,
      null,
      now,
    )!;
    const post = {
      status: 'scheduled',
      publishAt: due,
      createdAt: due,
      error: rateLimitWaitMessage('telegram', wait),
    };
    const sweepAt = new Date(due.getTime() + 3600_000);
    expect(decideOverduePublish(post, 'live', sweepAt)).toEqual({ action: 'leave' });
    for (const job of ['none', 'dead'] as const)
      expect(decideOverduePublish(post, job, sweepAt)).toMatchObject({
        action: 'requeue',
        when: wait.retryAt,
      });
    expect(decideOverduePublish({ ...post, status: 'cancelled' }, 'none', sweepAt)).toEqual({
      action: 'leave',
    });
  });
  it('parses HTTP dates and preserves an explicit zero hint as the minimum delay', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(due.getTime());
    try {
      expect(
        retryAfterHeader({
          headers: { 'retry-after': new Date(due.getTime() + 1800_000).toUTCString() },
        } as SafeResponse),
      ).toBe(1800);
      expect(
        retryAfterHeader({ headers: { 'retry-after': 'invalid' } } as SafeResponse),
      ).toBeNull();
      expect(
        (
          mapMetaError(
            429,
            {},
            { get: (name) => (name === 'retry-after' ? '0' : null) },
          ) as ProviderRateLimitError
        ).retryAfterMs,
      ).toBe(30_000);
      expect((mapMetaError(429, {}) as ProviderRateLimitError).retryAfterMs).toBeUndefined();
    } finally {
      clock.mockRestore();
    }
  });
  it('preserves provider seconds and Meta usage minutes as typed milliseconds', () => {
    expect((rateLimited('Telegram', 1800) as ProviderRateLimitError).retryAfterMs).toBe(1800_000);
    const headers = {
      get: (name: string) =>
        name === 'retry-after'
          ? '120'
          : name === 'x-business-use-case-usage'
            ? JSON.stringify({ page: [{ estimated_time_to_regain_access: 60 }] })
            : null,
    };
    expect(
      (mapMetaError(400, { error: { code: 4 } }, headers) as ProviderRateLimitError).retryAfterMs,
    ).toBe(3600_000);
    expect(retryAfterHeader({ headers: { 'retry-after': '1800' } } as SafeResponse)).toBe(1800);
  });
});
