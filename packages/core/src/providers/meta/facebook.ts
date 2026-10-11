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
import type {
  PublishedPostItem,
  PublishedPostPage,
  PublishedPostPresence,
  PublishedPostQuery,
} from '../published-posts.js';
import {
  ProviderAuthError,
  ProviderBadRequestError,
  ProviderRateLimitError,
} from '../../errors.js';
import { cursorParams, MetaClient, nextPageCursor, type MetaClientConfig } from './client.js';

/**
 * Facebook Pages provider (issue #14). Publishes to a Page's feed/photos/videos and reads back
 * post insights + follower count. Shares MetaClient with the Instagram provider (#13).
 *
 * Token model — the important bit (RESEARCH meta.md §2.1):
 *   login → short-lived user token → 60-day long-lived user token → GET /me/accounts → **Page
 *   token**, which is effectively non-expiring. We connect the Page with the Page token and store
 *   NO expiry, so `computeHealth` reports 'healthy' forever and `expiresInDays` is null — the
 *   "non-expiring" state issue #14 asks for. The 60-day user token is discarded after the swap;
 *   Page tokens outlive it (they die only on password change, deauth, lost Page role, or Meta
 *   invalidation — all of which surface as auth errors → needs_reconnect).
 *
 * `tokenModel` is therefore 'one-time': a Page token cannot be refreshed, so the sweeper must never
 * try. (Its candidate filter excludes both non-refreshable models and null expiries, so this is
 * belt-and-braces.) A dead Page token means a real reconnect.
 */

/**
 * Per-post metrics, in the views-era names (issue #54; sources in RESEARCH meta.md §5.2.1).
 *
 * Meta retired the `post_impressions*` family for ALL API versions (unique variants June 2025, the
 * rest November 2025), and an unknown name errors the whole call rather than being omitted — so
 * these are requested one-by-one and failures are skipped (see postAnalytics). A name Meta retires
 * next degrades to "absent", never to "no metrics at all".
 *
 *   post_media_view               documented replacement for post_impressions        — NOT seen live
 *   post_total_media_view_unique  documented replacement for post_impressions_unique — NOT seen live
 *   post_reactions_like_total     documented, no deprecation notice                  — NOT seen live
 *   post_clicks, post_video_views returned by live Graph on 2026-07-16
 *
 * Only metrics whose value is a plain number belong here: postAnalytics drops object values
 * (`post_reactions_by_type_total`, `post_activity_by_action_type`), and splitting one into several
 * stored names would be a renaming map (spec invariant 7).
 * CONFIRM AFTER DEPLOY which of the three unseen names return rows, and re-record the fixtures.
 */
const POST_METRICS = [
  'post_media_view',
  'post_total_media_view_unique',
  'post_reactions_like_total',
  'post_clicks',
  'post_video_views',
] as const;

const PAGE_FIELDS = 'id,name,access_token';

/**
 * What an import reads of each Page post (RESEARCH meta.md §7.1). `attachments.target.id` is the
 * photo or video behind the story: `post()` returns that id, not the story's, for a video upload.
 */
const PUBLISHED_POST_FIELDS =
  'id,message,created_time,permalink_url,full_picture,status_type,is_published,' +
  'attachments{media_type,type,target{id},subattachments.limit(10){media_type,type,target{id}}}';
/** Meta refuses a `limit` above 100 on a Page's post edges. */
const MAX_PUBLISHED_POSTS_PAGE = 100;

interface GraphAttachment {
  media_type?: string;
  type?: string;
  target?: { id?: string };
  subattachments?: { data?: GraphAttachment[] };
}

interface GraphPagePost {
  id?: string;
  message?: string;
  created_time?: string;
  permalink_url?: string;
  full_picture?: string;
  status_type?: string;
  is_published?: boolean;
  attachments?: { data?: GraphAttachment[] };
}

const releaseUrlFor = (externalPostId: string): string =>
  `https://www.facebook.com/${externalPostId}`;

const isVideo = (a: GraphAttachment | undefined): boolean =>
  /video/.test(`${a?.media_type ?? ''} ${a?.type ?? ''}`);

