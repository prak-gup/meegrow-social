import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '@meegrow-social/core';
import type { FastifyInstance } from 'fastify';
import { buildServer, trustProxySetting } from './server.js';

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
