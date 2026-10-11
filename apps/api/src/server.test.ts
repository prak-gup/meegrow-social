import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '@meegrow-social/core';
import type { FastifyInstance } from 'fastify';
import { buildServer, inviteFlowCookie, trustProxySetting } from './server.js';

/**
 * The REST layer in isolation, for the routes that need no database to prove: `core` is replaced by
 * spies, so what is under test is routing (static vs parametric paths, methods), auth ordering,
 * what each route hands core, and how each core outcome maps to a status. The behaviour behind the
 * spies is covered by the `*.integration.test.ts` suites.
 */
vi.mock('@meegrow-social/core', async (importOriginal) => ({
  ...(await importOriginal<typeof core>()),
  authenticateApiKey: vi.fn(),
  authenticateSession: vi.fn(),
  buildUserView: vi.fn(),
  changePasswordWithLimit: vi.fn(),
  createSession: vi.fn(),
  loginWithPassword: vi.fn(),
  recordApiRequestLog: vi.fn(),
  createPost: vi.fn(),
  createConnectInvite: vi.fn(),
  isWorkspaceMember: vi.fn(),
  finishInviteConnect: vi.fn(),
  getInviteFlow: vi.fn(),
  handleCallback: vi.fn(),
  startInviteConnect: vi.fn(),
  getConnectionHealth: vi.fn(),
  listConnectionHealth: vi.fn(),
  previewQueueSlots: vi.fn(),
  retryPost: vi.fn(),
  validatePost: vi.fn(),
}));

const WS = '11111111-1111-4111-8111-111111111111';
const POST = '22222222-2222-4222-8222-222222222222';
const CONN = '33333333-3333-4333-8333-333333333333';
const QUEUE = '66666666-6666-4666-8666-666666666666';
const auth = { authorization: 'Bearer sk_live_good' };

let app: FastifyInstance;
let previousDriver: string | undefined;

beforeAll(async () => {
  // Skips the disk-backed /media static route, which wants a real directory.
  previousDriver = process.env.MEDIA_STORAGE_DRIVER;
  process.env.MEDIA_STORAGE_DRIVER = 's3';
  app = await buildServer();
});
afterAll(async () => {
  await app.close();
  if (previousDriver === undefined) delete process.env.MEDIA_STORAGE_DRIVER;
  else process.env.MEDIA_STORAGE_DRIVER = previousDriver;
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(core.authenticateApiKey).mockImplementation(async (key) =>
    key === 'sk_live_good' ? { workspaceId: WS, apiKeyId: 'key-1' } : null,
  );
  vi.mocked(core.recordApiRequestLog).mockResolvedValue(undefined as never);
});

describe('GET /mcp', () => {
  it('is 405 with Allow: POST for an authenticated caller, not 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/mcp', headers: auth });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe('POST');
    expect(res.json()).toEqual({ error: 'method not allowed: /mcp accepts POST only' });
  });

  it('is 401 without a key, like POST /mcp — auth is answered before the method', async () => {
    const res = await app.inject({ method: 'GET', url: '/mcp' });
    expect(res.statusCode).toBe(401);
    expect(res.headers.allow).toBeUndefined();
    expect(res.json()).toEqual({ error: 'unauthenticated' });

    const revoked = await app.inject({
      method: 'GET',
      url: '/mcp',
      headers: { authorization: 'Bearer sk_live_revoked' },
    });
    expect(revoked.statusCode).toBe(401);
  });

  it('answers DELETE the same way: a stateless server has no session to end', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/mcp', headers: auth });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe('POST');
  });
});

