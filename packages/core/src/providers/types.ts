import type {
  RemotePostFields,
  ConnectInputKind,
  ConnectMethod,
  SiteCheck,
  ProviderIdentifier,
  TokenModel,
  MediaRef,
  PostOptions,
} from '@meegrow-social/contracts';
import type {
  PublishedPostItem,
  PublishedPostPage,
  PublishedPostPresence,
  PublishedPostQuery,
} from './published-posts.js';

export interface AuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  externalId: string;
  displayName: string;
  /**
   * Non-secret facts about HOW the account was connected, stored in the clear on the connection
   * (`connections.meta`) so a list can show them without decrypting anything — WordPress records
   * `method` (`approval` | `password`) and the endpoint a login was verified at.
   */
  connectionMeta?: Record<string, string>;
}

/** What a site-address provider learned about an address before anyone logs in. */
export type SiteInspection = Omit<SiteCheck, 'ticket'>;

/** A username-and-password connect, bound to the endpoint the person was shown. */
export interface PasswordConnectParams {
  /** The address the login is sent to — from a sealed site check, never from the request body. */
  endpoint: string;
  username: string;
  password: string;
  /** What the site check established: the address as entered, and the public one if confirmed. */
  site: { entered: string; home: string | null; name: string | null };
}

export interface GenerateAuthUrl {
  url: string;
  /**
   * Whatever the provider needs back at the callback: a PKCE verifier, or (WordPress) which site
   * this flow was started for. Opaque to the connect service, which persists it on the flow row
   * and hands it to `authenticate` untouched.
   */
  codeVerifier?: string;
}

/** A selectable account for two-phase (isBetweenSteps) providers — a Page/Org/Channel/Location. */
export interface ProviderAccount {
  externalId: string;
  displayName: string;
}

/** One unit to publish. `post()` takes an array → native thread/carousel support (Postiz pattern). */
export interface PostDetails {
  caption: string;
  media: MediaRef[];
  /**
   * Per-platform options (#44) — YouTube title/privacy, GBP topic type + CTA, reel vs feed. Shape
   * is validated in contracts; the arm always matches this provider by the time it arrives here.
   * Undefined for providers that take no options.
   */
  options?: PostOptions;
}

export interface PostResult {
  /**
   * Absent only where the platform reports neither (a Slack incoming webhook answers `ok` and
   * nothing else). Such a post is stored without them: no link to show, nothing to poll.
   */
  externalPostId?: string;
  releaseUrl?: string;
  /**
   * Set when the post went out but not as asked — YouTube forcing an upload to private, a thumbnail
   * it refused. The post is still published (failing it would invite a retry that publishes twice);
   * the publish service records this on the event log so the difference is visible.
   */
  notice?: string;
}

export interface MetricPoint {
  metric: string;
  value: number;
  capturedAt: Date;
}

/**
 * The sealed provider contract. A new platform = implement this + register it. Nothing else in the
 * codebase changes. Derived from Postiz's IAuthenticator + ISocialMediaIntegration split.
 */
export interface SocialProvider {
  readonly identifier: ProviderIdentifier;
  readonly displayName: string;
  /** Two-phase OAuth: user picks a Page/Org/Channel/Location after redirect. */
  readonly isBetweenSteps: boolean;
  readonly tokenModel: TokenModel;
  readonly maxConcurrentJobs: number;
  /** Article inventories include old drafts and future site schedules outside social windows. */
  readonly importsWholeHistory?: boolean;
  /**
   * What must be asked BEFORE the person can be sent anywhere (see `generateAuthUrl`'s `siteUrl`).
   * Absent for OAuth platforms.
   */
  readonly connectInput?: ConnectInputKind;
  /**
   * True when the redirect back carries a long-lived credential itself rather than a one-time code
   * that only this server can exchange (WordPress hands over an application password in the query
   * string). The connect service then requires EVERY flow of this provider — dashboard ones too,
   * not just invites — to finish in the browser that started it.
   */
  readonly credentialInCallback?: boolean;
  /**
   * The ways this provider can be connected, when there is more than the one redirect. `password`
   * means `authenticateWithPassword` exists: the person types a login into THIS app, which is only
   * ever offered alongside `inspectSite` so they are shown where it will be sent first.
   */
  readonly connectMethods?: readonly ConnectMethod[];

