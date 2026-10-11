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
  PasswordConnectParams,
  PostDetails,
  PostResult,
  SiteInspection,
  SocialProvider,
} from '../types.js';
import { ConnectError, ProviderAuthError, ProviderBadRequestError } from '../../errors.js';
import { fileStem, permalink, statusNotice, uploadExtension } from './article.js';
import {
  decodeCredentials,
  encodeCredentials,
  plainText,
  sameSite,
  UPLOAD_TIMEOUT_MS,
  WordPressClient,
  type WordPressClientConfig,
  type WordPressRestCredentials,
  type WordPressSite,
} from './client.js';
import { WordPressXmlRpcClient, type XmlRpcEndpointState } from './xmlrpc-client.js';
import { postOverXmlRpc } from './xmlrpc-publisher.js';

/**
 * WordPress provider — blog articles on a self-hosted site (or any WordPress that exposes the core
 * REST API with Application Passwords). Research, sources and the live bring-up checklist:
 * docs/dev/research/wordpress.md. NOTHING here has run against a real site; the tests replay
 * fixtures built from WordPress's documented shapes.
 *
 * Connect — there is no central WordPress login, so the flow starts with the site's address. Two
 * ways on from there (`connectMethods`):
 *   approval — address → discovery (`WordPressClient.discover`) → the site's own
 *   authorize-application screen → the person approves while logged in to THEIR site → WordPress
 *   redirects back with a freshly generated application password. Nobody types a password here.
 *   password — for a site where application passwords are switched off: a WordPress username and
 *   login password, checked against the site's `xmlrpc.php` (`authenticateWithPassword`).
 *
 * Token model — `one-time`, no expiry: either kind of password lives until someone revokes or
 * changes it on the site, and cannot be refreshed. A dead one surfaces as `ProviderAuthError` →
 * needs_reconnect, like a dead Facebook Page token. The "access token" this app stores is the
 * transport, the address it was verified at, the username and the password as one JSON string,
 * which the connect service encrypts like any other token; `externalId` is the site's public
 * address. `post()` dispatches on the stored transport.
 *
 * Post — `caption` is the article body in Markdown (converted and sanitised by
 * `articleMarkdownToHtml`), `options` (arm `wordpress`) carries the title and the rest, and the
 * first image in `media` becomes the featured image.
 */

type WordPressOptions = Extract<PostOptions, { kind: 'wordpress' }>;

