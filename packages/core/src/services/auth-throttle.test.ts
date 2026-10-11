import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ATTEMPT_STORE_TIMEOUT_MS,
  AUTH_ATTEMPT_LIMITS,
  beginAuthAttempt,
  beginSiteLoginAttempt,
  clientAddressBucket,
  MemoryAttemptStore,
  resetAttemptStore,
  setAttemptStore,
  type AttemptGate,
  type AttemptLimit,
  type AttemptResult,
  type AttemptStore,
} from './auth-throttle.js';

const MINUTE = 60_000;
const limit: AttemptLimit = { windowMs: 15 * MINUTE, perAccount: 3, perIp: 5 };

let now = 0;
const clock = () => now;

/** One attempt, settled straight away. Returns the gate so a refusal can be inspected. */
async function attempt(
  ip: string,
  account: string,
  result: AttemptResult = 'failed',
): Promise<AttemptGate> {
  const gate = await beginAuthAttempt('login', { ip, account }, limit);
  if (gate.allowed) await gate.settle(result);
  return gate;
}
const allowed = async (ip: string, account: string, result: AttemptResult = 'failed') =>
  (await attempt(ip, account, result)).allowed;

beforeEach(() => {
  now = 1_760_000_000_000;
  resetAttemptStore();
  setAttemptStore(new MemoryAttemptStore(clock));
});
afterEach(() => {
  vi.useRealTimers();
  resetAttemptStore();
});

describe('MemoryAttemptStore', () => {
  it('counts hits in a fixed window that later hits do not extend', async () => {
    const store = new MemoryAttemptStore(clock);
    expect(await store.hit('k', 1000)).toEqual({ count: 1, resetInMs: 1000 });
    now += 400;
    expect(await store.hit('k', 5000)).toEqual({ count: 2, resetInMs: 600 });
    now += 600;
    expect(await store.hit('k', 1000)).toEqual({ count: 1, resetInMs: 1000 });
  });

  it('unhit gives one back, drops the key at zero, and never creates one', async () => {
    const store = new MemoryAttemptStore(clock);
    await store.unhit('k');
    await store.hit('k', 1000);
    await store.hit('k', 1000);
    await store.unhit('k');
    expect((await store.hit('k', 1000)).count).toBe(2);
    await store.unhit('k');
    await store.unhit('k');
    await store.unhit('k'); // already gone
    expect((await store.hit('k', 1000)).count).toBe(1);
  });

  it('reset forgets the key', async () => {
    const store = new MemoryAttemptStore(clock);
    await store.hit('k', 1000);
    await store.reset('k');
    expect((await store.hit('k', 1000)).count).toBe(1);
  });
});

describe('beginAuthAttempt — per account', () => {
  it('refuses the attempt after the limit, whatever address it comes from', async () => {
    for (let i = 0; i < 3; i++) expect(await allowed(`10.0.0.${i}`, 'ann@x.test')).toBe(true);
    // A fourth address — distributed guessing at one account is still stopped.
    const gate = await attempt('10.0.0.99', 'ann@x.test');
    expect(gate).toEqual({ allowed: false, retryAfterSeconds: 900 });
  });

  it('does not touch other accounts: one locked account locks out nobody else', async () => {
    for (let i = 0; i < 3; i++) await attempt(`10.0.0.${i}`, 'ann@x.test');
    expect(await allowed('10.0.1.1', 'ann@x.test')).toBe(false);
    expect(await allowed('10.0.1.1', 'bob@x.test')).toBe(true);
  });

  it('reports the time left in the window, rounded up, and lets go when it closes', async () => {
    for (let i = 0; i < 3; i++) await attempt(`10.0.0.${i}`, 'ann@x.test');
    now += 14 * MINUTE + 59_001;
    expect(await attempt('10.0.0.9', 'ann@x.test')).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
    now += 999;
    expect(await allowed('10.0.0.9', 'ann@x.test')).toBe(true);
  });

  it('refused attempts do not push the window out', async () => {
    for (let i = 0; i < 3; i++) await attempt(`10.0.0.${i}`, 'ann@x.test');
    for (let minute = 1; minute < 15; minute++) {
      now += MINUTE;
      expect(await allowed(`10.0.2.${minute}`, 'ann@x.test')).toBe(false);
    }
    now += MINUTE;
    expect(await allowed('10.0.3.1', 'ann@x.test')).toBe(true);
  });
});

