import { describe, expect, it } from 'vitest';
import { FacebookPagesProvider, normalizePagePost } from './facebook.js';
import { InstagramProvider, normalizeIgMedia } from './instagram.js';
import {
  MetaClient,
  cursorParams,
  mapMetaError,
  nextPageCursor,
  readMetaUsage,
  type FetchLike,
} from './client.js';
import { ProviderAuthError, ProviderRateLimitError, ProviderTransientError } from '../../errors.js';
import type { AuthTokens } from '../types.js';

/**
 * Reading an account's existing posts (import past posts), for both Meta providers.
 *
 * EVERY FIXTURE HERE IS DOCUMENTATION-BUILT, NOT RECORDED: the response shapes are the ones Meta's
 * public reference describes (docs/dev/research/meta.md §7, read 2026-10-11). No Graph call was
 * made to produce them. The first live import must re-record them — see the bring-up checklist there.
 */

interface Recorded {
  /** Substring matched against the request URL — first match wins. */
  match: string;
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

function recorder(responses: Recorded[]): { fetchImpl: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    urls.push(url);
    const hit = responses.find((r) => url.includes(r.match));
    if (!hit) throw new Error(`no fixture recorded for ${url}`);
    const status = hit.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => hit.body,
      headers: { get: (name) => hit.headers?.[name.toLowerCase()] ?? null },
    };
  };
  return { fetchImpl, urls };
}

const client = (fetchImpl: FetchLike) =>
  new MetaClient({ appId: '2214641422606935', appSecret: 'test-secret', fetchImpl });

const PAGE: AuthTokens = {
  accessToken: 'PAGE-TOKEN',
  externalId: '1112223334',
  displayName: 'City Hospital',
};
const IG: AuthTokens = {
  accessToken: 'PAGE-TOKEN',
  externalId: '17841400000000001',
  displayName: '@cityhospital',
};

const SINCE = new Date('2026-07-13T00:00:00.000Z');
const UNTIL = new Date('2026-10-11T11:45:00.000Z');
const params = (url: string) => new URL(url).searchParams;

// --- Facebook -----------------------------------------------------------------------------------

/** A photo post, a video post, an album, a link share and a text post, as the reference shapes them. */
const FB_PAGE_ONE = {
  data: [
    {
      id: '1112223334_900000000000005',
      message: 'Flu clinic opens Monday. Walk-ins welcome.',
      created_time: '2026-10-09T05:30:00+0000',
      permalink_url: 'https://www.facebook.com/cityhospital/posts/pfbid0photo',
      full_picture: 'https://scontent.xx.fbcdn.net/v/t39/photo_720.jpg?oe=6712AB34',
      status_type: 'added_photos',
      is_published: true,
      attachments: {
        data: [{ media_type: 'photo', type: 'photo', target: { id: '900000000000105' } }],
      },
    },
    {
      id: '1112223334_900000000000004',
      message: 'Meet our new cardiology wing',
      created_time: '2026-10-05T09:00:00+0000',
      permalink_url: 'https://www.facebook.com/cityhospital/videos/900000000000204',
      full_picture: 'https://scontent.xx.fbcdn.net/v/t15/video_still.jpg?oe=6712AB35',
      status_type: 'added_video',
      attachments: {
        data: [{ media_type: 'video', type: 'video_inline', target: { id: '900000000000204' } }],
      },
    },
    {
      id: '1112223334_900000000000003',
      message: 'Open day in pictures',
      created_time: '2026-09-28T12:15:00+0000',
      permalink_url: 'https://www.facebook.com/cityhospital/posts/pfbid0album',
      full_picture: 'https://scontent.xx.fbcdn.net/v/t39/album_first.jpg?oe=6712AB36',
      status_type: 'added_photos',
      attachments: {
        data: [
          {
            media_type: 'album',
            type: 'album',
            target: { id: '900000000000300' },
            subattachments: {
              data: [
                { media_type: 'photo', type: 'photo', target: { id: '900000000000301' } },
                { media_type: 'photo', type: 'photo', target: { id: '900000000000302' } },
                { media_type: 'photo', type: 'photo', target: { id: '900000000000303' } },
              ],
            },
          },
        ],
      },
    },
    {
      id: '1112223334_900000000000002',
      message: 'Our annual report is out https://cityhospital.test/report',
      created_time: '2026-09-20T07:00:00+0000',
      permalink_url: 'https://www.facebook.com/cityhospital/posts/pfbid0link',
      full_picture: 'https://external.xx.fbcdn.net/safe_image.php?url=report.png',
      status_type: 'shared_story',
      attachments: { data: [{ media_type: 'link', type: 'share' }] },
    },
    {
      id: '1112223334_900000000000001',
      message: 'Visiting hours change on Monday.',
      created_time: '2026-09-15T07:00:00+0000',
      permalink_url: 'https://www.facebook.com/cityhospital/posts/pfbid0text',
      status_type: 'mobile_status_update',
    },
  ],
  paging: {
    cursors: { before: 'QVFI', after: 'QVFJ' },
    next: 'https://graph.facebook.com/v21.0/1112223334/published_posts?access_token=PAGE-TOKEN&fields=id%2Cmessage&limit=25&since=1783900800&until=1791632700&after=QVFJ',
  },
};

