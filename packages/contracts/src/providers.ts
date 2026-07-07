import { z } from 'zod';

/**
 * Provider identifiers. `-standalone` / `-page` variants mirror the two-phase-OAuth split
 * documented in RESEARCH.md (e.g. instagram via Page vs Instagram Login; linkedin personal vs page).
 * Flag-gated at launch: linkedin*, x, youtube (see PRD M3). `fake` exists only for tests/scaffold.
 */
export const providerIdentifier = z.enum([
  'instagram',
  'facebook',
  'gmb',
  'linkedin',
  'linkedin-page',
  'x',
  'youtube',
  'fake',
]);
export type ProviderIdentifier = z.infer<typeof providerIdentifier>;

/** How a provider's token lifecycle behaves — drives the refresh sweeper. */
export const tokenModel = z.enum(['auto-refresh', 'refresh-cron', 'one-time']);
export type TokenModel = z.infer<typeof tokenModel>;

export const connectionHealth = z.enum(['healthy', 'expiring', 'needs_reconnect']);
export type ConnectionHealth = z.infer<typeof connectionHealth>;
