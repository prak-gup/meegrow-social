import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, schema, withWorkspace } from '@meegrow-social/db';
import { createConnection, createUser, createWorkspace, resetDb } from '@meegrow-social/testing';
import { createClientWorkspace, getWorkspace, overviewForUser } from './overview.js';
import type { Clock } from './queues.js';

/**
 * Cross-client overview against a real DB (#redesign). The point of the endpoint is that it spans
 * EVERY workspace the user belongs to — so the tests wire a user into multiple workspaces and
 * assert the rollup stitches them, while a non-member's workspace never leaks in.
 */

beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgres://prakhar@localhost:5432/meegrow_social';
  process.env.APP_DATABASE_URL ??= 'postgres://mgs_app:mgs_app@localhost:5432/meegrow_social';
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
});
beforeEach(resetDb);
afterAll(closeDb);

const now = new Date('2026-07-21T09:00:00Z');
const clock: Clock = { now: () => now };
const HOUR = 3600_000;

async function member(userId: string, wsId: string) {
  await withWorkspace(wsId, async () => undefined); // ensure ws exists
  const { db } = await import('@meegrow-social/db');
  await db().insert(schema.memberships).values({ userId, workspaceId: wsId, role: 'owner' });
}

async function publishedPost(
  wsId: string,
  connId: string,
  opts: { status?: string; publishAt?: Date; createdAt?: Date } = {},
) {
  return withWorkspace(wsId, async (tx) => {
    const [g] = await tx.insert(schema.postGroups).values({ workspaceId: wsId }).returning();
    await tx.insert(schema.posts).values({
      workspaceId: wsId,
      groupId: g!.id,
      connectionId: connId,
      provider: 'fake',
      status: opts.status ?? 'published',
      caption: 'hi',
      publishAt: opts.publishAt ?? null,
      externalPostId: 'x',
    });
  });
}

describe('overviewForUser', () => {
  it('rolls up every workspace the user belongs to, sorted by name', async () => {
    const { id: uid } = await createUser();
    const wsA = await createWorkspace('Alpha');
    const wsB = await createWorkspace('Bravo');
    await member(uid, wsA);
    await member(uid, wsB);
    await createConnection(wsA);
    await createConnection(wsB);

    const ov = await overviewForUser(uid, clock);

    expect(ov.clients.map((c) => c.name)).toEqual(['Alpha', 'Bravo']);
    expect(ov.clients[0]!.connectionCount).toBe(1);
  });

  it('never includes a workspace the user is not a member of', async () => {
    const { id: uid } = await createUser();
    const mine = await createWorkspace('Mine');
    const notMine = await createWorkspace('NotMine');
    await member(uid, mine);
    await createConnection(notMine);

    const ov = await overviewForUser(uid, clock);
    expect(ov.clients.map((c) => c.name)).toEqual(['Mine']);
  });

  it('counts this-week published + failed and aggregates attention', async () => {
    const { id: uid } = await createUser();
    const ws = await createWorkspace('Ecolive');
    await member(uid, ws);
    const conn = await createConnection(ws);
    await publishedPost(ws, conn, { status: 'published' });
    await publishedPost(ws, conn, { status: 'published' });
    await publishedPost(ws, conn, { status: 'failed' });

    const ov = await overviewForUser(uid, clock);
    const c = ov.clients[0]!;
    expect(c.publishedThisWeek).toBe(2);
    expect(c.failedThisWeek).toBe(1);
    expect(ov.attention.failedPublishes).toBe(1);
    // no future-scheduled post => queue reads empty, and 1 failure => health warn
    expect(ov.attention.emptyQueues).toBe(1);
    expect(c.health).toBe('warn');
  });

  it('surfaces the next scheduled post and lists it in upcoming', async () => {
    const { id: uid } = await createUser();
    const ws = await createWorkspace('Mlearn');
    await member(uid, ws);
    const conn = await createConnection(ws);
    const soon = new Date(now.getTime() + 2 * HOUR);
    await publishedPost(ws, conn, { status: 'scheduled', publishAt: soon });

    const ov = await overviewForUser(uid, clock);
    expect(ov.clients[0]!.nextPublishAt?.getTime()).toBe(soon.getTime());
    expect(ov.clients[0]!.health).toBe('ok'); // has upcoming, no failures
    expect(ov.upcoming).toHaveLength(1);
    expect(ov.upcoming[0]!.workspaceName).toBe('Mlearn');
    expect(ov.attention.emptyQueues).toBe(0);
  });

  it('flags needs_reconnect as bad health and counts it', async () => {
    const { id: uid } = await createUser();
    const ws = await createWorkspace('GLs');
    await member(uid, ws);
    await createConnection(ws, 'fake', 'Dead', { needsReconnect: true });

    const ov = await overviewForUser(uid, clock);
    expect(ov.clients[0]!.health).toBe('bad');
    expect(ov.attention.needsReconnect).toBe(1);
  });
});

