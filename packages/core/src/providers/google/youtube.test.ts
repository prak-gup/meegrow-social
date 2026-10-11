import { describe, expect, it } from 'vitest';
import {
  SHORTS_MAX_SECONDS,
  UploadLedger,
  YOUTUBE_DESCRIPTION_MAX_BYTES,
  YOUTUBE_SCOPES,
  YouTubeProvider,
  hasShortsTag,
  isShortEligible,
  mapYouTubeError,
  pacificDay,
  type MediaFetchLike,
} from './youtube.js';
import { GBP_SCOPES, GbpProvider } from './gbp.js';
import { GoogleOAuthClient, type GoogleFetchLike } from './client.js';
import {
  ProviderAuthError,
  ProviderBadRequestError,
  ProviderTransientError,
} from '../../errors.js';
import type { AuthTokens, PostDetails } from '../types.js';

/**
 * Contract tests for the YouTube provider (#25) — CI never touches Google.
 *
 * FIXTURE PROVENANCE: NOT RECORDED. There were no Google credentials when these were written, so
 * every response below is hand-built from Google's published reference (the pages listed in
 * docs/dev/research/x-youtube.md §B7, read 2026-10-11). None of it came off the wire. They prove
 * this code matches the documentation, not that the documentation matches Google. Replace them with
 * real recordings at the live bring-up; §B8 of the research note is the checklist.
 */

interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Simulate a dropped connection instead of answering. */
  drop?: boolean;
}

interface Route {
  /** Substring matched against the request URL — first match wins. */
  match: string;
  method?: string;
  /** One reply per call, in order; the last one repeats. */
  replies: Reply[];
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
}

const NOW = new Date('2026-10-11T09:30:00.000Z');
const KIB_256 = 256 * 1024;
const REDIRECT = 'https://social.meegrowlabs.com/connect/callback';
const CHANNEL = 'UCmeegrow0000000000000001';
const VIDEO_ID = 'dQw4w9WgXcQ';
const MEDIA_URL = 'https://media.meegrowlabs.com/ws/clip.mp4';
const THUMB_URL = 'https://media.meegrowlabs.com/ws/thumb.jpg';
const SESSION = `https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=xa298sd_f&part=snippet,status`;

const TOKEN_ROUTE: Route = {
  match: 'oauth2.googleapis.com/token',
  replies: [{ body: { access_token: 'ya29.minted', expires_in: 3599, token_type: 'Bearer' } }],
};

function google(routes: Route[]): { fetchImpl: GoogleFetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const served = new Map<Route, number>();
  const fetchImpl: GoogleFetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, headers: init?.headers ?? {}, body: init?.body });
    const route = routes.find((r) => url.includes(r.match) && (!r.method || r.method === method));
    if (!route) throw new Error(`no fixture recorded for ${method} ${url}`);
    const n = served.get(route) ?? 0;
    served.set(route, n + 1);
    const reply = route.replies[Math.min(n, route.replies.length - 1)]!;
    if (reply.drop) throw new Error('socket hang up');
    const status = reply.status ?? 200;
    const headers = new Map(
      Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
      json: async () => {
        if (reply.body === undefined) throw new Error('empty body');
        return reply.body;
      },
    };
  };
  return { fetchImpl, calls };
}

/** Deterministic bytes, so a chunk's content proves which part of the file it was. */
function fileOf(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = i % 251;
  return bytes;
}

/** Our own media host: serves ranged reads from memory, like S3. */
function mediaHost(
  files: Record<string, { bytes: Uint8Array; contentType?: string }>,
  opts: { ranges?: boolean } = {},
): { fetchMedia: MediaFetchLike; reads: Array<{ url: string; range?: string }> } {
  const reads: Array<{ url: string; range?: string }> = [];
  const fetchMedia: MediaFetchLike = async (url, init) => {
    const range = init?.headers?.Range;
    reads.push({ url, range });
    const file = files[url];
    if (!file) {
      return {
        ok: false,
        status: 404,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    const type = file.contentType ?? 'video/mp4';
    const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
    if (opts.ranges === false || !match) {
      const headers: Record<string, string> = {
        'content-type': type,
        'content-length': String(file.bytes.byteLength),
      };
      return {
        ok: true,
        status: 200,
        headers: { get: (n) => headers[n.toLowerCase()] ?? null },
        arrayBuffer: async () => file.bytes.slice().buffer,
        body: { cancel: async () => undefined },
      };
    }
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), file.bytes.byteLength - 1);
    const headers: Record<string, string> = {
      'content-type': type,
      'content-range': `bytes ${start}-${end}/${file.bytes.byteLength}`,
    };
    return {
      ok: true,
      status: 206,
      headers: { get: (n) => headers[n.toLowerCase()] ?? null },
      arrayBuffer: async () => file.bytes.slice(start, end + 1).buffer,
    };
  };
  return { fetchMedia, reads };
}

function build(
  routes: Route[],
  opts: {
    files?: Record<string, { bytes: Uint8Array; contentType?: string }>;
    ranges?: boolean;
    dailyUploadLimit?: number;
    clock?: { ms: number };
  } = {},
) {
  const clock = opts.clock ?? { ms: NOW.getTime() };
  const { fetchImpl, calls } = google(routes);
  const { fetchMedia, reads } = mediaHost(opts.files ?? {}, { ranges: opts.ranges });
  const sleeps: number[] = [];
  const yt = new YouTubeProvider(
    new GoogleOAuthClient({
      clientId: 'test-client.apps.googleusercontent.com',
      clientSecret: 'test-secret',
      fetchImpl,
      now: () => clock.ms,
      mapError: mapYouTubeError,
    }),
    {
      now: () => new Date(clock.ms),
      fetchMedia,
      sleep: async (ms) => void sleeps.push(ms),
      uploadChunkBytes: KIB_256,
      ...(opts.dailyUploadLimit ? { dailyUploadLimit: opts.dailyUploadLimit } : {}),
    },
  );
  return { yt, calls, reads, sleeps, clock };
}

const tokens: AuthTokens = {
  accessToken: 'ya29.stale',
  refreshToken: '1//refresh',
  externalId: CHANNEL,
  displayName: 'Meegrow Labs',
};

function detail(
  over: Partial<PostDetails> = {},
  options: Record<string, unknown> = {},
): PostDetails {
  return {
    caption: 'How we plan a month of content in an afternoon.',
    media: [{ mediaId: '11111111-1111-4111-8111-111111111111', kind: 'video', url: MEDIA_URL }],
    options: {
      kind: 'youtube',
      title: 'Planning a month of content',
      privacyStatus: 'public',
      madeForKids: false,
      ...options,
    } as PostDetails['options'],
    ...over,
  };
}

/** videos.insert success body — a `video` resource with the requested parts. */
function videoResource(status: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'youtube#video',
    id: VIDEO_ID,
    snippet: { channelId: CHANNEL, title: 'Planning a month of content' },
    status: { uploadStatus: 'uploaded', privacyStatus: 'public', ...status },
  };
}

function listOf(status: Record<string, unknown>): Reply {
  return {
    body: {
      kind: 'youtube#videoListResponse',
      items: [{ kind: 'youtube#video', id: VIDEO_ID, status }],
    },
  };
}

