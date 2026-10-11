import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, schema, withWorkspace } from '@meegrow-social/db';
import {
  createConnection,
  createWorkspace,
  resetDb,
  useTestDatabaseEnv,
} from '@meegrow-social/testing';
import { getConnectionFollowers, getPostMetrics } from './analytics.js';
import { deleteConnection } from './connections.js';
import { pruneExpiredMetrics } from './metrics-retention.js';

/**
 * Metric retention against a real DB (#61).
 *
 * NEVER RUN when written: there was no Postgres in the environment this was built in. It follows
 * analytics.integration.test.ts line for line in setup, but the first `pnpm test:integration` is
 * its first execution — read a failure here as "the test may be wrong" before "the code is wrong".
 */

beforeAll(() => {
  useTestDatabaseEnv();
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
});
beforeEach(resetDb);
afterAll(closeDb);

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-11T09:30:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

async function createPost(workspaceId: string, connectionId: string, provider: string) {
  return withWorkspace(workspaceId, async (tx) => {
    const [group] = await tx.insert(schema.postGroups).values({ workspaceId }).returning();
    const [post] = await tx
      .insert(schema.posts)
      .values({
        workspaceId,
        groupId: group!.id,
        connectionId,
        provider,
        status: 'published',
        caption: 'hello',
        publishAt: daysAgo(60),
        externalPostId: 'ext-1',
      })
      .returning();
    return post!.id;
  });
}

/** One metric row stored `storedDaysAgo` days ago. */
async function storeMetric(
  workspaceId: string,
  target: { postId?: string; connectionId?: string },
  metric: string,
  storedDaysAgo: number,
): Promise<void> {
  await withWorkspace(workspaceId, async (tx) => {
    await tx.insert(schema.metrics).values({
      workspaceId,
      postId: target.postId ?? null,
      connectionId: target.connectionId ?? null,
      metric,
      value: '1',
      capturedAt: daysAgo(storedDaysAgo),
      createdAt: daysAgo(storedDaysAgo),
    });
  });
}

const countMetrics = (workspaceId: string) =>
  withWorkspace(workspaceId, async (tx) => (await tx.select().from(schema.metrics)).length);

describe('pruneExpiredMetrics', () => {
  it('deletes YouTube rows past the limit, per-post and account-level, and keeps recent ones', async () => {
    const ws = await createWorkspace();
    const conn = await createConnection(ws, 'youtube', 'Channel');
    const post = await createPost(ws, conn, 'youtube');
    await storeMetric(ws, { postId: post }, 'viewCount', 45);
    await storeMetric(ws, { postId: post }, 'viewCount', 30);
    await storeMetric(ws, { postId: post }, 'viewCount', 5);
    await storeMetric(ws, { connectionId: conn }, 'followers', 45);
    await storeMetric(ws, { connectionId: conn }, 'followers', 1);

    const result = await pruneExpiredMetrics(NOW);

    expect(result.expired.youtube).toBe(3);
    // The read APIs need no special case: they simply see fewer rows.
    expect((await getPostMetrics(ws, post)).series).toHaveLength(1);
    expect(await getConnectionFollowers(ws, conn)).toHaveLength(1);
  });

  it('never touches another platform’s history, whatever its age or metric name', async () => {
    const ws = await createWorkspace();
    const conn = await createConnection(ws, 'facebook', 'Page');
    const post = await createPost(ws, conn, 'facebook');
    // Same metric names as YouTube emits — the match is on the source, never the name.
    await storeMetric(ws, { postId: post }, 'viewCount', 400);
    await storeMetric(ws, { connectionId: conn }, 'followers', 400);

    const result = await pruneExpiredMetrics(NOW);

    expect(result.expired.youtube).toBe(0);
    expect(await countMetrics(ws)).toBe(2);
  });

  it('measures age from when the row was stored, not the day it describes', async () => {
    const ws = await createWorkspace();
    const conn = await createConnection(ws, 'youtube', 'Channel');
    await withWorkspace(ws, async (tx) => {
      // Stored yesterday, describing a day long past.
      await tx.insert(schema.metrics).values({
        workspaceId: ws,
        connectionId: conn,
        metric: 'views',
        value: '1',
        capturedAt: daysAgo(90),
        createdAt: daysAgo(1),
      });
    });
    await pruneExpiredMetrics(NOW);
    expect(await countMetrics(ws)).toBe(1);
  });

  it('leaves rows whose connection or post is gone — they can no longer be attributed to a platform', async () => {
    const ws = await createWorkspace();
    const conn = await createConnection(ws, 'facebook', 'Page');
    const post = await createPost(ws, conn, 'facebook');
    await storeMetric(ws, { connectionId: conn }, 'followers', 45);
    await storeMetric(ws, { connectionId: conn }, 'followers', 2);
    await storeMetric(ws, { postId: post }, 'viewCount', 45);
    await deleteConnection(ws, conn);
    await withWorkspace(ws, async (tx) => {
      await tx.delete(schema.posts).where(eq(schema.posts.id, post));
    });

    const result = await pruneExpiredMetrics(NOW);

    expect(result.expired.youtube).toBe(0);
    expect(await countMetrics(ws)).toBe(3);
  });

  it('disconnecting a YouTube account deletes its metrics at once, whatever their age', async () => {
    const ws = await createWorkspace();
    const yt = await createConnection(ws, 'youtube', 'Channel');
    const ytPost = await createPost(ws, yt, 'youtube');
    const fb = await createConnection(ws, 'facebook', 'Page');
    const fbPost = await createPost(ws, fb, 'facebook');
    await storeMetric(ws, { connectionId: yt }, 'followers', 1);
    await storeMetric(ws, { postId: ytPost }, 'viewCount', 1);
    await storeMetric(ws, { connectionId: fb }, 'followers', 1);
    await storeMetric(ws, { postId: fbPost }, 'viewCount', 1);

    await deleteConnection(ws, yt);
    // Only the YouTube rows went; the Facebook connection and its history are untouched.
    expect(await countMetrics(ws)).toBe(2);

    await deleteConnection(ws, fb);
    // Another platform keeps its history when its connection is removed.
    expect(await countMetrics(ws)).toBe(2);
  });

  it('stays inside each workspace', async () => {
    const a = await createWorkspace('A');
    const b = await createWorkspace('B');
    const connA = await createConnection(a, 'youtube', 'A');
    const connB = await createConnection(b, 'youtube', 'B');
    await storeMetric(a, { connectionId: connA }, 'followers', 45);
    await storeMetric(b, { connectionId: connB }, 'followers', 45);
    await storeMetric(b, { connectionId: connB }, 'followers', 1);

    expect((await pruneExpiredMetrics(NOW)).expired.youtube).toBe(2);
    expect(await countMetrics(a)).toBe(0);
    expect(await countMetrics(b)).toBe(1);
  });
});
