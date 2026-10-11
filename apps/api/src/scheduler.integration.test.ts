import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Queue, Worker } from 'bullmq';
import { createBullScheduler, publishJobId, PUBLISH_QUEUE } from './scheduler.js';
import type { PublishJobData } from './scheduler.js';
import { requireTestRedisUrl } from '@meegrow-social/testing';

/**
 * Exercises the REAL BullMQ adapter (needs Redis; CI provides it).
 *
 * Every other test that touches scheduling injects the recording scheduler from `testing/`, which
 * validates nothing. That gap let `jobId: 'publish:<uuid>'` reach production, where BullMQ rejects
 * any custom id containing ':' — stranding every scheduled post as 'scheduled' with no job. A fake
 * cannot catch a constraint only the real adapter enforces, so this suite drives the actual queue.
 */
const REDIS_URL = requireTestRedisUrl();

let queue: Queue<PublishJobData>;

beforeAll(() => {
  queue = new Queue<PublishJobData>(PUBLISH_QUEUE, { connection: { url: REDIS_URL } });
});

// Each test starts from an empty queue: the cases that take a job by hand (`getNextJob`) get the
// oldest waiting one, which would otherwise be a job an earlier test left behind.
beforeEach(async () => {
  await queue.obliterate({ force: true });
});

afterAll(async () => {
  await queue.obliterate({ force: true }).catch(() => undefined);
  await queue.close();
});

