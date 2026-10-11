import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, db, schema, withWorkspace } from '@meegrow-social/db';
import {
  createConnection,
  createWorkspace,
  resetDb,
  useRecordingScheduler,
} from '@meegrow-social/testing';
import { registerProvider } from '../providers/registry.js';
import type { AuthTokens, PostResult, SocialProvider } from '../providers/types.js';
import { createPost, getPost } from './posts.js';
import { publishPost } from './publish.js';
import { sweepStrandedPublishes, sweepStrandedPublishesForWorkspace } from './publish-sweep.js';

/**
 * The stranded-post sweep against real Postgres: the candidate query, the row lock it resolves
 * each post under (`FOR UPDATE SKIP LOCKED`), and its writes. The job engine is the recording
 * scheduler, whose `jobs` map the tests edit to stage a lost or dead job.
 */
beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgres://mgs:mgs@localhost:5433/meegrow_social';
  process.env.APP_DATABASE_URL ??= 'postgres://mgs_app:mgs_app@localhost:5433/meegrow_social';
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
  registerProvider(slow);
});
beforeEach(() => {
  sent.length = 0;
  hold = null;
  entered = null;
  return resetDb();
});
afterAll(closeDb);

const MIN = 60_000;
/** One connection per workspace, shared by every post a test seeds in it. */
const connections = new Map<string, string>();
const sent: string[] = [];
let hold: Promise<void> | null = null;
let entered: (() => void) | null = null;

/** A platform whose `post()` can be held open, registered under `x` (no real provider yet). */
const slow: SocialProvider = {
  identifier: 'x',
  displayName: 'Slow (stub)',
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
    entered?.();
    if (hold) await hold;
    sent.push(details[0]!.caption);
    return { externalPostId: `x-${sent.length}`, releaseUrl: `https://x.test/p/${sent.length}` };
  },
  async postAnalytics() {
    return [];
  },
  async accountAnalytics() {
    return [];
  },
};

/**
 * A `scheduled` post that was due `overdueMs` ago. Created for the future (as a real one is), then
 * back-dated on the admin handle, like `setStatus` in the lifecycle tests.
 */
async function seedOverdue(ws: string, overdueMs: number, caption = 'flu clinic opens at 9') {
  const conn = connections.get(ws) ?? (await createConnection(ws, 'x'));
  connections.set(ws, conn);
  const [post] = await createPost(ws, {
    caption,
    media: [],
    variants: [{ connectionId: conn, provider: 'x' }],
    schedule: { type: 'at', publishAt: new Date(Date.now() + 60 * MIN) },
  });
  await db()
    .update(schema.posts)
    .set({ publishAt: new Date(Date.now() - overdueMs) })
    .where(eq(schema.posts.id, post!.id));
  return post!.id;
}

const rows = <T>(ws: string, table: 'eventLogs' | 'jobsDlq') =>
  withWorkspace(ws, (tx) => tx.select().from(schema[table])) as Promise<T[]>;
const publishLogStatuses = async (ws: string) =>
  (await rows<{ kind: string; status: string | null }>(ws, 'eventLogs'))
    .filter((l) => l.kind === 'publish')
    .map((l) => l.status);

