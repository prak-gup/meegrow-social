import { z } from 'zod';
import {
  connectInputKind,
  connectMethod,
  connectionHealth,
  providerIdentifier,
  tokenModel,
} from './providers.js';
import { connectionImportView } from './imports.js';

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
  /** Expected consent expiry while the Google OAuth app is in Testing mode. */
  expiryReason: z.literal('google_testing').optional(),
  /**
   * How the account was connected, where a provider has more than one way (WordPress). `password`
   * means a login password is stored for it. Absent for every OAuth platform and for connections
   * made before this was recorded.
   */
  method: connectMethod.optional(),
  /** Past-post import state. Optional only so a consumer holding an older payload still parses. */
  import: connectionImportView.optional(),
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
  /**
   * Set when connecting starts with a question (`POST /v1/connections/:provider/start`) rather than
   * a bare redirect. Absent for every OAuth platform.
   */
  connectInput: connectInputKind.optional(),
  /** Set when there is more than one way to connect, so the dialog can offer the choice. */
  connectMethods: z.array(connectMethod).optional(),
});
export type ProviderView = z.infer<typeof providerView>;

/** Result of the OAuth callback: either the connection is made, or the user must pick an account. */
export const callbackResult = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('connected'),
    connectionId: z.string().uuid(),
    provider: providerIdentifier.optional(),
  }),
  z.object({
    status: z.literal('choose_account'),
    provider: providerIdentifier.optional(),
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

/**
 * Body of `POST /v1/connections/:provider/start` (and of the public invite start). `siteUrl` is
 * required by providers whose `connectInput` is `site_url` and ignored by the rest. It is only
 * shape-checked here: whether the address may be contacted at all is decided in core, by the one
 * SSRF guard (`safeFetch`), never by a regex in a contract.
 */
export const startConnectInput = z.object({
  siteUrl: z.string().trim().min(1).max(2048).optional(),
});
export type StartConnectInput = z.infer<typeof startConnectInput>;

/** Where to send the person next. The same shape `GET …/auth-url` has always answered with. */
export const startConnectResult = z.object({ url: z.string().url() });
export type StartConnectResult = z.infer<typeof startConnectResult>;

/** Body of `POST /v1/connections/:provider/site-check`. Shape-checked only, like `startConnectInput`. */
export const siteCheckInput = z.object({
  siteUrl: z.string().trim().min(1).max(2048),
});
export type SiteCheckInput = z.infer<typeof siteCheckInput>;

/**
 * What the server learned about a site address without logging in to it: which connect methods
 * the site can use, and — plainly — why not when it cannot. Messages are written by this app for
 * the person at the dialog; none is text from the site.
 */
export const siteCheck = z.object({
  /** The address as the site finally answered at (after its own redirects). */
  entered: z.string(),
  name: z.string().nullable(),
  /** WordPress Address (where it is administered) and Site Address (what visitors see). */
  siteAddress: z.string().nullable(),
  homeAddress: z.string().nullable(),
  /** True when those two are different addresses. */
  separateAddresses: z.boolean(),
  approval: z.discriminatedUnion('available', [
    z.object({ available: z.literal(true) }),
    z.object({ available: z.literal(false), reason: z.string(), message: z.string() }),
  ]),
  password: z.discriminatedUnion('available', [
    /** `endpoint` is the exact address a username and password would be sent to. */
    z.object({ available: z.literal(true), endpoint: z.string() }),
    z.object({ available: z.literal(false), reason: z.string(), message: z.string() }),
  ]),
  /**
   * Present when `password.available`: a short-lived seal over the endpoint above, for this
   * client only. The password route accepts a login for that endpoint and no other.
   */
  ticket: z.string().optional(),
});
export type SiteCheck = z.infer<typeof siteCheck>;

/**
 * Body of `POST /v1/connections/:provider/password`. `password` is a WordPress LOGIN password: it
 * is never trimmed, echoed in an error, logged or returned. The limits are WordPress's own
 * (`user_login` is 60 characters) with room for a long passphrase.
 */
export const passwordConnectInput = z.object({
  ticket: z.string().min(1).max(4096),
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(512),
});
export type PasswordConnectInput = z.infer<typeof passwordConnectInput>;

export const passwordConnectResult = z.object({
  connectionId: z.string().uuid(),
  displayName: z.string(),
  externalId: z.string(),
  /** The address the login was verified at, and will be used at. */
  endpoint: z.string(),
});
export type PasswordConnectResult = z.infer<typeof passwordConnectResult>;

/**
 * Body of `POST /v1/connections/:provider/credentials`, for a provider whose `connectInput` is
 * `credentials`. Which fields a provider wants is the provider's own business (core), so this only
 * bounds the shape: a handful of short named strings. The values are secrets — nothing may log or
 * echo this body.
 */
export const connectCredentialsInput = z.object({
  fields: z
    .record(z.string().min(1).max(40), z.string().max(4096))
    .refine((fields) => Object.keys(fields).length <= 8, 'too many fields'),
});
export type ConnectCredentialsInput = z.infer<typeof connectCredentialsInput>;

/** What a credential connect answers with. Never anything that was sent in. */
export const connectCredentialsResult = z.object({
  connectionId: z.string().uuid(),
  displayName: z.string(),
  /** True when an existing connection to the same account was given the new credential. */
  reconnected: z.boolean(),
});
export type ConnectCredentialsResult = z.infer<typeof connectCredentialsResult>;