/** One Graph Page post → the shape the importer stores. Null for an item that cannot be one. */
export function normalizePagePost(post: GraphPagePost): PublishedPostItem | null {
  const publishedAt = post.created_time ? new Date(post.created_time) : null;
  if (!post.id || !publishedAt || Number.isNaN(publishedAt.getTime())) return null;
  // A scheduled or ad-only post is not out yet; importing it would mark it published.
  if (post.is_published === false) return null;
  const first = post.attachments?.data?.[0];
  const children = first?.subattachments?.data ?? [];
  const lead = children[0] ?? first;
  const video = isVideo(lead) || (!lead && post.status_type === 'added_video');
  // `full_picture` is also the scraped image of a link post: still the right thumbnail.
  const hasMedia = video || Boolean(post.full_picture);
  const alternateIds = [first, ...children]
    .map((a) => a?.target?.id)
    .filter((id): id is string => typeof id === 'string' && id !== post.id);
  return {
    externalPostId: post.id,
    alternateIds: [...new Set(alternateIds)],
    // What `toResult` builds for a post this provider published.
    knownUrls: [post.id, ...alternateIds].map(releaseUrlFor),
    caption: post.message ?? '',
    publishedAt,
    permalink: post.permalink_url ?? null,
    mediaKind: hasMedia ? (video ? 'video' : 'image') : null,
    mediaCount: hasMedia ? Math.max(children.length, 1) : 0,
    thumbnailUrl: post.full_picture ?? null,
  };
}

interface PageAccount {
  id: string;
  name: string;
  access_token: string;
}

export class FacebookPagesProvider implements SocialProvider {
  readonly identifier = 'facebook' as const;
  readonly displayName = 'Facebook Page';
  readonly isBetweenSteps = true;
  readonly tokenModel = 'one-time' as const;
  readonly maxConcurrentJobs = 3;

  private readonly client: MetaClient;

  constructor(config: MetaClientConfig | MetaClient) {
    this.client = config instanceof MetaClient ? config : new MetaClient(config);
  }

  async generateAuthUrl(params: { redirectUri: string; state: string }): Promise<GenerateAuthUrl> {
    return { url: this.client.authDialogUrl(params) };
  }

  /**
   * Returns the long-lived *user* token. externalId/displayName stay 'pending' — this is a
   * two-phase provider, so the real identity arrives once the user picks a Page (finalizeAccount).
   */
  async authenticate(params: { code: string; redirectUri: string }): Promise<AuthTokens> {
    const { accessToken } = await this.client.exchangeCodeForLongLivedUserToken({
      code: params.code,
      redirectUri: params.redirectUri,
    });
    return { accessToken, externalId: 'pending', displayName: 'pending' };
  }

  async listAccounts(tokens: AuthTokens): Promise<ProviderAccount[]> {
    const pages = await this.fetchPages(tokens.accessToken);
    // Deliberately NOT returning access_token here: `oauth_flows.accounts` is plain JSON.
    return pages.map((p) => ({ externalId: p.id, displayName: p.name }));
  }

  /** Swap the 60-day user token for the chosen Page's non-expiring Page token. */
  async finalizeAccount(tokens: AuthTokens, account: ProviderAccount): Promise<AuthTokens> {
    const pages = await this.fetchPages(tokens.accessToken);
    const page = pages.find((p) => p.id === account.externalId);
    if (!page) {
      throw new ProviderAuthError(
        `page ${account.externalId} is no longer among the pages this user manages`,
      );
    }
    if (!page.access_token) {
      throw new ProviderAuthError(`no page access token returned for page ${account.externalId}`);
    }
    return {
      accessToken: page.access_token,
      // No expiresAt: Page tokens are non-expiring. This is what makes health read 'healthy'
      // indefinitely and keeps the row out of the refresh sweeper.
      externalId: page.id,
      displayName: page.name,
    };
  }

  /** Page tokens are not refreshable; reaching here means the connection genuinely needs re-auth. */
  async refreshToken(): Promise<AuthTokens> {
    throw new ProviderAuthError('facebook page tokens cannot be refreshed — reconnect required');
  }

