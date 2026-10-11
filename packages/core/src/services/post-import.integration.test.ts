import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, schema, withWorkspace } from '@meegrow-social/db';
import {
  createConnection,
  createWorkspace,
  resetDb,
  useRecordingScheduler,
  useTempDiskStorage,
  useTestDatabaseEnv,
} from '@meegrow-social/testing';
import { registerProvider } from '../providers/registry.js';
import type { AuthTokens, MetricPoint, PostResult, SocialProvider } from '../providers/types.js';
import type {
  PublishedPostItem,
  PublishedPostPage,
  PublishedPostPresence,
  PublishedPostQuery,
} from '../providers/published-posts.js';
import { ProviderAuthError } from '../errors.js';
import {
  getLatestPostMetrics,
  POSTS_PER_CONNECTION_PER_SWEEP,
  sweepAnalyticsForWorkspace,
} from './analytics.js';
import { handleCallback, listConnections, startConnect } from './connections.js';
import { listMedia } from './media.js';
import {
  calendarPosts,
  cancelPost,
  duplicatePost,
  duplicatePostGroup,
  getPost,
  listPostGroups,
  listPosts,
  PostStateError,
  retryPost,
  updatePost,
} from './posts.js';
import { publishPost } from './publish.js';
import { sweepStrandedPublishesForWorkspace } from './publish-sweep.js';
import type { Clock } from './queues.js';
import {
  IMPORT_PAUSE_MS,
  IMPORT_SYNC_INTERVAL_MS,
  ImportNotSupportedError,
  parseImportState,
  requestPostImport,
  runConnectionImport,
  runDueImports,
} from './post-import.js';

/**
 * Import past posts against real Postgres: the writes, the unique index and check constraint that
 * make the guarantees structural, and the reads that have to include an imported post. The
 * platform is a stub registered under `linkedin-page` (no real provider there) whose listing the
 * test controls — nothing touches a network.
 */

