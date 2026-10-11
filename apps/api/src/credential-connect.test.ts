import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '@meegrow-social/core';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './server.js';

/**
 * The REST layer for a provider that connects with a pasted credential (Bluesky, Telegram,
 * Discord, Slack). `core` is replaced by spies, as in server.test.ts: what is under test is the
 * transport — who may call it, what reaches core, how each failure is answered, and that no answer
 * ever repeats what was sent. The verify-then-store behind the spy is in core's
 * `credential-connect.*.integration.test.ts` and each provider's unit tests.
 */
vi.mock('@meegrow-social/core', async (importOriginal) => ({
  ...(await importOriginal<typeof core>()),
  authenticateApiKey: vi.fn(),
  authenticateSession: vi.fn(),
  recordApiRequestLog: vi.fn(),
  connectWithCredentials: vi.fn(),
  createConnectInvite: vi.fn(),
  tryGetProvider: vi.fn(),
}));

const WS = '11111111-1111-4111-8111-111111111111';
const CONN = '33333333-3333-4333-8333-333333333333';
const SECRET = '123456789:AAF-secret_bot_token_value_0123456789abc';
const auth = { authorization: 'Bearer sk_live_good' };

process.env.TOKEN_ENCRYPTION_KEY ??= 'unit-test-key';

let app: FastifyInstance;
let previousDriver: string | undefined;

beforeAll(async () => {
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

const connect = (payload?: unknown, headers: Record<string, string> = auth) =>
  app.inject({
    method: 'POST',
    url: '/v1/connections/fake/credentials',
    payload: payload as Record<string, unknown>,
    headers,
  });

const fields = { token: SECRET, chat: '@acme_news' };

describe('POST /v1/connections/:provider/credentials', () => {
  it('hands the fields and the client address to core and answers with safe identifiers only', async () => {
    vi.mocked(core.connectWithCredentials).mockResolvedValue({
      ok: true,
      connectionId: CONN,
      displayName: 'Acme News',
      reconnected: false,
    });
    const res = await connect({ fields });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      connectionId: CONN,
      displayName: 'Acme News',
      reconnected: false,
    });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(core.connectWithCredentials).toHaveBeenCalledWith(
      WS,
      'fake',
      fields,
      expect.any(String),
    );
    expect(res.body).not.toContain(SECRET);
  });

  it('answers a rate-limited attempt with 429 and Retry-After', async () => {
    vi.mocked(core.connectWithCredentials).mockResolvedValue({
      ok: false,
      reason: 'rate_limited',
      retryAfterSeconds: 480,
    });
    const res = await connect({ fields });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('480');
    expect(res.json()).toEqual({ error: 'too many attempts, try again later' });
  });

  it.each([
    [new core.CredentialFormatError('That is not a bot token.'), 400],
    [new core.ProviderBadRequestError('The bot is not an administrator of that channel.'), 400],
    [new core.ProviderAuthError('Telegram did not accept the bot token.'), 422],
    [new core.ProviderTransientError('Telegram could not be reached.'), 503],
  ])('answers %o with its own words and status %i', async (error, status) => {
    vi.mocked(core.connectWithCredentials).mockRejectedValue(error);
    const res = await connect({ fields });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ error: error.message });
  });

  it('never echoes an unexpected error, whose text may hold the credential', async () => {
    vi.mocked(core.connectWithCredentials).mockRejectedValue(
      new Error(`request to https://api.telegram.org/bot${SECRET}/getMe failed`),
    );
    const res = await connect({ fields });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'the connection could not be completed' });
    expect(res.body).not.toContain(SECRET);
  });

  it.each([
    undefined,
    {},
    { fields: 'token' },
    { fields: { token: 42 } },
    { fields: { token: 'x'.repeat(4097) } },
    { fields: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`f${i}`, 'x'])) },
  ])('rejects a malformed body before core: %j', async (payload) => {
    const res = await connect(payload);
    expect(res.statusCode).toBe(400);
    expect(core.connectWithCredentials).not.toHaveBeenCalled();
    expect(res.body).not.toContain('xxxx');
  });

  it('does not quote a body it could not parse — the body is the credential', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connections/fake/credentials',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: `{"fields":{"token":"${SECRET}"`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'the request could not be read' });
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain(SECRET.slice(0, 12));
    expect(core.connectWithCredentials).not.toHaveBeenCalled();
  });

  it('requires a session or key, and a known provider', async () => {
    expect((await connect({ fields }, {})).statusCode).toBe(401);
    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/connections/myspace/credentials',
      payload: { fields },
      headers: auth,
    });
    expect(unknown.statusCode).toBe(400);
    expect(core.connectWithCredentials).not.toHaveBeenCalled();
  });

  it('refuses a cookie-authenticated call from another origin', async () => {
    vi.mocked(core.authenticateSession).mockResolvedValue({
      workspaceId: WS,
      userId: 'user-1',
      sessionId: 'session-1',
    } as never);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connections/fake/credentials',
      payload: { fields },
      headers: { cookie: `${core.SESSION_COOKIE}=abc`, origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(403);
    expect(core.connectWithCredentials).not.toHaveBeenCalled();
  });

  it('records the request by its route pattern, never by anything that was sent', async () => {
    vi.mocked(core.connectWithCredentials).mockResolvedValue({
      ok: true,
      connectionId: CONN,
      displayName: 'Acme News',
      reconnected: true,
    });
    await connect({ fields });
    await vi.waitFor(() => expect(core.recordApiRequestLog).toHaveBeenCalled());
    const logged = JSON.stringify(vi.mocked(core.recordApiRequestLog).mock.calls);
    expect(logged).toContain('/v1/connections/:provider/credentials');
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain('acme_news');
  });
});

describe('POST /v1/connections/:provider/invite for a credential platform', () => {
  it('refuses: a pasted credential is entered in the dashboard only', async () => {
    vi.mocked(core.tryGetProvider).mockReturnValue({ connectInput: 'credentials' } as never);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connections/fake/invite',
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/dashboard/);
    expect(core.createConnectInvite).not.toHaveBeenCalled();
  });

  it('still mints a link for every other platform', async () => {
    vi.mocked(core.tryGetProvider).mockReturnValue({} as never);
    vi.mocked(core.createConnectInvite).mockResolvedValue({
      token: 'tok',
      provider: 'fake',
      expiresAt: new Date('2026-11-01T00:00:00Z'),
    } as never);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connections/fake/invite',
      headers: auth,
    });
    expect(res.statusCode).toBe(201);
  });
});
