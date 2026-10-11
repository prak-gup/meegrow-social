import {
  BLUESKY_MAX_BYTES,
  BLUESKY_MAX_GRAPHEMES,
  blueskyFacets,
  findMentions,
  graphemeLength,
  utf8Length,
  type MediaRef,
} from '@meegrow-social/contracts';
import type {
  AuthTokens,
  GenerateAuthUrl,
  MetricPoint,
  PostDetails,
  PostResult,
  SocialProvider,
} from '../types.js';
import { ProviderAuthError, ProviderBadRequestError } from '../../errors.js';
import { downloadMedia, field, type ProviderFetch } from '../shared/http.js';
import {
  assertAppPassword,
  BlueskyClient,
  decodeBlueskyCredentials,
  encodeBlueskyCredentials,
  parseBlueskyIdentifier,
  type BlueskyClientConfig,
  type BlueskyCredentials,
} from './client.js';

/**
 * Bluesky provider — posts on an account's profile, over the AT Protocol. Research, sources, the
 * documented-versus-assumed split and the live bring-up checklist:
 * docs/dev/research/quick-platforms.md §1. NOTHING here has run against Bluesky; the tests replay
 * fixtures built from the published lexicons and guides.
 *
 * Connect — no OAuth and no redirect: the person makes an *app password* in Bluesky and pastes it
 * with their handle (`connectWithCredentials`). The handle is resolved to its DID and PDS, the
 * password is tried there once, and the connection is stored.
 *
 * Token model — `one-time`, no expiry: an app password lives until it is revoked in Bluesky, and a
 * revoked one surfaces as a 401 → `ProviderAuthError` → needs_reconnect. Why the app password is
 * kept rather than a refresh token is on `BlueskyClient.session`. `externalId` is the DID, which
 * survives a handle change; the display name is the handle.
 *
 * Post — one `app.bsky.feed.post` record: the caption as `text`, facets for every link, #tag and
 * resolvable @handle (the API links nothing by itself), and up to four images.
 */

const POST_COLLECTION = 'app.bsky.feed.post';
/** `app.bsky.embed.images`: at most 4, each a blob of at most 2,000,000 bytes. */
export const BLUESKY_MAX_IMAGES = 4;
export const BLUESKY_IMAGE_MAX_BYTES = 2_000_000;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
/** Handles looked up per post; any beyond stay plain text rather than add requests without end. */
const MAX_MENTIONS = 10;
/** `app.bsky.feed.getPosts` reports these per post. Stored under these exact names. */
const POST_COUNTS = ['likeCount', 'repostCount', 'replyCount', 'quoteCount', 'bookmarkCount'];

const NOT_OAUTH =
  'Bluesky is connected with a handle and an app password, entered in the dashboard.';

interface BlobRef {
  $type?: unknown;
  ref?: unknown;
  mimeType?: unknown;
  size?: unknown;
}

export class BlueskyProvider implements SocialProvider {
  readonly identifier = 'bluesky' as const;
  readonly displayName = 'Bluesky';
  readonly isBetweenSteps = false;
  readonly tokenModel = 'one-time' as const;
  readonly maxConcurrentJobs = 3;
  readonly connectInput = 'credentials' as const;

  private readonly client: BlueskyClient;
  private readonly fetchMedia: ProviderFetch | undefined;

  constructor(config: BlueskyClientConfig = {}) {
    this.client = new BlueskyClient(config);
    this.fetchMedia = config.fetchImpl;
  }

  async generateAuthUrl(): Promise<GenerateAuthUrl> {
    throw new ProviderBadRequestError(NOT_OAUTH);
  }

  async authenticate(): Promise<AuthTokens> {
    throw new ProviderBadRequestError(NOT_OAUTH);
  }