const NOW = new Date('2026-10-11T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const clockAt = (d: Date): Clock => ({ now: () => d });
const PROVIDER = 'linkedin-page';

/** What the stub platform currently lists, newest first, and how it answers. */
const platform = {
  posts: [] as PublishedPostItem[],
  usage: null as PublishedPostPage['usage'],
  /** Answer of `publishedPostPresence` per id; anything else is `present`. */
  presence: new Map<string, PublishedPostPresence>(),
  listError: null as Error | null,
  listCalls: [] as PublishedPostQuery[],
  presenceCalls: [] as string[],
  analyticsCalls: [] as string[],
  /** Every publish that reached the platform. Must stay empty for imported posts. */
  sent: [] as string[],
};

const stub: SocialProvider = {
  identifier: PROVIDER,
  displayName: 'Stub platform',
  isBetweenSteps: false,
  tokenModel: 'one-time',
  maxConcurrentJobs: 1,
  async generateAuthUrl({ redirectUri, state }) {
    return { url: `${redirectUri}?state=${state}&code=c` };
  },
  async authenticate(): Promise<AuthTokens> {
    return { accessToken: 'stub-token', externalId: 'acct-1', displayName: 'City Hospital' };
  },
  async refreshToken(): Promise<AuthTokens> {
    throw new Error('not exercised');
  },
  async post(_tokens, details): Promise<PostResult> {
    platform.sent.push(details[0]!.caption);
    return { externalPostId: `new-${platform.sent.length}`, releaseUrl: 'https://stub.test/p/new' };
  },
  async postAnalytics(_tokens, externalPostId): Promise<MetricPoint[]> {
    platform.analyticsCalls.push(externalPostId);
    return [{ metric: 'views', value: 42, capturedAt: NOW }];
  },
  async accountAnalytics() {
    return [];
  },
  async listPublishedPosts(_tokens, query): Promise<PublishedPostPage> {
    platform.listCalls.push(query);
    if (platform.listError) throw platform.listError;
    const from = query.cursor ? Number(query.cursor) : 0;
    const to = from + query.limit;
    const visible = platform.posts.filter(
      (p) => p.publishedAt >= query.since && (!query.until || p.publishedAt <= query.until),
    );
    return {
      items: visible.slice(from, to),
      nextCursor: to < visible.length ? String(to) : null,
      usage: platform.usage,
    };
  },
  async publishedPostPresence(_tokens, externalPostId) {
    platform.presenceCalls.push(externalPostId);
    return platform.presence.get(externalPostId) ?? 'present';
  },
};

const listed = (
  id: string,
  publishedAgo: number,
  over: Partial<PublishedPostItem> = {},
): PublishedPostItem => ({
  externalPostId: id,
  alternateIds: [],
  knownUrls: [],
  caption: `caption ${id}`,
  publishedAt: ago(publishedAgo),
  permalink: `https://stub.test/p/${id}`,
  mediaKind: null,
  mediaCount: 0,
  thumbnailUrl: null,
  ...over,
});

let scheduler: ReturnType<typeof useRecordingScheduler>;

beforeAll(() => {
  useTestDatabaseEnv();
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
  registerProvider(stub);
});
beforeEach(async () => {
  platform.posts = [];
  platform.usage = null;
  platform.presence = new Map();
  platform.listError = null;
  platform.listCalls = [];
  platform.presenceCalls = [];
  platform.analyticsCalls = [];
  platform.sent = [];
  scheduler = useRecordingScheduler();
  await resetDb();
});
afterAll(closeDb);

const deps = (now: Date = NOW) => ({ clock: clockAt(now), sleep: async () => {} });

async function seed(): Promise<{ ws: string; conn: string }> {
  const ws = await createWorkspace();
  const conn = await createConnection(ws, PROVIDER, 'City Hospital', { externalId: 'acct-1' });
  return { ws, conn };
}

/** A post this app published, written as `publishPost` leaves one. */
async function ownPost(
  ws: string,
  conn: string,
  over: Partial<typeof schema.posts.$inferInsert> = {},
): Promise<string> {
  return withWorkspace(ws, async (tx) => {
    const [group] = await tx.insert(schema.postGroups).values({ workspaceId: ws }).returning();
    const [post] = await tx
      .insert(schema.posts)
      .values({
        workspaceId: ws,
        groupId: group!.id,
        connectionId: conn,
        provider: PROVIDER,
        status: 'published',
        caption: 'what we sent',
        ...over,
      })
      .returning();
    return post!.id;
  });
}

const allPosts = (ws: string) => withWorkspace(ws, (tx) => tx.select().from(schema.posts));
const connectionRow = async (ws: string, conn: string) =>
  (
    await withWorkspace(ws, (tx) =>
      tx.select().from(schema.connections).where(eq(schema.connections.id, conn)),
    )
  )[0]!;
const importedId = async (ws: string, externalPostId: string): Promise<string> =>
  (await allPosts(ws)).find((p) => p.externalPostId === externalPostId && p.source === 'imported')!
    .id;

describe('importing', () => {
  it('imports each listed post as a published, imported post in a group of its own', async () => {
    const { ws, conn } = await seed();
    platform.posts = [listed('a', DAY), listed('b', 2 * DAY), listed('c', 40 * DAY)];

    const run = await runConnectionImport(ws, conn, deps());
    expect(run).toMatchObject({ status: 'done', imported: 3, matched: 0, capped: false });

    const posts = await allPosts(ws);
    expect(posts).toHaveLength(3);
    expect(new Set(posts.map((p) => p.groupId)).size).toBe(3);
    for (const p of posts) {
      expect(p).toMatchObject({ source: 'imported', status: 'published', connectionId: conn });
      expect(p.queueId).toBeNull();
    }
    const a = posts.find((p) => p.externalPostId === 'a')!;
    expect(a).toMatchObject({ caption: 'caption a', releaseUrl: 'https://stub.test/p/a' });
    // The platform's own timestamp, not the time of the import.
    expect(a.publishAt).toEqual(ago(DAY));

    // Never handed to the scheduler, never sent anywhere.
    expect(scheduler.calls).toEqual([]);
    expect(platform.sent).toEqual([]);
    const state = await connectionRow(ws, conn);
    expect(state.lastImportAt).toEqual(NOW);
    expect(parseImportState(state.importState)).toMatchObject({ status: 'done', imported: 3 });
  });

  it('import twice → no duplicates', async () => {
    const { ws, conn } = await seed();
    platform.posts = [listed('a', DAY), listed('b', 2 * DAY)];

    await runConnectionImport(ws, conn, deps());
    // Asked for again by an operator, and run.
    await requestPostImport(ws, conn, { windowDays: 90 }, clockAt(NOW));
    const second = await runConnectionImport(ws, conn, deps());

    expect(second).toMatchObject({ status: 'done', imported: 0 });
    expect(await allPosts(ws)).toHaveLength(2);
    const groups = await withWorkspace(ws, (tx) => tx.select().from(schema.postGroups));
    expect(groups).toHaveLength(2);
  });

  it('the database refuses a second imported row for the same platform post', async () => {
    const { ws, conn } = await seed();
    platform.posts = [listed('a', DAY)];
    await runConnectionImport(ws, conn, deps());

    await expect(ownPost(ws, conn, { source: 'imported', externalPostId: 'a' })).rejects.toThrow();
    // The same id on another account is a different post.
    const other = await createConnection(ws, PROVIDER, 'Second account', { externalId: 'acct-2' });
    await expect(
      ownPost(ws, other, { source: 'imported', externalPostId: 'a' }),
    ).resolves.toBeTruthy();
  });

  it('our own published post is matched, not duplicated, and gains its publish time', async () => {
    const { ws, conn } = await seed();
    const ours = await ownPost(ws, conn, { externalPostId: 'a', publishAt: null });
    platform.posts = [listed('a', 40 * DAY, { caption: 'edited on the platform' })];

    const run = await runConnectionImport(ws, conn, deps());
    expect(run).toMatchObject({ imported: 0, matched: 1 });

    const posts = await allPosts(ws);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ id: ours, source: 'app', caption: 'what we sent' });
    expect(posts[0]!.publishAt).toEqual(ago(40 * DAY));
  });

  it('leaves a publish time our own post already has', async () => {
    const { ws, conn } = await seed();
    await ownPost(ws, conn, { externalPostId: 'a', publishAt: ago(3 * DAY) });
    platform.posts = [listed('a', 3 * DAY - 90_000)];
    await runConnectionImport(ws, conn, deps());
    expect((await allPosts(ws))[0]!.publishAt).toEqual(ago(3 * DAY));
  });

  it('recognises our own post under an alternate id, and one stored before ids were kept by its link', async () => {
    const { ws, conn } = await seed();
    const video = await ownPost(ws, conn, { externalPostId: 'video-9', publishAt: ago(DAY) });
    const legacy = await ownPost(ws, conn, {
      externalPostId: null,
      releaseUrl: 'https://stub.test/legacy/b',
      publishAt: null,
    });
    platform.posts = [
      listed('story-1', DAY, { alternateIds: ['video-9'] }),
      listed('b', 5 * DAY, { knownUrls: ['https://stub.test/legacy/b'] }),
    ];

    const run = await runConnectionImport(ws, conn, deps());
    expect(run).toMatchObject({ imported: 0, matched: 2 });
    const posts = await allPosts(ws);
    expect(posts.map((p) => p.id).sort()).toEqual([video, legacy].sort());
    // The legacy post now has the id analytics are polled by, and a publish time.
    expect(posts.find((p) => p.id === legacy)).toMatchObject({ externalPostId: 'b' });
    expect(posts.find((p) => p.id === legacy)!.publishAt).toEqual(ago(5 * DAY));
    // The video keeps the id it was published under.
    expect(posts.find((p) => p.id === video)!.externalPostId).toBe('video-9');
  });

  it('leaves a post younger than the settle margin for the next run', async () => {
    const { ws, conn } = await seed();
    platform.posts = [listed('just-now', 2 * MINUTE), listed('settled', HOUR)];
    await runConnectionImport(ws, conn, deps());
    expect((await allPosts(ws)).map((p) => p.externalPostId)).toEqual(['settled']);
  });

  it('follows the platform when an imported post was edited there', async () => {
    const { ws, conn } = await seed();
    platform.posts = [listed('a', DAY)];
    await runConnectionImport(ws, conn, deps());
    platform.posts = [listed('a', DAY, { caption: 'corrected caption' })];
    const later = new Date(NOW.getTime() + IMPORT_SYNC_INTERVAL_MS);
    await runConnectionImport(ws, conn, deps(later));
    expect((await allPosts(ws))[0]!.caption).toBe('corrected caption');
  });
});

