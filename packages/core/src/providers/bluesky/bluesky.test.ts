import { describe, expect, it } from 'vitest';
import {
  ProviderAuthError,
  ProviderBadRequestError,
  ProviderRateLimitError,
  ProviderTransientError,
} from '../../errors.js';
import {
  safeFetch,
  SafeFetchError,
  type SafeFetchOptions,
  type SafeResponse,
} from '../../net/safe-fetch.js';
import { CredentialFormatError } from '../shared/http.js';
import type { AuthTokens, PostDetails } from '../types.js';
import { BlueskyProvider } from './bluesky.js';
import {
  assertAppPassword,
  decodeBlueskyCredentials,
  encodeBlueskyCredentials,
  jwtExpiryMs,
  parseBlueskyIdentifier,
  pdsFromDidDocument,
} from './client.js';

/**
 * FIXTURES ARE DOCUMENTATION-BUILT. Every request and response shape below is taken from the
 * published AT Protocol lexicons and Bluesky guides (docs/dev/research/quick-platforms.md §1),
 * not captured from a live PDS: this provider has never talked to one.
 */

const DID = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';
const HANDLE = 'acme.bsky.social';
const PDS = 'https://morel.us-east.host.bsky.network';
const APP_PASSWORD = 'abcd-efgh-ijkl-mnop';
const NOW = Date.parse('2026-10-11T12:00:00Z');
const MEDIA_ID = '11111111-1111-4111-8111-111111111111';

const jwt = (expiresInSeconds: number): string =>
  [
    Buffer.from('{"alg":"ES256K","typ":"at+jwt"}').toString('base64url'),
    Buffer.from(JSON.stringify({ exp: Math.floor(NOW / 1000) + expiresInSeconds })).toString(
      'base64url',
    ),
    'signature-part',
  ].join('.');
const ACCESS = jwt(7200);

const didDoc = (overrides: Record<string, unknown> = {}) => ({
  '@context': ['https://www.w3.org/ns/did/v1'],
  id: DID,
  alsoKnownAs: [`at://${HANDLE}`],
  service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }],
  ...overrides,
});

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer | string | undefined;
  options: SafeFetchOptions;
}

type Route = (seen: Seen) => { status?: number; body?: unknown; headers?: Record<string, string> };

function answer(url: string, reply: ReturnType<Route>): SafeResponse {
  const body = reply.body ?? {};
  return {
    status: reply.status ?? 200,
    headers: { 'content-type': 'application/json', ...reply.headers },
    body: Buffer.isBuffer(body)
      ? body
      : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
    url,
  };
}

/** A network of documented shapes. `routes` are matched on "<METHOD> <url prefix>", first wins. */
function network(overrides: Record<string, Route> = {}) {
  const seen: Seen[] = [];
  const defaults: Record<string, Route> = {
    [`GET https://${HANDLE}/.well-known/atproto-did`]: () => ({ body: DID }),
    [`GET https://plc.directory/${DID}`]: () => ({ body: didDoc() }),
    [`POST ${PDS}/xrpc/com.atproto.server.createSession`]: () => ({
      body: { accessJwt: ACCESS, refreshJwt: jwt(7_776_000), handle: HANDLE, did: DID },
    }),
    [`POST ${PDS}/xrpc/com.atproto.repo.createRecord`]: () => ({
      body: { uri: `at://${DID}/app.bsky.feed.post/3k4duaz5vfs2b`, cid: 'bafyreibjifzpqj6o6w' },
    }),
    [`POST ${PDS}/xrpc/com.atproto.repo.uploadBlob`]: (s) => ({
      body: {
        blob: {
          $type: 'blob',
          ref: { $link: `bafkrei${(s.body as Buffer).toString('hex').slice(0, 8)}` },
          mimeType: s.headers['content-type'],
          size: (s.body as Buffer).byteLength,
        },
      },
    }),
    'GET https://media.example.com/': () => ({
      body: Buffer.from('jpeg-bytes'),
      headers: { 'content-type': 'image/jpeg' },
    }),
  };
  // Overrides are matched first, so a narrower prefix can shadow a default.
  const routes: Record<string, Route> = { ...overrides };
  for (const [key, route] of Object.entries(defaults)) routes[key] ??= route;
  const fetchImpl = async (url: string, options: SafeFetchOptions): Promise<SafeResponse> => {
    const method = (options.method ?? 'GET').toUpperCase();
    const entry: Seen = {
      method,
      url,
      headers: options.headers ?? {},
      body: options.body,
      options,
    };
    seen.push(entry);
    const key = Object.keys(routes).find((k) => `${method} ${url}`.startsWith(k));
    if (!key) throw new Error(`unexpected request: ${method} ${url}`);
    return answer(url, routes[key]!(entry));
  };
  const noDns = async (): Promise<string[][]> => {
    throw new Error('ENOTFOUND');
  };
  return { seen, fetchImpl, noDns };
}

function provider(net = network(), dns?: (name: string) => Promise<string[][]>) {
  return new BlueskyProvider({
    fetchImpl: net.fetchImpl,
    resolveTxt: dns ?? net.noDns,
    now: () => NOW,
  });
}

