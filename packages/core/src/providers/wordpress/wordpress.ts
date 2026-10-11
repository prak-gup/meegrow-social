import {
  ARTICLE_BODY_MAX,
  articleMarkdownToHtml,
  articleMarkdownToText,
  type MediaRef,
  type PostOptions,
} from '@meegrow-social/contracts';
import type {
  AuthTokens,
  GenerateAuthUrl,
  MetricPoint,
  PostDetails,
  PostResult,
  SocialProvider,
} from '../types.js';
import { ConnectError, ProviderAuthError, ProviderBadRequestError } from '../../errors.js';
import {
  decodeCredentials,
  encodeCredentials,
  plainText,
  sameSite,
  UPLOAD_TIMEOUT_MS,
  WordPressClient,
  type WordPressClientConfig,
  type WordPressCredentials,
  type WordPressSite,
} from './client.js';

/**
 * WordPress provider — blog articles on a self-hosted site (or any WordPress that exposes the core
 * REST API with Application Passwords). Research, sources and the live bring-up checklist:
 * docs/dev/research/wordpress.md. NOTHING here has run against a real site; the tests replay
 * fixtures built from WordPress's documented shapes.
 *
 * Connect — there is no central WordPress login, so the flow starts with the site's address:
 *   address → discovery (`WordPressClient.discover`) → the site's own authorize-application screen
 *   → the person approves while logged in to THEIR site → WordPress redirects back with a freshly
 *   generated application password. The operator never types a password into this app.
 *
 * Token model — `one-time`, no expiry: an application password lives until someone revokes it on
 * the site, and cannot be refreshed. A revoked one surfaces as a 401 → `ProviderAuthError` →
 * needs_reconnect, like a dead Facebook Page token. The "access token" this app stores is the
 * site's REST root + username + application password as one JSON string, which the connect service
 * encrypts like any other token; `externalId` is the site's public address.
 *
 * Post — `caption` is the article body in Markdown (converted and sanitised by
 * `articleMarkdownToHtml`), `options` (arm `wordpress`) carries the title and the rest, and the
 * first image in `media` becomes the featured image.
 */

type WordPressOptions = Extract<PostOptions, { kind: 'wordpress' }>;

/** What `generateAuthUrl` leaves on the flow row for `authenticate` (see `GenerateAuthUrl`). */
type FlowContext = Pick<WordPressSite, 'siteUrl' | 'home' | 'apiRoot' | 'name'>;

const UPLOADABLE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** WordPress limits on what the callback may carry; anything longer is not something it issued. */
const MAX_LOGIN_LENGTH = 60;
const MAX_PASSWORD_LENGTH = 128;

interface WordPressTerm {
  id?: unknown;
  name?: unknown;
}

interface WordPressPost {
  id?: unknown;
  link?: unknown;
  status?: unknown;
}

export class WordPressProvider implements SocialProvider {
  readonly identifier = 'wordpress' as const;
  readonly displayName = 'WordPress';
  readonly isBetweenSteps = false;
  readonly tokenModel = 'one-time' as const;
  /** One site is somebody's shared hosting: keep the pressure on it low. */
  readonly maxConcurrentJobs = 2;
  readonly connectInput = 'site_url' as const;
  readonly credentialInCallback = true;

  private readonly client: WordPressClient;

  constructor(config: WordPressClientConfig | WordPressClient = {}) {
    this.client = config instanceof WordPressClient ? config : new WordPressClient(config);
  }

  async generateAuthUrl(params: {
    redirectUri: string;
    state: string;
    siteUrl?: string;
  }): Promise<GenerateAuthUrl> {
    if (!params.siteUrl) {
      throw new ProviderBadRequestError('Enter the address of the WordPress site.');
    }
    const site = await this.client.discover(params.siteUrl);
    const context: FlowContext = {
      siteUrl: site.siteUrl,
      home: site.home,
      apiRoot: site.apiRoot,
      name: site.name,
    };
    return { url: this.client.authorizeUrl(site, params), codeVerifier: JSON.stringify(context) };
  }

  /**
   * The redirect back from authorize-application.php. Everything in `callback` is attacker-
   * reachable — it is a query string on a public URL — so:
   *  - the site it claims to come from must be the site this flow was STARTED for;
   *  - the credentials are then tried against the REST root recorded at the start, never against
   *    anything in the callback, and must belong to a user who can publish.
   * That the flow exists, is unused, unexpired, and is being finished in the browser that started
   * it is the connect service's job (`handleCallback`), done before this is called.
   */
  async authenticate(params: {
    code: string;
    codeVerifier?: string;
    redirectUri: string;
    callback?: Readonly<Record<string, string | undefined>>;
  }): Promise<AuthTokens> {
    const context = parseFlowContext(params.codeVerifier);
    const { site_url: siteUrl, user_login: username, password } = params.callback ?? {};
    if (
      !siteUrl ||
      !username ||
      !password ||
      username.length > MAX_LOGIN_LENGTH ||
      password.length > MAX_PASSWORD_LENGTH
    ) {
      throw new ConnectError('incomplete');
    }
    if (!sameSite(siteUrl, context.siteUrl)) throw new ConnectError('site_mismatch');

    const credentials: WordPressCredentials = {
      siteUrl: context.siteUrl,
      apiRoot: context.apiRoot,
      username,
      password,
    };
    await this.client.verifyUser(credentials);
    return {
      accessToken: encodeCredentials(credentials),
      externalId: context.home,
      displayName: context.name,
    };
  }

