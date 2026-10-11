import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, db, schema } from '@meegrow-social/db';
import {
  createConnection,
  createWorkspace,
  resetDb,
  useRecordingScheduler,
  useTestDatabaseEnv,
} from '@meegrow-social/testing';
import {
  calendarPosts,
  cancelPost,
  createPost,
  getPost,
  getPostGroup,
  listPosts,
  PostStateError,
  updatePost,
} from './posts.js';

beforeAll(() => {
  useTestDatabaseEnv();
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
});
beforeEach(resetDb);
afterAll(closeDb);

const NONEXISTENT = '00000000-0000-0000-0000-000000000000';
const futureMs = (ms: number) => new Date(Date.now() + ms);

async function seedScheduledPost(
  ws: string,
  conn: string,
  publishAt: Date = futureMs(60_000),
  caption = 'c',
) {
  const posts = await createPost(ws, {
    caption,
    variants: [{ connectionId: conn, provider: 'fake' }],
    schedule: { type: 'at', publishAt },
  });
  return posts[0]!;
}

async function setStatus(_ws: string, postId: string, status: string): Promise<void> {
  // Test setup only — admin handle (like resetDb) bypasses RLS to force a terminal status.
  await db().update(schema.posts).set({ status }).where(eq(schema.posts.id, postId));
}

describe('post lifecycle — publish now', () => {
  it('stores no scheduled time, enqueues immediately, and remains listable', async () => {
    const { calls } = useRecordingScheduler();
    const ws = await createWorkspace();
    const conn = await createConnection(ws);

    const [post] = await createPost(ws, {
      caption: 'publish immediately',
      variants: [{ connectionId: conn, provider: 'fake' }],
      schedule: { type: 'now' },
    });

    expect(post?.publishAt).toBeNull();
    expect(calls).toContainEqual({ postId: post!.id, when: 'now' });
    expect((await listPosts(ws)).map((listed) => listed.id)).toContain(post!.id);
  });
});

describe('post lifecycle — cancel', () => {
  it('cancels a scheduled post, sets status cancelled, and interrupts the job', async () => {
    const { cancels } = useRecordingScheduler();
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const post = await seedScheduledPost(ws, conn);

    expect(await cancelPost(ws, post.id)).toBe(true);
    expect(cancels).toContain(post.id);
    expect((await getPost(ws, post.id))?.status).toBe('cancelled');
  });

  it('refuses to cancel a post past the point of no return', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const post = await seedScheduledPost(ws, conn);
    await setStatus(ws, post.id, 'published');

    await expect(cancelPost(ws, post.id)).rejects.toBeInstanceOf(PostStateError);
  });

  it('returns false for a missing post', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    expect(await cancelPost(ws, NONEXISTENT)).toBe(false);
  });
});

describe('post lifecycle — edit', () => {
  it("edits a scheduled post's caption without touching the job", async () => {
    const { calls, cancels } = useRecordingScheduler();
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const post = await seedScheduledPost(ws, conn);
    const callsBefore = calls.length;

    const updated = await updatePost(ws, post.id, { caption: 'edited caption' });
    expect(updated?.caption).toBe('edited caption');
    expect(calls.length).toBe(callsBefore); // no reschedule
    expect(cancels).toHaveLength(0); // no cancel
  });

  it('reschedules the job when publishAt changes on a scheduled post', async () => {
    const { calls, cancels } = useRecordingScheduler();
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const post = await seedScheduledPost(ws, conn, futureMs(60_000));
    const callsBefore = calls.length;
    const newWhen = futureMs(120_000);

    await updatePost(ws, post.id, { publishAt: newWhen });

    expect(cancels).toContain(post.id); // old job interrupted
    expect(calls.length).toBe(callsBefore + 1); // new job scheduled
    const row = await getPost(ws, post.id);
    expect(row?.publishAt?.getTime()).toBe(newWhen.getTime());
    expect(row?.status).toBe('scheduled');
  });

  it('demotes to draft + cancels the job when publishAt is cleared', async () => {
    const { cancels } = useRecordingScheduler();
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const post = await seedScheduledPost(ws, conn);

    await updatePost(ws, post.id, { publishAt: null });

    expect(cancels).toContain(post.id);
    const row = await getPost(ws, post.id);
    expect(row?.status).toBe('draft');
    expect(row?.publishAt).toBeNull();
  });

  it('promotes a draft to scheduled when publishAt is set', async () => {
    const { calls } = useRecordingScheduler();
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const [draft] = await createPost(ws, {
      caption: 'd',
      variants: [{ connectionId: conn, provider: 'fake' }],
      schedule: { type: 'draft' },
    });
    const callsBefore = calls.length;
    const when = futureMs(60_000);

    await updatePost(ws, draft!.id, { publishAt: when });

    expect(calls.length).toBe(callsBefore + 1);
    const row = await getPost(ws, draft!.id);
    expect(row?.status).toBe('scheduled');
    expect(row?.publishAt?.getTime()).toBe(when.getTime());
  });

  it('refuses to edit a published post', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const post = await seedScheduledPost(ws, conn);
    await setStatus(ws, post.id, 'published');

    await expect(updatePost(ws, post.id, { caption: 'x' })).rejects.toBeInstanceOf(PostStateError);
  });

  it('returns null for a missing post', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    expect(await updatePost(ws, NONEXISTENT, { caption: 'x' })).toBeNull();
  });
});