const OPEN_SESSION: Route = {
  match: 'uploadType=resumable&part=snippet,status',
  method: 'POST',
  replies: [{ status: 200, headers: { Location: SESSION } }],
};
const READ_BACK_PUBLIC: Route = {
  match: '/youtube/v3/videos?part=status',
  replies: [listOf({ uploadStatus: 'uploaded', privacyStatus: 'public' })],
};

const chunkPuts = (calls: Call[]): Call[] =>
  calls.filter((c) => c.method === 'PUT' && c.body instanceof Uint8Array);
const statusQueries = (calls: Call[]): Call[] =>
  calls.filter((c) => c.method === 'PUT' && c.headers['Content-Range']?.startsWith('bytes */'));

describe('YouTubeProvider — identity', () => {
  it('is the two-phase, auto-refresh youtube provider', () => {
    const { yt } = build([]);
    expect(yt.identifier).toBe('youtube');
    expect(yt.isBetweenSteps).toBe(true);
    expect(yt.tokenModel).toBe('auto-refresh');
  });

  it('refuses a chunk size that is not a multiple of 256 KiB', () => {
    expect(
      () => new YouTubeProvider({ clientId: 'a', clientSecret: 'b' }, { uploadChunkBytes: 1000 }),
    ).toThrow(/256 KiB/);
  });
});

describe('YouTubeProvider — OAuth', () => {
  it('asks for exactly the three YouTube scopes and no previously granted ones', async () => {
    const { yt } = build([]);
    const { url } = await yt.generateAuthUrl({ redirectUri: REDIRECT, state: 'flow-1' });
    const qs = new URL(url).searchParams;
    expect(qs.get('scope')!.split(' ')).toEqual([
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/yt-analytics.readonly',
    ]);
    expect(qs.get('include_granted_scopes')).toBe('false');
    expect(qs.get('access_type')).toBe('offline');
    expect(qs.get('prompt')).toBe('consent');
    expect(qs.get('state')).toBe('flow-1');
    expect(qs.get('redirect_uri')).toBe(REDIRECT);
  });

  it('coexists with GBP on one OAuth client — neither consent names the other’s scopes', async () => {
    const config = { clientId: 'shared.apps.googleusercontent.com', clientSecret: 's' };
    const yt = new YouTubeProvider(config);
    const gbp = new GbpProvider(config);
    const ytUrl = new URL((await yt.generateAuthUrl({ redirectUri: REDIRECT, state: 'a' })).url);
    const gbpUrl = new URL((await gbp.generateAuthUrl({ redirectUri: REDIRECT, state: 'b' })).url);

    expect(ytUrl.searchParams.get('client_id')).toBe(gbpUrl.searchParams.get('client_id'));
    const ytScopes = ytUrl.searchParams.get('scope')!.split(' ');
    const gbpScopes = gbpUrl.searchParams.get('scope')!.split(' ');
    expect(ytScopes).toEqual([...YOUTUBE_SCOPES]);
    expect(gbpScopes).toEqual([...GBP_SCOPES]);
    expect(ytScopes.filter((s) => gbpScopes.includes(s))).toEqual([]);
  });

  it('exchanges the code and stores no expiry — the refresh token is the credential', async () => {
    const { yt, calls } = build([
      {
        match: 'oauth2.googleapis.com/token',
        replies: [
          {
            body: {
              access_token: 'ya29.first',
              refresh_token: '1//refresh',
              expires_in: 3599,
              scope: YOUTUBE_SCOPES.join(' '),
              token_type: 'Bearer',
            },
          },
        ],
      },
    ]);
    const result = await yt.authenticate({ code: 'auth-code', redirectUri: REDIRECT });
    expect(result).toEqual({
      accessToken: 'ya29.first',
      refreshToken: '1//refresh',
      externalId: 'pending',
      displayName: 'pending',
    });
    expect(result.expiresAt).toBeUndefined();
    expect(String(calls[0]!.body)).toContain('grant_type=authorization_code');
  });

  it('refuses a consent that came back without a refresh token', async () => {
    const { yt } = build([
      {
        match: 'oauth2.googleapis.com/token',
        replies: [{ body: { access_token: 'ya29.first', expires_in: 3599 } }],
      },
    ]);
    await expect(yt.authenticate({ code: 'c', redirectUri: REDIRECT })).rejects.toBeInstanceOf(
      ProviderAuthError,
    );
  });

  it('refreshToken mints an access token and passes no expiry', async () => {
    const { yt } = build([TOKEN_ROUTE]);
    expect(await yt.refreshToken('1//refresh')).toEqual({
      accessToken: 'ya29.minted',
      externalId: 'pending',
      displayName: 'pending',
    });
  });

  it('a dead refresh token is an auth error (→ needs_reconnect)', async () => {
    const { yt } = build([
      {
        match: 'oauth2.googleapis.com/token',
        replies: [
          {
            status: 400,
            body: {
              error: 'invalid_grant',
              error_description: 'Token has been expired or revoked.',
            },
          },
        ],
      },
    ]);
    await expect(yt.refreshToken('1//dead')).rejects.toBeInstanceOf(ProviderAuthError);
  });
});

describe('YouTubeProvider — channel pick', () => {
  it('lists the channel of the identity chosen at consent, with a minted token', async () => {
    const { yt, calls } = build([
      TOKEN_ROUTE,
      {
        match: '/youtube/v3/channels',
        replies: [
          {
            body: {
              kind: 'youtube#channelListResponse',
              pageInfo: { totalResults: 1, resultsPerPage: 50 },
              items: [
                {
                  kind: 'youtube#channel',
                  id: CHANNEL,
                  snippet: { title: 'Meegrow Labs', customUrl: '@meegrowlabs' },
                },
              ],
            },
          },
        ],
      },
    ]);
    expect(await yt.listAccounts({ ...tokens, externalId: 'pending' })).toEqual([
      { externalId: CHANNEL, displayName: 'Meegrow Labs (@meegrowlabs)' },
    ]);
    const list = calls.find((c) => c.url.includes('/channels'))!;
    const qs = new URL(list.url).searchParams;
    expect(qs.get('mine')).toBe('true');
    expect(qs.get('part')).toBe('snippet');
    expect(list.headers.Authorization).toBe('Bearer ya29.minted');
  });

  it('a Brand Account identity is just another channel — same call, same shape', async () => {
    const { yt } = build([
      TOKEN_ROUTE,
      {
        match: '/youtube/v3/channels',
        replies: [
          {
            body: {
              items: [
                { id: 'UCbrandaccount00000000001', snippet: { title: 'Client Brand Channel' } },
              ],
            },
          },
        ],
      },
    ]);
    expect(await yt.listAccounts(tokens)).toEqual([
      { externalId: 'UCbrandaccount00000000001', displayName: 'Client Brand Channel' },
    ]);
  });

  it('follows nextPageToken', async () => {
    const { yt, calls } = build([
      TOKEN_ROUTE,
      {
        match: '/youtube/v3/channels',
        replies: [
          { body: { items: [{ id: 'UC1', snippet: { title: 'One' } }], nextPageToken: 'p2' } },
          { body: { items: [{ id: 'UC2', snippet: { title: 'Two' } }] } },
        ],
      },
    ]);
    expect((await yt.listAccounts(tokens)).map((a) => a.externalId)).toEqual(['UC1', 'UC2']);
    expect(calls.filter((c) => c.url.includes('/channels'))[1]!.url).toContain('pageToken=p2');
  });

  it('an account with no channel yields an empty list', async () => {
    const { yt } = build([
      TOKEN_ROUTE,
      { match: '/youtube/v3/channels', replies: [{ body: { pageInfo: { totalResults: 0 } } }] },
    ]);
    expect(await yt.listAccounts(tokens)).toEqual([]);
  });
});