/**
 * The live defect: a workspace with 3 real accounts read "4 accounts · 134 followers" because a
 * connection on the test-only `fake` provider — and its follower series, dated 1970 — was counted.
 */
describe('overviewForUser — test-only providers', () => {
  afterEach(() => vi.unstubAllEnvs());

  async function followers(wsId: string, connectionId: string, value: number, capturedAt: Date) {
    await withWorkspace(wsId, (tx) =>
      tx.insert(schema.metrics).values({
        workspaceId: wsId,
        connectionId,
        metric: 'followers',
        value: String(value),
        capturedAt,
      }),
    );
  }

  async function seed() {
    const { id: uid } = await createUser();
    const ws = await createWorkspace('Acme');
    await member(uid, ws);
    const fb = await createConnection(ws, 'facebook', 'Acme Page', { externalId: 'fb-1' });
    const ig = await createConnection(ws, 'instagram', 'Acme IG', { externalId: 'ig-1' });
    const gmb = await createConnection(ws, 'gmb', 'Acme Listing', { externalId: 'gmb-1' });
    const fake = await createConnection(ws, 'fake', 'Fake Account', { needsReconnect: true });
    await followers(ws, fb, 20, now);
    await followers(ws, ig, 10, now);
    await followers(ws, gmb, 4, now);
    await followers(ws, fake, 100, new Date(0));
    await publishedPost(ws, fake, { status: 'failed' });
    await publishedPost(ws, fake, {
      status: 'scheduled',
      publishAt: new Date(now.getTime() + 2 * HOUR),
    });
    return uid;
  }

  it('in production leaves the fake account out of every number', async () => {
    const uid = await seed();
    vi.stubEnv('NODE_ENV', 'production');

    const ov = await overviewForUser(uid, clock);
    const c = ov.clients[0]!;
    expect(c.connectionCount).toBe(3);
    expect(c.followers).toBe(34);
    expect(c.failedThisWeek).toBe(0);
    expect(c.nextPublishAt).toBeNull();
    expect(ov.upcoming).toEqual([]);
    expect(ov.attention).toEqual({
      failedPublishes: 0,
      needsReconnect: 0,
      tokensExpiring: 0,
      emptyQueues: 1,
    });
  });

  it('outside production still counts it, and the data is untouched either way', async () => {
    const uid = await seed();

    const ov = await overviewForUser(uid, clock);
    expect(ov.clients[0]!.connectionCount).toBe(4);
    expect(ov.clients[0]!.followers).toBe(134);
    expect(ov.attention.needsReconnect).toBe(1);
    expect(ov.upcoming).toHaveLength(1);
  });
});

describe('createClientWorkspace', () => {
  it('creates a workspace, makes the caller owner, and it shows up in their overview', async () => {
    const { id: uid } = await createUser();
    const created = await createClientWorkspace(uid, 'Blossom Wellbeing');

    expect(created.slug).toBe('blossom-wellbeing');
    const [ms] = await (
      await import('@meegrow-social/db')
    )
      .db()
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.workspaceId, created.workspaceId));
    expect(ms!.role).toBe('owner');

    const ov = await overviewForUser(uid, clock);
    expect(ov.clients.map((c) => c.name)).toContain('Blossom Wellbeing');
  });

  it('de-dupes slugs so two clients can share a display name', async () => {
    const { id: uid } = await createUser();
    const a = await createClientWorkspace(uid, 'Acme');
    const b = await createClientWorkspace(uid, 'Acme');
    expect(a.slug).toBe('acme');
    expect(b.slug).toBe('acme-2');
  });
});

describe('getWorkspace (D1)', () => {
  it('returns id, name and slug of the workspace, and nothing else', async () => {
    const id = await createWorkspace('Client A');
    await createWorkspace('Client B');
    const ws = await getWorkspace(id);
    expect(ws).toEqual({ id, name: 'Client A', slug: expect.stringMatching(/^client-a-/) });
  });

  it('returns null for an unknown workspace id', async () => {
    await createWorkspace();
    expect(await getWorkspace('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});
