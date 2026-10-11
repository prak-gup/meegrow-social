import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '@meegrow-social/core';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './server.js';

/**
 * The REST layer for connecting a WordPress site with a username and LOGIN password. `core` is
 * replaced by spies, as in wordpress-connect.test.ts: what is under test is the transport — that
 * the password goes into core and comes out of nothing: not a response, not an error (including
 * Fastify's own, for a body it could not parse), not the request log. The checks behind the spies
 * (the sealed endpoint, the attempt limits, the encryption) are in core's
 * `connections.password.test.ts`.
 */
vi.mock('@meegrow-social/core', async (importOriginal) => ({
  ...(await importOriginal<typeof core>()),
  authenticateApiKey: vi.fn(),
  authenticateSession: vi.fn(),
  recordApiRequestLog: vi.fn(),
  checkConnectSite: vi.fn(),
  connectWithPassword: vi.fn(),
}));

const WS = '11111111-1111-4111-8111-111111111111';
const CONN = '33333333-3333-4333-8333-333333333333';
const ENDPOINT = 'https://blog.example.com/xmlrpc.php';
const USERNAME = 'priya.editor';
/** Distinctive, and full of what JSON and HTML treat specially. */
const PASSWORD = 'Tr0ub4dor&3 <correct> "horse"';
const TICKET = 'eyJ0aWNrZXQiOnRydWV9.c2VhbA';
const auth = { authorization: 'Bearer sk_live_good' };

process.env.TOKEN_ENCRYPTION_KEY ??= 'unit-test-key';

let app: FastifyInstance;
let previous: Record<string, string | undefined>;

beforeAll(async () => {
  previous = { driver: process.env.MEDIA_STORAGE_DRIVER, appUrl: process.env.APP_URL };
  process.env.MEDIA_STORAGE_DRIVER = 's3';
  process.env.APP_URL = 'https://social.meegrowlabs.com';
  app = await buildServer();
});
afterAll(async () => {
  await app.close();
  for (const [name, env] of [
    ['driver', 'MEDIA_STORAGE_DRIVER'],
    ['appUrl', 'APP_URL'],
  ] as const) {
    if (previous[name] === undefined) delete process.env[env];
    else process.env[env] = previous[name];
  }
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(core.authenticateApiKey).mockImplementation(async (key) =>
    key === 'sk_live_good' ? { workspaceId: WS, apiKeyId: 'key-1' } : null,
  );
  vi.mocked(core.authenticateSession).mockImplementation(async (token) =>
    token === 'sess-good'
      ? ({ workspaceId: WS, userId: 'user-1', sessionId: 'sess-1' } as never)
      : null,
  );
  vi.mocked(core.recordApiRequestLog).mockResolvedValue(undefined as never);
});

const CONNECTED = {
  ok: true as const,
  connectionId: CONN,
  displayName: 'Ecolive & Co',
  externalId: 'https://blog.example.com',
  endpoint: ENDPOINT,
};

const submit = (
  payload: unknown = { ticket: TICKET, username: USERNAME, password: PASSWORD },
  headers: Record<string, string> = auth,
) =>
  app.inject({
    method: 'POST',
    url: '/v1/connections/wordpress/password',
    payload: payload as never,
    headers,
  });

/** Nothing the API sends back may carry the password, in any encoding a body would use. */
function expectNoPassword(text: string): void {
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toContain('Tr0ub4dor');
  expect(text).not.toContain(JSON.stringify(PASSWORD).slice(1, -1));
}