  /** Application passwords have no refresh; reaching here means a real reconnect is needed. */
  async refreshToken(): Promise<AuthTokens> {
    throw new ProviderAuthError(
      'WordPress application passwords cannot be refreshed — reconnect the site',
    );
  }

  assertPublishable(details: PostDetails[]): void {
    if (details.length !== 1) {
      throw new ProviderBadRequestError(
        `WordPress expects exactly one article, got ${details.length}`,
      );
    }
    const [detail] = details as [PostDetails];
    const options = wordpressOptions(detail.options);
    if (options.title.trim() === '') {
      throw new ProviderBadRequestError('A WordPress article needs a title');
    }
    if (detail.caption.length > ARTICLE_BODY_MAX) {
      throw new ProviderBadRequestError(
        `The article body is ${detail.caption.length} characters; the limit is ${ARTICLE_BODY_MAX}`,
      );
    }
    if (articleMarkdownToText(detail.caption) === '' && !/!\[/.test(detail.caption)) {
      throw new ProviderBadRequestError('A WordPress article needs a body');
    }
    if (detail.media.length > 1) {
      throw new ProviderBadRequestError(
        'A WordPress article takes one image at most — its featured image. Put other images in ' +
          'the body as ![description](https://…)',
      );
    }
    if (detail.media.some((m) => m.kind !== 'image')) {
      throw new ProviderBadRequestError(
        'The featured image of a WordPress article must be an image, not a video',
      );
    }
  }

  async post(tokens: AuthTokens, details: PostDetails[]): Promise<PostResult> {
    this.assertPublishable(details);
    const [detail] = details as [PostDetails];
    const options = wordpressOptions(detail.options);
    const credentials = decodeCredentials(tokens.accessToken);

    // Everything that can be refused is done BEFORE the article exists, so a failure here leaves
    // nothing half-published. The cost: a retry after a late failure re-uploads the image.
    const categories = await this.resolveCategories(credentials, options.categories ?? []);
    const tags = await this.resolveTags(credentials, options.tags ?? []);
    const featuredMedia = detail.media[0]
      ? await this.uploadFeaturedImage(credentials, detail.media[0], options.title)
      : undefined;

    const created = await this.client.request<WordPressPost>(credentials, '/wp/v2/posts', {
      method: 'POST',
      creates: 'The article',
      json: {
        title: options.title,
        content: articleMarkdownToHtml(detail.caption),
        status: options.status,
        ...(options.slug ? { slug: options.slug } : {}),
        ...(options.excerpt ? { excerpt: options.excerpt } : {}),
        ...(categories.length > 0 ? { categories } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        ...(featuredMedia !== undefined ? { featured_media: featuredMedia } : {}),
      },
    });
    if (typeof created.id !== 'number') {
      throw new ProviderBadRequestError(
        'WordPress accepted the article but did not say which one it is — check the site before ' +
          'retrying, so it is not published twice.',
      );
    }

    const status = typeof created.status === 'string' ? created.status : options.status;
    return {
      externalPostId: String(created.id),
      releaseUrl: permalink(created.link, tokens.externalId, created.id),
      ...(status === 'publish' ? {} : { notice: statusNotice(status, options.status) }),
    };
  }

  /**
   * WordPress core has no analytics API: there is nothing to read views or visitors from, and a
   * comment count is not a performance metric worth polling every site for. Returning nothing
   * keeps the analytics pages honest ("no data") rather than showing invented numbers. What it
   * would take later (Jetpack Stats, Site Kit) is in docs/dev/research/wordpress.md §9.
   */
  async postAnalytics(): Promise<MetricPoint[]> {
    return [];
  }

  async accountAnalytics(): Promise<MetricPoint[]> {
    return [];
  }

  /** Category names → ids. A name the site does not have is refused, never created. */
  private async resolveCategories(
    credentials: WordPressCredentials,
    wanted: ReadonlyArray<string | number>,
  ): Promise<number[]> {
    const ids: number[] = [];
    for (const term of wanted) {
      if (typeof term === 'number') {
        ids.push(term);
        continue;
      }
      const found = await this.findTerm(credentials, 'categories', term);
      if (found === null) {
        throw new ProviderBadRequestError(
          `The site has no category named "${term}". Create it in WordPress, or correct the name.`,
        );
      }
      ids.push(found);
    }
    return [...new Set(ids)];
  }

  /** Tag names → ids, creating the ones that do not exist yet (what WordPress's editor does). */
  private async resolveTags(
    credentials: WordPressCredentials,
    wanted: ReadonlyArray<string | number>,
  ): Promise<number[]> {
    const ids: number[] = [];
    for (const term of wanted) {
      if (typeof term === 'number') {
        ids.push(term);
        continue;
      }
      const found = await this.findTerm(credentials, 'tags', term);
      if (found !== null) {
        ids.push(found);
        continue;
      }
      const created = await this.client.tryRequest<WordPressTerm>(credentials, '/wp/v2/tags', {
        method: 'POST',
        json: { name: term },
      });
      if ('failure' in created) {
        // Lost a race with another writer, or the search missed it: WordPress names the existing id.
        const existing = created.failure.body?.data?.term_id;
        if (created.failure.code === 'term_exists' && typeof existing === 'number') {
          ids.push(existing);
          continue;
        }
        throw created.failure.error;
      }
      if (typeof created.data.id !== 'number') {
        throw new ProviderBadRequestError(`WordPress did not return an id for the tag "${term}"`);
      }
      ids.push(created.data.id);
    }
    return [...new Set(ids)];
  }

  private async findTerm(
    credentials: WordPressCredentials,
    taxonomy: 'categories' | 'tags',
    name: string,
  ): Promise<number | null> {
    const terms = await this.client.request<WordPressTerm[]>(credentials, `/wp/v2/${taxonomy}`, {
      query: { search: name, per_page: '100', _fields: 'id,name' },
    });
    if (!Array.isArray(terms)) return null;
    // `search` is a substring match; only an exact name (case aside) is the term that was meant.
    const wanted = name.trim().toLowerCase();
    const hit = terms.find((t) => plainText(t.name).toLowerCase() === wanted);
    return typeof hit?.id === 'number' ? hit.id : null;
  }

  private async uploadFeaturedImage(
    credentials: WordPressCredentials,
    media: MediaRef,
    title: string,
  ): Promise<number> {
    if (!media.url) {
      throw new ProviderBadRequestError(`media ${media.mediaId} has no stored url`);
    }
    const image = await this.client.download(media.url);
    const extension = UPLOADABLE[image.contentType];
    if (!extension) {
      throw new ProviderBadRequestError(
        `The featured image is ${image.contentType || 'of an unknown type'}; ` +
          'WordPress takes JPEG, PNG, GIF or WebP.',
      );
    }
    const uploaded = await this.client.request<{ id?: unknown }>(credentials, '/wp/v2/media', {
      method: 'POST',
      upload: {
        body: image.body,
        contentType: image.contentType,
        filename: `${fileStem(title)}.${extension}`,
      },
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
    if (typeof uploaded.id !== 'number') {
      throw new ProviderBadRequestError('WordPress did not return an id for the uploaded image');
    }
    return uploaded.id;
  }
}

function wordpressOptions(options: PostOptions | undefined): WordPressOptions {
  if (!options || options.kind !== 'wordpress') {
    throw new ProviderBadRequestError(
      'A WordPress article requires options (kind "wordpress") with a title',
    );
  }
  return options;
}

function parseFlowContext(stored: string | undefined): FlowContext {
  try {
    const parsed = JSON.parse(stored ?? '') as Partial<FlowContext>;
    if (
      typeof parsed.siteUrl === 'string' &&
      typeof parsed.home === 'string' &&
      typeof parsed.apiRoot === 'string' &&
      typeof parsed.name === 'string'
    ) {
      return {
        siteUrl: parsed.siteUrl,
        home: parsed.home,
        apiRoot: parsed.apiRoot,
        name: parsed.name,
      };
    }
  } catch {
    // Same answer as a context that parses but is incomplete.
  }
  throw new ConnectError('invalid_state');
}

/** A filename WordPress will keep as-is: the article's title, reduced to a slug. */
function fileStem(title: string): string {
  const stem = title
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return stem || 'featured-image';
}

/** The article's own URL as WordPress reports it; its `?p=` short form if that is unusable. */
function permalink(link: unknown, home: string, id: number): string {
  if (typeof link === 'string') {
    try {
      const url = new URL(link);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString();
    } catch {
      // Fall through to the short form.
    }
  }
  return `${home.replace(/\/+$/, '')}/?p=${id}`;
}

const STATUS_WORDS: Record<string, string> = {
  draft: 'a draft',
  pending: 'pending review',
  private: 'private',
  future: 'scheduled',
};

/** Said on the event log when "published" here does not mean "public on the site". */
function statusNotice(actual: string, asked: string): string {
  const state = STATUS_WORDS[actual] ?? `"${actual}"`;
  return actual === asked
    ? `Created on WordPress as ${state}, as asked — it is not public until someone publishes it there.`
    : `WordPress saved this as ${state} instead of "${asked}" — it is not public until someone ` +
        'publishes it there.';
}