describe('Facebook listPublishedPosts', () => {
  const fb = (responses: Recorded[]) => {
    const { fetchImpl, urls } = recorder(responses);
    return { provider: new FacebookPagesProvider(client(fetchImpl)), urls };
  };

  it('reads the Page node’s published_posts with the Page token — not feed, not me/accounts', async () => {
    const { provider, urls } = fb([{ match: 'published_posts', body: FB_PAGE_ONE }]);
    await provider.listPublishedPosts(PAGE, { since: SINCE, until: UNTIL, limit: 25 });

    expect(urls).toHaveLength(1);
    const url = new URL(urls[0]!);
    expect(url.pathname).toBe('/v21.0/1112223334/published_posts');
    expect(urls[0]).not.toContain('/feed');
    expect(urls[0]).not.toContain('me/accounts');
    const q = params(urls[0]!);
    expect(q.get('access_token')).toBe('PAGE-TOKEN');
    expect(q.get('limit')).toBe('25');
    expect(q.get('since')).toBe(String(SINCE.getTime() / 1000));
    expect(q.get('until')).toBe(String(UNTIL.getTime() / 1000));
    for (const field of ['id', 'message', 'created_time', 'permalink_url', 'full_picture']) {
      expect(q.get('fields')).toContain(field);
    }
    expect(q.get('fields')).toContain('attachments{');
  });

  it('never asks for more than the 100 posts a page Meta allows', async () => {
    const { provider, urls } = fb([{ match: 'published_posts', body: { data: [] } }]);
    await provider.listPublishedPosts(PAGE, { since: SINCE, limit: 500 });
    expect(params(urls[0]!).get('limit')).toBe('100');
    expect(params(urls[0]!).has('until')).toBe(false);
  });

  it('normalises photo, video, album, link and text posts', async () => {
    const { provider } = fb([{ match: 'published_posts', body: FB_PAGE_ONE }]);
    const { items } = await provider.listPublishedPosts(PAGE, { since: SINCE, limit: 25 });

    expect(items.map((i) => [i.mediaKind, i.mediaCount])).toEqual([
      ['image', 1],
      ['video', 1],
      ['image', 3],
      ['image', 1],
      [null, 0],
    ]);
    expect(items[0]).toMatchObject({
      externalPostId: '1112223334_900000000000005',
      caption: 'Flu clinic opens Monday. Walk-ins welcome.',
      publishedAt: new Date('2026-10-09T05:30:00.000Z'),
      permalink: 'https://www.facebook.com/cityhospital/posts/pfbid0photo',
      thumbnailUrl: 'https://scontent.xx.fbcdn.net/v/t39/photo_720.jpg?oe=6712AB34',
    });
    expect(items[4]).toMatchObject({ thumbnailUrl: null, mediaKind: null });
  });

  it('carries the ids and links a post this app published may be stored under', async () => {
    const { provider } = fb([{ match: 'published_posts', body: FB_PAGE_ONE }]);
    const { items } = await provider.listPublishedPosts(PAGE, { since: SINCE, limit: 25 });
    // post() returns the VIDEO id for an upload; the listing's own id is the feed story.
    expect(items[1]!.alternateIds).toEqual(['900000000000204']);
    expect(items[1]!.knownUrls).toEqual([
      'https://www.facebook.com/1112223334_900000000000004',
      'https://www.facebook.com/900000000000204',
    ]);
    expect(items[2]!.alternateIds).toEqual([
      '900000000000300',
      '900000000000301',
      '900000000000302',
      '900000000000303',
    ]);
    expect(items[4]!.alternateIds).toEqual([]);
  });

  it('hands back the next page as a cursor that does not carry the access token', async () => {
    const { provider, urls } = fb([{ match: 'published_posts', body: FB_PAGE_ONE }]);
    const first = await provider.listPublishedPosts(PAGE, {
      since: SINCE,
      until: UNTIL,
      limit: 25,
    });
    expect(first.nextCursor).toBeTruthy();
    expect(first.nextCursor).not.toContain('PAGE-TOKEN');
    expect(first.nextCursor).not.toContain('access_token');

    await provider.listPublishedPosts(PAGE, { since: SINCE, limit: 25, cursor: first.nextCursor! });
    const q = params(urls[1]!);
    // Exactly what Meta put on its `next` link, with the token added back.
    expect(q.get('after')).toBe('QVFJ');
    expect(q.get('since')).toBe('1783900800');
    expect(q.get('until')).toBe('1791632700');
    expect(q.get('access_token')).toBe('PAGE-TOKEN');
  });

  it('reports the last page as having no cursor', async () => {
    const { provider } = fb([
      { match: 'published_posts', body: { data: [], paging: { cursors: { after: 'x' } } } },
    ]);
    expect((await provider.listPublishedPosts(PAGE, { since: SINCE, limit: 25 })).nextCursor).toBe(
      null,
    );
  });

  it('skips a post that is not published yet, and one without an id or a time', () => {
    const base = { id: '1_2', created_time: '2026-10-01T00:00:00+0000' };
    expect(normalizePagePost({ ...base, is_published: false })).toBeNull();
    expect(normalizePagePost({ created_time: base.created_time })).toBeNull();
    expect(normalizePagePost({ id: base.id })).toBeNull();
    expect(normalizePagePost({ id: base.id, created_time: 'not a date' })).toBeNull();
    expect(normalizePagePost(base)).toMatchObject({ externalPostId: '1_2', caption: '' });
  });

  it('reports the rate-limit usage Meta put on the response', async () => {
    const { provider } = fb([
      {
        match: 'published_posts',
        body: { data: [] },
        headers: {
          'x-business-use-case-usage': JSON.stringify({
            '1112223334': [
              {
                type: 'pages',
                call_count: 41,
                total_cputime: 12,
                total_time: 58,
                estimated_time_to_regain_access: 0,
              },
            ],
          }),
        },
      },
    ]);
    expect((await provider.listPublishedPosts(PAGE, { since: SINCE, limit: 25 })).usage).toEqual({
      percent: 58,
      regainAccessMinutes: null,
    });
  });

  it('surfaces being throttled as a rate-limit error, and a dead token as an auth error', async () => {
    const throttled = fb([
      {
        match: 'published_posts',
        status: 400,
        body: { error: { code: 80001, message: 'There have been too many calls to this Page' } },
      },
    ]);
    await expect(
      throttled.provider.listPublishedPosts(PAGE, { since: SINCE, limit: 25 }),
    ).rejects.toBeInstanceOf(ProviderRateLimitError);

    const dead = fb([
      { match: 'published_posts', status: 400, body: { error: { code: 190, message: 'expired' } } },
    ]);
    await expect(
      dead.provider.listPublishedPosts(PAGE, { since: SINCE, limit: 25 }),
    ).rejects.toBeInstanceOf(ProviderAuthError);
  });
});