const tokens = (
  overrides: Partial<Parameters<typeof encodeBlueskyCredentials>[0]> = {},
): AuthTokens => ({
  accessToken: encodeBlueskyCredentials({
    did: DID,
    handle: HANDLE,
    pds: PDS,
    appPassword: APP_PASSWORD,
    ...overrides,
  }),
  externalId: DID,
  displayName: `@${HANDLE}`,
});

const post = (caption: string, media: PostDetails['media'] = []): PostDetails[] => [
  { caption, media },
];
const image = (n = 1) => ({
  mediaId: MEDIA_ID,
  kind: 'image' as const,
  url: `https://media.example.com/${n}.jpg`,
});
/** The JSON bodies this provider sends, loosely: enough structure for the assertions below. */
interface SentBody {
  identifier?: string;
  password?: string;
  repo?: string;
  collection?: string;
  record: {
    $type?: string;
    text?: string;
    createdAt: string;
    facets?: Array<{ index: { byteStart: number; byteEnd: number }; features: unknown[] }>;
    embed?: { $type: string; images: unknown[] };
  };
}
const json = (seen: Seen | undefined) => JSON.parse(String(seen?.body)) as SentBody;
const calls = (seen: Seen[], nsid: string) => seen.filter((s) => s.url.includes(`/xrpc/${nsid}`));

describe('parseBlueskyIdentifier', () => {
  it.each([
    ['acme.bsky.social', 'acme.bsky.social'],
    ['@Acme.bsky.social ', 'acme.bsky.social'],
    ['https://bsky.app/profile/acme.com', 'acme.com'],
    ['https://bsky.app/profile/acme.com/post/3k4duaz5vfs2b', 'acme.com'],
  ])('reads %j as the handle %s', (typed, handle) => {
    expect(parseBlueskyIdentifier(typed)).toEqual({ kind: 'handle', handle });
  });

  it('accepts a DID', () => {
    expect(parseBlueskyIdentifier(DID)).toEqual({ kind: 'did', did: DID });
    expect(parseBlueskyIdentifier('did:web:acme.example.com')).toEqual({
      kind: 'did',
      did: 'did:web:acme.example.com',
    });
  });

  it.each([
    '',
    'acme',
    'acme..social',
    '-acme.bsky.social',
    'acme.bsky.social:8443',
    'acme.bsky.social/../x',
    'user@acme.com',
    '127.0.0.1',
    'localhost',
    'did:plc:short',
    'did:web:acme.example.com:8443',
    'did:web:acme.example.com%3A8443',
    'did:key:z6Mk',
    `${'a'.repeat(250)}.com`,
  ])('refuses %j before anything is contacted', (typed) => {
    expect(() => parseBlueskyIdentifier(typed)).toThrow(CredentialFormatError);
  });

  it('suggests the full handle when only the name was typed', () => {
    expect(() => parseBlueskyIdentifier('acme')).toThrow(/acme\.bsky\.social/);
  });
});

describe('assertAppPassword', () => {
  it('accepts the xxxx-xxxx-xxxx-xxxx form', () => {
    expect(assertAppPassword(' ABCD-efgh-1234-mnop ')).toBe('abcd-efgh-1234-mnop');
  });

  it.each(['', 'hunter2', 'CorrectHorseBatteryStaple!', 'abcd-efgh-ijkl', 'abcd efgh ijkl mnop'])(
    'refuses %j — a main password must never be entered here',
    (typed) => {
      expect(() => assertAppPassword(typed)).toThrow(CredentialFormatError);
    },
  );

  it('does not repeat what was typed', () => {
    const err = (() => {
      try {
        assertAppPassword('CorrectHorseBatteryStaple!');
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).not.toContain('CorrectHorse');
  });
});

describe('pdsFromDidDocument', () => {
  it('reads the origin of the atproto_pds service', () => {
    expect(pdsFromDidDocument(didDoc())).toBe(PDS);
    expect(
      pdsFromDidDocument(
        didDoc({
          service: [
            { id: `${DID}#atproto_pds`, type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS },
          ],
        }),
      ),
    ).toBe(PDS);
  });

  it.each([
    'http://pds.example.com',
    'https://user:pw@pds.example.com',
    'https://pds.example.com/xrpc/evil',
    'https://pds.example.com/?x=1',
    'https://pds.example.com/#frag',
    'not a url',
    42,
  ])('refuses the endpoint %j', (serviceEndpoint) => {
    const doc = didDoc({
      service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint }],
    });
    expect(pdsFromDidDocument(doc)).toBeNull();
  });

  it('ignores services that are not the PDS, and does not skip a bad PDS entry for a later one', () => {
    expect(
      pdsFromDidDocument(
        didDoc({
          service: [
            {
              id: '#bsky_notif',
              type: 'BskyNotificationService',
              serviceEndpoint: 'https://x.example',
            },
            {
              id: '#atproto_pds',
              type: 'AtprotoPersonalDataServer',
              serviceEndpoint: 'http://a.example',
            },
            { id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS },
          ],
        }),
      ),
    ).toBeNull();
    expect(pdsFromDidDocument({})).toBeNull();
    expect(pdsFromDidDocument(null)).toBeNull();
  });
});

