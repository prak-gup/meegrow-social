import { describe, expect, it } from 'vitest';
import { FacebookPagesProvider } from './facebook.js';
import { MetaClient, mapMetaError, type FetchLike } from './client.js';
import {
  ProviderAuthError,
  ProviderBadRequestError,
  ProviderTransientError,
} from '../../errors.js';
import type { AuthTokens } from '../types.js';

/**
 * Contract tests for the Facebook Pages provider (#14), driven entirely by canned Graph
 * responses — CI never touches Meta. Fixture shapes are those documented in
 * docs/dev/research/meta.md; the live bring-up (HITL) re-records them if Meta drifts. The
 * postAnalytics fixtures in particular are documentation-built, not recorded (see there).
 */

interface Recorded {
  /** Substring matched against the request URL — first match wins. */
  match: string;
  status?: number;
  body: unknown;
}

interface Call {
  url: string;
  method: string;
  body?: string;
}

function recorder(responses: Recorded[]): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
    const hit = responses.find((r) => url.includes(r.match));
    if (!hit) throw new Error(`no fixture recorded for ${url}`);
    const status = hit.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => hit.body };
  };
  return { fetchImpl, calls };
}

function provider(responses: Recorded[]): { fb: FacebookPagesProvider; calls: Call[] } {
  const { fetchImpl, calls } = recorder(responses);
  const fb = new FacebookPagesProvider(
    new MetaClient({
      appId: '2214641422606935',
      appSecret: 'test-secret',
      loginConfigId: '1379559764274124',
      fetchImpl,
    }),
  );
  return { fb, calls };
}

const PAGE_TOKENS: AuthTokens = {
  accessToken: 'PAGE-TOKEN',
  externalId: '1112223334',
  displayName: 'Meegrow Test Page',
};

const ME_ACCOUNTS: Recorded = {
  match: 'me/accounts',
  body: {
    data: [
      { id: '1112223334', name: 'Meegrow Test Page', access_token: 'PAGE-TOKEN' },
      { id: '5556667778', name: 'Second Page', access_token: 'PAGE-TOKEN-2' },
    ],
  },
};

describe('auth dialog', () => {
  it('uses the Login-for-Business config_id and never an ad-hoc scope list', async () => {
    const { fb } = provider([]);
    const { url } = await fb.generateAuthUrl({
      redirectUri: 'https://social.meegrowlabs.com/connect/callback',
      state: 'flow-123',
    });
    expect(url).toContain('config_id=1379559764274124');
    expect(url).toContain('state=flow-123');
    expect(url).toContain(encodeURIComponent('https://social.meegrowlabs.com/connect/callback'));
    // Passing `scope` alongside config_id is the documented way to break FLB.
    expect(url).not.toContain('scope=');
  });
});

describe('authenticate', () => {
  it('exchanges code -> short-lived -> long-lived user token (both legs, server-side)', async () => {
    const { fb, calls } = provider([
      {
        match: 'fb_exchange_token',
        body: { access_token: 'LONG-USER-TOKEN', expires_in: 5184000 },
      },
      { match: 'oauth/access_token', body: { access_token: 'SHORT-USER-TOKEN' } },
    ]);
    const tokens = await fb.authenticate({
      code: 'auth-code',
      redirectUri: 'https://social.meegrowlabs.com/connect/callback',
    });

    expect(tokens.accessToken).toBe('LONG-USER-TOKEN');
    // Two-phase: identity is unknown until a Page is picked.
    expect(tokens.externalId).toBe('pending');
    expect(calls[0]!.url).toContain('code=auth-code');
    expect(calls[1]!.url).toContain('grant_type=fb_exchange_token');
    expect(calls[1]!.url).toContain('fb_exchange_token=SHORT-USER-TOKEN');
  });
});

