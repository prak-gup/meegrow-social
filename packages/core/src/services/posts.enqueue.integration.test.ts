import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, db, schema, withWorkspace } from '@meegrow-social/db';
import {
  createConnection,
  createWorkspace,
  resetDb,
  useRecordingScheduler,
} from '@meegrow-social/testing';
import { createPost, getPost, listPosts, retryPost, updatePost } from './posts.js';
import { publishPost } from './publish.js';
import { setScheduler, type Scheduler } from './scheduler.js';

/**
 * What happens when the job queue refuses a publish job AFTER the post row is committed. Before
 * this was handled, the post stayed `scheduled` with no job: promised, and never published.
 */
beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgres://mgs:mgs@localhost:5433/meegrow_social';
  process.env.APP_DATABASE_URL ??= 'postgres://mgs_app:mgs_app@localhost:5433/meegrow_social';
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
});
beforeEach(resetDb);
afterAll(closeDb);

const HOUR = 3_600_000;
const MESSAGE =
  'Could not be queued for publishing: redis is down. Nothing was sent — retry to queue it again.';

/** A queue that is down for scheduling, optionally only from the Nth `schedulePublish` on. */
function useFailingScheduler(failFromCall = 1): { cancels: string[]; scheduled: string[] } {
  const cancels: string[] = [];
  const scheduled: string[] = [];
  let calls = 0;
  const scheduler: Scheduler = {
    async schedulePublish({ postId }) {
      calls += 1;
      if (calls >= failFromCall) throw new Error('redis is down');
      scheduled.push(postId);
    },
    async cancelPublish({ postId }) {
      cancels.push(postId);
    },
    async publishJobState() {
      return 'none';
    },
  };
  setScheduler(scheduler);
  return { cancels, scheduled };
}

const publishLogs = (ws: string) =>
  withWorkspace(ws, (tx) => tx.select().from(schema.eventLogs)).then((rows) =>
    rows.filter((r) => r.kind === 'publish'),
  );

describe('createPost when the publish job cannot be enqueued', () => {
  it('rejects, and leaves the post failed with the reason rather than scheduled', async () => {
    useFailingScheduler();
    const ws = await createWorkspace();
    const conn = await createConnection(ws);

    await expect(
      createPost(ws, {
        caption: 'flu clinic opens at 9',
        media: [],
        variants: [{ connectionId: conn, provider: 'fake' }],
        schedule: { type: 'at', publishAt: new Date(Date.now() + 24 * HOUR) },
      }),
    ).rejects.toThrow('redis is down');

    const posts = await listPosts(ws);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ status: 'failed', error: MESSAGE });
    expect((await publishLogs(ws)).map((l) => [l.status, l.message])).toEqual([
      ['failed', MESSAGE],
    ]);
  });

  it('does the same for a publish-now post', async () => {
    useFailingScheduler();
    const ws = await createWorkspace();
    const conn = await createConnection(ws);

    await expect(
      createPost(ws, {
        caption: 'now',
        media: [],
        variants: [{ connectionId: conn, provider: 'fake' }],
        schedule: { type: 'now' },
      }),
    ).rejects.toThrow('redis is down');
    expect((await listPosts(ws))[0]).toMatchObject({ status: 'failed', error: MESSAGE });
  });

  it('fails every post of the call when only one enqueue fails, so nothing half-publishes', async () => {
    // The first variant's job is accepted, the second's is not.
    const { cancels, scheduled } = useFailingScheduler(2);
    const ws = await createWorkspace();
    const a = await createConnection(ws, 'fake', 'Page A', { externalId: 'ext-a' });
    const b = await createConnection(ws, 'fake', 'Page B', { externalId: 'ext-b' });

    await expect(
      createPost(ws, {
        caption: 'both or neither',
        media: [],
        variants: [
          { connectionId: a, provider: 'fake' },
          { connectionId: b, provider: 'fake' },
        ],
        schedule: { type: 'now' },
      }),
    ).rejects.toThrow('redis is down');

    const posts = await listPosts(ws);
    expect(posts.map((p) => p.status)).toEqual(['failed', 'failed']);
    // Both jobs are cleared, including the one that was accepted...
    expect([...cancels].sort()).toEqual(posts.map((p) => p.id).sort());
    // ...and if that job fires anyway it is refused: the caller was told the call failed.
    expect(await publishPost(ws, scheduled[0]!)).toMatchObject({ status: 'skipped' });
    expect((await getPost(ws, scheduled[0]!))!.status).toBe('failed');
  });

  it('leaves a draft alone — nothing is enqueued for one', async () => {
    useFailingScheduler();
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const [post] = await createPost(ws, {
      caption: 'draft',
      media: [],
      variants: [{ connectionId: conn, provider: 'fake' }],
      schedule: { type: 'draft' },
    });
    expect(post).toMatchObject({ status: 'draft', error: null });
  });

  it('replays the failed posts for a repeated idempotent create instead of creating more', async () => {
    useFailingScheduler();
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const input = {
      caption: 'keyed',
      media: [],
      variants: [{ connectionId: conn, provider: 'fake' as const }],
      schedule: { type: 'now' as const },
    };
    await expect(createPost(ws, input, { idempotencyKey: 'k-1' })).rejects.toThrow();

    const { calls } = useRecordingScheduler();
    const replay = await createPost(ws, input, { idempotencyKey: 'k-1' });
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({ status: 'failed', error: MESSAGE });
    expect(calls).toEqual([]);
    expect(await listPosts(ws)).toHaveLength(1);
  });
});