/** What `generateAuthUrl` leaves on the flow row for `authenticate` (see `GenerateAuthUrl`). */
type FlowContext = Pick<WordPressSite, 'siteUrl' | 'home' | 'apiRoot' | 'name'>;

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
  readonly connectMethods = ['approval', 'password'] as const;

  private readonly client: WordPressClient;
  private readonly xmlrpc: WordPressXmlRpcClient;

  constructor(config: WordPressClientConfig | WordPressClient = {}) {
    this.client = config instanceof WordPressClient ? config : new WordPressClient(config);
    // One way out for both transports: whatever the REST client fetches with, XML-RPC does too.
    this.xmlrpc = new WordPressXmlRpcClient({ fetchImpl: this.client.fetchImpl });
  }

  /**
   * What the Connect dialog shows after the address is typed: which of the two methods this site
   * can use, why not when it cannot, which addresses WordPress goes by, and the exact `xmlrpc.php`
   * a login would be sent to. Unauthenticated requests only.
   */
  async inspectSite(siteUrl: string): Promise<SiteInspection> {
    const inspection = await this.client.inspect(siteUrl);
    let endpoint: string | null = null;
    let state: XmlRpcEndpointState = 'not_found';
    const tried = new Set<string>();
    const tryEndpoint = async (candidate: string): Promise<boolean> => {
      if (tried.has(candidate)) return false;
      tried.add(candidate);
      const found = await this.xmlrpc.probe(candidate);
      if (found === 'available' || found === 'unknown') {
        endpoint = candidate;
        state = found;
        return true;
      }
      // Keep the most telling refusal: "switched off" says more than "nothing there".
      if (state === 'not_found') state = found;
      return false;
    };
    for (const candidate of inspection.xmlrpcCandidates) {
      if (await tryEndpoint(candidate)) break;
    }
    if (endpoint === null && inspection.siteUrl === null) {
      // The REST index could not say where WordPress lives; the page's own EditURI link can.
      const advertised = await this.client.editUriEndpoint(inspection.entered);
      if (advertised) await tryEndpoint(advertised);
    }
    return {
      entered: inspection.entered.replace(/\/+$/, ''),
      name: inspection.name,
      siteAddress: inspection.siteUrl,
      homeAddress: inspection.home,
      separateAddresses: inspection.split,
      approval: inspection.approve.available
        ? { available: true }
        : {
            available: false,
            reason: inspection.approve.reason,
            message: inspection.approve.message,
          },
      password:
        endpoint !== null
          ? { available: true, endpoint }
          : { available: false, reason: state, message: XMLRPC_UNAVAILABLE[state] },
    };
  }

  /**
   * Connect with a WordPress username and login password, over XML-RPC. `endpoint` is the
   * `xmlrpc.php` the person was shown by `inspectSite` — the connect service hands it back sealed,
   * so the password goes to that address and to no other. Verifies the login and that the user
   * can publish, then asks the logged-in site its own name and address.
   *
   * Throws `ConnectError` only: a fixed sentence, never WordPress's text or anything submitted.
   */
  async authenticateWithPassword(params: PasswordConnectParams): Promise<AuthTokens> {
    const { endpoint, username, password, site } = params;
    const login = { endpoint, username, password };
    await this.xmlrpc.verifyLogin(login);

    // Best effort: a site that hides wp.getOptions is still connected, under the address typed.
    const options = await this.xmlrpc
      .siteOptions(login)
      .catch(() => ({ title: '', homeUrl: null, siteUrl: null }));
    const endpointUrl = new URL(endpoint);
    const base = `${endpointUrl.origin}${endpointUrl.pathname.replace(/\/xmlrpc\.php$/, '')}`;
    // An address the site reports for itself is used only where it agrees with one already
    // confirmed: the endpoint that just accepted the login, or what the site check established.
    const known = [endpoint, site.entered, ...(site.home ? [site.home] : [])].map(hostOf);
    const reported = (address: string | null): string | null =>
      address !== null && known.includes(hostOf(address)) ? address.replace(/\/+$/, '') : null;
    const home = reported(options.homeUrl) ?? site.home ?? site.entered.replace(/\/+$/, '');
    const siteUrl =
      options.siteUrl !== null && hostOf(options.siteUrl) === endpointUrl.host
        ? options.siteUrl.replace(/\/+$/, '')
        : base;
    return {
      accessToken: encodeCredentials({
        transport: 'xmlrpc',
        siteUrl,
        endpoint,
        username,
        password,
      }),
      externalId: home,
      displayName: options.title || site.name || endpointUrl.host,
      connectionMeta: { method: 'password', endpoint },
    };
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

    const credentials: WordPressRestCredentials = {
      transport: 'rest',
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
      connectionMeta: { method: 'approval' },
    };
  }

  /** Neither kind of password has a refresh; reaching here means a real reconnect is needed. */
  async refreshToken(): Promise<AuthTokens> {
    throw new ProviderAuthError('WordPress passwords cannot be refreshed — reconnect the site');
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
    if (credentials.transport === 'xmlrpc') {
      return postOverXmlRpc(
        { xmlrpc: this.xmlrpc, images: this.client },
        credentials,
        detail,
        options,
        tokens.externalId,
      );
    }

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
    credentials: WordPressRestCredentials,
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
    credentials: WordPressRestCredentials,
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
    credentials: WordPressRestCredentials,
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
    credentials: WordPressRestCredentials,
    media: MediaRef,
    title: string,
  ): Promise<number> {
    if (!media.url) {
      throw new ProviderBadRequestError(`media ${media.mediaId} has no stored url`);
    }
    const image = await this.client.download(media.url);
    const extension = uploadExtension(image.contentType);
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

const XMLRPC_UNAVAILABLE: Record<XmlRpcEndpointState, string> = {
  available: '',
  unknown: '',
  disabled:
    'XML-RPC is switched off on this site — by WordPress, a security plugin or the host — so a ' +
    'username and password cannot be used.',
  blocked:
    'A firewall or security plugin on the site is blocking XML-RPC requests from this server.',
  not_found: 'No xmlrpc.php was found at this address.',
  unreachable: 'The site’s xmlrpc.php did not answer.',
};

/** The host of an address, or '' for one that does not parse (which then matches nothing). */
function hostOf(address: string): string {
  try {
    return new URL(address).host;
  } catch {
    return '';
  }
}
