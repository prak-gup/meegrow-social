import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, db, schema } from '@meegrow-social/db';
import { createApiKeyForWorkspace, createPost, getPost, listPosts } from '@meegrow-social/core';
import {
  createConnection,
  createQueue,
  createWorkspace,
  resetDb,
  useRecordingScheduler,
} from '@meegrow-social/testing';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './server.js';

/**
 * `/mcp` end to end: a real API key, the real stateless transport, real Postgres. The unit tests in
 * `mcp/mcp.test.ts` prove each tool hands core the key's workspace; these prove what that buys —
 * a key for workspace A cannot see or change workspace B's data through any tool, because RLS is
 * the thing enforcing it, not the handler.
 */

let app: FastifyInstance;

beforeAll(async () => {
  process.env.DATABASE_URL ??= 'postgres://mgs:mgs@localhost:5433/meegrow_social';
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
  app = await buildServer();
});
beforeEach(async () => {
  await resetDb();
  useRecordingScheduler();
});
afterAll(async () => {
  await app.close();
  await closeDb();
});

interface Outcome {
  isError: boolean;
  body: unknown;
}

async function rpc(secret: string, method: string, params?: unknown): Promise<unknown> {
  const res = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    payload: { jsonrpc: '2.0', id: 1, method, params },
  });
  expect(res.statusCode).toBe(200);
  // Stateless streamable HTTP answers a POST with a one-message SSE stream.
  const data = res.body.split('\n').find((line) => line.startsWith('data: '));
  if (!data) throw new Error(`no SSE data line in: ${res.body}`);
  return (JSON.parse(data.slice('data: '.length)) as { result: unknown }).result;
}

