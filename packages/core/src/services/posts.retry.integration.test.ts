import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, db, schema, withWorkspace } from '@meegrow-social/db';
import {
  createConnection,
  createWorkspace,
  resetDb,
  useRecordingScheduler,
} from '@meegrow-social/testing';
import { ProviderAuthError, ProviderBadRequestError, ProviderTransientError } from '../errors.js';
import { registerProvider } from '../providers/registry.js';
import type { AuthTokens, PostResult, SocialProvider } from '../providers/types.js';
import { createPost, getPost, PostStateError, retryPost } from './posts.js';
import { publishPost, recordPublishExhaustion } from './publish.js';
import { setScheduler } from './scheduler.js';

beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgres://mgs:mgs@localhost:5433/meegrow_social';
  process.env.APP_DATABASE_URL ??= 'postgres://mgs_app:mgs_app@localhost:5433/meegrow_social';
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
  registerProvider(flaky);
});
beforeEach(() => {
  sent.length = 0;
  failWith = null;
  return resetDb();
});
afterAll(closeDb);

/** Every caption the platform was actually handed — one entry per real publish attempt. */
const sent: string[] = [];
/** Set to make the stub's `post()` fail the way a real platform would. */
let failWith: Error | null = null;

/**
 * A platform that can be made to fail, registered under `x` (an identifier with no options arm and
 * no real provider yet). A caption containing "FAIL" is rejected only while `failWith` is set, so
 * one variant of a group can fail while its sibling publishes.
 */
const flaky: SocialProvider = {
  identifier: 'x',
  displayName: 'Flaky (stub)',
  isBetweenSteps: false,
  tokenModel: 'auto-refresh',
  maxConcurrentJobs: 1,
  async generateAuthUrl() {
    return { url: 'https://example.test/auth' };
  },
  async authenticate(): Promise<AuthTokens> {
    throw new Error('not exercised');
  },
  async refreshToken(): Promise<AuthTokens> {
    throw new Error('not exercised');
  },
  async post(_tokens, details): Promise<PostResult> {
    const caption = details[0]!.caption;
    if (failWith && caption.includes('FAIL')) throw failWith;
    sent.push(caption);
    return {
      externalPostId: `x-${sent.length}`,
      releaseUrl: `https://x.test/p/${sent.length}`,
    };
  },
  async postAnalytics() {
    return [];
  },
  async accountAnalytics() {
    return [];
  },
};

async function setStatus(postId: string, status: string): Promise<void> {
  // Test setup only — admin handle (like resetDb) bypasses RLS to force a status.
  await db().update(schema.posts).set({ status }).where(eq(schema.posts.id, postId));
}

/** A publish-now post on the flaky platform that has genuinely failed through `publishPost`. */
async function seedFailedPost(ws: string, caption = 'will FAIL') {
  const conn = await createConnection(ws, 'x');
  const [post] = await createPost(ws, {
    caption,
    variants: [{ connectionId: conn, provider: 'x' }],
    schedule: { type: 'now' },
  });
  failWith = new ProviderBadRequestError('the platform said no');
  const outcome = await publishPost(ws, post!.id);
  expect(outcome.status).toBe('failed');
  return { conn, postId: post!.id };
}

