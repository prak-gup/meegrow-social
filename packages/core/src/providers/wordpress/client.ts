import {
  ConnectError,
  ProviderAuthError,
  ProviderBadRequestError,
  ProviderTransientError,
} from '../../errors.js';
import {
  safeFetch,
  SafeFetchError,
  SsrfBlockedError,
  type SafeFetchOptions,
  type SafeResponse,
} from '../../net/safe-fetch.js';

/**
 * WordPress REST client for the wordpress provider: site discovery, the Application Passwords
 * authorization URL, authenticated calls and the error taxonomy. Shapes, endpoints and sources are
 * in docs/dev/research/wordpress.md.
 *
 * Every request goes to an address a person typed (or one that site told us about), so every
 * request goes through `safeFetch` — there is no other way out of this file. `fetchImpl` is
 * injectable so contract tests replay fixtures; it has `safeFetch`'s signature, which keeps the
 * guard's options (redirect cap, byte cap, deadline) visible to those tests.
 */

export type WordPressFetch = (url: string, options: SafeFetchOptions) => Promise<SafeResponse>;

/**
 * Identifies this application on a site's Application Passwords screen (`app_id`, a UUID WordPress
 * stores next to the password it issues). One value for every install: it lets a site owner find,
 * or revoke, everything this app was given.
 */
export const WORDPRESS_APP_ID = '5ecbfa40-f445-4971-a801-aebbcaaef97e';
export const WORDPRESS_APP_NAME = 'Meegrow Social';

export const USER_AGENT = 'MeegrowSocial/1.0 (WordPress publishing)';
/** The index lists every route of every plugin; `_fields` trims it, the cap covers sites that don't. */
const INDEX_MAX_BYTES = 4 * 1024 * 1024;
export const API_MAX_BYTES = 2 * 1024 * 1024;
/** A front page read only for its `<link rel="EditURI">`. */
const PAGE_MAX_BYTES = 2 * 1024 * 1024;
/** Featured images: WordPress's own default upload limit is host-set and often far lower. */
export const FEATURED_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const DISCOVERY_TIMEOUT_MS = 10_000;
export const API_TIMEOUT_MS = 30_000;
export const UPLOAD_TIMEOUT_MS = 90_000;

export interface WordPressClientConfig {
  fetchImpl?: WordPressFetch;
  appName?: string;
  appId?: string;
}

/** What discovery learned about a site — everything the connect flow needs to remember. */
export interface WordPressSite {
  /** WordPress Address (`siteurl`): what `site_url()` reports back on the authorization redirect. */
  siteUrl: string;
  /** Site Address (`home`): what visitors type. The connection's identity in this app. */
  home: string;
  /** REST root — `…/wp-json/`, or `…/?rest_route=/` on a site without pretty permalinks. */
  apiRoot: string;
  /** The site's own authorize-application screen, as its REST index advertises it. */
  authorizeUrl: string;
  name: string;
}

/**
 * How a connection talks to its site. `rest` is the REST API with an application password the
 * site issued for this app; `xmlrpc` is `xmlrpc.php` with the user's own login password, for
 * sites where application passwords are switched off. See docs/dev/research/wordpress.md §11.
 */
export type WordPressTransport = 'rest' | 'xmlrpc';

/** REST + application password. `transport` is optional on input: it is what a blob without one is. */
export interface WordPressRestCredentials {
  transport?: 'rest';
  siteUrl: string;
  apiRoot: string;
  username: string;
  password: string;
}

/** XML-RPC + login password. `endpoint` is the `xmlrpc.php` the login was verified against. */
export interface WordPressXmlRpcCredentials {
  transport: 'xmlrpc';
  siteUrl: string;
  endpoint: string;
  username: string;
  password: string;
}

export type ApproveUnavailableReason =
  | 'no_rest_api'
  | 'rest_restricted'
  | 'no_core_api'
  | 'application_passwords_unavailable'
  | 'unconfirmed_address'
  | 'invalid_authorize_url';

