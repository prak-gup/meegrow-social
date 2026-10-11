import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '@meegrow-social/core';
import type { FastifyInstance } from 'fastify';
import { buildServer, inviteFlowCookie } from './server.js';

/**
 * The REST layer for a provider that asks for a site address before it can redirect, and whose
 * callback carries a credential in the query string (WordPress). `core` is replaced by spies, as
 * in server.test.ts: what is under test is the transport — that the secret-bearing callback is
 * answered with a redirect and nothing else, what travels on that redirect, and that the result
 * page cannot be talked into announcing a connection. The flow checks behind the spies are in
 * core's `connections.wordpress.integration.test.ts`.
 */
vi.mock('@meegrow-social/core', async (importOriginal) => ({
  ...(await importOriginal<typeof core>()),
  authenticateApiKey: vi.fn(),
  authenticateSession: vi.fn(),
  recordApiRequestLog: vi.fn(),
  startConnect: vi.fn(),
  startInviteConnect: vi.fn(),
  handleCallback: vi.fn(),
  completeCredentialCallback: vi.fn(),
  getConnectInvite: vi.fn(),
}));

const WS = '11111111-1111-4111-8111-111111111111';
const FLOW = '44444444-4444-4444-8444-444444444444';
const CONN = '33333333-3333-4333-8333-333333333333';
const SECRET = 'abcd EFGH 1234 ijkl MNOP 5678';
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
  vi.mocked(core.recordApiRequestLog).mockResolvedValue(undefined as never);
});

const sealed = (status: string, detail: string): string =>
  new URLSearchParams({
    status,
    detail,
    seal: core.signConnectOutcome(`${status}:${detail}`),
  }).toString();

const wordpressCallback = (extra = '') =>
  `/connect/callback?state=${FLOW}&site_url=${encodeURIComponent('https://blog.example.com')}` +
  `&user_login=priya&password=${encodeURIComponent(SECRET)}${extra}`;

describe('POST /v1/connections/:provider/start', () => {
  const start = (payload?: Record<string, unknown>, headers: Record<string, string> = auth) =>
    app.inject({ method: 'POST', url: '/v1/connections/wordpress/start', payload, headers });

  it('hands the site address to core and binds the flow to this browser', async () => {
    vi.mocked(core.startConnect).mockResolvedValue({
      url: 'https://blog.example.com/wp-admin/authorize-application.php?app_name=x',
      flowId: FLOW,
      proof: 'proof-mac',
    });
    const res = await start({ siteUrl: '  blog.example.com ' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      url: 'https://blog.example.com/wp-admin/authorize-application.php?app_name=x',
    });
    expect(core.startConnect).toHaveBeenCalledWith(WS, 'wordpress', expect.any(String), undefined, {
      siteUrl: 'blog.example.com',
    });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toContain(`${inviteFlowCookie(FLOW)}=proof-mac`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    // The proof and the flow id are not for the page's script to hold.
    expect(res.body).not.toContain('proof-mac');
    expect(res.body).not.toContain(FLOW);
  });

  it('sets no cookie for a provider whose flow is not browser-bound', async () => {
    vi.mocked(core.startConnect).mockResolvedValue({ url: 'https://fake.test/auth', flowId: FLOW });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connections/fake/start',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(core.startConnect).toHaveBeenCalledWith(WS, 'fake', expect.any(String), undefined, {});
  });

  it('answers a refused address with the provider’s own words, as a 400', async () => {
    vi.mocked(core.startConnect).mockRejectedValue(
      new core.ProviderBadRequestError('That address is not a public website.'),
    );
    const res = await start({ siteUrl: 'https://10.0.0.5' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'That address is not a public website.' });
  });

  it.each([{ siteUrl: 42 }, { siteUrl: '' }, { siteUrl: 'x'.repeat(2049) }])(
    'rejects a malformed body before core: %j',
    async (payload) => {
      const res = await start(payload);
      expect(res.statusCode).toBe(400);
      expect(core.startConnect).not.toHaveBeenCalled();
    },
  );

  it('requires a session or key, and a known provider', async () => {
    expect((await start({ siteUrl: 'blog.example.com' }, {})).statusCode).toBe(401);
    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/connections/myspace/start',
      headers: auth,
    });
    expect(unknown.statusCode).toBe(400);
    expect(core.startConnect).not.toHaveBeenCalled();
  });
});

