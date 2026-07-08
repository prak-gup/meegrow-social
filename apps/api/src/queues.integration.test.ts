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

async function authFor(workspaceId: string): Promise<{ authorization: string }> {
  const { secret } = await createApiKeyForWorkspace(workspaceId, 'test-key');
  return { authorization: `Bearer ${secret}` };
}

describe('queues REST (PRD F3.4)', () => {
  it('creates, lists, gets, updates, and deletes a queue', async () => {
    const ws = await createWorkspace();
    const auth = await authFor(ws);

    const create = await app.inject({
      method: 'POST',
      url: '/v1/queues',
      headers: auth,
      payload: { name: 'Morning', timezone: 'Asia/Kolkata', slots: [{ dow: 1, time: '09:00' }] },
    });
    expect(create.statusCode).toBe(201);
    const { queue } = create.json<{ queue: { id: string; name: string } }>();

    const list = await app.inject({ method: 'GET', url: '/v1/queues', headers: auth });
    expect(list.json<{ queues: unknown[] }>().queues).toHaveLength(1);

    const get = await app.inject({ method: 'GET', url: `/v1/queues/${queue.id}`, headers: auth });
    expect(get.statusCode).toBe(200);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/queues/${queue.id}`,
      headers: auth,
      payload: { name: 'Renamed' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json<{ queue: { name: string } }>().queue.name).toBe('Renamed');

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/queues/${queue.id}`,
      headers: auth,
    });
    expect(del.statusCode).toBe(204);

    const getAfterDelete = await app.inject({
      method: 'GET',
      url: `/v1/queues/${queue.id}`,
      headers: auth,
    });
    expect(getAfterDelete.statusCode).toBe(404);
  });

  it('400s on an invalid queue payload', async () => {
    const ws = await createWorkspace();
    const auth = await authFor(ws);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/queues',
      headers: auth,
      payload: { name: 'Bad', timezone: 'Asia/Kolkata', slots: [{ dow: 9, time: '09:00' }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates a post via add-to-queue and it comes back scheduled with a computed publishAt', async () => {
    const ws = await createWorkspace();
    const auth = await authFor(ws);
    const connectionId = await createConnection(ws, 'fake');

    const createQueueRes = await app.inject({
      method: 'POST',
      url: '/v1/queues',
      headers: auth,
      payload: { name: 'Daily', timezone: 'Asia/Kolkata', slots: [{ dow: 1, time: '09:00' }] },
    });
    const { queue } = createQueueRes.json<{ queue: { id: string } }>();

    const createPostRes = await app.inject({
      method: 'POST',
      url: '/v1/posts',
      headers: auth,
      payload: {
        caption: 'queued via REST',
        variants: [{ connectionId, provider: 'fake' }],
        schedule: { type: 'queue', queueId: queue.id },
      },
    });
    expect(createPostRes.statusCode).toBe(201);
    const { posts } = createPostRes.json<{
      posts: Array<{ status: string; publishAt: string | null; queueId: string | null }>;
    }>();
    expect(posts[0]?.status).toBe('scheduled');
    expect(posts[0]?.publishAt).not.toBeNull();
    expect(posts[0]?.queueId).toBe(queue.id);
  });

  it('rejects add-to-queue on a deactivated queue with 400', async () => {
    const ws = await createWorkspace();
    const auth = await authFor(ws);
    const connectionId = await createConnection(ws, 'fake');

    const createQueueRes = await app.inject({
      method: 'POST',
      url: '/v1/queues',
      headers: auth,
      payload: {
        name: 'Paused',
        timezone: 'Asia/Kolkata',
        slots: [{ dow: 1, time: '09:00' }],
        active: false,
      },
    });
    const { queue } = createQueueRes.json<{ queue: { id: string } }>();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/posts',
      headers: auth,
      payload: {
        caption: 'rejected',
        variants: [{ connectionId, provider: 'fake' }],
        schedule: { type: 'queue', queueId: queue.id },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('404s on add-to-queue for an unknown queue id', async () => {
    const ws = await createWorkspace();
    const auth = await authFor(ws);
    const connectionId = await createConnection(ws, 'fake');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/posts',
      headers: auth,
      payload: {
        caption: 'no such queue',
        variants: [{ connectionId, provider: 'fake' }],
        schedule: { type: 'queue', queueId: '00000000-0000-0000-0000-000000000000' },
      },
    });
    expect(res.statusCode).toBe(404);
  });
});
