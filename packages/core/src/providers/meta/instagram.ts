import type { MediaRef } from '@meegrow-social/contracts';
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
  ProviderRateLimitError,
  ProviderTransientError,
} from '../../errors.js';
import type {
  PublishedPostItem,
  PublishedPostPage,
  PublishedPostPresence,
  PublishedPostQuery,
} from '../published-posts.js';
import { cursorParams, MetaClient, nextPageCursor, type MetaClientConfig } from './client.js';

/**
 * Instagram Business provider via Facebook Login (issue #13). Shares MetaClient with the Facebook
 * Pages provider (#14) — one Meta app, two providers, per both issues.
 *
 * Shape differs from Facebook in three ways that drive this whole file:
 *  1. **No text-only posts.** Instagram has no equivalent of `/feed` with just a message; every
 *     post carries media. A caption-only post is a permanent bad request, not something to retry.
 *  2. **Container → publish, never a direct upload.** Meta FETCHES the media from a public URL we
 *     hand it (RESEARCH meta.md gotcha #1), so `resolveMediaRefs` must have populated `url` by
 *     publish time. Containers expire after 24h.
 *  3. **Video/reels process asynchronously.** The container must reach `status_code=FINISHED`
 *     before `media_publish`, or Meta answers "media not ready" (gotcha #2).
 *
 * Identity: the connection stores the **IG user id** as externalId (that's what /media and
 * /media_publish address) and the **Page token** as the credential — IG-via-Page is authorised
 * through the Page, so there is no separate IG token on this path.
 */

/**
 * Views-era metric names. #14's live bring-up proved Meta 400s the WHOLE insights call on a single
 * unknown name rather than omitting it — `post_impressions_unique` came back rejected — so these
 * are requested one at a time and retired names are skipped. Never request `impressions`
 * (RESEARCH meta.md §6: impressions → views across Nov 2025–Jun 2026).
 * CONFIRM AT LIVE BRING-UP and re-record fixtures.
 */
const MEDIA_METRICS = [
  'views',
  'reach',
  'total_interactions',
  'likes',
  'comments',
  'saved',
] as const;

/** Video containers are async; poll this many times before giving up (RESEARCH gotcha #2). */
const DEFAULT_STATUS_ATTEMPTS = 20;
const DEFAULT_STATUS_DELAY_MS = 3000;

const PAGE_FIELDS = 'id,name,access_token,instagram_business_account{id,username}';

/** What an import reads of each IG media (RESEARCH meta.md §7.2). */
const MEDIA_FIELDS =
  'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,' +
  'children{media_type,media_url,thumbnail_url}';
const MAX_MEDIA_PAGE = 100;

interface GraphIgMedia {
  id?: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  timestamp?: string;
  children?: { data?: GraphIgMedia[] };
}

/** One IG media → the shape the importer stores. Null for an item that cannot be one. */
export function normalizeIgMedia(media: GraphIgMedia): PublishedPostItem | null {
  const publishedAt = media.timestamp ? new Date(media.timestamp) : null;
  if (!media.id || !publishedAt || Number.isNaN(publishedAt.getTime())) return null;
  // Stories are not on this edge (Meta documents `/stories` for them) and their insights last 24h;
  // an ad is not an organic post. Skipped if one ever turns up.
  if (media.media_product_type === 'STORY' || media.media_product_type === 'AD') return null;
  const children = media.children?.data ?? [];
  // An album's own `media_url` is not documented; its first child's is.
  const lead = media.media_type === 'CAROUSEL_ALBUM' ? (children[0] ?? media) : media;
  const video = lead.media_type === 'VIDEO';
  return {
    externalPostId: media.id,
    alternateIds: [],
    knownUrls: [],
    caption: media.caption ?? '',
    publishedAt,
    permalink: media.permalink ?? null,
    mediaKind: video ? 'video' : 'image',
    mediaCount: Math.max(children.length, 1),
    // `media_url` of a video is the video file, and Meta omits it for copyrighted audio; the still
    // is `thumbnail_url`. Null when Meta gives neither — the post is imported without a picture.
    thumbnailUrl: (video ? lead.thumbnail_url : lead.media_url) ?? null,
  };
}

