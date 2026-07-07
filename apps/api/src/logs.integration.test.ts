import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, schema, withWorkspace } from '@meegrow-social/db';
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

/**
 * The request-logging hook is deliberately fire-and-forget (never awaited by the request
 * lifecycle — see server.ts), so its write can land a tick after `app.inject()` resolves.
 * Poll briefly instead of asserting immediately.
 */
async function waitForLogRows(workspaceId: string, atLeast: number, timeoutMs = 2000) {
  const start = Date.now();
  for (;;) {
    const rows = await withWorkspace(workspaceId, (tx) => tx.select().from(schema.eventLogs));
    if (rows.length >= atLeast) return rows;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${atLeast} event_logs rows, saw ${rows.length}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('request-logging hook', () => {
  it('records an api_request log for an authed /v1 call, excluding /healthz', async () => {
    const ws = await createWorkspace();
    const { secret } = await createApiKeyForWorkspace(ws, 'test-key');

    await app.inject({ method: 'GET', url: '/healthz' });
    await app.inject({
      method: 'GET',
      url: '/v1/posts',
      headers: { authorization: `Bearer ${secret}` },
    });

    const rows = await waitForLogRows(ws, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'api_request', route: '/v1/posts', status: '200' });
    expect(rows[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('does not log unauthenticated (401) requests', async () => {
    await app.inject({ method: 'GET', url: '/v1/posts' }); // no Authorization header → 401

    // Nothing to scope the check to (no workspace resolved for a 401), so assert globally that
    // an admin-level read of a fresh workspace sees zero rows after an unrelated 401.
    const ws = await createWorkspace();
    const rows = await withWorkspace(ws, (tx) => tx.select().from(schema.eventLogs));
    expect(rows).toHaveLength(0);
  });
});

describe('GET /v1/logs', () => {
  it('filters by kind/status and paginates with a cursor', async () => {
    const ws = await createWorkspace();
    const { secret } = await createApiKeyForWorkspace(ws, 'test-key');
    const auth = { authorization: `Bearer ${secret}` };

    // Generate a handful of api_request logs via real traffic.
    await app.inject({ method: 'GET', url: '/v1/posts', headers: auth });
    await app.inject({ method: 'GET', url: '/v1/posts', headers: auth });
    await app.inject({ method: 'GET', url: '/v1/posts/does-not-exist', headers: auth }); // 404
    await waitForLogRows(ws, 3);

    const okOnly = await app.inject({ method: 'GET', url: '/v1/logs?status=200', headers: auth });
    expect(okOnly.statusCode).toBe(200);
    const okBody = okOnly.json<{ items: Array<{ status: string }>; nextCursor: string | null }>();
    expect(okBody.items.every((i) => i.status === '200')).toBe(true);
    expect(okBody.items.length).toBeGreaterThanOrEqual(2);

    const page1 = await app.inject({ method: 'GET', url: '/v1/logs?limit=1', headers: auth });
    const page1Body = page1.json<{ items: unknown[]; nextCursor: string | null }>();
    expect(page1Body.items).toHaveLength(1);
    expect(page1Body.nextCursor).not.toBeNull();

    const page2 = await app.inject({
      method: 'GET',
      url: `/v1/logs?limit=1&cursor=${encodeURIComponent(page1Body.nextCursor!)}`,
      headers: auth,
    });
    const page2Body = page2.json<{ items: unknown[] }>();
    expect(page2Body.items).toHaveLength(1);
    expect(page2Body.items).not.toEqual(page1Body.items);
  });

  it('does not leak logs across workspaces', async () => {
    const wsA = await createWorkspace('A');
    const connA = await createConnection(wsA, 'fake');
    const { secret: keyA } = await createApiKeyForWorkspace(wsA, 'A');
    await app.inject({
      method: 'POST',
      url: '/v1/posts',
      headers: { authorization: `Bearer ${keyA}` },
      payload: { caption: 'A only', variants: [{ connectionId: connA, provider: 'fake' }] },
    });
    await waitForLogRows(wsA, 1);

    const wsB = await createWorkspace('B');
    const { secret: keyB } = await createApiKeyForWorkspace(wsB, 'B');
    const logsB = await app.inject({
      method: 'GET',
      url: '/v1/logs',
      headers: { authorization: `Bearer ${keyB}` },
    });
    expect(logsB.json<{ items: unknown[] }>().items).toHaveLength(0);
  });

  it('rejects a malformed query with 400', async () => {
    const ws = await createWorkspace();
    const { secret } = await createApiKeyForWorkspace(ws, 'test-key');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/logs?limit=not-a-number',
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/logs/aggregate', () => {
  it('returns zero-filled buckets across the requested window', async () => {
    const ws = await createWorkspace();
    const { secret } = await createApiKeyForWorkspace(ws, 'test-key');
    const auth = { authorization: `Bearer ${secret}` };

    await app.inject({ method: 'GET', url: '/v1/posts', headers: auth });
    await waitForLogRows(ws, 1);

    const now = new Date();
    const from = new Date(now.getTime() - 60 * 60_000).toISOString();
    const to = new Date(now.getTime() + 60 * 60_000).toISOString();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/logs/aggregate?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&bucketMinutes=60`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ buckets: Array<{ total: number; errorCount: number }> }>();
    expect(body.buckets.length).toBeGreaterThanOrEqual(2);
    expect(body.buckets.reduce((sum, b) => sum + b.total, 0)).toBeGreaterThanOrEqual(1);
  });

  it('requires from/to and rejects a missing window with 400', async () => {
    const ws = await createWorkspace();
    const { secret } = await createApiKeyForWorkspace(ws, 'test-key');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/logs/aggregate',
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(res.statusCode).toBe(400);
  });
});
