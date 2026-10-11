import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isTestOnlyProvider,
  listConnectableProviders,
  listProviders,
  providerVisible,
  registerConfiguredProviders,
  tryGetProvider,
} from './registry.js';

afterEach(() => vi.unstubAllEnvs());

describe('isTestOnlyProvider', () => {
  it('is true for every member of the fake family and false for real platforms', () => {
    for (const id of ['fake', 'fake_2step', 'fake_onetime', 'fake_transient_analytics']) {
      expect(isTestOnlyProvider(id)).toBe(true);
    }
    for (const id of ['facebook', 'instagram', 'gmb', 'linkedin-page', 'x']) {
      expect(isTestOnlyProvider(id)).toBe(false);
    }
  });
});

describe('providerVisible', () => {
  it('shows fakes outside production — dev and CI run on them', () => {
    vi.stubEnv('NODE_ENV', 'test');
    expect(providerVisible('fake')).toBe(true);
    vi.stubEnv('NODE_ENV', 'development');
    expect(providerVisible('fake_2step')).toBe(true);
  });

  it('hides fakes in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(providerVisible('fake')).toBe(false);
    expect(providerVisible('fake_fail_refresh')).toBe(false);
  });

  it('shows fakes in production only for the exact opt-in SHOW_FAKE_PROVIDERS=true', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SHOW_FAKE_PROVIDERS', 'true');
    expect(providerVisible('fake')).toBe(true);
    vi.stubEnv('SHOW_FAKE_PROVIDERS', '1');
    expect(providerVisible('fake')).toBe(false);
  });

  it('always shows a real platform', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(providerVisible('facebook')).toBe(true);
    expect(providerVisible('gmb')).toBe(true);
  });
});

describe('listConnectableProviders', () => {
  it('is the whole registry outside production', () => {
    vi.stubEnv('NODE_ENV', 'test');
    expect(listConnectableProviders()).toEqual(listProviders());
    expect(listConnectableProviders().some((p) => p.identifier === 'fake')).toBe(true);
  });

  it('drops the fakes in production but leaves them registered', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(listConnectableProviders().some((p) => isTestOnlyProvider(p.identifier))).toBe(false);
    // Still registered: a stored row naming a fake must keep resolving.
    expect(listProviders().some((p) => p.identifier === 'fake')).toBe(true);
  });
});

/**
 * Runs last: registration is additive, so these leave `gmb` / `youtube` in this file's registry.
 */
describe('registerConfiguredProviders — Google', () => {
  it('registers neither Google provider without the shared credentials', () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', '');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', '');
    vi.stubEnv('YOUTUBE_ENABLED', 'true');
    registerConfiguredProviders();
    expect(tryGetProvider('gmb')).toBeUndefined();
    expect(tryGetProvider('youtube')).toBeUndefined();
  });

  it('the credentials alone bring up GBP but not YouTube', () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'id.apps.googleusercontent.com');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'secret');
    vi.stubEnv('YOUTUBE_ENABLED', '');
    registerConfiguredProviders();
    expect(tryGetProvider('gmb')?.identifier).toBe('gmb');
    expect(tryGetProvider('youtube')).toBeUndefined();
  });

  it('YouTube needs the exact opt-in YOUTUBE_ENABLED=true on top of them', () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'id.apps.googleusercontent.com');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'secret');
    vi.stubEnv('YOUTUBE_ENABLED', '1');
    registerConfiguredProviders();
    expect(tryGetProvider('youtube')).toBeUndefined();

    vi.stubEnv('YOUTUBE_ENABLED', 'true');
    registerConfiguredProviders();
    expect(tryGetProvider('youtube')?.identifier).toBe('youtube');
    expect(listConnectableProviders().some((p) => p.identifier === 'youtube')).toBe(true);
  });
});

describe('registerConfiguredProviders — WordPress', () => {
  it('stays out of the registry unless WORDPRESS_ENABLED is exactly "true"', () => {
    for (const value of ['', '1', 'TRUE', 'yes', 'false']) {
      vi.stubEnv('WORDPRESS_ENABLED', value);
      registerConfiguredProviders();
      expect(tryGetProvider('wordpress')).toBeUndefined();
    }
    vi.stubEnv('WORDPRESS_ENABLED', 'true');
    registerConfiguredProviders();
    const wordpress = tryGetProvider('wordpress');
    expect(wordpress?.identifier).toBe('wordpress');
    // A real platform, not a test fixture: shown in production once it is switched on.
    expect(isTestOnlyProvider('wordpress')).toBe(false);
    vi.stubEnv('NODE_ENV', 'production');
    expect(listConnectableProviders().some((p) => p.identifier === 'wordpress')).toBe(true);
  });
});

describe('registerConfiguredProviders — platforms connected with a pasted credential', () => {
  it.each([
    ['BLUESKY_ENABLED', 'bluesky'],
    ['TELEGRAM_ENABLED', 'telegram'],
    ['DISCORD_ENABLED', 'discord'],
    ['SLACK_ENABLED', 'slack'],
  ] as const)('%s must be exactly "true" for %s to be offered', (flag, identifier) => {
    for (const value of ['', '1', 'TRUE', 'yes', 'false']) {
      vi.stubEnv(flag, value);
      registerConfiguredProviders();
      expect(tryGetProvider(identifier)).toBeUndefined();
    }
    vi.stubEnv(flag, 'true');
    registerConfiguredProviders();
    const provider = tryGetProvider(identifier);
    expect(provider?.identifier).toBe(identifier);
    // No OAuth: connected by a form, never by a redirect, and nothing to refresh.
    expect(provider?.connectInput).toBe('credentials');
    expect(provider?.connectWithCredentials).toBeTypeOf('function');
    expect(provider?.tokenModel).toBe('one-time');
    expect(isTestOnlyProvider(identifier)).toBe(false);
    vi.stubEnv('NODE_ENV', 'production');
    expect(listConnectableProviders().some((p) => p.identifier === identifier)).toBe(true);
  });
});