interface PageWithIg {
  id: string;
  name: string;
  access_token: string;
  instagram_business_account?: { id: string; username?: string };
}

export interface InstagramProviderOptions {
  /** Injected so contract tests don't actually wait on the async-container poll. */
  sleep?: (ms: number) => Promise<void>;
  statusAttempts?: number;
  statusDelayMs?: number;
}

export class InstagramProvider implements SocialProvider {
  readonly identifier = 'instagram' as const;
  readonly displayName = 'Instagram';
  readonly isBetweenSteps = true;
  // Same reasoning as Facebook: the credential is a non-expiring Page token, which cannot be
  // refreshed — a dead one means a real reconnect, and the sweeper must never try to refresh it.
  readonly tokenModel = 'one-time' as const;
  readonly maxConcurrentJobs = 2;

  private readonly client: MetaClient;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly statusAttempts: number;
  private readonly statusDelayMs: number;

  constructor(config: MetaClientConfig | MetaClient, opts: InstagramProviderOptions = {}) {
    this.client = config instanceof MetaClient ? config : new MetaClient(config);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.statusAttempts = opts.statusAttempts ?? DEFAULT_STATUS_ATTEMPTS;
    this.statusDelayMs = opts.statusDelayMs ?? DEFAULT_STATUS_DELAY_MS;
  }

  async generateAuthUrl(params: { redirectUri: string; state: string }): Promise<GenerateAuthUrl> {
    return { url: this.client.authDialogUrl(params) };
  }

  async authenticate(params: { code: string; redirectUri: string }): Promise<AuthTokens> {
    const { accessToken } = await this.client.exchangeCodeForLongLivedUserToken({
      code: params.code,
      redirectUri: params.redirectUri,
    });
    return { accessToken, externalId: 'pending', displayName: 'pending' };
  }

  /**
   * Offers the IG accounts reachable through the user's Pages — not the Pages themselves. A Page
   * with no linked IG account is silently useless here, so it's filtered out rather than offered
   * and failing later.
   */
  async listAccounts(tokens: AuthTokens): Promise<ProviderAccount[]> {
    const pages = await this.fetchPagesWithIg(tokens.accessToken);
    return pages
      .filter((p) => p.instagram_business_account?.id)
      .map((p) => ({
        externalId: p.instagram_business_account!.id,
        // Prefer the IG handle; fall back to the Page name so the picker is never blank.
        displayName: p.instagram_business_account!.username
          ? `@${p.instagram_business_account!.username}`
          : p.name,
      }));
  }

  /** Swap the user token for the Page token that authorises the chosen IG account. */
  async finalizeAccount(tokens: AuthTokens, account: ProviderAccount): Promise<AuthTokens> {
    const pages = await this.fetchPagesWithIg(tokens.accessToken);
    const page = pages.find((p) => p.instagram_business_account?.id === account.externalId);
    if (!page) {
      throw new ProviderAuthError(
        `instagram account ${account.externalId} is no longer reachable through this user's pages`,
      );
    }
    if (!page.access_token) {
      throw new ProviderAuthError(`no page access token returned for page ${page.id}`);
    }
    return {
      accessToken: page.access_token,
      // No expiresAt — Page tokens are non-expiring (RESEARCH meta.md §2.1), same as #14.
      externalId: account.externalId, // the IG user id: what /media and /media_publish address
      displayName: account.displayName,
    };
  }

  async refreshToken(): Promise<AuthTokens> {
    throw new ProviderAuthError(
      'instagram-via-page uses a non-refreshable page token — reconnect required',
    );
  }

  async post(tokens: AuthTokens, details: PostDetails[]): Promise<PostResult> {
    if (details.length !== 1) {
      throw new ProviderBadRequestError(
        `instagram expects exactly one post, got ${details.length} (threads are not supported)`,
      );
    }
    const [detail] = details as [PostDetails];
    const igUserId = tokens.externalId;
    const media = detail.media;

    if (media.length === 0) {
      // Not retryable: Instagram simply has no text-only post.
      throw new ProviderBadRequestError('instagram posts require at least one image or video');
    }
    if (media.length > 10) {
      throw new ProviderBadRequestError(
        `instagram carousels hold at most 10 items, got ${media.length}`,
      );
    }

    const containerId =
      media.length > 1
        ? await this.createCarouselContainer(tokens, igUserId, detail.caption, media)
        : await this.createSingleContainer(tokens, igUserId, detail.caption, media[0]!);

    const mediaId = await this.publishContainer(tokens, igUserId, containerId);
    return { externalPostId: mediaId, releaseUrl: await this.permalinkFor(tokens, mediaId) };
  }

