import { lookup as dnsLookup } from 'node:dns/promises';
import https from 'node:https';
import type http from 'node:http';
import { isIP } from 'node:net';

/**
 * The ONE place this codebase makes an HTTP request to an address somebody typed in.
 *
 * A URL supplied by an operator, a client or an agent is a server-side request forgery vector: the
 * request leaves from our server, so `https://169.254.169.254/…`, `https://10.0.0.5/…` or a public
 * name that resolves to either reaches things the person asking could never reach themselves.
 * Everything below exists to make sure the socket only ever opens to a public address:
 *
 *  1. `assertSafeUrl` — https only, no credentials in the URL, port 443 only, no internal-looking
 *     names, and an IP literal must itself be public. The WHATWG parser has already folded the
 *     decimal / hex / octal / short forms (`2130706433`, `0x7f.1`, `017700000001`) into dotted
 *     decimal by then, so they are checked as the address they really are.
 *  2. The name is resolved ONCE and EVERY returned address must be public — one private record
 *     among several public ones is refused, since which one the socket picks is not ours to say.
 *  3. The request is PINNED to that validated address (`lookup` override below), so a second DNS
 *     answer cannot swap it between the check and the connect (DNS rebinding). TLS still verifies
 *     the certificate against the hostname.
 *  4. Redirects are never followed by the socket layer. `maxRedirects` (default 0) follows them
 *     here, one hop at a time, each hop re-validated from step 1; only GET/HEAD are replayed and
 *     `Authorization` never crosses to another origin.
 *  5. The response is capped in bytes and the whole call in time.
 *
 * `deps` are injectable so the guard is unit-tested without a network.
 */

export type SsrfReason =
  'invalid_url' | 'scheme' | 'credentials' | 'port' | 'hostname' | 'address' | 'dns';

/** The URL (or what it resolved to) is not somewhere this server will connect. Never retry. */
export class SsrfBlockedError extends Error {
  constructor(
    readonly reason: SsrfReason,
    message: string,
  ) {
    super(message);
  }
}

export type SafeFetchFailure =
  'timeout' | 'too_large' | 'too_many_redirects' | 'bad_redirect' | 'network';

/** The request was allowed but did not complete. `timeout` and `network` are worth a retry. */
export class SafeFetchError extends Error {
  constructor(
    readonly kind: SafeFetchFailure,
    message: string,
    /**
     * True when the request had been written to the socket before it failed, so the far side may
     * have acted on it. What a caller of a non-idempotent endpoint needs to know before retrying.
     */
    readonly requestSent = false,
  ) {
    super(message);
  }
}

// --- Address classification -------------------------------------------------------------------

/** [first address, prefix length, why it is refused]. */
const BLOCKED_V4: ReadonlyArray<readonly [string, number, string]> = [
  ['0.0.0.0', 8, 'unspecified ("this network")'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'carrier-grade NAT'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local (includes cloud metadata)'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'IETF protocol assignments'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, '6to4 relay'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved / broadcast'],
];

