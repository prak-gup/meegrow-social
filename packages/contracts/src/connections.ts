import { z } from 'zod';
import { connectionHealth, providerIdentifier, tokenModel } from './providers.js';

export const connectionView = z.object({
  id: z.string().uuid(),
  provider: providerIdentifier,
  externalId: z.string(),
  displayName: z.string(),
  needsReconnect: z.boolean(),
  expiresAt: z.coerce.date().nullable(),
  /** Whole days until the token expires; null when the token has no expiry. Negative = expired. */
  expiresInDays: z.number().int().nullable(),
  health: connectionHealth,
  createdAt: z.coerce.date(),
});
export type ConnectionView = z.infer<typeof connectionView>;

/**
 * `connectionHealth` plus `expired`: the badge folds an expired token into `expiring`, but "will
 * lapse soon" and "has lapsed" call for different actions, so the health report tells them apart.
 */
export const connectionHealthStatus = z.enum(['healthy', 'expiring', 'expired', 'needs_reconnect']);
export type ConnectionHealthStatus = z.infer<typeof connectionHealthStatus>;

/**
 * Account health report (`GET /v1/connections/health`, MCP `connection_health`). Derived ONLY from
 * what is stored — `source` says so. The platform is not called, so a token revoked on the
 * platform's side still reads `healthy` here until a publish or a token refresh trips over it.
 */
export const connectionHealthView = z.object({
  connectionId: z.string().uuid(),
  provider: providerIdentifier,
  displayName: z.string(),
  status: connectionHealthStatus,
  /** One human-readable sentence: why the account has this status. */
  reason: z.string(),
  /** One human-readable sentence: what to do about it. */
  recommendedAction: z.string(),
  needsReconnect: z.boolean(),
  tokenModel,
  /** True when the token sweeper can renew this token without a human. */
  autoRefresh: z.boolean(),
  expiresAt: z.coerce.date().nullable(),
  expiresInDays: z.number().int().nullable(),
  /** Last time the analytics sweeper polled this account. Null = never. */
  lastAnalyticsAt: z.coerce.date().nullable(),
  /**
   * The most recently created post on this account that is currently `failed`, with its reason.
   * Informational: a post can fail for its own content, so this never changes `status`.
   */
  lastFailedPost: z
    .object({
      postId: z.string().uuid(),
      error: z.string().nullable(),
      publishAt: z.coerce.date().nullable(),
    })
    .nullable(),
  source: z.literal('stored'),
  checkedAt: z.coerce.date(),
});
export type ConnectionHealthView = z.infer<typeof connectionHealthView>;

export const providerAccount = z.object({
  externalId: z.string(),
  displayName: z.string(),
});
export type ProviderAccountView = z.infer<typeof providerAccount>;

/**
 * A provider that is actually registered in this environment, so the dashboard can offer a connect
 * button per platform instead of hardcoding one. Registration is env-gated (a real provider only
 * registers when its credentials are set), so this list is correct per-environment by construction:
 * fakes in dev/CI, real platforms in production.
 */
export const providerView = z.object({
  identifier: providerIdentifier,
  displayName: z.string(),
  /** True when the user must pick an account (Page/Org/Channel/Location) after authorizing. */
  isBetweenSteps: z.boolean(),
});
export type ProviderView = z.infer<typeof providerView>;

/** Result of the OAuth callback: either the connection is made, or the user must pick an account. */
export const callbackResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('connected'), connectionId: z.string().uuid() }),
  z.object({
    status: z.literal('choose_account'),
    flowId: z.string().uuid(),
    accounts: z.array(providerAccount),
  }),
]);
export type CallbackResult = z.infer<typeof callbackResult>;

export const finishConnectInput = z.object({
  flowId: z.string().uuid(),
  externalId: z.string(),
});
export type FinishConnectInput = z.infer<typeof finishConnectInput>;
