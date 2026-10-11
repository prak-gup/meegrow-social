import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { closeDb, db, schema, withWorkspace } from '@meegrow-social/db';
import { createApiKeyForWorkspace, verifyPassword } from '@meegrow-social/core';
import { createMembership, createUser, createWorkspace, resetDb } from '@meegrow-social/testing';
import { buildServer } from './server.js';

/**
 * POST /v1/auth/password over HTTP: a signed-in human changes their own password.
 *
 * The properties that matter: only a session can do it (never an API key), the current password
 * must be proven, every other session of the user dies, and the caller stays signed in on a
 * re-issued cookie.
 */

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
const EMAIL = 'owner@test.local';
const OLD = 'old-password-123';
const NEW = 'a-brand-new-password';

function extractSid(res: { headers: Record<string, unknown> }): string | null {
  const sc = res.headers['set-cookie'];
  if (!sc) return null;
  for (const c of Array.isArray(sc) ? sc : [sc]) {
    const m = String(c).match(/mg_sid=([^;]+)/);
    if (m) return m[1] ?? null;
  }
  return null;
}

const sessionHeaders = (sid: string | null) => ({
  cookie: sid ? `mg_sid=${sid}` : '',
  origin: ORIGIN,
});

const login = (email: string, password: string) =>
  app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } });

const me = (sid: string | null) =>
  app.inject({ method: 'GET', url: '/v1/auth/me', headers: sessionHeaders(sid) });

const changePassword = (
  headers: Record<string, string>,
  payload: Record<string, unknown> = { currentPassword: OLD, newPassword: NEW },
) => app.inject({ method: 'POST', url: '/v1/auth/password', headers, payload });

async function seedOwner(): Promise<{ userId: string; workspaceId: string }> {
  const workspaceId = await createWorkspace();
  const u = await createUser(EMAIL, OLD);
  await createMembership(u.id, workspaceId, 'owner');
  return { userId: u.id, workspaceId };
}

