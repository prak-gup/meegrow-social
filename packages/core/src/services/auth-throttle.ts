import { createHash } from 'node:crypto';
import { isIPv6 } from 'node:net';

/**
 * Brute-force protection for password checks (`POST /v1/auth/login`, `POST /v1/auth/password`).
 *
 * Every attempt is counted against two keys before the password is looked at: the client IP and
 * the account being guessed. Per-IP alone is beaten by a botnet guessing one account; per-account
 * alone lets one client spray every account. Counting BEFORE the check (and giving the count back
 * afterwards when it was not a wrong guess) keeps the limit exact under concurrency — a
 * check-then-count design lets a burst of parallel guesses through on one stale read — and means a
 * blocked request never costs an argon2 verify.
 *
 * Windows are fixed: a key's window opens at its first counted attempt and is not extended by
 * later ones, so hammering a blocked account cannot keep it blocked past the window.
 */

export interface AttemptCount {
  /** Attempts counted on the key in its current window, this one included. */
  count: number;
  /** Milliseconds until the key's window closes and the count starts again. */
  resetInMs: number;
}

/**
 * Port for the attempt counters. The API runs as more than one process, so production wires a
 * Redis-backed store (apps/api); `MemoryAttemptStore` is the default for dev and tests, and the
 * fallback when the configured store is unreachable.
 */
export interface AttemptStore {
  /** Count one attempt on `key`, opening a `windowMs` window if the key has none. */
  hit(key: string, windowMs: number): Promise<AttemptCount>;
  /** Give one counted attempt back. Does nothing for a key with no open window. */
  unhit(key: string): Promise<void>;
  /** Forget the key: its next attempt opens a fresh window. */
  reset(key: string): Promise<void>;
}

/** Entries above which a hit sweeps out closed windows, so abandoned keys cannot pile up. */
const MEMORY_SWEEP_THRESHOLD = 10_000;

/** Process-local `AttemptStore`. Correct for one process; N processes multiply every limit by N. */
export class MemoryAttemptStore implements AttemptStore {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async hit(key: string, windowMs: number): Promise<AttemptCount> {
    const now = this.now();
    let entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      if (this.entries.size >= MEMORY_SWEEP_THRESHOLD) this.sweep(now);
      entry = { count: 0, resetAt: now + windowMs };
      this.entries.set(key, entry);
    }
    entry.count += 1;
    return { count: entry.count, resetInMs: entry.resetAt - now };
  }

  async unhit(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= this.now()) return;
    entry.count -= 1;
    if (entry.count <= 0) this.entries.delete(key);
  }

  async reset(key: string): Promise<void> {
    this.entries.delete(key);
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.entries) if (entry.resetAt <= now) this.entries.delete(key);
  }
}

export type AuthAttemptScope = 'login' | 'password' | 'connect' | 'people';

export interface AttemptLimit {
  /** Length of the fixed window, opened by a key's first counted attempt. */
  windowMs: number;
  /** Wrong guesses allowed against one account per window, from any number of addresses. */
  perAccount: number;
  /** Wrong guesses allowed from one address per window, across any number of accounts. */
  perIp: number;
}

/**
 * Defaults. Only wrong guesses use up a limit — a success gives its count back — so nobody who
 * knows their password is slowed down.
 *
 * - login, per account: 10 per 15 minutes. Room for a person fumbling a password manager, while a
 *   distributed attacker gets under 1,000 guesses a day at one account, whatever its address count.
 * - login, per IP: 30 per 15 minutes. Above the per-account figure because an agency office shares
 *   one address; it caps one client spraying a common password across many accounts.
 * - password change, per account: 5 per 15 minutes. The caller is already signed in and is proving
 *   a password they just used, so a wrong one is far less likely to be innocent — and the realistic
 *   attacker here holds a stolen session cookie.
 *
 * The cost of per-account limiting: anyone who knows an email address can keep that one account
 * locked out of login by spending its guesses. The per-IP limit stops one address doing that to
 * every account, and the fixed window bounds each lockout at 15 minutes.
 */
