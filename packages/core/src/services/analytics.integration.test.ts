import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { closeDb, schema, withWorkspace } from '@meegrow-social/db';
import { createConnection, createWorkspace, resetDb } from '@meegrow-social/testing';
import { getConnectionFollowers, getPostMetrics, sweepAnalyticsForWorkspace } from './analytics.js';
import { ANALYTICS_UPDATED_EVENT, CONNECTION_NEEDS_RECONNECT_EVENT } from './webhooks.js';
import type { Clock } from './queues.js';

/**
 * The analytics sweeper against a real DB (#9). Uses the fake providers so nothing touches a
 * platform, and an injected clock so cadence transitions are driven rather than waited for.
 */

beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgres://prakhar@localhost:5432/meegrow_social';
  process.env.APP_DATABASE_URL ??= 'postgres://mgs_app:mgs_app@localhost:5432/meegrow_social';
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
});
beforeEach(resetDb);
afterAll(closeDb);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const clockAt = (d: Date): Clock => ({ now: () => d });

async function createPublishedPost(
  workspaceId: string,
  connectionId: string,
  opts: {
    provider?: string;
    externalPostId?: string | null;
    publishAt?: Date;
    lastAnalyticsAt?: Date | null;
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
        provider: opts.provider ?? 'fake',
        status: opts.status ?? 'published',
        caption: 'hello',
        publishAt: opts.publishAt ?? new Date(),
        externalPostId: opts.externalPostId === undefined ? 'ext-post-1' : opts.externalPostId,
        lastAnalyticsAt: opts.lastAnalyticsAt ?? null,
      })
      .returning();
    return post!.id;
  });
}

async function metricRows(workspaceId: string) {
  return withWorkspace(workspaceId, async (tx) =>
    tx.select().from(schema.metrics).orderBy(desc(schema.metrics.createdAt)),
  );
}

describe('sweepAnalyticsForWorkspace', () => {
  it('collects post metrics and stamps lastAnalyticsAt', async () => {
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const postId = await createPublishedPost(ws, conn);
    const now = new Date('2026-07-16T12:00:00Z');

    const r = await sweepAnalyticsForWorkspace(ws, clockAt(now));

    expect(r.postsSwept).toBe(1);
    const rows = await metricRows(ws);
    const postMetric = rows.find((m) => m.postId === postId);
    expect(postMetric).toMatchObject({ metric: 'views', postId });

    const [post] = await withWorkspace(ws, async (tx) =>
      tx.select().from(schema.posts).where(eq(schema.posts.id, postId)),
    );
    expect(post!.lastAnalyticsAt).toEqual(now);
  });

  it('collects account followers on the connection, not the post', async () => {
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const now = new Date('2026-07-16T12:00:00Z');

    const r = await sweepAnalyticsForWorkspace(ws, clockAt(now));

    expect(r.accountsSwept).toBe(1);
    const rows = await metricRows(ws);
    const follower = rows.find((m) => m.metric === 'followers');
    expect(follower).toMatchObject({ connectionId: conn, postId: null, value: '100' });
  });

  it('APPENDS across sweeps rather than upserting — the history is the product', async () => {
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    await createPublishedPost(ws, conn);

    const day1 = new Date('2026-07-16T12:00:00Z');
    await sweepAnalyticsForWorkspace(ws, clockAt(day1));
    await sweepAnalyticsForWorkspace(ws, clockAt(new Date(day1.getTime() + DAY)));

    const rows = await metricRows(ws);
    expect(rows.filter((m) => m.metric === 'views')).toHaveLength(2);
    expect(rows.filter((m) => m.metric === 'followers')).toHaveLength(2);
  });

  it('skips posts that are not due yet (mature post, swept an hour ago)', async () => {
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const now = new Date('2026-07-16T12:00:00Z');
    await createPublishedPost(ws, conn, {
      publishAt: new Date(now.getTime() - 10 * DAY), // mature => daily cadence
      lastAnalyticsAt: new Date(now.getTime() - 2 * HOUR),
    });

    const r = await sweepAnalyticsForWorkspace(ws, clockAt(now));
    expect(r.postsSwept).toBe(0);
  });

  it('skips posts with no externalPostId — there is nothing to poll', async () => {
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    await createPublishedPost(ws, conn, { externalPostId: null });

    const r = await sweepAnalyticsForWorkspace(ws, clockAt(new Date()));
    expect(r.postsSwept).toBe(0);
  });

  it('skips posts that were never published', async () => {
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    await createPublishedPost(ws, conn, { status: 'scheduled' });

    const r = await sweepAnalyticsForWorkspace(ws, clockAt(new Date()));
    expect(r.postsSwept).toBe(0);
  });

  it('emits analytics.updated per post with fresh metrics', async () => {
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const postId = await createPublishedPost(ws, conn);
    await withWorkspace(ws, async (tx) => {
      await tx.insert(schema.webhookEndpoints).values({
        workspaceId: ws,
        url: 'https://example.test/hook',
        secret: 's3cret',
        events: [ANALYTICS_UPDATED_EVENT],
        active: true,
      });
    });

    await sweepAnalyticsForWorkspace(ws, clockAt(new Date()));

    const deliveries = await withWorkspace(ws, async (tx) =>
      tx.select().from(schema.webhookDeliveries),
    );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.eventType).toBe(ANALYTICS_UPDATED_EVENT);
    expect(deliveries[0]!.payload).toMatchObject({ postId, provider: 'fake' });
  });
});

