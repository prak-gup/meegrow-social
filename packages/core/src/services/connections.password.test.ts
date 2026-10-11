import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DbModule from '@meegrow-social/db';
import { decryptToken, openSiteCheck, sealSiteCheck } from '../crypto.js';
import { ConnectError, ProviderBadRequestError } from '../errors.js';
import { registerProvider } from '../providers/registry.js';
import type { PasswordConnectParams, SiteInspection, SocialProvider } from '../providers/types.js';
import { resetAttemptStore, SITE_LOGIN_LIMIT } from './auth-throttle.js';
import {
  checkConnectSite,
  connectionMethod,
  connectWithPassword,
  SITE_CHECK_TTL_MS,
} from './connections.js';

/**
 * Connecting a site with a username and login password, as the service sees it — without
 * Postgres: `withWorkspace` is a stand-in that records the row it was asked to insert. Under test
 * is everything between the route and the provider: that a login only ever goes to an endpoint
 * this server sealed for this client, that attempts are limited before the site is asked
 * anything, and that the password ends up in exactly one place — the encrypted token.
 *
 * The same flow against real Postgres is in `connections.wordpress-password.integration.test.ts`.
 */

const inserted: Array<Record<string, unknown>> = [];
const fakeTx = {
  insert: () => ({
    values: (row: Record<string, unknown>) => ({
      returning: async () => {
        inserted.push(row);
        return [{ id: CONNECTION }];
      },
    }),
  }),
};

vi.mock('@meegrow-social/db', async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  withWorkspace: async (_workspaceId: string, fn: (tx: typeof fakeTx) => unknown) => fn(fakeTx),
}));

process.env.TOKEN_ENCRYPTION_KEY ??= 'unit-test-key';

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '22222222-2222-4222-8222-222222222222';
const CONNECTION = '33333333-3333-4333-8333-333333333333';
const SITE = 'https://blog.example.com';
const ENDPOINT = `${SITE}/xmlrpc.php`;
const USERNAME = 'priya.editor';
const PASSWORD = 'Tr0ub4dor&3 <correct> "horse"';
const CALLER = { ip: '203.0.113.7', actor: 'user-1' };

const INSPECTION: SiteInspection = {
  entered: SITE,
  name: 'Ecolive & Co',
  siteAddress: SITE,
  homeAddress: SITE,
  separateAddresses: false,
  approval: {
    available: false,
    reason: 'application_passwords_unavailable',
    message: 'Application Passwords are not available on this site.',
  },
  password: { available: true, endpoint: ENDPOINT },
};

const inspectSite = vi.fn<(siteUrl: string) => Promise<SiteInspection>>();
const authenticateWithPassword = vi.fn<NonNullable<SocialProvider['authenticateWithPassword']>>();

/** A stand-in WordPress: only the two methods the password connect uses are real. */
const stub = {
  identifier: 'wordpress',
  displayName: 'WordPress',
  isBetweenSteps: false,
  tokenModel: 'one-time',
  maxConcurrentJobs: 2,
  connectInput: 'site_url',
  connectMethods: ['approval', 'password'],
  inspectSite,
  authenticateWithPassword,
} as unknown as SocialProvider;

const accepted = (params: PasswordConnectParams) => ({
  accessToken: JSON.stringify({
    v: 1,
    transport: 'xmlrpc',
    siteUrl: SITE,
    endpoint: params.endpoint,
    username: params.username,
    password: params.password,
  }),
  externalId: SITE,
  displayName: 'Ecolive & Co',
  connectionMeta: { method: 'password', endpoint: params.endpoint },
});

beforeEach(() => {
  vi.resetAllMocks();
  resetAttemptStore();
  inserted.length = 0;
  registerProvider(stub);
  inspectSite.mockResolvedValue(INSPECTION);
  authenticateWithPassword.mockImplementation(async (params) => accepted(params));
});

