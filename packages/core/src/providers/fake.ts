import type {
  AuthTokens,
  GenerateAuthUrl,
  MetricPoint,
  PostDetails,
  PostResult,
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

  async generateAuthUrl(redirectUri: string): Promise<GenerateAuthUrl> {
    return { url: `${redirectUri}?fake=1`, state: 'fake-state' };
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
