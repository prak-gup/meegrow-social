import { describe, expect, it } from 'vitest';
import { articleMarkdownToHtml } from '@meegrow-social/contracts';
import {
  ConnectError,
  ProviderAuthError,
  ProviderBadRequestError,
  ProviderTransientError,
} from '../../errors.js';
import {
  SafeFetchError,
  SsrfBlockedError,
  type SafeFetchOptions,
  type SafeResponse,
} from '../../net/safe-fetch.js';
import type { AuthTokens, PostDetails } from '../types.js';
import {
  apiRootFromLinkHeader,
  decodeCredentials,
  encodeCredentials,
  mapWordPressError,
  normalizeSiteInput,
  plainText,
  routeUrl,
  sameSite,
  WORDPRESS_APP_ID,
  WordPressClient,
  type WordPressFetch,
} from './client.js';
import { WordPressProvider } from './wordpress.js';

/**
 * Canned WordPress answers for the provider's contract tests.
 *
 * DOCUMENTATION-BUILT, NOT RECORDED. No request was ever made to a WordPress site to produce
 * these: the shapes are transcribed from the REST API handbook and from WordPress core's source
 * (URLs in docs/dev/research/wordpress.md §10). They prove this code handles what WordPress is
 * documented to send; whether a real site sends exactly that is what the live bring-up checklist
 * in that note is for. Re-record them there.
 */

const SITE = 'https://blog.example.com';
const API_ROOT = `${SITE}/wp-json/`;

/** `GET /wp-json/` — the REST index, trimmed with `_fields` (class-wp-rest-server.php `get_index`). */
const INDEX = {
  name: 'Ecolive &amp; Co',
  url: SITE,
  home: SITE,
  namespaces: ['oembed/1.0', 'wp/v2', 'wp-site-health/v1'],
  // Added by rest_add_application_passwords_to_index() when application passwords are available.
  authentication: {
    'application-passwords': {
      endpoints: { authorization: `${SITE}/wp-admin/authorize-application.php` },
    },
  },
};

/** `GET /wp/v2/users/me?context=edit` for an Editor. */
const USER_ME = {
  id: 7,
  name: 'Priya Editor',
  slug: 'priya',
  capabilities: { edit_posts: true, publish_posts: true, upload_files: true },
};

/** `POST /wp/v2/posts` → 201. */
const CREATED_POST = {
  id: 1284,
  date: '2026-10-11T09:30:00',
  date_gmt: '2026-10-11T09:30:00',
  status: 'publish',
  type: 'post',
  slug: 'five-ways-to-cut-plastic',
  link: `${SITE}/2026/10/five-ways-to-cut-plastic/`,
  title: { raw: 'Five ways to cut plastic', rendered: 'Five ways to cut plastic' },
  featured_media: 0,
};

/** `POST /wp/v2/media` → 201. */
const CREATED_MEDIA = {
  id: 551,
  media_type: 'image',
  mime_type: 'image/jpeg',
  source_url: `${SITE}/wp-content/uploads/2026/10/five-ways-to-cut-plastic.jpg`,
};

/** WordPress's error envelope (WP_Error → JSON): `{ code, message, data: { status } }`. */
const wpError = (code: string, message: string, status: number, data: object = {}) => ({
  code,
  message,
  data: { status, ...data },
});

interface Fixture {
  /** `"METHOD substring-of-url"`, a bare `"METHOD"`, or a bare substring — first match wins. */
  match: string;
  status?: number;
  /** JSON-encoded unless `raw` is given. */
  body?: unknown;
  raw?: string | Buffer;
  headers?: Record<string, string>;
  /** Answer as if this URL had been reached after redirects. */
  url?: string;
  /** Throw this instead of answering. */
  throws?: Error;
}

interface Call {
  method: string;
  url: string;
  options: SafeFetchOptions;
}

function recorder(fixtures: Fixture[]): { fetchImpl: WordPressFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: WordPressFetch = async (url, options) => {
    const method = (options.method ?? 'GET').toUpperCase();
    calls.push({ method, url, options });
    const hit = fixtures.find((f) => {
      const [first, second] = f.match.split(' ');
      if (second !== undefined) return first === method && url.includes(second);
      return /^[A-Z]+$/.test(first!) ? first === method : url.includes(first!);
    });
    if (!hit) throw new Error(`no fixture for ${method} ${url}`);
    if (hit.throws) throw hit.throws;
    const body =
      hit.raw !== undefined
        ? Buffer.from(hit.raw)
        : Buffer.from(hit.body === undefined ? '' : JSON.stringify(hit.body));
    const response: SafeResponse = {
      status: hit.status ?? 200,
      headers: { 'content-type': 'application/json; charset=UTF-8', ...hit.headers },
      body,
      url: hit.url ?? url,
    };
    return response;
  };
  return { fetchImpl, calls };
}

/** The decoded JSON body a call sent. */
function sentJson(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.options.body)) as Record<string, unknown>;
}

const REDIRECT = 'https://social.meegrowlabs.com/connect/callback';
const STATE = '9b2f6c1e-3d4a-4f5b-8c6d-7e8f9a0b1c2d';
const APP_PASSWORD = 'abcd EFGH 1234 ijkl MNOP 5678';

const HEAD_FRONT: Fixture = {
  match: 'HEAD blog.example.com',
  headers: { link: `<${API_ROOT}>; rel="https://api.w.org/"` },
  raw: '',
};
const GET_INDEX: Fixture = { match: 'GET /wp-json/?_fields', body: INDEX };
const GET_ME: Fixture = { match: 'GET /wp/v2/users/me', body: USER_ME };

function setup(fixtures: Fixture[]) {
  const { fetchImpl, calls } = recorder(fixtures);
  const client = new WordPressClient({ fetchImpl });
  return { wp: new WordPressProvider(client), client, calls };
}

const CREDENTIALS = {
  siteUrl: SITE,
  apiRoot: API_ROOT,
  username: 'priya',
  password: APP_PASSWORD,
};

