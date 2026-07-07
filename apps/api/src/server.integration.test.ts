import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '@meegrow-social/db';
import { createApiKeyForWorkspace } from '@meegrow-social/core';
import {
  createConnection,
  createWorkspace,
  resetDb,
  useRecordingScheduler,
} from '@meegrow-social/testing';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './server.js';

let app: FastifyInstance;

beforeAll(async () => {
  process.env.DATABASE_URL ??= 'postgres://mgs:mgs@localhost:5433/meegrow_social';
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
});
