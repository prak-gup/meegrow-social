import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isTestOnlyProvider,
  listConnectableProviders,
  listProviders,
  providerVisible,
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