export const AUTH_ATTEMPT_LIMITS: Record<AuthAttemptScope, AttemptLimit> = {
  people: { windowMs: 15 * 60 * 1000, perAccount: 10, perIp: 30 },
  login: { windowMs: 15 * 60 * 1000, perAccount: 10, perIp: 30 },
  password: { windowMs: 15 * 60 * 1000, perAccount: 5, perIp: 30 },
  // Credential connects (services/credential-connect.ts): each one makes this server present a
  // token to a platform, so it is a guess like any other. "Account" is a workspace + platform.
  connect: { windowMs: 15 * 60 * 1000, perAccount: 10, perIp: 30 },
};

/**
 * How long the configured store may take before an attempt falls back to the in-process store. A
 * Redis client that has lost its server queues commands and retries for a long time; login must
 * not hang on that.
 */
export const ATTEMPT_STORE_TIMEOUT_MS = 1000;

let _store: AttemptStore = new MemoryAttemptStore();
let _fallback: AttemptStore = new MemoryAttemptStore();

/** Wire the shared store at startup (apps/api). Without it, counting is per process. */
export function setAttemptStore(store: AttemptStore): void {
  _store = store;
}

/** Forget every counted attempt and go back to the in-process store. For tests. */
export function resetAttemptStore(): void {
  _store = new MemoryAttemptStore();
  _fallback = new MemoryAttemptStore();
}

/** What an attempt turned out to be. Until settled, an attempt counts as a wrong guess. */
export type AttemptResult =
  /** The password was wrong: the attempt stays counted against both keys. */
  | 'failed'
  /** The password was right: the account's count is cleared and the address gets this one back. */
  | 'succeeded'
  /** No password was checked (bad input, an internal error): both keys get this attempt back. */
  | 'not_a_guess';

export type AttemptGate =
  | { allowed: true; settle(result: AttemptResult): Promise<void> }
  | { allowed: false; retryAfterSeconds: number };

/**
 * What "one address" means for the per-IP limit. IPv4 is taken as is. An IPv6 client is counted
 * by its /64: a single subscriber is routinely handed a whole /64, so counting each address
 * separately would give one client 2^64 fresh budgets. An IPv4-mapped IPv6 address
 * (`::ffff:203.0.113.7`) counts as the IPv4 address it carries.
 */
export function clientAddressBucket(ip: string): string {
  const address = ip.trim().toLowerCase().replace(/%.*$/, ''); // drop a zone id (fe80::1%eth0)
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped) return mapped[1]!;
  if (!isIPv6(address)) return address;
  const [head = '', tail] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups =
    tail === undefined
      ? left
      : [
          ...left,
          ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'),
          ...right,
        ];
  const prefix = groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16));
  return `${prefix.join(':')}::/64`;
}

function attemptKey(scope: AuthAttemptScope, dimension: 'ip' | 'account', value: string): string {
  // Hashed: an email or address never appears in a store key, and the key length stays bounded.
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 32);
  return `mgs:auth-attempts:${scope}:${dimension}:${digest}`;
}

function withTimeout<T>(op: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('attempt store timed out')),
      ATTEMPT_STORE_TIMEOUT_MS,
    );
    op.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

const retryAfterSeconds = (hit: AttemptCount): number =>
  Math.max(1, Math.ceil(hit.resetInMs / 1000));

/**
 * Limits for checking a username and password against SOMEBODY ELSE'S site (connecting a
 * WordPress site by login, `connectWithPassword`). The danger is different from our own login:
 * here this server is the one doing the guessing, from its own address, at a site that never
 * asked to be tested. So three things are counted, and a success gives back only its own attempt
 * — it never clears a counter, or one known login would wipe the slate between guesses at another:
 *
 * - per site (the host the login is sent to), from everyone together: 5 wrong logins an hour. A
 *   person mistyping has room; nobody gets more than 120 guesses a day at one site through us.
 * - per caller (the signed-in user, or the API key's client): 10 an hour across all sites, so one
 *   account cannot spray a common password over many sites.
 * - per client address: 20 an hour, above the per-caller figure because an office shares one.
 */
export const SITE_LOGIN_LIMIT = {
  windowMs: 60 * 60 * 1000,
  perSite: 5,
  perActor: 10,
  perIp: 20,
} as const;

export interface SiteLoginSubject {
  /** The real client address, as for `beginAuthAttempt`. */
  ip: string;
  /** Who is asking: a user id, or the workspace of an API key. */
  actor: string;
  /** The host the login would be sent to. */
  site: string;
}

