import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, db, schema } from '@meegrow-social/db';
import { AUTH_ATTEMPT_LIMITS } from '@meegrow-social/core';
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

/**
 * Brute-force limits on POST /v1/auth/login. `resetDb` (beforeEach) also clears the attempt
 * counters, so every test starts with a full budget. `inject` has no reverse proxy in front of it,
 * so `remoteAddress` plays the client address here; how the address is taken from
 * X-Forwarded-For behind the proxy is covered in server.test.ts.
 */
describe('login attempt limiting', () => {
  const { perAccount, perIp } = AUTH_ATTEMPT_LIMITS.login;

  const loginFrom = (remoteAddress: string, email: string, password: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress,
      payload: { email, password },
    });

  async function seedUser(email = 'owner@test.local', password = 's3cret') {
    const ws = await createWorkspace();
    const u = await createUser(email, password);
    await createMembership(u.id, ws, 'owner');
  }

  it('429s with Retry-After once an account has had too many wrong passwords', async () => {
    await seedUser();
    for (let i = 0; i < perAccount; i++) {
      // A different address each time: this is the distributed-guessing case.
      const res = await loginFrom(`198.51.100.${i + 1}`, 'owner@test.local', 'wrong-password');
      expect(res.statusCode).toBe(401);
    }

    const res = await loginFrom('198.51.100.200', 'owner@test.local', 'wrong-password');
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: 'too many attempts, try again later' });
    const retryAfter = Number(res.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(15 * 60);
    expect(extractSid(res)).toBeNull();

    // Even the right password is refused until the window closes, and no session is created.
    const right = await loginFrom('198.51.100.201', 'owner@test.local', 's3cret');
    expect(right.statusCode).toBe(429);
    expect(extractSid(right)).toBeNull();
    expect(await db().select().from(schema.sessions)).toHaveLength(0);
  });

  it('one locked account locks out nobody else', async () => {
    await seedUser('owner@test.local');
    await seedUser('other@test.local', 'other-pass');
    for (let i = 0; i < perAccount; i++) {
      await loginFrom(`198.51.100.${i + 1}`, 'owner@test.local', 'wrong-password');
    }
    expect((await loginFrom('203.0.113.5', 'owner@test.local', 's3cret')).statusCode).toBe(429);
    expect((await loginFrom('203.0.113.5', 'other@test.local', 'other-pass')).statusCode).toBe(200);
  });

  it('a successful login clears the count, so earlier mistakes are not held against the user', async () => {
    await seedUser();
    for (let i = 0; i < perAccount - 1; i++) {
      expect((await login('owner@test.local', 'wrong-password')).statusCode).toBe(401);
    }
    expect((await login('owner@test.local', 's3cret')).statusCode).toBe(200);
    // A full budget again: perAccount more mistakes are 401s, not 429s.
    for (let i = 0; i < perAccount; i++) {
      expect((await login('owner@test.local', 'wrong-password')).statusCode).toBe(401);
    }
    expect((await login('owner@test.local', 'wrong-password')).statusCode).toBe(429);
  });

  it('throttles an unknown email exactly like a real one', async () => {
    for (let i = 0; i < perAccount; i++) {
      const res = await loginFrom(`198.51.100.${i + 1}`, 'nobody@test.local', 'guess');
      expect(res.statusCode).toBe(401);
    }
    expect((await loginFrom('198.51.100.200', 'nobody@test.local', 'guess')).statusCode).toBe(429);
  });

  it('429s one address spraying many accounts, without touching other addresses', async () => {
    await seedUser();
    for (let i = 0; i < perIp; i++) {
      const res = await loginFrom('203.0.113.66', `victim${i}@test.local`, 'Summer2026!');
      expect(res.statusCode).toBe(401);
    }
    expect((await loginFrom('203.0.113.66', 'owner@test.local', 's3cret')).statusCode).toBe(429);
    expect((await loginFrom('203.0.113.67', 'owner@test.local', 's3cret')).statusCode).toBe(200);
  });

  it('a malformed body is a 400 and uses up no attempt', async () => {
    await seedUser();
    for (let i = 0; i < perAccount + 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'owner@test.local' },
      });
      expect(res.statusCode).toBe(400);
    }
    expect((await login('owner@test.local', 's3cret')).statusCode).toBe(200);
  });
});
