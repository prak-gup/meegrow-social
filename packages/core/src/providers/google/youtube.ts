import type { MediaRef, PostOptions } from '@meegrow-social/contracts';
import type {
  PublishedPostItem,
  PublishedPostPage,
  PublishedPostPresence,
  PublishedPostQuery,
} from '../published-posts.js';
import type {
  AuthTokens,
  GenerateAuthUrl,
  MetricPoint,
  PostDetails,
  PostResult,
  ProviderAccount,
  SocialProvider,
} from '../types.js';
import {
  ProviderAuthError,
  ProviderBadRequestError,
  ProviderTransientError,
} from '../../errors.js';
import {
  GoogleOAuthClient,
  mapGoogleError,
  type GoogleClientConfig,
  type GoogleResponse,
} from './client.js';

/**
 * YouTube provider (issue #25, BUILD-SPEC-V2 §4 B4). Uploads one video to the connected channel
 * over the resumable protocol, reads the resulting status back, and reads video + channel numbers
 * from the Data API and the YouTube Analytics API.
 *
 * NOT LIVE-VERIFIED — there were no Google credentials and OAuth verification was pending when this
 * was written. Every shape below is the documented one (docs/dev/research/x-youtube.md Part B, and
 * its §B7 for what was re-read on 2026-10-11); §B8 of that note is the list of assumptions the live
 * bring-up has to confirm. Registration is env-gated twice over (registry.ts): the shared Google
 * credentials AND `YOUTUBE_ENABLED=true`, so setting the credentials for GBP does not expose this.
 *
 * Scopes are exactly the three in `YOUTUBE_SCOPES`. Google refuses verification where a narrower
 * scope would do, so nothing here may need `youtube` or `youtube.force-ssl` — which rules out
 * editing a video after upload (`videos.update`) and playlists (`playlistItems.insert`).
 *
 * Token model: identical to GBP (gbp.ts) — the refresh token is the durable credential, the
 * connection is stored with no `expiresAt`, and every call mints a fresh access token.
 *
 * One token is one channel. Google's account chooser makes the user pick a single identity — their
 * own channel or a Brand Account they own or manage — and the token is bound to it, so a second
 * channel is a second connect. `listAccounts` shows what that identity owns.
 */

const DATA_HOST = 'https://www.googleapis.com/youtube/v3';
const UPLOAD_HOST = 'https://www.googleapis.com/upload/youtube/v3';
const ANALYTICS_HOST = 'https://youtubeanalytics.googleapis.com/v2';

export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
] as const;

/**
 * YouTube API Services Developer Policies III.E.4 / III.D.2.c: stored API data is deleted or
 * refreshed within 30 calendar days. `services/metrics-retention.ts` enforces it for `metrics`.
 */
export const YOUTUBE_DATA_RETENTION_DAYS = 30;

export const YOUTUBE_TITLE_MAX = 100;
/** Bytes, not characters — Google's limit on `snippet.description` is 5000 bytes of UTF-8. */
export const YOUTUBE_DESCRIPTION_MAX_BYTES = 5000;
/** Across all tags, counted Google's way (see `tagsLength`). */
export const YOUTUBE_TAGS_MAX = 500;

/**
 * `videos.insert` draws on its own bucket: 100 calls a day by default, 1 per call, separate from
 * the 10,000-unit pool (developers.google.com/youtube/v3/determine_quota_cost, re-read
 * 2026-10-11). BUILD-SPEC-V2 §B4 still quotes the retired 1,600-unit cost.
 */
export const YOUTUBE_DAILY_UPLOAD_LIMIT = 100;

const KIB_256 = 256 * 1024;
/** Chunks must be a multiple of 256 KiB. 8 MiB bounds memory per upload without being chatty. */
export const YOUTUBE_UPLOAD_CHUNK_BYTES = 32 * KIB_256;
/** Recoveries without the server acknowledging a single new byte before the upload gives up. */
const MAX_STALLED_RECOVERIES = 5;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

/** Custom thumbnails: JPEG/PNG under 2 MB (YouTube Help, "Add video thumbnails"). */
const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

/** Shorts: vertical or square, at most three minutes. There is no API flag — YouTube classifies. */
export const SHORTS_MAX_SECONDS = 180;

/** YouTube Analytics lags about two days; a younger video has nothing there to read. */
const ANALYTICS_LAG_MS = 48 * 60 * 60 * 1000;
const VIDEO_REPORT_METRICS = [
  'views',
  'estimatedMinutesWatched',
  'averageViewDuration',
  'averageViewPercentage',
  'likes',
  'comments',
  'shares',
  'subscribersGained',
] as const;
const CHANNEL_REPORT_METRICS = [
  'views',
  'estimatedMinutesWatched',
  'subscribersGained',
  'subscribersLost',
] as const;
/** Complete days re-read each sweep: [today-4, today-2], so a day gets three chances to land. */
const CHANNEL_REPORT_FROM_DAYS_AGO = 4;
const CHANNEL_REPORT_TO_DAYS_AGO = 2;

/** Pagination backstop — a `nextPageToken` that never ends must not spin the connect flow. */
const MAX_PAGES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

type YoutubeOptions = Extract<PostOptions, { kind: 'youtube' }>;

/**
 * Reads the stored media file. Separate from the Google transport because it talks to OUR storage
 * (the public media URL), never to Google. Injectable so tests serve bytes from memory.
 */