describe('listAccounts', () => {
  it('lists pages without leaking page tokens (oauth_flows.accounts is plain JSON)', async () => {
    const { fb } = provider([ME_ACCOUNTS]);
    const accounts = await fb.listAccounts({
      accessToken: 'LONG-USER-TOKEN',
      externalId: 'pending',
      displayName: 'pending',
    });

    expect(accounts).toEqual([
      { externalId: '1112223334', displayName: 'Meegrow Test Page' },
      { externalId: '5556667778', displayName: 'Second Page' },
    ]);
    expect(JSON.stringify(accounts)).not.toContain('PAGE-TOKEN');
  });
});

describe('finalizeAccount — the non-expiring page token swap (#14 AC)', () => {
  it('replaces the 60-day user token with the chosen page token and sets NO expiry', async () => {
    const { fb } = provider([ME_ACCOUNTS]);
    const tokens = await fb.finalizeAccount(
      { accessToken: 'LONG-USER-TOKEN', externalId: 'pending', displayName: 'pending' },
      { externalId: '5556667778', displayName: 'Second Page' },
    );

    expect(tokens.accessToken).toBe('PAGE-TOKEN-2');
    expect(tokens.externalId).toBe('5556667778');
    expect(tokens.displayName).toBe('Second Page');
    // The whole point: no expiry => computeHealth() reports 'healthy' forever, expiresInDays null,
    // and the refresh sweeper's isNotNull(expiresAt) filter never picks it up.
    expect(tokens.expiresAt).toBeUndefined();
  });

  it('raises an auth error when the user no longer manages the chosen page', async () => {
    const { fb } = provider([ME_ACCOUNTS]);
    await expect(
      fb.finalizeAccount(
        { accessToken: 'LONG-USER-TOKEN', externalId: 'pending', displayName: 'pending' },
        { externalId: '9999999999', displayName: 'Revoked Page' },
      ),
    ).rejects.toBeInstanceOf(ProviderAuthError);
  });
});