describe('provider failures during the sweep', () => {
  it('an auth failure flags needs_reconnect, emits the event, and does NOT kill the sweep', async () => {
    const ws = await createWorkspace();
    const bad = await createConnection(ws, 'fake_fail_analytics', 'Bad', { externalId: 'bad' });
    const good = await createConnection(ws, 'fake', 'Good', { externalId: 'good' });
    await withWorkspace(ws, async (tx) => {
      await tx.insert(schema.webhookEndpoints).values({
        workspaceId: ws,
        url: 'https://example.test/hook',
        secret: 's3cret',
        events: [CONNECTION_NEEDS_RECONNECT_EVENT],
        active: true,
      });
    });

    const r = await sweepAnalyticsForWorkspace(ws, clockAt(new Date()));

    expect(r.flagged).toBe(1);
    // The healthy account is still swept — one dead account must not abort the workspace.
    expect(r.accountsSwept).toBe(1);

    const conns = await withWorkspace(ws, async (tx) => tx.select().from(schema.connections));
    expect(conns.find((c) => c.id === bad)!.needsReconnect).toBe(true);
    expect(conns.find((c) => c.id === good)!.needsReconnect).toBe(false);

    const deliveries = await withWorkspace(ws, async (tx) =>
      tx.select().from(schema.webhookDeliveries),
    );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.eventType).toBe(CONNECTION_NEEDS_RECONNECT_EVENT);
  });

  it('a transient failure is logged and does NOT flag — the next sweep retries', async () => {
    const ws = await createWorkspace();
    const conn = await createConnection(ws, 'fake_transient_analytics', 'Flaky');

    const r = await sweepAnalyticsForWorkspace(ws, clockAt(new Date()));

    expect(r.flagged).toBe(0);
    const [row] = await withWorkspace(ws, async (tx) =>
      tx.select().from(schema.connections).where(eq(schema.connections.id, conn)),
    );
    // Left alone on purpose: a rate limit is not a broken token.
    expect(row!.needsReconnect).toBe(false);

    const logs = await withWorkspace(ws, async (tx) => tx.select().from(schema.eventLogs));
    expect(logs.some((l) => (l.message ?? '').includes('analytics sweep failed'))).toBe(true);
  });

  it('skips connections already flagged needs_reconnect — no doomed calls', async () => {
    const ws = await createWorkspace();
    const conn = await createConnection(ws, 'fake', 'Dead Account', { needsReconnect: true });
    await createPublishedPost(ws, conn);

    const r = await sweepAnalyticsForWorkspace(ws, clockAt(new Date()));

    expect(r.postsSwept).toBe(0);
    expect(r.accountsSwept).toBe(0);
    expect(await metricRows(ws)).toHaveLength(0);
  });
});

describe('read APIs', () => {
  it('getPostMetrics returns latest-per-name plus the full ascending series', async () => {
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const postId = await createPublishedPost(ws, conn);

    const t0 = new Date('2026-07-16T12:00:00Z');
    await sweepAnalyticsForWorkspace(ws, clockAt(t0));
    await sweepAnalyticsForWorkspace(ws, clockAt(new Date(t0.getTime() + DAY)));

    const { latest, series } = await getPostMetrics(ws, postId);
    expect(series).toHaveLength(2);
    expect(series[0]!.capturedAt.getTime()).toBeLessThanOrEqual(series[1]!.capturedAt.getTime());
    expect(latest.views).toBe(0); // FakeProvider is deterministic
  });

  it('getConnectionFollowers returns the trend newest-first, and only follower rows', async () => {
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    await createPublishedPost(ws, conn);

    const t0 = new Date('2026-07-16T12:00:00Z');
    await sweepAnalyticsForWorkspace(ws, clockAt(t0));
    await sweepAnalyticsForWorkspace(ws, clockAt(new Date(t0.getTime() + DAY)));

    const followers = await getConnectionFollowers(ws, conn);
    expect(followers).toHaveLength(2);
    expect(followers.every((f) => f.metric === 'followers')).toBe(true);
    // newest first
    expect(followers[0]!.capturedAt.getTime()).toBeGreaterThanOrEqual(
      followers[1]!.capturedAt.getTime(),
    );
  });

  it('isolates metrics per workspace (RLS)', async () => {
    const wsA = await createWorkspace();
    const wsB = await createWorkspace();
    const connA = await createConnection(wsA);
    await createPublishedPost(wsA, connA);
    await sweepAnalyticsForWorkspace(wsA, clockAt(new Date()));

    expect(await metricRows(wsA)).not.toHaveLength(0);
    expect(await metricRows(wsB)).toHaveLength(0);
    expect(await getConnectionFollowers(wsB, connA)).toHaveLength(0);
  });
});
