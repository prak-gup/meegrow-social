import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { analyticsReportQuery, type AnalyticsReportQuery } from '@meegrow-social/contracts';
import { closeDb, schema, withWorkspace } from '@meegrow-social/db';
import {
  createConnection,
  createMembership,
  createUser,
  createWorkspace,
  resetDb,
  useTestDatabaseEnv,
} from '@meegrow-social/testing';
import {
  AnalyticsQueryError,
  getAnalyticsReport,
  getAnalyticsReportForUser,
} from './analytics-report.js';
import type { Clock } from './queues.js';

/**
 * The analytics report against a real database: what the queries select (both periods, the newest
 * capture per metric, filters), and that a workspace only ever reads its own rows. The arithmetic
 * itself is covered without a database in `analytics-report.test.ts`.
 */

beforeAll(() => {
  useTestDatabaseEnv();
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
});
beforeEach(resetDb);
afterAll(closeDb);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-10-11T12:00:00Z');
const clock: Clock = { now: () => NOW };
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const query = (q: Record<string, unknown> = {}): AnalyticsReportQuery =>
  analyticsReportQuery.parse(q);

async function publishedPost(
  workspaceId: string,
  connectionId: string,
  provider: string,
  opts: {
    publishAt?: Date | null;
    source?: 'app' | 'imported';
    status?: string;
    caption?: string;
    media?: unknown[];
    externalPostId?: string;
  } = {},
): Promise<string> {
  return withWorkspace(workspaceId, async (tx) => {
    const [group] = await tx.insert(schema.postGroups).values({ workspaceId }).returning();
    const [post] = await tx
      .insert(schema.posts)
      .values({
        workspaceId,
        groupId: group!.id,
        connectionId,
        provider,
        status: opts.status ?? 'published',
        caption: opts.caption ?? '',
        media: opts.media ?? [],
        publishAt: opts.publishAt === undefined ? ago(3 * DAY) : opts.publishAt,
        source: opts.source ?? 'app',
        externalPostId: opts.externalPostId ?? `ext-${Math.random()}`,
      })
      .returning();
    return post!.id;
  });
}

async function metrics(
  workspaceId: string,
  target: { postId?: string; connectionId?: string },
  capturedAt: Date,
  values: Record<string, number>,
): Promise<void> {
  await withWorkspace(workspaceId, async (tx) => {
    await tx.insert(schema.metrics).values(
      Object.entries(values).map(([metric, value]) => ({
        workspaceId,
        postId: target.postId ?? null,
        connectionId: target.connectionId ?? null,
        metric,
        value: String(value),
        capturedAt,
      })),
    );
  });
}

