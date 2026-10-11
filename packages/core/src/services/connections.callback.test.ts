import { describe, expect, it } from 'vitest';
import { signConnectOutcome, verifyConnectOutcome } from '../crypto.js';
import {
  CONNECT_FAILURE_MESSAGES,
  ConnectError,
  connectFailureCode,
  connectFailureMessage,
} from '../errors.js';
import {
  callbackCarriesCredential,
  completeCredentialCallback,
  InviteClosedError,
  openCallbackOutcome,
} from './connections.js';

/**
 * The DB-free half of the credential-bearing callback (WordPress): how its result is sealed into
 * the redirect and read back, and what a forged query gets. The flow checks themselves — unknown,
 * used, expired, wrong browser, replay — need Postgres and are in
 * `connections.wordpress.integration.test.ts`.
 */

const CONNECTION = '33333333-3333-4333-8333-333333333333';

// Set at load, not in a hook: the tables below seal their fixtures while the file is collected.
process.env.TOKEN_ENCRYPTION_KEY ??= 'unit-test-key';

const parse = (sealed: string): Record<string, string> =>
  Object.fromEntries(new URLSearchParams(sealed));

describe('callbackCarriesCredential', () => {
  it('is true for WordPress’s redirect and false for an OAuth one', () => {
    expect(
      callbackCarriesCredential({ state: 's', site_url: 'x', user_login: 'u', password: 'p' }),
    ).toBe(true);
    // Either half alone is still a secret-bearing URL that must not be rendered as a page.
    expect(callbackCarriesCredential({ state: 's', password: 'p' })).toBe(true);
    expect(callbackCarriesCredential({ state: 's', user_login: 'u' })).toBe(true);
    expect(callbackCarriesCredential({ state: 's', password: '' })).toBe(true);
    expect(callbackCarriesCredential({ state: 's', code: 'c' })).toBe(false);
    expect(callbackCarriesCredential({ state: 's', error: 'access_denied' })).toBe(false);
    expect(callbackCarriesCredential({})).toBe(false);
  });
});

describe('connect failure vocabulary', () => {
  it('codes come from the error’s class, never from its text', () => {
    expect(connectFailureCode(new ConnectError('site_mismatch'))).toBe('site_mismatch');
    expect(connectFailureCode(new InviteClosedError('whatever'))).toBe('invite_closed');
    expect(connectFailureCode(new Error('site_mismatch'))).toBe('failed');
    expect(connectFailureCode('credentials_rejected')).toBe('failed');
    expect(connectFailureCode(undefined)).toBe('failed');
  });

  it('a code read back from a URL can only ever select a fixed sentence', () => {
    expect(connectFailureMessage('site_mismatch')).toBe(CONNECT_FAILURE_MESSAGES.site_mismatch);
    for (const hostile of [
      '<script>alert(1)</script>',
      'Your account is locked, call 555-0100',
      '__proto__',
      'constructor',
      'toString',
      '',
      undefined,
      42,
      ['site_mismatch'],
    ]) {
      expect(connectFailureMessage(hostile)).toBe(CONNECT_FAILURE_MESSAGES.failed);
    }
  });
});

describe('sealed callback outcome', () => {
  it('a seal verifies only for exactly what was sealed', () => {
    const seal = signConnectOutcome(`connected:${CONNECTION}`);
    expect(verifyConnectOutcome(`connected:${CONNECTION}`, seal)).toBe(true);
    expect(verifyConnectOutcome(`connected:${CONNECTION}x`, seal)).toBe(false);
    expect(verifyConnectOutcome('error:failed', seal)).toBe(false);
    expect(verifyConnectOutcome(`connected:${CONNECTION}`, '')).toBe(false);
    expect(verifyConnectOutcome(`connected:${CONNECTION}`, undefined)).toBe(false);
    expect(verifyConnectOutcome(`connected:${CONNECTION}`, [seal])).toBe(false);
    expect(verifyConnectOutcome(`connected:${CONNECTION}`, `${seal}=`)).toBe(false);
  });

  it('opens a genuine success', () => {
    const detail = CONNECTION;
    const query = { status: 'connected', detail, seal: signConnectOutcome(`connected:${detail}`) };
    expect(openCallbackOutcome(query)).toEqual({ status: 'connected', connectionId: CONNECTION });
  });

  it('opens a genuine failure as its fixed sentence', () => {
    const query = {
      status: 'error',
      detail: 'site_mismatch',
      seal: signConnectOutcome('error:site_mismatch'),
    };
    expect(openCallbackOutcome(query)).toEqual({
      status: 'error',
      error: CONNECT_FAILURE_MESSAGES.site_mismatch,
    });
  });

  it.each([
    ['no seal', { status: 'connected', detail: CONNECTION }],
    ['a made-up seal', { status: 'connected', detail: CONNECTION, seal: 'AAAA' }],
    [
      'a failure’s seal moved onto a success',
      { status: 'connected', detail: CONNECTION, seal: signConnectOutcome('error:failed') },
    ],
    [
      'a real seal with the connection swapped',
      {
        status: 'connected',
        detail: '44444444-4444-4444-8444-444444444444',
        seal: signConnectOutcome(`connected:${CONNECTION}`),
      },
    ],
    ['nothing at all', {}],
    ['arrays where strings belong', { status: ['connected'], detail: [CONNECTION], seal: ['x'] }],
  ])('refuses to announce success for %s', (_name, query) => {
    expect(openCallbackOutcome(query)).toEqual({
      status: 'error',
      error: CONNECT_FAILURE_MESSAGES.failed,
    });
  });

  it('a seal made under another key is worthless', () => {
    const detail = CONNECTION;
    const before = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = 'somebody-elses-key';
    const foreign = signConnectOutcome(`connected:${detail}`);
    process.env.TOKEN_ENCRYPTION_KEY = before;
    expect(openCallbackOutcome({ status: 'connected', detail, seal: foreign }).status).toBe(
      'error',
    );
  });
});

describe('completeCredentialCallback — refusals that need no database', () => {
  const secret = 'abcd EFGH 1234 ijkl MNOP 5678';

  it.each([
    ['no state', { site_url: 'https://blog.example.com', user_login: 'priya', password: secret }],
    [
      'a state that is not a flow id',
      {
        state: "x' OR '1'='1",
        site_url: 'https://blog.example.com',
        user_login: 'priya',
        password: secret,
      },
    ],
    [
      'an empty state',
      { state: '', site_url: 'https://blog.example.com', user_login: 'priya', password: secret },
    ],
  ])(
    'reports %s as a sealed invalid_state, carrying nothing from the callback',
    async (_n, query) => {
      const sealed = await completeCredentialCallback(query, undefined);
      const out = parse(sealed);
      expect(out.status).toBe('error');
      expect(out.detail).toBe('invalid_state');
      expect(openCallbackOutcome(out)).toEqual({
        status: 'error',
        error: CONNECT_FAILURE_MESSAGES.invalid_state,
      });
      // Only the three sealed fields travel on: no password, no login, no site.
      expect(Object.keys(out).sort()).toEqual(['detail', 'seal', 'status']);
      expect(sealed).not.toContain('priya');
      expect(sealed).not.toContain('abcd');
      expect(sealed).not.toContain('example.com');
    },
  );
});