// --- Instagram ----------------------------------------------------------------------------------

const IG_PAGE_ONE = {
  data: [
    {
      id: '17900000000000004',
      caption: 'Flu clinic opens Monday #health',
      media_type: 'IMAGE',
      media_product_type: 'FEED',
      media_url: 'https://scontent.cdninstagram.com/v/t51/photo.jpg?oe=6712AB34',
      permalink: 'https://www.instagram.com/p/DAbc123/',
      timestamp: '2026-10-09T05:31:00+0000',
    },
    {
      id: '17900000000000003',
      caption: 'A day in the cardiology wing',
      media_type: 'VIDEO',
      media_product_type: 'REELS',
      media_url: 'https://scontent.cdninstagram.com/v/t50/reel.mp4?oe=6712AB35',
      thumbnail_url: 'https://scontent.cdninstagram.com/v/t51/reel_cover.jpg?oe=6712AB35',
      permalink: 'https://www.instagram.com/reel/DAbc456/',
      timestamp: '2026-10-05T09:01:00+0000',
    },
    {
      id: '17900000000000002',
      caption: 'Open day',
      media_type: 'CAROUSEL_ALBUM',
      media_product_type: 'FEED',
      permalink: 'https://www.instagram.com/p/DAbc789/',
      timestamp: '2026-09-28T12:16:00+0000',
      children: {
        data: [
          {
            id: '17900000000000021',
            media_type: 'IMAGE',
            media_url: 'https://scontent.cdninstagram.com/v/t51/slide1.jpg?oe=6712AB36',
          },
          {
            id: '17900000000000022',
            media_type: 'VIDEO',
            media_url: 'https://scontent.cdninstagram.com/v/t50/slide2.mp4',
            thumbnail_url: 'https://scontent.cdninstagram.com/v/t51/slide2.jpg',
          },
        ],
      },
    },
    {
      // Copyrighted audio: Meta omits media_url. The still is still there.
      id: '17900000000000001',
      media_type: 'VIDEO',
      media_product_type: 'REELS',
      thumbnail_url: 'https://scontent.cdninstagram.com/v/t51/reel2_cover.jpg',
      permalink: 'https://www.instagram.com/reel/DAbc000/',
      timestamp: '2026-09-20T07:00:00+0000',
    },
  ],
  paging: {
    cursors: { before: 'QVFI', after: 'QVFK' },
    next: 'https://graph.facebook.com/v21.0/17841400000000001/media?access_token=PAGE-TOKEN&fields=id&limit=25&after=QVFK',
  },
};