async function ticketFor(workspaceId = WS): Promise<string> {
  return (await checkConnectSite(workspaceId, 'wordpress', 'blog.example.com')).ticket!;
}

const connect = (ticket: string, over: Partial<typeof CALLER> = {}, workspaceId = WS) =>
  connectWithPassword(
    workspaceId,
    'wordpress',
    { ticket, username: USERNAME, password: PASSWORD },
    { ...CALLER, ...over },
  );

describe('checkConnectSite', () => {
  it('passes the provider’s findings on and seals the endpoint for this client', async () => {
    const check = await checkConnectSite(WS, 'wordpress', 'blog.example.com');
    expect(inspectSite).toHaveBeenCalledWith('blog.example.com');
    expect(check).toMatchObject(INSPECTION);
    const sealed = JSON.parse(openSiteCheck(check.ticket)!) as Record<string, unknown>;
    expect(sealed).toMatchObject({
      workspaceId: WS,
      provider: 'wordpress',
      endpoint: ENDPOINT,
      entered: SITE,
      home: SITE,
    });
    expect(Number(sealed.expiresAt) - Date.now()).toBeGreaterThan(SITE_CHECK_TTL_MS - 5000);
  });

  it('issues no ticket when a login is not possible on the site', async () => {
    inspectSite.mockResolvedValue({
      ...INSPECTION,
      password: { available: false, reason: 'disabled', message: 'XML-RPC is switched off.' },
    });
    expect((await checkConnectSite(WS, 'wordpress', SITE)).ticket).toBeUndefined();
  });

  it('issues no ticket for a provider that does not take a password', async () => {
    registerProvider({ ...stub, connectMethods: ['approval'] } as SocialProvider);
    const check = await checkConnectSite(WS, 'wordpress', SITE);
    expect(check.ticket).toBeUndefined();
    expect(check.password).toMatchObject({ available: false, reason: 'not_offered' });
  });

  it('refuses a provider that is not connected by site address', async () => {
    await expect(checkConnectSite(WS, 'fake', SITE)).rejects.toBeInstanceOf(
      ProviderBadRequestError,
    );
  });
});