const TOKENS: AuthTokens = {
  accessToken: encodeCredentials(CREDENTIALS),
  externalId: SITE,
  displayName: 'Ecolive & Co',
};

const FLOW_CONTEXT = JSON.stringify({
  siteUrl: SITE,
  home: SITE,
  apiRoot: API_ROOT,
  name: 'Ecolive & Co',
});

const article = (over: Partial<PostDetails> = {}, options: object = {}): PostDetails[] => [
  {
    caption: '# Why\n\nBecause **plastic** lasts.',
    media: [],
    options: {
      kind: 'wordpress',
      title: 'Five ways to cut plastic',
      status: 'publish',
      ...options,
    } as PostDetails['options'],
    ...over,
  },
];

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a rejection');
}

describe('normalizeSiteInput', () => {
  it.each([
    ['blog.example.com', 'https://blog.example.com/'],
    ['  https://blog.example.com  ', 'https://blog.example.com/'],
    ['https://example.com/blog', 'https://example.com/blog/'],
    ['https://example.com/wp-admin/', 'https://example.com/'],
    ['https://example.com/blog/wp-admin/options-general.php', 'https://example.com/blog/'],
    ['https://example.com/wp-login.php', 'https://example.com/'],
    ['https://example.com/?p=12#top', 'https://example.com/'],
    ['HTTPS://Example.COM', 'https://example.com/'],
  ])('reads %j as %s', (input, expected) => {
    expect(normalizeSiteInput(input)).toBe(expected);
  });

  it('refuses http with the reason WordPress has for it', () => {
    expect(() => normalizeSiteInput('http://blog.example.com')).toThrow(ProviderBadRequestError);
    expect(() => normalizeSiteInput('http://blog.example.com')).toThrow(/https/);
    expect(() => normalizeSiteInput('HTTP://blog.example.com')).toThrow(/https/);
  });

  it.each(['', '   ', 'ftp://example.com', 'javascript://example.com', 'https://'])(
    'refuses %j',
    (input) => {
      expect(() => normalizeSiteInput(input)).toThrow(ProviderBadRequestError);
    },
  );
});

describe('sameSite', () => {
  it('ignores case of the host and a trailing slash, nothing else', () => {
    expect(sameSite('https://Blog.Example.com/', 'https://blog.example.com')).toBe(true);
    expect(sameSite('https://example.com/blog/', 'https://example.com/blog')).toBe(true);
    expect(sameSite('https://example.com', 'https://example.com/blog')).toBe(false);
    expect(sameSite('http://example.com', 'https://example.com')).toBe(false);
    expect(sameSite('https://example.com.evil.test', 'https://example.com')).toBe(false);
    expect(sameSite('https://example.com:8443', 'https://example.com')).toBe(false);
    expect(sameSite('https://evil.test/?https://example.com', 'https://example.com')).toBe(false);
    expect(sameSite('https://example.com@evil.test', 'https://example.com')).toBe(false);
    expect(sameSite('not a url', 'https://example.com')).toBe(false);
    expect(sameSite('', '')).toBe(false);
  });
});

describe('small helpers', () => {
  it('routeUrl handles both REST root forms', () => {
    expect(routeUrl(API_ROOT, '/wp/v2/posts')).toBe(`${SITE}/wp-json/wp/v2/posts`);
    expect(routeUrl(API_ROOT, '/wp/v2/tags', { search: 'eco & co' })).toBe(
      `${SITE}/wp-json/wp/v2/tags?search=eco+%26+co`,
    );
    expect(routeUrl(`${SITE}/?rest_route=/`, '/wp/v2/posts', { per_page: '5' })).toBe(
      `${SITE}/?rest_route=%2Fwp%2Fv2%2Fposts&per_page=5`,
    );
  });

  it('apiRootFromLinkHeader finds the api.w.org link among others', () => {
    expect(apiRootFromLinkHeader(`<${API_ROOT}>; rel="https://api.w.org/"`)).toBe(API_ROOT);
    expect(
      apiRootFromLinkHeader(
        `<${SITE}/wp-json/wp/v2/pages/2>; rel="alternate"; type="application/json", ` +
          `<${SITE}/?rest_route=/>; rel="https://api.w.org/", <${SITE}/>; rel=shortlink`,
      ),
    ).toBe(`${SITE}/?rest_route=/`);
    expect(apiRootFromLinkHeader(`<${SITE}/>; rel=shortlink`)).toBeNull();
    expect(apiRootFromLinkHeader(undefined)).toBeNull();
  });

  it('plainText strips the markup WordPress puts in messages', () => {
    expect(plainText('<strong>Error:</strong> Unknown username.')).toBe('Error: Unknown username.');
    expect(plainText('Ecolive &amp; Co')).toBe('Ecolive & Co');
    expect(plainText(undefined)).toBe('');
    expect(plainText('x'.repeat(1000))).toHaveLength(300);
  });

  it('credentials round-trip, and an unreadable blob never appears in the error', () => {
    expect(decodeCredentials(encodeCredentials(CREDENTIALS))).toEqual(CREDENTIALS);
    for (const bad of ['', 'PLAIN-TOKEN-secret', '{"siteUrl":"x"}', 'null', '[]']) {
      const err = (() => {
        try {
          decodeCredentials(bad);
        } catch (e) {
          return e as Error;
        }
        throw new Error('expected a throw');
      })();
      expect(err).toBeInstanceOf(ProviderAuthError);
      if (bad) expect(err.message).not.toContain(bad);
    }
  });
});

