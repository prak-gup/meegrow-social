import type {
  AuthTokens,
  GenerateAuthUrl,
  MetricPoint,
  PostDetails,
  PostResult,
  ProviderAccount,
  SocialProvider,
} from './types.js';
import { ProviderAuthError } from '../errors.js';

/**
 * Test/scaffold provider. Publishes to nowhere, deterministically. The tracer bullet and all
 * integration tests use this so CI never touches a real platform. Real providers (M1+) implement
 * the same interface.
 */
export class FakeProvider implements SocialProvider {
  readonly identifier = 'fake' as const;
  readonly displayName = 'Fake Provider';
  readonly isBetweenSteps = false;
  readonly tokenModel = 'auto-refresh' as const;
  readonly maxConcurrentJobs = 5;

  async generateAuthUrl({
    redirectUri,
    state,
  }: {
    redirectUri: string;
    state: string;
  }): Promise<GenerateAuthUrl> {
    return { url: `${redirectUri}?fake=1&state=${state}` };
  }

  async authenticate(): Promise<AuthTokens> {
    return { accessToken: 'fake-token', externalId: 'fake-account', displayName: 'Fake Account' };
  }

  async refreshToken(): Promise<AuthTokens> {
    return {
      accessToken: 'fake-token-refreshed',
      refreshToken: 'fake-refresh',
      // 8 days out — beyond the 7d refresh window, so a second sweep won't re-refresh (idempotency).
      expiresAt: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000),
      externalId: 'fake-account',
      displayName: 'Fake Account',
    };
  }

  async post(_tokens: AuthTokens, details: PostDetails[]): Promise<PostResult> {
    const id = `fake_${Buffer.from(details.map((d) => d.caption).join('|'))
      .toString('hex')
      .slice(0, 12)}`;
    return { externalPostId: id, releaseUrl: `https://fake.local/p/${id}` };
  }

  async postAnalytics(): Promise<MetricPoint[]> {
    return [{ metric: 'views', value: 0, capturedAt: new Date(0) }];
  }
}

/**
 * Two-phase (isBetweenSteps) test provider: after auth the user must pick one of several accounts,
 * mirroring FB Page / LinkedIn Org / YouTube Channel / GBP Location selection. Test-only.
 */
export class FakeBetweenStepsProvider implements SocialProvider {
  readonly identifier = 'fake_2step' as const;
  readonly displayName = 'Fake Two-Step Provider';
  readonly isBetweenSteps = true;
  readonly tokenModel = 'refresh-cron' as const;
  readonly maxConcurrentJobs = 3;

  async generateAuthUrl({
    redirectUri,
    state,
  }: {
    redirectUri: string;
    state: string;
  }): Promise<GenerateAuthUrl> {
    return { url: `${redirectUri}?fake2=1&state=${state}`, codeVerifier: 'fake-verifier' };
  }

  async authenticate(): Promise<AuthTokens> {
    // externalId/displayName are placeholders until the user picks an account.
    return { accessToken: 'fake2-token', externalId: 'pending', displayName: 'pending' };
  }

  async listAccounts(): Promise<ProviderAccount[]> {
    return [
      { externalId: 'page-1', displayName: 'Page One' },
      { externalId: 'page-2', displayName: 'Page Two' },
    ];
  }

  async refreshToken(): Promise<AuthTokens> {
    return { accessToken: 'fake2-token-refreshed', externalId: 'x', displayName: 'x' };
  }

  async post(): Promise<PostResult> {
    return { externalPostId: 'fake2', releaseUrl: 'https://fake2.local/p/1' };
  }

  async postAnalytics(): Promise<MetricPoint[]> {
    return [{ metric: 'views', value: 0, capturedAt: new Date(0) }];
  }
}

/**
 * One-time-token test provider (issue #12): tokens can't be refreshed — the sweeper must NEVER
 * refresh these, only surface them as 'expiring' (T-14d) for manual re-auth.
 */
