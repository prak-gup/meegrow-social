import { describe, expect, it } from 'vitest';
import { InstagramProvider } from './instagram.js';
import { MetaClient, type FetchLike } from './client.js';
import {
  ProviderAuthError,
  ProviderBadRequestError,
  ProviderTransientError,
} from '../../errors.js';
import type { AuthTokens } from '../types.js';

/**
 * Contract tests for the Instagram provider (#13), driven by recorded Graph responses — CI never
 * touches Meta. The async-container poll is driven by an injected no-op sleep, so the video/reel
 * path is exercised without the test waiting on real timers.
 */

interface Recorded {
  match: string;
  status?: number;
  body: unknown;
  /** When set, successive matches return successive bodies (drives the status poll). */
  sequence?: unknown[];
}

interface Call {
  url: string;
  method: string;
  body?: string;
}

function recorder(responses: Recorded[]): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const seqIndex = new Map<string, number>();
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
    const hit = responses.find((r) => url.includes(r.match));
    if (!hit) throw new Error(`no fixture recorded for ${url}`);
    let body = hit.body;
    if (hit.sequence) {
      const i = seqIndex.get(hit.match) ?? 0;
      body = hit.sequence[Math.min(i, hit.sequence.length - 1)];
      seqIndex.set(hit.match, i + 1);
    }
    const status = hit.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fetchImpl, calls };
}

function provider(responses: Recorded[]): { ig: InstagramProvider; calls: Call[] } {
  const { fetchImpl, calls } = recorder(responses);
  const ig = new InstagramProvider(
    new MetaClient({
      appId: '2214641422606935',
      appSecret: 'test-secret',
      loginConfigId: '1379559764274124',
      fetchImpl,
    }),
    { sleep: async () => undefined, statusDelayMs: 0, statusAttempts: 5 },
  );
  return { ig, calls };
}

const IG_TOKENS: AuthTokens = {
  accessToken: 'PAGE-TOKEN',
  externalId: '17841400000000001', // IG user id
  displayName: '@meegrow',
};

const IMG = {
  mediaId: '11111111-1111-4111-8111-111111111111',
  kind: 'image' as const,
  url: 'https://cdn.test/a.jpg',
};
const IMG2 = {
  ...IMG,
  mediaId: '22222222-2222-4222-8222-222222222222',
  url: 'https://cdn.test/b.jpg',
};
const VID = {
  mediaId: '33333333-3333-4333-8333-333333333333',
  kind: 'video' as const,
  url: 'https://cdn.test/v.mp4',
};

const ME_ACCOUNTS: Recorded = {
  match: 'me/accounts',
  body: {
    data: [
      {
        id: '1112223334',
        name: 'Meegrow Test Page',
        access_token: 'PAGE-TOKEN',
        instagram_business_account: { id: '17841400000000001', username: 'meegrow' },
      },
      { id: '5556667778', name: 'Page With No IG', access_token: 'PAGE-TOKEN-2' },
    ],
  },
};

describe('listAccounts', () => {
  it('offers IG accounts (by handle), not Pages, and hides Pages with no linked IG', async () => {
    const { ig } = provider([ME_ACCOUNTS]);
    const accounts = await ig.listAccounts({
      accessToken: 'LONG-USER-TOKEN',
      externalId: 'pending',
      displayName: 'pending',
    });

    // "Page With No IG" would fail at publish time — never offer it.
    expect(accounts).toEqual([{ externalId: '17841400000000001', displayName: '@meegrow' }]);
  });

  it('asks for the linked IG account in the field expansion', async () => {
    const { ig, calls } = provider([ME_ACCOUNTS]);
    await ig.listAccounts({ accessToken: 'T', externalId: 'pending', displayName: 'pending' });
    expect(decodeURIComponent(calls[0]!.url)).toContain('instagram_business_account{id,username}');
  });

  it('falls back to the Page name when IG gives no username', async () => {
    const { ig } = provider([
      {
        match: 'me/accounts',
        body: {
          data: [
            {
              id: '1',
              name: 'Fallback Page',
              access_token: 'T',
              instagram_business_account: { id: '999' },
            },
          ],
        },
      },
    ]);
    const accounts = await ig.listAccounts({
      accessToken: 'T',
      externalId: 'pending',
      displayName: 'pending',
    });
    expect(accounts).toEqual([{ externalId: '999', displayName: 'Fallback Page' }]);
  });
});