describe('discovery', () => {
  it('finds the REST root from the Link header and the authorize screen from the index', async () => {
    const { client, calls } = setup([HEAD_FRONT, GET_INDEX]);
    const site = await client.discover('blog.example.com');
    expect(site).toEqual({
      siteUrl: SITE,
      home: SITE,
      apiRoot: API_ROOT,
      authorizeUrl: `${SITE}/wp-admin/authorize-application.php`,
      name: 'Ecolive & Co',
    });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'HEAD https://blog.example.com/',
      `GET ${API_ROOT}?_fields=name%2Curl%2Chome%2Cnamespaces%2Cauthentication`,
    ]);
    // Discovery is unauthenticated, follows a bounded number of redirects, and is capped.
    for (const call of calls) {
      expect(call.options.headers?.authorization).toBeUndefined();
      expect(call.options.maxRedirects).toBeGreaterThan(0);
      expect(call.options.maxRedirects).toBeLessThanOrEqual(3);
      expect(call.options.timeoutMs).toBeLessThanOrEqual(10_000);
    }
  });

  it('uses where the site finally answered (bare domain → www)', async () => {
    const www = 'https://www.example.com';
    const { client } = setup([
      {
        match: 'HEAD example.com',
        url: `${www}/`,
        headers: { link: `<${www}/wp-json/>; rel="https://api.w.org/"` },
      },
      {
        match: 'GET www.example.com/wp-json/',
        body: {
          ...INDEX,
          url: www,
          home: www,
          authentication: {
            'application-passwords': {
              endpoints: { authorization: `${www}/wp-admin/authorize-application.php` },
            },
          },
        },
      },
    ]);
    const site = await client.discover('example.com');
    expect(site.apiRoot).toBe(`${www}/wp-json/`);
    expect(site.home).toBe(www);
  });

  it('falls back to /wp-json/ and then ?rest_route=/ when no Link header is sent', async () => {
    const { client, calls } = setup([
      { match: 'HEAD blog.example.com', raw: '' },
      { match: 'GET /wp-json/', status: 404, raw: '<html>Not found</html>' },
      { match: 'GET rest_route=%2F', body: INDEX },
    ]);
    const site = await client.discover(SITE);
    expect(site.apiRoot).toBe(`${SITE}/?rest_route=/`);
    expect(calls).toHaveLength(3);
  });

  it('upgrades an http REST root advertised by a site behind a proxy', async () => {
    const { client } = setup([
      {
        match: 'HEAD blog.example.com',
        headers: { link: '<http://blog.example.com/wp-json/>; rel="https://api.w.org/"' },
      },
      GET_INDEX,
    ]);
    expect((await client.discover(SITE)).apiRoot).toBe(API_ROOT);
  });

  const failing: Array<[string, Fixture[], RegExp]> = [
    [
      'a site that is not WordPress',
      [
        { match: 'HEAD blog.example.com', raw: '' },
        { match: 'GET /wp-json/', status: 404, raw: '<html>404</html>' },
        { match: 'GET rest_route', status: 200, raw: '<html>Welcome</html>' },
      ],
      /No WordPress REST API was found/,
    ],
    [
      'a REST API locked to logged-in users by a security plugin',
      [
        HEAD_FRONT,
        {
          match: 'GET /wp-json/',
          status: 401,
          body: wpError('rest_not_logged_in', 'You are not currently logged in.', 401),
        },
      ],
      /security plugin is\s+restricting/,
    ],
    [
      'a firewall answering 403 with a challenge page',
      [HEAD_FRONT, { match: 'GET /wp-json/', status: 403, raw: '<html>Access denied</html>' }],
      /security plugin is\s+restricting/,
    ],
    [
      'application passwords switched off (empty authentication)',
      [HEAD_FRONT, { match: 'GET /wp-json/', body: { ...INDEX, authentication: [] } }],
      /Application Passwords are not available/,
    ],
    [
      'application passwords switched off (empty object)',
      [HEAD_FRONT, { match: 'GET /wp-json/', body: { ...INDEX, authentication: {} } }],
      /Application Passwords are not available/,
    ],
    [
      'a WordPress too old for wp/v2',
      [HEAD_FRONT, { match: 'GET /wp-json/', body: { ...INDEX, namespaces: ['oembed/1.0'] } }],
      /does not offer the core REST API/,
    ],
    [
      'a REST root advertised on another host',
      [
        {
          match: 'HEAD blog.example.com',
          headers: { link: '<https://api.elsewhere.test/wp-json/>; rel="https://api.w.org/"' },
        },
      ],
      /different host/,
    ],
    [
      'an authorize screen on another host',
      [
        HEAD_FRONT,
        {
          match: 'GET /wp-json/',
          body: {
            ...INDEX,
            authentication: {
              'application-passwords': {
                endpoints: { authorization: 'https://login.evil.test/authorize-application.php' },
              },
            },
          },
        },
      ],
      /not on the same https address/,
    ],
    [
      'an authorize screen over http',
      [
        HEAD_FRONT,
        {
          match: 'GET /wp-json/',
          body: {
            ...INDEX,
            authentication: {
              'application-passwords': {
                endpoints: {
                  authorization: 'http://blog.example.com/wp-admin/authorize-application.php',
                },
              },
            },
          },
        },
      ],
      /not on the same https address/,
    ],
    [
      'a site that says it lives somewhere else',
      [
        HEAD_FRONT,
        { match: 'GET /wp-json/', body: { ...INDEX, url: 'https://other.example.org' } },
      ],
      /says its address is other\.example\.org/,
    ],
  ];
  it.each(failing)('explains %s', async (_name, fixtures, message) => {
    const { client } = setup(fixtures);
    const err = await rejection(client.discover(SITE));
    expect(err).toBeInstanceOf(ProviderBadRequestError);
    expect(err.message).toMatch(message);
  });

  it('never makes a request for an http address', async () => {
    const { client, calls } = setup([]);
    const err = await rejection(client.discover('http://blog.example.com'));
    expect(err).toBeInstanceOf(ProviderBadRequestError);
    expect(calls).toHaveLength(0);
  });

  it('passes the guard’s refusal on in its own words, as a bad request', async () => {
    const { client } = setup([
      {
        match: 'HEAD',
        throws: new SsrfBlockedError('address', 'That address is not a public website.'),
      },
    ]);
    const err = await rejection(client.discover('https://10.0.0.5'));
    expect(err).toBeInstanceOf(ProviderBadRequestError);
    expect(err.message).toBe('That address is not a public website.');
  });

  it('says so when the site does not answer or loops', async () => {
    const down = setup([{ match: 'HEAD', throws: new SafeFetchError('timeout', 'no answer') }]);
    expect((await rejection(down.client.discover(SITE))).message).toMatch(/did not answer/);
    const loop = setup([
      { match: 'HEAD', throws: new SafeFetchError('too_many_redirects', 'looping') },
    ]);
    expect((await rejection(loop.client.discover(SITE))).message).toMatch(/keeps redirecting/);
  });
});

