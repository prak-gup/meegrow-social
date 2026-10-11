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

const USER_AGENT = 'MeegrowSocial/1.0 (WordPress publishing)';
/** The index lists every route of every plugin; `_fields` trims it, the cap covers sites that don't. */
const INDEX_MAX_BYTES = 4 * 1024 * 1024;
const API_MAX_BYTES = 2 * 1024 * 1024;
/** Featured images: WordPress's own default upload limit is host-set and often far lower. */
export const FEATURED_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const DISCOVERY_TIMEOUT_MS = 10_000;
const API_TIMEOUT_MS = 30_000;
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

/** What is stored (encrypted, as the connection's access token) to act as a site's user. */
export interface WordPressCredentials {
  siteUrl: string;
  apiRoot: string;
  username: string;
  password: string;
}

export function encodeCredentials(credentials: WordPressCredentials): string {
  return JSON.stringify({ v: 1, ...credentials });
}

export function decodeCredentials(stored: string): WordPressCredentials {
  let parsed: Partial<WordPressCredentials> | null = null;
  try {
    parsed = JSON.parse(stored) as Partial<WordPressCredentials>;
  } catch {
    // Falls through to the same answer as a blob that parses but is not ours.
  }
  if (
    !parsed ||
    typeof parsed.siteUrl !== 'string' ||
    typeof parsed.apiRoot !== 'string' ||
    typeof parsed.username !== 'string' ||
    typeof parsed.password !== 'string'
  ) {
    // Never include the blob: it is the secret.
    throw new ProviderAuthError('the stored WordPress credentials are unreadable — reconnect');
  }
  return {
    siteUrl: parsed.siteUrl,
    apiRoot: parsed.apiRoot,
    username: parsed.username,
    password: parsed.password,
  };
}

const HTTPS_ONLY =
  'WordPress only issues application passwords to sites served over https. ' +
  'Enter the address starting with https://.';

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
  method?: 'GET' | 'POST';
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