describe('retryPost', () => {
  it('puts a failed post back to scheduled and re-enqueues it through the scheduler', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const { postId } = await seedFailedPost(ws);
    expect(await getPost(ws, postId)).toMatchObject({
      status: 'failed',
      error: 'the platform said no',
    });

    // A fresh recorder, so only what the retry itself does is counted.
    const { calls, cancels } = useRecordingScheduler();
    const retried = await retryPost(ws, postId);

    expect(retried).toMatchObject({ id: postId, status: 'scheduled', error: null });
    expect(await getPost(ws, postId)).toMatchObject({ status: 'scheduled', error: null });
    // Re-enqueued, not published inline: the platform has still only ever refused it.
    expect(calls).toEqual([{ postId, when: 'now' }]);
    expect(cancels).toEqual([postId]);
    expect(sent).toEqual([]);
  });

  it('the re-enqueued job publishes through the normal path once the cause is fixed', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const { postId } = await seedFailedPost(ws);

    failWith = null;
    await retryPost(ws, postId);
    // What the worker does when the job fires.
    const outcome = await publishPost(ws, postId);

    expect(outcome.status).toBe('published');
    expect(sent).toEqual(['will FAIL']);
    expect(await getPost(ws, postId)).toMatchObject({
      status: 'published',
      error: null,
      releaseUrl: 'https://x.test/p/1',
    });
  });

  it('a retry that fails again leaves the post failed with the new reason, and retryable', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const { postId } = await seedFailedPost(ws);

    await retryPost(ws, postId);
    failWith = new ProviderBadRequestError('still no');
    await publishPost(ws, postId);
    expect(await getPost(ws, postId)).toMatchObject({ status: 'failed', error: 'still no' });

    await expect(retryPost(ws, postId)).resolves.toMatchObject({ status: 'scheduled' });
  });

  it.each(['draft', 'scheduled', 'publishing', 'published', 'cancelled'])(
    'refuses a %s post with PostStateError and enqueues nothing',
    async (status) => {
      useRecordingScheduler();
      const ws = await createWorkspace();
      const { postId } = await seedFailedPost(ws);
      await setStatus(postId, status);

      const { calls, cancels } = useRecordingScheduler();
      await expect(retryPost(ws, postId)).rejects.toThrow(PostStateError);
      await expect(retryPost(ws, postId)).rejects.toThrow(`a '${status}' post cannot be retried`);

      expect(calls).toEqual([]);
      expect(cancels).toEqual([]);
      expect((await getPost(ws, postId))?.status).toBe(status);
    },
  );

  it('cannot double-post the variant of a group that already went out', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const connA = await createConnection(ws, 'x', 'A', { externalId: 'ext-a' });
    const connB = await createConnection(ws, 'x', 'B', { externalId: 'ext-b' });
    const [good, bad] = await createPost(ws, {
      caption: 'group',
      variants: [
        { connectionId: connA, provider: 'x', caption: 'goes out' },
        { connectionId: connB, provider: 'x', caption: 'will FAIL' },
      ],
      schedule: { type: 'now' },
    });
    failWith = new ProviderBadRequestError('no');
    expect((await publishPost(ws, good!.id)).status).toBe('published');
    expect((await publishPost(ws, bad!.id)).status).toBe('failed');
    expect(sent).toEqual(['goes out']);

    // The published sibling is refused outright...
    const { calls } = useRecordingScheduler();
    await expect(retryPost(ws, good!.id)).rejects.toThrow(PostStateError);
    expect(calls).toEqual([]);

    // ...and retrying the failed one touches only itself.
    failWith = null;
    await retryPost(ws, bad!.id);
    expect(calls).toEqual([{ postId: bad!.id, when: 'now' }]);
    await publishPost(ws, bad!.id);
    expect(sent).toEqual(['goes out', 'will FAIL']);

    // Even a stale job firing for either post now reaches the platform zero more times.
    await publishPost(ws, good!.id);
    await publishPost(ws, bad!.id);
    expect(sent).toEqual(['goes out', 'will FAIL']);
    expect((await getPost(ws, good!.id))?.status).toBe('published');
  });

  it('of two concurrent retries exactly one enqueues', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const { postId } = await seedFailedPost(ws);

    const { calls } = useRecordingScheduler();
    const results = await Promise.allSettled([retryPost(ws, postId), retryPost(ws, postId)]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [rejected] = results.filter((r) => r.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(PostStateError);
    expect(calls).toEqual([{ postId, when: 'now' }]);
  });

  it("returns null for an unknown post and for another workspace's post, which it leaves alone", async () => {
    useRecordingScheduler();
    const mine = await createWorkspace('Mine');
    const theirs = await createWorkspace('Theirs');
    const { postId } = await seedFailedPost(theirs);

    const { calls } = useRecordingScheduler();
    expect(await retryPost(mine, '00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(await retryPost(mine, postId)).toBeNull();
    expect(calls).toEqual([]);
    expect((await getPost(theirs, postId))?.status).toBe('failed');
  });

  it('restores failed + the original reason when the scheduler cannot take the job', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const { postId } = await seedFailedPost(ws);

    setScheduler({
      async schedulePublish() {
        throw new Error('redis is down');
      },
      async cancelPublish() {},
      async publishJobState() {
        return 'none';
      },
    });
    await expect(retryPost(ws, postId)).rejects.toThrow('redis is down');

    // Not stranded as `scheduled` with no job behind it — and still retryable.
    expect(await getPost(ws, postId)).toMatchObject({
      status: 'failed',
      error: 'the platform said no',
    });
    const { calls } = useRecordingScheduler();
    await retryPost(ws, postId);
    expect(calls).toEqual([{ postId, when: 'now' }]);
  });

  it('retries a post that failed on auth; the account still needs a human', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const conn = await createConnection(ws, 'x');
    const [post] = await createPost(ws, {
      caption: 'will FAIL',
      variants: [{ connectionId: conn, provider: 'x' }],
      schedule: { type: 'now' },
    });
    failWith = new ProviderAuthError('token revoked');
    await publishPost(ws, post!.id);

    await expect(retryPost(ws, post!.id)).resolves.toMatchObject({ status: 'scheduled' });
    // Retrying does not clear the flag: only a reconnect does.
    const [row] = await db()
      .select({ needsReconnect: schema.connections.needsReconnect })
      .from(schema.connections)
      .where(eq(schema.connections.id, conn));
    expect(row?.needsReconnect).toBe(true);
  });
});