describe('Instagram listPublishedPosts', () => {
  const ig = (responses: Recorded[]) => {
    const { fetchImpl, urls } = recorder(responses);
    return { provider: new InstagramProvider(client(fetchImpl)), urls };
  };

  it('reads the IG user node’s media with the stored Page token and a time window', async () => {
    const { provider, urls } = ig([{ match: '/media', body: IG_PAGE_ONE }]);
    await provider.listPublishedPosts(IG, { since: SINCE, until: UNTIL, limit: 25 });

    const url = new URL(urls[0]!);
    expect(url.host).toBe('graph.facebook.com');
    expect(url.pathname).toBe('/v21.0/17841400000000001/media');
    const q = params(urls[0]!);
    expect(q.get('access_token')).toBe('PAGE-TOKEN');
    expect(q.get('since')).toBe(String(SINCE.getTime() / 1000));
    expect(q.get('until')).toBe(String(UNTIL.getTime() / 1000));
    for (const field of ['caption', 'media_type', 'media_url', 'thumbnail_url', 'permalink']) {
      expect(q.get('fields')).toContain(field);
    }
    expect(q.get('fields')).toContain('timestamp');
    expect(q.get('fields')).toContain('children{');
  });

  it('normalises images, reels and carousels, with the right still for each', async () => {
    const { provider } = ig([{ match: '/media', body: IG_PAGE_ONE }]);
    const { items } = await provider.listPublishedPosts(IG, { since: SINCE, limit: 25 });

    expect(items.map((i) => [i.externalPostId, i.mediaKind, i.mediaCount])).toEqual([
      ['17900000000000004', 'image', 1],
      ['17900000000000003', 'video', 1],
      ['17900000000000002', 'image', 2],
      ['17900000000000001', 'video', 1],
    ]);
    // An image's still is the image; a video's is its thumbnail — never the .mp4.
    expect(items[0]!.thumbnailUrl).toContain('photo.jpg');
    expect(items[1]!.thumbnailUrl).toContain('reel_cover.jpg');
    expect(items[2]!.thumbnailUrl).toContain('slide1.jpg');
    expect(items[3]!.thumbnailUrl).toContain('reel2_cover.jpg');
    expect(items[1]).toMatchObject({
      caption: 'A day in the cardiology wing',
      publishedAt: new Date('2026-10-05T09:01:00.000Z'),
      // The opaque shortcode link — never built from the media id.
      permalink: 'https://www.instagram.com/reel/DAbc456/',
      alternateIds: [],
      knownUrls: [],
    });
    expect(items[3]!.caption).toBe('');
  });

  it('takes a carousel’s kind and still from its first slide', () => {
    const videoFirst = normalizeIgMedia({
      id: '1',
      timestamp: '2026-10-01T00:00:00+0000',
      media_type: 'CAROUSEL_ALBUM',
      children: {
        data: [
          {
            media_type: 'VIDEO',
            media_url: 'https://c.test/a.mp4',
            thumbnail_url: 'https://c.test/a.jpg',
          },
          { media_type: 'IMAGE', media_url: 'https://c.test/b.jpg' },
        ],
      },
    });
    expect(videoFirst).toMatchObject({
      mediaKind: 'video',
      mediaCount: 2,
      thumbnailUrl: 'https://c.test/a.jpg',
    });
  });

  it('imports a media Meta gives no picture for, without one', () => {
    expect(
      normalizeIgMedia({ id: '1', timestamp: '2026-10-01T00:00:00+0000', media_type: 'VIDEO' }),
    ).toMatchObject({ mediaKind: 'video', thumbnailUrl: null });
  });

  it('skips stories and ads, and anything without an id or a time', () => {
    const base = { id: '1', timestamp: '2026-10-01T00:00:00+0000', media_type: 'IMAGE' };
    expect(normalizeIgMedia({ ...base, media_product_type: 'STORY' })).toBeNull();
    expect(normalizeIgMedia({ ...base, media_product_type: 'AD' })).toBeNull();
    expect(normalizeIgMedia({ timestamp: base.timestamp })).toBeNull();
    expect(normalizeIgMedia({ id: '1' })).toBeNull();
    expect(normalizeIgMedia(base)).not.toBeNull();
  });

  it('pages with the cursor Meta returned, token kept out of it', async () => {
    const { provider, urls } = ig([{ match: '/media', body: IG_PAGE_ONE }]);
    const first = await provider.listPublishedPosts(IG, { since: SINCE, limit: 25 });
    expect(first.nextCursor).not.toContain('PAGE-TOKEN');
    await provider.listPublishedPosts(IG, { since: SINCE, limit: 25, cursor: first.nextCursor! });
    expect(params(urls[1]!).get('after')).toBe('QVFK');
    expect(params(urls[1]!).get('access_token')).toBe('PAGE-TOKEN');
  });

  it('reports Instagram’s business-use-case usage', async () => {
    const { provider } = ig([
      {
        match: '/media',
        body: { data: [] },
        headers: {
          'x-business-use-case-usage': JSON.stringify({
            '17841400000000001': [
              { type: 'instagram', call_count: 9, total_cputime: 3, total_time: 4 },
            ],
          }),
          'x-app-usage': JSON.stringify({ call_count: 28, total_time: 25, total_cputime: 25 }),
        },
      },
    ]);
    expect((await provider.listPublishedPosts(IG, { since: SINCE, limit: 25 })).usage).toEqual({
      percent: 28,
      regainAccessMinutes: null,
    });
  });
});