function basicAuth(credentials: WordPressCredentials): string {
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
  private readonly fetchImpl: WordPressFetch;
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
   * handbook, "Discovery"). Makes two unauthenticated requests. Every way this can fail is the
   * person's to fix, so every failure is a `ProviderBadRequestError` that says what to do.
   */
  async discover(input: string): Promise<WordPressSite> {
    const start = normalizeSiteInput(input);

    // 1. Where is the REST root? The front page says so in a Link header. HEAD, as the handbook
    //    prefers — and a site may redirect (bare domain → www) before it answers.
    const front = await this.probe(start, { method: 'HEAD', maxRedirects: 3 });
    const landed = front.url;
    const advertised = apiRootFromLinkHeader(front.headers.link);
    let apiRoot: string;
    if (advertised) {
      let resolved: URL;
      try {
        resolved = new URL(advertised, landed);
      } catch {
        throw new ProviderBadRequestError('The site advertises an invalid REST API address.');
      }
      if (resolved.host !== new URL(landed).host) {
        throw new ProviderBadRequestError(
          'The site points to a REST API on a different host, which is not supported.',
        );
      }
      // A site behind a proxy can advertise http for a root that is served over https.
      resolved.protocol = 'https:';
      apiRoot = resolved.toString();
    } else {
      apiRoot = new URL('wp-json/', landed).toString();
    }

    // 2. What does the index say about authentication?
    const fields = { _fields: 'name,url,home,namespaces,authentication' };
    let index = await this.probe(routeUrl(apiRoot, '/', fields), {
      headers: { accept: 'application/json' },
      maxRedirects: 2,
      maxResponseBytes: INDEX_MAX_BYTES,
    });
    if (!advertised && (index.status === 404 || parseJson(index) === undefined)) {
      // No Link header and no /wp-json/: the plain-permalink form is the remaining possibility.
      apiRoot = new URL('?rest_route=/', landed).toString();
      index = await this.probe(routeUrl(apiRoot, '/', fields), {
        headers: { accept: 'application/json' },
        maxRedirects: 2,
        maxResponseBytes: INDEX_MAX_BYTES,
      });
    }
    const data = parseJson(index) as
      | {
          name?: unknown;
          url?: unknown;
          home?: unknown;
          namespaces?: unknown;
          authentication?: unknown;
          code?: unknown;
        }
      | undefined;

    if (index.status === 401 || index.status === 403) {
      throw new ProviderBadRequestError(
        'This site does not let its REST API be read without logging in — a security plugin is ' +
          'restricting it. Allow REST API access (at least to /wp-json/) and try again.',
      );
    }
    if (index.status !== 200 || data === undefined || data === null || typeof data !== 'object') {
      throw new ProviderBadRequestError(
        'No WordPress REST API was found at that address. Check that it is a WordPress site, and ' +
          'that the REST API has not been disabled by a plugin or blocked by a firewall.',
      );
    }
    if (!Array.isArray(data.namespaces) || !data.namespaces.includes('wp/v2')) {
      throw new ProviderBadRequestError(
        'That site answers like WordPress but does not offer the core REST API (wp/v2). ' +
          'It needs WordPress 5.6 or newer with the REST API enabled.',
      );
    }
    const authentication = data.authentication as
      { 'application-passwords'?: { endpoints?: { authorization?: unknown } } } | undefined;
    const authorize = authentication?.['application-passwords']?.endpoints?.authorization;
    if (typeof authorize !== 'string' || authorize === '') {
      throw new ProviderBadRequestError(
        'Application Passwords are not available on this site. They need WordPress 5.6 or newer ' +
          'served over https, and are switched off by some security plugins (Wordfence and Solid ' +
          'Security do this by default) — enable them in that plugin’s settings and try again.',
      );
    }

    const landedUrl = new URL(landed);
    let authorizeUrl: URL;
    try {
      authorizeUrl = new URL(authorize);
    } catch {
      throw new ProviderBadRequestError('The site advertises an invalid authorization address.');
    }
    // The person is about to be sent here to log in. It must be the site they named, over https.
    if (authorizeUrl.protocol !== 'https:' || authorizeUrl.host !== landedUrl.host) {
      throw new ProviderBadRequestError(
        'The site advertises an authorization page that is not on the same https address, which ' +
          'is not supported. Check the WordPress Address (URL) setting of the site.',
      );
    }
    authorizeUrl.username = '';
    authorizeUrl.password = '';

    const landedBase = `${landedUrl.origin}${landedUrl.pathname}`;
    const siteUrl = typeof data.url === 'string' && data.url !== '' ? data.url : landedBase;
    const home = typeof data.home === 'string' && data.home !== '' ? data.home : landedBase;
    for (const reported of [siteUrl, home]) {
      let host: string;
      try {
        host = new URL(reported).host;
      } catch {
        throw new ProviderBadRequestError('The site reports an invalid address for itself.');
      }
      if (host !== landedUrl.host) {
        throw new ProviderBadRequestError(
          `The site at ${landedUrl.host} says its address is ${host}. Enter that address instead.`,
        );
      }
    }
    return {
      siteUrl,
      home: home.replace(/\/+$/, ''),
      apiRoot,
      authorizeUrl: authorizeUrl.toString(),
      name: plainText(data.name) || landedUrl.host,
    };
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
    credentials: WordPressCredentials,
    route: string,
    request: WordPressRequest = {},
  ): Promise<T> {
    const result = await this.tryRequest<T>(credentials, route, request);
    if ('failure' in result) throw result.failure.error;
    return result.data;
  }

  /** `request`, but a WordPress error answer is returned (with its `code`) instead of thrown. */
  async tryRequest<T>(
    credentials: WordPressCredentials,
    route: string,
    request: WordPressRequest = {},
  ): Promise<{ data: T } | { failure: WordPressFailure }> {
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
        maxResponseBytes: API_MAX_BYTES,
      });
    } catch (err) {
      throw this.transportError(err, request.creates);
    }

    if (response.status >= 300 && response.status < 400) {
      throw new ProviderBadRequestError(
        'The site answered an API request with a redirect, so its address has changed. ' +
          'Reconnect the site using its current https address.',
      );
    }
    const parsed = parseJson(response);
    if (response.status >= 400) return { failure: mapWordPressError(response.status, parsed) };
    if (parsed === undefined) {
      throw new ProviderBadRequestError(
        'The site answered, but not with the JSON WordPress sends (a plugin or the server is ' +
          `adding output to API responses).${request.creates ? ` ${maybeCreated(request.creates)}` : ''}`,
      );
    }
    return { data: parsed as T };
  }

  private transportError(err: unknown, creates?: string): Error {
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

  /**
   * Confirm a freshly issued application password works, and that its user can publish. The call
   * goes to the REST root discovered when the flow STARTED — never to an address taken from the
   * callback — so a forged callback can only ever present credentials to the site that was named.
   */
  async verifyUser(credentials: WordPressCredentials): Promise<{ id: number; name: string }> {
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

function maybeCreated(what: string): string {
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
