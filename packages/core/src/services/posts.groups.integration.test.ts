import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, db, schema, withWorkspace } from '@meegrow-social/db';
import {
  createConnection,
  createWorkspace,
  resetDb,
  useRecordingScheduler,
  useTestDatabaseEnv,
} from '@meegrow-social/testing';
import {
  calendarPosts,
  createPost,
  duplicatePostGroup,
  getPost,
  getPostGroup,
  listPostGroups,
  listPosts,
} from './posts.js';

/**
 * The group list, media on post views, and the group duplicate, against a real database.
 * Pagination is by group; the filters are on the variants; media urls come from one lookup.
 */

beforeAll(() => {
  useTestDatabaseEnv();
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
});
beforeEach(resetDb);
afterAll(closeDb);

const NONEXISTENT = '00000000-0000-0000-0000-000000000000';
const DAY = 24 * 60 * 60 * 1000;
const future = (days: number): Date => new Date(Date.now() + days * DAY);

/** Test setup only — the admin handle bypasses RLS to force a status a test needs. */
async function setStatus(postId: string, status: string): Promise<void> {
  await db().update(schema.posts).set({ status }).where(eq(schema.posts.id, postId));
}

async function storeMedia(
  workspaceId: string,
  kind: 'image' | 'video',
  url: string | null,
): Promise<string> {
  return withWorkspace(workspaceId, async (tx) => {
    const [row] = await tx
      .insert(schema.media)
      .values({ workspaceId, kind, url, s3Key: `${workspaceId}/private-key.bin` })
      .returning();
    return row!.id;
  });
}

describe('listPostGroups', () => {
  it('returns one item per group with every variant, and the headline status', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const [ig, fb] = [
      await createConnection(ws, 'fake', 'IG', { externalId: 'ig' }),
      await createConnection(ws, 'fake', 'FB', { externalId: 'fb' }),
    ];
    const created = await createPost(ws, {
      caption: 'two platforms',
      media: [],
      variants: [
        { connectionId: ig, provider: 'fake' },
        { connectionId: fb, provider: 'fake' },
      ],
      schedule: { type: 'at', publishAt: future(1) },
    });
    await setStatus(created[0]!.id, 'published');
    await setStatus(created[1]!.id, 'failed');

    const groups = await listPostGroups(ws);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      id: created[0]!.groupId,
      caption: 'two platforms',
      status: 'partly_failed',
      media: [],
    });
    expect(groups[0]!.posts.map((p) => p.status).sort()).toEqual(['failed', 'published']);
    expect(groups[0]!.posts.map((p) => p.connectionId).sort()).toEqual([ig, fb].sort());
  });

  it('pages by group: a multi-platform post is never split across two pages', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const [a, b, c] = [
      await createConnection(ws, 'fake', 'A', { externalId: 'a' }),
      await createConnection(ws, 'fake', 'B', { externalId: 'b' }),
      await createConnection(ws, 'fake', 'C', { externalId: 'c' }),
    ];
    const variants = [a, b, c].map((connectionId) => ({ connectionId, provider: 'fake' as const }));
    for (let day = 1; day <= 3; day++) {
      await createPost(ws, {
        caption: `group ${day}`,
        media: [],
        variants,
        schedule: { type: 'at', publishAt: future(day) },
      });
    }

    const first = await listPostGroups(ws, { limit: 2, offset: 0, order: 'desc' });
    const second = await listPostGroups(ws, { limit: 2, offset: 2, order: 'desc' });

    // Newest first: day 3, day 2 | day 1. Nine posts, three groups, every group whole.
    expect(first.map((g) => g.caption)).toEqual(['group 3', 'group 2']);
    expect(second.map((g) => g.caption)).toEqual(['group 1']);
    for (const g of [...first, ...second]) expect(g.posts).toHaveLength(3);
  });

  it('orders oldest first on request, and a group with no publish time by when it was created', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const variants = [{ connectionId: conn, provider: 'fake' as const }];
    await createPost(ws, { caption: 'draft', media: [], variants, schedule: { type: 'draft' } });
    await createPost(ws, {
      caption: 'next week',
      media: [],
      variants,
      schedule: { type: 'at', publishAt: future(7) },
    });

    // The draft sorts at its creation time (now), before a post scheduled for next week.
    expect(
      (await listPostGroups(ws, { limit: 50, offset: 0, order: 'asc' })).map((g) => g.caption),
    ).toEqual(['draft', 'next week']);
    expect((await listPostGroups(ws)).map((g) => g.caption)).toEqual(['next week', 'draft']);
  });

  it('lists a group when ANY variant matches the filter, and still returns all of its variants', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const [a, b] = [
      await createConnection(ws, 'fake', 'A', { externalId: 'a' }),
      await createConnection(ws, 'fake_2step', 'B', { externalId: 'b' }),
    ];
    const mixed = await createPost(ws, {
      caption: 'Open day this weekend',
      media: [],
      variants: [
        { connectionId: a, provider: 'fake' },
        { connectionId: b, provider: 'fake_2step' },
      ],
      schedule: { type: 'at', publishAt: future(2) },
    });
    await setStatus(mixed[1]!.id, 'failed');
    await createPost(ws, {
      caption: '100% off_peak pricing',
      media: [],
      variants: [{ connectionId: a, provider: 'fake' }],
      schedule: { type: 'draft' },
    });
    const page = { limit: 50, offset: 0, order: 'desc' as const };

    const failed = await listPostGroups(ws, { ...page, status: 'failed' });
    expect(failed).toHaveLength(1);
    expect(failed[0]!.posts).toHaveLength(2);

    expect(await listPostGroups(ws, { ...page, provider: 'fake_2step' })).toHaveLength(1);
    expect(await listPostGroups(ws, { ...page, connectionId: a })).toHaveLength(2);
    expect(await listPostGroups(ws, { ...page, connectionId: b })).toHaveLength(1);
    // A date range is on publishAt, so a draft is in no range.
    expect(await listPostGroups(ws, { ...page, from: future(1), to: future(3) })).toHaveLength(1);
    expect(await listPostGroups(ws, { ...page, from: future(5) })).toHaveLength(0);

    // Caption search is case-insensitive, and `%` / `_` in the query are literal.
    expect((await listPostGroups(ws, { ...page, q: 'OPEN DAY' })).map((g) => g.caption)).toEqual([
      'Open day this weekend',
    ]);
    expect(await listPostGroups(ws, { ...page, q: '100%' })).toHaveLength(1);
    expect(await listPostGroups(ws, { ...page, q: 'off_peak' })).toHaveLength(1);
    expect(await listPostGroups(ws, { ...page, q: '%' })).toHaveLength(1);
    expect(await listPostGroups(ws, { ...page, q: 'offXpeak' })).toHaveLength(0);
  });

  it("never lists another workspace's groups (RLS)", async () => {
    useRecordingScheduler();
    const [a, b] = [await createWorkspace('A'), await createWorkspace('B')];
    const connB = await createConnection(b);
    await createPost(b, {
      caption: 'private to B',
      media: [],
      variants: [{ connectionId: connB, provider: 'fake' }],
      schedule: { type: 'draft' },
    });

    expect(await listPostGroups(a)).toEqual([]);
    expect(await listPostGroups(b)).toHaveLength(1);
  });
});

