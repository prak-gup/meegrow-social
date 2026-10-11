import { describe, expect, it } from 'vitest';
import {
  createQueueScheduler,
  PUBLISH_ATTEMPTS,
  PUBLISH_BACKOFF_MS,
  publishJobId,
  toPublishJobState,
  type PublishJobQueue,
} from './publish-queue.js';

/**
 * The scheduler against an in-memory queue that keeps BullMQ's rules: an add whose id exists is
 * dropped, a running job cannot be removed. The real queue is exercised by
 * apps/api/src/scheduler.integration.test.ts (needs Redis).
 */
type AddOpts = Parameters<PublishJobQueue['add']>[2];

function fakeQueue() {
  const jobs = new Map<string, { state: string; opts: AddOpts; data: unknown }>();
  const queue: PublishJobQueue = {
    async add(_name, data, opts) {
      if (opts.jobId.includes(':')) throw new Error('Custom Id cannot contain :');
      if (!jobs.has(opts.jobId)) {
        jobs.set(opts.jobId, { state: opts.delay > 0 ? 'delayed' : 'waiting', opts, data });
      }
      return undefined;
    },
    async getJob(jobId) {
      const job = jobs.get(jobId);
      return job ? { getState: async () => jobs.get(jobId)?.state ?? 'unknown' } : undefined;
    },
    async remove(jobId) {
      if (!jobs.has(jobId) || jobs.get(jobId)!.state === 'active') return 0;
      jobs.delete(jobId);
      return 1;
    },
  };
  return { queue, jobs };
}

const POST = '4e0a8d7e-4e80-4d00-aea2-fd055f0fdb08';
const input = { workspaceId: 'ws-1', postId: POST };

describe('toPublishJobState', () => {
  it.each(['waiting', 'delayed', 'active', 'prioritized', 'waiting-children'])(
    'treats a %s job as live',
    (state) => expect(toPublishJobState(state)).toBe('live'),
  );

  it('treats a failed job as dead: it exists but will never run again', () => {
    expect(toPublishJobState('failed')).toBe('dead');
  });

  it('treats a missing, completed or vanished job as none', () => {
    expect(toPublishJobState(undefined)).toBe('none');
    expect(toPublishJobState('completed')).toBe('none');
    expect(toPublishJobState('unknown')).toBe('none');
  });

  it('treats a state it does not know as live, so the sweep leaves the post alone', () => {
    expect(toPublishJobState('some-future-state')).toBe('live');
  });
});

describe('createQueueScheduler', () => {
  it('enqueues a publish-now job with the retry policy and the deterministic id', async () => {
    const { queue, jobs } = fakeQueue();
    await createQueueScheduler(queue).schedulePublish({ ...input, when: 'now' });
    const job = jobs.get(publishJobId(POST))!;
    expect(job.data).toEqual(input);
    expect(job.opts).toEqual({
      delay: 0,
      jobId: `publish-${POST}`,
      attempts: PUBLISH_ATTEMPTS,
      backoff: { type: 'exponential', delay: PUBLISH_BACKOFF_MS },
      removeOnComplete: true,
      removeOnFail: false,
    });
  });

  it('keeps the retry policy few and fast: 3 attempts, 2 minutes base backoff', () => {
    expect(PUBLISH_ATTEMPTS).toBe(3);
    expect(PUBLISH_BACKOFF_MS).toBe(120_000);
  });

  it('delays a future post until its time and never passes a negative delay', async () => {
    const { queue, jobs } = fakeQueue();
    const scheduler = createQueueScheduler(queue);
    await scheduler.schedulePublish({ ...input, when: new Date(Date.now() + 3_600_000) });
    const delay = jobs.get(publishJobId(POST))!.opts.delay;
    expect(delay).toBeGreaterThan(3_590_000);
    expect(delay).toBeLessThanOrEqual(3_600_000);

    jobs.clear();
    await scheduler.schedulePublish({ ...input, when: new Date(Date.now() - 60_000) });
    expect(jobs.get(publishJobId(POST))!.opts.delay).toBe(0);
  });

  it('cancels by the deterministic id; cancelling nothing is a no-op', async () => {
    const { queue, jobs } = fakeQueue();
    const scheduler = createQueueScheduler(queue);
    await scheduler.schedulePublish({ ...input, when: new Date(Date.now() + 60_000) });
    await scheduler.cancelPublish({ postId: POST });
    expect(jobs.size).toBe(0);
    await expect(scheduler.cancelPublish({ postId: POST })).resolves.toBeUndefined();
  });

  it('reports what stands behind a post', async () => {
    const { queue, jobs } = fakeQueue();
    const scheduler = createQueueScheduler(queue);
    expect(await scheduler.publishJobState({ postId: POST })).toBe('none');

    await scheduler.schedulePublish({ ...input, when: new Date(Date.now() + 60_000) });
    expect(await scheduler.publishJobState({ postId: POST })).toBe('live');

    jobs.get(publishJobId(POST))!.state = 'active';
    expect(await scheduler.publishJobState({ postId: POST })).toBe('live');

    // Stalled out or exhausted: kept in the failed set (removeOnFail is false).
    jobs.get(publishJobId(POST))!.state = 'failed';
    expect(await scheduler.publishJobState({ postId: POST })).toBe('dead');
  });
});
