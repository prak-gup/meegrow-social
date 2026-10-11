import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@meegrow-social/db';
import type * as DbModule from '@meegrow-social/db';
import { overviewForUser } from './overview.js';

/**
 * `overviewForUser` against a stand-in for the db handles (no Postgres in unit tests): every query
 * on a table resolves to that table's canned rows, whatever its WHERE/ORDER BY. What is under test
 * is which rows the rollup counts — the SQL itself is covered by overview.integration.test.ts.
 */
const now = new Date('2026-07-21T09:00:00Z');
const clock = { now: () => now };
const WS = 'ws-1';

type Row = Record<string, unknown>;
const tables = new Map<unknown, Row[]>();

function query(rows: Row[]) {
  const q: Record<string, unknown> = {};
  for (const step of ['where', 'orderBy', 'limit', 'innerJoin']) q[step] = () => q;
  q.then = (resolve: (r: Row[]) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return q;
}
const handle = { select: () => ({ from: (table: unknown) => query(tables.get(table) ?? []) }) };

vi.mock('@meegrow-social/db', async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  db: () => handle,
  withWorkspace: async <T>(_ws: string, fn: (tx: typeof handle) => Promise<T>) => fn(handle),
}));

const conn = (id: string, provider: string, over: Row = {}): Row => ({
  id,
  provider,
  tokenModel: 'auto-refresh',
  needsReconnect: false,
  expiresAt: null,
  ...over,
});
const post = (provider: string, status: string, over: Row = {}): Row => ({
  provider,
  status,
  caption: `${provider} ${status}`,
  publishAt: null,
  createdAt: new Date(now.getTime() - 3600_000),
  ...over,
});
const followers = (connectionId: string, value: number, capturedAt: Date): Row => ({
  connectionId,
  metric: 'followers',
  value: String(value),
  capturedAt,
});

const soon = new Date(now.getTime() + 2 * 3600_000);

/** Three real accounts and one on the test-only `fake` provider, as seen on the live Overview. */
function seedWorkspaceWithAFakeConnection(): void {
  tables.set(schema.memberships, [{ workspaceId: WS, role: 'owner', name: 'Acme', slug: 'acme' }]);
  tables.set(schema.apiKeys, []);
  tables.set(schema.connections, [
    conn('c-fb', 'facebook'),
    conn('c-ig', 'instagram'),
    conn('c-gmb', 'gmb'),
    conn('c-fake', 'fake', {
      needsReconnect: true,
      expiresAt: new Date(now.getTime() + 3600_000),
    }),
  ]);
  tables.set(schema.metrics, [
    followers('c-fb', 20, now),
    followers('c-ig', 10, now),
    followers('c-gmb', 4, now),
    followers('c-fake', 100, new Date(0)),
    // A connection that no longer exists: `metrics` has no FK, so its rows outlive it.
    followers('c-removed', 5000, now),
  ]);
  tables.set(schema.posts, [
    post('facebook', 'published'),
    post('fake', 'published'),
    post('fake', 'failed'),
    post('fake', 'scheduled', { publishAt: soon }),
  ]);
}

beforeEach(() => {
  tables.clear();
  seedWorkspaceWithAFakeConnection();
});
afterEach(() => vi.unstubAllEnvs());

describe('overviewForUser — test-only providers', () => {
  it('in production counts only the real accounts, their followers and their posts', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const ov = await overviewForUser('user-1', clock);
    const client = ov.clients[0]!;

    expect(client.connectionCount).toBe(3);
    expect(client.followers).toBe(34);
    expect(client.publishedThisWeek).toBe(1);
    expect(client.failedThisWeek).toBe(0);
    // The only scheduled post is on the fake, so for the user this queue is empty.
    expect(client.nextPublishAt).toBeNull();
    expect(ov.upcoming).toEqual([]);
    expect(ov.weekTotals.publishedThisWeek).toBe(1);
    expect(ov.attention).toEqual({
      failedPublishes: 0,
      needsReconnect: 0,
      tokensExpiring: 0,
      emptyQueues: 1,
    });
    // The fake's needs_reconnect no longer turns the client red; the empty queue makes it warn.
    expect(client.health).toBe('warn');
  });

  it('outside production keeps counting them — dev and CI run on the fakes', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const ov = await overviewForUser('user-1', clock);
    const client = ov.clients[0]!;

    expect(client.connectionCount).toBe(4);
    expect(client.followers).toBe(134);
    expect(client.publishedThisWeek).toBe(2);
    expect(client.failedThisWeek).toBe(1);
    expect(client.nextPublishAt).toEqual(soon);
    expect(ov.upcoming.map((u) => u.provider)).toEqual(['fake']);
    expect(ov.attention).toEqual({
      failedPublishes: 1,
      needsReconnect: 1,
      tokensExpiring: 0,
      emptyQueues: 0,
    });
    expect(client.health).toBe('bad');
  });

  it('counts them in production again with SHOW_FAKE_PROVIDERS=true', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SHOW_FAKE_PROVIDERS', 'true');
    const ov = await overviewForUser('user-1', clock);
    expect(ov.clients[0]!.connectionCount).toBe(4);
    expect(ov.clients[0]!.followers).toBe(134);
  });

  it('reports no followers, not zero, for a workspace whose only account is a fake', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    tables.set(schema.connections, [conn('c-fake', 'fake')]);
    const ov = await overviewForUser('user-1', clock);
    expect(ov.clients[0]!.connectionCount).toBe(0);
    expect(ov.clients[0]!.followers).toBeNull();
  });

  it('never sums the followers of a connection that has been removed', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const ov = await overviewForUser('user-1', clock);
    expect(ov.clients[0]!.followers).toBe(134); // not 5134
  });
});