describe('media on post views', () => {
  it("resolves a ref's url from the stored media, keeps a ref's own url, and never exposes the key", async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const stored = await storeMedia(ws, 'image', 'https://cdn.test/stored.jpg');
    const [post] = await createPost(ws, {
      caption: 'with media',
      media: [
        { mediaId: stored, kind: 'image' },
        { mediaId: NONEXISTENT, kind: 'image', url: 'https://elsewhere.test/own.jpg' },
        // Points at nothing and carries no url: shown as a placeholder, not an error.
        { mediaId: '7b0f6a52-3f0e-4c59-9f0b-2f4f0a6f7c11', kind: 'video' },
      ],
      variants: [{ connectionId: conn, provider: 'fake' }],
      schedule: { type: 'at', publishAt: future(1) },
    });
    const expected = [
      { id: stored, kind: 'image', url: 'https://cdn.test/stored.jpg', thumbnailUrl: null },
      {
        id: NONEXISTENT,
        kind: 'image',
        url: 'https://elsewhere.test/own.jpg',
        thumbnailUrl: null,
      },
      { id: '7b0f6a52-3f0e-4c59-9f0b-2f4f0a6f7c11', kind: 'video', url: null, thumbnailUrl: null },
    ];

    // Every way a post is read back carries the same media.
    expect(post!.media).toEqual(expected);
    expect((await getPost(ws, post!.id))?.media).toEqual(expected);
    expect((await listPosts(ws))[0]?.media).toEqual(expected);
    expect((await getPostGroup(ws, post!.groupId))?.posts[0]?.media).toEqual(expected);
    const [group] = await listPostGroups(ws);
    expect(group!.media).toEqual(expected);
    expect(group!.posts[0]?.media).toEqual(expected);
    const when = post!.publishAt!;
    const calendar = await calendarPosts(ws, {
      year: when.getUTCFullYear(),
      month: when.getUTCMonth() + 1,
      timezone: 'UTC',
    });
    expect(calendar.days[0]?.posts[0]?.media).toEqual(expected);

    expect(JSON.stringify([post, group, calendar])).not.toContain('private-key');
  });

  it("uses a meta post's cover as its video's thumbnail", async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const conn = await createConnection(ws, 'instagram');
    const video = await storeMedia(ws, 'video', 'https://cdn.test/reel.mp4');
    const [post] = await createPost(ws, {
      caption: 'reel',
      media: [{ mediaId: video, kind: 'video' }],
      variants: [
        {
          connectionId: conn,
          provider: 'instagram',
          options: { kind: 'meta', format: 'reel', coverUrl: 'https://cdn.test/cover.jpg' },
        },
      ],
      schedule: { type: 'draft' },
    });

    expect(post!.media).toEqual([
      {
        id: video,
        kind: 'video',
        url: 'https://cdn.test/reel.mp4',
        thumbnailUrl: 'https://cdn.test/cover.jpg',
      },
    ]);
  });

  it("does not resolve a ref against another workspace's media", async () => {
    useRecordingScheduler();
    const [a, b] = [await createWorkspace('A'), await createWorkspace('B')];
    const theirs = await storeMedia(b, 'image', 'https://cdn.test/b-only.jpg');
    const conn = await createConnection(a);
    const [post] = await createPost(a, {
      caption: 'names B media',
      media: [{ mediaId: theirs, kind: 'image' }],
      variants: [{ connectionId: conn, provider: 'fake' }],
      schedule: { type: 'draft' },
    });

    expect(post!.media).toEqual([{ id: theirs, kind: 'image', url: null, thumbnailUrl: null }]);
  });

  it('is an empty list, not absent, for a text-only post', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const [post] = await createPost(ws, {
      caption: 'words only',
      media: [],
      variants: [{ connectionId: conn, provider: 'fake' }],
      schedule: { type: 'draft' },
    });
    expect(post!.media).toEqual([]);
  });
});

