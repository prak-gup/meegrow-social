import { describe, expect, it } from 'vitest';
import {
  googleTestingExpiry,
  googleTestingHealth,
  testingConnectionState,
} from './google-oauth-testing.js';

const connected = new Date('2026-10-01T12:00:00Z');
const expiry = new Date('2026-10-08T12:00:00Z');
describe('Google OAuth testing consent expiry', () => {
  it.each(['youtube', 'gmb'])('derives seven-day expiry for %s only when enabled', (provider) => {
    expect(googleTestingExpiry({ provider, createdAt: connected }, true)).toEqual(expiry);
    expect(googleTestingExpiry({ provider, createdAt: connected }, false)).toBeNull();
  });
  it('leaves other providers alone', () => {
    expect(googleTestingExpiry({ provider: 'facebook', createdAt: connected }, true)).toBeNull();
  });
  it('is healthy until the last two days, including the exact boundary', () => {
    expect(googleTestingHealth(false, expiry, new Date('2026-10-06T11:59:59Z'))).toBe('healthy');
    expect(googleTestingHealth(false, expiry, new Date('2026-10-06T12:00:00Z'))).toBe('expiring');
  });
  it('requires reconnect at expiry and preserves a rejected credential', () => {
    expect(googleTestingHealth(false, expiry, expiry)).toBe('needs_reconnect');
    expect(googleTestingHealth(true, expiry, connected)).toBe('needs_reconnect');
  });
  it('defaults off and never changes stored expiry', () => {
    const connection = {
      provider: 'youtube',
      createdAt: connected,
      needsReconnect: false,
      tokenModel: 'auto-refresh' as const,
      expiresAt: null,
    };
    expect(testingConnectionState(connection, {})).toBeNull();
    expect(testingConnectionState(connection, { googleOAuthTesting: true })).toMatchObject({
      expiresAt: expiry,
      expiryReason: 'google_testing',
    });
    expect(connection.expiresAt).toBeNull();
  });
});