describe('POST /v1/auth/login', () => {
  const USER = { id: 'user-1', email: 'ann@x.test', name: 'Ann' };
  const login = (opts: { remoteAddress?: string; headers?: Record<string, string> } = {}) =>
    app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'ann@x.test', password: 'hunter2' },
      ...opts,
    });

  beforeEach(() => {
    vi.mocked(core.loginWithPassword).mockResolvedValue({ ok: true, user: USER });
    vi.mocked(core.createSession).mockResolvedValue({
      token: 'tok',
      id: 'session-1',
      userId: USER.id,
      activeWorkspaceId: WS,
      expiresAt: new Date('2026-11-01T00:00:00.000Z'),
    });
    vi.mocked(core.buildUserView).mockResolvedValue({ ...USER, memberships: [] });
  });

  it('signs in and sets the session cookie', async () => {
    const res = await login();
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['set-cookie'])).toContain('mg_sid=tok');
  });

  it('401s on wrong credentials, as before', async () => {
    vi.mocked(core.loginWithPassword).mockResolvedValue({
      ok: false,
      reason: 'invalid_credentials',
    });
    const res = await login();
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid credentials' });
    expect(res.headers['retry-after']).toBeUndefined();
  });

  it('429s with Retry-After and the { error } shape when rate-limited; no session is made', async () => {
    vi.mocked(core.loginWithPassword).mockResolvedValue({
      ok: false,
      reason: 'rate_limited',
      retryAfterSeconds: 412,
    });
    const res = await login();
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('412');
    expect(res.json()).toEqual({ error: 'too many attempts, try again later' });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(core.createSession).not.toHaveBeenCalled();
  });

  it('never reaches core with a malformed body, so it cannot use up attempts', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 1 } });
    expect(res.statusCode).toBe(400);
    expect(core.loginWithPassword).not.toHaveBeenCalled();
  });

  describe('the client address handed to core', () => {
    const ipSeenByCore = () => vi.mocked(core.loginWithPassword).mock.calls[0]![2];

    it('is the forwarded client, not the proxy, when the peer is the reverse proxy', async () => {
      // What production looks like: Caddy → 127.0.0.1:8990 → the container sees the Docker gateway.
      await login({
        remoteAddress: '172.18.0.1',
        headers: { 'x-forwarded-for': '203.0.113.9' },
      });
      expect(ipSeenByCore()).toBe('203.0.113.9');
    });

    it('is the address the proxy vouches for, not one the client prepended', async () => {
      await login({
        remoteAddress: '172.18.0.1',
        headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' },
      });
      expect(ipSeenByCore()).toBe('203.0.113.9');
    });

    it('ignores the header from a peer that is not a trusted proxy', async () => {
      await login({
        remoteAddress: '198.51.100.20',
        headers: { 'x-forwarded-for': '1.2.3.4' },
      });
      expect(ipSeenByCore()).toBe('198.51.100.20');
    });

    it('is the socket peer when nothing was forwarded', async () => {
      await login({ remoteAddress: '127.0.0.1' });
      expect(ipSeenByCore()).toBe('127.0.0.1');
    });
  });
});

describe('trustProxySetting', () => {
  it('by default trusts only loopback, link-local and private peers', () => {
    expect(trustProxySetting(undefined)).toEqual(['loopback', 'linklocal', 'uniquelocal']);
    expect(trustProxySetting('  ')).toEqual(['loopback', 'linklocal', 'uniquelocal']);
  });

  it('takes true, false, or a comma-separated list from TRUST_PROXY', () => {
    expect(trustProxySetting('true')).toBe(true);
    expect(trustProxySetting('false')).toBe(false);
    expect(trustProxySetting('loopback, 173.245.48.0/20 ,10.0.0.1')).toEqual([
      'loopback',
      '173.245.48.0/20',
      '10.0.0.1',
    ]);
  });
});

