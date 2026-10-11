import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, db, schema } from '@meegrow-social/db';
import {
  createConnection,
  createWorkspace,
  resetDb,
  useRecordingScheduler,
} from '@meegrow-social/testing';
import {
  deleteConnection,
  finishConnect,
  getConnectionHealth,
  handleCallback,
  listConnectionHealth,
  listConnections,
  startConnect,
} from './connections.js';
import { createPost } from './posts.js';

beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgres://prakhar@localhost:5432/meegrow_social';
  process.env.APP_DATABASE_URL ??= 'postgres://mgs_app:mgs_app@localhost:5432/meegrow_social';
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
});
beforeEach(resetDb);
afterAll(closeDb);

const APP = 'http://localhost:8990';
const NONEXISTENT = '00000000-0000-0000-0000-000000000000';

describe('OAuth connect flow', () => {
  it('single-step provider connects directly on callback', async () => {
    const ws = await createWorkspace();
    const { flowId } = await startConnect(ws, 'fake', APP);
    const result = await handleCallback(flowId, 'auth-code');
    expect(result.status).toBe('connected');

    const conns = await listConnections(ws);
    expect(conns).toHaveLength(1);
    expect(conns[0]?.displayName).toBe('Fake Account');
    expect(conns[0]?.health).toBe('healthy');
    // FakeProvider issues tokens with no expiry → both null on the view (#12).
    expect(conns[0]?.expiresAt).toBeNull();
    expect(conns[0]?.expiresInDays).toBeNull();
  });

  it('two-step provider requires an account pick, then finishes', async () => {
    const ws = await createWorkspace();
    const { flowId } = await startConnect(ws, 'fake_2step', APP);
    const result = await handleCallback(flowId, 'auth-code');
    expect(result.status).toBe('choose_account');
    if (result.status !== 'choose_account') throw new Error('unreachable');
    expect(result.accounts.map((a) => a.externalId)).toEqual(['page-1', 'page-2']);

    await finishConnect(ws, flowId, 'page-2');
    const conns = await listConnections(ws);
    expect(conns).toHaveLength(1);
    expect(conns[0]?.displayName).toBe('Page Two');
    expect(conns[0]?.externalId).toBe('page-2');
  });

  it('rejects an unknown/tampered state', async () => {
    await expect(handleCallback(NONEXISTENT, 'auth-code')).rejects.toThrow();
  });

  it('rejects replay of a consumed flow', async () => {
    const ws = await createWorkspace();
    const { flowId } = await startConnect(ws, 'fake', APP);
    await handleCallback(flowId, 'auth-code'); // consumes it
    await expect(handleCallback(flowId, 'auth-code')).rejects.toThrow();
  });

  it('rejects finishing an account pick for the wrong workspace', async () => {
    const wsA = await createWorkspace('A');
    const wsB = await createWorkspace('B');
    const { flowId } = await startConnect(wsA, 'fake_2step', APP);
    await handleCallback(flowId, 'auth-code');
    await expect(finishConnect(wsB, flowId, 'page-1')).rejects.toThrow();
  });

  it('rejects an account not in the offered list', async () => {
    const ws = await createWorkspace();
    const { flowId } = await startConnect(ws, 'fake_2step', APP);
    await handleCallback(flowId, 'auth-code');
    await expect(finishConnect(ws, flowId, 'page-999')).rejects.toThrow();
  });

  it('disconnect removes the connection', async () => {
    const ws = await createWorkspace();
    const { flowId } = await startConnect(ws, 'fake', APP);
    const result = await handleCallback(flowId, 'auth-code');
    if (result.status !== 'connected') throw new Error('unreachable');
    expect(await deleteConnection(ws, result.connectionId)).toBe(true);
    expect(await listConnections(ws)).toHaveLength(0);
  });
});

