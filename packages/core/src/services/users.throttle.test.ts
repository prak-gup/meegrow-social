import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DbModule from '@meegrow-social/db';
import { AUTH_ATTEMPT_LIMITS, resetAttemptStore } from './auth-throttle.js';
import { hashPassword } from './password.js';
import { changePasswordWithLimit, loginWithPassword } from './users.js';

/**
 * The brute-force limits as the login and change-password routes meet them, against a stand-in
 * for the admin db handle (no Postgres in unit tests): every user lookup returns `state.user`.
 * The counting rules themselves are covered in auth-throttle.test.ts; this is the wiring — which
 * outcomes use up an attempt, and that a refused attempt never reaches the password check.
 */
const state = {
  user: undefined as
    { id: string; email: string; name: string | null; passwordHash: string | null } | undefined,
  lookups: 0,
  lookupError: undefined as Error | undefined,
};

const fakeDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => {
          state.lookups += 1;
          if (state.lookupError) throw state.lookupError;
          return state.user ? [state.user] : [];
        },
      }),
    }),
  }),
};

vi.mock('@meegrow-social/db', async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  db: () => fakeDb,
}));

const EMAIL = 'ann@x.test';
const PASSWORD = 'correct-horse-battery';
const IP = '203.0.113.7';
let passwordHash: string;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});
beforeEach(() => {
  resetAttemptStore();
  state.user = { id: 'user-1', email: EMAIL, name: 'Ann', passwordHash };
  state.lookups = 0;
  state.lookupError = undefined;
});
afterAll(resetAttemptStore);

const { perAccount: LOGIN_LIMIT, perIp: LOGIN_IP_LIMIT } = AUTH_ATTEMPT_LIMITS.login;
const PASSWORD_LIMIT = AUTH_ATTEMPT_LIMITS.password.perAccount;

describe('loginWithPassword', () => {
  it('signs in with the right password', async () => {
    expect(await loginWithPassword(EMAIL, PASSWORD, IP)).toEqual({
      ok: true,
      user: { id: 'user-1', email: EMAIL, name: 'Ann' },
    });
  });

  it('rate-limits an account after too many wrong passwords, even from fresh addresses', async () => {
    for (let i = 0; i < LOGIN_LIMIT; i++) {
      expect(await loginWithPassword(EMAIL, 'wrong', `10.0.0.${i}`)).toEqual({
        ok: false,
        reason: 'invalid_credentials',
      });
    }
    const lookupsBefore = state.lookups;
    const refused = await loginWithPassword(EMAIL, 'wrong', '10.9.9.9');
    expect(refused).toEqual({ ok: false, reason: 'rate_limited', retryAfterSeconds: 900 });
    // Refused before the user was even looked up, let alone a hash verified.
    expect(state.lookups).toBe(lookupsBefore);
  });

  it('refuses even the right password while the account is rate-limited', async () => {
    for (let i = 0; i < LOGIN_LIMIT; i++) await loginWithPassword(EMAIL, 'wrong', `10.0.0.${i}`);
    expect(await loginWithPassword(EMAIL, PASSWORD, IP)).toMatchObject({
      ok: false,
      reason: 'rate_limited',
    });
  });

  it('a successful login clears the count: the next mistakes start from zero', async () => {
    for (let i = 0; i < LOGIN_LIMIT - 1; i++) await loginWithPassword(EMAIL, 'wrong', IP);
    expect((await loginWithPassword(EMAIL, PASSWORD, IP)).ok).toBe(true);
    for (let i = 0; i < LOGIN_LIMIT; i++) {
      expect(await loginWithPassword(EMAIL, 'wrong', `10.0.0.${i}`)).toMatchObject({
        reason: 'invalid_credentials',
      });
    }
  });

  it('counts case and whitespace variants of an email as one account', async () => {
    for (let i = 0; i < LOGIN_LIMIT; i++) {
      await loginWithPassword(i % 2 ? 'ANN@X.test' : ' ann@x.test ', 'wrong', `10.0.0.${i}`);
    }
    expect(await loginWithPassword('Ann@X.Test', 'wrong', '10.9.9.9')).toMatchObject({
      reason: 'rate_limited',
    });
  });

  it('throttles an unknown email exactly like a real one — no account enumeration', async () => {
    state.user = undefined;
    for (let i = 0; i < LOGIN_LIMIT; i++) {
      expect(await loginWithPassword('nobody@x.test', 'wrong', `10.0.0.${i}`)).toEqual({
        ok: false,
        reason: 'invalid_credentials',
      });
    }
    expect(await loginWithPassword('nobody@x.test', 'wrong', '10.9.9.9')).toEqual({
      ok: false,
      reason: 'rate_limited',
      retryAfterSeconds: 900,
    });
  });

  it('rate-limits one address spraying many accounts, and nobody else', async () => {
    for (let i = 0; i < LOGIN_IP_LIMIT; i++) await loginWithPassword(`u${i}@x.test`, 'wrong', IP);
    expect(await loginWithPassword(EMAIL, PASSWORD, IP)).toMatchObject({ reason: 'rate_limited' });
    expect((await loginWithPassword(EMAIL, PASSWORD, '198.51.100.1')).ok).toBe(true);
  });

  it('a lookup that throws is rethrown and uses up no attempt', async () => {
    state.lookupError = new Error('connection terminated');
    for (let i = 0; i < LOGIN_LIMIT + 5; i++) {
      await expect(loginWithPassword(EMAIL, PASSWORD, IP)).rejects.toThrow('connection terminated');
    }
    state.lookupError = undefined;
    expect((await loginWithPassword(EMAIL, PASSWORD, IP)).ok).toBe(true);
  });
});