describe('YouTubeProvider — assertPublishable', () => {
  const { yt } = build([]);
  const rejects = (d: PostDetails[], pattern: RegExp) => {
    expect(() => yt.assertPublishable(d)).toThrow(ProviderBadRequestError);
    expect(() => yt.assertPublishable(d)).toThrow(pattern);
  };

  it('accepts one video with a title', () => {
    expect(() => yt.assertPublishable([detail()])).not.toThrow();
  });

  it('accepts one video plus one image (the thumbnail)', () => {
    const media = [
      ...detail().media,
      { mediaId: '22222222-2222-4222-8222-222222222222', kind: 'image' as const, url: THUMB_URL },
    ];
    expect(() => yt.assertPublishable([detail({ media })])).not.toThrow();
  });

  it('rejects a thread', () => rejects([detail(), detail()], /exactly one post/));
  it('rejects missing options', () => rejects([detail({ options: undefined })], /title/));
  it('rejects another platform’s options arm', () =>
    rejects([detail({ options: { kind: 'meta', format: 'feed' } })], /title/));
  it('rejects no video', () => rejects([detail({ media: [] })], /exactly one video, got 0/));

  it('rejects two videos', () => {
    const [video] = detail().media;
    rejects([detail({ media: [video!, video!] })], /exactly one video, got 2/);
  });

  it('rejects two images', () => {
    const image = { mediaId: '22222222-2222-4222-8222-222222222222', kind: 'image' as const };
    rejects([detail({ media: [...detail().media, image, image] })], /at most one image/);
  });

  it('rejects a blank or over-long title', () => {
    rejects([detail({}, { title: '   ' })], /blank/);
    rejects([detail({}, { title: 'x'.repeat(101) })], /101 chars; the limit is 100/);
  });

  it('rejects angle brackets in title or description', () => {
    rejects([detail({}, { title: 'a <b> c' })], /< or >/);
    rejects([detail({ caption: '1 > 0' })], /< or >/);
  });

  it('measures the description in bytes, and falls back to the caption', () => {
    // 2000 Devanagari characters = 6000 bytes of UTF-8, under 5000 characters.
    const hindi = 'न'.repeat(2000);
    rejects([detail({ caption: hindi })], /6000 bytes; the limit is 5000/);
    rejects([detail({}, { description: hindi })], /6000 bytes/);
    // An explicit description replaces the caption entirely.
    expect(() =>
      yt.assertPublishable([detail({ caption: hindi }, { description: 'short' })]),
    ).not.toThrow();
    expect(() =>
      yt.assertPublishable([detail({ caption: 'a'.repeat(YOUTUBE_DESCRIPTION_MAX_BYTES) })]),
    ).not.toThrow();
  });

  it('counts tags the way Google does', () => {
    // 50 tags of 9 chars + 49 commas = 499.
    const ok = Array.from({ length: 50 }, (_, i) => `tag${String(i).padStart(6, '0')}`);
    expect(() => yt.assertPublishable([detail({}, { tags: ok })])).not.toThrow();
    // The same with a space in each: +2 per tag = 599.
    const spaced = ok.map((t) => `${t.slice(0, 4)} ${t.slice(5)}`);
    rejects([detail({}, { tags: spaced })], /599 chars; the limit is 500/);
  });
});

