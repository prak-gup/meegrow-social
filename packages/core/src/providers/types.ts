import type { ProviderIdentifier, TokenModel, MediaRef } from '@meegrow-social/contracts';

export interface AuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  externalId: string;
  displayName: string;
}

export interface GenerateAuthUrl {
  url: string;
  /** Provider-generated PKCE verifier, persisted by the connect service for the callback. */
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
}

export interface PostResult {
  externalPostId: string;
  releaseUrl: string;
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

  /** The connect service supplies `state` (an opaque flow id); the provider embeds it in the URL. */
  generateAuthUrl(params: { redirectUri: string; state: string }): Promise<GenerateAuthUrl>;
  authenticate(params: {
    code: string;
    codeVerifier?: string;
    redirectUri: string;
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