/** Strict dotted decimal → 32-bit number. Anything else (short, hex, octal forms) is null. */
export function parseIpv4(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

function blockedV4(value: number): string | null {
  for (const [base, bits, why] of BLOCKED_V4) {
    const start = parseIpv4(base)!;
    const size = 2 ** (32 - bits);
    if (value >= start && value < start + size) return why;
  }
  return null;
}

/** An IPv6 address as its eight 16-bit groups, or null. Accepts `::` and a dotted-quad tail. */
export function parseIpv6(text: string): number[] | null {
  // A zone id (`fe80::1%eth0`) names a local interface; nothing public carries one.
  if (text.includes('%')) return null;
  let source = text;
  const tail: number[] = [];
  const lastColon = source.lastIndexOf(':');
  if (source.slice(lastColon + 1).includes('.')) {
    const v4 = parseIpv4(source.slice(lastColon + 1));
    if (v4 === null) return null;
    tail.push(Math.floor(v4 / 65536), v4 % 65536);
    source = source.slice(0, lastColon + 1);
    // "::1.2.3.4" leaves "::"; "64:ff9b::1.2.3.4" leaves "64:ff9b::"; "a:b:1.2.3.4" leaves "a:b:".
    if (!source.endsWith('::')) source = source.slice(0, -1);
  }
  const halves = source.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = groups(halves[0] ?? '');
  const rest = halves.length === 2 ? groups(halves[1] ?? '') : [];
  if (!head || !rest) return null;
  const fixed = head.length + rest.length + tail.length;
  if (halves.length === 2) {
    if (fixed > 7) return null;
    return [...head, ...new Array<number>(8 - fixed).fill(0), ...rest, ...tail];
  }
  return fixed === 8 ? [...head, ...tail] : null;
}

function blockedV6(g: number[]): string | null {
  const v4At = (i: number): number => g[i]! * 65536 + g[i + 1]!;
  const zeros = (from: number, to: number): boolean => g.slice(from, to).every((x) => x === 0);

  if (zeros(0, 8)) return 'unspecified';
  if (zeros(0, 7) && g[7] === 1) return 'loopback';
  // IPv4-mapped (::ffff:a.b.c.d): the socket really goes to the IPv4 address — judge that.
  if (zeros(0, 5) && g[5] === 0xffff) return blockedV4(v4At(6));
  // IPv4-compatible (::a.b.c.d), deprecated: nothing legitimate is served there.
  if (zeros(0, 6)) return 'IPv4-compatible (deprecated)';
  // NAT64 well-known prefix embeds an IPv4 address; the local-use prefix is never public.
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    if (zeros(2, 6)) return blockedV4(v4At(6)) ?? null;
    return 'NAT64 local-use';
  }
  // Only global unicast (2000::/3) is public. That alone refuses unique-local (fc00::/7),
  // link-local (fe80::/10), site-local (fec0::/10), multicast (ff00::/8) and the discard prefix.
  if ((g[0]! & 0xe000) !== 0x2000) return 'not a global unicast address';
  if (g[0] === 0x2001 && g[1] === 0x0db8) return 'documentation';
  if (g[0] === 0x2001 && g[1] === 0) return 'Teredo tunnel';
  // 6to4 (2002:AABB:CCDD::/48) routes to the embedded IPv4 address.
  if (g[0] === 0x2002) return blockedV4(v4At(1));
  return null;
}

/**
 * Why this IP address must not be connected to, or null when it is public. An address that does not
 * parse is refused: anything this function cannot read is not something to open a socket to.
 */
export function blockedAddressReason(address: string): string | null {
  const text = address.replace(/^\[|\]$/g, '');
  const family = isIP(text);
  if (family === 4) {
    const v4 = parseIpv4(text);
    return v4 === null ? 'unreadable address' : blockedV4(v4);
  }
  if (family === 6 || text.includes(':')) {
    const v6 = parseIpv6(text);
    return v6 === null ? 'unreadable address' : blockedV6(v6);
  }
  return 'unreadable address';
}

// --- URL validation ---------------------------------------------------------------------------

/** Names that only mean something inside a private network. A public site is never served here. */
const INTERNAL_SUFFIXES = [
  'localhost',
  'local',
  'internal',
  'intranet',
  'lan',
  'home',
  'corp',
  'home.arpa',
];

export interface SafeUrlOptions {
  /** Ports a URL may name. Default: 443 only — a guard that lets any port through is a port scanner. */
  allowedPorts?: readonly number[];
}

/** The hostname of a parsed URL as it is checked and resolved: no brackets, no trailing dot. */
function bareHost(url: URL): string {
  return url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

/**
 * Parse and validate a user-supplied URL. Throws `SsrfBlockedError`; the message is written for the
 * person who typed the address and never repeats a resolved internal address back.
 */
export function assertSafeUrl(raw: string, options: SafeUrlOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfBlockedError('invalid_url', 'That is not a valid web address.');
  }
  if (url.protocol !== 'https:') {
    throw new SsrfBlockedError('scheme', 'The address must start with https://.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new SsrfBlockedError(
      'credentials',
      'The address must not contain a username or password.',
    );
  }
  const port = url.port === '' ? 443 : Number(url.port);
  if (!(options.allowedPorts ?? [443]).includes(port)) {
    throw new SsrfBlockedError('port', 'The address must use the standard https port (443).');
  }
  const host = bareHost(url);
  if (host === '') throw new SsrfBlockedError('hostname', 'The address has no host name.');
  if (isIP(host) !== 0) {
    if (blockedAddressReason(host) !== null) {
      throw new SsrfBlockedError('address', 'That address is not a public website.');
    }
    return url;
  }
  const internal =
    !host.includes('.') || INTERNAL_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
  if (internal) {
    throw new SsrfBlockedError('hostname', 'That address is not a public website.');
  }
  return url;
}

