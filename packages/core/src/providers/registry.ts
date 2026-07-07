import type { ProviderIdentifier } from '@meegrow-social/contracts';
import type { SocialProvider } from './types.js';
import { FakeProvider } from './fake.js';

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

// Scaffold default: the fake provider is always available.
registerProvider(new FakeProvider());
