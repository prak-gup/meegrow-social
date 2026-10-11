import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, db, schema } from '@meegrow-social/db';
import { createConnectInvite, listConnections, startConnect } from '@meegrow-social/core';
import { createUser, createWorkspace, resetDb } from '@meegrow-social/testing';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './server.js';

/**
 * The client-invite connect path, end to end over HTTP with the two-step fake provider: a person
 * with no login opens the link, approves on the platform, picks an account, and a connection exists
 * in the invite's workspace. Every request here is sent without a session or an API key — the only
 * thing carried between them is the cookie the start route sets.
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

const NONEXISTENT = '00000000-0000-0000-0000-000000000000';

/** The `name=value` pairs of a response's Set-Cookie headers, as a browser would send them back. */
function cookiesOf(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers['set-cookie'];
  if (!sc) return '';
  return (Array.isArray(sc) ? sc : [sc]).map((c) => String(c).split(';')[0]).join('; ');
}

/** Open an invite link and click Connect: returns the browser's cookie and where the flow is. */
async function startFromInvite(workspaceName = 'Ecolive') {
  const { id: uid } = await createUser();
  const ws = await createWorkspace(workspaceName);
  const invite = await createConnectInvite(ws, 'fake_2step', uid);
  const res = await app.inject({ method: 'POST', url: `/v1/invite/${invite.token}/start` });
  expect(res.statusCode).toBe(200);
  const authUrl = new URL(res.json<{ url: string }>().url);
  const flowId = authUrl.searchParams.get('state')!;
  return { ws, token: invite.token, flowId, cookie: cookiesOf(res), origin: authUrl.origin };
}

/** The platform redirecting the browser back after consent. */
const callback = (flowId: string, cookie = '') =>
  app.inject({
    method: 'GET',
    url: `/connect/callback?state=${flowId}&code=auth-code`,
    headers: cookie ? { cookie } : {},
  });

const picker = (flowId: string, cookie = '') =>
  app.inject({
    method: 'GET',
    url: `/v1/invite/flow/${flowId}`,
    headers: cookie ? { cookie } : {},
  });

const finish = (flowId: string, externalId: string, cookie = '', origin?: string) =>
  app.inject({
    method: 'POST',
    url: `/v1/invite/flow/${flowId}/finish`,
    payload: { externalId },
    headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) },
  });