describe('POST /v1/auth/password', () => {
  const session = { cookie: 'mg_sid=good', origin: 'http://localhost:8990' };
  const change = (headers: Record<string, string> = session, remoteAddress = '172.18.0.1') =>
    app.inject({
      method: 'POST',
      url: '/v1/auth/password',
      headers: { 'x-forwarded-for': '203.0.113.9', ...headers },
      remoteAddress,
      payload: { currentPassword: 'old-password-123', newPassword: 'a-brand-new-password' },
    });

  beforeEach(() => {
    vi.mocked(core.authenticateSession).mockImplementation(async (token) =>
      token === 'good' ? { workspaceId: WS, userId: 'user-1', sessionId: 'session-1' } : null,
    );
  });

  it('hands core the user, the session and the real client address', async () => {
    vi.mocked(core.changePasswordWithLimit).mockResolvedValue({
      ok: true,
      token: 'rotated',
      expiresAt: new Date('2026-11-01T00:00:00.000Z'),
    });
    const res = await change();
    expect(res.statusCode).toBe(200);
    expect(core.changePasswordWithLimit).toHaveBeenCalledWith(
      'user-1',
      'session-1',
      'old-password-123',
      'a-brand-new-password',
      '203.0.113.9',
    );
    expect(String(res.headers['set-cookie'])).toContain('mg_sid=rotated');
  });

  it('429s with Retry-After when rate-limited, and leaves the session cookie alone', async () => {
    vi.mocked(core.changePasswordWithLimit).mockResolvedValue({
      ok: false,
      reason: 'rate_limited',
      retryAfterSeconds: 60,
    });
    const res = await change();
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('60');
    expect(res.json()).toEqual({ error: 'too many attempts, try again later' });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('still 422s on a wrong current password', async () => {
    vi.mocked(core.changePasswordWithLimit).mockResolvedValue({
      ok: false,
      reason: 'invalid_current_password',
    });
    const res = await change();
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'current password is incorrect' });
  });

  it("refuses an API key before core is asked — a key cannot use up a user's attempts", async () => {
    const res = await change(auth);
    expect(res.statusCode).toBe(401);
    expect(core.changePasswordWithLimit).not.toHaveBeenCalled();
  });
});

describe('GET /v1/providers', () => {
  afterEach(() => vi.unstubAllEnvs());
  const identifiers = async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/providers', headers: auth });
    expect(res.statusCode).toBe(200);
    return (res.json() as { providers: Array<{ identifier: string }> }).providers.map(
      (p) => p.identifier,
    );
  };

  it('offers the fakes outside production, where dev and CI connect through them', async () => {
    expect(await identifiers()).toContain('fake');
  });

  it('offers no test-only provider in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect((await identifiers()).filter((id) => id.startsWith('fake'))).toEqual([]);
  });

  it('offers them in production again with SHOW_FAKE_PROVIDERS=true', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SHOW_FAKE_PROVIDERS', 'true');
    expect(await identifiers()).toContain('fake');
  });
});

describe('POST /v1/posts/:id/retry', () => {
  const retry = () => app.inject({ method: 'POST', url: `/v1/posts/${POST}/retry`, headers: auth });

  it('returns the re-scheduled post', async () => {
    vi.mocked(core.retryPost).mockResolvedValue({ id: POST, status: 'scheduled' } as never);
    const res = await retry();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ post: { id: POST, status: 'scheduled' } });
    expect(core.retryPost).toHaveBeenCalledWith(WS, POST);
  });

  it('404s for a post the workspace does not have', async () => {
    vi.mocked(core.retryPost).mockResolvedValue(null);
    expect((await retry()).statusCode).toBe(404);
  });

  it('409s — the edit/cancel invalid-state error — when the post is not failed', async () => {
    vi.mocked(core.retryPost).mockRejectedValue(
      new core.PostStateError("a 'published' post cannot be retried"),
    );
    const res = await retry();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "a 'published' post cannot be retried" });
  });

  it('401s without a key and never reaches core', async () => {
    const res = await app.inject({ method: 'POST', url: `/v1/posts/${POST}/retry` });
    expect(res.statusCode).toBe(401);
    expect(core.retryPost).not.toHaveBeenCalled();
  });
});

describe('POST /v1/posts/validate', () => {
  it('hands core the raw body and returns its verdict with 200, valid or not', async () => {
    const verdict = {
      valid: false,
      issues: [{ connectionId: CONN, code: 'connection_not_found', message: 'nope' }],
    };
    vi.mocked(core.validatePost).mockResolvedValue(verdict as never);
    const body = { caption: 'hi', variants: [{ connectionId: CONN, provider: 'fake' }] };
    const res = await app.inject({
      method: 'POST',
      url: '/v1/posts/validate',
      headers: auth,
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(verdict);
    expect(core.validatePost).toHaveBeenCalledWith(WS, body);
    expect(core.createPost).not.toHaveBeenCalled();
  });

  it("does not pre-reject a body that fails the contract: reporting that is core's job", async () => {
    vi.mocked(core.validatePost).mockResolvedValue({ valid: false, issues: [] });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/posts/validate',
      headers: auth,
      payload: { nonsense: true },
    });
    expect(res.statusCode).toBe(200);
    expect(core.validatePost).toHaveBeenCalledWith(WS, { nonsense: true });
  });

  it('is not swallowed by the parametric /v1/posts/:id routes', async () => {
    vi.mocked(core.validatePost).mockResolvedValue({ valid: true, issues: [] });
    await app.inject({ method: 'POST', url: '/v1/posts/validate', headers: auth, payload: {} });
    expect(core.validatePost).toHaveBeenCalledTimes(1);
    expect(core.retryPost).not.toHaveBeenCalled();
  });
});

