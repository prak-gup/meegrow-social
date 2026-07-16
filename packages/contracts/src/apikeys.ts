import { z } from 'zod';

/**
 * API-key management (issue #8, PRD F6.3). Per-client API keys are how this product is actually
 * driven day to day (RESEARCH: the antidote bot calls Zernio with one key per client), so this
 * surface is closer to the core than the dashboard is.
 */

/**
 * A key as it can safely be shown. Deliberately has no `secret` and no `hash` field — the secret
 * exists only in the create response, and the hash must never leave the database.
 */
export const apiKeyView = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /** Display-only fragment, e.g. `sk_live_abc123…`. Not enough to authenticate with. */
  prefix: z.string(),
  lastUsedAt: z.coerce.date().nullable(),
  expiresAt: z.coerce.date().nullable(),
  revokedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
});
export type ApiKeyView = z.infer<typeof apiKeyView>;

export const createApiKeyInput = z.object({
  name: z.string().min(1).max(100),
});
export type CreateApiKeyInput = z.infer<typeof createApiKeyInput>;

/**
 * The create response — the ONLY time the full secret is ever returned. It is not stored (only its
 * sha-256 is), so it is unrecoverable afterwards: a lost key must be revoked and reissued.
 */
export const createdApiKeyView = z.object({
  id: z.string().uuid(),
  name: z.string(),
  prefix: z.string(),
  secret: z.string(),
});
export type CreatedApiKeyView = z.infer<typeof createdApiKeyView>;