describe('connectWithCredentials', () => {
  const fields = { handle: `@${HANDLE}`, appPassword: APP_PASSWORD };

  it('resolves the handle, signs in once at the PDS its DID document names, and stores that', async () => {
    const net = network();
    const result = await provider(net).connectWithCredentials(fields);
    expect(result.externalId).toBe(DID);
    expect(result.displayName).toBe(`@${HANDLE}`);
    expect(result.refreshToken).toBeUndefined();
    expect(result.expiresAt).toBeUndefined();
    expect(decodeBlueskyCredentials(result.accessToken)).toEqual({
      did: DID,
      handle: HANDLE,
      pds: PDS,
      appPassword: APP_PASSWORD,
    });
    expect(net.seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      `GET https://${HANDLE}/.well-known/atproto-did`,
      `GET https://plc.directory/${DID}`,
      `POST ${PDS}/xrpc/com.atproto.server.createSession`,
    ]);
    expect(json(net.seen[2])).toEqual({ identifier: DID, password: APP_PASSWORD });
    // The session's tokens are not what is kept.
    expect(result.accessToken).not.toContain(ACCESS);
  });

  it('sends the password to the PDS and to nothing else', async () => {
    const net = network();
    await provider(net).connectWithCredentials(fields);
    for (const s of net.seen) {
      const carries = `${s.url} ${JSON.stringify(s.headers)} ${String(s.body ?? '')}`.includes(
        APP_PASSWORD,
      );
      expect(carries).toBe(s.url.startsWith(`${PDS}/xrpc/com.atproto.server.createSession`));
      expect(s.options.maxRedirects ?? 0).toBe(0);
    }
  });

  it('prefers the DNS TXT record, and never contacts the handle’s web server when it has one', async () => {
    const net = network();
    const dns = async (name: string) => {
      expect(name).toBe('_atproto.acme.com');
      return [['v=spf1 -all'], ['did=', DID]];
    };
    const doc = didDoc({ alsoKnownAs: ['at://acme.com'] });
    net.fetchImpl = network({
      [`GET https://plc.directory/${DID}`]: () => ({ body: doc }),
    }).fetchImpl;
    const seen: string[] = [];
    const result = await new BlueskyProvider({
      fetchImpl: async (url, options) => {
        seen.push(url);
        return net.fetchImpl(url, options);
      },
      resolveTxt: dns,
      now: () => NOW,
    }).connectWithCredentials({ handle: 'acme.com', appPassword: APP_PASSWORD });
    expect(result.displayName).toBe(`@${HANDLE}`); // the handle the session reported
    expect(seen.some((u) => u.includes('.well-known/atproto-did'))).toBe(false);
  });

  it('fails resolution when DNS names two different accounts', async () => {
    const net = network({
      [`GET https://${HANDLE}/.well-known/atproto-did`]: () => ({ status: 404 }),
    });
    const dns = async () => [[`did=${DID}`], ['did=did:plc:aaaaaaaaaaaaaaaaaaaaaaaa']];
    await expect(provider(net, dns).connectWithCredentials(fields)).rejects.toThrow(
      /No Bluesky account was found/,
    );
  });

  it('refuses a handle its own DID document does not claim — and never sends the password', async () => {
    const net = network({
      [`GET https://plc.directory/${DID}`]: () => ({
        body: didDoc({ alsoKnownAs: ['at://someone-else.bsky.social'] }),
      }),
    });
    await expect(provider(net).connectWithCredentials(fields)).rejects.toThrow(
      /does not belong to the account/,
    );
    expect(calls(net.seen, 'com.atproto.server.createSession')).toHaveLength(0);
  });

  it('refuses a DID document that is for another DID, or names no usable PDS', async () => {
    const other = network({
      [`GET https://plc.directory/${DID}`]: () => ({ body: didDoc({ id: 'did:plc:other' }) }),
    });
    await expect(provider(other).connectWithCredentials(fields)).rejects.toBeInstanceOf(
      ProviderBadRequestError,
    );
    const noPds = network({
      [`GET https://plc.directory/${DID}`]: () => ({ body: didDoc({ service: [] }) }),
    });
    await expect(provider(noPds).connectWithCredentials(fields)).rejects.toThrow(/usable server/);
    for (const net of [other, noPds]) {
      expect(calls(net.seen, 'com.atproto.server.createSession')).toHaveLength(0);
    }
  });

  it('resolves a did:web account from its own domain', async () => {
    const did = 'did:web:acme.example.com';
    const net = network({
      'GET https://acme.example.com/.well-known/did.json': () => ({
        body: didDoc({ id: did, alsoKnownAs: ['at://acme.example.com'] }),
      }),
      [`POST ${PDS}/xrpc/com.atproto.server.createSession`]: () => ({
        body: { accessJwt: ACCESS, refreshJwt: 'r', handle: 'acme.example.com', did },
      }),
    });
    const result = await provider(net).connectWithCredentials({
      handle: did,
      appPassword: APP_PASSWORD,
    });
    expect(result.externalId).toBe(did);
    expect(result.displayName).toBe('@acme.example.com');
  });

  it('answers a wrong password as an auth error, in words for the person connecting', async () => {
    const net = network({
      [`POST ${PDS}/xrpc/com.atproto.server.createSession`]: () => ({
        status: 401,
        body: { error: 'AuthenticationRequired', message: 'Invalid identifier or password' },
      }),
    });
    const err = await provider(net)
      .connectWithCredentials(fields)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect(err.message).toMatch(/did not accept that handle and app password/);
    expect(err.message).not.toContain(APP_PASSWORD);
  });

  it('says so when the main password was used on an account with email sign-in codes', async () => {
    const net = network({
      [`POST ${PDS}/xrpc/com.atproto.server.createSession`]: () => ({
        status: 401,
        body: { error: 'AuthFactorTokenRequired', message: 'A sign in code has been sent' },
      }),
    });
    await expect(provider(net).connectWithCredentials(fields)).rejects.toThrow(/main password/);
  });

  it('refuses a session for a different account, and an account that is not active', async () => {
    const swapped = network({
      [`POST ${PDS}/xrpc/com.atproto.server.createSession`]: () => ({
        body: { accessJwt: ACCESS, refreshJwt: 'r', handle: HANDLE, did: 'did:plc:other' },
      }),
    });
    await expect(provider(swapped).connectWithCredentials(fields)).rejects.toBeInstanceOf(
      ProviderAuthError,
    );
    const suspended = network({
      [`POST ${PDS}/xrpc/com.atproto.server.createSession`]: () => ({
        body: { accessJwt: ACCESS, handle: HANDLE, did: DID, active: false, status: 'suspended' },
      }),
    });
    await expect(provider(suspended).connectWithCredentials(fields)).rejects.toThrow(/suspended/);
  });

  it('treats an unreachable directory as transient, not as a wrong handle', async () => {
    const net = network({ [`GET https://plc.directory/${DID}`]: () => ({ status: 503 }) });
    await expect(provider(net).connectWithCredentials(fields)).rejects.toBeInstanceOf(
      ProviderTransientError,
    );
  });

  it('rejects malformed input without a single request', async () => {
    const net = network();
    const inputs: Array<Record<string, string>> = [
      { handle: '', appPassword: APP_PASSWORD },
      { handle: HANDLE, appPassword: 'my-real-password' },
      { handle: 'https://10.0.0.5/', appPassword: APP_PASSWORD },
      {},
    ];
    for (const bad of inputs) {
      await expect(provider(net).connectWithCredentials(bad)).rejects.toBeInstanceOf(
        CredentialFormatError,
      );
    }
    expect(net.seen).toHaveLength(0);
  });
});

