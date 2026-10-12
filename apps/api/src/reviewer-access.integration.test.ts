import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { db, schema, closeDb, withWorkspace } from '@meegrow-social/db';
import { eq } from 'drizzle-orm';
import { createApiKeyForWorkspace, createSession, verifyPassword } from '@meegrow-social/core';
import {
  createConnection,
  createMembership,
  createQueue,
  createUser,
  createWorkspace,
  resetDb,
  useRecordingScheduler,
  useTestDatabaseEnv,
} from '@meegrow-social/testing';
import { buildServer } from './server.js';

// Written for a dedicated test database and intentionally NOT run as part of this task.
let app: FastifyInstance;
beforeAll(async () => {
  useTestDatabaseEnv();
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
  process.env.MEDIA_STORAGE_DRIVER = 's3';
  useRecordingScheduler();
  app = await buildServer();
});
beforeEach(resetDb);
afterAll(async () => {
  await app.close();
  await closeDb();
});
const origin = 'http://localhost:8990';
const headers = (token: string) => ({ cookie: `mg_sid=${token}`, origin });
async function setup() {
  const a = await createWorkspace('Demo A');
  const b = await createWorkspace('Private B');
  const owner = await createUser('owner@example.invalid', randomBytes(24).toString('base64url'));
  await createMembership(owner.id, a, 'owner');
  await createMembership(owner.id, b, 'owner');
  const session = await createSession(owner.id);
  const result = await app.inject({
    method: 'POST',
    url: `/v1/workspaces/${a}/people`,
    headers: headers(session.token),
    payload: { email: 'reviewer@example.invalid', role: 'member' },
  });
  expect(result.statusCode).toBe(201);
  const created = result.json();
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: created.person.email, password: created.temporaryPassword },
  });
  expect(login.statusCode).toBe(200);
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  return { a, b, created, ownerHeaders: headers(session.token), memberHeaders: { cookie, origin } };
}

