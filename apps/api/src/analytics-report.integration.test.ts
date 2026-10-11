import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, schema, withWorkspace } from '@meegrow-social/db';
import { createApiKeyForWorkspace } from '@meegrow-social/core';
import type { AnalyticsReportView } from '@meegrow-social/contracts';
import {
  createConnection,
  createMembership,
  createUser,
  createWorkspace,
  resetDb,
  useRecordingScheduler,
  useTestDatabaseEnv,
} from '@meegrow-social/testing';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './server.js';

/** `GET /v1/analytics/report` over HTTP: auth, validation, and what each caller is allowed to add up. */

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

// Matches appUrl()'s default → originAllowed() accepts it.
const ORIGIN = 'http://localhost:5174';

async function seeded(name: string, likes: number) {
  const ws = await createWorkspace(name);
  const conn = await createConnection(ws, 'instagram', `${name} IG`);
  const post = await withWorkspace(ws, async (tx) => {
    const [group] = await tx.insert(schema.postGroups).values({ workspaceId: ws }).returning();
    const [row] = await tx
      .insert(schema.posts)
      .values({
        workspaceId: ws,
        groupId: group!.id,
        connectionId: conn,
        provider: 'instagram',
        status: 'published',
        publishAt: new Date(Date.now() - 2 * 86_400_000),
        externalPostId: `ext-${name}`,
      })
      .returning();
    await tx.insert(schema.metrics).values(
      Object.entries({ likes, reach: 1000 }).map(([metric, value]) => ({
        workspaceId: ws,
        postId: row!.id,
        metric,
        value: String(value),
        capturedAt: new Date(Date.now() - 3_600_000),
      })),
    );
    return row!.id;
  });
  return { ws, conn, post };
}

async function sessionFor(workspaces: string[]): Promise<Record<string, string>> {
  const user = await createUser('owner@test.local', 's3cret');
  for (const ws of workspaces) await createMembership(user.id, ws, 'owner');
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: 'owner@test.local', password: 's3cret' },
  });
  const raw = res.headers['set-cookie'];
  const sid = (Array.isArray(raw) ? raw : [String(raw)])
    .map((c) => /mg_sid=([^;]+)/.exec(c)?.[1])
    .find(Boolean);
  return { cookie: `mg_sid=${sid}`, origin: ORIGIN };
}

describe('GET /v1/analytics/report', () => {
  it('needs a credential', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/analytics/report' });
    expect(res.statusCode).toBe(401);
  });

  it("answers an API key with its own workspace's numbers only", async () => {
    const a = await seeded('A', 10);
    const b = await seeded('B', 70);
    const { secret } = await createApiKeyForWorkspace(a.ws, 'A');

    const res = await app.inject({
      method: 'GET',
      url: '/v1/analytics/report?days=30&timezone=Asia/Kolkata',
      headers: { authorization: `Bearer ${secret}` },
    });

    expect(res.statusCode).toBe(200);
    const report = res.json<AnalyticsReportView>();
    expect(report.timezone).toBe('Asia/Kolkata');
    expect(report.topPosts.map((p) => p.id)).toEqual([a.post]);
    expect(report.summary.totals.likes.value).toBe(10);
    expect(report.summary.engagementRate.rate).toBe(1);
    expect(res.body).not.toContain(b.post);
  });

  it('refuses scope=all to an API key: it has no user to take memberships from', async () => {
    const a = await seeded('A', 10);
    const { secret } = await createApiKeyForWorkspace(a.ws, 'A');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/analytics/report?scope=all',
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("scope=all adds up the session user's workspaces and no others", async () => {
    const a = await seeded('A', 10);
    const b = await seeded('B', 70);
    const c = await seeded('C', 900);
    const headers = await sessionFor([a.ws, b.ws]);

    const all = await app.inject({ method: 'GET', url: '/v1/analytics/report?scope=all', headers });
    expect(all.statusCode).toBe(200);
    const report = all.json<AnalyticsReportView>();
    expect(report.topPosts.map((p) => p.id).sort()).toEqual([a.post, b.post].sort());
    expect(report.summary.totals.likes.value).toBe(80);
    expect(all.body).not.toContain(c.post);

    // Without the scope it is the session's active workspace alone.
    const one = await app.inject({ method: 'GET', url: '/v1/analytics/report', headers });
    expect(one.json<AnalyticsReportView>().topPosts).toHaveLength(1);
  });

  it('rejects a malformed query and an unknown timezone with 400', async () => {
    const a = await seeded('A', 10);
    const { secret } = await createApiKeyForWorkspace(a.ws, 'A');
    const get = (qs: string) =>
      app.inject({
        method: 'GET',
        url: `/v1/analytics/report?${qs}`,
        headers: { authorization: `Bearer ${secret}` },
      });

    expect((await get('days=0')).statusCode).toBe(400);
    expect((await get('days=9999')).statusCode).toBe(400);
    expect((await get('from=2026-09-01T00:00:00Z')).statusCode).toBe(400);
    expect((await get('from=2026-09-10T00:00:00Z&to=2026-09-01T00:00:00Z')).statusCode).toBe(400);
    expect((await get('connectionId=not-a-uuid')).statusCode).toBe(400);
    expect((await get('source=elsewhere')).statusCode).toBe(400);
    expect((await get('timezone=Mars/Olympus')).statusCode).toBe(400);
    expect((await get('from=2026-09-01T00:00:00Z&to=2026-09-10T00:00:00Z')).statusCode).toBe(200);
  });
});