export type MediaFetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer: () => Promise<ArrayBuffer>;
  body?: { cancel(): Promise<void> } | null;
}>;

export interface YouTubeProviderDeps {
  now?: () => Date;
  fetchMedia?: MediaFetchLike;
  /** Backoff between upload recoveries; injectable so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Uploads allowed per Pacific day before the pre-flight refuses. */
  dailyUploadLimit?: number;
  /** Must be a multiple of 256 KiB. */
  uploadChunkBytes?: number;
}

interface YouTubeErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{ reason?: string; domain?: string; message?: string }>;
  };
}

interface ChannelResource {
  id?: string;
  snippet?: { title?: string; customUrl?: string };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
  statistics?: {
    viewCount?: string;
    subscriberCount?: string;
    hiddenSubscriberCount?: boolean;
    videoCount?: string;
  };
}

interface VideoResource {
  id?: string;
  snippet?: {
    publishedAt?: string;
    channelId?: string;
    title?: string;
    description?: string;
    categoryId?: string;
    tags?: string[];
    thumbnails?: Record<string, { url?: string }>;
  };
  contentDetails?: { duration?: string };
  status?: {
    selfDeclaredMadeForKids?: boolean;
    madeForKids?: boolean;
    uploadStatus?: string;
    privacyStatus?: string;
    failureReason?: string;
    rejectionReason?: string;
  };
  statistics?: Record<string, string | number | undefined>;
}

interface ReportTable {
  columnHeaders?: Array<{ name?: string; columnType?: string }>;
  rows?: Array<Array<string | number>>;
}

/**
 * Map a YouTube error onto the sealed taxonomy. YouTube puts the useful part in
 * `error.errors[0].reason`, and its 403s mean five different things — the shared `mapGoogleError`
 * would label every one of them a GBP access problem.
 */
export function mapYouTubeError(status: number, body: unknown): Error {
  const err = (body as YouTubeErrorBody | undefined)?.error;
  // The OAuth token endpoint's bare-string errors are the same for every Google API.
  if (typeof err !== 'object' || err === null) return mapGoogleError(status, body);

  const reason = err.errors?.[0]?.reason ?? '';
  const message = err.message ?? `YouTube API request failed (HTTP ${status})`;
  const detail = `${message}${reason ? ` [${reason}]` : ''}`;

  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
    return new ProviderBadRequestError(`${quotaExhaustedMessage()} (Google said: ${detail})`);
  }
  if (reason === 'uploadLimitExceeded') {
    return new ProviderBadRequestError(
      'This YouTube channel has reached its own upload limit — YouTube caps uploads per channel ' +
        `per day, separately from our API quota. Try again tomorrow. (Google said: ${detail})`,
    );
  }
  if (reason === 'youtubeSignupRequired') {
    // Arrives as 401, but reconnecting cannot fix an account that has no channel.
    return new ProviderBadRequestError(
      `This Google account has no YouTube channel — create one, then connect again. (${detail})`,
    );
  }
  if (/rateLimitExceeded$/i.test(reason)) return new ProviderTransientError(detail);
  if (reason === 'insufficientPermissions' || /insufficient.*scope/i.test(message)) {
    // The grant is missing a scope (the user unticked one at consent) — only a reconnect fixes it.
    return new ProviderAuthError(detail);
  }
  if (status === 403) {
    if (reason === 'accessNotConfigured' || /has not been used in project/i.test(message)) {
      return new ProviderBadRequestError(
        `The YouTube API is not enabled for this Google Cloud project. (Google said: ${detail})`,
      );
    }
    return new ProviderBadRequestError(detail);
  }
  return mapGoogleError(status, body);
}

function quotaExhaustedMessage(): string {
  return (
    'YouTube API quota for this project is used up for today — it resets at midnight Pacific ' +
    'time. Retry the post after that.'
  );
}

/**
 * The upload pre-flight (#25 "quota accounting"). Counts `videos.insert` sessions this process
 * opened in the current Pacific day — the day Google's quota resets on.
 *
 * APPROXIMATE, and deliberately so: providers hold no database or Redis handle, so there is no
 * shared counter. This one is per process and in memory. It under-counts after a restart, across
 * several worker processes, and for anything else that uses the project's quota; it counts nothing
 * in the API process, where the create-time `assertPublishable` runs but no upload ever happens.
 * What it does guarantee is that one worker stops BEFORE calling Google once it has itself used the
 * allowance. Google's own `quotaExceeded` is the backstop and maps to the same message.
 */
export class UploadLedger {
  private day = '';
  private used = 0;

  constructor(
    readonly limit: number,
    private readonly now: () => Date,
  ) {}

  count(): number {
    this.roll();
    return this.used;
  }

  record(): void {
    this.roll();
    this.used += 1;
  }

  private roll(): void {
    const today = pacificDay(this.now());
    if (today !== this.day) {
      this.day = today;
      this.used = 0;
    }
  }
}