  /**
   * `fields.handle` + `fields.appPassword`. Both are shape-checked before anything is contacted;
   * then the handle is resolved and the password tried ONCE, at the PDS the account's own DID
   * document names — never at an address taken from the form.
   */
  async connectWithCredentials(fields: Readonly<Record<string, string>>): Promise<AuthTokens> {
    const identifier = parseBlueskyIdentifier(field(fields, 'handle'));
    const appPassword = assertAppPassword(field(fields, 'appPassword'));
    const identity = await this.client.identify(identifier);
    let session: Awaited<ReturnType<BlueskyClient['createSession']>>;
    try {
      session = await this.client.createSession({ ...identity, appPassword });
    } catch (err) {
      if (err instanceof ProviderAuthError && /saved app password/.test(err.message)) {
        throw new ProviderAuthError(
          'Bluesky did not accept that handle and app password. Check both — an app password ' +
            'that was deleted in Bluesky no longer works.',
        );
      }
      throw err;
    }
    const handle = session.handle.includes('.') ? session.handle : identity.handle;
    return {
      accessToken: encodeBlueskyCredentials({
        did: identity.did,
        handle,
        pds: identity.pds,
        appPassword,
      }),
      externalId: identity.did,
      displayName: `@${handle}`,
    };
  }

  /** There is nothing to refresh; reaching here means a real reconnect is needed. */
  async refreshToken(): Promise<AuthTokens> {
    throw new ProviderAuthError(
      'A Bluesky app password cannot be refreshed — reconnect the account',
    );
  }

  assertPublishable(details: PostDetails[]): void {
    if (details.length !== 1) {
      throw new ProviderBadRequestError(`Bluesky expects exactly one post, got ${details.length}`);
    }
    const [detail] = details as [PostDetails];
    const graphemes = graphemeLength(detail.caption);
    if (graphemes > BLUESKY_MAX_GRAPHEMES) {
      throw new ProviderBadRequestError(
        `The text is ${graphemes} characters; Bluesky takes at most ${BLUESKY_MAX_GRAPHEMES}`,
      );
    }
    if (utf8Length(detail.caption) > BLUESKY_MAX_BYTES) {
      throw new ProviderBadRequestError(
        `The text is too large for Bluesky (over ${BLUESKY_MAX_BYTES} bytes) — long emoji ` +
          'sequences are the usual cause',
      );
    }
    if (detail.media.some((m) => m.kind !== 'image')) {
      throw new ProviderBadRequestError(
        'Video is not posted to Bluesky from here yet — attach images only',
      );
    }
    if (detail.media.length > BLUESKY_MAX_IMAGES) {
      throw new ProviderBadRequestError(
        `Bluesky takes at most ${BLUESKY_MAX_IMAGES} images per post, got ${detail.media.length}`,
      );
    }
    if (detail.caption.trim() === '' && detail.media.length === 0) {
      throw new ProviderBadRequestError('A Bluesky post needs text or an image');
    }
  }

  async post(tokens: AuthTokens, details: PostDetails[]): Promise<PostResult> {
    this.assertPublishable(details);
    const [detail] = details as [PostDetails];
    const credentials = decodeBlueskyCredentials(tokens.accessToken);

    // Everything that can be refused or retried is done BEFORE the record exists: handles are
    // looked up and images uploaded first. An uploaded blob nothing refers to is dropped by the
    // PDS after a few minutes, so a retry after a late failure costs a re-upload and nothing else.
    const mentions = await this.resolveMentions(detail.caption);
    const images: Array<{ alt: string; image: BlobRef }> = [];
    for (const media of detail.media) {
      images.push({ alt: '', image: await this.uploadImage(credentials, media) });
    }

    const facets = blueskyFacets(detail.caption, mentions);
    const { data: created, session } = await this.client.authed<{ uri?: unknown }>(
      credentials,
      'com.atproto.repo.createRecord',
      {
        posts: 'the Bluesky profile',
        json: {
          repo: credentials.did,
          collection: POST_COLLECTION,
          record: {
            $type: POST_COLLECTION,
            text: detail.caption,
            createdAt: new Date().toISOString(),
            ...(facets.length > 0 ? { facets } : {}),
            ...(images.length > 0 ? { embed: { $type: 'app.bsky.embed.images', images } } : {}),
          },
        },
      },
    );
    const rkey = recordKey(created.uri, credentials.did);
    if (!rkey) {
      throw new ProviderBadRequestError(
        'Bluesky accepted the post but did not say which one it is — check the profile before ' +
          'retrying, so it is not posted twice.',
      );
    }
    // The handle as Bluesky has it now (the session's); the DID also works in this URL.
    const { handle } = session;
    return {
      externalPostId: created.uri as string,
      releaseUrl: `https://bsky.app/profile/${handle.includes('.') ? handle : credentials.did}/post/${rkey}`,
    };
  }