  async postAnalytics(tokens: AuthTokens, externalPostId: string): Promise<MetricPoint[]> {
    const capturedAt = new Date();
    const points: MetricPoint[] = [];

    for (const metric of MEDIA_METRICS) {
      try {
        const res = await this.client.graphGet<{
          data?: Array<{ name?: string; values?: Array<{ value?: number }> }>;
        }>(`${externalPostId}/insights`, { metric, access_token: tokens.accessToken });
        for (const row of res.data ?? []) {
          const value = row.values?.[0]?.value;
          if (typeof value === 'number' && row.name) {
            points.push({ metric: row.name, value, capturedAt });
          }
        }
      } catch (err) {
        // A retired metric must not sink the whole collection; auth errors still surface so the
        // analytics sweeper (#9) flags the connection, and so does a throttled call —
        // swallowed, it would record "swept, nothing to report" for a media that was never read.
        if (err instanceof ProviderAuthError || err instanceof ProviderRateLimitError) throw err;
      }
    }
    return points;
  }

  /** Followers as a node field on the IG user (#9's daily cadence). */
  async accountAnalytics(tokens: AuthTokens): Promise<MetricPoint[]> {
    const user = await this.client.graphGet<{ followers_count?: number }>(tokens.externalId, {
      fields: 'followers_count',
      access_token: tokens.accessToken,
    });
    return typeof user.followers_count === 'number'
      ? [{ metric: 'followers', value: user.followers_count, capturedAt: new Date() }]
      : [];
  }

  /**
   * The account's own media, newest first, read from the IG user node with the stored Page token
   * (RESEARCH meta.md §7.2). Stories are not on this edge.
   */
  async listPublishedPosts(
    tokens: AuthTokens,
    query: PublishedPostQuery,
  ): Promise<PublishedPostPage> {
    const params: Record<string, string> = query.cursor
      ? cursorParams(query.cursor)
      : {
          fields: MEDIA_FIELDS,
          limit: String(Math.min(query.limit, MAX_MEDIA_PAGE)),
          since: String(Math.floor(query.since.getTime() / 1000)),
          ...(query.until ? { until: String(Math.ceil(query.until.getTime() / 1000)) } : {}),
        };
    const { data, usage } = await this.client.graphGetWithUsage<{
      data?: GraphIgMedia[];
      paging?: { next?: string };
    }>(`${tokens.externalId}/media`, { ...params, access_token: tokens.accessToken });
    return {
      items: (data.data ?? []).flatMap((m) => normalizeIgMedia(m) ?? []),
      nextCursor: nextPageCursor(data.paging?.next),
      usage,
    };
  }

  /** Same rule as Facebook: `gone` only when the media is missing and the account still reads. */
  async publishedPostPresence(
    tokens: AuthTokens,
    externalPostId: string,
  ): Promise<PublishedPostPresence> {
    const media = await this.client.nodePresence(externalPostId, tokens.accessToken);
    if (media !== 'missing') return media;
    const account = await this.client.nodePresence(tokens.externalId, tokens.accessToken);
    return account === 'present' ? 'gone' : 'unknown';
  }

  // --- internals -------------------------------------------------------------------------------

  private async fetchPagesWithIg(userAccessToken: string): Promise<PageWithIg[]> {
    const res = await this.client.graphGet<{ data?: PageWithIg[] }>('me/accounts', {
      fields: PAGE_FIELDS,
      access_token: userAccessToken,
    });
    if (res.data?.length) return res.data;
    // Same fallback as Facebook, by Page id — the IG account still arrives through its Page
    // (UNVERIFIED against Meta — see MetaClient.pagesFromGrantedScopes).
    return this.client.pagesFromGrantedScopes<PageWithIg>(userAccessToken, PAGE_FIELDS);
  }

