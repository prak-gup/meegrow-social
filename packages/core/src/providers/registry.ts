import type { ProviderIdentifier } from '@meegrow-social/contracts';
import type { SocialProvider } from './types.js';
import {
  FakeBetweenStepsProvider,
  FakeFailingAnalyticsProvider,
  FakeFailingRefreshProvider,
  FakeOneTimeProvider,
  FakeProvider,
  FakeTransientAnalyticsProvider,
  FakeTransientRefreshProvider,
} from './fake.js';
import { FacebookPagesProvider } from './meta/facebook.js';
import { InstagramProvider } from './meta/instagram.js';
import { GbpProvider } from './google/gbp.js';

/**
 * Explicit registry (Postiz pattern — no decorator auto-discovery). Real providers get added to
 * this array as they land (M1: instagram, facebook; M2: gmb; M3: linkedin, x, youtube).
 */
const providers = new Map<ProviderIdentifier, SocialProvider>();

export function registerProvider(provider: SocialProvider): void {
  providers.set(provider.identifier, provider);
}

export function getProvider(identifier: ProviderIdentifier): SocialProvider {
  const p = providers.get(identifier);
  if (!p) throw new Error(`No provider registered for "${identifier}"`);
  return p;
}

/**
 * Non-throwing lookup. Used by create-time validation (#44), which must not start rejecting posts
 * for providers that simply aren't configured in this environment — CI and local dev run with only
 * the fakes registered, and a missing platform secret must not change what the API accepts.
 */
export function tryGetProvider(identifier: ProviderIdentifier): SocialProvider | undefined {
  return providers.get(identifier);
}

export function listProviders(): SocialProvider[] {
  return [...providers.values()];
}

// Scaffold defaults: fake providers (single-step + two-step + #12 health fixtures) are always
// available for tests.
registerProvider(new FakeProvider());
registerProvider(new FakeBetweenStepsProvider());
registerProvider(new FakeOneTimeProvider());
registerProvider(new FakeFailingRefreshProvider());
registerProvider(new FakeTransientRefreshProvider());
registerProvider(new FakeFailingAnalyticsProvider());
registerProvider(new FakeTransientAnalyticsProvider());

/**
 * Register the real, env-configured providers. A provider whose credentials are absent is simply
 * skipped, so CI and local dev run on the fakes without any platform secrets — only the deployed
 * box has them (see .env.production.example). Exported and called here at module load to mirror the
 * fakes above; re-callable from tests.
 */
export function registerConfiguredProviders(): void {
  const appId = process.env.FACEBOOK_APP_ID;
  const appSecret = process.env.FACEBOOK_APP_SECRET;
  if (appId && appSecret) {
    // One Meta app, two providers (#14 + #13) — instagram-via-page authorises through the same
    // Facebook Login config, so it needs no credentials of its own.
    const config = { appId, appSecret, loginConfigId: process.env.FACEBOOK_LOGIN_CONFIG_ID };
    registerProvider(new FacebookPagesProvider(config));
    registerProvider(new InstagramProvider(config));
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (clientId && clientSecret) {
    // GBP (#21). Built against Google's documented shapes only — the API sits at 0 QPM until the
    // access request clears (BUILD-SPEC-V2 §A1) — so leaving these unset keeps `gmb` absent.
    registerProvider(new GbpProvider({ clientId, clientSecret }));
  }
}

registerConfiguredProviders();