describe('generateAuthUrl', () => {
  it('sends the person to the site’s own authorize screen with the documented parameters', async () => {
    const { wp } = setup([HEAD_FRONT, GET_INDEX]);
    const { url, codeVerifier } = await wp.generateAuthUrl({
      redirectUri: REDIRECT,
      state: STATE,
      siteUrl: 'blog.example.com',
    });
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(`${SITE}/wp-admin/authorize-application.php`);
    expect(parsed.searchParams.get('app_name')).toBe('Meegrow Social');
    // WordPress refuses an app_id that is not a UUID ("The application ID must be a UUID.").
    expect(parsed.searchParams.get('app_id')).toBe(WORDPRESS_APP_ID);
    expect(WORDPRESS_APP_ID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(parsed.searchParams.get('success_url')).toBe(`${REDIRECT}?state=${STATE}`);
    expect(parsed.searchParams.get('reject_url')).toBe(
      `${REDIRECT}?state=${STATE}&error=access_denied`,
    );
    // What the flow row keeps: which site this flow is for. No secret exists yet.
    expect(JSON.parse(codeVerifier!)).toEqual({
      siteUrl: SITE,
      home: SITE,
      apiRoot: API_ROOT,
      name: 'Ecolive & Co',
    });
  });

  it('asks for the address when none was given', async () => {
    const { wp, calls } = setup([]);
    const err = await rejection(wp.generateAuthUrl({ redirectUri: REDIRECT, state: STATE }));
    expect(err).toBeInstanceOf(ProviderBadRequestError);
    expect(calls).toHaveLength(0);
  });
});

describe('authenticate — the redirect back from authorize-application.php', () => {
  const callback = (over: Record<string, string | undefined> = {}) => ({
    state: STATE,
    site_url: SITE,
    user_login: 'priya',
    password: APP_PASSWORD,
    ...over,
  });
  const authenticate = (
    wp: WordPressProvider,
    cb: Record<string, string | undefined>,
    codeVerifier: string | undefined = FLOW_CONTEXT,
  ) => wp.authenticate({ code: '', codeVerifier, redirectUri: REDIRECT, callback: cb });

  it('verifies the password against the site the flow was started for, then returns it packed', async () => {
    const { wp, calls } = setup([GET_ME]);
    const tokens = await authenticate(wp, callback());
    expect(tokens.externalId).toBe(SITE);
    expect(tokens.displayName).toBe('Ecolive & Co');
    expect(tokens.refreshToken).toBeUndefined();
    expect(tokens.expiresAt).toBeUndefined();
    expect(decodeCredentials(tokens.accessToken)).toEqual(CREDENTIALS);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      `${API_ROOT}wp/v2/users/me?context=edit&_fields=id%2Cname%2Cslug%2Ccapabilities`,
    );
    expect(calls[0]!.options.headers?.authorization).toBe(
      `Basic ${Buffer.from(`priya:${APP_PASSWORD}`).toString('base64')}`,
    );
    // A request that carries the password is never replayed to wherever a redirect points.
    expect(calls[0]!.options.maxRedirects ?? 0).toBe(0);
  });

  it.each([
    ['another site entirely', 'https://evil.example.net'],
    ['a look-alike host', 'https://blog.example.com.evil.test'],
    ['the same host over http', 'http://blog.example.com'],
    ['a different path on the host', 'https://blog.example.com/other'],
    ['a different port', 'https://blog.example.com:8443'],
    ['garbage', 'not-a-url'],
  ])(
    'refuses a callback claiming to come from %s, without contacting anything',
    async (_n, siteUrl) => {
      const { wp, calls } = setup([GET_ME]);
      const err = await rejection(authenticate(wp, callback({ site_url: siteUrl })));
      expect(err).toBeInstanceOf(ConnectError);
      expect((err as ConnectError).code).toBe('site_mismatch');
      expect(calls).toHaveLength(0);
    },
  );

  it('accepts the site’s address written with a trailing slash or other case', async () => {
    const { wp } = setup([GET_ME]);
    await expect(
      authenticate(wp, callback({ site_url: 'https://Blog.Example.com/' })),
    ).resolves.toBeDefined();
  });

  it('never sends the credentials anywhere the callback names', async () => {
    // The flow was started for blog.example.com; the context is what decides where the check goes.
    const { wp, calls } = setup([GET_ME]);
    await authenticate(wp, callback());
    expect(calls.every((c) => c.url.startsWith(API_ROOT))).toBe(true);
  });

  it.each([
    ['no site_url', { site_url: undefined }],
    ['no user_login', { user_login: undefined }],
    ['no password', { password: undefined }],
    ['an empty password', { password: '' }],
    ['an absurdly long login', { user_login: 'u'.repeat(61) }],
    ['an absurdly long password', { password: 'p'.repeat(129) }],
  ])('refuses a callback with %s', async (_name, over) => {
    const { wp, calls } = setup([GET_ME]);
    const err = await rejection(authenticate(wp, callback(over)));
    expect((err as ConnectError).code).toBe('incomplete');
    expect(calls).toHaveLength(0);
  });

  it.each([undefined, '', 'not json', '{"siteUrl":"https://blog.example.com"}'])(
    'refuses when the flow carries no usable site (%j)',
    async (codeVerifier) => {
      const { wp, calls } = setup([GET_ME]);
      const err = await rejection(
        wp.authenticate({ code: '', codeVerifier, redirectUri: REDIRECT, callback: callback() }),
      );
      expect((err as ConnectError).code).toBe('invalid_state');
      expect(calls).toHaveLength(0);
    },
  );

  it('rejects a password the site does not accept (a forged callback with made-up credentials)', async () => {
    const { wp } = setup([
      {
        match: 'GET /wp/v2/users/me',
        status: 401,
        body: wpError(
          'incorrect_password',
          'The provided password is an invalid application password.',
          401,
        ),
      },
    ]);
    const err = await rejection(authenticate(wp, callback({ password: 'made up' })));
    expect((err as ConnectError).code).toBe('credentials_rejected');
    // The failure names no credential.
    expect(err.message).not.toContain('made up');
    expect(err.message).not.toContain('priya');
  });

  it('rejects a server that strips the Authorization header (WordPress then sees nobody)', async () => {
    const { wp } = setup([
      {
        match: 'GET /wp/v2/users/me',
        status: 401,
        body: wpError('rest_not_logged_in', 'You are not currently logged in.', 401),
      },
    ]);
    expect(((await rejection(authenticate(wp, callback()))) as ConnectError).code).toBe(
      'credentials_rejected',
    );
  });

  it.each([
    ['a Subscriber', { read: true }],
    ['a Contributor (can write, cannot publish)', { edit_posts: true }],
    ['a user with no capabilities listed', undefined],
  ])('refuses %s', async (_name, capabilities) => {
    const { wp } = setup([{ match: 'GET /wp/v2/users/me', body: { ...USER_ME, capabilities } }]);
    expect(((await rejection(authenticate(wp, callback()))) as ConnectError).code).toBe(
      'insufficient_role',
    );
  });

  it('reports an unreachable site as that, not as bad credentials', async () => {
    const timeout = setup([
      { match: 'GET /wp/v2/users/me', throws: new SafeFetchError('timeout', 'no answer') },
    ]);
    expect(((await rejection(authenticate(timeout.wp, callback()))) as ConnectError).code).toBe(
      'site_unreachable',
    );
    const down = setup([{ match: 'GET /wp/v2/users/me', status: 503, raw: 'Service Unavailable' }]);
    expect(((await rejection(authenticate(down.wp, callback()))) as ConnectError).code).toBe(
      'site_unreachable',
    );
  });
});