/** YYYY-MM-DD in America/Los_Angeles. */
export function pacificDay(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * Could YouTube classify this file as a Short? Needs the probed dimensions, which a `MediaRef` does
 * not carry — so this is for callers that hold `media.meta` (the composer, `validate`), not for
 * `post()`. Unknown dimensions or duration answer false.
 */
export function isShortEligible(meta: {
  width?: number;
  height?: number;
  durationSeconds?: number;
}): boolean {
  if (!meta.width || !meta.height || meta.durationSeconds === undefined) return false;
  return meta.height >= meta.width && meta.durationSeconds <= SHORTS_MAX_SECONDS;
}

/** The uploader marked this as a Short by putting #Shorts in the title or description. */
export function hasShortsTag(detail: PostDetails): boolean {
  const options = youtubeOptions(detail);
  return /(^|\s)#shorts\b/i.test(`${options?.title ?? ''} ${descriptionOf(detail)}`);
}

export class YouTubeProvider implements SocialProvider {
  readonly identifier = 'youtube' as const;
  readonly displayName = 'YouTube';
  readonly isBetweenSteps = true;
  readonly tokenModel = 'auto-refresh' as const;
  // An upload holds a chunk of the file in memory and a long-lived job slot; keep them few.
  readonly maxConcurrentJobs = 2;

  private readonly client: GoogleOAuthClient;
  private readonly now: () => Date;
  private readonly fetchMedia: MediaFetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly chunkBytes: number;
  private readonly ledger: UploadLedger;

  constructor(config: GoogleClientConfig | GoogleOAuthClient, deps: YouTubeProviderDeps = {}) {
    this.client =
      config instanceof GoogleOAuthClient
        ? config
        : new GoogleOAuthClient({ ...config, mapError: config.mapError ?? mapYouTubeError });
    this.now = deps.now ?? (() => new Date());
    this.fetchMedia = deps.fetchMedia ?? (globalThis.fetch as unknown as MediaFetchLike);
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.chunkBytes = deps.uploadChunkBytes ?? YOUTUBE_UPLOAD_CHUNK_BYTES;
    if (this.chunkBytes <= 0 || this.chunkBytes % KIB_256 !== 0) {
      throw new Error('YouTube upload chunk size must be a positive multiple of 256 KiB');
    }
    this.ledger = new UploadLedger(deps.dailyUploadLimit ?? YOUTUBE_DAILY_UPLOAD_LIMIT, this.now);
  }

  /**
   * Asks for the three YouTube scopes and nothing else. `includeGrantedScopes: false` keeps a
   * `business.manage` grant the same Google user gave the GBP provider out of this token.
   */
  async generateAuthUrl(params: { redirectUri: string; state: string }): Promise<GenerateAuthUrl> {
    return {
      url: this.client.authUrl({
        ...params,
        scopes: [...YOUTUBE_SCOPES],
        includeGrantedScopes: false,
      }),
    };
  }

  /** externalId/displayName stay 'pending' until the channel is picked. No `expiresAt` (as GBP). */
  async authenticate(params: { code: string; redirectUri: string }): Promise<AuthTokens> {
    const tokens = await this.client.exchangeCode(params);
    if (!tokens.refreshToken) {
      throw new ProviderAuthError(
        'Google returned no refresh token — the consent must run with access_type=offline and ' +
          'prompt=consent. Remove the app at myaccount.google.com/permissions and connect again.',
      );
    }
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      externalId: 'pending',
      displayName: 'pending',
    };
  }

  /**
   * The channels owned by the identity the user chose at Google's account chooser — almost always
   * exactly one. An account with no channel yields an empty list rather than an error.
   */
  async listAccounts(tokens: AuthTokens): Promise<ProviderAccount[]> {
    const token = await this.accessToken(tokens);
    const found: ProviderAccount[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const qs = new URLSearchParams({ part: 'snippet', mine: 'true', maxResults: '50' });
      if (pageToken) qs.set('pageToken', pageToken);
      const res = await this.client.authed<{ items?: ChannelResource[]; nextPageToken?: string }>(
        `${DATA_HOST}/channels?${qs.toString()}`,
        {},
        token,
      );
      for (const channel of res.items ?? []) {
        if (!channel.id) continue;
        const title = channel.snippet?.title ?? channel.id;
        const handle = channel.snippet?.customUrl;
        found.push({
          externalId: channel.id,
          displayName: handle ? `${title} (${handle})` : title,
        });
      }
      pageToken = res.nextPageToken;
      if (!pageToken) break;
    }
    return found;
  }

  /** One channel lookup per run, then two one-unit Data API reads per page (at most 50 videos). */
  async listPublishedPosts(
    tokens: AuthTokens,
    query: PublishedPostQuery,
  ): Promise<PublishedPostPage> {
    const token = await this.accessToken(tokens);
    let playlist: string;
    let pageToken: string | undefined;
    if (query.cursor) {
      let cursor: unknown;
      try {
        cursor = JSON.parse(query.cursor);
      } catch {
        throw new ProviderBadRequestError('Invalid YouTube import cursor');
      }
      if (
        !cursor ||
        typeof cursor !== 'object' ||
        !('playlist' in cursor) ||
        typeof cursor.playlist !== 'string' ||
        !('pageToken' in cursor) ||
        typeof cursor.pageToken !== 'string'
      ) {
        throw new ProviderBadRequestError('Invalid YouTube import cursor');
      }
      playlist = cursor.playlist;
      pageToken = cursor.pageToken;
    } else {
      const channels = await this.client.authed<{ items?: ChannelResource[] }>(
        `${DATA_HOST}/channels?part=contentDetails&mine=true`,
        {},
        token,
      );
      const channel = channels.items?.find((item) => item.id === tokens.externalId);
      const uploads = channel?.contentDetails?.relatedPlaylists?.uploads;
      if (!uploads)
        throw new ProviderBadRequestError(
          'The connected YouTube channel did not return an uploads playlist',
        );
      playlist = uploads;
    }
    const qs = new URLSearchParams({
      part: 'contentDetails',
      playlistId: playlist,
      maxResults: String(Math.max(1, Math.min(50, Math.floor(query.limit)))),
    });
    if (pageToken) qs.set('pageToken', pageToken);
    const listed = await this.client.authed<{
      items?: Array<{ contentDetails?: { videoId?: string; videoPublishedAt?: string } }>;
      nextPageToken?: string;
    }>(`${DATA_HOST}/playlistItems?${qs}`, {}, token);
    const ids = [
      ...new Set(
        (listed.items ?? []).flatMap((item) =>
          item.contentDetails?.videoId ? [item.contentDetails.videoId] : [],
        ),
      ),
    ];
    const videos = ids.length
      ? await this.client.authed<{ items?: VideoResource[] }>(
          `${DATA_HOST}/videos?${new URLSearchParams({ part: 'snippet,status,statistics,contentDetails', id: ids.join(',') })}`,
          {},
          token,
        )
      : { items: [] };
    const byId = new Map((videos.items ?? []).map((item) => [item.id, item]));
    const items = ids
      .flatMap((id) => normalizeImportedVideo(byId.get(id), tokens.externalId) ?? [])
      .filter(
        (item) =>
          item.publishedAt >= query.since && (!query.until || item.publishedAt <= query.until),
      );
    // Upload order is not publication order (private videos and premieres can publish later).
    // Never end the scan on an old page: later pages may still contain in-window videos.
    // Window filtering above uses videos.snippet.publishedAt, never playlistItem.snippet.publishedAt.
    return {
      items,
      itemsRead: listed.items?.length ?? 0,
      orderedByPublishedAt: false,
      nextCursor: listed.nextPageToken
        ? JSON.stringify({ playlist, pageToken: listed.nextPageToken })
        : null,
      usage: null,
    };
  }

  /** A missing video is only a deletion when the grant still owns the connected channel. */
  async publishedPostPresence(
    tokens: AuthTokens,
    externalPostId: string,
  ): Promise<PublishedPostPresence> {
    try {
      const token = await this.accessToken(tokens);
      const video = await this.client.authed<{ items?: VideoResource[] }>(
        `${DATA_HOST}/videos?${new URLSearchParams({ part: 'snippet', id: externalPostId })}`,
        {},
        token,
      );
      if (
        video.items?.some(
          (item) => item.id === externalPostId && item.snippet?.channelId === tokens.externalId,
        )
      )
        return 'present';
      if (video.items?.length) return 'unknown';
      const channels = await this.client.authed<{ items?: ChannelResource[] }>(
        `${DATA_HOST}/channels?part=id&mine=true`,
        {},
        token,
      );
      return channels.items?.some((item) => item.id === tokens.externalId) ? 'gone' : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  // No finalizeAccount: the token already belongs to the channel — there is nothing to swap.

  /** For the contract and a manual refresh; with no stored expiry the sweeper never calls it. */
  async refreshToken(refreshToken: string): Promise<AuthTokens> {
    const tokens = await this.client.refresh(refreshToken);
    return {
      accessToken: tokens.accessToken,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      externalId: 'pending',
      displayName: 'pending',
    };
  }

  /**
   * YouTube's own rules, checked at create time and again in `post()`. The quota check is last so
   * a malformed post is reported as malformed even on a day the allowance is spent.
   */
  assertPublishable(details: PostDetails[]): void {
    if (details.length !== 1) {
      throw new ProviderBadRequestError(
        `youtube expects exactly one post, got ${details.length} (one upload is one video)`,
      );
    }
    const [detail] = details as [PostDetails];
    const options = youtubeOptions(detail);
    if (!options) {
      throw new ProviderBadRequestError('youtube posts need options with a title');
    }

    const videos = detail.media.filter((m) => m.kind === 'video');
    const images = detail.media.filter((m) => m.kind === 'image');
    if (videos.length !== 1) {
      throw new ProviderBadRequestError(
        `youtube posts need exactly one video, got ${videos.length}`,
      );
    }
    if (images.length > 1) {
      throw new ProviderBadRequestError(
        `youtube takes at most one image (the custom thumbnail), got ${images.length}`,
      );
    }

    if (options.title.trim().length === 0) {
      throw new ProviderBadRequestError('youtube title cannot be blank');
    }
    if (options.title.length > YOUTUBE_TITLE_MAX) {
      throw new ProviderBadRequestError(
        `youtube title is ${options.title.length} chars; the limit is ${YOUTUBE_TITLE_MAX}`,
      );
    }
    const description = descriptionOf(detail);
    if (/[<>]/.test(options.title) || /[<>]/.test(description)) {
      throw new ProviderBadRequestError(
        'youtube titles and descriptions cannot contain < or > (YouTube rejects them)',
      );
    }
    const bytes = Buffer.byteLength(description, 'utf8');
    if (bytes > YOUTUBE_DESCRIPTION_MAX_BYTES) {
      throw new ProviderBadRequestError(
        `youtube description is ${bytes} bytes; the limit is ${YOUTUBE_DESCRIPTION_MAX_BYTES} ` +
          '(bytes, not characters — non-Latin text and emoji count for more)',
      );
    }
    const tagChars = tagsLength(options.tags ?? []);
    if (tagChars > YOUTUBE_TAGS_MAX) {
      throw new ProviderBadRequestError(
        `youtube tags add up to ${tagChars} chars; the limit is ${YOUTUBE_TAGS_MAX} ` +
          '(commas count, and a tag with a space counts two extra)',
      );
    }

    const used = this.ledger.count();
    if (used >= this.ledger.limit) {
      throw new ProviderBadRequestError(
        `YouTube upload allowance reached: ${used} of ${this.ledger.limit} uploads started today. ` +
          'It resets at midnight Pacific time — retry the post after that.',
      );
    }
  }

  /**
   * Upload, then read the video back. What YouTube did with the upload is what gets reported: a
   * project that has not passed the API compliance audit may have its uploads locked to private
   * whatever was asked for, so the requested visibility is never assumed.
   *
   * Once the upload has succeeded nothing below may throw a retryable error — a retry would upload
   * the video a second time. Anything that goes wrong after that point becomes a `notice`.
   */
  async post(tokens: AuthTokens, details: PostDetails[]): Promise<PostResult> {
    // Re-checked here: the worker can pick up a row stored before a rule existed, and this is the
    // process whose ledger actually counts uploads.
    this.assertPublishable(details);
    const [detail] = details as [PostDetails];
    const options = youtubeOptions(detail)!;
    const video = detail.media.find((m) => m.kind === 'video')!;
    const thumbnail = detail.media.find((m) => m.kind === 'image');

    const uploaded = await this.upload(tokens, requireUrl(video), buildVideoResource(detail));
    const videoId = uploaded.id;
    if (!videoId) {
      // Not retried on purpose: the video may exist, and a retry would upload it twice.
      throw new ProviderBadRequestError('YouTube accepted the upload but returned no video id');
    }

    const notices: string[] = [];
    const status = (await this.readBack(tokens, videoId, notices)) ?? uploaded.status;

    if (status?.uploadStatus === 'rejected' || status?.uploadStatus === 'failed') {
      const why = status.rejectionReason ?? status.failureReason ?? 'no reason given';
      throw new ProviderBadRequestError(
        `YouTube ${status.uploadStatus} the upload (${why}) — video ${videoId}. Do not retry ` +
          'without changing the file.',
      );
    }
    if (!status?.privacyStatus) {
      notices.push('YouTube did not report the video’s visibility — check it in YouTube Studio.');
    } else if (status.privacyStatus !== options.privacyStatus) {
      notices.push(
        `Requested ${options.privacyStatus}, but YouTube set this video to ` +
          `${status.privacyStatus}. Uploads from an API project that has not passed YouTube’s ` +
          'compliance audit can be locked to private; the channel’s own upload defaults can also ' +
          'override it. Change it in YouTube Studio.',
      );
    }

    if (thumbnail) {
      const failure = await this.setThumbnail(tokens, videoId, thumbnail);
      if (failure) notices.push(failure);
    }

    return {
      externalPostId: videoId,
      options: {
        ...options,
        ...(['public', 'unlisted', 'private'].includes(status?.privacyStatus ?? '')
          ? { remote: { privacyStatus: status!.privacyStatus as YoutubeOptions['privacyStatus'] } }
          : { remote: undefined }),
      },
      releaseUrl: hasShortsTag(detail)
        ? `https://www.youtube.com/shorts/${videoId}`
        : `https://www.youtube.com/watch?v=${videoId}`,
      ...(notices.length > 0 ? { notice: notices.join(' ') } : {}),
    };
  }

  /**
   * Lifetime counters from the Data API, plus — once the video is past the Analytics lag — its
   * lifetime totals from the Analytics API. Both sets keep Google's own names (`viewCount` and
   * `views` are different numbers from different systems; neither is renamed into the other).
   *
   * A video that no longer exists resolves to no points, and so does a permanent 4xx: an unstamped
   * post is re-polled every hour, so a video Google will never report on must not fail forever.
   */
  async postAnalytics(tokens: AuthTokens, externalPostId: string): Promise<MetricPoint[]> {
    const token = await this.accessToken(tokens);
    const capturedAt = this.now();

    let video: VideoResource | undefined;
    try {
      const qs = new URLSearchParams({ part: 'snippet,statistics', id: externalPostId });
      const res = await this.client.authed<{ items?: VideoResource[] }>(
        `${DATA_HOST}/videos?${qs.toString()}`,
        {},
        token,
      );
      video = res.items?.[0];
    } catch (err) {
      if (err instanceof ProviderBadRequestError) return [];
      throw err;
    }
    if (!video) return [];

    const points: MetricPoint[] = [];
    for (const [metric, raw] of Object.entries(video.statistics ?? {})) {
      // favoriteCount has been a constant 0 since 2015 — it is not a measurement.
      if (metric === 'favoriteCount') continue;
      const value = toNumber(raw);
      if (value !== undefined) points.push({ metric, value, capturedAt });
    }

    const publishedAt = video.snippet?.publishedAt ? new Date(video.snippet.publishedAt) : null;
    if (
      !publishedAt ||
      Number.isNaN(publishedAt.getTime()) ||
      capturedAt.getTime() - publishedAt.getTime() < ANALYTICS_LAG_MS
    ) {
      return points;
    }

    try {
      const table = await this.report(token, {
        // A day early: Analytics days are Pacific, `publishedAt` is UTC.
        startDate: isoDay(new Date(publishedAt.getTime() - DAY_MS)),
        endDate: isoDay(capturedAt),
        metrics: VIDEO_REPORT_METRICS.join(','),
        filters: `video==${externalPostId}`,
      });
      const [row] = table.rows ?? [];
      (table.columnHeaders ?? []).forEach((header, index) => {
        const value = toNumber(row?.[index]);
        if (header.name && value !== undefined) {
          points.push({ metric: header.name, value, capturedAt });
        }
      });
    } catch (err) {
      // The counters above are still good; only the Analytics half is skipped.
      if (!(err instanceof ProviderBadRequestError)) throw err;
    }
    return points;
  }

  /**
   * Channel counters now, plus daily Analytics rows for a short trailing window, each stamped with
   * the UTC midnight of the day it belongs to (as GBP does).
   *
   * The subscriber count is emitted as `followers`, the name the Meta providers already use and
   * the one the follower-trend read API serves. A channel that hides its count emits none.
   */
  async accountAnalytics(tokens: AuthTokens): Promise<MetricPoint[]> {
    const token = await this.accessToken(tokens);
    const capturedAt = this.now();

    const qs = new URLSearchParams({ part: 'statistics', id: tokens.externalId });
    const res = await this.client.authed<{ items?: ChannelResource[] }>(
      `${DATA_HOST}/channels?${qs.toString()}`,
      {},
      token,
    );
    const stats = res.items?.[0]?.statistics;

    const points: MetricPoint[] = [];
    const subscribers = stats?.hiddenSubscriberCount ? undefined : toNumber(stats?.subscriberCount);
    if (subscribers !== undefined) {
      points.push({ metric: 'followers', value: subscribers, capturedAt });
    }
    for (const metric of ['viewCount', 'videoCount'] as const) {
      const value = toNumber(stats?.[metric]);
      if (value !== undefined) points.push({ metric, value, capturedAt });
    }

    try {
      const table = await this.report(token, {
        startDate: isoDay(new Date(capturedAt.getTime() - CHANNEL_REPORT_FROM_DAYS_AGO * DAY_MS)),
        endDate: isoDay(new Date(capturedAt.getTime() - CHANNEL_REPORT_TO_DAYS_AGO * DAY_MS)),
        metrics: CHANNEL_REPORT_METRICS.join(','),
        dimensions: 'day',
        sort: 'day',
      });
      const headers = table.columnHeaders ?? [];
      const dayIndex = headers.findIndex((h) => h.name === 'day');
      for (const row of table.rows ?? []) {
        const day = dayIndex >= 0 ? utcDay(row[dayIndex]) : undefined;
        if (!day) continue;
        headers.forEach((header, index) => {
          if (index === dayIndex || !header.name) return;
          const value = toNumber(row[index]);
          if (value !== undefined) points.push({ metric: header.name, value, capturedAt: day });
        });
      }
    } catch (err) {
      if (!(err instanceof ProviderBadRequestError)) throw err;
    }
    return points;
  }

  /** Always mint from the refresh token when there is one — the stored access token is stale. */
  private async accessToken(tokens: AuthTokens): Promise<string> {
    return tokens.refreshToken
      ? this.client.accessTokenFor(tokens.refreshToken)
      : tokens.accessToken;
  }

  private report(token: string, params: Record<string, string>): Promise<ReportTable> {
    const qs = new URLSearchParams({ ids: 'channel==MINE', ...params });
    return this.client.authed<ReportTable>(`${ANALYTICS_HOST}/reports?${qs.toString()}`, {}, token);
  }

  /**
   * Resumable `videos.insert`. The file is never held whole: each chunk is a ranged read of the
   * stored media, PUT to the session, then dropped — so memory is one chunk whatever the file size,
   * and a resume is just "read from the offset Google confirms".
   *
   * After any failed chunk the server is asked how much it has (`Content-Range: bytes * / total`)
   * rather than assumed to have nothing or everything; that same query is what recovers a final
   * chunk whose 201 was lost in transit.
   */
  private async upload(
    tokens: AuthTokens,
    mediaUrl: string,
    resource: Record<string, unknown>,
  ): Promise<VideoResource> {
    const first = await this.readRange(mediaUrl, 0, this.chunkBytes);
    const total = first.total;
    if (total > 256 * 1024 ** 3) {
      throw new ProviderBadRequestError('YouTube videos must be no larger than 256 GiB');
    }
    if (
      !first.contentType.startsWith('video/') &&
      !['application/octet-stream', 'binary/octet-stream'].includes(first.contentType)
    ) {
      throw new ProviderBadRequestError('YouTube requires a video file with a video MIME type');
    }
    const contentType = first.contentType.startsWith('video/') ? first.contentType : 'video/*';

    // Counted before the call: Google charges for failed calls too.
    this.ledger.record();
    const session = await this.client.send(
      `${UPLOAD_HOST}/videos?uploadType=resumable&part=snippet,status`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await this.accessToken(tokens)}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Length': String(total),
          'X-Upload-Content-Type': contentType,
        },
        body: JSON.stringify(resource),
      },
    );
    if (!session.ok) throw this.client.toError(session.status, session.body);
    const sessionUrl = session.header('location');
    if (!sessionUrl) {
      throw new ProviderTransientError('YouTube opened no upload session (no Location header)');
    }

    let offset = 0;
    let pending: Uint8Array | undefined = first.bytes;
    let stalled = 0;
    const giveUp = (why: string): ProviderTransientError =>
      new ProviderTransientError(`YouTube upload stalled at byte ${offset} of ${total} (${why})`);

    for (;;) {
      const bytes: Uint8Array =
        pending ?? (await this.readRange(mediaUrl, offset, this.chunkBytes, total)).bytes;
      pending = undefined;

      let step = await this.uploadStep(sessionUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${await this.accessToken(tokens)}`,
          'Content-Length': String(bytes.byteLength),
          'Content-Type': contentType,
          'Content-Range': `bytes ${offset}-${offset + bytes.byteLength - 1}/${total}`,
        },
        body: bytes,
      });
      while ('failure' in step) {
        stalled += 1;
        if (stalled > MAX_STALLED_RECOVERIES) throw giveUp(step.failure);
        await this.sleep(Math.min(BACKOFF_BASE_MS * 2 ** (stalled - 1), BACKOFF_MAX_MS));
        step = await this.uploadStep(sessionUrl, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${await this.accessToken(tokens)}`,
            'Content-Length': '0',
            'Content-Range': `bytes */${total}`,
          },
        });
      }
      if ('video' in step) return step.video;

      if (step.received > offset) stalled = 0;
      else if ((stalled += 1) > MAX_STALLED_RECOVERIES) throw giveUp('no bytes acknowledged');
      offset = step.received;
      if (offset >= total) {
        throw new ProviderTransientError(
          `YouTube acknowledged all ${total} bytes but returned no video`,
        );
      }
    }
  }

  /** One request to the upload session, reduced to the three things it can mean. */
  private async uploadStep(
    sessionUrl: string,
    init: { method: string; headers: Record<string, string>; body?: Uint8Array },
  ): Promise<{ video: VideoResource } | { received: number } | { failure: string }> {
    let res: GoogleResponse;
    try {
      res = await this.client.send(sessionUrl, init);
    } catch (err) {
      // Connection lost mid-request — the caller asks the server what it has.
      if (err instanceof ProviderTransientError) return { failure: err.message };
      throw err;
    }
    if (res.status === 200 || res.status === 201) return { video: res.body as VideoResource };
    if (res.status === 308) return { received: receivedBytes(res.header('range')) };
    if (isResumable(res.status)) return { failure: `HTTP ${res.status}` };
    // An expired session: the next job attempt opens a new one from byte zero.
    if (res.status === 404) {
      throw new ProviderTransientError('YouTube upload session expired (HTTP 404)');
    }
    throw this.client.toError(res.status, res.body);
  }

  /**
   * One ranged read of the stored media. `total` comes from the first read's `Content-Range`. A
   * host that ignores `Range` and answers 200 is acceptable only when the whole file fits in one
   * chunk — otherwise reading it would mean buffering the entire video, so it is refused unread.
   */
  private async readRange(
    url: string,
    offset: number,
    length: number,
    knownTotal?: number,
  ): Promise<{ bytes: Uint8Array; total: number; contentType: string }> {
    const end = knownTotal === undefined ? offset + length : Math.min(offset + length, knownTotal);
    let res: Awaited<ReturnType<MediaFetchLike>>;
    try {
      res = await this.fetchMedia(url, { headers: { Range: `bytes=${offset}-${end - 1}` } });
    } catch (cause) {
      throw new ProviderTransientError(
        `could not read the stored video: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (res.status >= 500) {
      throw new ProviderTransientError(`could not read the stored video (HTTP ${res.status})`);
    }
    if (!res.ok) {
      throw new ProviderBadRequestError(`could not read the stored video (HTTP ${res.status})`);
    }
    const contentType = res.headers.get('content-type') ?? '';

    if (res.status === 206) {
      const total = Number(/\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '')?.[1]);
      if (!Number.isFinite(total) || total <= 0) {
        throw new ProviderBadRequestError('media host sent a ranged reply with no total size');
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const expected = Math.min(end, total) - offset;
      if (bytes.byteLength !== expected) {
        throw new ProviderTransientError(
          `stored video read came back ${bytes.byteLength} bytes, expected ${expected}`,
        );
      }
      return { bytes, total, contentType };
    }

    const size = Number(res.headers.get('content-length'));
    if (offset !== 0 || !Number.isFinite(size) || size <= 0 || size > length) {
      await res.body?.cancel().catch(() => undefined);
      throw new ProviderBadRequestError(
        'the media host does not support ranged reads, so this video cannot be streamed to ' +
          'YouTube without holding it all in memory',
      );
    }
    return { bytes: new Uint8Array(await res.arrayBuffer()), total: size, contentType };
  }

  /**
   * `videos.list` for the status YouTube actually settled on. Never throws: the video is up, so a
   * failed read becomes a notice and the caller falls back to what the upload itself returned.
   */
  private async readBack(
    tokens: AuthTokens,
    videoId: string,
    notices: string[],
  ): Promise<VideoResource['status'] | undefined> {
    try {
      const qs = new URLSearchParams({ part: 'status', id: videoId });
      const res = await this.client.authed<{ items?: VideoResource[] }>(
        `${DATA_HOST}/videos?${qs.toString()}`,
        {},
        await this.accessToken(tokens),
      );
      const status = res.items?.[0]?.status;
      if (status) return status;
      notices.push('YouTube did not return the uploaded video when asked for its status.');
    } catch (err) {
      notices.push(
        `Could not re-read the video’s status from YouTube (${err instanceof Error ? err.message : String(err)}).`,
      );
    }
    return undefined;
  }

  /**
   * `thumbnails.set` — allowed on `youtube.upload`. Returns a notice on failure instead of throwing
   * (the video is already up). The usual cause is a channel without phone verification, which
   * YouTube answers with a bare 403.
   */
  private async setThumbnail(
    tokens: AuthTokens,
    videoId: string,
    image: MediaRef,
  ): Promise<string | undefined> {
    try {
      const file = await this.readRange(requireUrl(image), 0, THUMBNAIL_MAX_BYTES + 1);
      if (file.total > THUMBNAIL_MAX_BYTES) {
        return 'Thumbnail not set: the image is over YouTube’s 2 MB limit.';
      }
      const contentType = /^image\/(jpeg|png)$/.test(file.contentType)
        ? file.contentType
        : 'application/octet-stream';
      const res = await this.client.send(
        `${UPLOAD_HOST}/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${await this.accessToken(tokens)}`,
            'Content-Type': contentType,
            'Content-Length': String(file.bytes.byteLength),
          },
          body: file.bytes,
        },
      );
      if (res.ok) return undefined;
      const reason = this.client.toError(res.status, res.body).message;
      return res.status === 403
        ? `Thumbnail not set: YouTube refused it (${reason}). Custom thumbnails need a phone-verified channel.`
        : `Thumbnail not set (${reason}).`;
    } catch (err) {
      return `Thumbnail not set (${err instanceof Error ? err.message : String(err)}).`;
    }
  }
}

function youtubeOptions(detail: PostDetails): YoutubeOptions | undefined {
  return detail.options?.kind === 'youtube' ? detail.options : undefined;
}

/** An explicit description wins; otherwise the caption is the description. */
function descriptionOf(detail: PostDetails): string {
  return youtubeOptions(detail)?.description ?? detail.caption;
}

/**
 * The `video` resource for the session-opening request. Sent as given: Developer Policies III.F.2
 * forbid altering what the user wrote, which is why `#Shorts` is never appended here.
 */
function buildVideoResource(detail: PostDetails): Record<string, unknown> {
  const options = youtubeOptions(detail)!;
  return {
    snippet: {
      title: options.title,
      description: descriptionOf(detail),
      ...(options.tags?.length ? { tags: options.tags } : {}),
      ...(options.categoryId ? { categoryId: options.categoryId } : {}),
    },
    status: {
      privacyStatus: options.privacyStatus,
      selfDeclaredMadeForKids: options.madeForKids,
    },
  };
}

/**
 * Google's own arithmetic for the 500-char tag limit: commas between tags count, and a tag with a
 * space is counted as if it were wrapped in quotes.
 */
function tagsLength(tags: string[]): number {
  const chars = tags.reduce((sum, tag) => sum + tag.length + (/\s/.test(tag) ? 2 : 0), 0);
  return chars + Math.max(0, tags.length - 1);
}

/** Statuses the resumable protocol documents as "ask where you are and carry on". */
function isResumable(status: number): boolean {
  return status === 500 || status === 502 || status === 503 || status === 504;
}

/** `Range: bytes=0-N` → N + 1 bytes held. No header means the server has nothing yet. */
function receivedBytes(range: string | null): number {
  const last = /bytes=0-(\d+)/.exec(range ?? '')?.[1];
  return last === undefined ? 0 : Number(last) + 1;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function utcDay(value: string | number | undefined): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!match) return undefined;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

/** Google serialises unsigned longs as strings. */
function toNumber(value: string | number | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function requireUrl(media: MediaRef): string {
  if (!media.url) {
    throw new ProviderBadRequestError(
      `media ${media.mediaId} has no stored url — the upload reads the file from it`,
    );
  }
  return media.url;
}

/** Data API has no Shorts flag or dimensions: #Shorts is an editorial hint, never a classification. */
function normalizeImportedVideo(
  video: VideoResource | undefined,
  channelId: string,
): PublishedPostItem | null {
  const snippet = video?.snippet;
  const publishedAt = new Date(snippet?.publishedAt ?? '');
  const privacy = video?.status?.privacyStatus;
  if (
    !video?.id ||
    snippet?.channelId !== channelId ||
    !snippet.title ||
    !Number.isFinite(publishedAt.getTime()) ||
    !['public', 'unlisted', 'private'].includes(privacy ?? '')
  )
    return null;
  const duration = /^(?:P(?:(\d+)D)?T)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(
    video.contentDetails?.duration ?? '',
  );
  const durationSeconds = duration
    ? Number(duration[1] ?? 0) * 86400 +
      Number(duration[2] ?? 0) * 3600 +
      Number(duration[3] ?? 0) * 60 +
      Number(duration[4] ?? 0)
    : undefined;
  const description = snippet.description ?? '';
  return {
    externalPostId: video.id,
    alternateIds: [],
    knownUrls: [],
    caption: description,
    options: {
      kind: 'youtube',
      title: snippet.title,
      description,
      privacyStatus: privacy as YoutubeOptions['privacyStatus'],
      remote: { privacyStatus: privacy as YoutubeOptions['privacyStatus'] },
      madeForKids: video.status?.selfDeclaredMadeForKids ?? video.status?.madeForKids ?? false,
      ...(snippet.categoryId ? { categoryId: snippet.categoryId } : {}),
      ...(snippet.tags ? { tags: snippet.tags } : {}),
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      shortsHint: /(^|\s)#shorts\b/i.test(`${snippet.title} ${description}`),
    },
    publishedAt,
    permalink: `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`,
    mediaKind: 'video',
    mediaCount: 1,
    thumbnailUrl:
      ['maxres', 'standard', 'high', 'medium', 'default']
        .map((size) => snippet.thumbnails?.[size]?.url)
        .find(Boolean) ?? null,
  };
}
