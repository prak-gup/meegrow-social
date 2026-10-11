import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, db, schema } from '@meegrow-social/db';
import { createConnectInvite, listConnections, startConnect } from '@meegrow-social/core';
import {
  createMembership,
  createUser,
  createWorkspace,
  resetDb,
  useTestDatabaseEnv,
} from '@meegrow-social/testing';
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
  useTestDatabaseEnv();
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

  it('the link can be retried until a connection succeeds, then stops working', async () => {
    const first = await startFromInvite();
    await callback(first.flowId, first.cookie);
    // Gave up at the picker, or picked nothing: opening the link again starts a fresh flow.
    const retry = await app.inject({ method: 'POST', url: `/v1/invite/${first.token}/start` });
    expect(retry.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/v1/invite/${first.token}` })).statusCode).toBe(
      200,
    );

    expect((await finish(first.flowId, 'page-1', first.cookie, first.origin)).statusCode).toBe(201);

    // Used: the landing shows "This link isn't valid" and nothing new can be started from it.
    expect((await app.inject({ method: 'GET', url: `/v1/invite/${first.token}` })).statusCode).toBe(
      404,
    );
    const again = await app.inject({ method: 'POST', url: `/v1/invite/${first.token}/start` });
    expect(again.statusCode).toBe(404);
  });

  it('a second flow left open on the same link cannot connect after the first one did', async () => {
    const first = await startFromInvite();
    const secondStart = await app.inject({
      method: 'POST',
      url: `/v1/invite/${first.token}/start`,
    });
    const secondFlow = new URL(secondStart.json<{ url: string }>().url).searchParams.get('state')!;
    const secondCookie = cookiesOf(secondStart);
    await callback(first.flowId, first.cookie);
    await callback(secondFlow, secondCookie);

    expect((await finish(first.flowId, 'page-1', first.cookie, first.origin)).statusCode).toBe(201);
    expect((await picker(secondFlow, secondCookie)).statusCode).toBe(409);
    expect((await finish(secondFlow, 'page-2', secondCookie, first.origin)).statusCode).toBe(409);
    expect(await listConnections(first.ws)).toHaveLength(1);
  });

  it('a single-step platform connects on the callback and uses the link up', async () => {
    const { id: uid } = await createUser();
    const ws = await createWorkspace('Single');
    const invite = await createConnectInvite(ws, 'fake', uid);
    const start = await app.inject({ method: 'POST', url: `/v1/invite/${invite.token}/start` });
    const flowId = new URL(start.json<{ url: string }>().url).searchParams.get('state')!;

    const back = await callback(flowId, cookiesOf(start));
    expect(back.statusCode).toBe(200);
    expect(back.body).toContain('<h1 id="t">Connected</h1>');
    expect(await listConnections(ws)).toHaveLength(1);
    expect(
      (await app.inject({ method: 'GET', url: `/v1/invite/${invite.token}` })).statusCode,
    ).toBe(404);
  });

  // The forwarded-consent case: someone holding the link starts a flow, sends the platform's
  // consent URL to a person who manages the account, and waits for them to approve.
  it('refuses the callback in a browser that did not start the flow, and burns the flow', async () => {
    const { ws, flowId, cookie, origin } = await startFromInvite();

    const back = await callback(flowId); // the other person's browser: no proof cookie
    expect(back.statusCode).toBe(400);
    expect(back.body).toContain('Not connected');
    expect(back.body).toContain('opened in a different browser');
    // Their approval was never exchanged, so there is nothing for the link holder to pick up…
    const [flow] = await db()
      .select()
      .from(schema.oauthFlows)
      .where(eq(schema.oauthFlows.id, flowId));
    expect(flow?.encryptedTokens).toBeNull();
    expect(flow?.status).toBe('consumed');
    expect((await picker(flowId, cookie)).statusCode).toBe(409);
    expect((await finish(flowId, 'page-1', cookie, origin)).statusCode).toBe(409);
    // …and replaying the same redirect in the starting browser does not revive it.
    expect((await callback(flowId, cookie)).statusCode).toBe(400);
    expect(await listConnections(ws)).toHaveLength(0);
  });

  it('refuses the same thing for a single-step platform, which would otherwise connect at once', async () => {
    const { id: uid } = await createUser();
    const ws = await createWorkspace('Single');
    const invite = await createConnectInvite(ws, 'fake', uid);
    const start = await app.inject({ method: 'POST', url: `/v1/invite/${invite.token}/start` });
    const flowId = new URL(start.json<{ url: string }>().url).searchParams.get('state')!;

    expect((await callback(flowId)).statusCode).toBe(400);
    expect(await listConnections(ws)).toHaveLength(0);
    // Nothing connected, so the link itself is still good for an honest retry.
    expect(
      (await app.inject({ method: 'GET', url: `/v1/invite/${invite.token}` })).statusCode,
    ).toBe(200);
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

/** The Clients page mints for any client in the list, without switching the operator's active one. */
describe('minting an invite for a named client', () => {
  const ORIGIN = 'http://localhost:8990';

  async function operator() {
    const active = await createWorkspace('Active');
    const user = await createUser('op@test.local', 's3cret-pass');
    await createMembership(user.id, active, 'owner');
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: user.email, password: user.password },
    });
    expect(login.statusCode).toBe(200);
    return { userId: user.id, active, headers: { cookie: cookiesOf(login), origin: ORIGIN } };
  }

  it('mints for another client the operator belongs to, and stays on the active client', async () => {
    const { userId, active, headers } = await operator();
    const other = await createWorkspace('Jaipur Eye');
    await createMembership(userId, other, 'owner');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/connections/fake_2step/invite',
      headers,
      payload: { workspaceId: other },
    });
    expect(res.statusCode).toBe(201);
    const { token } = res.json<{ token: string }>();
    const landing = await app.inject({ method: 'GET', url: `/v1/invite/${token}` });
    expect(landing.json<{ workspaceName: string }>().workspaceName).toBe('Jaipur Eye');

    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers });
    expect(me.json<{ activeWorkspaceId: string }>().activeWorkspaceId).toBe(active);
  });

  it("refuses a client the operator does not belong to, the same as one that doesn't exist", async () => {
    const { headers } = await operator();
    const foreign = await createWorkspace('Not Mine');
    for (const workspaceId of [foreign, NONEXISTENT]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/connections/fake_2step/invite',
        headers,
        payload: { workspaceId },
      });
      expect(res.statusCode).toBe(403);
    }
  });
});

/** The operator's view of a client's links: which still work, and cancelling one. */
describe('outstanding invite links', () => {
  const ORIGIN = 'http://localhost:8990';

  async function operator() {
    const active = await createWorkspace('Active');
    const user = await createUser('op@test.local', 's3cret-pass');
    await createMembership(user.id, active, 'owner');
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: user.email, password: user.password },
    });
    expect(login.statusCode).toBe(200);
    return { userId: user.id, active, headers: { cookie: cookiesOf(login), origin: ORIGIN } };
  }

  interface Listed {
    id: string;
    url: string;
    provider: string;
    lastStartedAt: string | null;
  }
  const list = async (headers: Record<string, string>, workspaceId?: string) => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/connections/invites${workspaceId ? `?workspaceId=${workspaceId}` : ''}`,
      headers,
    });
    return { status: res.statusCode, invites: res.json<{ invites?: Listed[] }>().invites ?? [] };
  };
  const revoke = (headers: Record<string, string>, id: string, workspaceId?: string) =>
    app.inject({
      method: 'DELETE',
      url: `/v1/connections/invites/${id}${workspaceId ? `?workspaceId=${workspaceId}` : ''}`,
      headers,
    });

  it('lists the links that still work, and says when one was opened but not finished', async () => {
    const { userId, active, headers } = await operator();
    const opened = await createConnectInvite(active, 'fake_2step', userId);
    const untouched = await createConnectInvite(active, 'fake', userId);
    const expired = await createConnectInvite(active, 'fake', userId);
    await db()
      .update(schema.connectInvites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.connectInvites.token, expired.token));
    await app.inject({ method: 'POST', url: `/v1/invite/${opened.token}/start` });

    const { status, invites } = await list(headers);
    expect(status).toBe(200);
    expect(invites.map((i) => i.url).sort()).toEqual(
      [`${ORIGIN}/i/${opened.token}`, `${ORIGIN}/i/${untouched.token}`].sort(),
    );
    const byUrl = new Map(invites.map((i) => [i.url, i]));
    expect(byUrl.get(`${ORIGIN}/i/${opened.token}`)?.lastStartedAt).not.toBeNull();
    expect(byUrl.get(`${ORIGIN}/i/${untouched.token}`)?.lastStartedAt).toBeNull();
  });

  it('a link drops off the list once an account was connected through it', async () => {
    const { userId, active, headers } = await operator();
    const invite = await createConnectInvite(active, 'fake_2step', userId);
    const start = await app.inject({ method: 'POST', url: `/v1/invite/${invite.token}/start` });
    const flowId = new URL(start.json<{ url: string }>().url).searchParams.get('state')!;
    const cookie = cookiesOf(start);
    await callback(flowId, cookie);
    expect((await list(headers)).invites).toHaveLength(1);

    expect((await finish(flowId, 'page-1', cookie, ORIGIN)).statusCode).toBe(201);
    expect((await list(headers)).invites).toHaveLength(0);
  });

  it('a cancelled link shows as invalid, starts nothing, and strands a flow already open', async () => {
    const { userId, active, headers } = await operator();
    const invite = await createConnectInvite(active, 'fake_2step', userId);
    const start = await app.inject({ method: 'POST', url: `/v1/invite/${invite.token}/start` });
    const flowId = new URL(start.json<{ url: string }>().url).searchParams.get('state')!;
    const cookie = cookiesOf(start);
    await callback(flowId, cookie);
    const [listed] = (await list(headers)).invites;

    const res = await revoke(headers, listed!.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ revoked: true });

    expect((await list(headers)).invites).toHaveLength(0);
    expect(
      (await app.inject({ method: 'GET', url: `/v1/invite/${invite.token}` })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: `/v1/invite/${invite.token}/start` })).statusCode,
    ).toBe(404);
    // The client was already on the picker when the operator cancelled.
    expect((await picker(flowId, cookie)).statusCode).toBe(410);
    expect((await finish(flowId, 'page-1', cookie, ORIGIN)).statusCode).toBe(410);
    expect(await listConnections(active)).toHaveLength(0);
    // Cancelling twice is a 404, like a link that never existed.
    expect((await revoke(headers, listed!.id)).statusCode).toBe(404);
  });

  it('a cancelled link refuses a flow that had not come back from the platform yet', async () => {
    const { userId, active, headers } = await operator();
    const invite = await createConnectInvite(active, 'fake', userId);
    const start = await app.inject({ method: 'POST', url: `/v1/invite/${invite.token}/start` });
    const flowId = new URL(start.json<{ url: string }>().url).searchParams.get('state')!;
    const [listed] = (await list(headers)).invites;
    await revoke(headers, listed!.id);

    const back = await callback(flowId, cookiesOf(start));
    expect(back.statusCode).toBe(400);
    expect(back.body).toContain('no longer valid');
    expect(await listConnections(active)).toHaveLength(0);
  });

  it('reaches another client the operator belongs to, without switching the active one', async () => {
    const { userId, active, headers } = await operator();
    const other = await createWorkspace('Jaipur Eye');
    await createMembership(userId, other, 'owner');
    const invite = await createConnectInvite(other, 'fake', userId);

    expect((await list(headers)).invites).toHaveLength(0);
    const { invites } = await list(headers, other);
    expect(invites.map((i) => i.url)).toEqual([`${ORIGIN}/i/${invite.token}`]);

    // The id alone is not enough: it has to be named under the client it belongs to.
    expect((await revoke(headers, invites[0]!.id)).statusCode).toBe(404);
    expect((await list(headers, other)).invites).toHaveLength(1);
    expect((await revoke(headers, invites[0]!.id, other)).statusCode).toBe(200);
    expect((await list(headers, other)).invites).toHaveLength(0);

    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers });
    expect(me.json<{ activeWorkspaceId: string }>().activeWorkspaceId).toBe(active);
  });

  it("cannot see or cancel a client's links without belonging to it", async () => {
    const { headers } = await operator();
    const owner = await createUser('other@test.local', 's3cret-pass');
    const foreign = await createWorkspace('Not Mine');
    const invite = await createConnectInvite(foreign, 'fake', owner.id);
    const [row] = await db()
      .select({ id: schema.connectInvites.id })
      .from(schema.connectInvites)
      .where(eq(schema.connectInvites.token, invite.token));

    for (const workspaceId of [foreign, NONEXISTENT]) {
      expect((await list(headers, workspaceId)).status).toBe(403);
      expect((await revoke(headers, row!.id, workspaceId)).statusCode).toBe(403);
    }
    // Nor by naming the id under the operator's own client.
    expect((await revoke(headers, row!.id)).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: `/v1/invite/${invite.token}` })).statusCode,
    ).toBe(200);
  });

  it('needs a login or a key', async () => {
    expect((await list({})).status).toBe(401);
    expect((await revoke({}, NONEXISTENT)).statusCode).toBe(401);
  });
});
