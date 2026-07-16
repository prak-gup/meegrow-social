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
import { ProviderAuthError, ProviderBadRequestError } from '../../errors.js';
import { MetaClient, type MetaClientConfig } from './client.js';

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
 * Per-post metrics. Meta deprecated the `impressions` family across Nov 2025–Jun 2026 in favour of
 * views-era names, and querying a dead metric errors the whole call rather than omitting it — so
 * these are requested one-by-one and failures are skipped (see postAnalytics).
 * CONFIRM AT LIVE BRING-UP (the HITL half of #14) and re-record fixtures if Meta has moved again.
 */
const POST_METRICS = ['post_impressions_unique', 'post_video_views', 'post_clicks'] as const;

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
   * Per-post insights + the Page's follower count. Metrics are requested individually so one
   * deprecated name doesn't nuke the whole response (Meta errors rather than omitting).
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
        // A metric Meta has retired shouldn't fail the whole collection; auth errors must still
        // surface so the connection gets flagged.
        if (err instanceof ProviderAuthError) throw err;
      }
    }

    // Followers are a node field, not an insight — `page_fans` is deprecated (RESEARCH gotcha #6).
    try {
      const page = await this.client.graphGet<{ followers_count?: number }>(tokens.externalId, {
        fields: 'followers_count',
        access_token: tokens.accessToken,
      });
      if (typeof page.followers_count === 'number') {
        points.push({ metric: 'followers', value: page.followers_count, capturedAt });
      }
    } catch (err) {
      if (err instanceof ProviderAuthError) throw err;
    }

    return points;
  }

  private async fetchPages(userAccessToken: string): Promise<PageAccount[]> {
    const res = await this.client.graphGet<{ data?: PageAccount[] }>('me/accounts', {
      fields: 'id,name,access_token',
      access_token: userAccessToken,
    });
    return res.data ?? [];
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
    return {
      externalPostId,
      releaseUrl: `https://www.facebook.com/${externalPostId}`,
    };
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