describe('reviewer lifecycle and real membership isolation', () => {
  it('creates exactly one membership and a hash, changes the password, then removes access and revokes all sessions', async () => {
    const s = await setup();
    const [user] = await db()
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, s.created.person.userId));
    expect(await verifyPassword(user!.passwordHash!, s.created.temporaryPassword)).toBe(true);
    const memberships = await db()
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.userId, user!.id));
    expect(memberships.map((m) => [m.workspaceId, m.role])).toEqual([[s.a, 'member']]);
    const second = await createSession(user!.id);
    const newPassword = randomBytes(24).toString('base64url');
    const change = await app.inject({
      method: 'POST',
      url: '/v1/auth/password',
      headers: s.memberHeaders,
      payload: { currentPassword: s.created.temporaryPassword, newPassword },
    });
    expect(change.statusCode).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/auth/me', headers: headers(second.token) }))
        .statusCode,
    ).toBe(401);
    const currentHeaders = { cookie: String(change.headers['set-cookie']).split(';')[0]!, origin };
    const list = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${s.a}/people`,
      headers: s.ownerHeaders,
    });
    expect(list.body).not.toContain(s.created.temporaryPassword);
    expect(list.body).not.toContain('passwordHash');
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/v1/workspaces/${s.a}/people/${user!.id}`,
          headers: s.ownerHeaders,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/auth/me', headers: currentHeaders })).statusCode,
    ).toBe(401);
    expect(
      await db().select().from(schema.sessions).where(eq(schema.sessions.userId, user!.id)),
    ).toEqual([]);
  });

  it('rejects B across every resource family and excludes B from lists, overview, logs and scope=all', async () => {
    const s = await setup();
    const connection = await createConnection(s.b);
    const queue = await createQueue(s.b);
    const key = await createApiKeyForWorkspace(s.b, 'private-key');
    const { post, group, media } = await withWorkspace(s.b, async (tx) => {
      const [g] = await tx
        .insert(schema.postGroups)
        .values({ workspaceId: s.b, caption: 'private caption' })
        .returning();
      const [p] = await tx
        .insert(schema.posts)
        .values({
          workspaceId: s.b,
          groupId: g!.id,
          connectionId: connection,
          provider: 'fake',
          caption: 'private caption',
        })
        .returning();
      const [m] = await tx
        .insert(schema.media)
        .values({ workspaceId: s.b, kind: 'image', url: 'https://example.invalid/private.jpg' })
        .returning();
      await tx
        .insert(schema.eventLogs)
        .values({ workspaceId: s.b, kind: 'connection', message: 'private-event' });
      return { post: p!.id, group: g!.id, media: m!.id };
    });
    const [flow] = await db()
      .insert(schema.oauthFlows)
      .values({
        workspaceId: s.b,
        provider: 'fake',
        redirectUri: `${origin}/connect/callback`,
        status: 'awaiting_account',
        expiresAt: new Date(Date.now() + 60000),
      })
      .returning();
    const denied: Array<InjectOptions & { status: number }> = [
      {
        method: 'POST',
        url: '/v1/auth/session/workspace',
        payload: { workspaceId: s.b },
        status: 403,
      },
      { method: 'POST', url: '/v1/workspaces', payload: { name: 'Escape' }, status: 403 },
      { method: 'GET', url: `/v1/workspaces/${s.b}/people`, status: 403 },
      {
        method: 'POST',
        url: `/v1/workspaces/${s.b}/people`,
        payload: { email: 'other@example.invalid', role: 'member' },
        status: 403,
      },
      {
        method: 'DELETE',
        url: `/v1/workspaces/${s.b}/people/${s.created.person.userId}`,
        status: 403,
      },
      { method: 'GET', url: '/v1/api-keys', status: 403 },
      { method: 'POST', url: '/v1/api-keys', payload: { name: 'Escape' }, status: 403 },
      { method: 'DELETE', url: `/v1/api-keys/${key.id}`, status: 403 },
      { method: 'GET', url: `/v1/connections/invites?workspaceId=${s.b}`, status: 403 },
      {
        method: 'POST',
        url: '/v1/connections/fake/invite',
        payload: { workspaceId: s.b },
        status: 403,
      },
      {
        method: 'DELETE',
        url: `/v1/connections/invites/${flow!.id}?workspaceId=${s.b}`,
        status: 403,
      },
      {
        method: 'POST',
        url: '/v1/connections/finish',
        payload: { flowId: flow!.id, externalId: 'private-account' },
        status: 403,
      },
      { method: 'GET', url: `/v1/connections/${connection}/health`, status: 404 },
      { method: 'GET', url: `/v1/connections/${connection}/followers`, status: 404 },
      { method: 'DELETE', url: `/v1/connections/${connection}`, status: 404 },
      { method: 'POST', url: `/v1/connections/${connection}/import`, payload: {}, status: 404 },
      { method: 'GET', url: `/v1/posts/${post}`, status: 404 },
      { method: 'GET', url: `/v1/posts/${post}/metrics`, status: 404 },
      { method: 'PATCH', url: `/v1/posts/${post}`, payload: { caption: 'attempt' }, status: 404 },
      { method: 'DELETE', url: `/v1/posts/${post}`, status: 404 },
      { method: 'POST', url: `/v1/posts/${post}/retry`, status: 404 },
      { method: 'POST', url: `/v1/posts/${post}/remote/refresh`, payload: {}, status: 404 },
      { method: 'GET', url: `/v1/post-groups/${group}`, status: 404 },
      { method: 'POST', url: `/v1/post-groups/${group}/duplicate`, payload: {}, status: 404 },
      { method: 'GET', url: `/v1/media/${media}`, status: 404 },
      {
        method: 'POST',
        url: `/v1/media/${media}/validate`,
        payload: { provider: 'fake' },
        status: 404,
      },
      { method: 'GET', url: `/v1/queues/${queue}`, status: 404 },
      { method: 'GET', url: `/v1/queues/${queue}/slots`, status: 404 },
      { method: 'PATCH', url: `/v1/queues/${queue}`, payload: { name: 'attempt' }, status: 404 },
      { method: 'DELETE', url: `/v1/queues/${queue}`, status: 404 },
    ];
    for (const { status, ...request } of denied)
      expect(
        (await app.inject({ ...request, headers: s.memberHeaders })).statusCode,
        `${request.method} ${request.url}`,
      ).toBe(status);
    for (const url of [
      '/v1/auth/me',
      '/v1/overview',
      '/v1/connections',
      '/v1/posts',
      '/v1/post-groups',
      '/v1/queues',
      '/v1/logs',
      '/v1/logs/aggregate?from=2026-10-01&to=2026-10-12',
      '/v1/analytics/report?scope=all',
    ]) {
      const response = await app.inject({ method: 'GET', url, headers: s.memberHeaders });
      expect(response.statusCode, url).toBe(200);
      expect(response.body).not.toContain(s.b);
      expect(response.body).not.toContain('Private B');
      expect(response.body).not.toContain('private caption');
      expect(response.body).not.toContain('private-event');
    }
    const metrics = await app.inject({
      method: 'POST',
      url: '/v1/posts/metrics/latest',
      headers: s.memberHeaders,
      payload: { postIds: [post] },
    });
    expect(metrics.json()).toEqual({ metrics: {} });
  });
});