  async post(tokens: AuthTokens, details: PostDetails[]): Promise<PostResult> {
    if (details.length !== 1) {
      // Facebook Pages have no thread concept; a multi-image post is one details entry with N media.
      throw new ProviderBadRequestError(
        `facebook expects exactly one post, got ${details.length} (threads are not supported)`,
      );
    }
    const [detail] = details as [PostDetails];
    const pageId = tokens.externalId;
    const images = detail.media.filter((m) => m.kind === 'image');
    const videos = detail.media.filter((m) => m.kind === 'video');

    if (videos.length > 1) {
      throw new ProviderBadRequestError('facebook supports at most one video per post');
    }
    if (videos.length === 1 && images.length > 0) {
      throw new ProviderBadRequestError('facebook cannot mix a video and images in one post');
    }

    if (videos.length === 1) return this.postVideo(tokens, pageId, detail.caption, videos[0]!);
    if (images.length === 1)
      return this.postSinglePhoto(tokens, pageId, detail.caption, images[0]!);
    if (images.length > 1) return this.postMultiPhoto(tokens, pageId, detail.caption, images);
    return this.postText(tokens, pageId, detail.caption);
  }

  /**
   * Per-post insights. Metrics are requested individually so one metric Meta has retired doesn't
   * nuke the whole response — Meta errors the entire call rather than omitting an unknown name
   * (RESEARCH meta.md §2.4). Names are stored exactly as Meta returns them.
   */
  async postAnalytics(tokens: AuthTokens, externalPostId: string): Promise<MetricPoint[]> {
    const capturedAt = new Date();
    const points: MetricPoint[] = [];

    for (const metric of POST_METRICS) {
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
        // A retired metric shouldn't fail the whole collection; auth errors must still surface so
        // the sweeper flags the connection needs_reconnect. A throttled call surfaces
        // too: swallowing it would record "swept, nothing to report" for a post that was never read.
        if (err instanceof ProviderAuthError || err instanceof ProviderRateLimitError) throw err;
      }
    }

