import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDb } from '@meegrow-social/db';
import { createApiKeyForWorkspace } from '@meegrow-social/core';
import {
  createWorkspace,
  resetDb,
  useRecordingScheduler,
  useTestDatabaseEnv,
} from '@meegrow-social/testing';
import { buildServer } from './server.js';

/**
 * API-key lifecycle over HTTP (#8): create → use → revoke → 401.
 *
 * The cross-workspace tests matter more than they look: `api_keys` is deliberately NOT in
 * TENANT_TABLES (the auth layer reads it before any tenant context exists), so **RLS does not scope
 * it** — the workspaceId predicate in the service is the only isolation. If someone drops it, these
 * are the tests that notice.
 */

beforeAll(() => {
  useTestDatabaseEnv();
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
  useRecordingScheduler();
});
beforeEach(resetDb);
afterAll(closeDb);

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildServer();
});
afterAll(async () => app?.close());

const auth = (key: string) => ({ authorization: `Bearer ${key}` });

describe('POST /v1/api-keys', () => {
  it('returns the full secret exactly once, and it authenticates', async () => {
    const ws = await createWorkspace();
    const { secret: bootstrap } = await createApiKeyForWorkspace(ws, 'bootstrap');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(bootstrap),
      payload: { name: 'antidote-bot' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe('antidote-bot');
    expect(body.secret).toMatch(/^sk_live_/);
    expect(body.prefix).toContain('sk_live_');

    // The returned secret is a working credential.
    const used = await app.inject({
      method: 'GET',
      url: '/v1/connections',
      headers: auth(body.secret),
    });
    expect(used.statusCode).toBe(200);
  });

  it('rejects an empty name', async () => {
    const ws = await createWorkspace();
    const { secret } = await createApiKeyForWorkspace(ws, 'bootstrap');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(secret),
      payload: { name: '' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/api-keys', () => {
  it('never exposes the hash or the secret', async () => {
    const ws = await createWorkspace();
    const { secret } = await createApiKeyForWorkspace(ws, 'bootstrap');

    const res = await app.inject({ method: 'GET', url: '/v1/api-keys', headers: auth(secret) });

    expect(res.statusCode).toBe(200);
    const raw = res.body; // assert on the WIRE, not the parsed object
    expect(raw).not.toContain('hash');
    expect(raw).not.toContain(secret);
    const [key] = res.json().apiKeys;
    expect(key).toMatchObject({ name: 'bootstrap' });
    expect(key.prefix).toContain('…'); // display fragment only — not usable to authenticate
  });

  it('lists only this workspace’s keys (api_keys has no RLS)', async () => {
    const wsA = await createWorkspace('WS A');
    const wsB = await createWorkspace('WS B');
    const { secret: keyA } = await createApiKeyForWorkspace(wsA, 'a-key');
    await createApiKeyForWorkspace(wsB, 'b-key');

    const res = await app.inject({ method: 'GET', url: '/v1/api-keys', headers: auth(keyA) });

    const names = res.json().apiKeys.map((k: { name: string }) => k.name);
    expect(names).toEqual(['a-key']);
    expect(names).not.toContain('b-key');
  });
});

describe('DELETE /v1/api-keys/:id — revoke', () => {
  it('revokes, and the key stops authenticating immediately', async () => {
    const ws = await createWorkspace();
    const { secret: bootstrap } = await createApiKeyForWorkspace(ws, 'bootstrap');
    const created = (
      await app.inject({
        method: 'POST',
        url: '/v1/api-keys',
        headers: auth(bootstrap),
        payload: { name: 'doomed' },
      })
    ).json();

    // works…
    expect(
      (await app.inject({ method: 'GET', url: '/v1/connections', headers: auth(created.secret) }))
        .statusCode,
    ).toBe(200);

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/api-keys/${created.id}`,
      headers: auth(bootstrap),
    });
    expect(del.statusCode).toBe(200);

    // …and immediately doesn't. No cache, no grace period.
    expect(
      (await app.inject({ method: 'GET', url: '/v1/connections', headers: auth(created.secret) }))
        .statusCode,
    ).toBe(401);
  });

  it('reports the revoked key in the list rather than hiding it', async () => {
    const ws = await createWorkspace();
    const { secret: bootstrap } = await createApiKeyForWorkspace(ws, 'bootstrap');
    const created = (
      await app.inject({
        method: 'POST',
        url: '/v1/api-keys',
        headers: auth(bootstrap),
        payload: { name: 'doomed' },
      })
    ).json();
    await app.inject({
      method: 'DELETE',
      url: `/v1/api-keys/${created.id}`,
      headers: auth(bootstrap),
    });

    const keys = (
      await app.inject({ method: 'GET', url: '/v1/api-keys', headers: auth(bootstrap) })
    ).json().apiKeys;
    const doomed = keys.find((k: { id: string }) => k.id === created.id);
    // Revocation is auditable history, not a delete.
    expect(doomed.revokedAt).not.toBeNull();
  });

  it('is idempotent — revoking twice still reports success', async () => {
    const ws = await createWorkspace();
    const { secret: bootstrap } = await createApiKeyForWorkspace(ws, 'bootstrap');
    const created = (
      await app.inject({
        method: 'POST',
        url: '/v1/api-keys',
        headers: auth(bootstrap),
        payload: { name: 'doomed' },
      })
    ).json();
    const url = `/v1/api-keys/${created.id}`;

    expect((await app.inject({ method: 'DELETE', url, headers: auth(bootstrap) })).statusCode).toBe(
      200,
    );
    // A retried revoke must not look like a failure.
    expect((await app.inject({ method: 'DELETE', url, headers: auth(bootstrap) })).statusCode).toBe(
      200,
    );
  });

  it('cannot revoke another workspace’s key — the ONLY guard is the workspaceId predicate', async () => {
    const wsA = await createWorkspace('WS A');
    const wsB = await createWorkspace('WS B');
    const { secret: keyA } = await createApiKeyForWorkspace(wsA, 'a-key');
    const victim = await createApiKeyForWorkspace(wsB, 'b-key');

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/api-keys/${victim.id}`,
      headers: auth(keyA),
    });

    // Indistinguishable from "not found" on purpose — don't confirm the id exists elsewhere.
    expect(res.statusCode).toBe(404);
    // And B's key still works.
    expect(
      (await app.inject({ method: 'GET', url: '/v1/connections', headers: auth(victim.secret) }))
        .statusCode,
    ).toBe(200);
  });

  it('404s an unknown key id', async () => {
    const ws = await createWorkspace();
    const { secret } = await createApiKeyForWorkspace(ws, 'bootstrap');
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/api-keys/11111111-1111-4111-8111-111111111111',
      headers: auth(secret),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('lastUsedAt', () => {
  it('is stamped on use', async () => {
    const ws = await createWorkspace();
    const { secret } = await createApiKeyForWorkspace(ws, 'bootstrap');

    const before = (
      await app.inject({ method: 'GET', url: '/v1/api-keys', headers: auth(secret) })
    ).json().apiKeys[0];
    // The list call above already authenticated once, so it's stamped by now.
    expect(before.lastUsedAt).not.toBeNull();
  });

  it('is throttled — a burst of requests does not rewrite it every time', async () => {
    const ws = await createWorkspace();
    const { secret } = await createApiKeyForWorkspace(ws, 'bootstrap');

    await app.inject({ method: 'GET', url: '/v1/connections', headers: auth(secret) });
    const first = (
      await app.inject({ method: 'GET', url: '/v1/api-keys', headers: auth(secret) })
    ).json().apiKeys[0].lastUsedAt;

    for (let i = 0; i < 3; i++) {
      await app.inject({ method: 'GET', url: '/v1/connections', headers: auth(secret) });
    }
    const after = (
      await app.inject({ method: 'GET', url: '/v1/api-keys', headers: auth(secret) })
    ).json().apiKeys[0].lastUsedAt;

    // Within the throttle window the value must be untouched — otherwise every authenticated
    // request is a write to the same hot row.
    expect(after).toBe(first);
  });
});

describe('unauthenticated', () => {
  it('401s without a key', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/api-keys' })).statusCode).toBe(401);
  });

  it('401s with a garbage key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/api-keys',
      headers: auth('sk_live_not-a-real-key'),
    });
    expect(res.statusCode).toBe(401);
  });
});