describe('POST /v1/posts with a connection outside the workspace', () => {
  it('404s with the connection-not-found message and nothing about where the id lives', async () => {
    vi.mocked(core.createPost).mockRejectedValue(
      new core.ConnectionNotFoundError(`connection ${CONN} not found`),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/posts',
      headers: auth,
      payload: { caption: 'x', variants: [{ connectionId: CONN, provider: 'fake' }] },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: `connection ${CONN} not found` });
  });
});

describe('connection health', () => {
  const report = { connectionId: CONN, status: 'healthy', source: 'stored' };

  it('GET /v1/connections/health lists every account, and is not read as an id', async () => {
    vi.mocked(core.listConnectionHealth).mockResolvedValue([report] as never);
    const res = await app.inject({ method: 'GET', url: '/v1/connections/health', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ connections: [report] });
    expect(core.listConnectionHealth).toHaveBeenCalledWith(WS);
    expect(core.getConnectionHealth).not.toHaveBeenCalled();
  });

  it('GET /v1/connections/:id/health returns one, or 404', async () => {
    vi.mocked(core.getConnectionHealth).mockResolvedValueOnce(report as never);
    const url = `/v1/connections/${CONN}/health`;
    const found = await app.inject({ method: 'GET', url, headers: auth });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toEqual({ health: report });
    expect(core.getConnectionHealth).toHaveBeenCalledWith(WS, CONN);

    vi.mocked(core.getConnectionHealth).mockResolvedValueOnce(null);
    const missing = await app.inject({ method: 'GET', url, headers: auth });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'not found' });
  });
});

describe('GET /v1/queues/:id/slots', () => {
  const view = { queueId: QUEUE, timezone: 'Asia/Kolkata', slots: [] };
  const slots = (query = '') =>
    app.inject({ method: 'GET', url: `/v1/queues/${QUEUE}/slots${query}`, headers: auth });

  it('defaults to 5 and passes an explicit count through', async () => {
    vi.mocked(core.previewQueueSlots).mockResolvedValue(view);
    const res = await slots();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(view);
    expect(core.previewQueueSlots).toHaveBeenLastCalledWith(WS, QUEUE, 5);
    await slots('?count=50');
    expect(core.previewQueueSlots).toHaveBeenLastCalledWith(WS, QUEUE, 50);
  });

  it.each(['0', '51', 'abc'])('400s on count=%s without calling core', async (count) => {
    expect((await slots(`?count=${count}`)).statusCode).toBe(400);
    expect(core.previewQueueSlots).not.toHaveBeenCalled();
  });

  it('an inactive queue is the existing invalid-request 400; an unknown one is 404', async () => {
    vi.mocked(core.previewQueueSlots).mockRejectedValueOnce(
      new core.QueueInactiveError(`queue ${QUEUE} is not active`),
    );
    const inactive = await slots();
    expect(inactive.statusCode).toBe(400);
    expect(inactive.json()).toEqual({ error: `queue ${QUEUE} is not active` });

    vi.mocked(core.previewQueueSlots).mockRejectedValueOnce(
      new core.QueueNotFoundError(`queue ${QUEUE} not found`),
    );
    expect((await slots()).statusCode).toBe(404);
  });
});

/**
 * The client-invite connect path. Nobody here has a session or an API key: every request below is
 * sent without credentials, and the flow's proof cookie is the only thing that opens the picker.
 */
