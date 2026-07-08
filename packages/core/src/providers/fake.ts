import type {
  AuthTokens,
  GenerateAuthUrl,
  MetricPoint,
  PostDetails,
  PostResult,
  ProviderAccount,
  SocialProvider,
} from './types.js';

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