// --- Removed on platform -------------------------------------------------------------------------

const NOT_FOUND = {
  status: 400,
  body: {
    error: {
      message:
        "Unsupported get request. Object with ID '1112223334_9' does not exist, cannot be loaded due to missing permissions, or does not support this operation.",
      type: 'GraphMethodException',
      code: 100,
      error_subcode: 33,
    },
  },
};

describe('publishedPostPresence — a post is gone only when Meta says so and the token still works', () => {
  const presence = async (
    responses: Recorded[],
    which: 'fb' | 'ig' = 'fb',
  ): Promise<{ answer: string; urls: string[] }> => {
    const { fetchImpl, urls } = recorder(responses);
    const answer =
      which === 'fb'
        ? await new FacebookPagesProvider(client(fetchImpl)).publishedPostPresence(
            PAGE,
            '1112223334_9',
          )
        : await new InstagramProvider(client(fetchImpl)).publishedPostPresence(
            IG,
            '17900000000000009',
          );
    return { answer, urls };
  };

  it('is present when the post node reads, in one call', async () => {
    const { answer, urls } = await presence([
      { match: '1112223334_9', body: { id: '1112223334_9' } },
    ]);
    expect(answer).toBe('present');
    expect(urls).toHaveLength(1);
    expect(params(urls[0]!).get('fields')).toBe('id');
  });

  it('is gone when the post does not exist and the Page itself still reads', async () => {
    const { answer, urls } = await presence([
      { match: '1112223334_9', ...NOT_FOUND },
      { match: '/1112223334?', body: { id: '1112223334' } },
    ]);
    expect(answer).toBe('gone');
    expect(urls).toHaveLength(2);
  });

  it('is unknown — never gone — when the Page does not read either (a lost permission looks the same)', async () => {
    const { answer } = await presence([
      { match: '1112223334_9', ...NOT_FOUND },
      { match: '/1112223334?', ...NOT_FOUND },
    ]);
    expect(answer).toBe('unknown');
  });

  it.each([
    ['an expired token', 400, { error: { code: 190, message: 'expired' } }],
    ['a rate limit', 400, { error: { code: 80001, message: 'too many calls' } }],
    ['a server error', 500, { error: { code: 2, message: 'temporarily unavailable' } }],
    ['a different bad request', 400, { error: { code: 100, message: 'nonexisting field' } }],
    ['a body that is not JSON', 502, undefined],
  ])('is unknown for %s', async (_what, status, body) => {
    const { answer, urls } = await presence([{ match: '1112223334_9', status, body }]);
    expect(answer).toBe('unknown');
    // No second call: only "does not exist" is worth checking the account for.
    expect(urls).toHaveLength(1);
  });

  it('is unknown when the network fails', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('socket hang up');
    };
    expect(
      await new FacebookPagesProvider(client(fetchImpl)).publishedPostPresence(PAGE, '1_2'),
    ).toBe('unknown');
  });

  it('applies the same rule to Instagram media, checked against the IG account', async () => {
    const gone = await presence(
      [
        { match: '17900000000000009', ...NOT_FOUND },
        { match: '/17841400000000001?', body: { id: '17841400000000001' } },
      ],
      'ig',
    );
    expect(gone.answer).toBe('gone');
    const unsure = await presence(
      [
        { match: '17900000000000009', ...NOT_FOUND },
        { match: '/17841400000000001?', ...NOT_FOUND },
      ],
      'ig',
    );
    expect(unsure.answer).toBe('unknown');
  });
});