describe('POST /v1/connections/:provider/site-check', () => {
  const check = (payload?: Record<string, unknown>, headers: Record<string, string> = auth) =>
    app.inject({ method: 'POST', url: '/v1/connections/wordpress/site-check', payload, headers });

  const REPORT = {
    entered: 'https://blog.example.com',
    name: 'Ecolive & Co',
    siteAddress: 'https://blog.example.com',
    homeAddress: 'https://blog.example.com',
    separateAddresses: false,
    approval: {
      available: false as const,
      reason: 'application_passwords_unavailable',
      message: 'Application Passwords are not available on this site.',
    },
    password: { available: true as const, endpoint: ENDPOINT },
    ticket: TICKET,
  };

  it('asks core about the address for the caller’s client and passes the answer on', async () => {
    vi.mocked(core.checkConnectSite).mockResolvedValue(REPORT);
    const res = await check({ siteUrl: '  blog.example.com ' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(REPORT);
    expect(core.checkConnectSite).toHaveBeenCalledWith(WS, 'wordpress', 'blog.example.com');
  });

  it('answers an address that cannot be contacted with the provider’s words, as a 400', async () => {
    vi.mocked(core.checkConnectSite).mockRejectedValue(
      new core.ProviderBadRequestError('That address is not a public website.'),
    );
    const res = await check({ siteUrl: 'https://10.0.0.5' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'That address is not a public website.' });
  });

  it.each([{}, { siteUrl: 42 }, { siteUrl: '' }, { siteUrl: 'x'.repeat(2049) }])(
    'rejects a malformed body before core: %j',
    async (payload) => {
      expect((await check(payload)).statusCode).toBe(400);
      expect(core.checkConnectSite).not.toHaveBeenCalled();
    },
  );

  it('requires a session or key, and a known provider', async () => {
    expect((await check({ siteUrl: 'blog.example.com' }, {})).statusCode).toBe(401);
    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/connections/myspace/site-check',
      payload: { siteUrl: 'blog.example.com' },
      headers: auth,
    });
    expect(unknown.statusCode).toBe(400);
    expect(core.checkConnectSite).not.toHaveBeenCalled();
  });
});

