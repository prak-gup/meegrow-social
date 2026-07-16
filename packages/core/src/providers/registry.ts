import type { ProviderIdentifier } from '@meegrow-social/contracts';
import type { SocialProvider } from './types.js';
import {
  FakeBetweenStepsProvider,
  FakeFailingRefreshProvider,
  FakeOneTimeProvider,
  FakeProvider,
  FakeTransientRefreshProvider,
} from './fake.js';
import { FacebookPagesProvider } from './meta/facebook.js';

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
    registerProvider(
      new FacebookPagesProvider({
        appId,
        appSecret,
        loginConfigId: process.env.FACEBOOK_LOGIN_CONFIG_ID,
      }),
    );
  }
}

registerConfiguredProviders();