/**
 * DOCUMENTATION-BUILT fixtures, never recorded — the same unverified fallback as the Facebook
 * provider (see facebook.test.ts and RESEARCH meta.md §2.5), reaching the IG account through the
 * Page the person ticked.
 */
describe('listAccounts when me/accounts is empty (granular-scope fallback, unverified)', () => {
  const USER = { accessToken: 'LONG-USER-TOKEN', externalId: 'pending', displayName: 'pending' };
  const FALLBACK: Recorded[] = [
    { match: 'me/accounts', body: { data: [] } },
    {
      match: 'debug_token',
      body: {
        data: {
          is_valid: true,
          granular_scopes: [
            { scope: 'pages_show_list', target_ids: ['1112223334', '5556667778'] },
            { scope: 'instagram_basic', target_ids: ['17841400000000001'] },
          ],
        },
      },
    },
    {
      match: '/1112223334?',
      body: {
        id: '1112223334',
        name: 'Business-Owned Page',
        access_token: 'PAGE-TOKEN',
        instagram_business_account: { id: '17841400000000001', username: 'meegrow' },
      },
    },
    {
      match: '/5556667778?',
      body: { id: '5556667778', name: 'Page With No IG', access_token: 'PAGE-TOKEN-2' },
    },
  ];

  it('offers the IG account linked to a ticked Page, and still hides a Page with none', async () => {
    const { ig, calls } = provider(FALLBACK);
    expect(await ig.listAccounts(USER)).toEqual([
      { externalId: '17841400000000001', displayName: '@meegrow' },
    ]);
    expect(decodeURIComponent(calls[2]!.url)).toContain('instagram_business_account{id,username}');
  });

  it('connects it with the Page token of that Page', async () => {
    const { ig } = provider(FALLBACK);
    const tokens = await ig.finalizeAccount(USER, {
      externalId: '17841400000000001',
      displayName: '@meegrow',
    });
    expect(tokens.accessToken).toBe('PAGE-TOKEN');
    expect(tokens.externalId).toBe('17841400000000001');
  });
});

describe('finalizeAccount', () => {
  it('stores the IG user id as identity and the PAGE token as credential, with no expiry', async () => {
    const { ig } = provider([ME_ACCOUNTS]);
    const tokens = await ig.finalizeAccount(
      { accessToken: 'LONG-USER-TOKEN', externalId: 'pending', displayName: 'pending' },
      { externalId: '17841400000000001', displayName: '@meegrow' },
    );

    expect(tokens.accessToken).toBe('PAGE-TOKEN'); // IG-via-Page authorises through the Page
    expect(tokens.externalId).toBe('17841400000000001'); // what /media addresses
    expect(tokens.expiresAt).toBeUndefined(); // page tokens don't expire => health stays healthy
  });

  it('raises auth error when the IG account is no longer reachable', async () => {
    const { ig } = provider([ME_ACCOUNTS]);
    await expect(
      ig.finalizeAccount(
        { accessToken: 'T', externalId: 'pending', displayName: 'pending' },
        { externalId: 'gone', displayName: '@gone' },
      ),
    ).rejects.toBeInstanceOf(ProviderAuthError);
  });
});

const PERMALINK: Recorded = {
  match: 'permalink',
  body: { permalink: 'https://www.instagram.com/p/CxYz123/' },
};

describe('post — single image', () => {
  it('creates a container then publishes it', async () => {
    const { ig, calls } = provider([
      { match: '/media_publish', body: { id: 'IG_MEDIA_1' } },
      { match: '/media', body: { id: 'CONTAINER_1' } },
      PERMALINK,
    ]);
    const result = await ig.post(IG_TOKENS, [{ caption: 'hello', media: [IMG] }]);

    expect(result.externalPostId).toBe('IG_MEDIA_1');
    expect(calls[0]!.url).toContain('17841400000000001/media');
    expect(calls[0]!.body).toContain(encodeURIComponent('https://cdn.test/a.jpg'));
    expect(calls[0]!.body).toContain('caption=hello');
    // No media_type for a plain image — Meta defaults to IMAGE.
    expect(calls[0]!.body).not.toContain('media_type');
    expect(calls[1]!.url).toContain('media_publish');
    expect(calls[1]!.body).toContain('creation_id=CONTAINER_1');
  });
});