describe('provider contract', () => {
  it('declares a single-step, non-expiring, browser-bound connection that starts with a site address', () => {
    const { wp } = setup([]);
    expect(wp.identifier).toBe('wordpress');
    expect(wp.isBetweenSteps).toBe(false);
    expect(wp.tokenModel).toBe('one-time');
    expect(wp.connectInput).toBe('site_url');
    expect(wp.credentialInCallback).toBe(true);
  });

  it('cannot refresh: an application password is replaced by reconnecting', async () => {
    const { wp } = setup([]);
    await expect(wp.refreshToken()).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it('reports no analytics rather than inventing any, and calls nothing to do so', async () => {
    const { wp, calls } = setup([]);
    expect(await wp.postAnalytics()).toEqual([]);
    expect(await wp.accountAnalytics()).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('assertPublishable', () => {
  const { wp } = setup([]);
  const image = { mediaId: '11111111-1111-4111-8111-111111111111', kind: 'image' as const };
  const video = { mediaId: '22222222-2222-4222-8222-222222222222', kind: 'video' as const };

  it('accepts a titled article with a body, with or without a featured image', () => {
    expect(() => wp.assertPublishable(article())).not.toThrow();
    expect(() => wp.assertPublishable(article({ media: [image] }))).not.toThrow();
    expect(() =>
      wp.assertPublishable(article({ caption: '![chart](https://cdn.example.com/c.png)' })),
    ).not.toThrow();
  });

  it.each([
    ['no options', article({ options: undefined }), /requires options/],
    [
      'another platform’s options',
      article({ options: { kind: 'meta', format: 'feed' } }),
      /requires options/,
    ],
    ['a blank title', article({}, { title: '   ' }), /needs a title/],
    ['an empty body', article({ caption: '' }), /needs a body/],
    ['a whitespace body', article({ caption: ' \n\n ' }), /needs a body/],
    ['a body that is only a rule', article({ caption: '---' }), /needs a body/],
    ['a body past the limit', article({ caption: 'a'.repeat(100_001) }), /limit is 100000/],
    ['two images', article({ media: [image, image] }), /one image at most/],
    ['a video', article({ media: [video] }), /must be an image/],
  ])('rejects %s', (_name, details, message) => {
    expect(() => wp.assertPublishable(details)).toThrow(ProviderBadRequestError);
    expect(() => wp.assertPublishable(details)).toThrow(message);
  });

  it('rejects anything but exactly one article', () => {
    expect(() => wp.assertPublishable([])).toThrow(/exactly one article/);
    expect(() => wp.assertPublishable([...article(), ...article()])).toThrow(/exactly one article/);
  });
});

describe('post', () => {
  const POST_OK: Fixture = { match: 'POST /wp/v2/posts', status: 201, body: CREATED_POST };

  it('creates the article and returns its permalink and id', async () => {
    const { wp, calls } = setup([POST_OK]);
    const result = await wp.post(TOKENS, article());
    expect(result).toEqual({
      externalPostId: '1284',
      releaseUrl: `${SITE}/2026/10/five-ways-to-cut-plastic/`,
    });
    expect(calls).toHaveLength(1);
    const [call] = calls as [Call];
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${API_ROOT}wp/v2/posts`);
    expect(call.options.headers).toMatchObject({
      authorization: `Basic ${Buffer.from(`priya:${APP_PASSWORD}`).toString('base64')}`,
      'content-type': 'application/json; charset=utf-8',
    });
    expect(call.options.maxRedirects ?? 0).toBe(0);
    expect(sentJson(call)).toEqual({
      title: 'Five ways to cut plastic',
      content: '<h1>Why</h1>\n\n<p>Because <strong>plastic</strong> lasts.</p>',
      status: 'publish',
    });
  });

  it('sends the body through the one converter, so typed HTML arrives escaped', async () => {
    const { wp, calls } = setup([POST_OK]);
    const body = 'Hello <script>alert(1)</script>\n\n[x](javascript:alert(1))';
    await wp.post(TOKENS, article({ caption: body }));
    const content = sentJson(calls[0]!).content as string;
    expect(content).toBe(articleMarkdownToHtml(body));
    expect(content).not.toContain('<script');
    expect(content).not.toMatch(/href="javascript/);
  });

  it('never sets a date: when it goes out is this app’s schedule, not WordPress’s', async () => {
    const { wp, calls } = setup([POST_OK]);
    await wp.post(TOKENS, article());
    const sent = sentJson(calls[0]!);
    expect(sent).not.toHaveProperty('date');
    expect(sent).not.toHaveProperty('date_gmt');
    expect(sent.status).not.toBe('future');
  });

  it('sends slug and excerpt when given', async () => {
    const { wp, calls } = setup([POST_OK]);
    await wp.post(TOKENS, article({}, { slug: 'cut-plastic', excerpt: 'Five small changes.' }));
    expect(sentJson(calls[0]!)).toMatchObject({
      slug: 'cut-plastic',
      excerpt: 'Five small changes.',
    });
  });

  it('works against a site without pretty permalinks', async () => {
    const { wp, calls } = setup([{ match: 'POST rest_route', status: 201, body: CREATED_POST }]);
    const tokens = {
      ...TOKENS,
      accessToken: encodeCredentials({ ...CREDENTIALS, apiRoot: `${SITE}/?rest_route=/` }),
    };
    await wp.post(tokens, article());
    expect(calls[0]!.url).toBe(`${SITE}/?rest_route=%2Fwp%2Fv2%2Fposts`);
  });

  describe('status', () => {
    it.each([
      ['draft', /as a draft, as asked/],
      ['pending', /as pending review, as asked/],
      ['private', /as private, as asked/],
    ])('creates a %s article and says it is not public', async (status, notice) => {
      const { wp, calls } = setup([
        { match: 'POST /wp/v2/posts', status: 201, body: { ...CREATED_POST, status } },
      ]);
      const result = await wp.post(TOKENS, article({}, { status }));
      expect(sentJson(calls[0]!).status).toBe(status);
      expect(result.notice).toMatch(notice);
      expect(result.notice).toMatch(/not public/);
    });

    it('says so when WordPress saved it as something other than asked', async () => {
      const { wp } = setup([
        { match: 'POST /wp/v2/posts', status: 201, body: { ...CREATED_POST, status: 'pending' } },
      ]);
      const result = await wp.post(TOKENS, article());
      expect(result.notice).toMatch(/pending review instead of "publish"/);
    });
  });

  describe('permalink', () => {
    it.each([
      ['a missing link', undefined],
      ['a link that is not a URL', 'nope'],
      ['a link with a script scheme', 'javascript:alert(1)'],
    ])('falls back to the ?p= form for %s', async (_name, link) => {
      const { wp } = setup([
        { match: 'POST /wp/v2/posts', status: 201, body: { ...CREATED_POST, link } },
      ]);
      expect((await wp.post(TOKENS, article())).releaseUrl).toBe(`${SITE}/?p=1284`);
    });
  });

  describe('categories and tags', () => {
    it('resolves names to ids, passes ids through, and creates a tag that does not exist', async () => {
      const { wp, calls } = setup([
        {
          match: 'GET /wp/v2/categories',
          // `search` is a substring match: the exact name has to be picked out.
          body: [
            { id: 4, name: 'Sustainability Tips' },
            { id: 9, name: 'Sustainability' },
          ],
        },
        { match: 'GET /wp/v2/tags?search=plastic', body: [{ id: 21, name: 'Plastic' }] },
        { match: 'GET /wp/v2/tags?search=zero', body: [] },
        { match: 'POST /wp/v2/tags', status: 201, body: { id: 77, name: 'zero waste' } },
        POST_OK,
      ]);
      await wp.post(
        TOKENS,
        article({}, { categories: ['sustainability', 12], tags: ['plastic', 'zero waste', 21] }),
      );
      const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/wp/v2/tags'))!;
      expect(sentJson(create)).toEqual({ name: 'zero waste' });
      expect(sentJson(calls.at(-1)!)).toMatchObject({ categories: [9, 12], tags: [21, 77] });
      // Everything that can be refused happens before the article is created.
      expect(calls.at(-1)!.url).toBe(`${API_ROOT}wp/v2/posts`);
    });

    it('refuses an unknown category instead of creating it, and creates nothing', async () => {
      const { wp, calls } = setup([{ match: 'GET /wp/v2/categories', body: [] }, POST_OK]);
      const err = await rejection(wp.post(TOKENS, article({}, { categories: ['Sustainabilty'] })));
      expect(err).toBeInstanceOf(ProviderBadRequestError);
      expect(err.message).toContain('no category named "Sustainabilty"');
      expect(calls.some((c) => c.method === 'POST')).toBe(false);
    });

    it('uses the id WordPress names when the tag turns out to exist (term_exists)', async () => {
      const { wp, calls } = setup([
        { match: 'GET /wp/v2/tags', body: [] },
        {
          match: 'POST /wp/v2/tags',
          status: 400,
          body: wpError('term_exists', 'A term with the name provided already exists.', 400, {
            term_id: 33,
          }),
        },
        POST_OK,
      ]);
      await wp.post(TOKENS, article({}, { tags: ['plastic'] }));
      expect(sentJson(calls.at(-1)!).tags).toEqual([33]);
    });

    it('fails as an auth error when the user may not create tags', async () => {
      const { wp } = setup([
        { match: 'GET /wp/v2/tags', body: [] },
        {
          match: 'POST /wp/v2/tags',
          status: 403,
          body: wpError('rest_cannot_create', 'Sorry, you are not allowed to create terms.', 403),
        },
      ]);
      await expect(wp.post(TOKENS, article({}, { tags: ['new'] }))).rejects.toBeInstanceOf(
        ProviderAuthError,
      );
    });
  });

  describe('featured image', () => {
    const media = [
      {
        mediaId: '11111111-1111-4111-8111-111111111111',
        kind: 'image' as const,
        url: 'https://media.meegrowlabs.com/ws/abc.jpg',
      },
    ];
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const DOWNLOAD: Fixture = {
      match: 'GET media.meegrowlabs.com',
      raw: JPEG,
      headers: { 'content-type': 'image/jpeg' },
    };
    const UPLOAD: Fixture = { match: 'POST /wp/v2/media', status: 201, body: CREATED_MEDIA };

    it('downloads the stored image, uploads it to the media library, then attaches it', async () => {
      const { wp, calls } = setup([DOWNLOAD, UPLOAD, POST_OK]);
      await wp.post(TOKENS, article({ media }));
      expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        'GET https://media.meegrowlabs.com/ws/abc.jpg',
        `POST ${API_ROOT}wp/v2/media`,
        `POST ${API_ROOT}wp/v2/posts`,
      ]);
      const [download, upload, create] = calls as [Call, Call, Call];
      // The image URL is as untrusted as a site URL: no credentials go with it.
      expect(download.options.headers?.authorization).toBeUndefined();
      expect(download.options.maxResponseBytes).toBe(20 * 1024 * 1024);
      // The upload is the raw bytes with the two headers WordPress requires for that.
      expect(Buffer.isBuffer(upload.options.body)).toBe(true);
      expect((upload.options.body as Buffer).equals(JPEG)).toBe(true);
      expect(upload.options.headers).toMatchObject({
        'content-type': 'image/jpeg',
        'content-disposition': 'attachment; filename="five-ways-to-cut-plastic.jpg"',
      });
      expect(upload.options.headers?.authorization).toMatch(/^Basic /);
      expect(sentJson(create).featured_media).toBe(551);
    });

    it('names the file safely whatever the title is', async () => {
      const { wp, calls } = setup([DOWNLOAD, UPLOAD, POST_OK]);
      await wp.post(TOKENS, article({ media }, { title: '"; rm -rf / \r\n ../../é 日本' }));
      expect(calls[1]!.options.headers?.['content-disposition']).toBe(
        'attachment; filename="rm-rf-e.jpg"',
      );
      const blank = setup([DOWNLOAD, UPLOAD, POST_OK]);
      await blank.wp.post(TOKENS, article({ media }, { title: '日本語' }));
      expect(blank.calls[1]!.options.headers?.['content-disposition']).toBe(
        'attachment; filename="featured-image.jpg"',
      );
    });

    it('refuses a file WordPress would not take as an image, before uploading anything', async () => {
      const { wp, calls } = setup([
        {
          match: 'GET media.meegrowlabs.com',
          raw: '<svg/>',
          headers: { 'content-type': 'image/svg+xml' },
        },
        UPLOAD,
        POST_OK,
      ]);
      const err = await rejection(wp.post(TOKENS, article({ media })));
      expect(err).toBeInstanceOf(ProviderBadRequestError);
      expect(err.message).toMatch(/JPEG, PNG, GIF or WebP/);
      expect(calls.some((c) => c.method === 'POST')).toBe(false);
    });

    it('refuses an image at an address the guard blocks', async () => {
      const { wp, calls } = setup([
        {
          match: 'GET media.meegrowlabs.com',
          throws: new SsrfBlockedError('address', 'That address is not a public website.'),
        },
      ]);
      const err = await rejection(wp.post(TOKENS, article({ media })));
      expect(err).toBeInstanceOf(ProviderBadRequestError);
      expect(calls).toHaveLength(1);
    });

    it('refuses an image that is too large, and retries one that could not be fetched', async () => {
      const big = setup([
        { match: 'GET media.meegrowlabs.com', throws: new SafeFetchError('too_large', 'too big') },
      ]);
      expect(await rejection(big.wp.post(TOKENS, article({ media })))).toBeInstanceOf(
        ProviderBadRequestError,
      );
      const flaky = setup([
        { match: 'GET media.meegrowlabs.com', throws: new SafeFetchError('network', 'reset') },
      ]);
      expect(await rejection(flaky.wp.post(TOKENS, article({ media })))).toBeInstanceOf(
        ProviderTransientError,
      );
      const gone = setup([{ match: 'GET media.meegrowlabs.com', status: 404, raw: '' }]);
      expect(await rejection(gone.wp.post(TOKENS, article({ media })))).toBeInstanceOf(
        ProviderBadRequestError,
      );
    });

    it('fails without an article when WordPress refuses the upload', async () => {
      const { wp, calls } = setup([
        DOWNLOAD,
        {
          match: 'POST /wp/v2/media',
          status: 403,
          body: wpError(
            'rest_cannot_create',
            'Sorry, you are not allowed to upload media on this site.',
            403,
          ),
        },
        POST_OK,
      ]);
      await expect(wp.post(TOKENS, article({ media }))).rejects.toBeInstanceOf(ProviderAuthError);
      expect(calls.some((c) => c.url.endsWith('/wp/v2/posts'))).toBe(false);
    });

    it('refuses a media ref that never got a URL', async () => {
      const { wp } = setup([POST_OK]);
      const noUrl = [{ mediaId: media[0]!.mediaId, kind: 'image' as const }];
      await expect(wp.post(TOKENS, article({ media: noUrl }))).rejects.toThrow(/no stored url/);
    });
  });

  describe('errors', () => {
    const failWith = (fixture: Omit<Fixture, 'match'>) =>
      rejection(setup([{ match: 'POST /wp/v2/posts', ...fixture }]).wp.post(TOKENS, article()));

    it('a revoked application password → auth (needs reconnect), with WordPress’s own words', async () => {
      const err = await failWith({
        status: 401,
        body: wpError(
          'incorrect_password',
          'The provided password is an invalid application password.',
          401,
        ),
      });
      expect(err).toBeInstanceOf(ProviderAuthError);
      expect(err.message).toContain('The provided password is an invalid application password.');
      expect(err.message).toContain('[incorrect_password]');
      expect(err.message).not.toContain(APP_PASSWORD);
    });

    it.each([
      ['rest_cannot_create', 'Sorry, you are not allowed to create posts as this user.'],
      ['rest_cannot_publish', 'Sorry, you are not allowed to publish posts in this post type.'],
      ['rest_cannot_assign_term', 'Sorry, you are not allowed to assign the provided terms.'],
      ['application_passwords_disabled', 'Application passwords are not available.'],
    ])('403 %s → auth', async (code, message) => {
      const err = await failWith({ status: 403, body: wpError(code, message, 403) });
      expect(err).toBeInstanceOf(ProviderAuthError);
      expect(err.message).toContain(message);
    });

    it('a 403 that is not WordPress’s (a firewall page) → bad request naming the firewall', async () => {
      const err = await failWith({ status: 403, raw: '<html>Blocked by Wordfence</html>' });
      expect(err).toBeInstanceOf(ProviderBadRequestError);
      expect(err.message).toMatch(/firewall or security\s+plugin/);
    });

    it('a 404 (REST API switched off after connecting) → bad request naming that', async () => {
      const err = await failWith({
        status: 404,
        body: wpError(
          'rest_no_route',
          'No route was found matching the URL and request method.',
          404,
        ),
      });
      expect(err).toBeInstanceOf(ProviderBadRequestError);
      expect(err.message).toMatch(/disabled or restricted by a plugin/);
    });

    it('a validation error → bad request with WordPress’s message and the field', async () => {
      const err = await failWith({
        status: 400,
        body: wpError('rest_invalid_param', 'Invalid parameter(s): status', 400, {
          params: { status: 'status is not one of publish, future, draft, pending, private.' },
        }),
      });
      expect(err).toBeInstanceOf(ProviderBadRequestError);
      expect(err.message).toContain('Invalid parameter(s): status');
      expect(err.message).toContain('status is not one of publish');
    });

    it.each([500, 502, 503, 504, 429])('HTTP %i → transient', async (status) => {
      expect(await failWith({ status, raw: 'upstream error' })).toBeInstanceOf(
        ProviderTransientError,
      );
    });

    it('a failure before anything was sent → transient', async () => {
      expect(
        await failWith({ throws: new SafeFetchError('network', 'connect ECONNREFUSED', false) }),
      ).toBeInstanceOf(ProviderTransientError);
      expect(
        await failWith({ throws: new SafeFetchError('timeout', 'slow', false) }),
      ).toBeInstanceOf(ProviderTransientError);
    });

    it('a timeout AFTER the article was sent is final, not retried into a duplicate', async () => {
      const err = await failWith({ throws: new SafeFetchError('timeout', 'slow', true) });
      expect(err).toBeInstanceOf(ProviderBadRequestError);
      expect(err.message).toMatch(/may or may not have been created/);
    });

    it('the same timeout on a read is just retried', async () => {
      const { wp } = setup([
        { match: 'GET /wp/v2/categories', throws: new SafeFetchError('timeout', 'slow', true) },
      ]);
      expect(
        await rejection(wp.post(TOKENS, article({}, { categories: ['News'] }))),
      ).toBeInstanceOf(ProviderTransientError);
    });

    it('a redirect is never followed with the password; it means the address changed', async () => {
      const err = await failWith({
        status: 301,
        headers: { location: 'https://new.example.com/' },
      });
      expect(err).toBeInstanceOf(ProviderBadRequestError);
      expect(err.message).toMatch(/address has changed/);
    });

    it('a 201 that is not JSON is final: the article may exist', async () => {
      const err = await failWith({ status: 201, raw: '<br />Warning: something in a plugin' });
      expect(err).toBeInstanceOf(ProviderBadRequestError);
      expect(err.message).toMatch(/may or may not have been created/);
    });

    it('a 201 without an id is final too', async () => {
      const err = await failWith({ status: 201, body: {} });
      expect(err).toBeInstanceOf(ProviderBadRequestError);
      expect(err.message).toMatch(/check the site before\s+retrying/);
    });

    it('a site that now resolves somewhere private is refused; a DNS blip is retried', async () => {
      expect(
        await failWith({ throws: new SsrfBlockedError('address', 'not public') }),
      ).toBeInstanceOf(ProviderBadRequestError);
      expect(await failWith({ throws: new SsrfBlockedError('dns', 'not found') })).toBeInstanceOf(
        ProviderTransientError,
      );
    });

    it('unreadable stored credentials → auth, before any request', async () => {
      const { wp, calls } = setup([POST_OK]);
      await expect(
        wp.post({ ...TOKENS, accessToken: 'not-json' }, article()),
      ).rejects.toBeInstanceOf(ProviderAuthError);
      expect(calls).toHaveLength(0);
    });
  });
});

describe('mapWordPressError', () => {
  it('keeps the machine code for callers that branch on it', () => {
    const failure = mapWordPressError(400, wpError('term_exists', 'exists', 400, { term_id: 5 }));
    expect(failure.code).toBe('term_exists');
    expect(failure.body?.data?.term_id).toBe(5);
  });

  it('survives a body that is not an object', () => {
    for (const body of [undefined, null, 'text', 42, []]) {
      expect(mapWordPressError(500, body).error).toBeInstanceOf(ProviderTransientError);
      expect(mapWordPressError(400, body).error).toBeInstanceOf(ProviderBadRequestError);
      expect(mapWordPressError(401, body).error).toBeInstanceOf(ProviderAuthError);
    }
  });

  it('strips markup from WordPress’s message', () => {
    const failure = mapWordPressError(
      401,
      wpError('invalid_username', '<strong>Error:</strong> Unknown username.', 401),
    );
    expect(failure.error.message).toContain('Error: Unknown username.');
    expect(failure.error.message).not.toContain('<strong>');
  });
});
