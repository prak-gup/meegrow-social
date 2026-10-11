import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, db, schema } from '@meegrow-social/db';
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

describe('api', () => {
  it('rejects requests without a valid API key', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/posts' });
    expect(res.statusCode).toBe(401);
  });

  it('creates a draft post and reads it back with a valid key', async () => {
    const ws = await createWorkspace();
    const connectionId = await createConnection(ws, 'fake');
    const { secret } = await createApiKeyForWorkspace(ws, 'test-key');
    const auth = { authorization: `Bearer ${secret}` };

    const create = await app.inject({
      method: 'POST',
      url: '/v1/posts',
      headers: auth,
      payload: {
        caption: 'from the api',
        variants: [{ connectionId, provider: 'fake' }],
        schedule: { type: 'draft' },
      },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json<{ posts: Array<{ id: string; status: string }> }>();
    expect(created.posts[0]?.status).toBe('draft');

    const list = await app.inject({ method: 'GET', url: '/v1/posts', headers: auth });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ posts: unknown[] }>().posts).toHaveLength(1);
  });

  it('does not leak posts across workspaces', async () => {
    const wsA = await createWorkspace('A');
    const connA = await createConnection(wsA, 'fake');
    const { secret: keyA } = await createApiKeyForWorkspace(wsA, 'A');
    await app.inject({
      method: 'POST',
      url: '/v1/posts',
      headers: { authorization: `Bearer ${keyA}` },
      payload: { caption: 'A only', variants: [{ connectionId: connA, provider: 'fake' }] },
    });

    const wsB = await createWorkspace('B');
    const { secret: keyB } = await createApiKeyForWorkspace(wsB, 'B');
    const listB = await app.inject({
      method: 'GET',
      url: '/v1/posts',
      headers: { authorization: `Bearer ${keyB}` },
    });
    expect(listB.json<{ posts: unknown[] }>().posts).toHaveLength(0);
  });

  it("refuses a post onto another workspace's connection with the same 404 as an unknown id", async () => {
    const wsA = await createWorkspace('A');
    const wsB = await createWorkspace('B');
    const connB = await createConnection(wsB, 'fake');
    const { secret: keyA } = await createApiKeyForWorkspace(wsA, 'A');
    const { secret: keyB } = await createApiKeyForWorkspace(wsB, 'B');
    const authA = { authorization: `Bearer ${keyA}` };
    const unknownId = '00000000-0000-4000-8000-000000000000';
    const create = (connectionId: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/posts',
        headers: authA,
        payload: { caption: 'x', variants: [{ connectionId, provider: 'fake' }] },
      });

    const foreign = await create(connB);
    const unknown = await create(unknownId);
    expect(foreign.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    // Same shape, same wording; only the id the caller sent differs.
    expect(foreign.json()).toEqual({ error: `connection ${connB} not found` });
    expect(unknown.json()).toEqual({ error: `connection ${unknownId} not found` });

    for (const key of [keyA, keyB]) {
      const list = await app.inject({
        method: 'GET',
        url: '/v1/posts',
        headers: { authorization: `Bearer ${key}` },
      });
      expect(list.json<{ posts: unknown[] }>().posts).toHaveLength(0);
    }

    const verdict = await app.inject({
      method: 'POST',
      url: '/v1/posts/validate',
      headers: authA,
      payload: { caption: 'x', variants: [{ connectionId: connB, provider: 'fake' }] },
    });
    expect(verdict.statusCode).toBe(200);
    expect(verdict.json()).toEqual({
      valid: false,
      issues: [
        {
          connectionId: connB,
          provider: 'fake',
          code: 'connection_not_found',
          message: `connection ${connB} not found`,
        },
      ],
    });
  });

  it('POST /v1/posts/validate answers 200 for a valid body and for a malformed one, creating nothing', async () => {
    const ws = await createWorkspace();
    const connectionId = await createConnection(ws, 'fake');
    const { secret } = await createApiKeyForWorkspace(ws, 'test-key');
    const auth = { authorization: `Bearer ${secret}` };
    const validate = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/v1/posts/validate', headers: auth, payload });

    const good = await validate({
      caption: 'fine',
      variants: [{ connectionId, provider: 'fake' }],
      schedule: { type: 'now' },
    });
    expect(good.statusCode).toBe(200);
    expect(good.json()).toEqual({ valid: true, issues: [] });

    const bad = await validate({ caption: 'no variants' });
    expect(bad.statusCode).toBe(200);
    expect(bad.json()).toEqual({
      valid: false,
      issues: [{ code: 'invalid_request', message: 'variants: Required' }],
    });

    const list = await app.inject({ method: 'GET', url: '/v1/posts', headers: auth });
    expect(list.json<{ posts: unknown[] }>().posts).toHaveLength(0);
  });

  it('POST /v1/posts/:id/retry: 200 for a failed post, 409 otherwise, 404 across workspaces', async () => {
    const ws = await createWorkspace();
    const connectionId = await createConnection(ws, 'fake');
    const { secret } = await createApiKeyForWorkspace(ws, 'test-key');
    const auth = { authorization: `Bearer ${secret}` };
    const created = await app.inject({
      method: 'POST',
      url: '/v1/posts',
      headers: auth,
      payload: {
        caption: 'to retry',
        variants: [{ connectionId, provider: 'fake' }],
        schedule: { type: 'now' },
      },
    });
    const postId = created.json<{ posts: Array<{ id: string }> }>().posts[0]!.id;
    const retry = (headers: { authorization: string }) =>
      app.inject({ method: 'POST', url: `/v1/posts/${postId}/retry`, headers });

    // Still scheduled: not retryable.
    const early = await retry(auth);
    expect(early.statusCode).toBe(409);
    expect(early.json()).toEqual({ error: "a 'scheduled' post cannot be retried" });

    // Test setup only — the admin handle forces the state a failed publish records.
    await db()
      .update(schema.posts)
      .set({ status: 'failed', error: 'the platform said no' })
      .where(eq(schema.posts.id, postId));

    const other = await createApiKeyForWorkspace(await createWorkspace('Other'), 'other');
    expect((await retry({ authorization: `Bearer ${other.secret}` })).statusCode).toBe(404);

    const { calls } = useRecordingScheduler();
    const ok = await retry(auth);
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ post: { status: string; error: string | null } }>().post).toMatchObject({
      id: postId,
      status: 'scheduled',
      error: null,
    });
    expect(calls).toEqual([{ postId, when: 'now' }]);
  });

  it('GET /mcp is 405 with Allow: POST for a valid key, and 401 without one', async () => {
    const { secret } = await createApiKeyForWorkspace(await createWorkspace(), 'test-key');
    const withKey = await app.inject({
      method: 'GET',
      url: '/mcp',
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(withKey.statusCode).toBe(405);
    expect(withKey.headers.allow).toBe('POST');

    const withoutKey = await app.inject({ method: 'GET', url: '/mcp' });
    expect(withoutKey.statusCode).toBe(401);
  });

  it('connection health over REST: the list, one by id, and 404 across workspaces', async () => {
    const ws = await createWorkspace();
    const conn = await createConnection(ws, 'fake', 'Flagged', { needsReconnect: true });
    const foreign = await createConnection(await createWorkspace('Other'), 'fake');
    const { secret } = await createApiKeyForWorkspace(ws, 'test-key');
    const auth = { authorization: `Bearer ${secret}` };

    const list = await app.inject({ method: 'GET', url: '/v1/connections/health', headers: auth });
    expect(list.statusCode).toBe(200);
    const { connections } = list.json<{
      connections: Array<{ connectionId: string; status: string; source: string }>;
    }>();
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      connectionId: conn,
      status: 'needs_reconnect',
      source: 'stored',
    });

    const one = await app.inject({
      method: 'GET',
      url: `/v1/connections/${conn}/health`,
      headers: auth,
    });
    expect(one.statusCode).toBe(200);
    expect(one.json<{ health: { connectionId: string } }>().health.connectionId).toBe(conn);

    const notMine = await app.inject({
      method: 'GET',
      url: `/v1/connections/${foreign}/health`,
      headers: auth,
    });
    expect(notMine.statusCode).toBe(404);
  });
});