/** The request-logging hook is fire-and-forget, so its rows can land after inject() resolves. */
async function waitForLogRows(workspaceId: string, route: string, atLeast: number) {
  const start = Date.now();
  for (;;) {
    const all = await withWorkspace(workspaceId, (tx) => tx.select().from(schema.eventLogs));
    const rows = all.filter((r) => r.route === route);
    if (rows.length >= atLeast) return rows;
    if (Date.now() - start > 2000) {
      throw new Error(`timed out waiting for ${atLeast} ${route} log rows, saw ${rows.length}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function storedHash(userId: string): Promise<string> {
  const [row] = await db()
    .select({ passwordHash: schema.users.passwordHash })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return row!.passwordHash!;
}

describe('POST /v1/auth/password', () => {
  it('changes the password: the new one logs in, the old one no longer does', async () => {
    const { userId } = await seedOwner();
    const sid = extractSid(await login(EMAIL, OLD))!;

    const res = await changePassword(sessionHeaders(sid));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const hash = await storedHash(userId);
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, NEW)).toBe(true);

    expect((await login(EMAIL, OLD)).statusCode).toBe(401);
    expect((await login(EMAIL, NEW)).statusCode).toBe(200);
  });

  it('keeps the caller signed in on a rotated cookie and kills the pre-change token', async () => {
    await seedOwner();
    const sid = extractSid(await login(EMAIL, OLD))!;

    const res = await changePassword(sessionHeaders(sid));
    const raw = res.headers['set-cookie'];
    const setCookie = Array.isArray(raw) ? raw.join('; ') : String(raw ?? '');
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);

    const rotated = extractSid(res);
    expect(rotated).toBeTruthy();
    expect(rotated).not.toBe(sid);
    expect((await me(rotated)).statusCode).toBe(200);
    expect((await me(sid)).statusCode).toBe(401);
  });

  it("revokes every other session of the user, and nobody else's", async () => {
    const { userId, workspaceId } = await seedOwner();
    const here = extractSid(await login(EMAIL, OLD))!;
    const laptop = extractSid(await login(EMAIL, OLD))!;
    const phone = extractSid(await login(EMAIL, OLD))!;

    // A different user in the same workspace must be untouched.
    const other = await createUser('other@test.local', 'other-password-1');
    await createMembership(other.id, workspaceId, 'member');
    const otherSid = extractSid(await login('other@test.local', 'other-password-1'))!;

    const res = await changePassword(sessionHeaders(here));
    expect(res.statusCode).toBe(200);

    expect((await me(laptop)).statusCode).toBe(401);
    expect((await me(phone)).statusCode).toBe(401);
    expect((await me(extractSid(res))).statusCode).toBe(200);
    expect((await me(otherSid)).statusCode).toBe(200);

    const mine = await db()
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, userId));
    expect(mine).toHaveLength(1);
  });

  it('rejects a wrong current password with 422 and changes nothing', async () => {
    const { userId } = await seedOwner();
    const sid = extractSid(await login(EMAIL, OLD))!;
    const elsewhere = extractSid(await login(EMAIL, OLD))!;
    const before = await storedHash(userId);

    const res = await changePassword(sessionHeaders(sid), {
      currentPassword: 'not-my-password',
      newPassword: NEW,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'current password is incorrect' });
    expect(extractSid(res)).toBeNull();

    expect(await storedHash(userId)).toBe(before);
    // Neither this session nor the other one was touched.
    expect((await me(sid)).statusCode).toBe(200);
    expect((await me(elsewhere)).statusCode).toBe(200);
    expect((await login(EMAIL, NEW)).statusCode).toBe(401);
  });

  it('refuses an API key, even one for the same workspace', async () => {
    const { userId, workspaceId } = await seedOwner();
    const { secret } = await createApiKeyForWorkspace(workspaceId, 'bot');
    const before = await storedHash(userId);

    const res = await changePassword({ authorization: `Bearer ${secret}` });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'session required' });
    expect(await storedHash(userId)).toBe(before);
  });

  it('refuses a request carrying both a valid API key and a valid session cookie', async () => {
    // The auth hook resolves the key first, so this is a key-authed request: no user, no change.
    const { userId, workspaceId } = await seedOwner();
    const { secret } = await createApiKeyForWorkspace(workspaceId, 'bot');
    const sid = extractSid(await login(EMAIL, OLD))!;
    const before = await storedHash(userId);

    const res = await changePassword({
      ...sessionHeaders(sid),
      authorization: `Bearer ${secret}`,
    });
    expect(res.statusCode).toBe(401);
    expect(await storedHash(userId)).toBe(before);
    expect((await me(sid)).statusCode).toBe(200);
  });

  it('rejects an unauthenticated request', async () => {
    await seedOwner();
    const res = await changePassword({ origin: ORIGIN });
    expect(res.statusCode).toBe(401);
  });

  it('enforces the new-password policy server-side', async () => {
    const { userId } = await seedOwner();
    const sid = extractSid(await login(EMAIL, OLD))!;
    const before = await storedHash(userId);

    const attempts = [
      { currentPassword: OLD, newPassword: 'x'.repeat(11) }, // too short
      { currentPassword: OLD, newPassword: 'x'.repeat(129) }, // too long
      { currentPassword: OLD, newPassword: OLD }, // unchanged
      { currentPassword: OLD }, // missing
      { newPassword: NEW }, // missing
    ];
    for (const payload of attempts) {
      const res = await changePassword(sessionHeaders(sid), payload);
      expect(res.statusCode).toBe(400);
      // A validation error must never echo a submitted password.
      expect(res.body).not.toContain(OLD);
    }
    expect(await storedHash(userId)).toBe(before);
    expect((await me(sid)).statusCode).toBe(200);
  });

  it('is covered by the CSRF Origin check', async () => {
    const { userId } = await seedOwner();
    const sid = extractSid(await login(EMAIL, OLD))!;
    const before = await storedHash(userId);

    const res = await changePassword({ cookie: `mg_sid=${sid}`, origin: 'https://evil.example' });
    expect(res.statusCode).toBe(403);
    expect(await storedHash(userId)).toBe(before);
  });

  it('logs the request as route + status only — neither password reaches event_logs', async () => {
    const { workspaceId } = await seedOwner();
    const sid = extractSid(await login(EMAIL, OLD))!;
    await changePassword(sessionHeaders(sid), {
      currentPassword: 'wrong-guess-1',
      newPassword: NEW,
    });
    await changePassword(sessionHeaders(sid));

    const rows = await waitForLogRows(workspaceId, '/v1/auth/password', 2);
    expect(rows.map((r) => r.status).sort()).toEqual(['200', '422']);
    const dump = JSON.stringify(rows);
    for (const secret of [OLD, NEW, 'wrong-guess-1']) expect(dump).not.toContain(secret);
  });
});