describe('releaseUrl', () => {
  it('FETCHES the permalink — a shortcode URL cannot be built from the media id', async () => {
    const { ig } = provider([
      { match: '/media_publish', body: { id: 'IG_MEDIA_1' } },
      { match: '/media', body: { id: 'CONTAINER_1' } },
      PERMALINK,
    ]);
    const result = await ig.post(IG_TOKENS, [{ caption: 'hello', media: [IMG] }]);

    expect(result.releaseUrl).toBe('https://www.instagram.com/p/CxYz123/');
    // `instagram.com/p/<numeric media id>` 404s — the permalink is an opaque shortcode.
    expect(result.releaseUrl).not.toContain('IG_MEDIA_1');
  });

  it('falls back to the profile URL rather than failing an already-published post', async () => {
    const { ig } = provider([
      { match: '/media_publish', body: { id: 'IG_MEDIA_1' } },
      { match: '/media', body: { id: 'CONTAINER_1' } },
      { match: 'permalink', status: 500, body: { error: { message: 'boom', code: 1 } } },
    ]);
    // The post is live by now; losing it over a cosmetic link would be the wrong trade.
    const result = await ig.post(IG_TOKENS, [{ caption: 'hello', media: [IMG] }]);

    expect(result.externalPostId).toBe('IG_MEDIA_1');
    expect(result.releaseUrl).toBe('https://www.instagram.com/meegrow/');
  });
});

describe('post — video/reel (the async container path)', () => {
  it('polls status until FINISHED, then publishes', async () => {
    const { ig, calls } = provider([
      { match: '/media_publish', body: { id: 'IG_REEL_1' } },
      { match: '/media', body: { id: 'CONTAINER_V' } },
      {
        match: 'status_code',
        body: {},
        sequence: [
          { status_code: 'IN_PROGRESS' },
          { status_code: 'IN_PROGRESS' },
          { status_code: 'FINISHED' },
        ],
      },
    ]);
    const result = await ig.post(IG_TOKENS, [{ caption: 'a reel', media: [VID] }]);

    expect(result.externalPostId).toBe('IG_REEL_1');
    expect(calls[0]!.body).toContain('media_type=REELS');
    expect(calls[0]!.body).toContain('share_to_feed=true');
    // Three status checks (IN_PROGRESS, IN_PROGRESS, FINISHED) before publishing.
    expect(calls.filter((c) => c.url.includes('status_code'))).toHaveLength(3);
  });

  it('treats container ERROR as permanent — a retry would fail identically', async () => {
    const { ig } = provider([
      { match: '/media', body: { id: 'CONTAINER_V' } },
      { match: 'status_code', body: { status_code: 'ERROR', status: 'bad codec' } },
    ]);
    await expect(ig.post(IG_TOKENS, [{ caption: 'x', media: [VID] }])).rejects.toBeInstanceOf(
      ProviderBadRequestError,
    );
  });

  it('treats an EXPIRED container as permanent', async () => {
    const { ig } = provider([
      { match: '/media', body: { id: 'CONTAINER_V' } },
      { match: 'status_code', body: { status_code: 'EXPIRED' } },
    ]);
    await expect(ig.post(IG_TOKENS, [{ caption: 'x', media: [VID] }])).rejects.toBeInstanceOf(
      ProviderBadRequestError,
    );
  });

  it('treats "still processing" as transient so BullMQ retries', async () => {
    const { ig } = provider([
      { match: '/media', body: { id: 'CONTAINER_V' } },
      { match: 'status_code', body: { status_code: 'IN_PROGRESS' } },
    ]);
    await expect(ig.post(IG_TOKENS, [{ caption: 'x', media: [VID] }])).rejects.toBeInstanceOf(
      ProviderTransientError,
    );
  });
});