describe('YouTubeProvider — upload', () => {
  const size = 2 * KIB_256 + 1000;
  const file = fileOf(size);
  const files = { [MEDIA_URL]: { bytes: file } };
  const finalChunk: Reply = { status: 201, body: videoResource() };
  const ack = (lastByte: number): Reply => ({
    status: 308,
    headers: { Range: `bytes=0-${lastByte}` },
  });

  it('opens a session, sends the file in order one chunk at a time, and reads the status back', async () => {
    const { yt, calls, reads } = build(
      [
        TOKEN_ROUTE,
        OPEN_SESSION,
        {
          match: 'upload_id=xa298sd_f',
          method: 'PUT',
          replies: [ack(KIB_256 - 1), ack(2 * KIB_256 - 1), finalChunk],
        },
        READ_BACK_PUBLIC,
      ],
      { files },
    );

    const result = await yt.post(tokens, [
      detail(
        {},
        { description: 'Full walkthrough.', tags: ['planning', 'social media'], categoryId: '22' },
      ),
    ]);
    expect(result).toEqual({
      externalPostId: VIDEO_ID,
      releaseUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    });

    const open = calls.find((c) => c.method === 'POST' && c.url.includes('uploadType=resumable'))!;
    expect(open.url).toBe(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    );
    expect(open.headers).toMatchObject({
      Authorization: 'Bearer ya29.minted',
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(size),
      'X-Upload-Content-Type': 'video/mp4',
    });
    expect(JSON.parse(open.body as string)).toEqual({
      snippet: {
        title: 'Planning a month of content',
        description: 'Full walkthrough.',
        tags: ['planning', 'social media'],
        categoryId: '22',
      },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
    });

    const puts = chunkPuts(calls);
    expect(puts.map((c) => c.headers['Content-Range'])).toEqual([
      `bytes 0-${KIB_256 - 1}/${size}`,
      `bytes ${KIB_256}-${2 * KIB_256 - 1}/${size}`,
      `bytes ${2 * KIB_256}-${size - 1}/${size}`,
    ]);
    expect(puts.map((c) => c.headers['Content-Length'])).toEqual([
      String(KIB_256),
      String(KIB_256),
      '1000',
    ]);
    expect(puts.every((c) => c.url === SESSION)).toBe(true);
    // The bytes on the wire are the file's, in order.
    const sent = new Uint8Array(size);
    let at = 0;
    for (const put of puts) {
      sent.set(put.body as Uint8Array, at);
      at += (put.body as Uint8Array).byteLength;
    }
    expect(Buffer.from(sent).equals(Buffer.from(file))).toBe(true);

    // Never more than one chunk in hand: every read of our storage is a ranged read of ≤ a chunk.
    expect(reads.map((r) => r.range)).toEqual([
      `bytes=0-${KIB_256 - 1}`,
      `bytes=${KIB_256}-${2 * KIB_256 - 1}`,
      `bytes=${2 * KIB_256}-${size - 1}`,
    ]);
    expect(Math.max(...puts.map((c) => (c.body as Uint8Array).byteLength))).toBe(KIB_256);

    const readBack = calls[calls.length - 1]!;
    expect(readBack.method).toBe('GET');
    expect(readBack.url).toBe(
      `https://www.googleapis.com/youtube/v3/videos?part=status&id=${VIDEO_ID}`,
    );
  });

  it('uses the caption as the description when none is given, and sends no empty tags', async () => {
    const { yt, calls } = build(
      [
        TOKEN_ROUTE,
        OPEN_SESSION,
        { match: 'upload_id=', method: 'PUT', replies: [finalChunk] },
        READ_BACK_PUBLIC,
      ],
      { files: { [MEDIA_URL]: { bytes: fileOf(500) } } },
    );
    await yt.post(tokens, [detail({}, { privacyStatus: 'unlisted', madeForKids: true })]);
    const open = calls.find((c) => c.method === 'POST' && c.url.includes('uploadType=resumable'))!;
    expect(JSON.parse(open.body as string)).toEqual({
      snippet: {
        title: 'Planning a month of content',
        description: 'How we plan a month of content in an afternoon.',
      },
      status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: true },
    });
  });

  it('declares video/* when our storage does not say it is a video', async () => {
    const { yt, calls } = build(
      [
        TOKEN_ROUTE,
        OPEN_SESSION,
        { match: 'upload_id=', method: 'PUT', replies: [finalChunk] },
        READ_BACK_PUBLIC,
      ],
      { files: { [MEDIA_URL]: { bytes: fileOf(500), contentType: 'binary/octet-stream' } } },
    );
    await yt.post(tokens, [detail()]);
    const open = calls.find((c) => c.method === 'POST' && c.url.includes('uploadType=resumable'))!;
    expect(open.headers['X-Upload-Content-Type']).toBe('video/*');
  });

  describe('resume', () => {
    it('after a 503 on a chunk, asks the server what it has and resumes from there', async () => {
      // Google kept only the first 100,000 bytes of the failed second chunk.
      const held = KIB_256 + 100_000;
      const { yt, calls, reads, sleeps } = build(
        [
          TOKEN_ROUTE,
          OPEN_SESSION,
          {
            match: 'upload_id=',
            method: 'PUT',
            replies: [
              ack(KIB_256 - 1), // chunk 1
              { status: 503, body: { error: { code: 503, message: 'Backend Error' } } }, // chunk 2 fails
              ack(held - 1), // status query
              finalChunk, // the rest, from the confirmed offset
            ],
          },
          READ_BACK_PUBLIC,
        ],
        { files },
      );

      expect((await yt.post(tokens, [detail()])).externalPostId).toBe(VIDEO_ID);

      const query = statusQueries(calls);
      expect(query).toHaveLength(1);
      expect(query[0]!.headers).toMatchObject({
        'Content-Length': '0',
        'Content-Range': `bytes */${size}`,
      });
      expect(query[0]!.body).toBeUndefined();
      expect(sleeps).toEqual([1000]);

      expect(chunkPuts(calls).map((c) => c.headers['Content-Range'])).toEqual([
        `bytes 0-${KIB_256 - 1}/${size}`,
        `bytes ${KIB_256}-${2 * KIB_256 - 1}/${size}`,
        `bytes ${held}-${size - 1}/${size}`,
      ]);
      // The resumed chunk was re-read from storage at the confirmed offset, not replayed from memory.
      expect(reads.map((r) => r.range)).toContain(`bytes=${held}-${size - 1}`);
      const resumed = chunkPuts(calls)[2]!.body as Uint8Array;
      expect(Buffer.from(resumed).equals(Buffer.from(file.slice(held)))).toBe(true);
    });

    it('a dropped connection is recovered the same way', async () => {
      const { yt, calls } = build(
        [
          TOKEN_ROUTE,
          OPEN_SESSION,
          {
            match: 'upload_id=',
            method: 'PUT',
            // Chunk 1 dropped; the server turns out to have none of it.
            replies: [
              { drop: true },
              { status: 308 },
              ack(KIB_256 - 1),
              ack(2 * KIB_256 - 1),
              finalChunk,
            ],
          },
          READ_BACK_PUBLIC,
        ],
        { files },
      );
      await yt.post(tokens, [detail()]);
      expect(chunkPuts(calls).map((c) => c.headers['Content-Range'])).toEqual([
        `bytes 0-${KIB_256 - 1}/${size}`,
        `bytes 0-${KIB_256 - 1}/${size}`,
        `bytes ${KIB_256}-${2 * KIB_256 - 1}/${size}`,
        `bytes ${2 * KIB_256}-${size - 1}/${size}`,
      ]);
    });

    it('a final chunk whose 201 was lost is recovered by the status query, not re-sent', async () => {
      const { yt, calls } = build(
        [
          TOKEN_ROUTE,
          OPEN_SESSION,
          {
            match: 'upload_id=',
            method: 'PUT',
            replies: [ack(KIB_256 - 1), ack(2 * KIB_256 - 1), { drop: true }, finalChunk],
          },
          READ_BACK_PUBLIC,
        ],
        { files },
      );
      expect((await yt.post(tokens, [detail()])).externalPostId).toBe(VIDEO_ID);
      expect(chunkPuts(calls)).toHaveLength(3);
      expect(statusQueries(calls)).toHaveLength(1);
    });

    it('gives up as transient when the server stops making progress', async () => {
      const { yt, sleeps, calls } = build(
        [
          TOKEN_ROUTE,
          OPEN_SESSION,
          { match: 'upload_id=', method: 'PUT', replies: [{ status: 503 }] },
        ],
        { files },
      );
      const err = await yt.post(tokens, [detail()]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderTransientError);
      expect((err as Error).message).toMatch(/stalled at byte 0 of \d+ \(HTTP 503\)/);
      expect(sleeps).toEqual([1000, 2000, 4000, 8000, 16000]);
      expect(statusQueries(calls)).toHaveLength(5);
    });

    it('an expired session (404) is transient — the next attempt starts over', async () => {
      const { yt } = build(
        [
          TOKEN_ROUTE,
          OPEN_SESSION,
          { match: 'upload_id=', method: 'PUT', replies: [ack(KIB_256 - 1), { status: 404 }] },
        ],
        { files },
      );
      await expect(yt.post(tokens, [detail()])).rejects.toThrow(/session expired/);
    });

    it('a permanent error on a chunk is not retried', async () => {
      const { yt, calls } = build(
        [
          TOKEN_ROUTE,
          OPEN_SESSION,
          {
            match: 'upload_id=',
            method: 'PUT',
            replies: [
              {
                status: 400,
                body: {
                  error: {
                    code: 400,
                    message: 'The request metadata specifies an invalid video title.',
                    errors: [{ domain: 'youtube.video', reason: 'invalidTitle' }],
                  },
                },
              },
            ],
          },
        ],
        { files },
      );
      await expect(yt.post(tokens, [detail()])).rejects.toBeInstanceOf(ProviderBadRequestError);
      expect(chunkPuts(calls)).toHaveLength(1);
      expect(statusQueries(calls)).toHaveLength(0);
    });
  });

  describe('reading the stored file', () => {
    it('accepts a host without ranged reads when the whole file fits in one chunk', async () => {
      const { yt, calls } = build(
        [
          TOKEN_ROUTE,
          OPEN_SESSION,
          { match: 'upload_id=', method: 'PUT', replies: [finalChunk] },
          READ_BACK_PUBLIC,
        ],
        { files: { [MEDIA_URL]: { bytes: fileOf(4000) } }, ranges: false },
      );
      await yt.post(tokens, [detail()]);
      expect(chunkPuts(calls).map((c) => c.headers['Content-Range'])).toEqual([
        'bytes 0-3999/4000',
      ]);
    });

    it('refuses — without reading it — a larger file from a host without ranged reads', async () => {
      const { yt, calls } = build([TOKEN_ROUTE], { files, ranges: false });
      const err = await yt.post(tokens, [detail()]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderBadRequestError);
      expect((err as Error).message).toMatch(/ranged reads/);
      expect(calls).toHaveLength(0);
    });

    it('a missing file is permanent; a storage 5xx is transient', async () => {
      const gone = build([TOKEN_ROUTE], { files: {} });
      await expect(gone.yt.post(tokens, [detail()])).rejects.toBeInstanceOf(
        ProviderBadRequestError,
      );

      const flaky = new YouTubeProvider(
        { clientId: 'a', clientSecret: 'b' },
        {
          fetchMedia: async () => ({
            ok: false,
            status: 503,
            headers: { get: () => null },
            arrayBuffer: async () => new ArrayBuffer(0),
          }),
        },
      );
      await expect(flaky.post(tokens, [detail()])).rejects.toBeInstanceOf(ProviderTransientError);
    });

    it('refuses media with no stored url', async () => {
      const { yt } = build([]);
      const media = [{ mediaId: '11111111-1111-4111-8111-111111111111', kind: 'video' as const }];
      await expect(yt.post(tokens, [detail({ media })])).rejects.toThrow(/no stored url/);
    });
  });
});