export class FakeOneTimeProvider implements SocialProvider {
  readonly identifier = 'fake_onetime' as const;
  readonly displayName = 'Fake One-Time Provider';
  readonly isBetweenSteps = false;
  readonly tokenModel = 'one-time' as const;
  readonly maxConcurrentJobs = 1;

  async generateAuthUrl({
    redirectUri,
    state,
  }: {
    redirectUri: string;
    state: string;
  }): Promise<GenerateAuthUrl> {
    return { url: `${redirectUri}?fake_onetime=1&state=${state}` };
  }

  async authenticate(): Promise<AuthTokens> {
    return { accessToken: 'fake-onetime-token', externalId: 'onetime-1', displayName: 'One-Time' };
  }

  // One-time tokens are never refreshed; if ever called, treat as auth failure.
  async refreshToken(): Promise<AuthTokens> {
    throw new ProviderAuthError('one-time tokens cannot be refreshed');
  }

  async post(): Promise<PostResult> {
    return { externalPostId: 'fake_onetime', releaseUrl: 'https://fake-onetime.local/p/1' };
  }

  async postAnalytics(): Promise<MetricPoint[]> {
    return [{ metric: 'views', value: 0, capturedAt: new Date(0) }];
  }
}

/**
 * Refreshable test provider whose refresh always fails with ProviderAuthError (issue #12 failure
 * path): the sweeper must mark the connection needs_reconnect + emit connection.needs_reconnect.
 */
export class FakeFailingRefreshProvider implements SocialProvider {
  readonly identifier = 'fake_fail_refresh' as const;
  readonly displayName = 'Fake Failing-Refresh Provider';
  readonly isBetweenSteps = false;
  readonly tokenModel = 'auto-refresh' as const;
  readonly maxConcurrentJobs = 1;

  async generateAuthUrl({
    redirectUri,
    state,
  }: {
    redirectUri: string;
    state: string;
  }): Promise<GenerateAuthUrl> {
    return { url: `${redirectUri}?fake_fail=1&state=${state}` };
  }

  async authenticate(): Promise<AuthTokens> {
    return { accessToken: 'fake-fail-token', externalId: 'fail-1', displayName: 'Failing' };
  }

  async refreshToken(): Promise<AuthTokens> {
    throw new ProviderAuthError('refresh denied (fake)');
  }

  async post(): Promise<PostResult> {
    return { externalPostId: 'fake_fail', releaseUrl: 'https://fake-fail.local/p/1' };
  }

  async postAnalytics(): Promise<MetricPoint[]> {
    return [{ metric: 'views', value: 0, capturedAt: new Date(0) }];
  }
}

/**
 * Refreshable test provider whose refresh fails with a NON-auth (transient) error (issue #12): the
 * sweeper must log it and leave the connection alone — NOT flag needs_reconnect — so the next sweep
 * retries. Locks the catch-order invariant.
 */
export class FakeTransientRefreshProvider implements SocialProvider {
  readonly identifier = 'fake_transient_refresh' as const;
  readonly displayName = 'Fake Transient-Refresh Provider';
  readonly isBetweenSteps = false;
  readonly tokenModel = 'auto-refresh' as const;
  readonly maxConcurrentJobs = 1;

  async generateAuthUrl({
    redirectUri,
    state,
  }: {
    redirectUri: string;
    state: string;
  }): Promise<GenerateAuthUrl> {
    return { url: `${redirectUri}?fake_transient=1&state=${state}` };
  }

  async authenticate(): Promise<AuthTokens> {
    return {
      accessToken: 'fake-transient-token',
      externalId: 'transient-1',
      displayName: 'Transient',
    };
  }

  async refreshToken(): Promise<AuthTokens> {
    throw new Error('upstream timeout (fake transient)');
  }

  async post(): Promise<PostResult> {
    return { externalPostId: 'fake_transient', releaseUrl: 'https://fake-transient.local/p/1' };
  }

  async postAnalytics(): Promise<MetricPoint[]> {
    return [{ metric: 'views', value: 0, capturedAt: new Date(0) }];
  }
}
