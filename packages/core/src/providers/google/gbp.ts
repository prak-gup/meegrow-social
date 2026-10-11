import type { MediaRef, PostOptions } from '@meegrow-social/contracts';
import type {
  AuthTokens,
  GenerateAuthUrl,
  MetricPoint,
  PostDetails,
  PostResult,
  ProviderAccount,
  SocialProvider,
} from '../types.js';
import { ProviderAuthError, ProviderBadRequestError } from '../../errors.js';
import { GoogleOAuthClient, type GoogleClientConfig } from './client.js';

/**
 * Google Business Profile provider (issue #21, BUILD-SPEC-V2 §4 B1). Publishes Local Posts to one
 * location and reads back per-post insights + daily Performance metrics.
 *
 * NOT LIVE-VERIFIED — Google had granted no API access when this was written. Every shape below is
 * the documented one (docs/dev/research/gbp-linkedin.md), and §A7 of that note is the list of
 * assumptions the live bring-up has to confirm. Registration is env-gated (registry.ts), so with
 * no GOOGLE_CLIENT_ID/SECRET set this provider does not exist at runtime.
 *
 * Token model — the important bit (RESEARCH gbp-linkedin.md §A5):
 *   consent → { access token (~1h), refresh token }. The refresh token is the durable credential
 *   and it carries no expiry we can read, so the connection is stored with NO `expiresAt`:
 *   `computeHealth` reports 'healthy' and `expiresInDays` is null — the "non-expiring" state #21
 *   asks for. Storing the access token's one-hour expiry instead would pin every GBP connection at
 *   'expiring' forever, because the health window is 7 days.
 *
 *   The stored access token is therefore stale within the hour and is never trusted: every call
 *   mints a fresh one from the refresh token (cached in memory by the shared client). When the
 *   refresh token itself dies — revoked, or the 7-day expiry Google applies while the consent
 *   screen is unverified (BUILD-SPEC-V2 §A2) — the mint fails `invalid_grant`, which surfaces as
 *   an auth error → needs_reconnect on the next publish or analytics sweep.
 */

const ACCOUNTS_HOST = 'https://mybusinessaccountmanagement.googleapis.com/v1';
const INFO_HOST = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const PERFORMANCE_HOST = 'https://businessprofileperformance.googleapis.com/v1';
/** The legacy host. Local Posts never got a v1 successor, and it is the one behind the 0-QPM gate. */
const V4_HOST = 'https://mybusiness.googleapis.com/v4';

/**
 * `business.manage` alone covers posts, locations and performance. Nothing here reads userinfo —
 * the connection is named after the location, not the Google user — and Google's verification
 * rejects scopes the demo never exercises, so it is the only scope requested (#21 listed two more).
 */
export const GBP_SCOPES = ['https://www.googleapis.com/auth/business.manage'] as const;

/** Hard cap on `summary`. Google truncates the card long before this — lead with the point. */
export const GBP_SUMMARY_MAX = 1500;
const EVENT_TITLE_MAX = 58;
const LANGUAGE_CODE = 'en';

const POST_METRICS = ['LOCAL_POST_VIEWS_SEARCH', 'LOCAL_POST_ACTIONS_CALL_TO_ACTION'] as const;
/** `reportInsights` wants an explicit range; a post's card is long gone from the listing by then. */
const POST_INSIGHTS_WINDOW_DAYS = 30;

/** Stored verbatim (invariant 7). GBP has no follower metric, so none is emitted — never a 0. */
const DAILY_METRICS = [
  'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
  'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
  'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
  'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
  'WEBSITE_CLICKS',
  'CALL_CLICKS',
  'BUSINESS_DIRECTION_REQUESTS',
  'BUSINESS_CONVERSATIONS',
  'BUSINESS_BOOKINGS',
] as const;
/** Complete days re-read on each sweep, ending yesterday (UTC). */
const DAILY_WINDOW_DAYS = 2;

/** Pagination backstop — a `nextPageToken` that never ends must not spin the connect flow. */
const MAX_PAGES = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Where a post links when Google returns no `searchUrl` (it is output-only and may lag). */
const FALLBACK_RELEASE_URL = 'https://business.google.com/';