describe('invite connect path', () => {
  it('connects the picked account into the invite workspace, with no login anywhere', async () => {
    const { ws, flowId, cookie, origin } = await startFromInvite('Ecolive');
    expect(cookie).toContain(flowId);

    const back = await callback(flowId, cookie);
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe(`${origin}/i/finish/${flowId}`);
    // Approving on the platform is not a connection.
    expect(await listConnections(ws)).toHaveLength(0);

    const pick = await picker(flowId, cookie);
    expect(pick.statusCode).toBe(200);
    expect(pick.json()).toEqual({
      workspaceName: 'Ecolive',
      provider: 'fake_2step',
      providerDisplayName: 'Fake Two-Step Provider',
      accounts: [
        { externalId: 'page-1', displayName: 'Page One' },
        { externalId: 'page-2', displayName: 'Page Two' },
      ],
    });

    const done = await finish(flowId, 'page-2', cookie, origin);
    expect(done.statusCode).toBe(201);
    const body = done.json<{ connectionId: string }>();
    expect(body).toMatchObject({
      accountName: 'Page Two',
      workspaceName: 'Ecolive',
      providerDisplayName: 'Fake Two-Step Provider',
    });

    const conns = await listConnections(ws);
    expect(conns).toHaveLength(1);
    expect(conns[0]).toMatchObject({
      id: body.connectionId,
      provider: 'fake_2step',
      externalId: 'page-2',
      displayName: 'Page Two',
    });

    // Single-use, and a reload of the picker says so rather than offering the list again.
    expect((await picker(flowId, cookie)).statusCode).toBe(409);
    expect((await finish(flowId, 'page-1', cookie, origin)).statusCode).toBe(409);
    expect(await listConnections(ws)).toHaveLength(1);
  });

  it('the invite link stays usable for a second connect', async () => {
    const first = await startFromInvite();
    await callback(first.flowId, first.cookie);
    expect((await finish(first.flowId, 'page-1', first.cookie, first.origin)).statusCode).toBe(201);

    const again = await app.inject({ method: 'POST', url: `/v1/invite/${first.token}/start` });
    expect(again.statusCode).toBe(200);
  });

  it('refuses a forged or unknown flow id, and a browser that did not start the flow', async () => {
    const { ws, flowId, cookie, origin } = await startFromInvite();
    await callback(flowId, cookie);
    const forgedCookie = `mg_flow_${flowId}=${'A'.repeat(43)}`;

    // No cookie at all: someone who only learned the flow id (it is the OAuth state).
    expect((await picker(flowId)).statusCode).toBe(404);
    expect((await finish(flowId, 'page-1', '', origin)).statusCode).toBe(404);
    // A made-up proof.
    expect((await picker(flowId, forgedCookie)).statusCode).toBe(404);
    expect((await finish(flowId, 'page-1', forgedCookie, origin)).statusCode).toBe(404);
    // A real proof, pointed at a flow id it was not minted for.
    expect((await picker(NONEXISTENT, cookie)).statusCode).toBe(404);
    expect((await finish(NONEXISTENT, 'page-1', cookie, origin)).statusCode).toBe(404);
    // Not an id at all: still a 404, never a database error.
    expect((await picker('not-a-uuid', cookie)).statusCode).toBe(404);
    expect((await finish('not-a-uuid', 'page-1', cookie, origin)).statusCode).toBe(404);

    expect(await listConnections(ws)).toHaveLength(0);
    // None of that burned the flow for the browser that owns it.
    expect((await finish(flowId, 'page-1', cookie, origin)).statusCode).toBe(201);
  });

  it("cannot finish, or land in, another workspace's flow", async () => {
    const mine = await startFromInvite('Mine');
    const theirs = await startFromInvite('Theirs');
    await callback(mine.flowId, mine.cookie);
    await callback(theirs.flowId, theirs.cookie);

    // My browser, their flow: my cookie is not a proof for it.
    expect((await picker(theirs.flowId, mine.cookie)).statusCode).toBe(404);
    expect((await finish(theirs.flowId, 'page-1', mine.cookie, mine.origin)).statusCode).toBe(404);
    // My proof replayed under their flow's cookie name.
    const replayed = `mg_flow_${theirs.flowId}=${mine.cookie.split('=')[1]}`;
    expect((await finish(theirs.flowId, 'page-1', replayed, mine.origin)).statusCode).toBe(404);
    expect(await listConnections(theirs.ws)).toHaveLength(0);

    // My own finish lands in my workspace and nowhere else.
    expect((await finish(mine.flowId, 'page-1', mine.cookie, mine.origin)).statusCode).toBe(201);
    expect(await listConnections(mine.ws)).toHaveLength(1);
    expect(await listConnections(theirs.ws)).toHaveLength(0);
  });

  it('a flow started from the dashboard cannot be finished through the public route', async () => {
    const ws = await createWorkspace();
    const { flowId } = await startConnect(ws, 'fake_2step', 'http://localhost:8990');
    const back = await callback(flowId);
    // No proof cookie → the popup hand-off page, not a redirect, and not a success.
    expect(back.statusCode).toBe(200);
    expect(back.body).toContain('window.opener.postMessage');
    expect(back.body).toContain('Not connected yet');
    expect((await picker(flowId)).statusCode).toBe(404);
    expect((await finish(flowId, 'page-1')).statusCode).toBe(404);
    expect(await listConnections(ws)).toHaveLength(0);
  });

  it('refuses an expired flow and connects nothing', async () => {
    const { ws, flowId, cookie, origin } = await startFromInvite();
    await callback(flowId, cookie);
    await db()
      .update(schema.oauthFlows)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.oauthFlows.id, flowId));

    expect((await picker(flowId, cookie)).statusCode).toBe(410);
    expect((await finish(flowId, 'page-1', cookie, origin)).statusCode).toBe(410);
    expect(await listConnections(ws)).toHaveLength(0);
  });

  it('a flow that expired before the platform redirected back fails on the callback page', async () => {
    const { ws, flowId, cookie } = await startFromInvite();
    await db()
      .update(schema.oauthFlows)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.oauthFlows.id, flowId));

    const back = await callback(flowId, cookie);
    expect(back.statusCode).toBe(400);
    expect(back.body).toContain('Not connected');
    expect(back.body).toContain('connect flow expired');
    expect(await listConnections(ws)).toHaveLength(0);
  });

  it('with zero accounts offered, shows an empty picker and connects nothing', async () => {
    const { ws, flowId, cookie, origin } = await startFromInvite();
    await callback(flowId, cookie);
    // Test setup only — fake_2step always lists two; this is the Instagram-without-a-linked-Page case.
    await db()
      .update(schema.oauthFlows)
      .set({ accounts: [] })
      .where(eq(schema.oauthFlows.id, flowId));

    const pick = await picker(flowId, cookie);
    expect(pick.statusCode).toBe(200);
    expect(pick.json<{ accounts: unknown[] }>().accounts).toEqual([]);
    expect((await finish(flowId, 'page-1', cookie, origin)).statusCode).toBe(400);
    expect(await listConnections(ws)).toHaveLength(0);
  });

  it('refuses an account that was not offered and a cross-origin post', async () => {
    const { ws, flowId, cookie, origin } = await startFromInvite();
    await callback(flowId, cookie);
    expect((await finish(flowId, 'page-999', cookie, origin)).statusCode).toBe(400);
    expect((await finish(flowId, 'page-1', cookie, 'https://evil.example')).statusCode).toBe(403);
    expect(await listConnections(ws)).toHaveLength(0);
  });

  it('a dead invite link starts nothing', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/invite/not-a-real-token/start' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});
