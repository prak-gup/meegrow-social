import { describe, expect, it } from 'vitest';
import {
  ACTIVE_JOB_POLL_MS,
  ACTIVE_JOB_WAIT_MS,
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

/**
 * Retry racing the job that just failed the post: the post already reads `failed` (so a retry is
 * accepted) while its job is still active for a moment. An add in that moment used to be dropped.
 */
describe('schedulePublish while a job is still running under the post id', () => {
  /** A queue holding an active job for POST, and a sleep that runs `onTick` instead of waiting. */
  function racing(onTick: (ticks: number, jobs: ReturnType<typeof fakeQueue>['jobs']) => void) {
    const { queue, jobs } = fakeQueue();
    const running = { state: 'active', opts: { delay: 0 } as AddOpts, data: 'the old run' };
    jobs.set(publishJobId(POST), running);
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
      onTick(slept.length, jobs);
    };
    return { scheduler: createQueueScheduler(queue, sleep), jobs, slept };
  }

  it('waits for the running job to complete, then enqueues the retry', async () => {
    // Completes (and is removed, as removeOnComplete does) on the second look.
    const { scheduler, jobs, slept } = racing((ticks, q) => {
      if (ticks === 2) q.delete(publishJobId(POST));
    });

    await scheduler.schedulePublish({ ...input, when: 'now' });

    expect(slept).toEqual([ACTIVE_JOB_POLL_MS, ACTIVE_JOB_POLL_MS]);
    const job = jobs.get(publishJobId(POST))!;
    expect(job.data).toEqual(input);
    expect(job.state).toBe('waiting');
  });

  it('replaces the running job if it ends up failed — a dead job would block the add', async () => {
    const { scheduler, jobs } = racing((ticks, q) => {
      if (ticks === 1) q.get(publishJobId(POST))!.state = 'failed';
    });

    await scheduler.schedulePublish({ ...input, when: 'now' });

    expect(jobs.get(publishJobId(POST))).toMatchObject({ data: input, state: 'waiting' });
  });

  it('gives way to a job that is still running after the wait, without throwing', async () => {
    const { scheduler, jobs, slept } = racing(() => undefined);

    await expect(scheduler.schedulePublish({ ...input, when: 'now' })).resolves.toBeUndefined();

    // Bounded, and the running job is untouched: it reads the post as it is now.
    expect(slept.reduce((a, b) => a + b, 0)).toBe(ACTIVE_JOB_WAIT_MS);
    expect(jobs.get(publishJobId(POST))).toMatchObject({ data: 'the old run', state: 'active' });
  });

  it('does not wait at all when nothing is running', async () => {
    const { queue, jobs } = fakeQueue();
    const slept: number[] = [];
    const scheduler = createQueueScheduler(queue, async (ms) => void slept.push(ms));

    await scheduler.schedulePublish({ ...input, when: 'now' });
    expect(slept).toEqual([]);
    expect(jobs.size).toBe(1);
  });

  it('clears a dead job left under the id before adding', async () => {
    const { queue, jobs } = fakeQueue();
    jobs.set(publishJobId(POST), { state: 'failed', opts: { delay: 0 } as AddOpts, data: 'dead' });

    await createQueueScheduler(queue).schedulePublish({ ...input, when: 'now' });
    expect(jobs.get(publishJobId(POST))).toMatchObject({ data: input, state: 'waiting' });
  });

  it('still leaves a waiting or delayed job in place: a second add is ignored', async () => {
    const { queue, jobs } = fakeQueue();
    const scheduler = createQueueScheduler(queue);
    await scheduler.schedulePublish({ ...input, when: new Date(Date.now() + 3_600_000) });
    await scheduler.schedulePublish({ ...input, when: 'now' });
    expect(jobs.get(publishJobId(POST))!.opts.delay).toBeGreaterThan(0);
  });
});