type GmbOptions = Extract<PostOptions, { kind: 'gmb' }>;

interface GbpAccount {
  name: string;
  accountName?: string;
}

interface GbpLocation {
  name: string;
  title?: string;
  storefrontAddress?: { locality?: string };
}

interface GoogleDate {
  year?: number;
  month?: number;
  day?: number;
}

interface LocalPost {
  name?: string;
  state?: string;
  searchUrl?: string;
}

interface PostInsights {
  localPostMetrics?: Array<{
    metricValues?: Array<{ metric?: string; totalValue?: { value?: string | number } }>;
  }>;
}

export class GbpProvider implements SocialProvider {
  readonly identifier = 'gmb' as const;
  readonly displayName = 'Google Business Profile';
  readonly isBetweenSteps = true;
  readonly tokenModel = 'auto-refresh' as const;
  // 300 QPM is shared project-wide across every read and write, so keep the fan-out small.
  readonly maxConcurrentJobs = 2;

  private readonly client: GoogleOAuthClient;
  private readonly now: () => Date;

  constructor(config: GoogleClientConfig | GoogleOAuthClient, now: () => Date = () => new Date()) {
    this.client = config instanceof GoogleOAuthClient ? config : new GoogleOAuthClient(config);
    this.now = now;
  }

  async generateAuthUrl(params: { redirectUri: string; state: string }): Promise<GenerateAuthUrl> {
    // `includeGrantedScopes: false`: one OAuth client serves YouTube too, and a GBP token must not
    // pick up scopes the same Google user granted for another platform.
    return {
      url: this.client.authUrl({ ...params, scopes: [...GBP_SCOPES], includeGrantedScopes: false }),
    };
  }

