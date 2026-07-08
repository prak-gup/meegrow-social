import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, db, schema } from '@meegrow-social/db';
import {
  createConnection,
  createMembership,
  createUser,
  createWorkspace,
  resetDb,
} from '@meegrow-social/testing';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './server.js';

let app: FastifyInstance;

beforeAll(async () => {
  process.env.DATABASE_URL ??= 'postgres://prakhar@localhost:5432/meegrow_social';
  process.env.APP_DATABASE_URL ??= 'postgres://mgs_app:mgs_app@localhost:5432/meegrow_social';
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
  app = await buildServer();
});
beforeEach(resetDb);
afterAll(async () => {
  await app.close();
  await closeDb();
});

// Matches appUrl()'s default → originAllowed() accepts it.
const ORIGIN = 'http://localhost:8990';

function extractSid(res: { headers: Record<string, unknown> }): string | null {
  const sc = res.headers['set-cookie'];
  if (!sc) return null;
  for (const c of Array.isArray(sc) ? sc : [sc]) {
    const m = String(c).match(/mg_sid=([^;]+)/);
    if (m) return m[1];
  }
  return null;
}

const sessionHeaders = (sid: string | null) => ({
  cookie: sid ? `mg_sid=${sid}` : '',
  origin: ORIGIN,
});

const login = (email: string, password: string) =>
  app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } });

async function loginOwner(
  email = 'owner@test.local',
  password = 's3cret',
): Promise<{ sid: string; userId: string; workspaceId: string }> {
  const ws = await createWorkspace();
  const u = await createUser(email, password);
  await createMembership(u.id, ws, 'owner');
  const sid = extractSid(await login(email, password))!;
  return { sid, userId: u.id, workspaceId: ws };
}

describe('human auth (sessions, invite-only)', () => {
  it('logs in with correct credentials and sets an httpOnly + SameSite=Lax session cookie', async () => {
    const ws = await createWorkspace('Owner WS');
    const u = await createUser('owner@test.local', 's3cret');
    await createMembership(u.id, ws, 'owner');

    const res = await login('owner@test.local', 's3cret');
    expect(res.statusCode).toBe(200);
    const raw = res.headers['set-cookie'];
    const setCookie = Array.isArray(raw) ? raw.join('; ') : String(raw ?? '');
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(extractSid(res)).toBeTruthy();

    const body = res.json<{
      user: { email: string; memberships: unknown[] };
      activeWorkspaceId: string;
    }>();
    expect(body.user.email).toBe('owner@test.local');
    expect(body.user.memberships).toHaveLength(1);
    expect(body.activeWorkspaceId).toBe(ws);
  });

  it('rejects a wrong password with 401 and sets no session cookie', async () => {
    const ws = await createWorkspace();
    const u = await createUser('owner@test.local', 's3cret');
    await createMembership(u.id, ws, 'owner');

    const res = await login('owner@test.local', 'wrong-password');
    expect(res.statusCode).toBe(401);
    expect(extractSid(res)).toBeNull();
  });

  it('rejects an unknown user with 401', async () => {
    const res = await login('nobody@test.local', 's3cret');
    expect(res.statusCode).toBe(401);
  });

  it('session-authed requests reach the same /v1 APIs as key-authed (workspace from membership)', async () => {
    const ws = await createWorkspace();
    const u = await createUser('owner@test.local', 's3cret');
    await createMembership(u.id, ws, 'owner');
    await createConnection(ws, 'fake'); // a connection exists in this workspace

    const sid = extractSid(await login('owner@test.local', 's3cret'))!;
    const me = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: sessionHeaders(sid),
    });
    expect(me.statusCode).toBe(200);

    const conns = await app.inject({
      method: 'GET',
      url: '/v1/connections',
      headers: sessionHeaders(sid),
    });
    expect(conns.statusCode).toBe(200);
    expect(conns.json<{ connections: unknown[] }>().connections).toHaveLength(1);
  });

  it('logout revokes the session server-side and clears the cookie', async () => {
    const { sid } = await loginOwner();

    const out = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: sessionHeaders(sid),
    });
    expect(out.statusCode).toBe(200);
    expect(out.headers['set-cookie']).toBeDefined();

    // The old token no longer authenticates.
    const me = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: sessionHeaders(sid),
    });
    expect(me.statusCode).toBe(401);
  });

  it('rejects an expired session', async () => {
    const { sid, userId } = await loginOwner();
    // Force the session row into the past; authenticateSession must treat it as expired.
    await db()
      .update(schema.sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.sessions.userId, userId));

    const me = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: sessionHeaders(sid),
    });
    expect(me.statusCode).toBe(401);
  });

  it('rotates the session token and invalidates the old one', async () => {
    const { sid: sid1 } = await loginOwner();

    const rot = await app.inject({
      method: 'POST',
      url: '/v1/auth/session/rotate',
      headers: sessionHeaders(sid1),
    });
    expect(rot.statusCode).toBe(200);
    const sid2 = extractSid(rot);
    expect(sid2).toBeTruthy();
    expect(sid2).not.toBe(sid1);

    const meOld = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: sessionHeaders(sid1),
    });
    expect(meOld.statusCode).toBe(401);

    const meNew = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: sessionHeaders(sid2),
    });
    expect(meNew.statusCode).toBe(200);
  });

  it('switches the active workspace (memberships) and re-scopes /v1 to it', async () => {
    const ws1 = await createWorkspace('One');
    const ws2 = await createWorkspace('Two');
    const u = await createUser('owner@test.local', 's3cret');
    await createMembership(u.id, ws1, 'owner');
    await createMembership(u.id, ws2, 'owner');
    await createConnection(ws2, 'fake', 'WS2 conn'); // only ws2 has a connection

    const sid = extractSid(await login('owner@test.local', 's3cret'))!;
    // Default active workspace is the first membership (ws1) → no connections.
    const before = await app.inject({
      method: 'GET',
      url: '/v1/connections',
      headers: sessionHeaders(sid),
    });
    expect(before.json<{ connections: unknown[] }>().connections).toHaveLength(0);

    const switchRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/session/workspace',
      headers: sessionHeaders(sid),
      payload: { workspaceId: ws2 },
    });
    expect(switchRes.statusCode).toBe(200);
    expect(switchRes.json<{ activeWorkspaceId: string }>().activeWorkspaceId).toBe(ws2);

    const after = await app.inject({
      method: 'GET',
      url: '/v1/connections',
      headers: sessionHeaders(sid),
    });
    expect(after.json<{ connections: unknown[] }>().connections).toHaveLength(1);
  });

  it('refuses switching to a workspace the user is not a member of', async () => {
    const { sid } = await loginOwner();
    const other = await createWorkspace('Not mine');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/session/workspace',
      headers: sessionHeaders(sid),
      payload: { workspaceId: other },
    });
    expect(res.statusCode).toBe(403);
  });

  it('blocks a cookie-authed mutation from a disallowed Origin (CSRF)', async () => {
    const { sid } = await loginOwner();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie: `mg_sid=${sid}`, origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('allows a cookie-authed mutation from the same Origin', async () => {
    const { sid } = await loginOwner();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: sessionHeaders(sid), // origin = app origin
    });
    expect(res.statusCode).toBe(200);
  });
});