describe('GET /v1/connections/:provider/auth-url', () => {
  it('is a 400, not a 500, for a provider that needs an address first', async () => {
    vi.mocked(core.startConnect).mockRejectedValue(
      new core.ProviderBadRequestError('Enter the address of the WordPress site.'),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/v1/connections/wordpress/auth-url',
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Enter the address of the WordPress site.' });
  });
});

describe('POST /v1/invite/:token/start', () => {
  it('passes the client’s site address through, with no session', async () => {
    vi.mocked(core.startInviteConnect).mockResolvedValue({
      url: 'https://blog.example.com/wp-admin/authorize-application.php',
      flowId: FLOW,
      proof: 'proof-mac',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/invite/tok123/start',
      payload: { siteUrl: 'blog.example.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(core.startInviteConnect).toHaveBeenCalledWith('tok123', expect.any(String), {
      siteUrl: 'blog.example.com',
    });
    expect(String(res.headers['set-cookie'])).toContain(`${inviteFlowCookie(FLOW)}=proof-mac`);
  });

  it('answers a refused address as a 400 with the provider’s words', async () => {
    vi.mocked(core.startInviteConnect).mockRejectedValue(
      new core.ProviderBadRequestError('The address must start with https://.'),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/invite/tok123/start',
      payload: { siteUrl: 'http://blog.example.com' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'The address must start with https://.' });
  });
});

describe('GET /connect/callback carrying a credential', () => {
  beforeEach(() => {
    vi.mocked(core.completeCredentialCallback).mockResolvedValue(sealed('connected', CONN));
  });

  it('is answered with a redirect that carries none of the callback', async () => {
    const res = await app.inject({
      method: 'GET',
      url: wordpressCallback(),
      headers: { cookie: `${inviteFlowCookie(FLOW)}=proof-mac` },
    });
    expect(res.statusCode).toBe(303);
    const location = String(res.headers.location);
    expect(location.startsWith('https://social.meegrowlabs.com/connect/done?')).toBe(true);
    expect([...new URL(location).searchParams.keys()].sort()).toEqual(['detail', 'seal', 'status']);
    for (const leaked of ['abcd', 'EFGH', 'priya', 'blog.example.com', 'password', 'user_login']) {
      expect(location).not.toContain(leaked);
      expect(res.body).not.toContain(leaked);
    }
    // No page is rendered at the secret-bearing URL, and nothing may keep or forward it.
    expect(res.body).toBe('');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('gives core the query and this browser’s proof, then drops the proof cookie', async () => {
    const res = await app.inject({
      method: 'GET',
      url: wordpressCallback(),
      headers: { cookie: `${inviteFlowCookie(FLOW)}=proof-mac` },
    });
    expect(core.completeCredentialCallback).toHaveBeenCalledWith(
      {
        state: FLOW,
        site_url: 'https://blog.example.com',
        user_login: 'priya',
        password: SECRET,
      },
      'proof-mac',
    );
    expect(core.handleCallback).not.toHaveBeenCalled();
    expect(String(res.headers['set-cookie'])).toMatch(
      new RegExp(`^${inviteFlowCookie(FLOW)}=;.*(Max-Age=0|Expires=Thu, 01 Jan 1970)`),
    );
  });

  it('passes no proof when this browser holds none — core decides what that means', async () => {
    await app.inject({ method: 'GET', url: wordpressCallback() });
    expect(vi.mocked(core.completeCredentialCallback).mock.calls[0]![1]).toBeUndefined();
  });

  it('never uses another flow’s cookie as this flow’s proof', async () => {
    const other = '55555555-5555-4555-8555-555555555555';
    await app.inject({
      method: 'GET',
      url: wordpressCallback(),
      headers: { cookie: `${inviteFlowCookie(other)}=someone-elses-proof` },
    });
    expect(vi.mocked(core.completeCredentialCallback).mock.calls[0]![1]).toBeUndefined();
  });

  it('drops a parameter sent twice instead of choosing one', async () => {
    await app.inject({ method: 'GET', url: wordpressCallback('&site_url=https://evil.test') });
    const [query] = vi.mocked(core.completeCredentialCallback).mock.calls[0]!;
    expect(query.site_url).toBeUndefined();
    expect(query.password).toBe(SECRET);
  });

  it('still redirects when there is no state at all', async () => {
    vi.mocked(core.completeCredentialCallback).mockResolvedValue(sealed('error', 'invalid_state'));
    const res = await app.inject({
      method: 'GET',
      url: `/connect/callback?user_login=priya&password=${encodeURIComponent(SECRET)}`,
    });
    expect(res.statusCode).toBe(303);
    expect(res.body).toBe('');
    expect(String(res.headers.location)).not.toContain('abcd');
  });

  it('is not written to the request log, even when the browser is logged in', async () => {
    vi.mocked(core.authenticateSession).mockResolvedValue({
      workspaceId: WS,
      userId: 'user-1',
      sessionId: 'sess-1',
    } as never);
    await app.inject({
      method: 'GET',
      url: wordpressCallback(),
      headers: { cookie: `${core.SESSION_COOKIE}=tok` },
    });
    expect(core.recordApiRequestLog).not.toHaveBeenCalled();
  });

  it('leaves an OAuth callback exactly as it was: a page, through handleCallback', async () => {
    vi.mocked(core.handleCallback).mockResolvedValue({ status: 'connected', connectionId: CONN });
    const res = await app.inject({
      method: 'GET',
      url: `/connect/callback?state=${FLOW}&code=abc`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(core.handleCallback).toHaveBeenCalledWith(FLOW, 'abc', undefined);
    expect(core.completeCredentialCallback).not.toHaveBeenCalled();
  });

  it.each([
    ['access_denied', 'access was not approved'],
    ['disabled', 'does not allow application passwords'],
  ])('words a rejection (%s) with a fixed phrase', async (error, phrase) => {
    const res = await app.inject({
      method: 'GET',
      url: `/connect/callback?state=${FLOW}&error=${error}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain(phrase);
    expect(core.handleCallback).not.toHaveBeenCalled();
  });
});

describe('GET /connect/done', () => {
  const done = (query: string) => app.inject({ method: 'GET', url: `/connect/done?${query}` });

  it('shows a sealed success and hands it to the opener', async () => {
    const res = await done(sealed('connected', CONN));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('<h1 id="t">Connected</h1>');
    expect(res.body).toContain(`"connectionId":"${CONN}"`);
    expect(res.body).toContain('window.opener.postMessage');
  });

  it('shows a sealed failure as its fixed sentence', async () => {
    const res = await done(sealed('error', 'site_mismatch'));
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Not connected');
    expect(res.body).toContain('different site than the one being connected');
  });

  it.each([
    ['an unsealed success', `status=connected&detail=${CONN}`],
    ['a made-up seal', `status=connected&detail=${CONN}&seal=AAAA`],
    [
      'a failure’s seal on a success',
      sealed('error', 'failed').replace('status=error', 'status=connected'),
    ],
    ['a real seal with another connection', sealed('connected', CONN).replace(CONN, WS)],
    ['nothing', ''],
  ])('never announces a connection for %s', async (_name, query) => {
    const res = await done(query);
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('<h1 id="t">Connected</h1>');
    expect(res.body).toContain('Not connected');
    expect(res.body).not.toContain('"status":"connected"');
  });

  it('cannot be made to say words from the link', async () => {
    const hostile = encodeURIComponent('<script>alert(1)</script> call 555-0100');
    const res = await done(`status=error&detail=${hostile}&seal=x`);
    expect(res.body).not.toContain('555-0100');
    expect(res.body).not.toContain('<script>alert(1)');
    // Even a correctly sealed unknown code only ever selects the generic sentence.
    const odd = await done(sealed('error', 'call 555-0100'));
    expect(odd.body).not.toContain('555-0100');
  });

  it('needs no login: the person approving may be a client with none', async () => {
    expect((await done(sealed('connected', CONN))).statusCode).toBe(200);
    expect(core.authenticateSession).not.toHaveBeenCalled();
  });
});

describe('request log', () => {
  it('never records a query string, even for a path no route matches', async () => {
    await app.inject({
      method: 'GET',
      url: `/v1/no-such-route?password=${encodeURIComponent(SECRET)}&token=t0p`,
      headers: auth,
    });
    await new Promise((r) => setImmediate(r));
    const logged = vi.mocked(core.recordApiRequestLog).mock.calls.map(([entry]) => entry.route);
    expect(logged.length).toBeGreaterThan(0);
    for (const route of logged) {
      expect(route).not.toContain('?');
      expect(route).not.toContain('abcd');
      expect(route).not.toContain('t0p');
    }
  });
});

describe('GET /v1/providers', () => {
  it('says which providers start with a question', async () => {
    const spy = vi.spyOn(core, 'listConnectableProviders').mockReturnValue([
      {
        identifier: 'wordpress',
        displayName: 'WordPress',
        isBetweenSteps: false,
        connectInput: 'site_url',
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
        },
        { identifier: 'fake', displayName: 'Fake', isBetweenSteps: false },
      ],
    });
  });
});