  /**
   * Public counts, read without credentials from Bluesky's AppView — so a revoked app password
   * never stops a published post's numbers, and no login is spent on reading them. Names are
   * Bluesky's own (`likeCount`, `repostCount`, `replyCount`, `quoteCount`, `bookmarkCount`).
   * A post that is gone, or was never indexed, simply has no numbers.
   */
  async postAnalytics(_tokens: AuthTokens, externalPostId: string): Promise<MetricPoint[]> {
    if (!/^at:\/\/did:[a-z]+:[^/\s]+\/app\.bsky\.feed\.post\/[^/\s]+$/.test(externalPostId)) {
      return [];
    }
    const data = await this.client.publicRead<{ posts?: unknown }>('app.bsky.feed.getPosts', {
      uris: externalPostId,
    });
    const post = Array.isArray(data.posts)
      ? (data.posts as Array<Record<string, unknown>>).find((p) => p?.uri === externalPostId)
      : undefined;
    if (!post) return [];
    const capturedAt = new Date();
    return POST_COUNTS.flatMap((metric) => {
      const value = post[metric];
      return typeof value === 'number' && Number.isFinite(value)
        ? [{ metric, value, capturedAt }]
        : [];
    });
  }

  /**
   * `followers` is this app's one cross-platform account metric (the follower trend reads it);
   * `followsCount` and `postsCount` are Bluesky's own names, kept as they are.
   */
  async accountAnalytics(tokens: AuthTokens): Promise<MetricPoint[]> {
    const result = await this.client.tryPublicRead<Record<string, unknown>>(
      'app.bsky.actor.getProfile',
      { actor: tokens.externalId },
    );
    if ('failure' in result) {
      // The public profile of an account that opted out of logged-out views, or was removed: no
      // numbers, and not a reason to mark the connection broken.
      if (result.failure.status === 400 || result.failure.status === 404) return [];
      throw result.failure.error;
    }
    const capturedAt = new Date();
    const points: MetricPoint[] = [];
    const add = (metric: string, value: unknown): void => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        points.push({ metric, value, capturedAt });
      }
    };
    add('followers', result.data.followersCount);
    add('followsCount', result.data.followsCount);
    add('postsCount', result.data.postsCount);
    return points;
  }

  /**
   * `@handle` → DID for each handle in the caption, through the public AppView. One that does not
   * resolve (or cannot be looked up right now) stays plain text — the post still goes out.
   */
  private async resolveMentions(caption: string): Promise<Map<string, string>> {
    const dids = new Map<string, string>();
    const handles = [...new Set(findMentions(caption).map((m) => m.handle))].slice(0, MAX_MENTIONS);
    for (const handle of handles) {
      try {
        const result = await this.client.tryPublicRead<{ did?: unknown }>(
          'com.atproto.identity.resolveHandle',
          { handle },
        );
        if (!('failure' in result) && typeof result.data.did === 'string') {
          dids.set(handle, result.data.did);
        }
      } catch {
        // Left as text.
      }
    }
    return dids;
  }

  private async uploadImage(credentials: BlueskyCredentials, media: MediaRef): Promise<BlobRef> {
    const image = await downloadMedia(
      media,
      { maxBytes: BLUESKY_IMAGE_MAX_BYTES, platform: 'Bluesky' },
      this.fetchMedia,
    );
    if (!IMAGE_TYPES.has(image.contentType)) {
      throw new ProviderBadRequestError(
        `The image is ${image.contentType || 'of an unknown type'}; ` +
          'Bluesky takes JPEG, PNG, WebP or GIF.',
      );
    }
    const { data: uploaded } = await this.client.authed<{ blob?: BlobRef }>(
      credentials,
      'com.atproto.repo.uploadBlob',
      { upload: { body: image.body, contentType: image.contentType } },
    );
    if (!uploaded.blob || typeof uploaded.blob !== 'object' || !uploaded.blob.ref) {
      throw new ProviderBadRequestError(
        'Bluesky did not return a reference for the uploaded image',
      );
    }
    return uploaded.blob;
  }
}

/** The record key of `at://<did>/app.bsky.feed.post/<rkey>`, when it is this account's post. */
function recordKey(uri: unknown, did: string): string | null {
  if (typeof uri !== 'string') return null;
  const match = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9._:~-]{1,512})$/.exec(uri);
  return match && match[1] === did ? match[2]! : null;
}