describe('beginAuthAttempt — per address', () => {
  it('refuses an address spraying many accounts once it passes its own limit', async () => {
    for (let i = 0; i < 5; i++) expect(await allowed('203.0.113.7', `user${i}@x.test`)).toBe(true);
    expect(await attempt('203.0.113.7', 'fresh@x.test')).toEqual({
      allowed: false,
      retryAfterSeconds: 900,
    });
    // Everyone else is untouched.
    expect(await allowed('198.51.100.1', 'fresh@x.test')).toBe(true);
  });

  it('an IPv6 client cannot dodge the limit by rotating addresses inside its /64', async () => {
    for (let i = 0; i < 5; i++) {
      expect(await allowed(`2001:db8:12:3400::${i + 1}`, `user${i}@x.test`)).toBe(true);
    }
    expect(await allowed('2001:db8:12:3400:ffff::1', 'fresh@x.test')).toBe(false);
    expect(await allowed('2001:db8:12:3401::1', 'fresh@x.test')).toBe(true);
  });

  it('a blocked address cannot spend the guesses of the accounts it names', async () => {
    for (let i = 0; i < 5; i++) await attempt('203.0.113.7', `user${i}@x.test`);
    for (let i = 0; i < 10; i++) expect(await allowed('203.0.113.7', 'ann@x.test')).toBe(false);
    // ann's own budget is intact: three wrong guesses from elsewhere are still allowed.
    for (let i = 0; i < 3; i++) expect(await allowed(`10.0.0.${i}`, 'ann@x.test')).toBe(true);
  });
});