describe('YouTubeProvider — status read-back', () => {
  const files = { [MEDIA_URL]: { bytes: fileOf(500) } };
  const upload = (insertStatus: Record<string, unknown> = {}): Route[] => [
    TOKEN_ROUTE,
    OPEN_SESSION,
    {
      match: 'upload_id=',
      method: 'PUT',
      replies: [{ status: 201, body: videoResource(insertStatus) }],
    },
  ];

  it('reports the visibility YouTube actually set, not the one requested', async () => {
    const { yt } = build(
      [
        ...upload(),
        {
          match: '/youtube/v3/videos?part=status',
          replies: [listOf({ uploadStatus: 'uploaded', privacyStatus: 'private' })],
        },
      ],
      { files },
    );
    const result = await yt.post(tokens, [detail()]);
    expect(result.externalPostId).toBe(VIDEO_ID);
    expect(result.notice).toMatch(/Requested public, but YouTube set this video to private/);
    expect(result.notice).toMatch(/compliance audit/);
  });

  it('says nothing when the read-back matches the request', async () => {
    const { yt } = build([...upload(), READ_BACK_PUBLIC], { files });
    expect((await yt.post(tokens, [detail()])).notice).toBeUndefined();
  });

  it('trusts the read-back over the upload response', async () => {
    // The insert echoes "public"; the read-back says the lock landed afterwards.
    const { yt } = build(
      [
        ...upload({ privacyStatus: 'public' }),
        {
          match: '/youtube/v3/videos?part=status',
          replies: [listOf({ uploadStatus: 'uploaded', privacyStatus: 'private' })],
        },
      ],
      { files },
    );
    expect((await yt.post(tokens, [detail()])).notice).toMatch(/set this video to private/);
  });

  it('a failed read-back never fails the post — it falls back to the upload response and says so', async () => {
    const { yt } = build(
      [
        ...upload({ privacyStatus: 'private' }),
        {
          match: '/youtube/v3/videos?part=status',
          replies: [{ status: 503, body: { error: { code: 503, message: 'Backend Error' } } }],
        },
      ],
      { files },
    );
    const result = await yt.post(tokens, [detail()]);
    expect(result.externalPostId).toBe(VIDEO_ID);
    expect(result.notice).toMatch(/Could not re-read the video’s status/);
    expect(result.notice).toMatch(/set this video to private/);
  });

  it('flags an unknown visibility rather than assuming the requested one', async () => {
    const { yt } = build(
      [
        TOKEN_ROUTE,
        OPEN_SESSION,
        { match: 'upload_id=', method: 'PUT', replies: [{ status: 201, body: { id: VIDEO_ID } }] },
        { match: '/youtube/v3/videos?part=status', replies: [{ body: { items: [] } }] },
      ],
      { files },
    );
    const result = await yt.post(tokens, [detail()]);
    expect(result.notice).toMatch(/did not return the uploaded video/);
    expect(result.notice).toMatch(/did not report the video’s visibility/);
  });

  it('a rejected upload fails the post permanently, with YouTube’s reason', async () => {
    const { yt } = build(
      [
        ...upload(),
        {
          match: '/youtube/v3/videos?part=status',
          replies: [
            listOf({
              uploadStatus: 'rejected',
              rejectionReason: 'duplicate',
              privacyStatus: 'private',
            }),
          ],
        },
      ],
      { files },
    );
    const err = await yt.post(tokens, [detail()]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderBadRequestError);
    expect((err as Error).message).toMatch(/rejected the upload \(duplicate\)/);
    expect((err as Error).message).toContain(VIDEO_ID);
  });

  it('an upload answered without a video id is permanent, never retried into a duplicate', async () => {
    const { yt } = build(
      [
        TOKEN_ROUTE,
        OPEN_SESSION,
        { match: 'upload_id=', method: 'PUT', replies: [{ status: 201, body: {} }] },
      ],
      { files },
    );
    await expect(yt.post(tokens, [detail()])).rejects.toBeInstanceOf(ProviderBadRequestError);
  });
});

describe('YouTubeProvider — thumbnail', () => {
  const image = {
    mediaId: '22222222-2222-4222-8222-222222222222',
    kind: 'image' as const,
    url: THUMB_URL,
  };
  const withThumb = () => detail({ media: [...detail().media, image] });
  const base: Route[] = [
    TOKEN_ROUTE,
    OPEN_SESSION,
    { match: 'upload_id=', method: 'PUT', replies: [{ status: 201, body: videoResource() }] },
    READ_BACK_PUBLIC,
  ];
  const files = (thumbBytes: number) => ({
    [MEDIA_URL]: { bytes: fileOf(500) },
    [THUMB_URL]: { bytes: fileOf(thumbBytes), contentType: 'image/jpeg' },
  });

  it('sets the image as the custom thumbnail after the upload', async () => {
    const { yt, calls } = build(
      [
        ...base,
        { match: '/thumbnails/set', replies: [{ body: { kind: 'youtube#thumbnailSetResponse' } }] },
      ],
      { files: files(9000) },
    );
    const result = await yt.post(tokens, [withThumb()]);
    expect(result.notice).toBeUndefined();
    const set = calls.find((c) => c.url.includes('/thumbnails/set'))!;
    expect(set.url).toBe(
      `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${VIDEO_ID}&uploadType=media`,
    );
    expect(set.method).toBe('POST');
    expect(set.headers['Content-Type']).toBe('image/jpeg');
    expect((set.body as Uint8Array).byteLength).toBe(9000);
  });

  it('a refused thumbnail is a notice — the video is already up', async () => {
    const { yt } = build(
      [
        ...base,
        {
          match: '/thumbnails/set',
          replies: [
            {
              status: 403,
              body: {
                error: {
                  code: 403,
                  message:
                    "The authenticated user doesn't have permissions to upload and set custom video thumbnails.",
                  errors: [{ domain: 'youtube.thumbnail', reason: 'forbidden' }],
                },
              },
            },
          ],
        },
      ],
      { files: files(9000) },
    );
    const result = await yt.post(tokens, [withThumb()]);
    expect(result.externalPostId).toBe(VIDEO_ID);
    expect(result.notice).toMatch(/Thumbnail not set: YouTube refused it/);
    expect(result.notice).toMatch(/phone-verified/);
  });

  it('an oversize image is skipped without being sent', async () => {
    const { yt, calls } = build(base, { files: files(2 * 1024 * 1024 + 1) });
    const result = await yt.post(tokens, [withThumb()]);
    expect(result.notice).toMatch(/over YouTube’s 2 MB limit/);
    expect(calls.some((c) => c.url.includes('/thumbnails/set'))).toBe(false);
  });
});