describe('post — carousel', () => {
  it('creates child containers, then a parent, then publishes the parent', async () => {
    const { ig, calls } = provider([
      { match: '/media_publish', body: { id: 'IG_CAROUSEL_1' } },
      {
        match: '/media',
        body: {},
        sequence: [{ id: 'CHILD_1' }, { id: 'CHILD_2' }, { id: 'PARENT' }],
      },
    ]);
    const result = await ig.post(IG_TOKENS, [{ caption: 'album', media: [IMG, IMG2] }]);

    expect(result.externalPostId).toBe('IG_CAROUSEL_1');
    expect(calls[0]!.body).toContain('is_carousel_item=true');
    expect(calls[1]!.body).toContain('is_carousel_item=true');
    const parent = calls[2]!.body!;
    expect(parent).toContain('media_type=CAROUSEL');
    expect(parent).toContain('children=CHILD_1%2CCHILD_2');
    // Caption belongs on the parent, not the children.
    expect(parent).toContain('caption=album');
    expect(calls[0]!.body).not.toContain('caption=album');
    expect(calls[3]!.body).toContain('creation_id=PARENT');
  });

  it('rejects more than 10 items without calling Meta', async () => {
    const { ig, calls } = provider([]);
    const many = Array.from({ length: 11 }, (_, i) => ({ ...IMG, mediaId: `id-${i}` }));
    await expect(ig.post(IG_TOKENS, [{ caption: 'x', media: many }])).rejects.toBeInstanceOf(
      ProviderBadRequestError,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('post — rejections that must never reach Meta', () => {
  it('rejects a text-only post: instagram has no such thing', async () => {
    const { ig, calls } = provider([]);
    await expect(ig.post(IG_TOKENS, [{ caption: 'just words', media: [] }])).rejects.toBeInstanceOf(
      ProviderBadRequestError,
    );
    expect(calls).toHaveLength(0);
  });

  it('rejects media with no public url — instagram fetches by url', async () => {
    const { ig, calls } = provider([]);
    await expect(
      ig.post(IG_TOKENS, [{ caption: 'x', media: [{ ...IMG, url: undefined }] }]),
    ).rejects.toBeInstanceOf(ProviderBadRequestError);
    expect(calls).toHaveLength(0);
  });

  it('rejects threads', async () => {
    const { ig } = provider([]);
    await expect(
      ig.post(IG_TOKENS, [
        { caption: 'a', media: [IMG] },
        { caption: 'b', media: [IMG2] },
      ]),
    ).rejects.toBeInstanceOf(ProviderBadRequestError);
  });
});

describe('analytics', () => {
  it('requests views-era metrics, never impressions', async () => {
    const { ig, calls } = provider([
      { match: 'insights', body: { data: [{ name: 'views', values: [{ value: 12 }] }] } },
    ]);
    const points = await ig.postAnalytics(IG_TOKENS, 'IG_MEDIA_1');

    expect(points.some((p) => p.metric === 'views' && p.value === 12)).toBe(true);
    // impressions was retired Nov 2025–Jun 2026 (RESEARCH meta.md §6).
    expect(calls.every((c) => !c.url.includes('metric=impressions'))).toBe(true);
  });

  it('skips a retired metric rather than losing the whole collection', async () => {
    // Proven live on #14: Meta 400s the entire call on one unknown name.
    const { ig } = provider([
      { match: 'insights', status: 400, body: { error: { message: 'bad metric', code: 100 } } },
    ]);
    await expect(ig.postAnalytics(IG_TOKENS, 'IG_MEDIA_1')).resolves.toEqual([]);
  });

  it('propagates auth errors so the sweeper flags the connection', async () => {
    const { ig } = provider([
      {
        match: 'insights',
        status: 400,
        body: { error: { message: 'Session expired', code: 190, error_subcode: 463 } },
      },
    ]);
    await expect(ig.postAnalytics(IG_TOKENS, 'IG_MEDIA_1')).rejects.toBeInstanceOf(
      ProviderAuthError,
    );
  });

  it('reads followers off the IG user node', async () => {
    const { ig, calls } = provider([{ match: 'followers_count', body: { followers_count: 42 } }]);
    const points = await ig.accountAnalytics(IG_TOKENS);

    expect(points).toEqual([expect.objectContaining({ metric: 'followers', value: 42 })]);
    expect(calls[0]!.url).toContain('17841400000000001');
  });
});

describe('token model', () => {
  it('is a two-phase, non-refreshable provider', async () => {
    const { ig } = provider([]);
    expect(ig.isBetweenSteps).toBe(true);
    expect(ig.tokenModel).toBe('one-time');
    await expect(ig.refreshToken()).rejects.toBeInstanceOf(ProviderAuthError);
  });
});