  /**
   * externalId/displayName stay 'pending' — this is a two-phase provider, so the real identity
   * arrives once the user picks a location. No `expiresAt`, deliberately (see the class note).
   */
  async authenticate(params: { code: string; redirectUri: string }): Promise<AuthTokens> {
    const tokens = await this.client.exchangeCode(params);
    if (!tokens.refreshToken) {
      // Google only returns a refresh token on a fresh consent. Without one the connection would
      // work for an hour and then die silently, so refuse it here instead.
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
   * Accounts → locations. `externalId` is the composite `accounts/{a}/locations/{l}`: the v4 host
   * needs both ids, the v1 hosts hand them back separately, and a connection keeps one string.
   */
  async listAccounts(tokens: AuthTokens): Promise<ProviderAccount[]> {
    const token = await this.accessToken(tokens);
    const accounts = await this.paginate<GbpAccount>(
      `${ACCOUNTS_HOST}/accounts`,
      { pageSize: '20' },
      'accounts',
      token,
    );

    const found: ProviderAccount[] = [];
    for (const account of accounts) {
      const locations = await this.paginate<GbpLocation>(
        `${INFO_HOST}/${account.name}/locations`,
        { readMask: 'name,title,storefrontAddress', pageSize: '100' },
        'locations',
        token,
      );
      for (const location of locations) {
        const title = location.title ?? location.name;
        const locality = location.storefrontAddress?.locality;
        found.push({
          externalId: `${account.name}/${location.name}`,
          displayName: locality ? `${title} — ${locality}` : title,
        });
      }
    }
    return found;
  }

  // No finalizeAccount: a location publishes with the user's own token — there is no per-location
  // token to swap in, unlike a Facebook Page.

  /**
   * Mint a fresh access token. The sweeper does not call this for GBP (no stored expiry puts the
   * row outside its candidate filter); it exists for the contract and for a manual refresh.
   */
  async refreshToken(refreshToken: string): Promise<AuthTokens> {
    const tokens = await this.client.refresh(refreshToken);
    return {
      accessToken: tokens.accessToken,
      // Google does not rotate refresh tokens; pass one through only if it ever sends one.
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      externalId: 'pending',
      displayName: 'pending',
    };
  }

  /**
   * GBP's own rules, checked at create time. Media is judged on arity only — refs may not carry a
   * resolved public URL yet (services/posts.ts), so the URL-only rule is enforced in `post()`.
   */
  assertPublishable(details: PostDetails[]): void {
    if (details.length !== 1) {
      throw new ProviderBadRequestError(
        `gmb expects exactly one post, got ${details.length} (GBP has no thread concept)`,
      );
    }
    const [detail] = details as [PostDetails];
    const options = gmbOptions(detail);
    const topicType = options?.topicType ?? 'STANDARD';

    if (detail.caption.trim().length === 0) {
      throw new ProviderBadRequestError('gmb posts need a caption (the post summary)');
    }
    if (detail.caption.length > GBP_SUMMARY_MAX) {
      throw new ProviderBadRequestError(
        `gmb caption is ${detail.caption.length} chars; the limit is ${GBP_SUMMARY_MAX} ` +
          '(and Google truncates the card — keep the point in the first ~100)',
      );
    }
    if (detail.media.length > 1) {
      throw new ProviderBadRequestError(
        `gmb supports at most one media item per post, got ${detail.media.length}`,
      );
    }

    if (topicType === 'ALERT') {
      // Google requires an `alertType` on ALERT posts and documents exactly one value, COVID_19.
      // The options contract carries none, and defaulting it would label a client's post a
      // COVID-19 update — so ALERT stays closed until the live bring-up says what it accepts.
      throw new ProviderBadRequestError(
        'gmb ALERT posts are not supported yet (Google requires an alertType we cannot supply)',
      );
    }

    const cta = options?.cta;
    if (cta?.actionType === 'CALL' && cta.url) {
      throw new ProviderBadRequestError(
        'gmb CALL button takes no url — it uses the location’s phone number',
      );
    }
    if (cta && cta.actionType !== 'CALL' && !cta.url) {
      throw new ProviderBadRequestError(`gmb ${cta.actionType} button needs a url`);
    }

    const event = options?.event;
    const needsEvent = topicType === 'EVENT' || topicType === 'OFFER';
    if (needsEvent && !event) {
      throw new ProviderBadRequestError(
        topicType === 'EVENT'
          ? 'gmb EVENT posts need event title and dates'
          : 'gmb OFFER posts need event title and dates (the offer’s schedule lives there)',
      );
    }
    if (!needsEvent && event) {
      throw new ProviderBadRequestError(`gmb ${topicType} posts cannot carry event details`);
    }
    if (event) {
      if (event.title.length > EVENT_TITLE_MAX) {
        throw new ProviderBadRequestError(
          `gmb event title is ${event.title.length} chars; the limit is ${EVENT_TITLE_MAX}`,
        );
      }
      if (event.end.getTime() <= event.start.getTime()) {
        throw new ProviderBadRequestError('gmb event must end after it starts');
      }
    }
    if (options?.offer && topicType !== 'OFFER') {
      throw new ProviderBadRequestError(`gmb ${topicType} posts cannot carry offer details`);
    }
  }

  async post(tokens: AuthTokens, details: PostDetails[]): Promise<PostResult> {
    // Re-checked here: the worker can pick up a row stored before a rule existed.
    this.assertPublishable(details);
    const [detail] = details as [PostDetails];
    const parent = locationPath(tokens.externalId).parent;
    const body = buildLocalPost(detail);

    const res = await this.client.authed<LocalPost>(
      `${V4_HOST}/${parent}/localPosts`,
      { method: 'POST', body },
      await this.accessToken(tokens),
    );

    // PROCESSING is success — Google is still fetching the photo. Only REJECTED is a failure.
    if (res.state === 'REJECTED') {
      throw new ProviderBadRequestError(
        `Google rejected the local post (state REJECTED)${res.name ? ` — ${res.name}` : ''}`,
      );
    }
    if (!res.name) {
      // Not retried on purpose: the post may exist, and a retry would publish it twice.
      throw new ProviderBadRequestError('Google accepted the local post but returned no name');
    }
    return { externalPostId: res.name, releaseUrl: res.searchUrl ?? FALLBACK_RELEASE_URL };
  }

  /**
   * Per-post insights over a trailing window, as one snapshot per sweep. `externalPostId` is the
   * full `accounts/{a}/locations/{l}/localPosts/{p}` name, so the parent comes straight out of it.
   *
   * A permanent 4xx resolves to no points rather than throwing: an unstamped post is re-polled
   * every hour, so a post Google will never report on must not fail forever. Auth and transient
   * errors still surface.
   */
  async postAnalytics(tokens: AuthTokens, externalPostId: string): Promise<MetricPoint[]> {
    const parent = externalPostId.replace(/\/localPosts\/[^/]+$/, '');
    const capturedAt = this.now();
    const body = {
      localPostNames: [externalPostId],
      basicRequest: {
        metricRequests: POST_METRICS.map((metric) => ({ metric })),
        timeRange: {
          startTime: new Date(
            capturedAt.getTime() - POST_INSIGHTS_WINDOW_DAYS * DAY_MS,
          ).toISOString(),
          endTime: capturedAt.toISOString(),
        },
      },
    };

    let res: PostInsights;
    try {
      res = await this.client.authed<PostInsights>(
        `${V4_HOST}/${parent}/localPosts:reportInsights`,
        { method: 'POST', body },
        await this.accessToken(tokens),
      );
    } catch (err) {
      if (err instanceof ProviderBadRequestError) return [];
      throw err;
    }

    const points: MetricPoint[] = [];
    for (const post of res.localPostMetrics ?? []) {
      for (const row of post.metricValues ?? []) {
        const value = toNumber(row.totalValue?.value);
        if (row.metric && value !== undefined) {
          points.push({ metric: row.metric, value, capturedAt });
        }
      }
    }
    return points;
  }

  /**
   * Daily Performance metrics for the location. Each point is stamped with the day it belongs to
   * (UTC midnight), not the sweep time, so a re-read of the same day lands on the same
   * `capturedAt`.
   *
   * Google omits `value` when a day's count is zero — and also while a recent day is still being
   * computed. The two are indistinguishable here, so a missing value is skipped rather than stored
   * as 0.
   */
  async accountAnalytics(tokens: AuthTokens): Promise<MetricPoint[]> {
    const { location } = locationPath(tokens.externalId);
    const today = this.now();
    const end = new Date(today.getTime() - DAY_MS);
    const start = new Date(today.getTime() - DAILY_WINDOW_DAYS * DAY_MS);

    const qs = new URLSearchParams();
    for (const metric of DAILY_METRICS) qs.append('dailyMetrics', metric);
    appendDate(qs, 'dailyRange.start_date', start);
    appendDate(qs, 'dailyRange.end_date', end);

    const res = await this.client.authed<{
      multiDailyMetricTimeSeries?: Array<{
        dailyMetricTimeSeries?: Array<{
          dailyMetric?: string;
          timeSeries?: { datedValues?: Array<{ date?: GoogleDate; value?: string | number }> };
        }>;
      }>;
    }>(
      `${PERFORMANCE_HOST}/${location}:fetchMultiDailyMetricsTimeSeries?${qs.toString()}`,
      {},
      await this.accessToken(tokens),
    );

    const points: MetricPoint[] = [];
    for (const group of res.multiDailyMetricTimeSeries ?? []) {
      for (const series of group.dailyMetricTimeSeries ?? []) {
        for (const dated of series.timeSeries?.datedValues ?? []) {
          const value = toNumber(dated.value);
          const capturedAt = toUtcDay(dated.date);
          if (series.dailyMetric && value !== undefined && capturedAt) {
            points.push({ metric: series.dailyMetric, value, capturedAt });
          }
        }
      }
    }
    return points;
  }

  /** Always mint from the refresh token when there is one — the stored access token is stale. */
  private async accessToken(tokens: AuthTokens): Promise<string> {
    return tokens.refreshToken
      ? this.client.accessTokenFor(tokens.refreshToken)
      : tokens.accessToken;
  }

  private async paginate<T>(
    url: string,
    params: Record<string, string>,
    key: string,
    token: string,
  ): Promise<T[]> {
    const items: T[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const qs = new URLSearchParams(params);
      if (pageToken) qs.set('pageToken', pageToken);
      const res = await this.client.authed<Record<string, unknown>>(
        `${url}?${qs.toString()}`,
        {},
        token,
      );
      items.push(...((res[key] as T[] | undefined) ?? []));
      pageToken = typeof res.nextPageToken === 'string' ? res.nextPageToken : undefined;
      if (!pageToken) break;
    }
    return items;
  }
}

function gmbOptions(detail: PostDetails): GmbOptions | undefined {
  return detail.options?.kind === 'gmb' ? detail.options : undefined;
}

/**
 * Split the composite externalId back into what each host wants: v4 takes the whole path, the
 * Performance API takes only `locations/{l}`.
 */
function locationPath(externalId: string): { parent: string; location: string } {
  const match = /^accounts\/[^/]+\/(locations\/[^/]+)$/.exec(externalId);
  if (!match) {
    throw new ProviderBadRequestError(
      `gmb connection id "${externalId}" is not accounts/{account}/locations/{location}`,
    );
  }
  return { parent: externalId, location: match[1]! };
}

function buildLocalPost(detail: PostDetails): Record<string, unknown> {
  const options = gmbOptions(detail);
  const body: Record<string, unknown> = {
    languageCode: LANGUAGE_CODE,
    summary: detail.caption,
    topicType: options?.topicType ?? 'STANDARD',
  };

  const cta = options?.cta;
  if (cta) {
    body.callToAction =
      cta.actionType === 'CALL'
        ? { actionType: 'CALL' }
        : { actionType: cta.actionType, url: cta.url };
  }

  const [media] = detail.media;
  if (media) {
    body.media = [
      { mediaFormat: media.kind === 'video' ? 'VIDEO' : 'PHOTO', sourceUrl: requireUrl(media) },
    ];
  }

  if (options?.event) {
    const { title, start, end } = options.event;
    body.event = {
      title,
      schedule: {
        startDate: toGoogleDate(start),
        startTime: toGoogleTime(start),
        endDate: toGoogleDate(end),
        endTime: toGoogleTime(end),
      },
    };
  }

  if (options?.offer) {
    const { couponCode, redeemUrl, terms } = options.offer;
    body.offer = {
      ...(couponCode ? { couponCode } : {}),
      ...(redeemUrl ? { redeemOnlineUrl: redeemUrl } : {}),
      ...(terms ? { termsConditions: terms } : {}),
    };
  }

  return body;
}

/**
 * Google's event schedule is wall-clock with no zone; we only hold an instant. Rendered in UTC
 * until the options contract carries the location's zone — see research note §A7.
 */
function toGoogleDate(d: Date): { year: number; month: number; day: number } {
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function toGoogleTime(d: Date): { hours: number; minutes: number; seconds: number; nanos: number } {
  return {
    hours: d.getUTCHours(),
    minutes: d.getUTCMinutes(),
    seconds: d.getUTCSeconds(),
    nanos: 0,
  };
}

function appendDate(qs: URLSearchParams, prefix: string, d: Date): void {
  const { year, month, day } = toGoogleDate(d);
  qs.set(`${prefix}.year`, String(year));
  qs.set(`${prefix}.month`, String(month));
  qs.set(`${prefix}.day`, String(day));
}

function toUtcDay(date: GoogleDate | undefined): Date | undefined {
  if (!date?.year || !date.month || !date.day) return undefined;
  return new Date(Date.UTC(date.year, date.month - 1, date.day));
}

/** Google serialises int64 as a string. */
function toNumber(value: string | number | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * GBP media is URL-only (`sourceUrl`) — Google fetches the file itself. `resolveMediaRefs`
 * populates the URL in the publish service; a missing one is permanent, not something a retry fixes.
 */
function requireUrl(media: MediaRef): string {
  if (!media.url) {
    throw new ProviderBadRequestError(
      `media ${media.mediaId} has no public url — GBP media is URL-only (sourceUrl)`,
    );
  }
  return media.url;
}