describe('YouTubeProvider — quota pre-flight', () => {
  const files = { [MEDIA_URL]: { bytes: fileOf(500) } };
  const routes: Route[] = [
    TOKEN_ROUTE,
    OPEN_SESSION,
    { match: 'upload_id=', method: 'PUT', replies: [{ status: 201, body: videoResource() }] },
    READ_BACK_PUBLIC,
  ];

  it('refuses the upload past the daily allowance before calling Google', async () => {
    const { yt, calls } = build(routes, { files, dailyUploadLimit: 2 });
    await yt.post(tokens, [detail()]);
    await yt.post(tokens, [detail()]);
    const before = calls.length;

    const err = await yt.post(tokens, [detail()]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderBadRequestError);
    expect((err as Error).message).toMatch(/2 of 2 uploads started today/);
    expect((err as Error).message).toMatch(/midnight Pacific/);
    expect(calls.length).toBe(before);
    // The same check answers at create time in this process.
    expect(() => yt.assertPublishable([detail()])).toThrow(/upload allowance reached/);
  });

  it('reports a malformed post as malformed even when the allowance is spent', async () => {
    const { yt } = build(routes, { files, dailyUploadLimit: 1 });
    await yt.post(tokens, [detail()]);
    expect(() => yt.assertPublishable([detail({ media: [] })])).toThrow(/exactly one video/);
  });

  it('resets at midnight Pacific, not midnight UTC', async () => {
    // 2026-10-11 09:30 UTC is 02:30 PDT on the 11th.
    const clock = { ms: NOW.getTime() };
    const { yt } = build(routes, { files, dailyUploadLimit: 1, clock });
    await yt.post(tokens, [detail()]);
    // 00:30 UTC on the 12th is still 17:30 PDT on the 11th.
    clock.ms = Date.parse('2026-10-12T00:30:00.000Z');
    expect(() => yt.assertPublishable([detail()])).toThrow(/upload allowance reached/);
    // 07:30 UTC on the 12th is 00:30 PDT on the 12th.
    clock.ms = Date.parse('2026-10-12T07:30:00.000Z');
    expect(() => yt.assertPublishable([detail()])).not.toThrow();
  });

  it('counts a session Google refused — failed calls are charged too', async () => {
    const { yt } = build(
      [
        TOKEN_ROUTE,
        {
          match: 'uploadType=resumable',
          method: 'POST',
          replies: [{ status: 503, body: { error: { code: 503, message: 'Backend Error' } } }],
        },
      ],
      { files, dailyUploadLimit: 1 },
    );
    await expect(yt.post(tokens, [detail()])).rejects.toBeInstanceOf(ProviderTransientError);
    expect(() => yt.assertPublishable([detail()])).toThrow(/1 of 1 uploads started today/);
  });

  it('does not count a post that never reached Google', async () => {
    const { yt } = build(routes, { files: {}, dailyUploadLimit: 1 });
    await expect(yt.post(tokens, [detail()])).rejects.toBeInstanceOf(ProviderBadRequestError);
    expect(() => yt.assertPublishable([detail()])).not.toThrow();
  });

  it('Google’s own quotaExceeded is the backstop, with the same operator message', async () => {
    const { yt } = build(
      [
        TOKEN_ROUTE,
        {
          match: 'uploadType=resumable',
          method: 'POST',
          replies: [
            {
              status: 403,
              body: {
                error: {
                  code: 403,
                  message: 'The request cannot be completed because you have exceeded your quota.',
                  errors: [{ domain: 'youtube.quota', reason: 'quotaExceeded' }],
                },
              },
            },
          ],
        },
      ],
      { files },
    );
    const err = await yt.post(tokens, [detail()]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderBadRequestError);
    expect((err as Error).message).toMatch(/quota for this project is used up for today/);
    expect((err as Error).message).not.toMatch(/GBP/);
  });
});

describe('UploadLedger / pacificDay', () => {
  it('counts per Pacific day', () => {
    let at = new Date('2026-01-15T07:59:00.000Z'); // 23:59 PST on the 14th
    const ledger = new UploadLedger(100, () => at);
    ledger.record();
    ledger.record();
    expect(ledger.count()).toBe(2);
    at = new Date('2026-01-15T08:01:00.000Z'); // 00:01 PST on the 15th
    expect(ledger.count()).toBe(0);
  });

  it('follows daylight saving', () => {
    expect(pacificDay(new Date('2026-01-15T07:59:00.000Z'))).toBe('2026-01-14');
    expect(pacificDay(new Date('2026-07-15T06:59:00.000Z'))).toBe('2026-07-14');
    expect(pacificDay(new Date('2026-07-15T07:01:00.000Z'))).toBe('2026-07-15');
  });
});

describe('Shorts', () => {
  it('is eligible when vertical or square and at most three minutes', () => {
    expect(isShortEligible({ width: 1080, height: 1920, durationSeconds: 45 })).toBe(true);
    expect(
      isShortEligible({ width: 1080, height: 1080, durationSeconds: SHORTS_MAX_SECONDS }),
    ).toBe(true);
    expect(isShortEligible({ width: 1080, height: 1920, durationSeconds: 181 })).toBe(false);
    expect(isShortEligible({ width: 1920, height: 1080, durationSeconds: 30 })).toBe(false);
  });

  it('answers false when the probe did not measure the file', () => {
    expect(isShortEligible({ width: 1080, height: 1920 })).toBe(false);
    expect(isShortEligible({ durationSeconds: 30 })).toBe(false);
  });

  it('reads the #Shorts tag from the title, description or caption', () => {
    expect(hasShortsTag(detail({}, { title: 'Quick tip #Shorts' }))).toBe(true);
    expect(hasShortsTag(detail({}, { description: 'More below.\n#shorts' }))).toBe(true);
    expect(hasShortsTag(detail({ caption: '#SHORTS a tip' }))).toBe(true);
    expect(hasShortsTag(detail())).toBe(false);
    expect(hasShortsTag(detail({ caption: 'buy#shorts and #shortsighted' }))).toBe(false);
    // An explicit description replaces the caption, so a tag only in the caption does not count.
    expect(hasShortsTag(detail({ caption: '#Shorts' }, { description: 'none' }))).toBe(false);
  });

  it('links a tagged upload as a Short and never rewrites what the user typed', async () => {
    const { yt, calls } = build(
      [
        TOKEN_ROUTE,
        OPEN_SESSION,
        { match: 'upload_id=', method: 'PUT', replies: [{ status: 201, body: videoResource() }] },
        READ_BACK_PUBLIC,
      ],
      { files: { [MEDIA_URL]: { bytes: fileOf(500) } } },
    );
    const tagged = await yt.post(tokens, [detail({}, { title: 'Quick tip #Shorts' })]);
    expect(tagged.releaseUrl).toBe(`https://www.youtube.com/shorts/${VIDEO_ID}`);

    const plain = await yt.post(tokens, [detail()]);
    expect(plain.releaseUrl).toBe(`https://www.youtube.com/watch?v=${VIDEO_ID}`);
    const opens = calls.filter(
      (c) => c.method === 'POST' && c.url.includes('uploadType=resumable'),
    );
    expect(JSON.parse(opens[1]!.body as string).snippet).toEqual({
      title: 'Planning a month of content',
      description: 'How we plan a month of content in an afternoon.',
    });
  });
});

