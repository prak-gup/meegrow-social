import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, schema, withWorkspace } from '@meegrow-social/db';
import {
  createConnection,
  createWorkspace,
  resetDb,
  useTestDatabaseEnv,
} from '@meegrow-social/testing';
import { ANALYTICS_CADENCE, getAnalyticsStatus, getLatestPostMetrics } from './analytics.js';
import type { Clock } from './queues.js';

/**
 * The bulk metrics read and the sync status against a real database (#28). Rows are written
 * directly: what is under test is the reads, not the sweep that normally produces the rows.
 */

beforeAll(() => {
  useTestDatabaseEnv();
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
});
beforeEach(resetDb);
afterAll(closeDb);

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = new Date('2026-10-11T12:00:00Z');
const clock: Clock = { now: () => NOW };
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const NONEXISTENT = '00000000-0000-0000-0000-000000000000';

async function publishedPost(
  workspaceId: string,
  connectionId: string,
  opts: {
    publishAt?: Date | null;
    lastAnalyticsAt?: Date | null;
    externalPostId?: string | null;
    status?: string;
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
        provider: 'fake',
        status: opts.status ?? 'published',
        publishAt: opts.publishAt === undefined ? ago(10 * DAY) : opts.publishAt,
        externalPostId: opts.externalPostId === undefined ? 'ext-1' : opts.externalPostId,
        lastAnalyticsAt: opts.lastAnalyticsAt ?? null,
      })
      .returning();
    return post!.id;
  });
}

async function metric(
  workspaceId: string,
  target: { postId?: string; connectionId?: string },
  name: string,
  value: number,
  capturedAt: Date,
): Promise<void> {
  await withWorkspace(workspaceId, async (tx) => {
    await tx.insert(schema.metrics).values({
      workspaceId,
      postId: target.postId ?? null,
      connectionId: target.connectionId ?? null,
      metric: name,
      value: String(value),
      capturedAt,
    });
  });
}

async function setConnection(
  workspaceId: string,
  connectionId: string,
  set: Partial<typeof schema.connections.$inferInsert>,
): Promise<void> {
  await withWorkspace(workspaceId, async (tx) => {
    await tx.update(schema.connections).set(set).where(eq(schema.connections.id, connectionId));
  });
}

describe('getLatestPostMetrics', () => {
  it('returns the newest value per metric name for each post, names verbatim', async () => {
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const [a, b] = [await publishedPost(ws, conn), await publishedPost(ws, conn)];
    await metric(ws, { postId: a }, 'views', 10, ago(2 * DAY));
    await metric(ws, { postId: a }, 'views', 25, ago(DAY));
    await metric(ws, { postId: a }, 'LOCAL_POST_VIEWS_SEARCH', 4, ago(3 * DAY));
    await metric(ws, { postId: b }, 'post_media_view', 7, ago(HOUR));

    const metrics = await getLatestPostMetrics(ws, [a, b]);

    expect(metrics[a]).toEqual({
      latest: { views: 25, LOCAL_POST_VIEWS_SEARCH: 4 },
      capturedAt: ago(DAY),
    });
    expect(metrics[b]).toEqual({ latest: { post_media_view: 7 }, capturedAt: ago(HOUR) });
  });

  it('gives a post with nothing collected an empty entry, and an unknown id no entry', async () => {
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const quiet = await publishedPost(ws, conn);

    const metrics = await getLatestPostMetrics(ws, [quiet, NONEXISTENT, quiet]);

    expect(metrics).toEqual({ [quiet]: { latest: {}, capturedAt: null } });
    expect(await getLatestPostMetrics(ws, [])).toEqual({});
  });

  it('leaves account-level rows out of a post’s numbers', async () => {
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const post = await publishedPost(ws, conn);
    await metric(ws, { connectionId: conn }, 'followers', 900, ago(HOUR));
    await metric(ws, { postId: post }, 'likes', 3, ago(HOUR));

    expect((await getLatestPostMetrics(ws, [post]))[post]?.latest).toEqual({ likes: 3 });
  });

  it("does not read another workspace's posts or metrics (RLS)", async () => {
    const [a, b] = [await createWorkspace('A'), await createWorkspace('B')];
    const connB = await createConnection(b);
    const theirs = await publishedPost(b, connB);
    await metric(b, { postId: theirs }, 'views', 99, ago(HOUR));

    expect(await getLatestPostMetrics(a, [theirs])).toEqual({});
    expect((await getLatestPostMetrics(b, [theirs]))[theirs]?.latest).toEqual({ views: 99 });
  });

  it('answers for 200 posts at once', async () => {
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const ids: string[] = [];
    for (let i = 0; i < 200; i++) ids.push(await publishedPost(ws, conn));
    await metric(ws, { postId: ids[199]! }, 'views', 1, ago(HOUR));

    const metrics = await getLatestPostMetrics(ws, ids);

    expect(Object.keys(metrics)).toHaveLength(200);
    expect(metrics[ids[199]!]?.latest).toEqual({ views: 1 });
  });
});

