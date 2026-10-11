import { describe, expect, it } from 'vitest';
import {
  decideOverduePublish,
  PUBLISH_OVERDUE_GRACE_MS,
  PUBLISH_REQUEUE_WINDOW_MS,
  PUBLISH_SWEEP_INTERVAL_MS,
  strandedPublishMessage,
} from './publish-sweep.js';

/**
 * The sweep's policy as a pure function of the post, what the job engine holds for it, and the
 * clock. The locking and the writes are covered by publish-sweep.integration.test.ts.
 */
const NOW = new Date('2026-10-12T09:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;
const scheduled = (publishAt: Date | null, createdAt: Date = ago(24 * 60 * MIN)) => ({
  status: 'scheduled',
  publishAt,
  createdAt,
});

describe('decideOverduePublish', () => {
  it('leaves a post that is still in the future, whatever the job engine says', () => {
    const future = new Date(NOW.getTime() + 60 * MIN);
    for (const job of ['live', 'dead', 'none'] as const) {
      expect(decideOverduePublish(scheduled(future), job, NOW)).toEqual({ action: 'leave' });
    }
  });

  it('leaves a post that is due but inside the grace period', () => {
    const justDue = ago(PUBLISH_OVERDUE_GRACE_MS - 1);
    expect(decideOverduePublish(scheduled(justDue), 'none', NOW)).toEqual({ action: 'leave' });
    expect(decideOverduePublish(scheduled(justDue), 'dead', NOW)).toEqual({ action: 'leave' });
  });

  it('leaves an overdue post that has a live job — waiting, running, or between retries', () => {
    expect(decideOverduePublish(scheduled(ago(10 * MIN)), 'live', NOW)).toEqual({
      action: 'leave',
    });
    // Even far past the window: a backed-up queue is not a stranded post.
    expect(decideOverduePublish(scheduled(ago(26 * 60 * MIN)), 'live', NOW)).toEqual({
      action: 'leave',
    });
  });

  it.each(['draft', 'cancelled', 'failed', 'published', 'publishing'])(
    'never touches a %s post',
    (status) => {
      const post = { status, publishAt: ago(3 * 60 * MIN), createdAt: ago(5 * 60 * MIN) };
      expect(decideOverduePublish(post, 'none', NOW)).toEqual({ action: 'leave' });
      expect(decideOverduePublish(post, 'dead', NOW)).toEqual({ action: 'leave' });
    },
  );

  it.each(['published', 'scheduled', 'publishing', 'failed'])(
    'never queues or fails an imported post, even one that reads %s and long overdue',
    (status) => {
      const post = {
        status,
        source: 'imported',
        publishAt: ago(20 * MIN),
        createdAt: ago(60 * MIN),
      };
      for (const job of ['none', 'dead', 'live'] as const) {
        expect(decideOverduePublish(post, job, NOW)).toEqual({ action: 'leave' });
      }
    },
  );

  it('queues a post again when it has no job and is only slightly late', () => {
    expect(decideOverduePublish(scheduled(ago(PUBLISH_OVERDUE_GRACE_MS)), 'none', NOW)).toEqual({
      action: 'requeue',
      overdueMs: PUBLISH_OVERDUE_GRACE_MS,
    });
    expect(decideOverduePublish(scheduled(ago(PUBLISH_REQUEUE_WINDOW_MS)), 'none', NOW)).toEqual({
      action: 'requeue',
      overdueMs: PUBLISH_REQUEUE_WINDOW_MS,
    });
  });

  it('fails a post with no job once it is past the requeue window', () => {
    expect(
      decideOverduePublish(scheduled(ago(PUBLISH_REQUEUE_WINDOW_MS + 1)), 'none', NOW),
    ).toEqual({ action: 'fail', reason: 'too_late', overdueMs: PUBLISH_REQUEUE_WINDOW_MS + 1 });
    // The "9am post at 4pm the next day" case.
    expect(decideOverduePublish(scheduled(ago(31 * 60 * MIN)), 'none', NOW)).toMatchObject({
      action: 'fail',
      reason: 'too_late',
    });
  });

  it('fails a post whose job died, even when only slightly late — it is never run again', () => {
    expect(decideOverduePublish(scheduled(ago(6 * MIN)), 'dead', NOW)).toEqual({
      action: 'fail',
      reason: 'job_died',
      overdueMs: 6 * MIN,
    });
    expect(decideOverduePublish(scheduled(ago(3 * 60 * MIN)), 'dead', NOW)).toMatchObject({
      action: 'fail',
      reason: 'job_died',
    });
  });

  it('measures a publish-now post (no publishAt) from when it was created', () => {
    expect(decideOverduePublish(scheduled(null, ago(2 * MIN)), 'none', NOW)).toEqual({
      action: 'leave',
    });
    expect(decideOverduePublish(scheduled(null, ago(10 * MIN)), 'none', NOW)).toEqual({
      action: 'requeue',
      overdueMs: 10 * MIN,
    });
    expect(decideOverduePublish(scheduled(null, ago(90 * MIN)), 'none', NOW)).toMatchObject({
      action: 'fail',
      reason: 'too_late',
    });
  });

  it('is stable: the same post, job state and clock always give the same answer', () => {
    const post = scheduled(ago(12 * MIN));
    expect(decideOverduePublish(post, 'none', NOW)).toEqual(
      decideOverduePublish(post, 'none', NOW),
    );
  });
});

describe('sweep thresholds', () => {
  it('gives a slightly-late post at least two sweeps inside the requeue window', () => {
    // Otherwise a post could go from "too early to touch" straight to "too late to requeue".
    expect(PUBLISH_REQUEUE_WINDOW_MS - PUBLISH_OVERDUE_GRACE_MS).toBeGreaterThanOrEqual(
      2 * PUBLISH_SWEEP_INTERVAL_MS,
    );
  });
});

describe('strandedPublishMessage', () => {
  it('says how late a never-attempted post was and that it was not sent', () => {
    expect(strandedPublishMessage('too_late', 45 * MIN)).toBe(
      'Not published: no publish job was found 45 minutes after it was due, and it was not sent late automatically. Retry to publish it now.',
    );
    expect(strandedPublishMessage('too_late', 31 * 60 * MIN)).toContain('31 hours after');
    expect(strandedPublishMessage('too_late', 5 * 24 * 60 * MIN)).toContain('5 days after');
  });

  it('warns that a post whose job died may already be on the platform', () => {
    expect(strandedPublishMessage('job_died', 6 * MIN)).toContain(
      'check the account before retrying',
    );
  });
});