describe('mapYouTubeError', () => {
  const body = (code: number, reason: string, message = 'msg') => ({
    error: { code, message, errors: [{ domain: 'youtube', reason }] },
  });

  it.each([
    [401, 'authError', ProviderAuthError],
    [403, 'insufficientPermissions', ProviderAuthError],
    [403, 'quotaExceeded', ProviderBadRequestError],
    [403, 'dailyLimitExceeded', ProviderBadRequestError],
    [400, 'uploadLimitExceeded', ProviderBadRequestError],
    [401, 'youtubeSignupRequired', ProviderBadRequestError],
    [403, 'forbidden', ProviderBadRequestError],
    [403, 'forbiddenPrivacySetting', ProviderBadRequestError],
    [403, 'accessNotConfigured', ProviderBadRequestError],
    [403, 'rateLimitExceeded', ProviderTransientError],
    [403, 'userRateLimitExceeded', ProviderTransientError],
    [429, 'uploadRateLimitExceeded', ProviderTransientError],
    [400, 'invalidTitle', ProviderBadRequestError],
    [404, 'videoNotFound', ProviderBadRequestError],
    [500, 'backendError', ProviderTransientError],
    [503, 'backendError', ProviderTransientError],
  ])('HTTP %i %s', (status, reason, kind) => {
    expect(mapYouTubeError(status, body(status, reason))).toBeInstanceOf(kind);
  });

  it('never blames GBP for a YouTube 403', () => {
    for (const reason of ['quotaExceeded', 'forbidden', 'accessNotConfigured']) {
      const message =
        reason === 'accessNotConfigured'
          ? 'YouTube Data API v3 has not been used in project 123 before or it is disabled.'
          : 'msg';
      expect(mapYouTubeError(403, body(403, reason, message)).message).not.toMatch(/GBP/);
    }
  });

  it('names the per-channel limit apart from the project quota', () => {
    expect(mapYouTubeError(400, body(400, 'uploadLimitExceeded')).message).toMatch(
      /channel has reached its own upload limit/,
    );
  });

  it('treats a scope the user declined as an auth error', () => {
    const err = mapYouTubeError(403, {
      error: {
        code: 403,
        message: 'Request had insufficient authentication scopes.',
        status: 'PERMISSION_DENIED',
      },
    });
    expect(err).toBeInstanceOf(ProviderAuthError);
  });

  it('leaves the OAuth token endpoint’s errors to the shared mapping', () => {
    expect(mapYouTubeError(400, { error: 'invalid_grant' })).toBeInstanceOf(ProviderAuthError);
    expect(mapYouTubeError(401, { error: 'invalid_client' })).toBeInstanceOf(
      ProviderBadRequestError,
    );
    expect(mapYouTubeError(502, undefined)).toBeInstanceOf(ProviderTransientError);
  });

  it('is what a provider built from plain config uses', async () => {
    const { fetchImpl } = google([
      TOKEN_ROUTE,
      {
        match: '/youtube/v3/channels',
        replies: [{ status: 403, body: body(403, 'quotaExceeded') }],
      },
    ]);
    const yt = new YouTubeProvider({ clientId: 'a', clientSecret: 'b', fetchImpl });
    await expect(yt.listAccounts(tokens)).rejects.toThrow(/quota for this project is used up/);
  });
});

describe('YouTubeProvider — postAnalytics', () => {
  const videoList = (publishedAt: string): Route => ({
    match: '/youtube/v3/videos?part=snippet%2Cstatistics',
    replies: [
      {
        body: {
          kind: 'youtube#videoListResponse',
          items: [
            {
              id: VIDEO_ID,
              snippet: { publishedAt, channelId: CHANNEL },
              // Unsigned longs arrive as strings.
              statistics: {
                viewCount: '1523',
                likeCount: '87',
                favoriteCount: '0',
                commentCount: '12',
              },
            },
          ],
        },
      },
    ],
  });
  const report: Route = {
    match: 'youtubeanalytics.googleapis.com/v2/reports',
    replies: [
      {
        body: {
          kind: 'youtubeAnalytics#resultTable',
          columnHeaders: [
            { name: 'views', columnType: 'METRIC', dataType: 'INTEGER' },
            { name: 'estimatedMinutesWatched', columnType: 'METRIC', dataType: 'INTEGER' },
            { name: 'averageViewDuration', columnType: 'METRIC', dataType: 'INTEGER' },
            { name: 'averageViewPercentage', columnType: 'METRIC', dataType: 'FLOAT' },
            { name: 'likes', columnType: 'METRIC', dataType: 'INTEGER' },
            { name: 'comments', columnType: 'METRIC', dataType: 'INTEGER' },
            { name: 'shares', columnType: 'METRIC', dataType: 'INTEGER' },
            { name: 'subscribersGained', columnType: 'METRIC', dataType: 'INTEGER' },
          ],
          rows: [[1490, 2210, 89, 41.7, 85, 12, 9, 4]],
        },
      },
    ],
  };

  it('inside the Analytics lag it reads the counters only', async () => {
    const { yt, calls } = build([TOKEN_ROUTE, videoList('2026-10-10T12:00:00Z'), report]);
    const points = await yt.postAnalytics(tokens, VIDEO_ID);
    expect(points).toEqual([
      { metric: 'viewCount', value: 1523, capturedAt: NOW },
      { metric: 'likeCount', value: 87, capturedAt: NOW },
      { metric: 'commentCount', value: 12, capturedAt: NOW },
    ]);
    expect(calls.some((c) => c.url.includes('youtubeanalytics'))).toBe(false);
  });

  it('past the lag it adds the Analytics totals under Google’s own names', async () => {
    const { yt, calls } = build([TOKEN_ROUTE, videoList('2026-10-01T18:00:00Z'), report]);
    const points = await yt.postAnalytics(tokens, VIDEO_ID);
    expect(points.map((p) => [p.metric, p.value])).toEqual([
      ['viewCount', 1523],
      ['likeCount', 87],
      ['commentCount', 12],
      ['views', 1490],
      ['estimatedMinutesWatched', 2210],
      ['averageViewDuration', 89],
      ['averageViewPercentage', 41.7],
      ['likes', 85],
      ['comments', 12],
      ['shares', 9],
      ['subscribersGained', 4],
    ]);
    expect(points.every((p) => p.capturedAt.getTime() === NOW.getTime())).toBe(true);

    const qs = new URL(calls.find((c) => c.url.includes('youtubeanalytics'))!.url).searchParams;
    expect(qs.get('ids')).toBe('channel==MINE');
    expect(qs.get('filters')).toBe(`video==${VIDEO_ID}`);
    expect(qs.get('startDate')).toBe('2026-09-30');
    expect(qs.get('endDate')).toBe('2026-10-11');
    expect(qs.get('metrics')).toBe(
      'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,shares,subscribersGained',
    );
  });

  it('a report with no rows yet adds nothing', async () => {
    const { yt } = build([
      TOKEN_ROUTE,
      videoList('2026-10-01T18:00:00Z'),
      {
        match: 'youtubeanalytics',
        replies: [
          { body: { kind: 'youtubeAnalytics#resultTable', columnHeaders: [{ name: 'views' }] } },
        ],
      },
    ]);
    expect((await yt.postAnalytics(tokens, VIDEO_ID)).map((p) => p.metric)).toEqual([
      'viewCount',
      'likeCount',
      'commentCount',
    ]);
  });

  it('a video that no longer exists yields no points', async () => {
    const { yt } = build([
      TOKEN_ROUTE,
      { match: '/youtube/v3/videos', replies: [{ body: { items: [] } }] },
    ]);
    expect(await yt.postAnalytics(tokens, VIDEO_ID)).toEqual([]);
  });

  it('keeps the counters when the Analytics half is refused', async () => {
    const { yt } = build([
      TOKEN_ROUTE,
      videoList('2026-10-01T18:00:00Z'),
      {
        match: 'youtubeanalytics',
        replies: [
          {
            status: 403,
            body: { error: { code: 403, message: 'Forbidden', errors: [{ reason: 'forbidden' }] } },
          },
        ],
      },
    ]);
    expect((await yt.postAnalytics(tokens, VIDEO_ID)).map((p) => p.metric)).toEqual([
      'viewCount',
      'likeCount',
      'commentCount',
    ]);
  });

  it('auth and transient failures still surface', async () => {
    const unauthorised = build([
      TOKEN_ROUTE,
      {
        match: '/youtube/v3/videos',
        replies: [{ status: 401, body: { error: { code: 401, message: 'Invalid Credentials' } } }],
      },
    ]);
    await expect(unauthorised.yt.postAnalytics(tokens, VIDEO_ID)).rejects.toBeInstanceOf(
      ProviderAuthError,
    );

    const down = build([
      TOKEN_ROUTE,
      videoList('2026-10-01T18:00:00Z'),
      {
        match: 'youtubeanalytics',
        replies: [{ status: 503, body: { error: { code: 503, message: 'Backend Error' } } }],
      },
    ]);
    await expect(down.yt.postAnalytics(tokens, VIDEO_ID)).rejects.toBeInstanceOf(
      ProviderTransientError,
    );
  });
});

