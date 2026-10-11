import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withWorkspace, schema, closeDb } from '@meegrow-social/db';
import { createWorkspace, resetDb, useTestDatabaseEnv } from '@meegrow-social/testing';
import { aggregateEventLogs, pruneEventLogs, queryEventLogs, recordApiRequestLog } from './logs.js';

beforeAll(() => {
  useTestDatabaseEnv();
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
});
beforeEach(resetDb);
afterAll(closeDb);

/** Inserts an event_logs row with an explicit createdAt (bypassing the defaultNow()). */
async function seedLog(
  workspaceId: string,
  overrides: Partial<typeof schema.eventLogs.$inferInsert> & { createdAt: Date },
): Promise<string> {
  const [row] = await withWorkspace(workspaceId, (tx) =>
    tx
      .insert(schema.eventLogs)
      .values({ workspaceId, kind: 'api_request', ...overrides })
      .returning(),
  );
  if (!row) throw new Error('failed to seed event_logs row');
  return row.id;
}

describe('queryEventLogs', () => {
  it('filters by kind/status/platform/route/from/to', async () => {
    const ws = await createWorkspace();
    const base = new Date('2026-07-01T00:00:00.000Z');
    await seedLog(ws, { kind: 'api_request', status: '200', route: '/v1/posts', createdAt: base });
    await seedLog(ws, {
      kind: 'publish',
      status: 'published',
      platform: 'instagram',
      createdAt: new Date(base.getTime() + 60_000),
    });
    await seedLog(ws, {
      kind: 'publish',
      status: 'failed',
      platform: 'tiktok',
      createdAt: new Date(base.getTime() + 120_000),
    });

    const byKind = await queryEventLogs(ws, { kind: 'publish', limit: 50 });
    expect(byKind.items).toHaveLength(2);
    expect(byKind.items.every((i) => i.kind === 'publish')).toBe(true);

    const byStatus = await queryEventLogs(ws, { status: 'failed', limit: 50 });
    expect(byStatus.items).toHaveLength(1);
    expect(byStatus.items[0]?.platform).toBe('tiktok');

    const byPlatform = await queryEventLogs(ws, { platform: 'instagram', limit: 50 });
    expect(byPlatform.items).toHaveLength(1);

    const byRoute = await queryEventLogs(ws, { route: '/v1/posts', limit: 50 });
    expect(byRoute.items).toHaveLength(1);
    expect(byRoute.items[0]?.kind).toBe('api_request');

    const byRange = await queryEventLogs(ws, {
      from: new Date(base.getTime() + 30_000),
      to: new Date(base.getTime() + 90_000),
      limit: 50,
    });
    expect(byRange.items).toHaveLength(1);
    expect(byRange.items[0]?.platform).toBe('instagram');
  });

  it('paginates with a stable keyset cursor, newest first', async () => {
    const ws = await createWorkspace();
    const base = new Date('2026-07-01T00:00:00.000Z');
    for (let i = 0; i < 5; i++) {
      await seedLog(ws, { status: String(i), createdAt: new Date(base.getTime() + i * 1000) });
    }

    const page1 = await queryEventLogs(ws, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.items.map((i) => i.status)).toEqual(['4', '3']); // newest first
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await queryEventLogs(ws, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.items.map((i) => i.status)).toEqual(['2', '1']);
    expect(page2.nextCursor).not.toBeNull();

    const page3 = await queryEventLogs(ws, { limit: 2, cursor: page2.nextCursor! });
    expect(page3.items.map((i) => i.status)).toEqual(['0']);
    expect(page3.nextCursor).toBeNull(); // exhausted

    // No overlap/gaps across pages.
    const seen = [...page1.items, ...page2.items, ...page3.items].map((i) => i.status);
    expect(new Set(seen).size).toBe(5);
  });

  it('never returns another workspace’s logs', async () => {
    const a = await createWorkspace('A');
    const b = await createWorkspace('B');
    await seedLog(a, { status: 'a-only', createdAt: new Date() });
    await seedLog(b, { status: 'b-only', createdAt: new Date() });

    const result = await queryEventLogs(a, { limit: 50 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.status).toBe('a-only');
  });
});

describe('aggregateEventLogs', () => {
  it('buckets counts by status over the window', async () => {
    const ws = await createWorkspace();
    const from = new Date('2026-07-01T00:00:00.000Z');
    await seedLog(ws, { status: '200', createdAt: new Date(from.getTime() + 5 * 60_000) });
    await seedLog(ws, { status: '500', createdAt: new Date(from.getTime() + 10 * 60_000) });
    await seedLog(ws, { status: '200', createdAt: new Date(from.getTime() + 70 * 60_000) });

    const result = await aggregateEventLogs(ws, {
      from,
      to: new Date(from.getTime() + 2 * 60 * 60_000),
      bucketMinutes: 60,
    });

    expect(result.buckets).toHaveLength(3);
    expect(result.buckets[0]?.total).toBe(2);
    expect(result.buckets[0]?.errorCount).toBe(1);
    expect(result.buckets[1]?.total).toBe(1);
    expect(result.buckets[2]?.total).toBe(0);
  });
});

describe('recordApiRequestLog', () => {
  it('inserts an api_request row scoped to the workspace', async () => {
    const ws = await createWorkspace();
    await recordApiRequestLog({
      workspaceId: ws,
      route: '/v1/posts',
      status: 201,
      durationMs: 12.7,
    });

    const { items } = await queryEventLogs(ws, { kind: 'api_request', limit: 10 });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ route: '/v1/posts', status: '201', durationMs: 13 });
  });
});

describe('pruneEventLogs', () => {
  it('deletes only rows older than the retention window, across workspaces', async () => {
    const a = await createWorkspace('A');
    const b = await createWorkspace('B');
    const now = new Date('2026-07-07T00:00:00.000Z');
    const old = new Date(now.getTime() - 91 * 24 * 60 * 60 * 1000);
    const recent = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);

    const oldIdA = await seedLog(a, { status: 'old', createdAt: old });
    const recentIdA = await seedLog(a, { status: 'recent', createdAt: recent });
    const oldIdB = await seedLog(b, { status: 'old', createdAt: old });

    const deleted = await pruneEventLogs(now, 90);
    expect(deleted).toBe(2);

    const remainingA = await withWorkspace(a, (tx) => tx.select().from(schema.eventLogs));
    expect(remainingA.map((r) => r.id)).toEqual([recentIdA]);
    expect(remainingA.map((r) => r.id)).not.toContain(oldIdA);

    const remainingB = await withWorkspace(b, (tx) => tx.select().from(schema.eventLogs));
    expect(remainingB).toHaveLength(0);
    expect(remainingB.map((r) => r.id)).not.toContain(oldIdB);
  });
});
