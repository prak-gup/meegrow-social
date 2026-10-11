import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import { createBullScheduler, publishJobId, PUBLISH_QUEUE } from './scheduler.js';
import type { PublishJobData } from './scheduler.js';

/**
 * Exercises the REAL BullMQ adapter (needs Redis; CI provides it).
 *
 * Every other test that touches scheduling injects the recording scheduler from `testing/`, which
 * validates nothing. That gap let `jobId: 'publish:<uuid>'` reach production, where BullMQ rejects
 * any custom id containing ':' — stranding every scheduled post as 'scheduled' with no job. A fake
 * cannot catch a constraint only the real adapter enforces, so this suite drives the actual queue.
 */
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

let queue: Queue<PublishJobData>;

beforeAll(() => {
  queue = new Queue<PublishJobData>(PUBLISH_QUEUE, { connection: { url: REDIS_URL } });
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