describe('the PDS and a handle’s domain are user-influenced: the full SSRF guard applies', () => {
  /** The real `safeFetch`, with only DNS and the socket replaced. */
  function guarded(addresses: Record<string, string>, net = network()) {
    const connected: string[] = [];
    const fetchImpl = (url: string, options: SafeFetchOptions) =>
      safeFetch(url, options, {
        resolve: async (host) => {
          const address = addresses[host];
          if (!address) throw new Error('ENOTFOUND');
          return [{ address, family: 4 }];
        },
        transport: async (request) => {
          connected.push(request.url.host);
          const response = await net.fetchImpl(request.url.toString(), {
            method: request.method,
            headers: request.headers,
            body: request.body,
          });
          return { status: response.status, headers: response.headers, body: response.body };
        },
      });
    return { connected, fetchImpl, net };
  }
  const publicHosts = {
    [HANDLE]: '93.184.216.34',
    'plc.directory': '93.184.216.35',
  };

  it('never opens a socket to a PDS that resolves to a private address', async () => {
    const g = guarded({ ...publicHosts, 'morel.us-east.host.bsky.network': '10.0.0.5' });
    const p = new BlueskyProvider({ fetchImpl: g.fetchImpl, resolveTxt: g.net.noDns });
    await expect(
      p.connectWithCredentials({ handle: HANDLE, appPassword: APP_PASSWORD }),
    ).rejects.toBeInstanceOf(ProviderBadRequestError);
    expect(g.connected).toEqual([HANDLE, 'plc.directory']);
  });

  it.each([
    'https://169.254.169.254',
    'https://localhost',
    'https://pds.internal',
    'https://pds.example.com:8443',
  ])('refuses a DID document that points the PDS at %s', async (endpoint) => {
    const g = guarded(
      publicHosts,
      network({
        [`GET https://plc.directory/${DID}`]: () => ({
          body: didDoc({
            service: [
              { id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: endpoint },
            ],
          }),
        }),
      }),
    );
    const p = new BlueskyProvider({ fetchImpl: g.fetchImpl, resolveTxt: g.net.noDns });
    await expect(
      p.connectWithCredentials({ handle: HANDLE, appPassword: APP_PASSWORD }),
    ).rejects.toBeInstanceOf(ProviderBadRequestError);
    expect(g.connected).toEqual([HANDLE, 'plc.directory']);
  });

  it('does not follow a handle domain that resolves somewhere private', async () => {
    const g = guarded({ 'evil.example.com': '127.0.0.1' });
    const p = new BlueskyProvider({ fetchImpl: g.fetchImpl, resolveTxt: g.net.noDns });
    await expect(
      p.connectWithCredentials({ handle: 'evil.example.com', appPassword: APP_PASSWORD }),
    ).rejects.toThrow(/No Bluesky account was found/);
    expect(g.connected).toEqual([]);
  });
});