/** What `WordPressClient.inspect` learned about an address without logging in. */
export interface WordPressInspection {
  /** Where the typed address finally answered. */
  entered: string;
  name: string | null;
  /** WordPress Address (`siteurl`) and Site Address (`home`), when the site's REST index said. */
  siteUrl: string | null;
  home: string | null;
  /** The two are different addresses — the site is administered at one and read at the other. */
  split: boolean;
  approve:
    | { available: true; site: WordPressSite }
    | { available: false; reason: ApproveUnavailableReason; message: string };
  /** Where `xmlrpc.php` should be, most likely first. Only addresses confirmed to be this site. */
  xmlrpcCandidates: string[];
}

/** What is stored (encrypted, as the connection's access token) to act as a site's user. */
export type WordPressCredentials = WordPressRestCredentials | WordPressXmlRpcCredentials;

export function encodeCredentials(credentials: WordPressCredentials): string {
  return JSON.stringify({ v: 1, ...credentials, transport: credentials.transport ?? 'rest' });
}

/**
 * Read a stored blob back. One written before transports existed has no `transport` and is REST —
 * which is why adding XML-RPC needed no migration.
 */
export function decodeCredentials(
  stored: string,
): Required<WordPressRestCredentials> | WordPressXmlRpcCredentials {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(stored) as Record<string, unknown> | null;
  } catch {
    // Falls through to the same answer as a blob that parses but is not ours.
  }
  const text = (name: string): string | null => {
    const value = parsed?.[name];
    return typeof value === 'string' ? value : null;
  };
  const siteUrl = text('siteUrl');
  const username = text('username');
  const password = text('password');
  const transport = parsed?.transport ?? 'rest';
  const address = transport === 'xmlrpc' ? text('endpoint') : text('apiRoot');
  if (
    siteUrl === null ||
    username === null ||
    password === null ||
    address === null ||
    (transport !== 'rest' && transport !== 'xmlrpc')
  ) {
    // Never include the blob: it is the secret.
    throw new ProviderAuthError('the stored WordPress credentials are unreadable — reconnect');
  }
  return transport === 'xmlrpc'
    ? { transport, siteUrl, endpoint: address, username, password }
    : { transport, siteUrl, apiRoot: address, username, password };
}

const HTTPS_ONLY =
  'WordPress only issues application passwords to sites served over https. ' +
  'Enter the address starting with https://.';

const NO_REST_API =
  'No WordPress REST API was found at that address. Check that it is a WordPress site, and ' +
  'that the REST API has not been disabled by a plugin or blocked by a firewall.';

/** The host of an address a site reports for itself. Throws for anything that is not http(s). */
function httpsHost(address: string): string {
  const url = new URL(address);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('not a web address');
  return url.host;
}

/**
 * A typed site address → the URL discovery starts from. Forgiving about what people paste (no
 * scheme, a `/wp-admin/` or `/wp-login.php` tail, a query string), strict about http. Whether the
 * address may be CONTACTED is not decided here — that is `safeFetch`'s job on the first request.
 */
export function normalizeSiteInput(raw: string): string {
  let text = raw.trim();
  if (text === '') throw new ProviderBadRequestError('Enter the address of the WordPress site.');
  if (/^http:\/\//i.test(text)) throw new ProviderBadRequestError(HTTPS_ONLY);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ProviderBadRequestError('That is not a valid web address.');
  }
  if (url.protocol !== 'https:') throw new ProviderBadRequestError(HTTPS_ONLY);
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/(wp-admin(\/.*)?|wp-login\.php)$/i, '/');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}