describe('stranded-post sweep', () => {
  it('queues a slightly-overdue post that has no job, and it then publishes once', async () => {
    const scheduler = useRecordingScheduler();
    const ws = await createWorkspace();
    const postId = await seedOverdue(ws, 10 * MIN);
    // The enqueue was lost: the post says scheduled but nothing will publish it.
    scheduler.jobs.delete(postId);
    scheduler.calls.length = 0;

    const result = await sweepStrandedPublishes();

    expect(result).toEqual({ examined: 1, requeued: 1, failed: 0, errors: [] });
    expect(scheduler.calls).toEqual([{ postId, when: 'now' }]);
    expect(await getPost(ws, postId)).toMatchObject({ status: 'scheduled', error: null });
    expect(await publishLogStatuses(ws)).toEqual(['requeued']);

    // The job it queued runs — and a second, stray run of it sends nothing more.
    expect((await publishPost(ws, postId)).status).toBe('published');
    expect((await publishPost(ws, postId)).status).toBe('published');
    expect(sent).toHaveLength(1);
  });

  it('fails a long-overdue post that has no job instead of publishing it late', async () => {
    const scheduler = useRecordingScheduler();
    const ws = await createWorkspace();
    const postId = await seedOverdue(ws, 31 * 60 * MIN);
    scheduler.jobs.delete(postId);
    scheduler.calls.length = 0;

    const result = await sweepStrandedPublishes();

    expect(result).toEqual({ examined: 1, requeued: 0, failed: 1, errors: [] });
    expect(scheduler.calls).toEqual([]);
    const post = await getPost(ws, postId);
    expect(post!.status).toBe('failed');
    expect(post!.error).toContain('no publish job was found 31 hours after it was due');
    expect(await publishLogStatuses(ws)).toEqual(['failed']);
    const dlq = await rows<{ queue: string; payload: unknown; error: string }>(ws, 'jobsDlq');
    expect(dlq).toHaveLength(1);
    expect(dlq[0]).toMatchObject({ queue: 'publish', payload: { workspaceId: ws, postId } });
    expect(sent).toEqual([]);
  });

  it('fails a post whose job died (stalled out) without running it again', async () => {
    const scheduler = useRecordingScheduler();
    const ws = await createWorkspace();
    const postId = await seedOverdue(ws, 8 * MIN);
    scheduler.jobs.set(postId, 'dead');
    scheduler.calls.length = 0;

    expect(await sweepStrandedPublishes()).toMatchObject({ requeued: 0, failed: 1 });

    expect(scheduler.calls).toEqual([]);
    const post = await getPost(ws, postId);
    expect(post!.status).toBe('failed');
    expect(post!.error).toContain('check the account before retrying');
  });

  it('leaves posts that are legitimately waiting: future, just due, or with a live job', async () => {
    const scheduler = useRecordingScheduler();
    const ws = await createWorkspace();
    const future = await seedOverdue(ws, -6 * 60 * MIN);
    const justDue = await seedOverdue(ws, 2 * MIN);
    const backedUp = await seedOverdue(ws, 3 * 60 * MIN);
    // Not even a job behind the first two: still none of the sweep's business yet.
    scheduler.jobs.delete(future);
    scheduler.jobs.delete(justDue);
    scheduler.calls.length = 0;

    expect(await sweepStrandedPublishes()).toEqual({
      examined: 1, // only the backed-up one is overdue enough to be looked at
      requeued: 0,
      failed: 0,
      errors: [],
    });

    expect(scheduler.calls).toEqual([]);
    expect(scheduler.cancels).toEqual([]);
    for (const id of [future, justDue, backedUp]) {
      expect(await getPost(ws, id)).toMatchObject({ status: 'scheduled', error: null });
    }
    expect(await publishLogStatuses(ws)).toEqual([]);
    expect(await rows(ws, 'jobsDlq')).toEqual([]);
  });

  it('leaves drafts, cancelled, failed and published posts alone however old they are', async () => {
    const scheduler = useRecordingScheduler();
    const ws = await createWorkspace();
    const ids: string[] = [];
    for (const status of ['draft', 'cancelled', 'failed', 'published']) {
      const id = await seedOverdue(ws, 31 * 60 * MIN);
      await db().update(schema.posts).set({ status }).where(eq(schema.posts.id, id));
      scheduler.jobs.delete(id);
      ids.push(id);
    }

    expect(await sweepStrandedPublishes()).toEqual({
      examined: 0,
      requeued: 0,
      failed: 0,
      errors: [],
    });
    expect((await Promise.all(ids.map((id) => getPost(ws, id)))).map((p) => p!.status)).toEqual([
      'draft',
      'cancelled',
      'failed',
      'published',
    ]);
  });

  it('skips a post that is being published right now, and does not wait for it', async () => {
    const scheduler = useRecordingScheduler();
    const ws = await createWorkspace();
    const postId = await seedOverdue(ws, 31 * 60 * MIN);
    // Its job is running (so not in the queue's waiting set) and holds the row mid-upload.
    scheduler.jobs.delete(postId);
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    const inFlight = new Promise<void>((r) => (entered = r));
    const publishing = publishPost(ws, postId);
    await inFlight;

    // Would be "fail: too late" on state alone; the row lock says someone is sending it.
    const result = await sweepStrandedPublishesForWorkspace(ws);
    expect(result).toEqual({ examined: 1, requeued: 0, failed: 0, errors: [] });

    release();
    expect((await publishing).status).toBe('published');
    expect(await getPost(ws, postId)).toMatchObject({ status: 'published', error: null });
    expect(sent).toHaveLength(1);
  });

  it('is idempotent: a second sweep changes nothing', async () => {
    const scheduler = useRecordingScheduler();
    const ws = await createWorkspace();
    const late = await seedOverdue(ws, 10 * MIN);
    const tooLate = await seedOverdue(ws, 5 * 60 * MIN);
    scheduler.jobs.delete(late);
    scheduler.jobs.delete(tooLate);
    scheduler.calls.length = 0;

    expect(await sweepStrandedPublishes()).toMatchObject({ requeued: 1, failed: 1 });
    // `late` now has a live job and `tooLate` is no longer scheduled.
    expect(await sweepStrandedPublishes()).toEqual({
      examined: 1,
      requeued: 0,
      failed: 0,
      errors: [],
    });

    expect(scheduler.calls).toEqual([{ postId: late, when: 'now' }]);
    expect(await rows(ws, 'jobsDlq')).toHaveLength(1);
  });

  it('queues a post once when two workers sweep at the same moment', async () => {
    const scheduler = useRecordingScheduler();
    const ws = await createWorkspace();
    const postId = await seedOverdue(ws, 10 * MIN);
    scheduler.jobs.delete(postId);
    scheduler.calls.length = 0;

    const [a, b] = await Promise.all([sweepStrandedPublishes(), sweepStrandedPublishes()]);

    // One holds the row; the other skips it (locked) or arrives after and finds the live job.
    expect(a.requeued + b.requeued).toBe(1);
    expect(scheduler.calls).toEqual([{ postId, when: 'now' }]);
    expect(await publishLogStatuses(ws)).toEqual(['requeued']);
  });

  it('sweeps every workspace and keeps each one to its own posts', async () => {
    const scheduler = useRecordingScheduler();
    const wsA = await createWorkspace('A');
    const wsB = await createWorkspace('B');
    const inA = await seedOverdue(wsA, 5 * 60 * MIN);
    const inB = await seedOverdue(wsB, 10 * MIN);
    scheduler.jobs.delete(inA);
    scheduler.jobs.delete(inB);

    expect(await sweepStrandedPublishes()).toMatchObject({ examined: 2, requeued: 1, failed: 1 });
    expect(await getPost(wsA, inA)).toMatchObject({ status: 'failed' });
    expect(await getPost(wsB, inB)).toMatchObject({ status: 'scheduled' });
    expect(await rows(wsB, 'jobsDlq')).toEqual([]);
  });
});