describe('getAnalyticsReport', () => {
  it('reads the newest capture per metric and maps native names to concepts per platform', async () => {
    const ws = await createWorkspace('Client');
    const ig = await createConnection(ws, 'instagram', 'IG account');
    const fb = await createConnection(ws, 'facebook', 'FB page');
    const a = await publishedPost(ws, ig, 'instagram');
    const b = await publishedPost(ws, fb, 'facebook');
    await metrics(ws, { postId: a }, ago(2 * DAY), { views: 100, reach: 80, likes: 4 });
    await metrics(ws, { postId: a }, ago(HOUR), {
      views: 900,
      reach: 500,
      likes: 40,
      comments: 5,
      saved: 5,
      total_interactions: 50,
    });
    await metrics(ws, { postId: b }, ago(HOUR), {
      post_media_view: 300,
      post_reactions_like_total: 6,
      post_clicks: 9,
      post_video_views: 12,
    });

    const report = await getAnalyticsReport(ws, query(), clock);

    expect(report.summary.posts.value).toBe(2);
    expect(report.summary.totals.views.value).toBe(1200);
    expect(report.summary.totals.likes.value).toBe(46);
    expect(report.summary.totals.clicks.value).toBe(9);
    expect(report.summary.totals.shares.value).toBeNull();
    // (40 + 5 + 5) ÷ 500 reach, and 6 ÷ 300 views: 56 ÷ 800.
    expect(report.summary.engagementRate).toMatchObject({ basis: 'mixed' });
    expect(report.summary.engagementRate?.rate).toBeCloseTo(7, 9);
    expect(report.summary.lastCapturedAt).toEqual(ago(HOUR));
    const top = report.topPosts.find((p) => p.id === a)!;
    expect(top.metrics).toMatchObject({
      views: 900,
      reach: 500,
      likes: 40,
      saves: 5,
      shares: null,
    });
    expect(top).toMatchObject({ engagements: 50, engagementRate: 10, basis: 'reach' });
    // Nothing collected is hidden: the unmapped native names are listed as they are stored.
    expect(report.rawMetrics).toContainEqual({
      provider: 'instagram',
      metric: 'total_interactions',
      concept: null,
      posts: 1,
      total: 50,
    });
    expect(report.rawMetrics).toContainEqual({
      provider: 'facebook',
      metric: 'post_video_views',
      concept: null,
      posts: 1,
      total: 12,
    });
    expect(report.accounts.map((x) => [x.displayName, x.workspaceName])).toEqual([
      ['IG account', 'Client'],
      ['FB page', 'Client'],
    ]);
  });

  it('compares with the period before and leaves older, unpublished and undated posts out', async () => {
    const ws = await createWorkspace();
    const ig = await createConnection(ws, 'instagram');
    const current = await publishedPost(ws, ig, 'instagram', { publishAt: ago(2 * DAY) });
    const prior = await publishedPost(ws, ig, 'instagram', { publishAt: ago(40 * DAY) });
    const old = await publishedPost(ws, ig, 'instagram', { publishAt: ago(80 * DAY) });
    const draft = await publishedPost(ws, ig, 'instagram', { status: 'draft' });
    const undated = await publishedPost(ws, ig, 'instagram', { publishAt: null });
    for (const [id, likes] of [
      [current, 30],
      [prior, 10],
      [old, 500],
      [draft, 500],
      [undated, 500],
    ] as const) {
      await metrics(ws, { postId: id }, ago(HOUR), { likes, reach: 1000 });
    }

    const report = await getAnalyticsReport(ws, query({ days: 30 }), clock);

    expect(report.summary.posts).toEqual({ value: 1, prior: 1, deltaPct: 0 });
    expect(report.summary.totals.likes).toEqual({ value: 30, prior: 10, deltaPct: 200 });
    expect(report.summary.engagementRate.rate).toBe(3);
    expect(report.summary.engagementRatePrior).toBe(1);
    expect(report.summary.undatedPosts).toBe(1);
    expect(report.topPosts.map((p) => p.id)).toEqual([current]);
  });

  it('applies the platform, account and source filters', async () => {
    const ws = await createWorkspace();
    const ig = await createConnection(ws, 'instagram', 'IG');
    const ig2 = await createConnection(ws, 'instagram', 'IG two', { externalId: 'ext-2' });
    const fb = await createConnection(ws, 'facebook', 'FB');
    const mine = await publishedPost(ws, ig, 'instagram');
    const imported = await publishedPost(ws, ig, 'instagram', { source: 'imported' });
    const other = await publishedPost(ws, ig2, 'instagram');
    const page = await publishedPost(ws, fb, 'facebook');
    const ids = async (q: Record<string, unknown>) =>
      (await getAnalyticsReport(ws, query(q), clock)).topPosts.map((p) => p.id).sort();

    expect(await ids({})).toEqual([mine, imported, other, page].sort());
    expect(await ids({ provider: 'instagram' })).toEqual([mine, imported, other].sort());
    expect(await ids({ connectionId: ig })).toEqual([mine, imported].sort());
    expect(await ids({ source: 'imported' })).toEqual([imported]);
    expect(await ids({ source: 'app', provider: 'facebook' })).toEqual([page]);

    const filtered = await getAnalyticsReport(ws, query({ provider: 'facebook' }), clock);
    // Every account stays listed, so a screen can still offer it; only the selected ones count.
    expect(filtered.accounts.map((a) => [a.displayName, a.selected])).toEqual([
      ['IG', false],
      ['IG two', false],
      ['FB', true],
    ]);
  });

  it('reads followers per account for the period and the one before', async () => {
    const ws = await createWorkspace();
    const ig = await createConnection(ws, 'instagram');
    const gbp = await createConnection(ws, 'gmb', 'Location', { externalId: 'loc' });
    await metrics(ws, { connectionId: ig }, ago(40 * DAY), { followers: 1000 });
    await metrics(ws, { connectionId: ig }, ago(3 * DAY), { followers: 1040 });
    await metrics(ws, { connectionId: ig }, ago(DAY), { followers: 1050 });
    // GBP has no follower metric: a row of that name on it is not a follower count.
    await metrics(ws, { connectionId: gbp }, ago(DAY), { followers: 7, WEBSITE_CLICKS: 3 });

    const report = await getAnalyticsReport(ws, query(), clock);

    expect(report.summary.followers).toEqual({
      value: 1050,
      change: 50,
      deltaPct: 5,
      accounts: 2,
      accountsCounted: 1,
    });
    expect(report.followerSeries).toEqual([
      {
        connectionId: ig,
        points: [
          { day: '2026-10-08', value: 1040 },
          { day: '2026-10-10', value: 1050 },
        ],
      },
    ]);
  });

  it('builds the accumulation curve from stored snapshots only', async () => {
    const ws = await createWorkspace();
    const ig = await createConnection(ws, 'instagram');
    const publishAt = ago(10 * DAY);
    const after = (h: number) => new Date(publishAt.getTime() + h * HOUR);
    for (let i = 0; i < 3; i++) {
      const id = await publishedPost(ws, ig, 'instagram', { publishAt });
      await metrics(ws, { postId: id }, after(2), { likes: 10, views: 50 });
      await metrics(ws, { postId: id }, after(20), { likes: 30, views: 90 });
      await metrics(ws, { postId: id }, after(100), { likes: 40, views: 120 });
      await metrics(ws, { postId: id }, after(200), { likes: 40, views: 130 });
    }
    // An imported post: one recent snapshot, so it cannot say how its engagement arrived.
    const late = await publishedPost(ws, ig, 'instagram', { publishAt, source: 'imported' });
    await metrics(ws, { postId: late }, ago(HOUR), { likes: 400 });

    const { accumulation } = await getAnalyticsReport(ws, query(), clock);

    expect(accumulation).toMatchObject({ postsConsidered: 4, postsUsed: 3 });
    expect(accumulation.points.map((p) => [p.untilHours, p.pct, p.posts])).toEqual([
      [6, 25, 3],
      [12, 25, 3],
      [24, 75, 3],
      [48, 75, 3],
      [168, 100, 3],
      [720, null, 0],
    ]);
    expect(accumulation.halfByHours).toBe(24);
    expect(accumulation.eightyByHours).toBe(168);
  });

  it('carries a thumbnail and a format for each post', async () => {
    const ws = await createWorkspace();
    const ig = await createConnection(ws, 'instagram');
    const mediaId = '99999999-9999-4999-8999-999999999999';
    const image = await publishedPost(ws, ig, 'instagram', {
      media: [{ mediaId, kind: 'image', url: 'https://cdn.test/a.jpg' }],
    });
    const video = await publishedPost(ws, ig, 'instagram', {
      media: [{ mediaId, kind: 'video', thumbnailUrl: 'https://cdn.test/still.jpg' }],
    });
    const text = await publishedPost(ws, ig, 'instagram');

    const { topPosts } = await getAnalyticsReport(ws, query(), clock);
    const of = (id: string) => topPosts.find((p) => p.id === id)!;

    expect(of(image)).toMatchObject({ format: 'image', thumbnailUrl: 'https://cdn.test/a.jpg' });
    expect(of(video)).toMatchObject({
      format: 'video',
      thumbnailUrl: 'https://cdn.test/still.jpg',
    });
    expect(of(text)).toMatchObject({ format: 'text', thumbnailUrl: null });
  });

  it('refuses a timezone that is not an IANA zone', async () => {
    const ws = await createWorkspace();
    await expect(
      getAnalyticsReport(ws, query({ timezone: 'Mars/Olympus' }), clock),
    ).rejects.toBeInstanceOf(AnalyticsQueryError);
  });

  it('is an empty report, not an error, for a workspace with nothing', async () => {
    const ws = await createWorkspace();
    const report = await getAnalyticsReport(ws, query(), clock);
    expect(report.accounts).toEqual([]);
    expect(report.topPosts).toEqual([]);
    expect(report.summary.posts.value).toBe(0);
    expect(report.summary.followers.value).toBeNull();
  });
});