// --- Client helpers -----------------------------------------------------------------------------

describe('readMetaUsage', () => {
  const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n] ?? null });

  it('is null when Meta sent no usage header (it only does once an endpoint is busy)', () => {
    expect(readMetaUsage(undefined)).toBeNull();
    expect(readMetaUsage(headers({}))).toBeNull();
  });

  it('takes the worst figure across every entry of both headers', () => {
    const usage = readMetaUsage(
      headers({
        'x-app-usage': JSON.stringify({ call_count: 28, total_time: 25, total_cputime: 25 }),
        'x-business-use-case-usage': JSON.stringify({
          '1112223334': [{ type: 'pages', call_count: 10, total_cputime: 71, total_time: 12 }],
          '17841400000000001': [{ type: 'instagram', call_count: 44, total_time: 3 }],
        }),
      }),
    );
    expect(usage).toEqual({ percent: 71, regainAccessMinutes: null });
  });

  it('reports the wait Meta names when it is throttling', () => {
    const usage = readMetaUsage(
      headers({
        'x-business-use-case-usage': JSON.stringify({
          '1': [{ type: 'pages', call_count: 100, estimated_time_to_regain_access: 19 }],
        }),
      }),
    );
    expect(usage).toEqual({ percent: 100, regainAccessMinutes: 19 });
  });

  it('ignores a header it cannot parse rather than failing the call', () => {
    expect(readMetaUsage(headers({ 'x-app-usage': '{not json' }))).toBeNull();
    expect(readMetaUsage(headers({ 'x-business-use-case-usage': '"a string"' }))).toBeNull();
    expect(readMetaUsage(headers({ 'x-business-use-case-usage': '{"1":"x"}' }))).toBeNull();
  });
});

describe('nextPageCursor / cursorParams', () => {
  it('keeps every paging parameter and drops the access token', () => {
    const cursor = nextPageCursor(
      'https://graph.facebook.com/v21.0/1/published_posts?access_token=SECRET&limit=25&until=1791000000&__paging_token=enc_abc',
    );
    expect(cursor).not.toContain('SECRET');
    expect(cursorParams(cursor!)).toEqual({
      limit: '25',
      until: '1791000000',
      __paging_token: 'enc_abc',
    });
  });

  it('is null when there is no next page, or the link is not a url', () => {
    expect(nextPageCursor(undefined)).toBeNull();
    expect(nextPageCursor('')).toBeNull();
    expect(nextPageCursor('not a url')).toBeNull();
  });
});

describe('mapMetaError — business-use-case rate limits', () => {
  it.each([
    ['Pages calls with a Page token', 80001],
    ['the Instagram Platform', 80002],
    ['the app-wide limit', 4],
  ])('maps the limit for %s to a rate-limit error, which is still transient', (_what, code) => {
    const err = mapMetaError(400, { error: { code, message: 'too many calls' } });
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    expect(err).toBeInstanceOf(ProviderTransientError);
  });

  it('keeps an ordinary upstream failure transient without calling it a rate limit', () => {
    const err = mapMetaError(500, { error: { code: 2, message: 'try again' } });
    expect(err).toBeInstanceOf(ProviderTransientError);
    expect(err).not.toBeInstanceOf(ProviderRateLimitError);
  });
});