describe('assertPublishable', () => {
  const p = provider();
  const check = (caption: string, media: PostDetails['media'] = []) =>
    p.assertPublishable(post(caption, media));

  it('allows 300 graphemes and refuses 301, counting what a reader sees', () => {
    expect(() => check('a'.repeat(300))).not.toThrow();
    expect(() => check('a'.repeat(301))).toThrow(
      'The text is 301 characters; Bluesky takes at most 300',
    );
    // 300 emoji are 600 UTF-16 units and 1200 bytes — still 300 characters to Bluesky.
    expect(() => check('👍'.repeat(300))).not.toThrow();
    expect(() => check('👍'.repeat(301))).toThrow(/301 characters/);
    // Hindi: 2 graphemes, 5 code points, 15 bytes per word.
    expect(() => check('हिंदी'.repeat(150))).not.toThrow();
    expect(() => check('हिंदी'.repeat(151))).toThrow(/302 characters/);
  });

  it('also applies the 3000 byte limit, which long emoji sequences reach first', () => {
    const family = '👨‍👩‍👧‍👦'; // one grapheme, 25 bytes
    expect(() => check(family.repeat(120))).not.toThrow();
    expect(() => check(family.repeat(121))).toThrow(/over 3000 bytes/);
  });

  it('takes up to four images and no video', () => {
    expect(() => check('x', [image(1), image(2), image(3), image(4)])).not.toThrow();
    expect(() => check('x', [1, 2, 3, 4, 5].map(image))).toThrow(/at most 4 images/);
    expect(() => check('x', [{ mediaId: MEDIA_ID, kind: 'video' }])).toThrow(/Video is not posted/);
  });

  it('needs text or an image, and exactly one post', () => {
    expect(() => check('   ')).toThrow(/needs text or an image/);
    expect(() => check('', [image()])).not.toThrow();
    expect(() => p.assertPublishable([])).toThrow(/exactly one post/);
  });

  it('decides on kind and count alone — a media ref has no url yet at create time', () => {
    expect(() => check('x', [{ mediaId: MEDIA_ID, kind: 'image' }])).not.toThrow();
  });
});