describe('invite connect path (public)', () => {
  const FLOW = '44444444-4444-4444-8444-444444444444';
  const OTHER_FLOW = '55555555-5555-4555-8555-555555555555';
  const ORIGIN = 'http://localhost:8990'; // appUrl()'s default
  const accounts = [
    { externalId: 'page-1', displayName: 'Page One' },
    { externalId: 'page-2', displayName: 'Page Two' },
  ];
  let proof: string;
  let cookie: string;
  let previousKey: string | undefined;
  let previousAppUrl: string | undefined;

  beforeAll(() => {
    previousKey = process.env.TOKEN_ENCRYPTION_KEY;
    previousAppUrl = process.env.APP_URL;
    process.env.TOKEN_ENCRYPTION_KEY = 'unit-test-key';
    delete process.env.APP_URL;
    proof = core.signConnectFlow(FLOW);
    cookie = `${inviteFlowCookie(FLOW)}=${proof}`;
  });
  afterAll(() => {
    if (previousKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = previousKey;
    if (previousAppUrl !== undefined) process.env.APP_URL = previousAppUrl;
  });

  describe('POST /v1/invite/:token/start', () => {
    it('hands the starting browser the flow proof as an HttpOnly, Lax cookie', async () => {
      vi.mocked(core.startInviteConnect).mockResolvedValue({
        url: 'https://platform.test/dialog',
        flowId: FLOW,
        proof,
      });
      const res = await app.inject({ method: 'POST', url: '/v1/invite/tok123/start' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ url: 'https://platform.test/dialog' });
      expect(core.startInviteConnect).toHaveBeenCalledWith('tok123', ORIGIN);
      const set = String(res.headers['set-cookie']);
      expect(set).toContain(`${inviteFlowCookie(FLOW)}=${proof}`);
      expect(set).toContain('HttpOnly');
      expect(set).toContain('SameSite=Lax');
      expect(set).toContain('Max-Age=2400');
      // The proof is for the cookie jar only; the page's script never sees it.
      expect(res.body).not.toContain(proof);
    });

    it('404s for a dead invite and sets no cookie', async () => {
      vi.mocked(core.startInviteConnect).mockResolvedValue(null);
      const res = await app.inject({ method: 'POST', url: '/v1/invite/nope/start' });
      expect(res.statusCode).toBe(404);
      expect(res.headers['set-cookie']).toBeUndefined();
    });
  });

  describe('GET /connect/callback', () => {
    const callback = (headers: Record<string, string> = {}) =>
      app.inject({ method: 'GET', url: `/connect/callback?state=${FLOW}&code=c0de`, headers });

    it('sends the invite browser on to the picker when an account has to be chosen', async () => {
      vi.mocked(core.handleCallback).mockResolvedValue({
        status: 'choose_account',
        flowId: FLOW,
        accounts,
      });
      const res = await callback({ cookie });
      expect(core.handleCallback).toHaveBeenCalledWith(FLOW, 'c0de');
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`${ORIGIN}/i/finish/${FLOW}`);
    });

    it('still answers the dashboard popup with the hand-off page (no proof cookie)', async () => {
      vi.mocked(core.handleCallback).mockResolvedValue({
        status: 'choose_account',
        flowId: FLOW,
        accounts,
      });
      const res = await callback();
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('window.opener.postMessage');
      expect(res.body).toContain('Not connected yet');
      expect(res.body).not.toContain('Connected. You can close this window.');
    });

    it("does not redirect on another flow's proof", async () => {
      vi.mocked(core.handleCallback).mockResolvedValue({
        status: 'choose_account',
        flowId: FLOW,
        accounts,
      });
      const res = await callback({
        cookie: `${inviteFlowCookie(FLOW)}=${core.signConnectFlow(OTHER_FLOW)}`,
      });
      expect(res.statusCode).toBe(200);
    });

    it('a single-step provider connects on the callback and says so truthfully', async () => {
      vi.mocked(core.handleCallback).mockResolvedValue({ status: 'connected', connectionId: CONN });
      const res = await callback({ cookie });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('<h1 id="t">Connected</h1>');
    });

    it('reports a failed exchange as not connected, with the reason', async () => {
      vi.mocked(core.handleCallback).mockRejectedValue(new Error('connect flow expired'));
      const res = await callback({ cookie });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('<h1 id="t">Not connected</h1>');
      expect(res.body).toContain('Connecting failed: connect flow expired.');
    });

    it('a declined consent is a failure, and the page never echoes the query text', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/connect/callback?state=${FLOW}&error=access_denied&error_description=CALL-0000`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('access was not approved');
      expect(res.body).not.toContain('CALL-0000');
      expect(core.handleCallback).not.toHaveBeenCalled();
    });
  });

  describe('GET /v1/invite/flow/:flowId', () => {
    const view = {
      workspaceName: 'Ecolive',
      provider: 'fake_2step' as const,
      providerDisplayName: 'Fake Two-Step Provider',
      accounts,
    };

    it('returns the picker for the flow, passing the cookie of that flow to core', async () => {
      vi.mocked(core.getInviteFlow).mockResolvedValue({ status: 'choose_account', ...view });
      const res = await app.inject({
        method: 'GET',
        url: `/v1/invite/flow/${FLOW}`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(view);
      expect(core.getInviteFlow).toHaveBeenCalledWith(FLOW, proof);
    });

    it("never offers one flow's proof for another flow", async () => {
      vi.mocked(core.getInviteFlow).mockResolvedValue({ status: 'not_found' });
      const res = await app.inject({
        method: 'GET',
        url: `/v1/invite/flow/${OTHER_FLOW}`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(404);
      expect(core.getInviteFlow).toHaveBeenCalledWith(OTHER_FLOW, undefined);
    });

    it.each([
      ['not_found', 404],
      ['used', 409],
      ['expired', 410],
    ] as const)('%s → %i', async (status, code) => {
      vi.mocked(core.getInviteFlow).mockResolvedValue({ status });
      const res = await app.inject({ method: 'GET', url: `/v1/invite/flow/${FLOW}` });
      expect(res.statusCode).toBe(code);
      expect(typeof res.json<{ error: string }>().error).toBe('string');
    });
  });

  describe('POST /v1/invite/flow/:flowId/finish', () => {
    const finish = (
      opts: { payload?: unknown; headers?: Record<string, string>; flowId?: string } = {},
    ) =>
      app.inject({
        method: 'POST',
        url: `/v1/invite/flow/${opts.flowId ?? FLOW}/finish`,
        payload: opts.payload ?? { externalId: 'page-2' },
        headers: opts.headers ?? { cookie, origin: ORIGIN },
      });
    const connected = {
      status: 'connected' as const,
      connectionId: CONN,
      accountName: 'Page Two',
      workspaceName: 'Ecolive',
      providerDisplayName: 'Fake Two-Step Provider',
    };

    it('connects the picked account and reports what joined what', async () => {
      vi.mocked(core.finishInviteConnect).mockResolvedValue(connected);
      const res = await finish();
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({
        connectionId: CONN,
        accountName: 'Page Two',
        workspaceName: 'Ecolive',
        providerDisplayName: 'Fake Two-Step Provider',
      });
      // No workspace anywhere in the request: core takes it from the flow.
      expect(core.finishInviteConnect).toHaveBeenCalledWith(FLOW, proof, 'page-2');
      expect(String(res.headers['set-cookie'])).toContain(`${inviteFlowCookie(FLOW)}=;`);
    });

    it('passes no proof when the browser has none, or only has one for another flow', async () => {
      vi.mocked(core.finishInviteConnect).mockResolvedValue({ status: 'not_found' });
      expect((await finish({ headers: { origin: ORIGIN } })).statusCode).toBe(404);
      expect(core.finishInviteConnect).toHaveBeenLastCalledWith(FLOW, undefined, 'page-2');
      expect((await finish({ flowId: OTHER_FLOW })).statusCode).toBe(404);
      expect(core.finishInviteConnect).toHaveBeenLastCalledWith(OTHER_FLOW, undefined, 'page-2');
    });

    it.each([
      [{ status: 'not_found' }, 404],
      [{ status: 'used' }, 409],
      [{ status: 'expired' }, 410],
      [{ status: 'invalid_account' }, 400],
      [{ status: 'failed', error: 'the platform refused the page' }, 502],
    ] as const)('%o → %i, and the proof cookie is kept', async (result, code) => {
      vi.mocked(core.finishInviteConnect).mockResolvedValue(result);
      const res = await finish();
      expect(res.statusCode).toBe(code);
      expect(typeof res.json<{ error: string }>().error).toBe('string');
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('surfaces the platform reason on a failed connect', async () => {
      vi.mocked(core.finishInviteConnect).mockResolvedValue({
        status: 'failed',
        error: 'the platform refused the page',
      });
      expect((await finish()).json()).toEqual({ error: 'the platform refused the page' });
    });

    it('400s on a missing account without calling core', async () => {
      expect((await finish({ payload: {} })).statusCode).toBe(400);
      expect((await finish({ payload: { externalId: '' } })).statusCode).toBe(400);
      expect(core.finishInviteConnect).not.toHaveBeenCalled();
    });

    it('refuses a cross-origin post', async () => {
      const res = await finish({ headers: { cookie, origin: 'https://evil.example' } });
      expect(res.statusCode).toBe(403);
      expect(core.finishInviteConnect).not.toHaveBeenCalled();
    });
  });

  it('leaves the dashboard finish route behind auth', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connections/finish',
      payload: { flowId: FLOW, externalId: 'page-1' },
      headers: { cookie },
    });
    expect(res.statusCode).toBe(401);
  });
});

/**
 * Minting an invite for a client other than the active one (the Clients page lists them all). The
 * session is never switched; membership is what allows it.
 */
describe('POST /v1/connections/:provider/invite', () => {
  const OTHER_WS = '77777777-7777-4777-8777-777777777777';
  const USER = '88888888-8888-4888-8888-888888888888';
  const ORIGIN = 'http://localhost:8990';
  const session = { cookie: 'mg_sid=good', origin: ORIGIN };
  const mint = (payload: unknown, headers: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: '/v1/connections/fake/invite',
      headers,
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  let previousAppUrl: string | undefined;

  beforeAll(() => {
    previousAppUrl = process.env.APP_URL;
    delete process.env.APP_URL;
  });
  afterAll(() => {
    if (previousAppUrl !== undefined) process.env.APP_URL = previousAppUrl;
  });
  beforeEach(() => {
    vi.mocked(core.authenticateSession).mockImplementation(async (token) =>
      token === 'good'
        ? ({ workspaceId: WS, userId: USER, sessionId: 'session-1' } as never)
        : null,
    );
    vi.mocked(core.createConnectInvite).mockImplementation(async (_ws, provider) => ({
      token: 'tok123',
      provider,
      expiresAt: new Date('2026-11-01T00:00:00.000Z'),
    }));
  });

  it('mints for the active client when no workspace is named, body or no body', async () => {
    for (const payload of [undefined, {}]) {
      const res = await mint(payload, session);
      expect(res.statusCode).toBe(201);
      expect(res.json<{ url: string }>().url).toBe(`${ORIGIN}/i/tok123`);
      expect(core.createConnectInvite).toHaveBeenLastCalledWith(WS, 'fake', USER);
    }
    expect(core.isWorkspaceMember).not.toHaveBeenCalled();
  });

  it('mints for another client the user belongs to', async () => {
    vi.mocked(core.isWorkspaceMember).mockResolvedValue(true);
    const res = await mint({ workspaceId: OTHER_WS }, session);
    expect(res.statusCode).toBe(201);
    expect(core.isWorkspaceMember).toHaveBeenCalledWith(USER, OTHER_WS);
    expect(core.createConnectInvite).toHaveBeenCalledWith(OTHER_WS, 'fake', USER);
  });

  it('refuses a client the user does not belong to', async () => {
    vi.mocked(core.isWorkspaceMember).mockResolvedValue(false);
    const res = await mint({ workspaceId: OTHER_WS }, session);
    expect(res.statusCode).toBe(403);
    expect(core.createConnectInvite).not.toHaveBeenCalled();
  });

  it('an API key cannot reach past its own workspace', async () => {
    const res = await mint({ workspaceId: OTHER_WS }, auth);
    expect(res.statusCode).toBe(403);
    expect(core.isWorkspaceMember).not.toHaveBeenCalled();
    expect(core.createConnectInvite).not.toHaveBeenCalled();
    // Naming its own workspace is the same as naming none.
    expect((await mint({ workspaceId: WS }, auth)).statusCode).toBe(201);
    expect(core.createConnectInvite).toHaveBeenLastCalledWith(WS, 'fake', WS);
  });

  it('400s on a workspace id that is not a uuid, and 401s without credentials', async () => {
    expect((await mint({ workspaceId: 'nope' }, session)).statusCode).toBe(400);
    expect((await mint({ workspaceId: OTHER_WS }, {})).statusCode).toBe(401);
    expect(core.createConnectInvite).not.toHaveBeenCalled();
  });
});