describe('connectWithPassword', () => {
  it('sends the login to the sealed endpoint, stores it encrypted, and returns none of it', async () => {
    const outcome = await connect(await ticketFor());
    expect(outcome).toEqual({
      ok: true,
      connectionId: CONNECTION,
      displayName: 'Ecolive & Co',
      externalId: SITE,
      endpoint: ENDPOINT,
    });
    expect(authenticateWithPassword).toHaveBeenCalledWith({
      endpoint: ENDPOINT,
      username: USERNAME,
      password: PASSWORD,
      site: { entered: SITE, home: SITE, name: 'Ecolive & Co' },
    });

    // What was returned carries no part of the login.
    expect(JSON.stringify(outcome)).not.toContain('Tr0ub4dor');
    expect(JSON.stringify(outcome)).not.toContain(USERNAME);

    // What was stored: ciphertext, plus how it was connected — in the clear, and not a secret.
    expect(inserted).toHaveLength(1);
    const [row] = inserted as [Record<string, unknown>];
    expect(row).toMatchObject({
      workspaceId: WS,
      provider: 'wordpress',
      externalId: SITE,
      tokenModel: 'one-time',
      meta: { method: 'password', endpoint: ENDPOINT },
    });
    const { accessToken, ...rest } = row;
    expect(String(accessToken)).not.toContain('Tr0ub4dor');
    expect(String(accessToken)).not.toContain(USERNAME);
    expect(JSON.stringify(rest)).not.toContain('Tr0ub4dor');
    expect(JSON.stringify(rest)).not.toContain(USERNAME);
    expect(JSON.parse(decryptToken(String(accessToken)))).toMatchObject({
      transport: 'xmlrpc',
      endpoint: ENDPOINT,
      username: USERNAME,
      password: PASSWORD,
    });
  });

  it.each<[string, (ticket: string) => string | Promise<string>]>([
    ['made up', () => 'not-a-ticket'],
    ['empty', () => ''],
    [
      'with its endpoint changed',
      (t) => {
        const [body, seal] = t.split('.') as [string, string];
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as {
          endpoint: string;
        };
        payload.endpoint = 'https://victim.example.org/xmlrpc.php';
        return `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${seal}`;
      },
    ],
    ['sealed for another client', () => ticketFor(OTHER_WS)],
    [
      'sealed for another provider',
      () =>
        sealSiteCheck(
          JSON.stringify({
            workspaceId: WS,
            provider: 'fake',
            endpoint: ENDPOINT,
            entered: SITE,
            home: SITE,
            name: null,
            expiresAt: Date.now() + 60_000,
          }),
        ),
    ],
    [
      'that has expired',
      () =>
        sealSiteCheck(
          JSON.stringify({
            workspaceId: WS,
            provider: 'wordpress',
            endpoint: ENDPOINT,
            entered: SITE,
            home: SITE,
            name: null,
            expiresAt: Date.now() - 1,
          }),
        ),
    ],
    ['that is sealed but not a ticket', () => sealSiteCheck('"hello"')],
  ])('refuses a ticket %s, without contacting any site', async (_name, forge) => {
    const outcome = await connect(await forge(await ticketFor()));
    expect(outcome).toMatchObject({ ok: false, reason: 'check_expired' });
    expect(authenticateWithPassword).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it('reduces whatever the provider threw to a fixed sentence', async () => {
    authenticateWithPassword.mockRejectedValue(new ConnectError('login_rejected'));
    expect(await connect(await ticketFor())).toEqual({
      ok: false,
      reason: 'login_rejected',
      message: 'the site did not accept that username and password',
    });

    // Even an error that (wrongly) carries the login in its text cannot get it out.
    authenticateWithPassword.mockRejectedValue(
      new Error(`login failed for ${USERNAME} with ${PASSWORD}`),
    );
    const outcome = await connect(await ticketFor());
    expect(outcome).toEqual({
      ok: false,
      reason: 'failed',
      message: 'the connection could not be completed',
    });
    expect(inserted).toHaveLength(0);
  });

  it('refuses a provider that takes no password', async () => {
    const ticket = await ticketFor();
    registerProvider({ ...stub, connectMethods: ['approval'] } as SocialProvider);
    expect(await connect(ticket)).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(authenticateWithPassword).not.toHaveBeenCalled();
  });
});

describe('connectWithPassword — attempt limits', () => {
  const wrong = () =>
    authenticateWithPassword.mockRejectedValue(new ConnectError('login_rejected'));

  it('stops guessing at one site after the limit, whoever asks and from wherever', async () => {
    wrong();
    const ticket = await ticketFor();
    for (let i = 0; i < SITE_LOGIN_LIMIT.perSite; i++) {
      // A different caller and address every time: the per-site count is what fills.
      const outcome = await connect(ticket, { ip: `198.51.100.${i}`, actor: `user-${i}` });
      expect(outcome).toMatchObject({ ok: false, reason: 'login_rejected' });
    }
    const blocked = await connect(ticket, { ip: '192.0.2.99', actor: 'someone-new' });
    expect(blocked).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect(
      blocked.ok === false && blocked.reason === 'rate_limited' && blocked.retryAfterSeconds,
    ).toBeGreaterThan(0);
    // The site is not asked again once the limit is reached.
    expect(authenticateWithPassword).toHaveBeenCalledTimes(SITE_LOGIN_LIMIT.perSite);

    // Even the right password waits: the limit is on asking, not on being wrong.
    authenticateWithPassword.mockImplementation(async (params) => accepted(params));
    expect(await connect(ticket, { ip: '192.0.2.99', actor: 'someone-new' })).toMatchObject({
      reason: 'rate_limited',
    });
    expect(inserted).toHaveLength(0);
  });

  it('stops one caller spraying a login across many sites', async () => {
    wrong();
    for (let i = 0; i < SITE_LOGIN_LIMIT.perActor; i++) {
      inspectSite.mockResolvedValue({
        ...INSPECTION,
        password: { available: true, endpoint: `https://site-${i}.example.com/xmlrpc.php` },
      });
      // A fresh address each time, so it is the per-caller count that fills.
      expect(await connect(await ticketFor(), { ip: `198.51.100.${i}` })).toMatchObject({
        reason: 'login_rejected',
      });
    }
    inspectSite.mockResolvedValue({
      ...INSPECTION,
      password: { available: true, endpoint: 'https://site-next.example.com/xmlrpc.php' },
    });
    expect(await connect(await ticketFor(), { ip: '192.0.2.50' })).toMatchObject({
      reason: 'rate_limited',
    });
  });

  it.each(['xmlrpc_blocked', 'site_unreachable', 'xmlrpc_disabled', 'failed'] as const)(
    'counts an attempt that ended in %s — every one is a request made at somebody’s login',
    async (code) => {
      authenticateWithPassword.mockRejectedValue(new ConnectError(code));
      const ticket = await ticketFor();
      for (let i = 0; i < SITE_LOGIN_LIMIT.perSite; i++) {
        await connect(ticket, { ip: `198.51.100.${i}`, actor: `user-${i}` });
      }
      expect(await connect(ticket, { ip: '192.0.2.1', actor: 'x' })).toMatchObject({
        reason: 'rate_limited',
      });
    },
  );

  it('gives a successful login its attempt back, but never clears the site’s count', async () => {
    const ticket = await ticketFor();
    // Far more successes than the limit: none of them uses anything up.
    for (let i = 0; i < SITE_LOGIN_LIMIT.perSite * 3; i++) {
      expect((await connect(ticket)).ok).toBe(true);
    }
    // Wrong guesses up to one short of the limit, then a success, then one more wrong guess: the
    // success must not have wiped the slate (or a known login would buy unlimited guesses).
    wrong();
    for (let i = 0; i < SITE_LOGIN_LIMIT.perSite - 1; i++) {
      await connect(ticket, { ip: `198.51.100.${i}`, actor: `user-${i}` });
    }
    authenticateWithPassword.mockImplementation(async (params) => accepted(params));
    expect((await connect(ticket)).ok).toBe(true);
    wrong();
    expect(await connect(ticket, { ip: '192.0.2.8', actor: 'y' })).toMatchObject({
      reason: 'login_rejected',
    });
    expect(await connect(ticket, { ip: '192.0.2.9', actor: 'z' })).toMatchObject({
      reason: 'rate_limited',
    });
  });

  it('does not count the right password of a user who may not publish as a wrong guess', async () => {
    authenticateWithPassword.mockRejectedValue(new ConnectError('role_cannot_publish'));
    const ticket = await ticketFor();
    for (let i = 0; i < SITE_LOGIN_LIMIT.perSite * 2; i++) {
      expect(await connect(ticket)).toMatchObject({ reason: 'role_cannot_publish' });
    }
  });

  it('does not count a refused ticket: no site was asked anything', async () => {
    for (let i = 0; i < SITE_LOGIN_LIMIT.perIp + 5; i++) await connect('forged');
    expect((await connect(await ticketFor())).ok).toBe(true);
  });
});

describe('connectionMethod', () => {
  it('reads the method from a connection’s non-secret meta, and only a known one', () => {
    expect(connectionMethod({ method: 'password', endpoint: ENDPOINT })).toEqual({
      method: 'password',
    });
    expect(connectionMethod({ method: 'approval' })).toEqual({ method: 'approval' });
    for (const meta of [{}, null, undefined, { method: 'carrier-pigeon' }, { method: 7 }, 'x']) {
      expect(connectionMethod(meta)).toEqual({});
    }
  });
});
