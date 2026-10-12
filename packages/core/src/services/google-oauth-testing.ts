import type { ConnectionHealth, TokenModel } from '@meegrow-social/contracts';

const DAY = 86_400_000;

/** Expected consent expiry, independent of refreshable access-token expiry. No platform calls. */
export function googleTestingExpiry(
  connection: { provider: string; createdAt: Date },
  enabled: boolean,
): Date | null {
  return enabled && ['youtube', 'gmb'].includes(connection.provider)
    ? new Date(connection.createdAt.getTime() + 7 * DAY)
    : null;
}

export function googleTestingHealth(
  needsReconnect: boolean,
  expectedExpiry: Date,
  now = new Date(),
): ConnectionHealth {
  if (needsReconnect || expectedExpiry.getTime() <= now.getTime()) return 'needs_reconnect';
  return expectedExpiry.getTime() - now.getTime() <= 2 * DAY ? 'expiring' : 'healthy';
}

export interface ConnectionExpiryOptions {
  googleOAuthTesting?: boolean;
}

export function testingConnectionState(
  connection: {
    provider: string;
    createdAt: Date;
    needsReconnect: boolean;
    tokenModel: TokenModel;
    expiresAt: Date | null;
  },
  options: ConnectionExpiryOptions,
) {
  const expectedExpiry = googleTestingExpiry(connection, options.googleOAuthTesting ?? false);
  if (!expectedExpiry) return null;
  const health = googleTestingHealth(connection.needsReconnect, expectedExpiry);
  return {
    expiresAt: expectedExpiry,
    expiresInDays: Math.floor((expectedExpiry.getTime() - Date.now()) / DAY),
    health,
    expiryReason: 'google_testing' as const,
  };
}