describe('createBullScheduler against real BullMQ', () => {
  it('actually enqueues a publish job (the regression that stranded every post)', async () => {
    const scheduler = createBullScheduler(REDIS_URL);
    const postId = '11111111-1111-4111-8111-111111111111';

    // The bug: this threw "Custom Id cannot contain :" and the caller had already committed the post.
    await scheduler.schedulePublish({ workspaceId: 'ws-1', postId, when: 'now' });

    const job = await queue.getJob(publishJobId(postId));
    expect(job).toBeDefined();
    expect(job!.data).toEqual({ workspaceId: 'ws-1', postId });
  });

  it('schedules a future post as a delayed job', async () => {
    const scheduler = createBullScheduler(REDIS_URL);
    const postId = '22222222-2222-4222-8222-222222222222';
    const when = new Date(Date.now() + 60_000);

    await scheduler.schedulePublish({ workspaceId: 'ws-1', postId, when });

    const job = await queue.getJob(publishJobId(postId));
    expect(job).toBeDefined();
    expect(job!.opts.delay).toBeGreaterThan(0);
  });

  it('cancelPublish removes the job (#5 cancel path)', async () => {
    const scheduler = createBullScheduler(REDIS_URL);
    const postId = '33333333-3333-4333-8333-333333333333';

    await scheduler.schedulePublish({
      workspaceId: 'ws-1',
      postId,
      when: new Date(Date.now() + 60_000),
    });
    expect(await queue.getJob(publishJobId(postId))).toBeDefined();

    await scheduler.cancelPublish({ postId });
    expect(await queue.getJob(publishJobId(postId))).toBeUndefined();
  });

  it('cancelling an unknown post is a safe no-op, not a throw', async () => {
    const scheduler = createBullScheduler(REDIS_URL);
    await expect(
      scheduler.cancelPublish({ postId: '44444444-4444-4444-8444-444444444444' }),
    ).resolves.not.toThrow();
  });

  // What the stranded-post sweep relies on (core/services/publish-sweep.ts).
  it('publishJobState: none without a job, live while one waits, none again once cancelled', async () => {
    const scheduler = createBullScheduler(REDIS_URL);
    const postId = '66666666-6666-4666-8666-666666666666';
    expect(await scheduler.publishJobState({ postId })).toBe('none');

    await scheduler.schedulePublish({
      workspaceId: 'ws-1',
      postId,
      when: new Date(Date.now() + 60_000),
    });
    expect(await scheduler.publishJobState({ postId })).toBe('live');

    await scheduler.cancelPublish({ postId });
    expect(await scheduler.publishJobState({ postId })).toBe('none');
  });

  it('publishJobState: dead for a job that failed for good, and a retry can replace it', async () => {
    const scheduler = createBullScheduler(REDIS_URL);
    const postId = '77777777-7777-4777-8777-777777777777';
    await scheduler.schedulePublish({ workspaceId: 'ws-1', postId, when: 'now' });

    // Take the job by hand and fail it without a retry — what BullMQ does to a job that stalls
    // past maxStalledCount, where the worker's own `failed` handler never runs.
    const worker = new Worker<PublishJobData>(PUBLISH_QUEUE, null, {
      connection: { url: REDIS_URL },
    });
    try {
      const job = await worker.getNextJob('test-token');
      expect(job?.id).toBe(publishJobId(postId));
      job!.discard();
      await job!.moveToFailed(new Error('worker died'), 'test-token', false);
    } finally {
      await worker.close();
    }
    expect(await scheduler.publishJobState({ postId })).toBe('dead');

    // The dead job still owns the id: an add is dropped until it is cancelled.
    await scheduler.cancelPublish({ postId });
    expect(await scheduler.publishJobState({ postId })).toBe('none');
    await scheduler.schedulePublish({ workspaceId: 'ws-1', postId, when: 'now' });
    expect(await scheduler.publishJobState({ postId })).toBe('live');
  });

  // Retry racing the job that just failed the post: the post already reads `failed`, so a retry
  // is accepted, while that job is still active for a moment. remove() cannot take a running job
  // and the add was dropped as a duplicate id — the retry vanished and the post was stranded.
  it('enqueues a retry issued while the previous job is still finishing', async () => {
    const scheduler = createBullScheduler(REDIS_URL);
    const postId = '88888888-8888-4888-8888-888888888888';
    await scheduler.schedulePublish({ workspaceId: 'ws-1', postId, when: 'now' });

    const worker = new Worker<PublishJobData>(PUBLISH_QUEUE, null, {
      connection: { url: REDIS_URL },
    });
    try {
      const running = await worker.getNextJob('test-token');
      expect(running?.id).toBe(publishJobId(postId));

      // What retryPost does, while the job is active...
      await scheduler.cancelPublish({ postId });
      const retry = scheduler.schedulePublish({ workspaceId: 'ws-1', postId, when: 'now' });
      // ...and the job completes a moment later (removeOnComplete then frees the id).
      await new Promise((r) => setTimeout(r, 300));
      await running!.moveToCompleted({ status: 'failed' }, 'test-token', false);
      await retry;
    } finally {
      await worker.close();
    }

    const job = await queue.getJob(publishJobId(postId));
    expect(job).toBeDefined();
    expect(await job!.getState()).toBe('waiting');
    expect(job!.attemptsMade).toBe(0);
  });

  // What retry relies on: publish job ids are deterministic per post, and BullMQ silently drops an
  // add() whose id still exists. The recording scheduler would accept the second add either way.
  it('re-adds a post after its job is cancelled — the cancel-then-schedule a retry does', async () => {
    const scheduler = createBullScheduler(REDIS_URL);
    const postId = '55555555-5555-4555-8555-555555555555';

    await scheduler.schedulePublish({
      workspaceId: 'ws-1',
      postId,
      when: new Date(Date.now() + 3_600_000),
    });
    const first = await queue.getJob(publishJobId(postId));
    expect(first!.opts.delay).toBeGreaterThan(0);

    // Without the cancel the second add is ignored and the hour-long delay stands.
    await scheduler.schedulePublish({ workspaceId: 'ws-1', postId, when: 'now' });
    expect((await queue.getJob(publishJobId(postId)))!.opts.delay).toBeGreaterThan(0);

    await scheduler.cancelPublish({ postId });
    await scheduler.schedulePublish({ workspaceId: 'ws-1', postId, when: 'now' });
    const retried = await queue.getJob(publishJobId(postId));
    expect(retried).toBeDefined();
    expect(retried!.opts.delay).toBe(0);
  });
});