describe('refreshToken', () => {
  it('always fails — page tokens are one-time, the sweeper must never refresh them', async () => {
    const { fb } = provider([]);
    await expect(fb.refreshToken()).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it('declares the one-time token model so the sweeper filter excludes it', () => {
    const { fb } = provider([]);
    expect(fb.tokenModel).toBe('one-time');
    expect(fb.isBetweenSteps).toBe(true);
  });
});

describe('post', () => {
  it('publishes text to /feed', async () => {
    const { fb, calls } = provider([{ match: '/feed', body: { id: '1112223334_9001' } }]);
    const result = await fb.post(PAGE_TOKENS, [{ caption: 'hello world', media: [] }]);

    expect(result.externalPostId).toBe('1112223334_9001');
    expect(result.releaseUrl).toBe('https://www.facebook.com/1112223334_9001');
    expect(calls[0]!.url).toContain('1112223334/feed');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toContain('message=hello+world');
  });

  it('publishes a single photo to /photos and links to the feed story, not the photo', async () => {
    const { fb, calls } = provider([
      { match: '/photos', body: { id: 'photo-1', post_id: '1112223334_9002' } },
    ]);
    const result = await fb.post(PAGE_TOKENS, [
      {
        caption: 'a picture',
        media: [
          {
            mediaId: '11111111-1111-4111-8111-111111111111',
            kind: 'image',
            url: 'https://cdn.test/a.jpg',
          },
        ],
      },
    ]);

    expect(result.externalPostId).toBe('1112223334_9002');
    expect(calls[0]!.body).toContain(encodeURIComponent('https://cdn.test/a.jpg'));
  });

  it('stages multi-photo albums unpublished, then attaches them to one feed story', async () => {
    const { fb, calls } = provider([
      { match: '/photos', body: { id: 'photo-staged' } },
      { match: '/feed', body: { id: '1112223334_9003' } },
    ]);
    const result = await fb.post(PAGE_TOKENS, [
      {
        caption: 'album',
        media: [
          {
            mediaId: '11111111-1111-4111-8111-111111111111',
            kind: 'image',
            url: 'https://cdn.test/a.jpg',
          },
          {
            mediaId: '22222222-2222-4222-8222-222222222222',
            kind: 'image',
            url: 'https://cdn.test/b.jpg',
          },
        ],
      },
    ]);

    expect(result.externalPostId).toBe('1112223334_9003');
    expect(calls).toHaveLength(3); // two staged photos + one feed story
    expect(calls[0]!.body).toContain('published=false');
    expect(calls[1]!.body).toContain('published=false');
    expect(calls[2]!.body).toContain(encodeURIComponent('{"media_fbid":"photo-staged"}'));
  });

  it('publishes video by public url (Meta fetches it — never a binary upload)', async () => {
    const { fb, calls } = provider([
      { match: '/videos', body: { id: 'vid-1', post_id: '1112223334_9004' } },
    ]);
    const result = await fb.post(PAGE_TOKENS, [
      {
        caption: 'a clip',
        media: [
          {
            mediaId: '33333333-3333-4333-8333-333333333333',
            kind: 'video',
            url: 'https://cdn.test/v.mp4',
          },
        ],
      },
    ]);

    expect(result.externalPostId).toBe('1112223334_9004');
    expect(calls[0]!.url).toContain('1112223334/videos');
    expect(calls[0]!.body).toContain('file_url');
  });

  it('rejects media with no public url as a permanent failure, without calling Meta', async () => {
    const { fb, calls } = provider([]);
    await expect(
      fb.post(PAGE_TOKENS, [
        {
          caption: 'x',
          media: [{ mediaId: '44444444-4444-4444-8444-444444444444', kind: 'image' }],
        },
      ]),
    ).rejects.toBeInstanceOf(ProviderBadRequestError);
    expect(calls).toHaveLength(0);
  });

  it('rejects threads, mixed video+image, and multi-video as bad requests', async () => {
    const { fb } = provider([]);
    const img = {
      mediaId: '11111111-1111-4111-8111-111111111111',
      kind: 'image' as const,
      url: 'https://cdn.test/a.jpg',
    };
    const vid = {
      mediaId: '33333333-3333-4333-8333-333333333333',
      kind: 'video' as const,
      url: 'https://cdn.test/v.mp4',
    };

    await expect(
      fb.post(PAGE_TOKENS, [
        { caption: 'a', media: [] },
        { caption: 'b', media: [] },
      ]),
    ).rejects.toBeInstanceOf(ProviderBadRequestError);
    await expect(
      fb.post(PAGE_TOKENS, [{ caption: 'a', media: [img, vid] }]),
    ).rejects.toBeInstanceOf(ProviderBadRequestError);
    await expect(
      fb.post(PAGE_TOKENS, [
        { caption: 'a', media: [vid, { ...vid, mediaId: '55555555-5555-4555-8555-555555555555' }] },
      ]),
    ).rejects.toBeInstanceOf(ProviderBadRequestError);
  });
});

/**
 * NOT recorded traffic. These insights bodies are built from Meta's public reference (the
 * `{ data: [{ name, period, values: [{ value }] }] }` envelope and the metric names in
 * docs/dev/research/meta.md §5.2.1); no credentials were available when #54 was written. Of the
 * names below only post_clicks and post_video_views have been seen in a live response. Replace with
 * recorded bodies after the first production sweep.
 */
const insight = (name: string, value: unknown): Recorded => ({
  match: `metric=${name}&`,
  body: {
    data: [
      {
        name,
        period: 'lifetime',
        values: [{ value }],
        id: `1112223334_9001/insights/${name}/lifetime`,
      },
    ],
  },
});
const INVALID_METRIC = {
  status: 400,
  body: { error: { message: '(#100) The value must be a valid insights metric', code: 100 } },
};
const DOCUMENTED_INSIGHTS: Recorded[] = [
  insight('post_media_view', 310),
  insight('post_total_media_view_unique', 204),
  insight('post_reactions_like_total', 17),
  insight('post_clicks', 9),
  insight('post_video_views', 0),
];

describe('postAnalytics', () => {
  it('asks for the views-era metrics one per call, and never the retired impressions names', async () => {
    const { fb, calls } = provider(DOCUMENTED_INSIGHTS);
    await fb.postAnalytics(PAGE_TOKENS, '1112223334_9001');

    const requested = calls.map((c) => new URL(c.url).searchParams.get('metric'));
    expect(requested).toEqual([
      'post_media_view',
      'post_total_media_view_unique',
      'post_reactions_like_total',
      'post_clicks',
      'post_video_views',
    ]);
    expect(calls.every((c) => c.url.includes('/1112223334_9001/insights?'))).toBe(true);
    expect(calls.some((c) => c.url.includes('impressions'))).toBe(false);
  });

  it('stores each metric under the name Meta returned, zero included', async () => {
    const { fb } = provider(DOCUMENTED_INSIGHTS);
    const points = await fb.postAnalytics(PAGE_TOKENS, '1112223334_9001');

    expect(Object.fromEntries(points.map((p) => [p.metric, p.value]))).toEqual({
      post_media_view: 310,
      post_total_media_view_unique: 204,
      post_reactions_like_total: 17,
      post_clicks: 9,
      post_video_views: 0,
    });
  });

  it('keeps the other metrics when Meta rejects one name', async () => {
    // If a documented name turns out not to be served, the post loses that column only.
    const { fb } = provider([
      { match: 'metric=post_total_media_view_unique&', ...INVALID_METRIC },
      ...DOCUMENTED_INSIGHTS,
    ]);
    const points = await fb.postAnalytics(PAGE_TOKENS, '1112223334_9001');

    expect(points.map((p) => p.metric)).toEqual([
      'post_media_view',
      'post_reactions_like_total',
      'post_clicks',
      'post_video_views',
    ]);
  });

  it('drops a value that is not a plain number rather than inventing names for its parts', async () => {
    const { fb } = provider([
      insight('post_media_view', { is_from_followers: 200, is_from_ads: 110 }),
      ...DOCUMENTED_INSIGHTS,
    ]);
    const points = await fb.postAnalytics(PAGE_TOKENS, '1112223334_9001');

    expect(points.some((p) => p.metric === 'post_media_view')).toBe(false);
    expect(points).toHaveLength(4);
  });

  it('skips a metric Meta has retired instead of failing the whole collection', async () => {
    const { fb } = provider([
      {
        match: 'insights',
        ...INVALID_METRIC,
      },
    ]);
    // Every requested metric 400s — the call still resolves rather than throwing, so one retired
    // name can't take the whole sweep down with it.
    await expect(fb.postAnalytics(PAGE_TOKENS, '1112223334_9001')).resolves.toEqual([]);
  });

  it('still propagates auth errors so the connection gets flagged', async () => {
    const { fb } = provider([
      {
        match: 'insights',
        status: 400,
        body: { error: { message: 'Session expired', code: 190, error_subcode: 463 } },
      },
    ]);
    await expect(fb.postAnalytics(PAGE_TOKENS, '1112223334_9001')).rejects.toBeInstanceOf(
      ProviderAuthError,
    );
  });
});

describe('accountAnalytics', () => {
  it('reads followers from the node field, not the deprecated page_fans insight', async () => {
    const { fb, calls } = provider([{ match: 'followers_count', body: { followers_count: 1234 } }]);
    const points = await fb.accountAnalytics(PAGE_TOKENS);

    expect(points).toEqual([expect.objectContaining({ metric: 'followers', value: 1234 })]);
    expect(calls[0]!.url).toContain('fields=followers_count');
    expect(calls[0]!.url).not.toContain('insights');
    expect(calls[0]!.url).not.toContain('page_fans');
  });

  it('returns nothing rather than a bogus zero when Meta omits the field', async () => {
    const { fb } = provider([{ match: 'followers_count', body: {} }]);
    await expect(fb.accountAnalytics(PAGE_TOKENS)).resolves.toEqual([]);
  });

  it('propagates auth errors so the sweeper flags the connection', async () => {
    const { fb } = provider([
      {
        match: 'followers_count',
        status: 400,
        body: { error: { message: 'Session expired', code: 190, error_subcode: 463 } },
      },
    ]);
    await expect(fb.accountAnalytics(PAGE_TOKENS)).rejects.toBeInstanceOf(ProviderAuthError);
  });
});

describe('mapMetaError — the taxonomy the scheduler branches on', () => {
  it.each([
    ['expired token subcode', 400, { error: { code: 190, error_subcode: 463 } }, ProviderAuthError],
    [
      'app unauthorized subcode',
      400,
      { error: { code: 190, error_subcode: 458 } },
      ProviderAuthError,
    ],
    ['no page role subcode', 403, { error: { code: 200, error_subcode: 492 } }, ProviderAuthError],
    ['plain invalid token', 400, { error: { code: 190 } }, ProviderAuthError],
    ['permissions error', 403, { error: { code: 10 } }, ProviderAuthError],
    ['app rate limit', 400, { error: { code: 4 } }, ProviderTransientError],
    ['user rate limit', 400, { error: { code: 17 } }, ProviderTransientError],
    ['page rate limit', 400, { error: { code: 32 } }, ProviderTransientError],
    ['temporarily unavailable', 400, { error: { code: 2 } }, ProviderTransientError],
    ['server error', 500, { error: { code: 999 } }, ProviderTransientError],
    ['too many requests', 429, {}, ProviderTransientError],
    ['malformed call', 400, { error: { code: 100 } }, ProviderBadRequestError],
    ['unknown 4xx', 400, {}, ProviderBadRequestError],
  ])('%s -> correct kind', (_label, status, body, expected) => {
    expect(mapMetaError(status, body)).toBeInstanceOf(expected);
  });

  it('keeps the Meta code in the message for debugging', () => {
    const err = mapMetaError(400, {
      error: { message: 'Session expired', code: 190, error_subcode: 463 },
    });
    expect(err.message).toContain('Session expired');
    expect(err.message).toContain('190/463');
  });
});

describe('MetaClient.debugToken', () => {
  it('reads expires_at: 0 (page tokens) as "never expires"', async () => {
    const { fetchImpl } = recorder([
      {
        match: 'debug_token',
        body: { data: { is_valid: true, expires_at: 0, scopes: ['pages_manage_posts'] } },
      },
    ]);
    const client = new MetaClient({ appId: 'a', appSecret: 'b', fetchImpl });
    const info = await client.debugToken('PAGE-TOKEN');

    expect(info.isValid).toBe(true);
    expect(info.expiresAt).toBeNull();
    expect(info.scopes).toContain('pages_manage_posts');
  });
});

/**
 * The fallback for a business-owned Page (`me/accounts` empty without `business_management`).
 * DOCUMENTATION-BUILT fixtures, never recorded: the `granular_scopes` shape is from Meta's
 * debug_token reference and the Page node's `access_token` field from the Page reference. Whether
 * Meta really answers the by-id read for such a Page is unconfirmed (RESEARCH meta.md §2.5).
 */
describe('page discovery when me/accounts is empty (granular-scope fallback, unverified)', () => {
  const USER = { accessToken: 'LONG-USER-TOKEN', externalId: 'pending', displayName: 'pending' };
  const EMPTY_ACCOUNTS: Recorded = { match: 'me/accounts', body: { data: [] } };
  const granted = (granular_scopes: unknown): Recorded => ({
    match: 'debug_token',
    body: { data: { is_valid: true, scopes: ['pages_show_list'], granular_scopes } },
  });
  const PAGE_NODE: Recorded = {
    match: '/1112223334?',
    body: { id: '1112223334', name: 'Business-Owned Page', access_token: 'PAGE-TOKEN' },
  };

  it('offers the Pages the person ticked, read one by one by id', async () => {
    const { fb, calls } = provider([
      EMPTY_ACCOUNTS,
      granted([
        { scope: 'pages_show_list', target_ids: ['1112223334'] },
        { scope: 'pages_manage_posts', target_ids: ['1112223334'] },
        { scope: 'instagram_basic', target_ids: ['17841400000000001'] },
      ]),
      PAGE_NODE,
    ]);

    expect(await fb.listAccounts(USER)).toEqual([
      { externalId: '1112223334', displayName: 'Business-Owned Page' },
    ]);
    // me/accounts first, then the token inspection (app token), then each Page once — and never
    // the Instagram id, which is not a Page.
    expect(calls.map((c) => c.url.split('?')[0]!.split('/').pop())).toEqual([
      'accounts',
      'debug_token',
      '1112223334',
    ]);
    expect(decodeURIComponent(calls[1]!.url)).toContain('input_token=LONG-USER-TOKEN');
    expect(decodeURIComponent(calls[1]!.url)).toContain(
      'access_token=2214641422606935|test-secret',
    );
    expect(decodeURIComponent(calls[2]!.url)).toContain('fields=id,name,access_token');
    expect(calls[2]!.url).toContain('access_token=LONG-USER-TOKEN');
  });

  it('connects such a Page with its own Page token', async () => {
    const { fb } = provider([
      EMPTY_ACCOUNTS,
      granted([{ scope: 'pages_show_list', target_ids: [1112223334] }]),
      PAGE_NODE,
    ]);
    const tokens = await fb.finalizeAccount(USER, {
      externalId: '1112223334',
      displayName: 'Business-Owned Page',
    });
    expect(tokens.accessToken).toBe('PAGE-TOKEN');
    expect(tokens.expiresAt).toBeUndefined();
  });

  it('never runs when me/accounts lists a Page', async () => {
    const { fb, calls } = provider([ME_ACCOUNTS]);
    await fb.listAccounts(USER);
    expect(calls).toHaveLength(1);
  });

  it('offers nothing when the grant was not narrowed to Pages (target_ids omitted)', async () => {
    const { fb, calls } = provider([EMPTY_ACCOUNTS, granted([{ scope: 'pages_show_list' }])]);
    expect(await fb.listAccounts(USER)).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it('leaves out a Page Meta refuses, and keeps the ones it returns', async () => {
    const { fb } = provider([
      EMPTY_ACCOUNTS,
      granted([{ scope: 'pages_show_list', target_ids: ['999', '1112223334'] }]),
      {
        match: '/999?',
        status: 400,
        body: { error: { message: 'Unsupported get request', code: 100, error_subcode: 33 } },
      },
      PAGE_NODE,
    ]);
    expect(await fb.listAccounts(USER)).toEqual([
      { externalId: '1112223334', displayName: 'Business-Owned Page' },
    ]);
  });

  it('degrades to "no pages" when the token inspection itself fails', async () => {
    const { fb } = provider([
      EMPTY_ACCOUNTS,
      { match: 'debug_token', status: 400, body: { error: { message: 'nope', code: 190 } } },
    ]);
    expect(await fb.listAccounts(USER)).toEqual([]);
  });

  it('drops a target id that is not a whole decimal id', async () => {
    const { fetchImpl } = recorder([
      granted([{ scope: 'pages_show_list', target_ids: ['12', 34, 1.5, 'abc', 2 ** 60, null] }]),
    ]);
    const client = new MetaClient({ appId: 'a', appSecret: 'b', fetchImpl });
    expect((await client.debugToken('T')).granularScopes).toEqual([
      { scope: 'pages_show_list', targetIds: ['12', '34'] },
    ]);
  });
});

describe('network failures', () => {
  it('treats a socket-level failure as transient so BullMQ retries', async () => {
    const fb = new FacebookPagesProvider(
      new MetaClient({
        appId: 'a',
        appSecret: 'b',
        fetchImpl: async () => {
          throw new Error('ECONNRESET');
        },
      }),
    );
    await expect(fb.post(PAGE_TOKENS, [{ caption: 'x', media: [] }])).rejects.toBeInstanceOf(
      ProviderTransientError,
    );
  });
});