/**
 * A transient platform error on every attempt. `publishPost` rethrows it and its transaction rolls
 * back, so the post still reads `scheduled`; the job runner then reports the exhaustion.
 */
describe('recordPublishExhaustion', () => {
  const exhaustion = (ws: string, postId: string) => ({
    workspaceId: ws,
    postId,
    queue: 'publish',
    payload: { workspaceId: ws, postId },
    error: 'platform returned 503',
    attempts: 3,
  });

  async function seedExhaustedPost(ws: string) {
    const conn = await createConnection(ws, 'x', 'Flaky Account');
    const [post] = await createPost(ws, {
      caption: 'will FAIL',
      variants: [{ connectionId: conn, provider: 'x' }],
      schedule: { type: 'now' },
    });
    failWith = new ProviderTransientError('platform returned 503');
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(publishPost(ws, post!.id)).rejects.toThrow('platform returned 503');
    }
    return post!.id;
  }

  it('a transient failure alone leaves the post scheduled — intermediate attempts change nothing', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const postId = await seedExhaustedPost(ws);
    expect(await getPost(ws, postId)).toMatchObject({ status: 'scheduled', error: null });
  });

  it('marks the exhausted post failed with the reason, logs it, and writes the DLQ row', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const postId = await seedExhaustedPost(ws);

    expect(await recordPublishExhaustion(exhaustion(ws, postId))).toEqual({
      postMarkedFailed: true,
      dlqRecorded: true,
    });

    expect(await getPost(ws, postId)).toMatchObject({
      status: 'failed',
      error: 'Publishing failed after 3 attempts: platform returned 503',
    });
    const { dlq, logs } = await withWorkspace(ws, async (tx) => ({
      dlq: await tx.select().from(schema.jobsDlq),
      logs: await tx.select().from(schema.eventLogs),
    }));
    expect(dlq).toHaveLength(1);
    expect(dlq[0]).toMatchObject({
      queue: 'publish',
      payload: { workspaceId: ws, postId },
      error: 'platform returned 503',
    });
    expect(logs.filter((l) => l.kind === 'publish' && l.status === 'failed')).toMatchObject([
      { platform: 'x', account: 'Flaky Account' },
    ]);
  });

  it('the failed post is then retryable, and publishes exactly once', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const postId = await seedExhaustedPost(ws);
    await recordPublishExhaustion(exhaustion(ws, postId));

    failWith = null;
    const { calls } = useRecordingScheduler();
    expect(await retryPost(ws, postId)).toMatchObject({ status: 'scheduled', error: null });
    expect(calls).toEqual([{ postId, when: 'now' }]);
    expect((await publishPost(ws, postId)).status).toBe('published');
    expect(sent).toEqual(['will FAIL']);
  });

  it.each(['published', 'cancelled', 'draft'])(
    'never touches a %s post: it stays as it is and stays un-retryable',
    async (status) => {
      useRecordingScheduler();
      const ws = await createWorkspace();
      const postId = await seedExhaustedPost(ws);
      await setStatus(postId, status);

      expect(await recordPublishExhaustion(exhaustion(ws, postId))).toEqual({
        postMarkedFailed: false,
        dlqRecorded: true,
      });
      expect(await getPost(ws, postId)).toMatchObject({ status, error: null });
      await expect(retryPost(ws, postId)).rejects.toBeInstanceOf(PostStateError);
    },
  );

  it("cannot reach another workspace's post", async () => {
    useRecordingScheduler();
    const mine = await createWorkspace('Mine');
    const theirs = await createWorkspace('Theirs');
    const postId = await seedExhaustedPost(theirs);

    expect((await recordPublishExhaustion(exhaustion(mine, postId))).postMarkedFailed).toBe(false);
    expect(await getPost(theirs, postId)).toMatchObject({ status: 'scheduled' });
  });
});