/** Two site addresses name the same site: same scheme, host, port and path, trailing slash aside. */
export function sameSite(a: string, b: string): boolean {
  const key = (value: string): string | null => {
    try {
      const url = new URL(value.trim());
      return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`;
    } catch {
      return null;
    }
  };
  const left = key(a);
  return left !== null && left === key(b);
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#039': "'",
  '#39': "'",
  '#8217': '’',
  '#8211': '–',
  nbsp: ' ',
};

/** WordPress messages and names arrive with markup and entities; people read them as plain text. */
export function plainText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<[^>]{0,200}>/g, '')
    .replace(
      /&(#?[a-z0-9]{2,6});/gi,
      (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole,
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

interface WordPressErrorBody {
  code?: unknown;
  message?: unknown;
  data?: { status?: unknown; params?: unknown; term_id?: unknown } | null;
}

/** A WordPress REST failure, with the machine-readable `code` kept for callers that branch on it. */
export interface WordPressFailure {
  error: Error;
  code: string | null;
  body: WordPressErrorBody | null;
}

/**
 * Map a WordPress REST failure onto the sealed taxonomy (errors.ts):
 *  - 401, and a 403 that WordPress itself explains → auth: the password was revoked, or the user
 *    may no longer do this. Reconnecting (as a user who may) is the fix, retrying never is.
 *  - 429 and 5xx → transient.
 *  - a 403 or 404 that is NOT a WordPress answer → bad request, naming the likely cause: a
 *    firewall, or a plugin that turned the REST API off.
 *  - any other 4xx → bad request, with WordPress's own message and the fields it objected to.
 */
export function mapWordPressError(status: number, parsed: unknown): WordPressFailure {
  const body =
    parsed !== null && typeof parsed === 'object' ? (parsed as WordPressErrorBody) : null;
  const code = typeof body?.code === 'string' ? body.code : null;
  const said = plainText(body?.message);
  const suffix = code ? ` [${code}]` : '';
  const says = said ? `WordPress says: ${said}${suffix}` : `HTTP ${status}${suffix}`;
  const fail = (error: Error): WordPressFailure => ({ error, code, body });

  if (status === 401) {
    return fail(
      new ProviderAuthError(
        `The site no longer accepts the saved application password. ${says}. Reconnect the site.`,
      ),
    );
  }
  if (status === 403) {
    if (code) {
      return fail(
        new ProviderAuthError(
          `The connected WordPress user is not allowed to do this. ${says}. ` +
            'Reconnect with a user who can publish posts.',
        ),
      );
    }
    return fail(
      new ProviderBadRequestError(
        'The site refused the request before WordPress saw it (HTTP 403) — a firewall or security ' +
          'plugin is blocking API requests from this server.',
      ),
    );
  }
  if (status === 404) {
    return fail(
      new ProviderBadRequestError(
        code === 'rest_no_route' || !code
          ? `The site's REST API did not recognise the request (HTTP 404${suffix}) — the REST API ` +
              'may have been disabled or restricted by a plugin.'
          : says,
      ),
    );
  }
  if (status === 429 || status >= 500) return fail(new ProviderTransientError(says));

  const params = body?.data?.params;
  const fields =
    params !== null && typeof params === 'object'
      ? Object.entries(params as Record<string, unknown>)
          .slice(0, 5)
          .map(([name, why]) => `${name}: ${plainText(why)}`)
          .join('; ')
      : '';
  return fail(new ProviderBadRequestError(fields ? `${says} (${fields})` : says));
}

export interface WordPressRequest {
  /** Inventory pages may contain multiple long HTML articles, still bounded. */
  maxResponseBytes?: number;
  method?: 'GET' | 'POST' | 'DELETE';
  query?: Record<string, string>;
  /** JSON body. */
  json?: unknown;
  /** Raw upload body (`POST /wp/v2/media`). */
  upload?: { body: Buffer; contentType: string; filename: string };
  timeoutMs?: number;
  /**
   * True for a call that creates something and cannot be told "this is a retry". If the request
   * was sent and the answer never arrived, the thing may exist — so that failure is reported as
   * final, with words, instead of being retried into a duplicate.
   */
  creates?: string;
}

function basicAuth(credentials: WordPressRestCredentials): string {
  const pair = `${credentials.username}:${credentials.password}`;
  return `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`;
}

/** `/wp/v2/posts` against either REST root form. */
export function routeUrl(
  apiRoot: string,
  route: string,
  query: Record<string, string> = {},
): string {
  const url = new URL(apiRoot);
  if (url.searchParams.has('rest_route')) url.searchParams.set('rest_route', route);
  else url.pathname = `${url.pathname.replace(/\/+$/, '')}${route}`;
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return url.toString();
}