  private async createSingleContainer(
    tokens: AuthTokens,
    igUserId: string,
    caption: string,
    item: MediaRef,
  ): Promise<string> {
    const params: Record<string, string> = { caption, access_token: tokens.accessToken };
    if (item.kind === 'video') {
      // Everything video goes up as REELS — Meta folded standalone IG video into reels, and
      // share_to_feed keeps it visible in the profile grid as well as the Reels tab.
      params.media_type = 'REELS';
      params.video_url = requireUrl(item);
      params.share_to_feed = 'true';
    } else {
      params.image_url = requireUrl(item);
    }
    const res = await this.client.graphPost<{ id: string }>(`${igUserId}/media`, params);
    if (item.kind === 'video') await this.awaitContainerReady(tokens, res.id);
    return res.id;
  }

  /** 2–10 children, then one parent container. Meta crops every slide to the FIRST item's ratio. */
  private async createCarouselContainer(
    tokens: AuthTokens,
    igUserId: string,
    caption: string,
    items: MediaRef[],
  ): Promise<string> {
    const childIds: string[] = [];
    for (const item of items) {
      const params: Record<string, string> = {
        is_carousel_item: 'true',
        access_token: tokens.accessToken,
      };
      if (item.kind === 'video') {
        params.media_type = 'VIDEO';
        params.video_url = requireUrl(item);
      } else {
        params.image_url = requireUrl(item);
      }
      const child = await this.client.graphPost<{ id: string }>(`${igUserId}/media`, params);
      if (item.kind === 'video') await this.awaitContainerReady(tokens, child.id);
      childIds.push(child.id);
    }

    const parent = await this.client.graphPost<{ id: string }>(`${igUserId}/media`, {
      media_type: 'CAROUSEL',
      children: childIds.join(','),
      caption,
      access_token: tokens.accessToken,
    });
    return parent.id;
  }

  /**
   * Poll until the async container finishes processing. ERROR/EXPIRED are permanent (a re-run
   * produces the same result on the same media); running out of attempts is transient, so BullMQ
   * retries the publish job.
   */
  private async awaitContainerReady(tokens: AuthTokens, containerId: string): Promise<void> {
    for (let attempt = 0; attempt < this.statusAttempts; attempt++) {
      const res = await this.client.graphGet<{ status_code?: string; status?: string }>(
        containerId,
        { fields: 'status_code,status', access_token: tokens.accessToken },
      );
      if (res.status_code === 'FINISHED') return;
      if (res.status_code === 'ERROR' || res.status_code === 'EXPIRED') {
        throw new ProviderBadRequestError(
          `instagram container ${containerId} ${res.status_code}: ${res.status ?? 'no detail'}`,
        );
      }
      await this.sleep(this.statusDelayMs);
    }
    throw new ProviderTransientError(
      `instagram container ${containerId} still processing after ${this.statusAttempts} checks`,
    );
  }

  private async publishContainer(
    tokens: AuthTokens,
    igUserId: string,
    containerId: string,
  ): Promise<string> {
    const res = await this.client.graphPost<{ id: string }>(`${igUserId}/media_publish`, {
      creation_id: containerId,
      access_token: tokens.accessToken,
    });
    return res.id;
  }

  /**
   * The human-facing URL must be fetched, not constructed: an Instagram permalink uses an opaque
   * shortcode (`/p/CxYz123/`), NOT the numeric media id `media_publish` returns — building
   * `instagram.com/p/{mediaId}` yields a 404. Falls back to the profile URL rather than failing the
   * publish: the post is already live at this point, and a cosmetic link is not worth losing it.
   */
  private async permalinkFor(tokens: AuthTokens, mediaId: string): Promise<string> {
    try {
      const res = await this.client.graphGet<{ permalink?: string }>(mediaId, {
        fields: 'permalink',
        access_token: tokens.accessToken,
      });
      if (res.permalink) return res.permalink;
    } catch {
      // fall through
    }
    return `https://www.instagram.com/${tokens.displayName.replace(/^@/, '')}/`;
  }
}

/** Instagram never accepts a binary upload — it fetches by URL, so a missing one is permanent. */
function requireUrl(media: MediaRef): string {
  if (!media.url) {
    throw new ProviderBadRequestError(
      `media ${media.mediaId} has no public url — instagram fetches media by url`,
    );
  }
  return media.url;
}