describe('post', () => {
  it('creates one app.bsky.feed.post record and reports where it is', async () => {
    const net = network();
    const result = await provider(net).post(tokens(), post('Hello Bluesky'));
    expect(result).toEqual({
      externalPostId: `at://${DID}/app.bsky.feed.post/3k4duaz5vfs2b`,
      releaseUrl: `https://bsky.app/profile/${HANDLE}/post/3k4duaz5vfs2b`,
    });
    const [create] = calls(net.seen, 'com.atproto.repo.createRecord');
    expect(create?.headers.authorization).toBe(`Bearer ${ACCESS}`);
    const body = json(create);
    expect(body.repo).toBe(DID);
    expect(body.collection).toBe('app.bsky.feed.post');
    expect(body.record).toMatchObject({ $type: 'app.bsky.feed.post', text: 'Hello Bluesky' });
    expect(new Date(body.record.createdAt).toISOString()).toBe(body.record.createdAt);
    expect(body.record.facets).toBeUndefined();
    expect(body.record.embed).toBeUndefined();
  });

  it('declares every link and tag with byte offsets that slice back to them', async () => {
    const net = network();
    const caption =
      'दिवाली की शुभकामनाएं 🪔✨ देखें https://example.com/diwali और https://example.org/a?b=1। #दिवाली #Diwali';
    await provider(net).post(tokens(), post(caption));
    const { record } = json(calls(net.seen, 'com.atproto.repo.createRecord')[0]);
    expect(record.text).toBe(caption);
    const bytes = Buffer.from(caption, 'utf8');
    const sliced = (record.facets as Array<{ index: { byteStart: number; byteEnd: number } }>).map(
      (f) => bytes.subarray(f.index.byteStart, f.index.byteEnd).toString('utf8'),
    );
    expect(sliced).toEqual([
      'https://example.com/diwali',
      'https://example.org/a?b=1',
      '#दिवाली',
      '#Diwali',
    ]);
    expect(record.facets?.map((f) => f.features[0])).toEqual([
      { $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com/diwali' },
      { $type: 'app.bsky.richtext.facet#link', uri: 'https://example.org/a?b=1' },
      { $type: 'app.bsky.richtext.facet#tag', tag: 'दिवाली' },
      { $type: 'app.bsky.richtext.facet#tag', tag: 'Diwali' },
    ]);
  });

  it('resolves @handles through the public AppView and leaves unknown ones as text', async () => {
    const net = network({
      'GET https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle': (s) =>
        s.url.includes('handle=atproto.com')
          ? { body: { did: 'did:plc:ewvi7nxzyoun6zhxrhs64oiz' } }
          : { status: 400, body: { error: 'InvalidRequest', message: 'Unable to resolve handle' } },
    });
    await provider(net).post(tokens(), post('thanks @atproto.com and @nobody.example.com'));
    const { record } = json(calls(net.seen, 'com.atproto.repo.createRecord')[0]);
    expect(record.facets).toEqual([
      {
        index: { byteStart: 7, byteEnd: 19 },
        features: [
          { $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:ewvi7nxzyoun6zhxrhs64oiz' },
        ],
      },
    ]);
    // Looked up without credentials.
    for (const s of calls(net.seen, 'com.atproto.identity.resolveHandle')) {
      expect(s.headers.authorization).toBeUndefined();
    }
  });

  it('uploads each image as a blob, then embeds them in order', async () => {
    const net = network({
      'GET https://media.example.com/2.png': () => ({
        body: Buffer.from('png-bytes'),
        headers: { 'content-type': 'image/png' },
      }),
    });
    await provider(net).post(
      tokens(),
      post('two images', [image(1), { ...image(2), url: 'https://media.example.com/2.png' }]),
    );
    const uploads = calls(net.seen, 'com.atproto.repo.uploadBlob');
    expect(uploads.map((u) => [u.headers['content-type'], String(u.body)])).toEqual([
      ['image/jpeg', 'jpeg-bytes'],
      ['image/png', 'png-bytes'],
    ]);
    for (const u of uploads) expect(u.headers.authorization).toBe(`Bearer ${ACCESS}`);
    const { record } = json(calls(net.seen, 'com.atproto.repo.createRecord')[0]);
    expect(record.embed?.$type).toBe('app.bsky.embed.images');
    expect(record.embed?.images).toEqual([
      {
        alt: '',
        image: expect.objectContaining({ $type: 'blob', mimeType: 'image/jpeg', size: 10 }),
      },
      {
        alt: '',
        image: expect.objectContaining({ $type: 'blob', mimeType: 'image/png', size: 9 }),
      },
    ]);
    // Uploads come before the record: a failure there leaves nothing posted.
    const order = net.seen.map((s) => s.url.split('/xrpc/')[1] ?? 'media');
    expect(order.indexOf('com.atproto.repo.createRecord')).toBe(order.length - 1);
  });

  it('caps the image download at Bluesky’s 2,000,000 bytes and refuses other file types', async () => {
    const net = network();
    await provider(net).post(tokens(), post('x', [image()]));
    const download = net.seen.find((s) => s.url.startsWith('https://media.example.com/'));
    expect(download?.options.maxResponseBytes).toBe(2_000_000);

    const tooBig = network();
    const inner = tooBig.fetchImpl;
    tooBig.fetchImpl = async (url, options) => {
      if (url.startsWith('https://media.example.com/'))
        throw new SafeFetchError('too_large', 'big');
      return inner(url, options);
    };
    await expect(provider(tooBig).post(tokens(), post('x', [image()]))).rejects.toThrow(
      'The image is larger than 2.0 MB, the most Bluesky takes.',
    );
    expect(calls(tooBig.seen, 'com.atproto.repo.createRecord')).toHaveLength(0);

    const pdf = network({
      'GET https://media.example.com/': () => ({
        body: 'x',
        headers: { 'content-type': 'application/pdf' },
      }),
    });
    await expect(provider(pdf).post(tokens(), post('x', [image()]))).rejects.toThrow(
      /Bluesky takes JPEG, PNG, WebP or GIF/,
    );
  });

  it('logs in once and reuses the session while its token has time left', async () => {
    const net = network();
    const p = provider(net);
    await p.post(tokens(), post('one'));
    await p.post(tokens(), post('two'));
    expect(calls(net.seen, 'com.atproto.server.createSession')).toHaveLength(1);
  });

  it('logs in again once the cached token is close to expiry', async () => {
    let now = NOW;
    const net = network();
    const p = new BlueskyProvider({
      fetchImpl: net.fetchImpl,
      resolveTxt: net.noDns,
      now: () => now,
    });
    await p.post(tokens(), post('one'));
    now += 7200_000 - 30_000;
    await p.post(tokens(), post('two'));
    expect(calls(net.seen, 'com.atproto.server.createSession')).toHaveLength(2);
  });

  it('does not reuse a session across a changed app password', async () => {
    const net = network();
    const p = provider(net);
    await p.post(tokens(), post('one'));
    await p.post(tokens({ appPassword: 'wxyz-wxyz-wxyz-wxyz' }), post('two'));
    const logins = calls(net.seen, 'com.atproto.server.createSession').map((s) => json(s).password);
    expect(logins).toEqual([APP_PASSWORD, 'wxyz-wxyz-wxyz-wxyz']);
  });

  it('replaces a session the server calls expired with one fresh login, once', async () => {
    let refused = 0;
    const net = network({
      [`POST ${PDS}/xrpc/com.atproto.repo.createRecord`]: () =>
        refused++ === 0
          ? { status: 400, body: { error: 'ExpiredToken', message: 'Token has expired' } }
          : { body: { uri: `at://${DID}/app.bsky.feed.post/3kabc` } },
    });
    const result = await provider(net).post(tokens(), post('x'));
    expect(result.releaseUrl).toBe(`https://bsky.app/profile/${HANDLE}/post/3kabc`);
    expect(calls(net.seen, 'com.atproto.server.createSession')).toHaveLength(2);
    expect(calls(net.seen, 'com.atproto.repo.createRecord')).toHaveLength(2);
  });

  it('refuses unreadable stored credentials as an auth error, without quoting them', async () => {
    const err = await provider()
      .post(
        { accessToken: `{"appPassword":"${APP_PASSWORD}"}`, externalId: DID, displayName: 'x' },
        post('x'),
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect(err.message).not.toContain(APP_PASSWORD);
  });

  it('refuses an answer that does not name this account’s post', async () => {
    const net = network({
      [`POST ${PDS}/xrpc/com.atproto.repo.createRecord`]: () => ({
        body: { uri: 'at://did:plc:other/app.bsky.feed.post/3kabc' },
      }),
    });
    await expect(provider(net).post(tokens(), post('x'))).rejects.toThrow(/check the profile/);
  });
});

describe('error mapping', () => {
  const failing = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    network({
      [`POST ${PDS}/xrpc/com.atproto.repo.createRecord`]: () => ({ status, body, headers }),
    });

  it('a revoked app password → auth (needs reconnect)', async () => {
    const net = network({
      [`POST ${PDS}/xrpc/com.atproto.server.createSession`]: () => ({
        status: 401,
        body: { error: 'AuthenticationRequired', message: 'Invalid identifier or password' },
      }),
    });
    const err = await provider(net)
      .post(tokens(), post('x'))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect(err.message).toMatch(/Reconnect the account with a new app password/);
  });

  it('a 401 that survives a fresh login → auth', async () => {
    const net = failing(401, { error: 'AuthenticationRequired', message: 'bad token' });
    await expect(provider(net).post(tokens(), post('x'))).rejects.toBeInstanceOf(ProviderAuthError);
    expect(calls(net.seen, 'com.atproto.repo.createRecord')).toHaveLength(2);
  });

  it('a taken-down or deactivated account → auth', async () => {
    for (const error of ['AccountTakedown', 'AccountDeactivated']) {
      const net = failing(400, { error, message: 'Account is not available' });
      await expect(provider(net).post(tokens(), post('x'))).rejects.toBeInstanceOf(
        ProviderAuthError,
      );
    }
  });

  it('a validation failure → bad request, with Bluesky’s own message', async () => {
    const net = failing(400, {
      error: 'InvalidRequest',
      message:
        'Invalid app.bsky.feed.post record: Record/text must not be longer than 300 graphemes',
    });
    const err = await provider(net)
      .post(tokens(), post('x'))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderBadRequestError);
    expect(err.message).toBe(
      'Bluesky says: Invalid app.bsky.feed.post record: Record/text must not be longer than 300 graphemes [InvalidRequest]',
    );
  });

  it('429 → rate limited (transient), with the server’s wait', async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 90);
    const net = failing(
      429,
      { error: 'RateLimitExceeded', message: 'Rate Limit Exceeded' },
      {
        'ratelimit-reset': reset,
      },
    );
    const err = await provider(net)
      .post(tokens(), post('x'))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    expect(err.message).toMatch(/It asked for a (89|90|91) second wait\./);
  });

  it('5xx → transient', async () => {
    const net = failing(502, 'Bad Gateway');
    const err = await provider(net)
      .post(tokens(), post('x'))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderTransientError);
    expect(err).not.toBeInstanceOf(ProviderRateLimitError);
  });

  it('a timeout AFTER the post was sent is final: it may have been posted', async () => {
    const net = network();
    const inner = net.fetchImpl;
    net.fetchImpl = async (url, options) => {
      if (url.includes('createRecord')) throw new SafeFetchError('timeout', 'no answer', true);
      return inner(url, options);
    };
    const err = await provider(net)
      .post(tokens(), post('x'))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderBadRequestError);
    expect(err.message).toBe(
      'Bluesky did not answer in time. The post may or may not have been published — check the Bluesky profile before retrying, so it is not posted twice.',
    );
  });

  it('a failure before the post was sent, or during an upload, is retried', async () => {
    for (const [match, sent] of [
      ['createRecord', false],
      ['uploadBlob', true],
    ] as const) {
      const net = network();
      const inner = net.fetchImpl;
      net.fetchImpl = async (url, options) => {
        if (url.includes(match)) throw new SafeFetchError('network', 'reset', sent);
        return inner(url, options);
      };
      await expect(provider(net).post(tokens(), post('x', [image()]))).rejects.toBeInstanceOf(
        ProviderTransientError,
      );
    }
  });
});

