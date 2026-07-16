import { z } from 'zod';
import { connectionHealth, providerIdentifier } from './providers.js';

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