describe('getAnalyticsStatus', () => {
  it('is all nulls, with the cadence, for a workspace with nothing connected', async () => {
    const ws = await createWorkspace();
    expect(await getAnalyticsStatus(ws, clock)).toEqual({
      lastCapturedAt: null,
      lastSweptAt: null,
      nextDueAt: null,
      cadence: ANALYTICS_CADENCE,
    });
  });

  it('is due now for an account that has never been swept', async () => {
    const ws = await createWorkspace();
    await createConnection(ws);
    const status = await getAnalyticsStatus(ws, clock);
    expect(status.nextDueAt).toEqual(NOW);
    expect(status.lastSweptAt).toBeNull();
  });

  it('reports the newest capture, the last sweep, and the earliest due time by the sweep’s own rules', async () => {
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    await setConnection(ws, conn, { lastAnalyticsAt: ago(3 * HOUR) }); // due in 21h
    // Fresh post swept 20 minutes ago: due in 40 minutes — the earliest of the three.
    const fresh = await publishedPost(ws, conn, {
      publishAt: ago(5 * HOUR),
      lastAnalyticsAt: ago(20 * MINUTE),
    });
    // Mature post swept 2 hours ago: due in 22h.
    await publishedPost(ws, conn, { publishAt: ago(9 * DAY), lastAnalyticsAt: ago(2 * HOUR) });
    await metric(ws, { postId: fresh }, 'views', 5, ago(25 * MINUTE));
    await metric(ws, { connectionId: conn }, 'followers', 100, ago(3 * HOUR));

    expect(await getAnalyticsStatus(ws, clock)).toEqual({
      lastCapturedAt: ago(25 * MINUTE),
      lastSweptAt: ago(20 * MINUTE),
      nextDueAt: new Date(NOW.getTime() + 40 * MINUTE),
      cadence: ANALYTICS_CADENCE,
    });
  });

  it('is due now when a mature post has never been swept, however recently the rest were', async () => {
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    await setConnection(ws, conn, { lastAnalyticsAt: ago(HOUR) });
    await publishedPost(ws, conn, { publishAt: ago(9 * DAY), lastAnalyticsAt: ago(HOUR) });
    await publishedPost(ws, conn, { publishAt: null, lastAnalyticsAt: null });

    expect((await getAnalyticsStatus(ws, clock)).nextDueAt).toEqual(NOW);
  });

  it('ignores what the sweep cannot poll: unpublished posts, posts with no platform id, flagged accounts', async () => {
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    await setConnection(ws, conn, { lastAnalyticsAt: ago(HOUR) });
    await publishedPost(ws, conn, { lastAnalyticsAt: null, status: 'failed' });
    await publishedPost(ws, conn, { lastAnalyticsAt: null, externalPostId: null });
    const flagged = await createConnection(ws, 'fake', 'Flagged', {
      externalId: 'flagged',
      needsReconnect: true,
    });
    await publishedPost(ws, flagged, { lastAnalyticsAt: null });

    // Only the healthy account counts: due a day after its last sweep.
    expect((await getAnalyticsStatus(ws, clock)).nextDueAt).toEqual(
      new Date(NOW.getTime() - HOUR + DAY),
    );

    await setConnection(ws, conn, { needsReconnect: true });
    expect((await getAnalyticsStatus(ws, clock)).nextDueAt).toBeNull();
  });

  it("is computed from this workspace's rows only (RLS)", async () => {
    const [a, b] = [await createWorkspace('A'), await createWorkspace('B')];
    const connB = await createConnection(b);
    const post = await publishedPost(b, connB, { lastAnalyticsAt: ago(HOUR) });
    await metric(b, { postId: post }, 'views', 1, ago(HOUR));

    const status = await getAnalyticsStatus(a, clock);
    expect(status.lastCapturedAt).toBeNull();
    expect(status.lastSweptAt).toBeNull();
    expect(status.nextDueAt).toBeNull();
  });
});