describe('duplicatePostGroup', () => {
  it('copies every variant, with its own caption, media and options, into one new group of drafts', async () => {
    const { calls } = useRecordingScheduler();
    const ws = await createWorkspace();
    const [ig, other] = [
      await createConnection(ws, 'instagram', 'IG', { externalId: 'ig' }),
      await createConnection(ws, 'fake', 'Other', { externalId: 'other' }),
    ];
    const options = { kind: 'meta' as const, format: 'feed' as const };
    const media = [{ mediaId: '7b0f6a52-3f0e-4c59-9f0b-2f4f0a6f7c11', kind: 'image' as const }];
    const source = await createPost(ws, {
      caption: 'shared caption',
      media,
      variants: [
        { connectionId: ig, provider: 'instagram', caption: 'for instagram', options },
        { connectionId: other, provider: 'fake' },
      ],
      schedule: { type: 'at', publishAt: future(1) },
    });
    await setStatus(source[0]!.id, 'published');
    const scheduledBefore = calls.length;

    const copy = await duplicatePostGroup(ws, source[0]!.groupId);

    expect(copy).toMatchObject({ caption: 'shared caption', status: 'draft' });
    expect(copy!.id).not.toBe(source[0]!.groupId);
    expect(copy!.posts).toHaveLength(2);
    expect(copy!.posts.every((p) => p.status === 'draft' && p.publishAt === null)).toBe(true);
    const igCopy = copy!.posts.find((p) => p.connectionId === ig);
    expect(igCopy).toMatchObject({ caption: 'for instagram', options });
    expect(copy!.posts.find((p) => p.connectionId === other)?.caption).toBe('shared caption');
    expect(copy!.posts.map((p) => p.media?.map((m) => m.id))).toEqual([
      [media[0]!.mediaId],
      [media[0]!.mediaId],
    ]);
    // A copy never publishes by itself, and the source is untouched.
    expect(calls.length).toBe(scheduledBefore);
    expect((await getPost(ws, source[0]!.id))?.status).toBe('published');
    expect(await listPostGroups(ws)).toHaveLength(2);
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

    const first = await duplicatePostGroup(ws, source!.groupId, { idempotencyKey: 'dup-g-1' });
    const second = await duplicatePostGroup(ws, source!.groupId, { idempotencyKey: 'dup-g-1' });

    expect(second?.id).toBe(first?.id);
    expect(await listPostGroups(ws)).toHaveLength(2);
  });

  it("returns null for a missing group and for another workspace's, writing nothing", async () => {
    useRecordingScheduler();
    const [a, b] = [await createWorkspace('A'), await createWorkspace('B')];
    const connB = await createConnection(b);
    const [theirs] = await createPost(b, {
      caption: 'private to B',
      media: [],
      variants: [{ connectionId: connB, provider: 'fake' }],
      schedule: { type: 'draft' },
    });

    expect(await duplicatePostGroup(a, NONEXISTENT)).toBeNull();
    expect(await duplicatePostGroup(a, theirs!.groupId)).toBeNull();
    expect(await listPostGroups(a)).toHaveLength(0);
    expect(await listPostGroups(b)).toHaveLength(1);
  });
});