describe('clientAddressBucket', () => {
  it('leaves an IPv4 address as it is', () => {
    expect(clientAddressBucket('203.0.113.7')).toBe('203.0.113.7');
  });

  it('counts an IPv4-mapped IPv6 address as its IPv4 address', () => {
    expect(clientAddressBucket('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(clientAddressBucket('::FFFF:203.0.113.7')).toBe('203.0.113.7');
  });

  it('puts every address of one IPv6 /64 in the same bucket, however it is written', () => {
    const bucket = '2001:db8:12:3400::/64';
    expect(clientAddressBucket('2001:db8:12:3400::1')).toBe(bucket);
    expect(clientAddressBucket('2001:0DB8:0012:3400:aaaa:bbbb:cccc:dddd')).toBe(bucket);
    expect(clientAddressBucket('2001:db8:12:3400:0:0:0:9')).toBe(bucket);
    expect(clientAddressBucket('2001:db8:12:3401::1')).not.toBe(bucket);
  });

  it('expands a compressed prefix and drops a zone id', () => {
    expect(clientAddressBucket('::1')).toBe('0:0:0:0::/64');
    expect(clientAddressBucket('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(clientAddressBucket('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('passes through anything that is not an address rather than throwing', () => {
    expect(clientAddressBucket('')).toBe('');
    expect(clientAddressBucket('unknown')).toBe('unknown');
  });
});

describe('beginAuthAttempt — settling', () => {
  it('a success clears the account, so the user is not left penalised', async () => {
    await attempt('10.0.0.1', 'ann@x.test');
    await attempt('10.0.0.1', 'ann@x.test');
    expect(await allowed('10.0.0.1', 'ann@x.test', 'succeeded')).toBe(true);
    // A full budget again, not one guess left.
    for (let i = 0; i < 3; i++) expect(await allowed('10.0.0.1', 'ann@x.test')).toBe(true);
    expect(await allowed('10.0.0.2', 'ann@x.test')).toBe(false);
  });

  it('successes never use up the address limit', async () => {
    for (let i = 0; i < 50; i++) {
      expect(await allowed('10.0.0.1', `user${i}@x.test`, 'succeeded')).toBe(true);
    }
  });

  it('a success does not wipe the address count: no resetting between guesses', async () => {
    for (let i = 0; i < 4; i++) await attempt('203.0.113.7', `victim${i}@x.test`);
    await attempt('203.0.113.7', 'attacker@x.test', 'succeeded');
    expect(await allowed('203.0.113.7', 'victim5@x.test')).toBe(true); // the fifth wrong guess
    expect(await allowed('203.0.113.7', 'victim6@x.test')).toBe(false);
  });

  it('an attempt that checked no password is given back on both keys', async () => {
    for (let i = 0; i < 20; i++) {
      expect(await allowed('10.0.0.1', 'ann@x.test', 'not_a_guess')).toBe(true);
    }
  });

  it('an attempt nobody settles stays counted as a wrong guess', async () => {
    for (let i = 0; i < 3; i++) {
      await beginAuthAttempt('login', { ip: `10.0.0.${i}`, account: 'ann@x.test' }, limit);
    }
    expect(await allowed('10.0.0.9', 'ann@x.test')).toBe(false);
  });

  it('holds the limit under a burst of concurrent guesses', async () => {
    const gates = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        beginAuthAttempt('login', { ip: `10.1.0.${i}`, account: 'ann@x.test' }, limit),
      ),
    );
    expect(gates.filter((g) => g.allowed)).toHaveLength(3);
  });
});

describe('beginAuthAttempt — scopes and defaults', () => {
  it('counts login and password-change attempts separately', async () => {
    for (let i = 0; i < 3; i++) await attempt(`10.0.0.${i}`, 'user-1');
    expect(await allowed('10.0.0.9', 'user-1')).toBe(false);
    const gate = await beginAuthAttempt('password', { ip: '10.0.0.9', account: 'user-1' }, limit);
    expect(gate.allowed).toBe(true);
  });

  it('uses the documented defaults when no limit is passed', async () => {
    expect(AUTH_ATTEMPT_LIMITS).toEqual({
      login: { windowMs: 15 * MINUTE, perAccount: 10, perIp: 30 },
      password: { windowMs: 15 * MINUTE, perAccount: 5, perIp: 30 },
      connect: { windowMs: 15 * MINUTE, perAccount: 10, perIp: 30 },
    });
    for (let i = 0; i < 5; i++) {
      const gate = await beginAuthAttempt('password', { ip: `10.0.0.${i}`, account: 'user-1' });
      expect(gate.allowed).toBe(true);
    }
    const sixth = await beginAuthAttempt('password', { ip: '10.0.0.9', account: 'user-1' });
    expect(sixth.allowed).toBe(false);
  });
});

describe('beginAuthAttempt — when the shared store is down', () => {
  const broken: AttemptStore = {
    hit: async () => {
      throw new Error('ECONNREFUSED');
    },
    unhit: async () => {
      throw new Error('ECONNREFUSED');
    },
    reset: async () => {
      throw new Error('ECONNREFUSED');
    },
  };

  it('still limits, counting in this process instead of failing open or locking everyone out', async () => {
    setAttemptStore(broken);
    for (let i = 0; i < 3; i++) expect(await allowed(`10.0.0.${i}`, 'ann@x.test')).toBe(true);
    expect(await allowed('10.0.0.9', 'ann@x.test')).toBe(false);
    expect(await allowed('10.0.0.9', 'bob@x.test')).toBe(true);
  });

  it('does not wait on a store that never answers', async () => {
    vi.useFakeTimers();
    setAttemptStore({ ...broken, hit: () => new Promise(() => undefined) });
    const pending = beginAuthAttempt('login', { ip: '10.0.0.1', account: 'ann@x.test' }, limit);
    await vi.advanceTimersByTimeAsync(ATTEMPT_STORE_TIMEOUT_MS);
    expect((await pending).allowed).toBe(true);
  });

  it('a give-back the store rejects never fails the request', async () => {
    const store = new MemoryAttemptStore(clock);
    setAttemptStore({ ...broken, hit: (key, windowMs) => store.hit(key, windowMs) });
    const gate = await beginAuthAttempt('login', { ip: '10.0.0.1', account: 'ann@x.test' }, limit);
    expect(gate.allowed).toBe(true);
    if (gate.allowed) await expect(gate.settle('succeeded')).resolves.toBeUndefined();
  });
});

describe('beginSiteLoginAttempt — logins this server tries at somebody else’s site', () => {
  const siteLimit = { windowMs: 60 * MINUTE, perSite: 3, perActor: 5, perIp: 7 };
  const tryLogin = async (
    over: Partial<{ ip: string; actor: string; site: string }> = {},
    result: AttemptResult = 'failed',
  ): Promise<AttemptGate> => {
    const gate = await beginSiteLoginAttempt(
      { ip: '203.0.113.1', actor: 'user-1', site: 'blog.example.com', ...over },
      siteLimit,
    );
    if (gate.allowed) await gate.settle(result);
    return gate;
  };
  /** A caller and address nobody has used yet, so only the site's count can refuse. */
  let fresh = 0;
  const stranger = () => ({ ip: `198.51.100.${++fresh}`, actor: `stranger-${fresh}` });

  it('limits wrong logins per site across every caller and address', async () => {
    for (let i = 0; i < siteLimit.perSite; i++)
      expect((await tryLogin(stranger())).allowed).toBe(true);
    const refused = await tryLogin(stranger());
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 3600 });
    // Another site is unaffected, and the host is compared without regard to case.
    expect((await tryLogin({ ...stranger(), site: 'other.example.com' })).allowed).toBe(true);
    expect((await tryLogin({ ...stranger(), site: 'BLOG.example.com' })).allowed).toBe(false);
  });

  it('limits one caller across sites, and one address across callers', async () => {
    for (let i = 0; i < siteLimit.perActor; i++) {
      const gate = await tryLogin({ ip: `198.51.100.${i}`, site: `site-${i}.example.com` });
      expect(gate.allowed).toBe(true);
    }
    expect((await tryLogin({ ip: '198.51.100.200', site: 'fresh.example.com' })).allowed).toBe(
      false,
    );

    for (let i = 0; i < siteLimit.perIp; i++) {
      const gate = await tryLogin({
        ip: '192.0.2.44',
        actor: `a-${i}`,
        site: `ip-${i}.example.com`,
      });
      expect(gate.allowed).toBe(true);
    }
    expect(
      (await tryLogin({ ip: '192.0.2.44', actor: 'a-new', site: 'ip-new.example.com' })).allowed,
    ).toBe(false);
  });

  it('gives a success its own attempt back and never resets the site', async () => {
    for (let i = 0; i < 20; i++) expect((await tryLogin({}, 'succeeded')).allowed).toBe(true);
    for (let i = 0; i < siteLimit.perSite - 1; i++) await tryLogin(stranger());
    expect((await tryLogin(stranger(), 'succeeded')).allowed).toBe(true);
    expect((await tryLogin(stranger())).allowed).toBe(true);
    expect((await tryLogin(stranger())).allowed).toBe(false);
  });

  it('a refused address cannot spend the guesses of a site it names', async () => {
    for (let i = 0; i < siteLimit.perIp; i++) {
      await tryLogin({ ip: '192.0.2.77', actor: `b-${i}`, site: `burn-${i}.example.com` });
    }
    // Refused at the address, over and over, naming one site.
    for (let i = 0; i < 10; i++) {
      expect(
        (await tryLogin({ ip: '192.0.2.77', actor: `c-${i}`, site: 'target.example.com' })).allowed,
      ).toBe(false);
    }
    expect((await tryLogin({ ...stranger(), site: 'target.example.com' })).allowed).toBe(true);
  });

  it('opens again when the window closes, and is not extended by attempts made while refused', async () => {
    for (let i = 0; i < siteLimit.perSite; i++) await tryLogin(stranger());
    now += 59 * MINUTE;
    expect((await tryLogin(stranger())).allowed).toBe(false);
    now += 2 * MINUTE;
    expect((await tryLogin(stranger())).allowed).toBe(true);
  });

  it('falls back to counting in-process when the store is unreachable — never to no limit', async () => {
    const broken: AttemptStore = {
      hit: async () => {
        throw new Error('redis is down');
      },
      unhit: async () => undefined,
      reset: async () => undefined,
    };
    setAttemptStore(broken);
    for (let i = 0; i < siteLimit.perSite; i++)
      expect((await tryLogin(stranger())).allowed).toBe(true);
    expect((await tryLogin(stranger())).allowed).toBe(false);
  });

  it('keeps hosts, callers and addresses out of the store’s keys', async () => {
    const keys: string[] = [];
    const spy = new MemoryAttemptStore(clock);
    setAttemptStore({
      hit: (key, windowMs) => {
        keys.push(key);
        return spy.hit(key, windowMs);
      },
      unhit: (key) => spy.unhit(key),
      reset: (key) => spy.reset(key),
    });
    await tryLogin({
      ip: '203.0.113.9',
      actor: 'user-secret-id',
      site: 'private-client.example.com',
    });
    expect(keys).toHaveLength(3);
    for (const key of keys) {
      expect(key).toMatch(/^mgs:auth-attempts:site-login:(ip|actor|site):[0-9a-f]{32}$/);
      expect(key).not.toContain('private-client');
      expect(key).not.toContain('user-secret-id');
      expect(key).not.toContain('203.0.113.9');
    }
  });
});
