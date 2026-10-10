import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, db, schema } from '@meegrow-social/db';
import {
  createConnection,
  createWorkspace,
  resetDb,
  useRecordingScheduler,
} from '@meegrow-social/testing';
import { createPost, duplicatePost, getPost, getPostGroup, listPosts } from './posts.js';

beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgres://prakhar@localhost:5432/meegrow_social';
  process.env.APP_DATABASE_URL ??= 'postgres://mgs_app:mgs_app@localhost:5432/meegrow_social';
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
});
beforeEach(resetDb);
afterAll(closeDb);

const NONEXISTENT = '00000000-0000-0000-0000-000000000000';
const MEDIA = [{ mediaId: '7b0f6a52-3f0e-4c59-9f0b-2f4f0a6f7c11', kind: 'image' as const }];

describe('duplicatePost (D1)', () => {
  it("copies the post's own caption, media and options into a new draft group", async () => {
    const { calls } = useRecordingScheduler();
    const ws = await createWorkspace();
    const conn = await createConnection(ws, 'instagram');
    const options = { kind: 'meta' as const, format: 'feed' as const };
    const [source] = await createPost(ws, {
      caption: 'group caption',
      media: [],
      variants: [
        {
          connectionId: conn,
          provider: 'instagram',
          caption: 'variant caption',
          media: MEDIA,
          options,
        },
      ],
      schedule: { type: 'at', publishAt: new Date(Date.now() + 60_000) },
    });
    const scheduledBefore = calls.length;

    const copy = await duplicatePost(ws, source!.id);

    expect(copy).toMatchObject({
      provider: 'instagram',
      connectionId: conn,
      caption: 'variant caption',
      options,
      status: 'draft',
      publishAt: null,
      queueId: null,
    });
    expect(copy!.id).not.toBe(source!.id);
    expect(copy!.groupId).not.toBe(source!.groupId);
    // The variant's media, not the (empty) group media of the source.
    expect((await getPostGroup(ws, copy!.groupId))?.media).toEqual(MEDIA);
    // A copy never publishes by itself.
    expect(calls.length).toBe(scheduledBefore);
  });

  it('leaves the source untouched, and duplicates a post in a terminal status', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const [source] = await createPost(ws, {
      caption: 'already out',
      media: [],
      variants: [{ connectionId: conn, provider: 'fake' }],
      schedule: { type: 'draft' },
    });
    // Test setup only — the admin handle bypasses RLS to force a terminal status.
    await db()
      .update(schema.posts)
      .set({ status: 'published' })
      .where(eq(schema.posts.id, source!.id));

    const copy = await duplicatePost(ws, source!.id);

    expect(copy?.status).toBe('draft');
    expect((await getPost(ws, source!.id))?.status).toBe('published');
    expect(await listPosts(ws)).toHaveLength(2);
  });

  it('returns null for a missing post and writes nothing', async () => {
    const ws = await createWorkspace();
    expect(await duplicatePost(ws, NONEXISTENT)).toBeNull();
    expect(await listPosts(ws)).toHaveLength(0);
  });

  it("cannot duplicate another workspace's post", async () => {
    useRecordingScheduler();
    const [a, b] = [await createWorkspace('A'), await createWorkspace('B')];
    const connB = await createConnection(b);
    const [theirs] = await createPost(b, {
      caption: 'private to B',
      media: [],
      variants: [{ connectionId: connB, provider: 'fake' }],
      schedule: { type: 'draft' },
    });

    expect(await duplicatePost(a, theirs!.id)).toBeNull();
    expect(await listPosts(a)).toHaveLength(0);
    expect(await listPosts(b)).toHaveLength(1);
  });

  it('replays on a repeated idempotency key instead of copying again', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const [source] = await createPost(ws, {
      caption: 'copy me once',
      media: [],
      variants: [{ connectionId: conn, provider: 'fake' }],
      schedule: { type: 'draft' },
    });

    const first = await duplicatePost(ws, source!.id, { idempotencyKey: 'dup-1' });
    const second = await duplicatePost(ws, source!.id, { idempotencyKey: 'dup-1' });

    expect(second?.id).toBe(first?.id);
    expect(await listPosts(ws)).toHaveLength(2);
  });
});