function parseJson(response: SafeResponse): unknown {
  try {
    return JSON.parse(response.body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** `Link: <https://example.com/wp-json/>; rel="https://api.w.org/"` → the URL, or null. */
export function apiRootFromLinkHeader(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const match = /^\s*<([^<>]{1,2048})>\s*;(.*)$/s.exec(part);
    if (match && /rel\s*=\s*"?https:\/\/api\.w\.org\/"?/i.test(match[2]!)) return match[1]!;
  }
  return null;
}

export class WordPressClient {
  /** Shared with the XML-RPC client, so one injected fetch covers every request to a site. */
  readonly fetchImpl: WordPressFetch;
  readonly appName: string;
  readonly appId: string;

  constructor(config: WordPressClientConfig = {}) {
    this.fetchImpl = config.fetchImpl ?? ((url, options) => safeFetch(url, options));
    this.appName = config.appName ?? WORDPRESS_APP_NAME;
    this.appId = config.appId ?? WORDPRESS_APP_ID;
  }

  /** One guarded request during connect, with the guard's refusals worded for the person typing. */
  private async probe(url: string, options: SafeFetchOptions): Promise<SafeResponse> {
    try {
      return await this.fetchImpl(url, {
        timeoutMs: DISCOVERY_TIMEOUT_MS,
        ...options,
        headers: { 'user-agent': USER_AGENT, ...options.headers },
      });
    } catch (err) {
      if (err instanceof SsrfBlockedError) throw new ProviderBadRequestError(err.message);
      if (err instanceof SafeFetchError) {
        throw new ProviderBadRequestError(
          err.kind === 'too_many_redirects' || err.kind === 'bad_redirect'
            ? 'The site keeps redirecting. Enter the address it finally lands on.'
            : 'The site did not answer. Check the address, and that the site is online.',
        );
      }
      throw err;
    }
  }

  /**
   * Find a site's REST API and its Application Passwords authorization screen (WordPress REST
   * handbook, "Discovery"). Every way this can fail is the person's to fix, so every failure is a
   * `ProviderBadRequestError` that says what to do.
   */
  async discover(input: string): Promise<WordPressSite> {
    const { approve } = await this.inspect(input);
    if (!approve.available) throw new ProviderBadRequestError(approve.message);
    return approve.site;
  }

  /**
   * Everything that can be learned about an address without logging in: whether the site can be
   * connected by approval (and if not, why), which addresses WordPress itself goes by, and where
   * its `xmlrpc.php` should be. Unauthenticated requests only, all through the guard.
   *
   * Throws only when the address cannot be contacted at all. A site that answers but cannot be
   * connected by approval is a RESULT here, because it may still be connectable another way.
   *
   * Separate addresses. WordPress has two address settings — WordPress Address (`siteurl`, where
   * wp-admin and xmlrpc.php live) and Site Address (`home`, what visitors see) — and they may be
   * on different hosts. The REST root follows `home`, the authorize screen follows `siteurl`. A
   * second host is only ever accepted on mutual evidence, never on one side's say-so:
   *  - the entered host advertises a REST root on another host, and the index served THERE names
   *    the entered host as one of the site's two addresses; or
   *  - the index names another host, and that host's own front page advertises the SAME REST root.
   * Every one of those requests is a fresh address to the guard.
   */
  async inspect(input: string): Promise<WordPressInspection> {
    const start = normalizeSiteInput(input);
    // HEAD, as the handbook prefers — and a site may redirect (bare domain → www) before it answers.
    const front = await this.probe(start, { method: 'HEAD', maxRedirects: 3 });
    const landedUrl = new URL(front.url);
    const entered = `${landedUrl.origin}${landedUrl.pathname}`;
    const base: Pick<WordPressInspection, 'entered' | 'name' | 'siteUrl' | 'home' | 'split'> = {
      entered,
      name: null,
      siteUrl: null,
      home: null,
      split: false,
    };
    const xmlrpcAt = (address: string): string =>
      new URL('xmlrpc.php', address.endsWith('/') ? address : `${address}/`).toString();
    const unavailable = (
      reason: ApproveUnavailableReason,
      message: string,
      known: Partial<typeof base> = {},
      candidates: string[] = [xmlrpcAt(entered)],
    ): WordPressInspection => ({
      ...base,
      ...known,
      approve: { available: false, reason, message },
      xmlrpcCandidates: candidates,
    });

    // 1. Where is the REST root? The front page says so in a Link header.
    const advertised = apiRootFromLinkHeader(front.headers.link);
    let apiRoot: string;
    if (advertised) {
      let resolved: URL;
      try {
        resolved = new URL(advertised, front.url);
      } catch {
        return unavailable('no_rest_api', 'The site advertises an invalid REST API address.');
      }
      // A site behind a proxy can advertise http for a root that is served over https.
      resolved.protocol = 'https:';
      apiRoot = resolved.toString();
    } else {
      apiRoot = new URL('wp-json/', front.url).toString();
    }

    // 2. What does the index say about the site and about authentication?
    const fields = { _fields: 'name,url,home,namespaces,authentication' };
    const readIndex = (root: string): Promise<SafeResponse> =>
      this.probe(routeUrl(root, '/', fields), {
        headers: { accept: 'application/json' },
        maxRedirects: 2,
        maxResponseBytes: INDEX_MAX_BYTES,
      });
    let index: SafeResponse;
    try {
      index = await readIndex(apiRoot);
      if (!advertised && (index.status === 404 || parseJson(index) === undefined)) {
        // No Link header and no /wp-json/: the plain-permalink form is the remaining possibility.
        apiRoot = new URL('?rest_route=/', front.url).toString();
        index = await readIndex(apiRoot);
      }
    } catch (err) {
      if (!(err instanceof ProviderBadRequestError)) throw err;
      return unavailable('no_rest_api', NO_REST_API);
    }
    const data = parseJson(index) as
      | {
          name?: unknown;
          url?: unknown;
          home?: unknown;
          namespaces?: unknown;
          authentication?: unknown;
        }
      | undefined;

    if (index.status === 401 || index.status === 403) {
      return unavailable(
        'rest_restricted',
        'This site does not let its REST API be read without logging in — a security plugin is ' +
          'restricting it. Allow REST API access (at least to /wp-json/) and try again.',
      );
    }
    if (index.status !== 200 || data === undefined || data === null || typeof data !== 'object') {
      return unavailable('no_rest_api', NO_REST_API);
    }

    // 3. Which addresses does the site go by, and is each one really this site?
    const siteUrl = typeof data.url === 'string' && data.url !== '' ? data.url : entered;
    const home = typeof data.home === 'string' && data.home !== '' ? data.home : entered;
    let siteHost: string;
    let homeHost: string;
    try {
      siteHost = httpsHost(siteUrl);
      homeHost = httpsHost(home);
    } catch {
      return unavailable('unconfirmed_address', 'The site reports an invalid address for itself.');
    }
    const rootHost = new URL(apiRoot).host;
    const confirmed = new Set([landedUrl.host]);
    if (rootHost !== landedUrl.host) {
      // The index was read from another host. It counts only if it names the entered host back.
      const namesBoth =
        [siteHost, homeHost].includes(landedUrl.host) && [siteHost, homeHost].includes(rootHost);
      if (!namesBoth) {
        return unavailable(
          'unconfirmed_address',
          `The site at ${landedUrl.host} points to a REST API on ${rootHost}, and the site there ` +
            `does not name ${landedUrl.host} as one of its own addresses. Enter the address of ` +
            'the WordPress site itself.',
        );
      }
      confirmed.add(rootHost);
    }
    for (const [address, host] of [
      [siteUrl, siteHost],
      [home, homeHost],
    ] as const) {
      if (confirmed.has(host)) continue;
      // The index names a host nobody has vouched for yet. Ask that host which REST root it uses.
      if (!(await this.advertisesRoot(address, apiRoot))) {
        return unavailable(
          'unconfirmed_address',
          `The site at ${landedUrl.host} says its address is ${host}. Enter that address instead.`,
        );
      }
      confirmed.add(host);
    }
    const known = {
      name: plainText(data.name) || landedUrl.host,
      siteUrl: siteUrl.replace(/\/+$/, ''),
      home: home.replace(/\/+$/, ''),
      split: !sameSite(siteUrl, home),
    };
    // xmlrpc.php lives at the WordPress Address. The entered address is tried first all the same:
    // it is the one the person vouched for, and on most sites the two are one.
    const candidates = [...new Set([xmlrpcAt(entered), xmlrpcAt(siteUrl)])];

    // 4. Can it be connected by approval?
    if (!Array.isArray(data.namespaces) || !data.namespaces.includes('wp/v2')) {
      return unavailable(
        'no_core_api',
        'That site answers like WordPress but does not offer the core REST API (wp/v2). ' +
          'It needs WordPress 5.6 or newer with the REST API enabled.',
        known,
        candidates,
      );
    }
    const authentication = data.authentication as
      { 'application-passwords'?: { endpoints?: { authorization?: unknown } } } | undefined;
    const authorize = authentication?.['application-passwords']?.endpoints?.authorization;
    if (typeof authorize !== 'string' || authorize === '') {
      return unavailable(
        'application_passwords_unavailable',
        'Application Passwords are not available on this site. They need WordPress 5.6 or newer ' +
          'served over https, and are switched off by some hosts and security plugins (Wordfence ' +
          'and Solid Security do this by default) — enable them in that plugin’s settings and try ' +
          'again.',
        known,
        candidates,
      );
    }
    let authorizeUrl: URL;
    try {
      authorizeUrl = new URL(authorize);
    } catch {
      return unavailable(
        'invalid_authorize_url',
        'The site advertises an invalid authorization address.',
        known,
        candidates,
      );
    }
    // The person is about to be sent here to log in. It must be this site, over https.
    if (authorizeUrl.protocol !== 'https:' || !confirmed.has(authorizeUrl.host)) {
      return unavailable(
        'invalid_authorize_url',
        'The site advertises an authorization page that is not on the same https address, which ' +
          'is not supported. Check the WordPress Address (URL) setting of the site.',
        known,
        candidates,
      );
    }
    authorizeUrl.username = '';
    authorizeUrl.password = '';

    return {
      ...base,
      ...known,
      approve: {
        available: true,
        site: {
          siteUrl,
          home: known.home,
          apiRoot,
          authorizeUrl: authorizeUrl.toString(),
          name: known.name,
        },
      },
      xmlrpcCandidates: candidates,
    };
  }

  /** Does the front page at `address` advertise exactly this REST root? False on any failure. */
  private async advertisesRoot(address: string, apiRoot: string): Promise<boolean> {
    let front: SafeResponse;
    try {
      front = await this.probe(address.endsWith('/') ? address : `${address}/`, {
        method: 'HEAD',
        maxRedirects: 3,
      });
    } catch (err) {
      if (err instanceof ProviderBadRequestError) return false;
      throw err;
    }
    const advertised = apiRootFromLinkHeader(front.headers.link);
    if (!advertised) return false;
    try {
      const resolved = new URL(advertised, front.url);
      resolved.protocol = 'https:';
      return resolved.toString() === apiRoot;
    } catch {
      return false;
    }
  }

  /**
   * Where the page at `address` says its `xmlrpc.php` is: WordPress prints
   * `<link rel="EditURI" type="application/rsd+xml" href="…/xmlrpc.php?rsd">` in every page's head
   * (`rsd_link()`). Used only when nothing answered at the obvious address and the REST index
   * could not say where WordPress lives. Same host only: a page is not evidence about another host.
   */
  async editUriEndpoint(address: string): Promise<string | null> {
    let page: SafeResponse;
    try {
      page = await this.probe(address, {
        headers: { accept: 'text/html' },
        maxRedirects: 3,
        maxResponseBytes: PAGE_MAX_BYTES,
      });
    } catch (err) {
      if (err instanceof ProviderBadRequestError) return null;
      throw err;
    }
    if (page.status !== 200) return null;
    for (const [link] of page.body.toString('utf8').matchAll(/<link\b[^<>]{0,600}>/gi)) {
      if (!/\brel\s*=\s*["']?EditURI\b/i.test(link)) continue;
      const href = /\bhref\s*=\s*["']([^"'<>\s]{1,2048})["']/i.exec(link)?.[1];
      if (!href) continue;
      try {
        const url = new URL(href, page.url);
        if (
          url.protocol !== 'https:' ||
          url.host !== new URL(page.url).host ||
          !url.pathname.endsWith('/xmlrpc.php')
        ) {
          continue;
        }
        return `${url.origin}${url.pathname}`;
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * The authorization screen's URL (wp-admin/authorize-application.php). WordPress appends
   * `site_url`, `user_login` and `password` to `success_url` on approval; on rejection it sends
   * the person to `reject_url` as given.
   */
  authorizeUrl(site: WordPressSite, params: { redirectUri: string; state: string }): string {
    const back = new URL(params.redirectUri);
    back.searchParams.set('state', params.state);
    const success = back.toString();
    back.searchParams.set('error', 'access_denied');
    const url = new URL(site.authorizeUrl);
    url.searchParams.set('app_name', this.appName);
    url.searchParams.set('app_id', this.appId);
    url.searchParams.set('success_url', success);
    url.searchParams.set('reject_url', back.toString());
    return url.toString();
  }

  /** An authenticated REST call. Throws from the provider error taxonomy; never returns a failure. */
  async request<T>(
    credentials: WordPressRestCredentials,
    route: string,
    request: WordPressRequest = {},
  ): Promise<T> {
    const result = await this.tryRequest<T>(credentials, route, request);
    if ('failure' in result) throw result.failure.error;
    return result.data;
  }

  /** `request`, but a WordPress error answer is returned (with its `code`) instead of thrown. */
  async tryRequest<T>(
    credentials: WordPressRestCredentials,
    route: string,
    request: WordPressRequest = {},
  ): Promise<{ data: T; headers: SafeResponse['headers'] } | { failure: WordPressFailure }> {
    const method = request.method ?? 'GET';
    const headers: Record<string, string> = {
      authorization: basicAuth(credentials),
      accept: 'application/json',
      'user-agent': USER_AGENT,
    };
    let body: Buffer | string | undefined;
    if (request.upload) {
      headers['content-type'] = request.upload.contentType;
      headers['content-disposition'] = `attachment; filename="${request.upload.filename}"`;
      body = request.upload.body;
    } else if (request.json !== undefined) {
      headers['content-type'] = 'application/json; charset=utf-8';
      body = JSON.stringify(request.json);
    }

    let response: SafeResponse;
    try {
      // maxRedirects stays 0: a request carrying the password is never replayed somewhere else.
      response = await this.fetchImpl(routeUrl(credentials.apiRoot, route, request.query), {
        method,
        headers,
        body,
        timeoutMs: request.timeoutMs ?? API_TIMEOUT_MS,
        maxResponseBytes: request.maxResponseBytes ?? API_MAX_BYTES,
      });
    } catch (err) {
      throw transportFailure(err, request.creates);
    }

    if (response.status >= 300 && response.status < 400) {
      throw new ProviderBadRequestError(
        'The site answered an API request with a redirect, so its address has changed. ' +
          'Reconnect the site using its current https address.',
      );
    }
    const parsed = parseJson(response);
    if (response.status >= 400) {
      const failure = mapWordPressError(response.status, parsed);
      failure.error.message = failure.error.message
        .split(credentials.password)
        .join('[redacted]')
        .split(basicAuth(credentials))
        .join('[redacted]');
      return { failure };
    }
    if (parsed === undefined) {
      throw new ProviderBadRequestError(
        'The site answered, but not with the JSON WordPress sends (a plugin or the server is ' +
          `adding output to API responses).${request.creates ? ` ${maybeCreated(request.creates)}` : ''}`,
      );
    }
    return { data: parsed as T, headers: response.headers };
  }

  /**
   * Confirm a freshly issued application password works, and that its user can publish. The call
   * goes to the REST root discovered when the flow STARTED — never to an address taken from the
   * callback — so a forged callback can only ever present credentials to the site that was named.
   */
  async verifyUser(credentials: WordPressRestCredentials): Promise<{ id: number; name: string }> {
    let result: { data: WordPressUser } | { failure: WordPressFailure };
    try {
      result = await this.tryRequest<WordPressUser>(credentials, '/wp/v2/users/me', {
        query: { context: 'edit', _fields: 'id,name,slug,capabilities' },
        timeoutMs: DISCOVERY_TIMEOUT_MS,
      });
    } catch {
      throw new ConnectError('site_unreachable');
    }
    if ('failure' in result) {
      if (result.failure.error instanceof ProviderTransientError) {
        throw new ConnectError('site_unreachable');
      }
      throw new ConnectError('credentials_rejected');
    }
    const user = result.data;
    const can = user.capabilities ?? {};
    if (typeof user.id !== 'number' || !can.edit_posts || !can.publish_posts) {
      throw new ConnectError('insufficient_role');
    }
    return { id: user.id, name: plainText(user.name) };
  }

  /**
   * Fetch an image this app is about to upload. The URL comes from a media row, which
   * `register_media_from_url` lets a caller point anywhere — so it gets the same guard as a site.
   */
  async download(url: string): Promise<{ body: Buffer; contentType: string }> {
    let response: SafeResponse;
    try {
      response = await this.fetchImpl(url, {
        maxRedirects: 3,
        maxResponseBytes: FEATURED_IMAGE_MAX_BYTES,
        timeoutMs: UPLOAD_TIMEOUT_MS,
        headers: { 'user-agent': USER_AGENT },
      });
    } catch (err) {
      if (err instanceof SsrfBlockedError && err.reason !== 'dns') {
        throw new ProviderBadRequestError(
          'The featured image is not at a public https address, so it cannot be sent to WordPress.',
        );
      }
      if (err instanceof SafeFetchError && err.kind === 'too_large') {
        throw new ProviderBadRequestError(
          `The featured image is larger than ${FEATURED_IMAGE_MAX_BYTES / (1024 * 1024)} MB.`,
        );
      }
      throw new ProviderTransientError(
        `The featured image could not be fetched: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (response.status >= 500) {
      throw new ProviderTransientError(
        `The featured image could not be fetched (HTTP ${response.status}).`,
      );
    }
    if (response.status !== 200) {
      throw new ProviderBadRequestError(
        `The featured image could not be fetched (HTTP ${response.status}).`,
      );
    }
    const contentType = (response.headers['content-type'] ?? '')
      .split(';')[0]!
      .trim()
      .toLowerCase();
    return { body: response.body, contentType };
  }
}

/**
 * A request that never produced an answer, in the provider taxonomy. Shared by both transports:
 * the rule that a timeout AFTER the request was sent is final for a call that creates something
 * (`creates`) is what keeps a retry from publishing an article twice.
 */
export function transportFailure(err: unknown, creates?: string): Error {
  if (err instanceof SsrfBlockedError) {
    // A name that stops resolving is a blip; one that now resolves somewhere private is not.
    return err.reason === 'dns'
      ? new ProviderTransientError('The site’s address could not be looked up.')
      : new ProviderBadRequestError(
          'The site’s address no longer leads to a public website, so nothing was sent.',
        );
  }
  if (err instanceof SafeFetchError) {
    if (creates && err.requestSent) {
      return new ProviderBadRequestError(
        `The site did not answer in time. ${maybeCreated(creates)}`,
      );
    }
    if (err.kind === 'timeout' || err.kind === 'network') {
      return new ProviderTransientError(`The site could not be reached: ${err.message}`);
    }
    return new ProviderBadRequestError(`The site’s answer could not be used: ${err.message}`);
  }
  return new ProviderTransientError(
    `WordPress request failed: ${err instanceof Error ? err.message : String(err)}`,
  );
}

export function maybeCreated(what: string): string {
  return (
    `${what} may or may not have been created — check the site before retrying, ` +
    'so it is not published twice.'
  );
}

interface WordPressUser {
  id?: unknown;
  name?: unknown;
  capabilities?: Record<string, unknown>;
}
