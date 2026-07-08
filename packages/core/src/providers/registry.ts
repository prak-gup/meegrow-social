import type { ProviderIdentifier } from '@meegrow-social/contracts';
import type { SocialProvider } from './types.js';
import {
  FakeBetweenStepsProvider,
  FakeFailingRefreshProvider,
  FakeOneTimeProvider,
  FakeProvider,
  FakeTransientRefreshProvider,
} from './fake.js';

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