describe('YouTubeProvider — accountAnalytics', () => {
  const channel = (statistics: Record<string, unknown>): Route => ({
    match: '/youtube/v3/channels?part=statistics',
    replies: [{ body: { items: [{ id: CHANNEL, statistics }] } }],
  });
  const daily: Route = {
    match: 'youtubeanalytics.googleapis.com/v2/reports',
    replies: [
      {
        body: {
          kind: 'youtubeAnalytics#resultTable',
          columnHeaders: [
            { name: 'day', columnType: 'DIMENSION', dataType: 'STRING' },
            { name: 'views', columnType: 'METRIC', dataType: 'INTEGER' },
            { name: 'estimatedMinutesWatched', columnType: 'METRIC', dataType: 'INTEGER' },
            { name: 'subscribersGained', columnType: 'METRIC', dataType: 'INTEGER' },
            { name: 'subscribersLost', columnType: 'METRIC', dataType: 'INTEGER' },
          ],
          rows: [
            ['2026-10-07', 310, 512, 3, 1],
            ['2026-10-08', 295, 480, 2, 0],
          ],
        },
      },
    ],
  };

  it('emits the subscriber count as followers, the other counters natively, and daily rows by day', async () => {
    const { yt, calls } = build([
      TOKEN_ROUTE,
      channel({
        viewCount: '48213',
        subscriberCount: '1290',
        hiddenSubscriberCount: false,
        videoCount: '64',
      }),
      daily,
    ]);
    const points = await yt.accountAnalytics(tokens);
    expect(points.slice(0, 3)).toEqual([
      { metric: 'followers', value: 1290, capturedAt: NOW },
      { metric: 'viewCount', value: 48213, capturedAt: NOW },
      { metric: 'videoCount', value: 64, capturedAt: NOW },
    ]);
    const oct7 = new Date('2026-10-07T00:00:00.000Z');
    const oct8 = new Date('2026-10-08T00:00:00.000Z');
    expect(points.slice(3)).toEqual([
      { metric: 'views', value: 310, capturedAt: oct7 },
      { metric: 'estimatedMinutesWatched', value: 512, capturedAt: oct7 },
      { metric: 'subscribersGained', value: 3, capturedAt: oct7 },
      { metric: 'subscribersLost', value: 1, capturedAt: oct7 },
      { metric: 'views', value: 295, capturedAt: oct8 },
      { metric: 'estimatedMinutesWatched', value: 480, capturedAt: oct8 },
      { metric: 'subscribersGained', value: 2, capturedAt: oct8 },
      // A real zero is a value, not an absence.
      { metric: 'subscribersLost', value: 0, capturedAt: oct8 },
    ]);

    const channelCall = calls.find((c) => c.url.includes('/channels'))!;
    expect(new URL(channelCall.url).searchParams.get('id')).toBe(CHANNEL);
    const qs = new URL(calls.find((c) => c.url.includes('youtubeanalytics'))!.url).searchParams;
    expect(qs.get('dimensions')).toBe('day');
    expect(qs.get('startDate')).toBe('2026-10-07');
    expect(qs.get('endDate')).toBe('2026-10-09');
  });

  it('emits no followers for a channel that hides its subscriber count', async () => {
    const { yt } = build([
      TOKEN_ROUTE,
      channel({ viewCount: '48213', hiddenSubscriberCount: true, videoCount: '64' }),
      { match: 'youtubeanalytics', replies: [{ body: { columnHeaders: [] } }] },
    ]);
    expect((await yt.accountAnalytics(tokens)).map((p) => p.metric)).toEqual([
      'viewCount',
      'videoCount',
    ]);
  });

  it('keeps the counters when the daily report is refused, and surfaces an auth failure', async () => {
    const refused = build([
      TOKEN_ROUTE,
      channel({ subscriberCount: '5' }),
      {
        match: 'youtubeanalytics',
        replies: [
          {
            status: 403,
            body: { error: { code: 403, message: 'Forbidden', errors: [{ reason: 'forbidden' }] } },
          },
        ],
      },
    ]);
    expect(await refused.yt.accountAnalytics(tokens)).toEqual([
      { metric: 'followers', value: 5, capturedAt: NOW },
    ]);

    const dead = build([
      {
        match: 'oauth2.googleapis.com/token',
        replies: [{ status: 400, body: { error: 'invalid_grant' } }],
      },
    ]);
    await expect(dead.yt.accountAnalytics(tokens)).rejects.toBeInstanceOf(ProviderAuthError);
  });
});