    return points;
  }

  /**
   * Page-level metrics. Followers come from a **node field**, not an insight: `page_fans` is
   * deprecated (RESEARCH meta.md gotcha #6), so `GET /{page-id}?fields=followers_count` is the
   * supported route. Polled on its own (daily) cadence by the sweeper (#9).
   */
  async accountAnalytics(tokens: AuthTokens): Promise<MetricPoint[]> {
    const page = await this.client.graphGet<{ followers_count?: number }>(tokens.externalId, {
      fields: 'followers_count',
      access_token: tokens.accessToken,
    });
    return typeof page.followers_count === 'number'
      ? [{ metric: 'followers', value: page.followers_count, capturedAt: new Date() }]
      : [];
  }

  /**
   * The Page's own published posts, newest first (RESEARCH meta.md §7.1). `published_posts`, not
   * `feed`: the feed also returns visitors' posts and unpublished ones, and Meta documents it as
   * needing `pages_read_user_content`, which our login configuration does not ask for.
   *
   * Works with the stored Page token on the Page node — `me/accounts` is not needed (§2.4).
   */
  async listPublishedPosts(
    tokens: AuthTokens,
    query: PublishedPostQuery,
  ): Promise<PublishedPostPage> {
    const params: Record<string, string> = query.cursor
      ? cursorParams(query.cursor)
      : {
          fields: PUBLISHED_POST_FIELDS,
          limit: String(Math.min(query.limit, MAX_PUBLISHED_POSTS_PAGE)),
          since: String(Math.floor(query.since.getTime() / 1000)),
          ...(query.until ? { until: String(Math.ceil(query.until.getTime() / 1000)) } : {}),
        };
    const { data, usage } = await this.client.graphGetWithUsage<{
      data?: GraphPagePost[];
      paging?: { next?: string };
    }>(`${tokens.externalId}/published_posts`, { ...params, access_token: tokens.accessToken });
    return {
      items: (data.data ?? []).flatMap((p) => normalizePagePost(p) ?? []),
      nextCursor: nextPageCursor(data.paging?.next),
      usage,
    };
  }

  /**
   * `gone` only when Meta says the post does not exist AND the same token can still read the Page:
   * Meta gives the "does not exist" answer for a lost permission too, and a dead token must not
   * read as every post having been deleted.
   */
  async publishedPostPresence(
    tokens: AuthTokens,
    externalPostId: string,
  ): Promise<PublishedPostPresence> {
    const post = await this.client.nodePresence(externalPostId, tokens.accessToken);
    if (post !== 'missing') return post;
    const page = await this.client.nodePresence(tokens.externalId, tokens.accessToken);
    return page === 'present' ? 'gone' : 'unknown';
  }

  private async fetchPages(userAccessToken: string): Promise<PageAccount[]> {
    const res = await this.client.graphGet<{ data?: PageAccount[] }>('me/accounts', {
      fields: PAGE_FIELDS,
      access_token: userAccessToken,
    });
    if (res.data?.length) return res.data;
    // Nothing listed: a business-owned Page is not, without `business_management`. Fall back to the
    // Pages the person ticked (UNVERIFIED against Meta — see MetaClient.pagesFromGrantedScopes).
    return this.client.pagesFromGrantedScopes<PageAccount>(userAccessToken, PAGE_FIELDS);
  }

  private async postText(tokens: AuthTokens, pageId: string, caption: string): Promise<PostResult> {
    // A caption containing a URL renders as a link post automatically — FB scrapes OG tags from the
    // destination. Link previews aren't API-customisable (RESEARCH gotcha #9), so we send text only.
    const res = await this.client.graphPost<{ id: string }>(`${pageId}/feed`, {
      message: caption,
      access_token: tokens.accessToken,
    });
    return this.toResult(res.id);
  }

  private async postSinglePhoto(
    tokens: AuthTokens,
    pageId: string,
    caption: string,
    image: MediaRef,
  ): Promise<PostResult> {
    const res = await this.client.graphPost<{ id: string; post_id?: string }>(`${pageId}/photos`, {
      url: requireUrl(image),
      caption,
      access_token: tokens.accessToken,
    });
    // /photos returns the photo id; post_id is the feed story we want to link to.
    return this.toResult(res.post_id ?? res.id);
  }

  /** Album: stage each image unpublished, then attach them all to one feed story. */
  private async postMultiPhoto(
    tokens: AuthTokens,
    pageId: string,
    caption: string,
    images: MediaRef[],
  ): Promise<PostResult> {
    const mediaFbids: string[] = [];
    for (const image of images) {
      const staged = await this.client.graphPost<{ id: string }>(`${pageId}/photos`, {
        url: requireUrl(image),
        published: 'false',
        access_token: tokens.accessToken,
      });
      mediaFbids.push(staged.id);
    }
    const params: Record<string, string> = {
      message: caption,
      access_token: tokens.accessToken,
    };
    mediaFbids.forEach((id, i) => {
      params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id });
    });
    const res = await this.client.graphPost<{ id: string }>(`${pageId}/feed`, params);
    return this.toResult(res.id);
  }

  private async postVideo(
    tokens: AuthTokens,
    pageId: string,
    caption: string,
    video: MediaRef,
  ): Promise<PostResult> {
    // Meta pulls the file from our public URL — same "stage to a public URL" pattern Instagram
    // forces, kept uniform here on purpose (RESEARCH gotcha #1).
    const res = await this.client.graphPost<{ id: string; post_id?: string }>(`${pageId}/videos`, {
      file_url: requireUrl(video),
      description: caption,
      access_token: tokens.accessToken,
    });
    return this.toResult(res.post_id ?? res.id);
  }

  private toResult(externalPostId: string): PostResult {
    return { externalPostId, releaseUrl: releaseUrlFor(externalPostId) };
  }
}

/**
 * Media must carry a public URL by publish time — `resolveMediaRefs` populates it in the publish
 * service. A missing URL is a permanent failure, not something a retry fixes.
 */
function requireUrl(media: MediaRef): string {
  if (!media.url) {
    throw new ProviderBadRequestError(
      `media ${media.mediaId} has no public url — facebook fetches media by url`,
    );
  }
  return media.url;
}
