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
  // A self-hosted WordPress site (blog articles, not social posts). Registered only when
  // WORDPRESS_ENABLED=true; see docs/dev/research/wordpress.md.
  'wordpress',
  'fake',
  'fake_2step',
  // Test-only (issue #12): exercise the token-health matrix + sweeper failure path.
  'fake_onetime',
  'fake_fail_refresh',
  'fake_transient_refresh',
  // Test-only (issue #9): analytics that fail auth / transiently, to drive the sweeper's taxonomy.
  'fake_fail_analytics',
  'fake_transient_analytics',
]);
export type ProviderIdentifier = z.infer<typeof providerIdentifier>;

/** How a provider's token lifecycle behaves — drives the refresh sweeper. */
export const tokenModel = z.enum(['auto-refresh', 'refresh-cron', 'one-time']);
export type TokenModel = z.infer<typeof tokenModel>;

export const connectionHealth = z.enum(['healthy', 'expiring', 'needs_reconnect']);
export type ConnectionHealth = z.infer<typeof connectionHealth>;

/**
 * What a provider needs from the person BEFORE it can send them anywhere. OAuth platforms need
 * nothing (absent); WordPress has no central login, so the site's address has to come first.
 */
export const connectInputKind = z.enum(['site_url']);
export type ConnectInputKind = z.infer<typeof connectInputKind>;

/**
 * How a site-address provider (WordPress) was, or can be, connected. `approval`: the person
 * approves on the site's own screen and the site issues a separate password for this app.
 * `password`: the person types a username and login password here, for sites where the first is
 * switched off. Recorded on the connection so the difference stays visible afterwards.
 */
export const connectMethod = z.enum(['approval', 'password']);
export type ConnectMethod = z.infer<typeof connectMethod>;