  /**
   * The connect service supplies `state` (an opaque flow id); the provider embeds it in the URL.
   * `siteUrl` is the person's answer when `connectInput` is `site_url` — unvalidated user input.
   */
  generateAuthUrl(params: {
    redirectUri: string;
    state: string;
    siteUrl?: string;
  }): Promise<GenerateAuthUrl>;
  /**
   * `callback` is the redirect's whole query string, for providers that are not handed a `code`.
   * It is as trustworthy as any URL a stranger can type: validate everything in it.
   */
  authenticate(params: {
    code: string;
    codeVerifier?: string;
    redirectUri: string;
    callback?: Readonly<Record<string, string | undefined>>;
  }): Promise<AuthTokens>;
  /** Look at a site address without logging in (see `SiteInspection`). */
  inspectSite?(siteUrl: string): Promise<SiteInspection>;
  /**
   * Verify a typed username and password against the site and return what to store. Throws
   * `ConnectError` with a fixed code — never text from the site, never anything submitted.
   */
  authenticateWithPassword?(params: PasswordConnectParams): Promise<AuthTokens>;
  /**
   * Only meaningful when `isBetweenSteps`: after auth, list the Pages/Orgs/Channels/Locations the
   * user may connect. The user picks one, then the connect service finalizes the connection.
   */
  listAccounts?(tokens: AuthTokens): Promise<ProviderAccount[]>;
  /**
   * Only meaningful when `isBetweenSteps`: swap the user-level tokens for the ones the chosen
   * account should actually be connected with, once the user has picked. Facebook needs this — the
   * login yields a 60-day *user* token, but a Page must be stored with its own non-expiring *Page*
   * token (RESEARCH meta.md §2.1). Returning per-account tokens from `listAccounts` instead would
   * leak them into `oauth_flows.accounts`, which is plain JSON; this hook keeps them in the
   * encrypted path. Providers whose accounts all share the user token (LinkedIn org, YouTube
   * channel, GBP location) simply omit it.
   */
  finalizeAccount?(tokens: AuthTokens, account: ProviderAccount): Promise<AuthTokens>;
  /**
   * Only for `connectInput: 'credentials'`: the whole connect in one call. `fields` is what the
   * person typed into the form — unvalidated, and secret. Verify it against the platform and
   * return what to store; throw `CredentialFormatError` for input that was never sent anywhere,
   * `ProviderAuthError` for a credential the platform refused. Nothing thrown may contain a field.
   */
  connectWithCredentials?(fields: Readonly<Record<string, string>>): Promise<AuthTokens>;
  refreshToken(refreshToken: string): Promise<AuthTokens>;
  /**
   * Semantic validation of a post BEFORE it is stored (#44). Throws `ProviderBadRequestError` when
   * details can't publish on this platform — YouTube needs exactly one video, a GBP EVENT needs
   * event dates, a CALL button takes no url. Contracts validate the *shape* of options; only the
   * provider knows the platform's own rules, which is what keeps a new platform from having to edit
   * shared contract files.
   *
   * Called at create time deliberately: a scheduled post whose rules are only checked at publish
   * fails hours later inside the worker, after the client believes it is booked.
   *
   * Optional — a provider with no extra rules simply omits it.
   */
  assertPublishable?(details: PostDetails[]): void;
  /** Publish an array of details (thread/carousel) to one connected account. */
  post(tokens: AuthTokens, details: PostDetails[]): Promise<PostResult>;
  /** Per-post metrics for a previously published post. */
  postAnalytics(tokens: AuthTokens, externalPostId: string): Promise<MetricPoint[]>;
  /**
   * Account-level metrics for the connected account — follower count and any other whole-account
   * numbers (#9). Separate from `postAnalytics` because it's polled on its own cadence (daily) and
   * needs no post. Metric names stay provider-native and flexible: platforms rename them (Meta
   * retired `page_fans` for a `followers_count` node field), so never hardcode a canonical set.
   */
  accountAnalytics(tokens: AuthTokens): Promise<MetricPoint[]>;
  /**
   * One page of the posts already on the account, newest first — including ones this app never
   * published. Optional: a provider without it is simply never imported from.
   */
  listPublishedPosts?(tokens: AuthTokens, query: PublishedPostQuery): Promise<PublishedPostPage>;
  /** Read a single existing article, including the version required for remote edits. */
  readPublishedPost?(tokens: AuthTokens, id: string): Promise<PublishedPostItem>;
  /** Must check the observed version before writing and return an independent read-back. */
  updatePublishedPost?(
    tokens: AuthTokens,
    id: string,
    expectedModifiedAt: string,
    fields: RemotePostFields,
    bodyFormat: 'html' | 'markdown',
  ): Promise<PublishedPostItem>;
  /** Trash only, never force-delete. Must independently observe the trash status. */
  deletePublishedPost?(tokens: AuthTokens, id: string, expectedModifiedAt: string): Promise<void>;
  /** Whether the platform still has this post. Optional; without it nothing is marked removed. */
  publishedPostPresence?(
    tokens: AuthTokens,
    externalPostId: string,
  ): Promise<PublishedPostPresence>;
}