describe('retrying a post that could not be queued', () => {
  it('queues it for its scheduled time when that is still ahead, not for now', async () => {
    useFailingScheduler();
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const publishAt = new Date(Date.now() + 24 * HOUR);
    await createPost(ws, {
      caption: 'tomorrow 9am',
      media: [],
      variants: [{ connectionId: conn, provider: 'fake' }],
      schedule: { type: 'at', publishAt },
    }).catch(() => undefined);
    const [failed] = await listPosts(ws);

    const { calls } = useRecordingScheduler();
    const retried = await retryPost(ws, failed!.id);

    expect(retried).toMatchObject({ status: 'scheduled', error: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.postId).toBe(failed!.id);
    expect((calls[0]!.when as Date).getTime()).toBe(publishAt.getTime());
  });

  it('publishes now when the scheduled time has passed', async () => {
    useFailingScheduler();
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    await createPost(ws, {
      caption: 'was due an hour ago',
      media: [],
      variants: [{ connectionId: conn, provider: 'fake' }],
      schedule: { type: 'at', publishAt: new Date(Date.now() + HOUR) },
    }).catch(() => undefined);
    const [failed] = await listPosts(ws);
    await db()
      .update(schema.posts)
      .set({ publishAt: new Date(Date.now() - HOUR) })
      .where(eq(schema.posts.id, failed!.id));

    const { calls } = useRecordingScheduler();
    await retryPost(ws, failed!.id);
    expect(calls).toEqual([{ postId: failed!.id, when: 'now' }]);
  });
});

describe('updatePost when the job cannot be (re)scheduled', () => {
  it('fails a draft that could not be scheduled, keeping the edit', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const [draft] = await createPost(ws, {
      caption: 'draft',
      media: [],
      variants: [{ connectionId: conn, provider: 'fake' }],
      schedule: { type: 'draft' },
    });
    const publishAt = new Date(Date.now() + 24 * HOUR);

    useFailingScheduler();
    await expect(updatePost(ws, draft!.id, { caption: 'edited', publishAt })).rejects.toThrow(
      'redis is down',
    );

    const post = await getPost(ws, draft!.id);
    expect(post).toMatchObject({ status: 'failed', error: MESSAGE, caption: 'edited' });
    expect(post!.publishAt!.getTime()).toBe(publishAt.getTime());
  });

  it('fails a scheduled post whose reschedule could not be queued', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const [scheduled] = await createPost(ws, {
      caption: 'scheduled',
      media: [],
      variants: [{ connectionId: conn, provider: 'fake' }],
      schedule: { type: 'at', publishAt: new Date(Date.now() + HOUR) },
    });

    useFailingScheduler();
    await expect(
      updatePost(ws, scheduled!.id, { publishAt: new Date(Date.now() + 2 * HOUR) }),
    ).rejects.toThrow('redis is down');
    expect(await getPost(ws, scheduled!.id)).toMatchObject({ status: 'failed', error: MESSAGE });
  });
});