// --- Resolution + pinned transport --------------------------------------------------------------

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

const systemResolver: Resolver = async (hostname) => {
  const found = await dnsLookup(hostname, { all: true, verbatim: true });
  return found.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

/** One request, already validated, to be sent to `address` and nowhere else. */
export interface PinnedRequest {
  url: URL;
  address: string;
  family: 4 | 6;
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
  timeoutMs: number;
  maxResponseBytes: number;
}

export interface RawResponse {
  status: number;
  /** Lower-cased names; repeated headers joined with ", ". */
  headers: Record<string, string>;
  body: Buffer;
}

export type Transport = (request: PinnedRequest) => Promise<RawResponse>;

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;

/**
 * A `lookup` for `http(s).request` that answers with the already-validated address whatever name
 * it is asked about — this is the pin. Node asks with `all: true` when it races address families
 * and expects a list back, and with `all` unset expects a single address.
 */
export function pinnedLookup(address: string, family: 4 | 6) {
  return (_hostname: string, options: unknown, callback?: LookupCallback): void => {
    const cb = (typeof options === 'function' ? options : callback) as LookupCallback;
    const all = typeof options === 'object' && options !== null && 'all' in options && options.all;
    if (all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  };
}

/**
 * The real transport: `node:https`, one connection per request (no agent — a pooled socket would
 * outlive the validation that allowed it). `requestImpl` exists so the pinning, the byte cap and
 * the deadline can be exercised against a local plain-http listener in tests.
 */
export function nodeTransport(requestImpl: typeof http.request = https.request): Transport {
  return (request) =>
    new Promise<RawResponse>((resolve, reject) => {
      const { url, body } = request;
      let sent = false;
      let settled = false;
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.destroy();
        reject(err);
      };
      const headers: Record<string, string> = { ...request.headers, host: url.host };
      if (body) headers['content-length'] = String(body.byteLength);

      const req = requestImpl({
        protocol: url.protocol,
        hostname: bareHost(url),
        port: url.port === '' ? undefined : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers,
        agent: false,
        lookup: pinnedLookup(request.address, request.family) as never,
      });
      const timer = setTimeout(
        () =>
          fail(
            new SafeFetchError(
              'timeout',
              `no answer from ${url.host} within ${request.timeoutMs} ms`,
              sent,
            ),
          ),
        request.timeoutMs,
      );
      req.on('finish', () => {
        sent = true;
      });
      req.on('error', (err) =>
        fail(new SafeFetchError('network', `could not reach ${url.host}: ${err.message}`, sent)),
      );
      req.on('response', (res) => {
        const tooLarge = (): void =>
          fail(
            new SafeFetchError(
              'too_large',
              `${url.host} answered with more than ${request.maxResponseBytes} bytes`,
              true,
            ),
          );
        // A HEAD answer declares the length of a body it does not send.
        const declared = request.method === 'HEAD' ? 0 : Number(res.headers['content-length']);
        if (declared > request.maxResponseBytes) return tooLarge();
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > request.maxResponseBytes) return tooLarge();
          chunks.push(chunk);
        });
        res.on('error', (err) =>
          fail(
            new SafeFetchError('network', `connection to ${url.host} broke: ${err.message}`, true),
          ),
        );
        res.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const out: Record<string, string> = {};
          for (const [name, value] of Object.entries(res.headers)) {
            if (value !== undefined) out[name] = Array.isArray(value) ? value.join(', ') : value;
          }
          resolve({ status: res.statusCode ?? 0, headers: out, body: Buffer.concat(chunks) });
        });
      });
      req.end(body);
    });
}

