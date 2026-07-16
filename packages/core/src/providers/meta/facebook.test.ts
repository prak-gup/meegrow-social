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
 * Contract tests for the Facebook Pages provider (#14), driven entirely by recorded Graph
 * responses — CI never touches Meta. Fixture shapes are those documented in
 * docs/dev/research/meta.md; the live bring-up (HITL) re-records them if Meta drifts.
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

describe('postAnalytics', () => {
  it('collects per-metric insights plus followers as a node field', async () => {
    const { fb } = provider([
      {
        match: 'insights',
        body: { data: [{ name: 'post_impressions_unique', values: [{ value: 42 }] }] },
      },
      { match: 'followers_count', body: { followers_count: 1234 } },
    ]);
    const points = await fb.postAnalytics(PAGE_TOKENS, '1112223334_9001');

    expect(points.some((p) => p.metric === 'post_impressions_unique' && p.value === 42)).toBe(true);
    // page_fans is deprecated — followers must come from the node field (RESEARCH gotcha #6).
    expect(points.some((p) => p.metric === 'followers' && p.value === 1234)).toBe(true);
  });

  it('skips a metric Meta has retired instead of failing the whole collection', async () => {
    const { fb } = provider([
      {
        match: 'insights',
        status: 400,
        body: { error: { message: '(#100) metric no longer supported', code: 100 } },
      },
      { match: 'followers_count', body: { followers_count: 77 } },
    ]);
    const points = await fb.postAnalytics(PAGE_TOKENS, '1112223334_9001');

    // Every insight metric 400s, but the follower count still lands.
    expect(points).toEqual([expect.objectContaining({ metric: 'followers', value: 77 })]);
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