describe('changePasswordWithLimit', () => {
  const change = (current: string, next = 'a-brand-new-password', ip = IP) =>
    changePasswordWithLimit('user-1', 'session-1', current, next, ip);

  it('rate-limits a session guessing the current password, before any hash is verified', async () => {
    for (let i = 0; i < PASSWORD_LIMIT; i++) {
      expect(await change('wrong-guess', undefined, `10.0.0.${i}`)).toEqual({
        ok: false,
        reason: 'invalid_current_password',
      });
    }
    const lookupsBefore = state.lookups;
    expect(await change(PASSWORD, undefined, '10.9.9.9')).toEqual({
      ok: false,
      reason: 'rate_limited',
      retryAfterSeconds: 900,
    });
    expect(state.lookups).toBe(lookupsBefore);
  });

  it('does not count a request that never checked the current password', async () => {
    for (let i = 0; i < PASSWORD_LIMIT + 5; i++) {
      expect(await change(PASSWORD, 'short')).toEqual({
        ok: false,
        reason: 'invalid_new_password',
      });
    }
    expect(await change('wrong-guess')).toMatchObject({ reason: 'invalid_current_password' });
  });

  it('a proven current password clears the count, even when the change itself is refused', async () => {
    for (let i = 0; i < PASSWORD_LIMIT - 1; i++) await change('wrong-guess');
    // Proves the current password, then is refused for reusing it.
    expect(await change(PASSWORD, PASSWORD)).toEqual({ ok: false, reason: 'same_password' });
    for (let i = 0; i < PASSWORD_LIMIT; i++) {
      expect(await change('wrong-guess')).toMatchObject({ reason: 'invalid_current_password' });
    }
    expect(await change('wrong-guess')).toMatchObject({ reason: 'rate_limited' });
  });

  it('is counted apart from login: a locked password change does not lock sign-in', async () => {
    for (let i = 0; i < PASSWORD_LIMIT; i++) await change('wrong-guess');
    expect(await change(PASSWORD)).toMatchObject({ reason: 'rate_limited' });
    expect((await loginWithPassword(EMAIL, PASSWORD, IP)).ok).toBe(true);
  });
});
