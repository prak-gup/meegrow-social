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
  state: string;
  codeVerifier?: string;
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

  generateAuthUrl(redirectUri: string): Promise<GenerateAuthUrl>;
  authenticate(params: {
    code: string;
    codeVerifier?: string;
    redirectUri: string;
  }): Promise<AuthTokens>;
  refreshToken(refreshToken: string): Promise<AuthTokens>;
  /** Publish an array of details (thread/carousel) to one connected account. */
  post(tokens: AuthTokens, details: PostDetails[]): Promise<PostResult>;
  /** Per-post metrics for a previously published post. */
  postAnalytics(tokens: AuthTokens, externalPostId: string): Promise<MetricPoint[]>;
}