function siteLoginKey(dimension: 'ip' | 'actor' | 'site', value: string): string {
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 32);
  return `mgs:auth-attempts:site-login:${dimension}:${digest}`;
}

async function countSiteLogin(
  store: AttemptStore,
  keys: ReadonlyArray<readonly [key: string, max: number]>,
  windowMs: number,
): Promise<AttemptGate> {
  // In order, stopping at the first refusal: a blocked address or caller must not be able to
  // spend the guesses of a site it names.
  for (const [key, max] of keys) {
    const hit = await store.hit(key, windowMs);
    if (hit.count > max) return { allowed: false, retryAfterSeconds: retryAfterSeconds(hit) };
  }
  return {
    allowed: true,
    async settle(result) {
      if (result === 'failed') return;
      await withTimeout(Promise.all(keys.map(([key]) => store.unhit(key)))).catch(() => undefined);
    },
  };
}

/**
 * Count one login attempt against a third-party site, then say whether it may go ahead. Same
 * contract as `beginAuthAttempt`: an allowed caller MUST `settle`, and an attempt never settled
 * stays counted as a wrong guess. Falls back to in-process counting if the store is unreachable.
 */
export async function beginSiteLoginAttempt(
  subject: SiteLoginSubject,
  limit: { windowMs: number; perSite: number; perActor: number; perIp: number } = SITE_LOGIN_LIMIT,
): Promise<AttemptGate> {
  const keys = [
    [siteLoginKey('ip', clientAddressBucket(subject.ip)), limit.perIp],
    [siteLoginKey('actor', subject.actor), limit.perActor],
    [siteLoginKey('site', subject.site.trim().toLowerCase()), limit.perSite],
  ] as const;
  try {
    return await withTimeout(countSiteLogin(_store, keys, limit.windowMs));
  } catch {
    return countSiteLogin(_fallback, keys, limit.windowMs);
  }
}

async function countAttempt(
  store: AttemptStore,
  ipKey: string,
  accountKey: string,
  limit: AttemptLimit,
): Promise<AttemptGate> {
  // Address first: a blocked address must not be able to mint account keys, or spend the guesses
  // of accounts it names.
  const ipHit = await store.hit(ipKey, limit.windowMs);
  if (ipHit.count > limit.perIp) {
    return { allowed: false, retryAfterSeconds: retryAfterSeconds(ipHit) };
  }
  const accountHit = await store.hit(accountKey, limit.windowMs);
  if (accountHit.count > limit.perAccount) {
    return { allowed: false, retryAfterSeconds: retryAfterSeconds(accountHit) };
  }
  return {
    allowed: true,
    async settle(result) {
      if (result === 'failed') return;
      // Best effort: a give-back that fails only leaves this client counted one attempt too many.
      await withTimeout(
        Promise.all([
          result === 'succeeded' ? store.reset(accountKey) : store.unhit(accountKey),
          // The address only ever gets its own attempt back, never a reset — otherwise signing in
          // to an account you own would wipe the slate between guesses at someone else's.
          store.unhit(ipKey),
        ]),
      ).catch(() => undefined);
    },
  };
}

/**
 * Count one password attempt, then say whether it may go ahead. An allowed caller MUST `settle`
 * once it knows the outcome; an attempt that is never settled stays counted as a wrong guess.
 *
 * `account` is whatever identifies the account being guessed — the submitted email for login
 * (known or not, so an unknown address is throttled exactly like a real one), the user id for a
 * password change. `ip` must be the real client address, not the reverse proxy's.
 *
 * If the configured store fails or stalls, the attempt is counted in this process instead: limits
 * degrade to per-process, never to none, and an outage of the store cannot lock anyone out.
 */
export async function beginAuthAttempt(
  scope: AuthAttemptScope,
  subject: { ip: string; account: string },
  limit: AttemptLimit = AUTH_ATTEMPT_LIMITS[scope],
): Promise<AttemptGate> {
  const ipKey = attemptKey(scope, 'ip', clientAddressBucket(subject.ip));
  const accountKey = attemptKey(scope, 'account', subject.account);
  try {
    return await withTimeout(countAttempt(_store, ipKey, accountKey, limit));
  } catch {
    return countAttempt(_fallback, ipKey, accountKey, limit);
  }
}