describe('post list — filters, ordering, pagination', () => {
  it('filters by status / connectionId / date-range and orders publishAt asc nulls-last', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const conn1 = await createConnection(ws, 'fake', 'A');
    const conn2 = await createConnection(ws, 'fake', 'B');
    const t1 = futureMs(60_000);
    const t2 = futureMs(120_000);

    const p1 = await seedScheduledPost(ws, conn1, t1, 'p1'); // scheduled, conn1, t1
    const p2 = await seedScheduledPost(ws, conn2, t2, 'p2'); // scheduled, conn2, t2
    const [p3] = await createPost(ws, {
      caption: 'p3',
      variants: [{ connectionId: conn1, provider: 'fake' }],
      schedule: { type: 'draft' },
    }); // draft (null publishAt), conn1

    // status filter excludes the draft
    const scheduled = await listPosts(ws, { status: 'scheduled' });
    expect(scheduled.map((p) => p.id).sort()).toEqual([p1.id, p2.id].sort());

    // connection filter
    const onConn1 = await listPosts(ws, { connectionId: conn1 });
    expect(onConn1.map((p) => p.id).sort()).toEqual([p1.id, p3!.id].sort());

    // date range picks only p2
    const mid = new Date((t1.getTime() + t2.getTime()) / 2);
    const inRange = await listPosts(ws, { from: mid });
    expect(inRange.map((p) => p.id)).toEqual([p2.id]);

    // ordering: publishAt asc nulls last → p1(t1), p2(t2), p3(null)
    const ordered = await listPosts(ws, {});
    expect(ordered.map((p) => p.id)).toEqual([p1.id, p2.id, p3!.id]);

    // pagination
    expect((await listPosts(ws, { limit: 1, offset: 0 })).map((p) => p.id)).toEqual([p1.id]);
    expect((await listPosts(ws, { limit: 1, offset: 1 })).map((p) => p.id)).toEqual([p2.id]);
  });
});

describe('calendar + group view', () => {
  it('buckets posts by their calendar day in the requested timezone', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    // 2026-01-15 00:30 UTC → calendar day 2026-01-14 in America/New_York (EST -5), 2026-01-15 in UTC.
    const when = new Date(Date.UTC(2026, 0, 15, 0, 30));
    await seedScheduledPost(ws, conn, when);

    const byUtc = await calendarPosts(ws, { year: 2026, month: 1, timezone: 'UTC' });
    expect(byUtc.days).toHaveLength(1);
    expect(byUtc.days[0]?.date).toBe('2026-01-15');

    const byNy = await calendarPosts(ws, { year: 2026, month: 1, timezone: 'America/New_York' });
    expect(byNy.days[0]?.date).toBe('2026-01-14');

    // out-of-range month returns nothing
    const empty = await calendarPosts(ws, { year: 2026, month: 2, timezone: 'UTC' });
    expect(empty.days).toHaveLength(0);
  });

  it('returns the group with all platform children', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const connA = await createConnection(ws, 'fake', 'A');
    const connB = await createConnection(ws, 'fake', 'B');
    const posts = await createPost(ws, {
      caption: 'group caption',
      variants: [
        { connectionId: connA, provider: 'fake', caption: 'A variant' },
        { connectionId: connB, provider: 'fake' },
      ],
      schedule: { type: 'draft' },
    });

    const group = await getPostGroup(ws, posts[0]!.groupId);
    expect(group).not.toBeNull();
    expect(group!.caption).toBe('group caption');
    expect(group!.posts).toHaveLength(2);
    expect(group!.posts.map((p) => p.connectionId).sort()).toEqual([connA, connB].sort());

    expect(await getPostGroup(ws, NONEXISTENT)).toBeNull();
  });
});