async function call(
  secret: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Outcome> {
  const result = (await rpc(secret, 'tools/call', { name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  return { isError: result.isError === true, body: JSON.parse(result.content[0]!.text) };
}

async function keyFor(workspaceId: string): Promise<string> {
  return (await createApiKeyForWorkspace(workspaceId, 'test-key')).secret;
}

/** Two workspaces, each with a key, a connection and one scheduled post. */
async function twoTenants() {
  const a = await createWorkspace('Tenant A');
  const b = await createWorkspace('Tenant B');
  const [connA, connB] = [await createConnection(a), await createConnection(b)];
  const seed = async (ws: string, connectionId: string) =>
    (
      await createPost(ws, {
        caption: `post of ${ws}`,
        media: [],
        variants: [{ connectionId, provider: 'fake' }],
        schedule: { type: 'at', publishAt: new Date(Date.now() + 3_600_000) },
      })
    )[0]!;
  return {
    a: { ws: a, key: await keyFor(a), conn: connA, post: await seed(a, connA) },
    b: { ws: b, key: await keyFor(b), conn: connB, post: await seed(b, connB) },
  };
}

describe('/mcp transport', () => {
  it('rejects a call with no API key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('lists the tools without an initialize handshake, and none of them manages api keys', async () => {
    const key = await keyFor(await createWorkspace());
    const { tools } = (await rpc(key, 'tools/list')) as { tools: Array<{ name: string }> };
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['create_post', 'schedule_post', 'calendar']));
    expect(names.filter((n) => /key/i.test(n))).toEqual([]);
  });
});

describe('workspace isolation over /mcp', () => {
  it('read tools only ever return the workspace of the key', async () => {
    const { a, b } = await twoTenants();

    const posts = (await call(a.key, 'list_posts')).body as Array<{ id: string }>;
    expect(posts.map((p) => p.id)).toEqual([a.post.id]);

    const connections = (await call(a.key, 'list_connections')).body as Array<{ id: string }>;
    expect(connections.map((c) => c.id)).toEqual([a.conn]);

    const month = new Date(Date.now() + 3_600_000);
    const calendar = (
      await call(a.key, 'calendar', {
        year: month.getUTCFullYear(),
        month: month.getUTCMonth() + 1,
      })
    ).body as { days: Array<{ posts: Array<{ id: string }> }> };
    expect(calendar.days.flatMap((d) => d.posts.map((p) => p.id))).toEqual([a.post.id]);

    const [mediaA] = await db()
      .insert(schema.media)
      .values({ workspaceId: a.ws, kind: 'image', url: 'https://cdn.example/a.jpg' })
      .returning();
    const [mediaB] = await db()
      .insert(schema.media)
      .values({ workspaceId: b.ws, kind: 'image', url: 'https://cdn.example/b.jpg' })
      .returning();
    const media = (await call(a.key, 'list_media')).body as Array<{ id: string }>;
    expect(media.map((m) => m.id)).toEqual([mediaA!.id]);
    expect(await call(a.key, 'get_media', { mediaId: mediaB!.id })).toMatchObject({
      isError: true,
      body: { error: 'not_found' },
    });

    // The key decides the workspace; an id in the arguments is ignored.
    expect((await call(a.key, 'get_workspace', { workspaceId: b.ws })).body).toMatchObject({
      id: a.ws,
      name: 'Tenant A',
    });
    const workspaces = (await call(a.key, 'list_workspaces')).body as Array<{ id: string }>;
    expect(workspaces.map((w) => w.id)).toEqual([a.ws]);

    // Asking for B's rows by id is indistinguishable from asking for rows that do not exist.
    for (const [name, args] of [
      ['get_post', { postId: b.post.id }],
      ['get_post_group', { groupId: b.post.groupId }],
      ['get_connection', { connectionId: b.conn }],
      ['post_metrics', { postId: b.post.id }],
      ['connection_followers', { connectionId: b.conn }],
    ] as const) {
      const outcome = await call(a.key, name, args);
      expect(outcome, name).toMatchObject({ isError: true, body: { error: 'not_found' } });
    }
  });

  it("write tools cannot change another workspace's post", async () => {
    const { a, b } = await twoTenants();

    for (const [name, args] of [
      ['update_post', { postId: b.post.id, caption: 'hijacked' }],
      ['schedule_post', { postId: b.post.id, publishAt: '2030-01-01T00:00:00Z' }],
      ['unschedule_post', { postId: b.post.id }],
      ['cancel_post', { postId: b.post.id }],
      ['delete_post', { postId: b.post.id }],
      ['duplicate_post', { postId: b.post.id }],
    ] as const) {
      const outcome = await call(a.key, name, args);
      expect(outcome, name).toMatchObject({ isError: true, body: { error: 'not_found' } });
    }

    const untouched = await getPost(b.ws, b.post.id);
    expect(untouched).toMatchObject({
      status: 'scheduled',
      caption: b.post.caption,
      publishAt: b.post.publishAt,
    });
    expect(await listPosts(b.ws)).toHaveLength(1);
    expect(await listPosts(a.ws)).toHaveLength(1);
  });

  it("cannot take a slot in another workspace's queue, or write into another workspace", async () => {
    const { a, b } = await twoTenants();
    const queueB = await createQueue(b.ws);

    const viaQueue = await call(a.key, 'add_to_queue', {
      connectionId: a.conn,
      provider: 'fake',
      queueId: queueB,
    });
    expect(viaQueue).toMatchObject({ isError: true, body: { error: 'not_found' } });
    expect(await listPosts(a.ws)).toHaveLength(1);

    // Naming B's connection does not reach B: whatever A creates stays in A, where that
    // connection does not exist (core does not check the connection id at create time).
    await call(a.key, 'create_post', {
      caption: 'onto B',
      variants: [{ connectionId: b.conn, provider: 'fake' }],
    });
    expect((await listPosts(b.ws)).map((p) => p.id)).toEqual([b.post.id]);
  });
});

describe('draft → schedule → read back, entirely over /mcp', () => {
  it('creates a multi-variant draft with media, schedules it, and reads it back', async () => {
    const ws = await createWorkspace();
    const key = await keyFor(ws);
    const [conn1, conn2] = [
      await createConnection(ws, 'fake', 'One'),
      await createConnection(ws, 'fake', 'Two', { externalId: 'ext-2' }),
    ];
    const [mediaRow] = await db()
      .insert(schema.media)
      .values({ workspaceId: ws, kind: 'image', url: 'https://cdn.example/a.jpg', meta: {} })
      .returning();
    const media = [{ mediaId: mediaRow!.id, kind: 'image' }];

    const created = (
      await call(key, 'create_post', {
        caption: 'launch',
        media,
        variants: [
          { connectionId: conn1, provider: 'fake' },
          { connectionId: conn2, provider: 'fake', caption: 'launch, second account' },
        ],
      })
    ).body as Array<{ id: string; groupId: string; status: string; caption: string }>;
    expect(created.map((p) => p.status)).toEqual(['draft', 'draft']);
    expect(created.map((p) => p.caption)).toEqual(['launch', 'launch, second account']);

    const group = (await call(key, 'get_post_group', { groupId: created[0]!.groupId })).body as {
      media: unknown[];
      posts: unknown[];
    };
    expect(group.media).toEqual(media);
    expect(group.posts).toHaveLength(2);

    const scheduled = await call(key, 'schedule_post', {
      postId: created[0]!.id,
      publishAt: '2030-01-01T09:00:00Z',
    });
    expect(scheduled.body).toMatchObject({
      status: 'scheduled',
      publishAt: '2030-01-01T09:00:00.000Z',
    });

    const listed = (await call(key, 'list_posts', { status: 'scheduled' })).body as unknown[];
    expect(listed).toHaveLength(1);

    const unscheduled = await call(key, 'unschedule_post', { postId: created[0]!.id });
    expect(unscheduled.body).toMatchObject({ status: 'draft', publishAt: null });
  });

  it('create_post replays on a repeated idempotencyKey instead of creating again', async () => {
    const ws = await createWorkspace();
    const key = await keyFor(ws);
    const connectionId = await createConnection(ws);
    const args = { caption: 'once', connectionId, provider: 'fake', idempotencyKey: 'retry-1' };

    const first = (await call(key, 'create_post', args)).body as Array<{ id: string }>;
    const second = (await call(key, 'create_post', args)).body as Array<{ id: string }>;
    expect(second.map((p) => p.id)).toEqual(first.map((p) => p.id));
    expect(await listPosts(ws)).toHaveLength(1);
  });

  it('duplicate_post makes a draft copy and leaves the original alone', async () => {
    const { a } = await twoTenants();
    const copy = (await call(a.key, 'duplicate_post', { postId: a.post.id })).body as {
      id: string;
      groupId: string;
    };
    expect(copy).toMatchObject({ status: 'draft', publishAt: null, caption: a.post.caption });
    expect(copy.id).not.toBe(a.post.id);
    expect(copy.groupId).not.toBe(a.post.groupId);
    expect((await getPost(a.ws, a.post.id))?.status).toBe('scheduled');
  });
});

describe('core errors over /mcp', () => {
  it('editing, scheduling or cancelling a published post is invalid_state', async () => {
    const { a } = await twoTenants();
    // Test setup only — the admin handle bypasses RLS to force a terminal status.
    await db()
      .update(schema.posts)
      .set({ status: 'published' })
      .where(eq(schema.posts.id, a.post.id));

    for (const [name, args] of [
      ['update_post', { postId: a.post.id, caption: 'too late' }],
      ['schedule_post', { postId: a.post.id, publishAt: '2030-01-01T00:00:00Z' }],
      ['unschedule_post', { postId: a.post.id }],
      ['cancel_post', { postId: a.post.id }],
    ] as const) {
      const outcome = await call(a.key, name, args);
      expect(outcome, name).toMatchObject({ isError: true, body: { error: 'invalid_state' } });
    }
    expect((await getPost(a.ws, a.post.id))?.caption).toBe(a.post.caption);
  });

  it('an inactive queue is invalid_request and an unknown one is not_found', async () => {
    const ws = await createWorkspace();
    const key = await keyFor(ws);
    const connectionId = await createConnection(ws);
    const paused = await createQueue(ws, { active: false });

    expect(
      await call(key, 'add_to_queue', { connectionId, provider: 'fake', queueId: paused }),
    ).toMatchObject({ isError: true, body: { error: 'invalid_request' } });
    expect(
      await call(key, 'add_to_queue', {
        connectionId,
        provider: 'fake',
        queueId: '00000000-0000-4000-8000-000000000000',
      }),
    ).toMatchObject({ isError: true, body: { error: 'not_found' } });
    expect(await listPosts(ws)).toHaveLength(0);
  });
});
