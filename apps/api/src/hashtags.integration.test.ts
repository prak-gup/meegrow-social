import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '@meegrow-social/db';
import { createApiKeyForWorkspace } from '@meegrow-social/core';
import { createWorkspace, resetDb } from '@meegrow-social/testing';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './server.js';

let app: FastifyInstance;

beforeAll(async () => {
  process.env.DATABASE_URL ??= 'postgres://mgs:mgs@localhost:5433/meegrow_social';
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
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

describe('hashtag groups REST', () => {
  it('creates, lists, updates, and deletes a group', async () => {
    const workspaceId = await createWorkspace();
    const headers = await authFor(workspaceId);
    const createdResponse = await app.inject({
      method: 'POST',
      url: '/v1/hashtag-groups',
      headers,
      payload: { name: 'Launch' },
    });
    expect(createdResponse.statusCode).toBe(201);
    const { hashtagGroup } = createdResponse.json<{
      hashtagGroup: { id: string; name: string; tags: string[] };
    }>();
    expect(hashtagGroup).toMatchObject({ name: 'Launch', tags: [] });

    const list = await app.inject({ method: 'GET', url: '/v1/hashtag-groups', headers });
    expect(list.json<{ hashtagGroups: unknown[] }>().hashtagGroups).toHaveLength(1);

    const update = await app.inject({
      method: 'PATCH',
      url: `/v1/hashtag-groups/${hashtagGroup.id}`,
      headers,
      payload: { tags: ['#launch'] },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json<{ hashtagGroup: { tags: string[] } }>().hashtagGroup.tags).toEqual([
      '#launch',
    ]);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/hashtag-groups/${hashtagGroup.id}`,
      headers,
    });
    expect(deleted.statusCode).toBe(204);
  });

  it('validates payloads and maps missing rows to 404', async () => {
    const workspaceId = await createWorkspace();
    const headers = await authFor(workspaceId);
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/hashtag-groups',
      headers,
      payload: { name: '' },
    });
    expect(invalid.statusCode).toBe(400);

    const missing = await app.inject({
      method: 'PATCH',
      url: '/v1/hashtag-groups/00000000-0000-0000-0000-000000000000',
      headers,
      payload: { name: 'Nope' },
    });
    expect(missing.statusCode).toBe(404);
  });
});