describe('secrets never reach an error', () => {
  it('whatever fails, and whatever the far side echoes back', async () => {
    // What a server could conceivably repeat: the password at login, the token after it.
    const login = `password ${APP_PASSWORD}`;
    const echo = `${login} token ${ACCESS}`;
    const scenarios: Array<Record<string, Route>> = [
      {
        [`POST ${PDS}/xrpc/com.atproto.server.createSession`]: () => ({
          status: 401,
          body: { error: 'AuthenticationRequired', message: login },
        }),
      },
      {
        [`POST ${PDS}/xrpc/com.atproto.server.createSession`]: () => ({
          status: 400,
          body: { error: login, message: login },
        }),
      },
      {
        [`POST ${PDS}/xrpc/com.atproto.repo.createRecord`]: () => ({
          status: 400,
          body: { error: 'InvalidRequest', message: echo },
        }),
      },
      {
        [`POST ${PDS}/xrpc/com.atproto.repo.createRecord`]: () => ({
          status: 500,
          body: { message: echo },
        }),
      },
      {
        [`POST ${PDS}/xrpc/com.atproto.repo.createRecord`]: () => ({
          status: 429,
          body: { message: echo },
        }),
      },
      {
        [`POST ${PDS}/xrpc/com.atproto.repo.uploadBlob`]: () => ({
          status: 413,
          body: { message: echo },
        }),
      },
    ];
    const messages: string[] = [];
    for (const routes of scenarios) {
      const net = network(routes);
      messages.push(
        String(
          (
            await provider(net)
              .post(tokens(), post('x', [image()]))
              .catch((e) => e)
          ).message,
        ),
        String(
          (
            await provider(network(routes))
              .connectWithCredentials({ handle: HANDLE, appPassword: APP_PASSWORD })
              .catch((e) => e)
          )?.message ?? '',
        ),
      );
    }
    // A transport error that quotes the request, as a careless HTTP layer would.
    const net = network();
    net.fetchImpl = async (url, options) => {
      throw new Error(
        `fetch ${url} failed with body ${String(options.body)} auth ${options.headers?.authorization}`,
      );
    };
    messages.push(
      String(
        (
          await provider(net)
            .post(tokens(), post('x'))
            .catch((e) => e)
        ).message,
      ),
    );
    expect(messages.length).toBeGreaterThan(10);
    for (const message of messages) {
      expect(message).not.toContain(APP_PASSWORD);
      expect(message).not.toContain(ACCESS);
    }
  });

  it('the connect result carries the password only inside the blob that gets encrypted', async () => {
    const result = await provider().connectWithCredentials({
      handle: HANDLE,
      appPassword: APP_PASSWORD,
    });
    const { accessToken, ...rest } = result;
    expect(JSON.stringify(rest)).not.toContain(APP_PASSWORD);
    expect(accessToken).toContain(APP_PASSWORD);
  });
});