describe('tenant isolation', () => {
  async function seeded(name: string, likes: number) {
    const ws = await createWorkspace(name);
    const conn = await createConnection(ws, 'instagram', `${name} IG`);
    const post = await publishedPost(ws, conn, 'instagram', { caption: `${name} post` });
    await metrics(ws, { postId: post }, ago(HOUR), { likes, reach: 1000 });
    await metrics(ws, { connectionId: conn }, ago(HOUR), { followers: likes * 10 });
    return { ws, conn, post };
  }

  it("never reads another workspace's posts, metrics, accounts or followers (RLS)", async () => {
    const a = await seeded('A', 10);
    const b = await seeded('B', 70);

    const report = await getAnalyticsReport(a.ws, query(), clock);

    expect(report.topPosts.map((p) => p.id)).toEqual([a.post]);
    expect(report.accounts.map((x) => x.id)).toEqual([a.conn]);
    expect(report.summary.totals.likes.value).toBe(10);
    expect(report.summary.followers.value).toBe(100);
    expect(JSON.stringify(report)).not.toContain(b.post);
    expect(JSON.stringify(report)).not.toContain('B post');
  });

  it("cannot be pointed at another workspace's account through the filter", async () => {
    const a = await seeded('A', 10);
    const b = await seeded('B', 70);

    const report = await getAnalyticsReport(a.ws, query({ connectionId: b.conn }), clock);

    expect(report.topPosts).toEqual([]);
    // Its own account is listed and not selected; the other workspace's never appears.
    expect(report.accounts.map((x) => [x.id, x.selected])).toEqual([[a.conn, false]]);
    expect(report.summary.totals.likes.value).toBeNull();
    expect(report.summary.followers.value).toBeNull();
  });

  it('scope=all adds up exactly the workspaces the user belongs to', async () => {
    const a = await seeded('A', 10);
    const b = await seeded('B', 70);
    const c = await seeded('C', 900); // not a member
    const user = await createUser();
    await createMembership(user.id, a.ws, 'owner');
    await createMembership(user.id, b.ws, 'member');

    const report = await getAnalyticsReportForUser(user.id, query({ scope: 'all' }), clock);

    expect(report.topPosts.map((p) => p.id).sort()).toEqual([a.post, b.post].sort());
    expect(report.accounts.map((x) => x.workspaceName).sort()).toEqual(['A', 'B']);
    expect(report.summary.totals.likes.value).toBe(80);
    expect(report.summary.followers.value).toBe(800);
    expect(JSON.stringify(report)).not.toContain(c.post);

    const nobody = await createUser('nobody@test.local');
    const empty = await getAnalyticsReportForUser(nobody.id, query({ scope: 'all' }), clock);
    expect(empty.topPosts).toEqual([]);
    expect(empty.accounts).toEqual([]);
  });
});