describe('connection health (from stored state only)', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('reports one entry per connection of the workspace, each with status, reason and action', async () => {
    const ws = await createWorkspace();
    const healthy = await createConnection(ws, 'fake', 'Healthy', { externalId: 'h' });
    const flagged = await createConnection(ws, 'fake', 'Flagged', {
      externalId: 'f',
      needsReconnect: true,
    });
    const expiring = await createConnection(ws, 'fake', 'Expiring', {
      externalId: 'e',
      refreshToken: 'refresh',
      expiresAt: new Date(Date.now() + 3 * DAY + 60_000),
    });
    const expired = await createConnection(ws, 'fake_onetime', 'Expired', {
      externalId: 'x',
      tokenModel: 'one-time',
      expiresAt: new Date(Date.now() - 2 * DAY),
    });

    const reports = await listConnectionHealth(ws);
    const byId = new Map(reports.map((r) => [r.connectionId, r]));
    expect(reports).toHaveLength(4);

    expect(byId.get(healthy)).toMatchObject({
      status: 'healthy',
      displayName: 'Healthy',
      provider: 'fake',
      recommendedAction: 'None.',
      expiresAt: null,
      expiresInDays: null,
      lastAnalyticsAt: null,
      lastFailedPost: null,
      source: 'stored',
    });
    expect(byId.get(flagged)).toMatchObject({ status: 'needs_reconnect', needsReconnect: true });
    expect(byId.get(expiring)).toMatchObject({
      status: 'expiring',
      autoRefresh: true,
      expiresInDays: 3,
    });
    expect(byId.get(expired)).toMatchObject({
      status: 'expired',
      autoRefresh: false,
      tokenModel: 'one-time',
    });
    for (const report of reports) {
      expect(report.reason.length).toBeGreaterThan(10);
      expect(report.recommendedAction.length).toBeGreaterThan(3);
      expect(report.checkedAt).toBeInstanceOf(Date);
    }
  });

  it('agrees with the health field list_connections already returns', async () => {
    const ws = await createWorkspace();
    await createConnection(ws, 'fake', 'A', { externalId: 'a', needsReconnect: true });
    await createConnection(ws, 'fake', 'B', {
      externalId: 'b',
      expiresAt: new Date(Date.now() + 2 * DAY),
    });
    await createConnection(ws, 'fake', 'C', { externalId: 'c' });

    const badge = new Map((await listConnections(ws)).map((c) => [c.id, c.health]));
    for (const report of await listConnectionHealth(ws)) {
      expect(report.status).toBe(badge.get(report.connectionId));
    }
  });

  it('surfaces the newest currently-failed post of the account, without changing the status', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const conn = await createConnection(ws, 'fake', 'A', { externalId: 'a' });
    const quiet = await createConnection(ws, 'fake', 'B', { externalId: 'b' });
    const make = async (caption: string) =>
      (await createPost(ws, { caption, variants: [{ connectionId: conn, provider: 'fake' }] }))[0]!;
    const older = await make('older');
    const newer = await make('newer');
    await make('a draft that never failed');
    // Test setup only — the admin handle forces the failed state a real publish would record.
    const base = Date.now();
    for (const [post, error, ageMs] of [
      [older, 'first failure', 60_000],
      [newer, 'second failure', 0],
    ] as const) {
      await db()
        .update(schema.posts)
        .set({ status: 'failed', error, createdAt: new Date(base - ageMs) })
        .where(eq(schema.posts.id, post.id));
    }

    const report = await getConnectionHealth(ws, conn);
    expect(report).toMatchObject({
      status: 'healthy',
      lastFailedPost: { postId: newer.id, error: 'second failure', publishAt: null },
    });
    expect((await getConnectionHealth(ws, quiet))?.lastFailedPost).toBeNull();
  });

  it('includes the last analytics sweep time when there is one', async () => {
    const ws = await createWorkspace();
    const conn = await createConnection(ws);
    const sweptAt = new Date('2026-10-01T06:00:00.000Z');
    await db()
      .update(schema.connections)
      .set({ lastAnalyticsAt: sweptAt })
      .where(eq(schema.connections.id, conn));
    expect((await getConnectionHealth(ws, conn))?.lastAnalyticsAt).toEqual(sweptAt);
  });

  it("never reports another workspace's connection, by list or by id", async () => {
    const mine = await createWorkspace('Mine');
    const theirs = await createWorkspace('Theirs');
    const myConn = await createConnection(mine);
    const theirConn = await createConnection(theirs);

    expect((await listConnectionHealth(mine)).map((r) => r.connectionId)).toEqual([myConn]);
    expect(await getConnectionHealth(mine, theirConn)).toBeNull();
    expect(await getConnectionHealth(mine, NONEXISTENT)).toBeNull();
    expect(await listConnectionHealth(await createWorkspace('Empty'))).toEqual([]);
  });
});