// --- safeFetch ----------------------------------------------------------------------------------

export interface SafeFetchOptions extends SafeUrlOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  /** Deadline for the WHOLE call, redirects and DNS included. Default 15 s. */
  timeoutMs?: number;
  /** Largest response body accepted. Default 2 MB. */
  maxResponseBytes?: number;
  /** Redirect hops to follow (GET/HEAD only), each re-validated. Default 0: a 3xx is returned. */
  maxRedirects?: number;
}

export interface SafeFetchDeps {
  resolve?: Resolver;
  transport?: Transport;
}

export interface SafeResponse extends RawResponse {
  /** The URL that produced this response — differs from the request's after a followed redirect. */
  url: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Resolve a validated URL's host and insist every address it has is public. */
async function resolvePublic(
  url: URL,
  resolve: Resolver,
  timeoutMs: number,
): Promise<ResolvedAddress> {
  const host = bareHost(url);
  const literal = isIP(host);
  if (literal !== 0) return { address: host, family: literal === 6 ? 6 : 4 };

  let timer: NodeJS.Timeout | undefined;
  let addresses: ResolvedAddress[];
  try {
    addresses = await Promise.race([
      resolve(host),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new SafeFetchError('timeout', `looking up ${host} took too long`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (err) {
    if (err instanceof SafeFetchError) throw err;
    throw new SsrfBlockedError('dns', `The address ${host} could not be found.`);
  } finally {
    clearTimeout(timer);
  }
  if (addresses.length === 0) {
    throw new SsrfBlockedError('dns', `The address ${host} could not be found.`);
  }
  if (addresses.some((a) => blockedAddressReason(a.address) !== null)) {
    throw new SsrfBlockedError('address', 'That address is not a public website.');
  }
  return addresses[0]!;
}

/**
 * Fetch a user-supplied URL without letting it reach anything private. See the file header for
 * what is enforced. Throws `SsrfBlockedError` (refused) or `SafeFetchError` (allowed, but failed).
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
  deps: SafeFetchDeps = {},
): Promise<SafeResponse> {
  const resolve = deps.resolve ?? systemResolver;
  const transport = deps.transport ?? nodeTransport();
  const method = (options.method ?? 'GET').toUpperCase();
  const maxRedirects = options.maxRedirects ?? 0;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const body = typeof options.body === 'string' ? Buffer.from(options.body, 'utf8') : options.body;

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }

  let current = assertSafeUrl(rawUrl, options);
  for (let hops = 0; ; hops++) {
    const remaining = (): number => {
      const left = deadline - Date.now();
      if (left <= 0) throw new SafeFetchError('timeout', `no answer from ${current.host} in time`);
      return left;
    };
    const target = await resolvePublic(current, resolve, remaining());
    const response = await transport({
      url: current,
      address: target.address,
      family: target.family,
      method,
      headers: { ...headers },
      body,
      timeoutMs: remaining(),
      maxResponseBytes,
    });

    const location = response.headers.location;
    if (maxRedirects === 0 || !REDIRECT_STATUSES.has(response.status) || !location) {
      return { ...response, url: current.toString() };
    }
    if (hops >= maxRedirects) {
      throw new SafeFetchError(
        'too_many_redirects',
        `${current.host} redirected more than ${maxRedirects} times`,
      );
    }
    if (method !== 'GET' && method !== 'HEAD') {
      throw new SafeFetchError(
        'bad_redirect',
        `${current.host} answered a ${method} request with a redirect`,
        true,
      );
    }
    let next: string;
    try {
      next = new URL(location, current).toString();
    } catch {
      throw new SafeFetchError('bad_redirect', `${current.host} redirected to an invalid address`);
    }
    // Every hop is a brand-new user-supplied URL as far as the guard is concerned.
    const validated = assertSafeUrl(next, options);
    if (validated.origin !== current.origin) delete headers.authorization;
    current = validated;
  }
}