describe('analytics', () => {
  const URI = `at://${DID}/app.bsky.feed.post/3k4duaz5vfs2b`;

  it('reads the public counts under Bluesky’s own names, without credentials', async () => {
    const net = network({
      'GET https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts': () => ({
        body: {
          posts: [
            {
              uri: URI,
              cid: 'bafy',
              author: { did: DID, handle: HANDLE },
              record: { text: 'x' },
              replyCount: 3,
              repostCount: 5,
              likeCount: 42,
              quoteCount: 1,
              bookmarkCount: 2,
              indexedAt: '2026-10-11T12:00:00.000Z',
            },
          ],
        },
      }),
    });
    const points = await provider(net).postAnalytics(tokens(), URI);
    expect(Object.fromEntries(points.map((p) => [p.metric, p.value]))).toEqual({
      likeCount: 42,
      repostCount: 5,
      replyCount: 3,
      quoteCount: 1,
      bookmarkCount: 2,
    });
    const [read] = net.seen;
    expect(read?.url).toBe(
      `https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(URI)}`,
    );
    expect(read?.headers.authorization).toBeUndefined();
    expect(calls(net.seen, 'com.atproto.server.createSession')).toHaveLength(0);
  });

  it('reports only the counts Bluesky sent, and nothing for a post that is gone', async () => {
    const some = network({
      'GET https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts': () => ({
        body: { posts: [{ uri: URI, likeCount: 0, replyCount: '3' }] },
      }),
    });
    expect((await provider(some).postAnalytics(tokens(), URI)).map((p) => p.metric)).toEqual([
      'likeCount',
    ]);
    const gone = network({
      'GET https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts': () => ({
        body: { posts: [] },
      }),
    });
    expect(await provider(gone).postAnalytics(tokens(), URI)).toEqual([]);
  });

  it('asks nothing for an id that is not a post uri', async () => {
    const net = network();
    expect(await provider(net).postAnalytics(tokens(), 'https://evil.example/?x')).toEqual([]);
    expect(net.seen).toHaveLength(0);
  });

  it('account numbers: followers for the trend, Bluesky’s own names for the rest', async () => {
    const net = network({
      'GET https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile': () => ({
        body: { did: DID, handle: HANDLE, followersCount: 1200, followsCount: 80, postsCount: 310 },
      }),
    });
    const points = await provider(net).accountAnalytics(tokens());
    expect(Object.fromEntries(points.map((p) => [p.metric, p.value]))).toEqual({
      followers: 1200,
      followsCount: 80,
      postsCount: 310,
    });
    expect(net.seen[0]?.url).toContain(`actor=${encodeURIComponent(DID)}`);
  });

  it('a profile hidden from logged-out readers has no numbers and breaks nothing', async () => {
    const net = network({
      'GET https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile': () => ({
        status: 400,
        body: { error: 'InvalidRequest', message: 'Profile not found' },
      }),
    });
    expect(await provider(net).accountAnalytics(tokens())).toEqual([]);
  });

  it('a throttled read is transient, so the sweep stops rather than flags the account', async () => {
    const net = network({
      'GET https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts': () => ({
        status: 429,
        body: {},
      }),
    });
    await expect(provider(net).postAnalytics(tokens(), URI)).rejects.toBeInstanceOf(
      ProviderRateLimitError,
    );
  });
});

describe('the OAuth-shaped methods', () => {
  it('say how Bluesky is connected instead of producing a URL', async () => {
    const p = provider();
    await expect(p.generateAuthUrl()).rejects.toBeInstanceOf(ProviderBadRequestError);
    await expect(p.authenticate()).rejects.toBeInstanceOf(ProviderBadRequestError);
    await expect(p.refreshToken()).rejects.toBeInstanceOf(ProviderAuthError);
    expect(p.connectInput).toBe('credentials');
    expect(p.tokenModel).toBe('one-time');
  });
});

describe('jwtExpiryMs', () => {
  it('reads exp, and answers null for anything that is not a JWT', () => {
    expect(jwtExpiryMs(jwt(60))).toBe((Math.floor(NOW / 1000) + 60) * 1000);
    for (const junk of ['', 'abc', 'a.b.c', `x.${Buffer.from('{}').toString('base64url')}.y`]) {
      expect(jwtExpiryMs(junk)).toBeNull();
    }
  });
});