describe('POST /v1/connections/:provider/password', () => {
  it('hands the login to core for the caller’s client and answers with the connection only', async () => {
    vi.mocked(core.connectWithPassword).mockResolvedValue(CONNECTED);
    const res = await submit();
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      connectionId: CONN,
      displayName: 'Ecolive & Co',
      externalId: 'https://blog.example.com',
      endpoint: ENDPOINT,
    });
    expect(res.headers['cache-control']).toBe('no-store');
    expectNoPassword(res.body);
    expect(res.body).not.toContain(USERNAME);
    expect(res.body).not.toContain(TICKET);
    expect(JSON.stringify(res.headers)).not.toContain('Tr0ub4dor');

    expect(core.connectWithPassword).toHaveBeenCalledTimes(1);
    const [workspaceId, provider, input, caller] = vi.mocked(core.connectWithPassword).mock
      .calls[0]!;
    expect(workspaceId).toBe(WS);
    expect(provider).toBe('wordpress');
    // The password reaches core exactly as typed: not trimmed, not altered.
    expect(input).toEqual({ ticket: TICKET, username: USERNAME, password: PASSWORD });
    // An API key has no user: its client is who is counted.
    expect(caller).toEqual({ ip: '127.0.0.1', actor: `workspace:${WS}` });
  });

  it('counts a signed-in person by their user, and keeps a password’s own spaces', async () => {
    vi.mocked(core.connectWithPassword).mockResolvedValue(CONNECTED);
    await submit(
      { ticket: TICKET, username: `  ${USERNAME} `, password: '  spaces matter  ' },
      { cookie: `${core.SESSION_COOKIE}=sess-good` },
    );
    const [, , input, caller] = vi.mocked(core.connectWithPassword).mock.calls[0]!;
    expect(input).toMatchObject({ username: USERNAME, password: '  spaces matter  ' });
    expect(caller.actor).toBe('user-1');
  });

  it('takes the client from the session or key — nothing in the body can name another', async () => {
    vi.mocked(core.connectWithPassword).mockResolvedValue(CONNECTED);
    await submit({
      ticket: TICKET,
      username: USERNAME,
      password: PASSWORD,
      workspaceId: '99999999-9999-4999-8999-999999999999',
      endpoint: 'https://victim.example.org/xmlrpc.php',
    });
    const [workspaceId, , input] = vi.mocked(core.connectWithPassword).mock.calls[0]!;
    expect(workspaceId).toBe(WS);
    expect(Object.keys(input).sort()).toEqual(['password', 'ticket', 'username']);
  });

  it.each([
    ['login_rejected', 422, 'The site did not accept that username and password.'],
    ['role_cannot_publish', 422, /cannot publish posts/],
    ['check_expired', 409, /check the site again/],
    ['xmlrpc_disabled', 400, /XML-RPC is switched off on this site/],
    ['xmlrpc_blocked', 400, /firewall or security plugin/],
    ['xmlrpc_not_found', 400, /No xmlrpc\.php was found/],
    ['site_unreachable', 502, /could not be reached/],
    ['unavailable', 400, /does not offer this kind of connection/],
    ['failed', 400, 'The connection could not be completed.'],
  ] as const)('answers %s as %i with its fixed sentence', async (reason, status, message) => {
    vi.mocked(core.connectWithPassword).mockResolvedValue({
      ok: false,
      reason,
      message: core.connectFailureMessage(reason),
    });
    const res = await submit();
    expect(res.statusCode).toBe(status);
    const body = res.json<{ error: string; code: string }>();
    expect(body.code).toBe(reason);
    if (typeof message === 'string') expect(body.error).toBe(message);
    else expect(body.error).toMatch(message);
    expectNoPassword(res.body);
    expect(res.body).not.toContain(USERNAME);
  });

  it('answers too many attempts as 429 with when to try again', async () => {
    vi.mocked(core.connectWithPassword).mockResolvedValue({
      ok: false,
      reason: 'rate_limited',
      retryAfterSeconds: 1790,
    });
    const res = await submit();
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('1790');
    expect(res.json()).toEqual({
      error: 'Too many login attempts for this site from here. Try again in 30 minutes.',
      code: 'rate_limited',
    });
  });

  describe('a body that fails validation', () => {
    it.each([
      [
        'a password that is not text',
        { ticket: TICKET, username: USERNAME, password: { v: PASSWORD } },
      ],
      [
        'a password that is too long',
        { ticket: TICKET, username: USERNAME, password: PASSWORD.repeat(40) },
      ],
      ['an empty password', { ticket: TICKET, username: USERNAME, password: '' }],
      ['no ticket', { username: USERNAME, password: PASSWORD }],
      [
        'a username that is too long',
        { ticket: TICKET, username: PASSWORD.repeat(10), password: PASSWORD },
      ],
      ['an empty username', { ticket: TICKET, username: '   ', password: PASSWORD }],
      ['the password in the wrong field', { ticket: 7, username: [PASSWORD], password: PASSWORD }],
      ['a body that is an array', [PASSWORD]],
    ])('answers %s with one fixed sentence that quotes nothing', async (_name, payload) => {
      const res = await submit(payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'enter the username and password' });
      expect(core.connectWithPassword).not.toHaveBeenCalled();
    });
  });

  it('does not quote a body it could not parse — Fastify’s own error would', async () => {
    const broken = `{"ticket":"${TICKET}","username":"${USERNAME}","password":"Tr0ub4dor&3`;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connections/wordpress/password',
      payload: broken,
      headers: { ...auth, 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'the request could not be read' });
    expectNoPassword(res.body);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(core.connectWithPassword).not.toHaveBeenCalled();
  });

  it('does not quote a body in a content type it does not take', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connections/wordpress/password',
      payload: `password=${encodeURIComponent(PASSWORD)}`,
      headers: { ...auth, 'content-type': 'text/plain' },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expectNoPassword(res.body);
    expect(core.connectWithPassword).not.toHaveBeenCalled();
  });

  it('answers an unexpected failure with a fixed 500, whatever the error says', async () => {
    vi.mocked(core.connectWithPassword).mockRejectedValue(
      new Error(`Failed query: insert into connections … params: ${USERNAME},${PASSWORD}`),
    );
    const res = await submit();
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'the site could not be connected' });
    expectNoPassword(res.body);
    expect(res.body).not.toContain(USERNAME);
  });

  it('writes the route and the status to the request log, and nothing of the body', async () => {
    vi.mocked(core.connectWithPassword).mockResolvedValue({
      ok: false,
      reason: 'login_rejected',
      message: core.connectFailureMessage('login_rejected'),
    });
    await submit();
    await new Promise((r) => setImmediate(r));
    const logged = vi.mocked(core.recordApiRequestLog).mock.calls;
    expect(logged).toHaveLength(1);
    expect(logged[0]![0]).toMatchObject({
      workspaceId: WS,
      route: '/v1/connections/:provider/password',
      status: 422,
    });
    expect(Object.keys(logged[0]![0]).sort()).toEqual([
      'durationMs',
      'route',
      'status',
      'workspaceId',
    ]);
    expectNoPassword(JSON.stringify(logged));
    expect(JSON.stringify(logged)).not.toContain(USERNAME);
  });

  it('prints nothing: no console output on any path through the route', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    const stdout = vi.spyOn(process.stdout, 'write');
    const stderr = vi.spyOn(process.stderr, 'write');
    vi.mocked(core.connectWithPassword).mockResolvedValueOnce(CONNECTED);
    await submit();
    vi.mocked(core.connectWithPassword).mockRejectedValueOnce(new Error(`boom ${PASSWORD}`));
    await submit();
    await submit({ ticket: TICKET, username: USERNAME, password: 42 });
    const printed = JSON.stringify([
      ...spies.flatMap((s) => s.mock.calls),
      ...stdout.mock.calls.map(([chunk]) => String(chunk)),
      ...stderr.mock.calls.map(([chunk]) => String(chunk)),
    ]);
    for (const spy of [...spies, stdout, stderr]) spy.mockRestore();
    expectNoPassword(printed);
  });

  it('requires a session or key, and a known provider', async () => {
    expect((await submit(undefined, {})).statusCode).toBe(401);
    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/connections/myspace/password',
      payload: { ticket: TICKET, username: USERNAME, password: PASSWORD },
      headers: auth,
    });
    expect(unknown.statusCode).toBe(400);
    expectNoPassword(unknown.body);
    expect(core.connectWithPassword).not.toHaveBeenCalled();
  });

  it('refuses a cookie-authenticated request from another origin', async () => {
    const res = await submit(undefined, {
      cookie: `${core.SESSION_COOKIE}=sess-good`,
      origin: 'https://evil.test',
    });
    expect(res.statusCode).toBe(403);
    expect(core.connectWithPassword).not.toHaveBeenCalled();
  });

  it('is not a public route: the invite path has no way to reach it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/invite/tok123/password',
      payload: { ticket: TICKET, username: USERNAME, password: PASSWORD },
    });
    expect(res.statusCode).toBe(404);
    expect(core.connectWithPassword).not.toHaveBeenCalled();
  });
});

describe('GET /v1/providers', () => {
  it('says which providers offer more than one way to connect', async () => {
    const spy = vi.spyOn(core, 'listConnectableProviders').mockReturnValue([
      {
        identifier: 'wordpress',
        displayName: 'WordPress',
        isBetweenSteps: false,
        connectInput: 'site_url',
        connectMethods: ['approval', 'password'],
      },
      { identifier: 'fake', displayName: 'Fake', isBetweenSteps: false },
    ] as never);
    const res = await app.inject({ method: 'GET', url: '/v1/providers', headers: auth });
    spy.mockRestore();
    expect(res.json()).toEqual({
      providers: [
        {
          identifier: 'wordpress',
          displayName: 'WordPress',
          isBetweenSteps: false,
          connectInput: 'site_url',
          connectMethods: ['approval', 'password'],
        },
        { identifier: 'fake', displayName: 'Fake', isBetweenSteps: false },
      ],
    });
  });
});
