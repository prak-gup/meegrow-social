import type {
  ConnectInputKind,
  ProviderIdentifier,
  TokenModel,
  MediaRef,
  PostOptions,
} from '@meegrow-social/contracts';

export interface AuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  externalId: string;
  displayName: string;
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
  externalPostId: string;
  releaseUrl: string;
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
}