describe('thumbnails', () => {
  it('copies the still into our storage and shows it in the existing media shape', async () => {
    const { ws, conn } = await seed();
    const { publicBaseUrl } = useTempDiskStorage();
    platform.posts = [
      listed('photo', DAY, {
        mediaKind: 'image',
        mediaCount: 1,
        thumbnailUrl: 'https://cdn.stub.test/photo.jpg?oe=EXPIRES',
      }),
      listed('reel', 2 * DAY, {
        mediaKind: 'video',
        mediaCount: 1,
        thumbnailUrl: 'https://cdn.stub.test/reel_cover.jpg?oe=EXPIRES',
      }),
      listed('text', 3 * DAY),
    ];
    const fetchImpl = vi.fn(
      async () => new Response(new Uint8Array(64), { headers: { 'content-type': 'image/jpeg' } }),
    ) as unknown as typeof fetch;

    await runConnectionImport(ws, conn, { ...deps(), fetchImpl });

    const photo = (await getPost(ws, await importedId(ws, 'photo')))!;
    expect(photo.media).toHaveLength(1);
    expect(photo.media![0]).toMatchObject({ kind: 'image', thumbnailUrl: null });
    expect(photo.media![0]!.url).toContain(publicBaseUrl);
    // The platform's expiring url is stored nowhere.
    expect(JSON.stringify(await allPosts(ws))).not.toContain('cdn.stub.test');

    const reel = (await getPost(ws, await importedId(ws, 'reel')))!;
    expect(reel.media![0]).toMatchObject({ kind: 'video', url: null });
    expect(reel.media![0]!.thumbnailUrl).toContain(publicBaseUrl);

    expect((await getPost(ws, await importedId(ws, 'text')))!.media).toEqual([]);
    // The stills are not uploads: the media library does not list them.
    expect(await listMedia(ws)).toEqual([]);
  });

  it('imports the post without a picture when the still cannot be fetched', async () => {
    const { ws, conn } = await seed();
    useTempDiskStorage();
    platform.posts = [
      listed('photo', DAY, { mediaKind: 'image', mediaCount: 1, thumbnailUrl: 'https://x.test/a' }),
    ];
    const fetchImpl = vi.fn(async () => new Response('gone', { status: 403 }));
    const run = await runConnectionImport(ws, conn, {
      ...deps(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(run).toMatchObject({ status: 'done', imported: 1 });
    expect((await getPost(ws, await importedId(ws, 'photo')))!.media).toEqual([]);
  });
});

describe('an imported post can never be published', () => {
  async function imported(): Promise<{ ws: string; conn: string; id: string }> {
    const { ws, conn } = await seed();
    platform.posts = [listed('a', DAY)];
    await runConnectionImport(ws, conn, deps());
    return { ws, conn, id: await importedId(ws, 'a') };
  }

  it('is refused by retry, update and cancel, with the reason', async () => {
    const { ws, id } = await imported();

    await expect(retryPost(ws, id)).rejects.toThrow(PostStateError);
    await expect(retryPost(ws, id)).rejects.toThrow(/imported post cannot be retried/);
    await expect(updatePost(ws, id, { caption: 'changed' })).rejects.toThrow(/imported post/);
    await expect(updatePost(ws, id, { publishAt: new Date(Date.now() + HOUR) })).rejects.toThrow(
      /imported post cannot be edited or rescheduled/,
    );
    await expect(updatePost(ws, id, { publishAt: null })).rejects.toThrow(/imported post/);
    await expect(cancelPost(ws, id)).rejects.toThrow(/imported post cannot be cancelled/);

    expect(await getPost(ws, id)).toMatchObject({
      status: 'published',
      source: 'imported',
      caption: 'caption a',
    });
    expect(scheduler.calls).toEqual([]);
    expect(scheduler.cancels).toEqual([]);
  });

  it('is refused by publishPost: a job that fires for it sends nothing', async () => {
    const { ws, id } = await imported();
    expect(await publishPost(ws, id, NOW)).toEqual({
      postId: id,
      status: 'skipped',
      skipped: 'imported',
    });
    expect(platform.sent).toEqual([]);
    expect(await getPost(ws, id)).toMatchObject({ status: 'published', error: null });
  });

  it.each(['scheduled', 'draft', 'failed', 'publishing', 'cancelled'])(
    'the database refuses to store an imported post as %s',
    async (status) => {
      const { ws, conn, id } = await imported();
      await expect(
        withWorkspace(ws, (tx) =>
          tx.update(schema.posts).set({ status }).where(eq(schema.posts.id, id)),
        ),
      ).rejects.toThrow();
      await expect(
        ownPost(ws, conn, { source: 'imported', externalPostId: 'other', status }),
      ).rejects.toThrow();
      expect((await getPost(ws, id))!.status).toBe('published');
    },
  );

  it('is ignored by the stranded-post sweep', async () => {
    const { ws } = await imported();
    expect(await sweepStrandedPublishesForWorkspace(ws, NOW)).toEqual({
      examined: 0,
      requeued: 0,
      failed: 0,
      errors: [],
    });
    expect(scheduler.calls).toEqual([]);
  });

  it('may be duplicated — as an ordinary draft of this app, caption only, nothing scheduled', async () => {
    const { ws, id } = await imported();
    const source = (await getPost(ws, id))!;

    const group = await duplicatePostGroup(ws, source.groupId);
    expect(group!.posts).toHaveLength(1);
    expect(group!.posts[0]).toMatchObject({
      status: 'draft',
      source: 'app',
      caption: 'caption a',
      publishAt: null,
      releaseUrl: null,
      media: [],
    });
    const copy = await duplicatePost(ws, id);
    expect(copy).toMatchObject({ status: 'draft', source: 'app' });

    expect(scheduler.calls).toEqual([]);
    expect(platform.sent).toEqual([]);
    // The source is untouched, and the copies carry no platform id of their own.
    expect((await allPosts(ws)).filter((p) => p.externalPostId === 'a')).toHaveLength(1);
  });

  it('a duplicate of an imported post with a still does not carry the still as its media', async () => {
    const { ws, conn } = await seed();
    useTempDiskStorage();
    platform.posts = [
      listed('photo', DAY, { mediaKind: 'image', mediaCount: 1, thumbnailUrl: 'https://x.test/a' }),
    ];
    const fetchImpl = vi.fn(
      async () => new Response(new Uint8Array(8), { headers: { 'content-type': 'image/png' } }),
    ) as unknown as typeof fetch;
    await runConnectionImport(ws, conn, { ...deps(), fetchImpl });
    const source = (await getPost(ws, await importedId(ws, 'photo')))!;
    expect(source.media).toHaveLength(1);

    const group = await duplicatePostGroup(ws, source.groupId);
    expect(group!.media).toEqual([]);
    expect(group!.posts[0]!.media).toEqual([]);
  });
});

describe('reads include imported posts', () => {
  it('lists them, filters by source, groups them, and puts them on the calendar', async () => {
    const { ws, conn } = await seed();
    const ours = await ownPost(ws, conn, { externalPostId: 'ours', publishAt: ago(2 * DAY) });
    platform.posts = [listed('ours', 2 * DAY), listed('a', DAY), listed('b', 3 * DAY)];
    await runConnectionImport(ws, conn, deps());

    const all = await listPosts(ws);
    expect(all).toHaveLength(3);
    expect(all.find((p) => p.id === ours)).toMatchObject({ source: 'app' });

    const importedOnly = await listPosts(ws, {
      source: 'imported',
      limit: 50,
      offset: 0,
    });
    expect(importedOnly.map((p) => p.source)).toEqual(['imported', 'imported']);
    expect(importedOnly.every((p) => p.platformRemovedAt === null)).toBe(true);
    const appOnly = await listPosts(ws, { source: 'app', limit: 50, offset: 0 });
    expect(appOnly.map((p) => p.id)).toEqual([ours]);

    // Date-bounded: an imported post falls in a period by the platform's timestamp.
    const lastTwoDays = await listPosts(ws, {
      status: 'published',
      from: ago(2 * DAY + HOUR),
      to: NOW,
      limit: 50,
      offset: 0,
    });
    expect(lastTwoDays).toHaveLength(2);

    const groups = await listPostGroups(ws, { limit: 50, offset: 0, order: 'desc' });
    expect(groups).toHaveLength(3);
    expect(groups.every((g) => g.status === 'published' && g.posts.length === 1)).toBe(true);
    // Newest first by the platform's publish time.
    expect(groups.map((g) => g.posts[0]!.source)).toEqual(['imported', 'app', 'imported']);
    const importedGroups = await listPostGroups(ws, {
      source: 'imported',
      limit: 50,
      offset: 0,
      order: 'desc',
    });
    expect(importedGroups).toHaveLength(2);

    const calendar = await calendarPosts(ws, { year: 2026, month: 10, timezone: 'UTC' });
    expect(calendar.days.flatMap((d) => d.posts)).toHaveLength(3);
  });

  it('collects metrics for them, and the bulk read returns them', async () => {
    const { ws, conn } = await seed();
    platform.posts = [listed('a', DAY)];
    await runConnectionImport(ws, conn, deps());
    const id = await importedId(ws, 'a');

    const swept = await sweepAnalyticsForWorkspace(ws, clockAt(NOW));
    expect(swept.postsSwept).toBe(1);
    expect(platform.analyticsCalls).toEqual(['a']);
    expect(await getLatestPostMetrics(ws, [id])).toEqual({
      [id]: { latest: { views: 42 }, capturedAt: NOW },
    });
  });

  it('does not let hundreds of imported posts be polled in one sweep — newest first, the rest later', async () => {
    const { ws, conn } = await seed();
    platform.posts = Array.from({ length: 60 }, (_, n) => listed(`p${n}`, (n + 1) * DAY));
    await runConnectionImport(ws, conn, deps());

    const first = await sweepAnalyticsForWorkspace(ws, clockAt(NOW));
    expect(first.postsSwept).toBe(POSTS_PER_CONNECTION_PER_SWEEP);
    expect(first.postsDeferred).toBe(60 - POSTS_PER_CONNECTION_PER_SWEEP);
    expect(platform.analyticsCalls).toEqual(
      Array.from({ length: POSTS_PER_CONNECTION_PER_SWEEP }, (_, n) => `p${n}`),
    );

    // An hour later the next-newest are taken; nothing just polled is asked again.
    platform.analyticsCalls = [];
    const second = await sweepAnalyticsForWorkspace(ws, clockAt(new Date(NOW.getTime() + HOUR)));
    expect(second.postsSwept).toBe(POSTS_PER_CONNECTION_PER_SWEEP);
    expect(platform.analyticsCalls[0]).toBe(`p${POSTS_PER_CONNECTION_PER_SWEEP}`);
  });

  it('keeps them inside their workspace', async () => {
    const { ws, conn } = await seed();
    const other = await createWorkspace('Other client');
    platform.posts = [listed('a', DAY)];
    await runConnectionImport(ws, conn, deps());
    expect(await listPosts(other)).toEqual([]);
    expect(await listPostGroups(other)).toEqual([]);
  });
});

describe('removed on platform', () => {
  it('marks a post the list no longer has AND the platform confirms is gone', async () => {
    const { ws, conn } = await seed();
    const ours = await ownPost(ws, conn, { externalPostId: 'deleted', publishAt: ago(2 * DAY) });
    platform.posts = [listed('kept', DAY)];
    platform.presence.set('deleted', 'gone');

    const run = await runConnectionImport(ws, conn, deps());
    expect(run).toMatchObject({ status: 'done', removed: 1 });
    expect(platform.presenceCalls).toEqual(['deleted']);

    const post = (await getPost(ws, ours))!;
    // Marked, not relabelled: it did go out.
    expect(post.status).toBe('published');
    expect(post.platformRemovedAt).toEqual(NOW);
    // Its numbers are no longer polled.
    await sweepAnalyticsForWorkspace(ws, clockAt(NOW));
    expect(platform.analyticsCalls).toEqual(['kept']);
  });

  it('does not mark a post the platform cannot vouch for either way', async () => {
    const { ws, conn } = await seed();
    const ours = await ownPost(ws, conn, { externalPostId: 'unsure', publishAt: ago(2 * DAY) });
    platform.presence.set('unsure', 'unknown');
    const run = await runConnectionImport(ws, conn, deps());
    expect(run).toMatchObject({ removed: 0 });
    expect((await getPost(ws, ours))!.platformRemovedAt).toBeNull();
  });

  it('does not mark a post the list left out but the platform still has', async () => {
    const { ws, conn } = await seed();
    const ours = await ownPost(ws, conn, { externalPostId: 'unlisted', publishAt: ago(2 * DAY) });
    await runConnectionImport(ws, conn, deps());
    expect(platform.presenceCalls).toEqual(['unlisted']);
    expect((await getPost(ws, ours))!.platformRemovedAt).toBeNull();
  });

  it('never asks about a post outside the window that was read', async () => {
    const { ws, conn } = await seed();
    // The first import reads 90 days; this post is older, so not being listed means nothing.
    const old = await ownPost(ws, conn, { externalPostId: 'old', publishAt: ago(200 * DAY) });
    platform.presence.set('old', 'gone');
    await runConnectionImport(ws, conn, deps());
    expect(platform.presenceCalls).toEqual([]);
    expect((await getPost(ws, old))!.platformRemovedAt).toBeNull();
  });

  it('judges nothing as removed from a read that stopped early', async () => {
    const { ws, conn } = await seed();
    await ownPost(ws, conn, { externalPostId: 'deleted', publishAt: ago(50 * DAY) });
    platform.presence.set('deleted', 'gone');
    platform.posts = Array.from({ length: 60 }, (_, n) => listed(`p${n}`, (n + 1) * HOUR));
    platform.usage = { percent: 80, regainAccessMinutes: null };

    const run = await runConnectionImport(ws, conn, deps());
    expect(run).toMatchObject({ status: 'paused', removed: 0 });
    expect(platform.presenceCalls).toEqual([]);
  });

  it('clears the mark when the platform lists the post again', async () => {
    const { ws, conn } = await seed();
    const ours = await ownPost(ws, conn, {
      externalPostId: 'back',
      publishAt: ago(2 * DAY),
      platformRemovedAt: ago(HOUR),
    });
    platform.posts = [listed('back', 2 * DAY)];
    await runConnectionImport(ws, conn, deps());
    expect((await getPost(ws, ours))!.platformRemovedAt).toBeNull();
  });
});

describe('when it runs', () => {
  it('queues the first import when a connection is created — never inside the connect request', async () => {
    const ws = await createWorkspace();
    // The connect path stamps the request with the real clock, so this one test runs on it too.
    platform.posts = [{ ...listed('a', 0), publishedAt: new Date(Date.now() - DAY) }];

    const { flowId } = await startConnect(ws, PROVIDER, 'https://app.test');
    const result = await handleCallback(flowId, 'c');
    expect(result.status).toBe('connected');

    // The connect request is done; the platform's history has not been touched.
    expect(platform.listCalls).toEqual([]);
    expect(await allPosts(ws)).toEqual([]);
    const [conn] = await listConnections(ws);
    expect(conn!.import).toMatchObject({
      supported: true,
      status: 'queued',
      kind: 'backfill',
      windowDays: 90,
    });

    // The worker's next tick does the reading.
    const tick = await runDueImports({ sleep: async () => {} });
    expect(tick.runs).toHaveLength(1);
    expect(tick.runs[0]).toMatchObject({ status: 'done', imported: 1 });
    expect((await listConnections(ws))[0]!.import).toMatchObject({ status: 'done', imported: 1 });
  });

  it('does nothing for a provider that cannot list its posts', async () => {
    const ws = await createWorkspace();
    const conn = await createConnection(ws, 'fake');
    expect((await listConnections(ws))[0]!.import).toMatchObject({
      supported: false,
      status: null,
    });
    expect(await runConnectionImport(ws, conn, deps())).toBeNull();
    expect((await runDueImports(deps())).runs).toEqual([]);
    await expect(requestPostImport(ws, conn, { windowDays: 90 })).rejects.toThrow(
      ImportNotSupportedError,
    );
  });

  it('is not due again until the sync interval has passed, then picks up new platform posts', async () => {
    const { ws, conn } = await seed();
    platform.posts = [listed('a', DAY)];
    await runConnectionImport(ws, conn, deps());

    expect(await runConnectionImport(ws, conn, deps(new Date(NOW.getTime() + HOUR)))).toBeNull();

    const later = new Date(NOW.getTime() + IMPORT_SYNC_INTERVAL_MS);
    platform.posts = [
      { ...listed('new', 0), publishedAt: new Date(later.getTime() - HOUR) },
      ...platform.posts,
    ];
    const sync = await runConnectionImport(ws, conn, deps(later));
    expect(sync).toMatchObject({ status: 'done', imported: 1 });
    expect(await allPosts(ws)).toHaveLength(2);
    expect(parseImportState((await connectionRow(ws, conn)).importState)).toMatchObject({
      kind: 'sync',
    });
  });

  it('an operator can ask for a longer window; asking twice changes nothing', async () => {
    const { ws, conn } = await seed();
    platform.posts = [listed('recent', DAY), listed('last-year', 300 * DAY)];
    await runConnectionImport(ws, conn, deps());
    expect(await allPosts(ws)).toHaveLength(1);

    const asked = await requestPostImport(ws, conn, { windowDays: 365 }, clockAt(NOW));
    expect(asked).toMatchObject({ status: 'queued', windowDays: 365 });
    const again = await requestPostImport(ws, conn, { windowDays: 30 }, clockAt(NOW));
    expect(again).toMatchObject({ status: 'queued', windowDays: 365 });

    const run = await runConnectionImport(ws, conn, deps());
    expect(run).toMatchObject({ imported: 1 });
    expect(await allPosts(ws)).toHaveLength(2);
    expect(
      await requestPostImport(ws, '00000000-0000-4000-8000-000000000000', { windowDays: 90 }),
    ).toBe(null);
  });

  it('pauses at the rate-limit threshold and continues later without duplicating', async () => {
    const { ws, conn } = await seed();
    platform.posts = Array.from({ length: 60 }, (_, n) => listed(`p${n}`, (n + 1) * HOUR));
    platform.usage = { percent: 80, regainAccessMinutes: null };

    const first = await runConnectionImport(ws, conn, deps());
    expect(first).toMatchObject({ status: 'paused', imported: 25 });
    expect(platform.listCalls).toHaveLength(1);
    const paused = (await listConnections(ws))[0]!.import!;
    expect(paused.status).toBe('paused');
    expect(paused.resumeAt).toEqual(new Date(NOW.getTime() + IMPORT_PAUSE_MS));
    expect(paused.message).toMatch(/80% of the platform's rate limit/);

    // Not picked up before its time.
    expect(await runConnectionImport(ws, conn, deps(new Date(NOW.getTime() + MINUTE)))).toBeNull();

    platform.usage = null;
    const resumed = await runConnectionImport(
      ws,
      conn,
      deps(new Date(NOW.getTime() + IMPORT_PAUSE_MS)),
    );
    expect(resumed).toMatchObject({ status: 'done', imported: 60 });
    const posts = await allPosts(ws);
    expect(posts).toHaveLength(60);
    expect(new Set(posts.map((p) => p.externalPostId)).size).toBe(60);
  });

  it('flags the connection when the platform refuses the credentials, and stops trying', async () => {
    const { ws, conn } = await seed();
    platform.listError = new ProviderAuthError('token expired [code 190]');

    const run = await runConnectionImport(ws, conn, deps());
    expect(run).toMatchObject({ status: 'failed', imported: 0 });
    const row = await connectionRow(ws, conn);
    expect(row.needsReconnect).toBe(true);
    expect(row.lastImportAt).toBeNull();
    // A connection that needs reconnecting is never due.
    const muchLater = new Date(NOW.getTime() + 10 * IMPORT_SYNC_INTERVAL_MS);
    expect(await runConnectionImport(ws, conn, deps(muchLater))).toBeNull();
  });

  it('two workers cannot import one account at once', async () => {
    const { ws, conn } = await seed();
    platform.posts = [listed('a', DAY)];
    const [one, two] = await Promise.all([
      runConnectionImport(ws, conn, deps()),
      runConnectionImport(ws, conn, deps()),
    ]);
    expect([one, two].filter((r) => r !== null)).toHaveLength(1);
    expect(await allPosts(ws)).toHaveLength(1);
  });
});
