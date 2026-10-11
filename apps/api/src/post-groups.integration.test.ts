import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, schema, withWorkspace } from '@meegrow-social/db';
import { createApiKeyForWorkspace } from '@meegrow-social/core';
import {
  createConnection,
  createWorkspace,
  resetDb,
  useRecordingScheduler,
  useTestDatabaseEnv,
} from '@meegrow-social/testing';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './server.js';

/**
 * The reads added for the dashboard's post screens, end to end over HTTP against a real database:
 * the group list, the group duplicate, the bulk metrics read and the analytics status.
 */

let app: FastifyInstance;

beforeAll(async () => {
  useTestDatabaseEnv();
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
  useRecordingScheduler();
  app = await buildServer();
});
beforeEach(resetDb);
afterAll(async () => {
  await app.close();
  await closeDb();
});

interface Group {
  id: string;
  status: string;
  posts: Array<{ id: string; status: string; media: unknown[] }>;
}

async function setup() {
  const ws = await createWorkspace();
  const [a, b] = [
    await createConnection(ws, 'fake', 'A', { externalId: 'a' }),
    await createConnection(ws, 'fake', 'B', { externalId: 'b' }),
  ];
  const { secret } = await createApiKeyForWorkspace(ws, 'key');
  const auth = { authorization: `Bearer ${secret}` };
  const create = await app.inject({
    method: 'POST',
    url: '/v1/posts',
    headers: auth,
    payload: {
      caption: 'two accounts',
      variants: [
        { connectionId: a, provider: 'fake' },
        { connectionId: b, provider: 'fake' },
      ],
      schedule: { type: 'draft' },
    },
  });
  const posts = create.json<{ posts: Array<{ id: string; groupId: string }> }>().posts;
  return { ws, auth, posts };
}

describe('post groups over REST', () => {
  it('lists one group for a two-account post, each post carrying a media array', async () => {
    const { auth, posts } = await setup();

    const res = await app.inject({ method: 'GET', url: '/v1/post-groups', headers: auth });

    expect(res.statusCode).toBe(200);
    const { groups } = res.json<{ groups: Group[] }>();
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ id: posts[0]!.groupId, status: 'draft' });
    expect(groups[0]!.posts.map((p) => p.media)).toEqual([[], []]);

    // The per-post list is unchanged apart from the added field.
    const list = await app.inject({ method: 'GET', url: '/v1/posts', headers: auth });
    expect(list.json<{ posts: Array<{ media: unknown[] }> }>().posts).toHaveLength(2);
  });

  it('duplicates a group into a second group of drafts, once per idempotency key', async () => {
    const { auth, posts } = await setup();
    const duplicate = () =>
      app.inject({
        method: 'POST',
        url: `/v1/post-groups/${posts[0]!.groupId}/duplicate`,
        headers: { ...auth, 'idempotency-key': 'dup-http-1' },
      });

    const first = await duplicate();
    const second = await duplicate();

    expect(first.statusCode).toBe(201);
    const copy = first.json<{ group: Group }>().group;
    expect(copy.id).not.toBe(posts[0]!.groupId);
    expect(copy.posts).toHaveLength(2);
    expect(second.json<{ group: Group }>().group.id).toBe(copy.id);
    const list = await app.inject({ method: 'GET', url: '/v1/post-groups', headers: auth });
    expect(list.json<{ groups: Group[] }>().groups).toHaveLength(2);
  });

  it("404s duplicating a group of another workspace, and lists none of that workspace's groups", async () => {
    const { posts } = await setup();
    const other = await createWorkspace('Other');
    const { secret } = await createApiKeyForWorkspace(other, 'other');
    const auth = { authorization: `Bearer ${secret}` };

    const dup = await app.inject({
      method: 'POST',
      url: `/v1/post-groups/${posts[0]!.groupId}/duplicate`,
      headers: auth,
    });
    expect(dup.statusCode).toBe(404);
    const list = await app.inject({ method: 'GET', url: '/v1/post-groups', headers: auth });
    expect(list.json<{ groups: Group[] }>().groups).toEqual([]);
  });
});

describe('bulk metrics and analytics status over REST', () => {
  it('returns the latest metrics of the posts asked for, and nothing for an id it does not own', async () => {
    const { ws, auth, posts } = await setup();
    await withWorkspace(ws, async (tx) => {
      await tx.insert(schema.metrics).values([
        {
          workspaceId: ws,
          postId: posts[0]!.id,
          metric: 'views',
          value: '4',
          capturedAt: new Date('2026-10-01T00:00:00Z'),
        },
        {
          workspaceId: ws,
          postId: posts[0]!.id,
          metric: 'views',
          value: '9',
          capturedAt: new Date('2026-10-02T00:00:00Z'),
        },
      ]);
    });
    const unknown = '00000000-0000-4000-8000-000000000000';

    const res = await app.inject({
      method: 'POST',
      url: '/v1/posts/metrics/latest',
      headers: auth,
      payload: { postIds: [posts[0]!.id, posts[1]!.id, unknown] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      metrics: {
        [posts[0]!.id]: { latest: { views: 9 }, capturedAt: '2026-10-02T00:00:00.000Z' },
        [posts[1]!.id]: { latest: {}, capturedAt: null },
      },
    });
  });

  it('reports the sync status with the cadence core runs at', async () => {
    const { auth } = await setup();

    const res = await app.inject({ method: 'GET', url: '/v1/analytics/status', headers: auth });

    expect(res.statusCode).toBe(200);
    const status = res.json<{
      lastCapturedAt: string | null;
      nextDueAt: string | null;
      cadence: Record<string, number>;
    }>();
    expect(status.lastCapturedAt).toBeNull();
    // Two connected accounts that have never been swept: due now.
    expect(status.nextDueAt).not.toBeNull();
    expect(status.cadence).toMatchObject({ sweepIntervalMs: 3_600_000 });
  });
});
