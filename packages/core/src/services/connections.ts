import { testingConnectionState, type ConnectionExpiryOptions } from './google-oauth-testing.js';
import { AccessDeniedError } from './access.js';
import { db, schema, withWorkspace } from '@meegrow-social/db';
import { and, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import {
  connectMethod,
  type CallbackResult,
  type SiteCheck,
  type ConnectionView,
  type ConnectionHealth,
  type ConnectionHealthStatus,
  type ConnectionHealthView,
  type ProviderAccountView,
  type ProviderIdentifier,
  type TokenModel,
} from '@meegrow-social/contracts';
import { getProvider } from '../providers/registry.js';
import { METRIC_RETENTION_DAYS } from './metrics-retention.js';
import type { AuthTokens } from '../providers/types.js';
import {
  decryptToken,
  encryptToken,
  openSiteCheck,
  sealSiteCheck,
  signConnectFlow,
  signConnectOutcome,
  verifyConnectFlowProof,
  verifyConnectOutcome,
} from '../crypto.js';
import {
  ConnectError,
  connectFailureCode,
  connectFailureMessage,
  ProviderBadRequestError,
  type ConnectFailureCode,
} from '../errors.js';
import { beginSiteLoginAttempt } from './auth-throttle.js';
import { connectionImportView, initialImportState } from './post-import.js';

/** How long a started flow waits for the platform's redirect back (login + consent screens). */
const FLOW_TTL_MS = 10 * 60 * 1000;
/**
 * How long a two-phase flow waits for the account pick, counted from the callback rather than from
 * the start: the consent screens already spent an unknown share of FLOW_TTL_MS, and a person reading
 * a list of Pages on a phone should not lose the flow to whatever was left of it.
 */
const ACCOUNT_PICK_TTL_MS = 30 * 60 * 1000;
/** The longest a flow can live end to end — how long the invite path's proof cookie is kept. */
export const CONNECT_FLOW_MAX_AGE_MS = FLOW_TTL_MS + ACCOUNT_PICK_TTL_MS;
/** Refreshable tokens (auto-refresh / refresh-cron) surface 'expiring' within 7d of expiry. */
export const EXPIRING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** One-time tokens can't be auto-refreshed, so they surface 'expiring' earlier (14d) for manual re-auth. */
export const ONE_TIME_EXPIRING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Thrown when a post names a connection this workspace does not have (→ 404 in the API). The same
 * error whether the id is unknown or belongs to another workspace — RLS hides the difference, and
 * the message must not put it back.
 */
export class ConnectionNotFoundError extends Error {}

/**
 * Thrown when a flow's connect invite stopped being usable while the flow was in flight: an
 * operator cancelled the link, or another flow already connected an account through it.
 */
export class InviteClosedError extends ConnectError {
  constructor(message?: string) {
    super('invite_closed', message);
  }
}

function callbackUri(appUrl: string): string {
  return `${appUrl.replace(/\/$/, '')}/connect/callback`;
}

/**
 * Token health drives both the dashboard badge and the refresh sweeper's candidate filter.
 * `needsReconnect` always wins; otherwise the expiring window depends on tokenModel — refreshable
 * tokens get a 7d window (the sweeper refreshes them), one-time tokens get a 14d window (manual only).
 */
export function computeHealth(
  tokenModel: TokenModel,
  needsReconnect: boolean,
  expiresAt: Date | null,
): ConnectionHealth {
  if (needsReconnect) return 'needs_reconnect';
  if (!expiresAt) return 'healthy';
  const window = tokenModel === 'one-time' ? ONE_TIME_EXPIRING_WINDOW_MS : EXPIRING_WINDOW_MS;
  return expiresAt.getTime() - Date.now() < window ? 'expiring' : 'healthy';
}

/** Whole days until expiry (floor); null when the token has no expiry. Negative = already expired. */
export function expiresInDaysFrom(expiresAt: Date | null): number | null {
  if (!expiresAt) return null;
  return Math.floor((expiresAt.getTime() - Date.now()) / DAY_MS);
}

/**
 * Turns a connection's stored token state into a status, a reason and a next step (account health).
 * Pure — and built on `computeHealth`, so it can never disagree with the dashboard badge; the only
 * refinement is splitting an already-lapsed token (`expired`) out of `expiring`.
 *
 * `autoRefresh` is what the token sweeper acts on: a refreshable model AND a stored refresh token.
 */
export function describeConnectionHealth(conn: {
  tokenModel: TokenModel;
  needsReconnect: boolean;
  expiresAt: Date | null;
  hasRefreshToken: boolean;
}): {
  status: ConnectionHealthStatus;
  reason: string;
  recommendedAction: string;
  autoRefresh: boolean;
} {
  const autoRefresh = conn.tokenModel !== 'one-time' && conn.hasRefreshToken;
  const health = computeHealth(conn.tokenModel, conn.needsReconnect, conn.expiresAt);

  if (health === 'needs_reconnect') {
    return {
      status: 'needs_reconnect',
      reason: 'The platform rejected the stored credentials during a publish or a token refresh.',
      recommendedAction:
        'Reconnect the account in the dashboard. Posts to it fail until a human does.',
      autoRefresh,
    };
  }
  if (health === 'healthy') {
    return {
      status: 'healthy',
      reason: conn.expiresAt
        ? `The stored token is valid for another ${expiresInDaysFrom(conn.expiresAt)} days.`
        : 'The stored token has no expiry.',
      recommendedAction: 'None.',
      autoRefresh,
    };
  }

  const days = expiresInDaysFrom(conn.expiresAt)!;
  if (conn.expiresAt!.getTime() <= Date.now()) {
    return {
      status: 'expired',
      reason: `The stored token expired ${-days} day(s) ago.`,
      recommendedAction: autoRefresh
        ? 'The token refreshes automatically; if this persists past the next refresh sweep, reconnect the account in the dashboard.'
        : 'Reconnect the account in the dashboard. Posts to it will fail until then.',
      autoRefresh,
    };
  }
  return {
    status: 'expiring',
    reason: `The stored token expires in ${days} day(s).`,
    recommendedAction: autoRefresh
      ? 'None. The token refreshes automatically before it expires.'
      : 'Reconnect the account in the dashboard before the token expires; it cannot be refreshed automatically.',
    autoRefresh,
  };
}

/** What the person supplied before the redirect, for providers that ask (`connectInput`). */
export interface StartConnectAnswers {
  siteUrl?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Step 1: create a single-use flow row and return the provider auth URL to redirect the user to.
 * `inviteId` marks a flow started from a connect invite (see `handleCallback`).
 *
 * `proof` is returned when the flow must finish in the browser that started it — the provider's
 * callback carries a credential (`credentialInCallback`). The caller sets it as that browser's
 * cookie, exactly as the invite path does for its own flows.
 *
 * A provider that asks for input validates it itself and throws `ProviderBadRequestError` with
 * words for the person who typed it; the flow row is then burned rather than left pending.
 */
export async function startConnect(
  workspaceId: string,
  provider: ProviderIdentifier,
  appUrl: string,
  inviteId?: string,
  answers: StartConnectAnswers = {},
): Promise<{ url: string; flowId: string; proof?: string }> {
  const impl = getProvider(provider);
  const redirectUri = callbackUri(appUrl);
  const [flow] = await db()
    .insert(schema.oauthFlows)
    .values({
      workspaceId,
      provider,
      redirectUri,
      status: 'pending',
      inviteId: inviteId ?? null,
      expiresAt: new Date(Date.now() + FLOW_TTL_MS),
    })
    .returning();
  if (!flow) throw new Error('failed to create oauth flow');

  let generated: Awaited<ReturnType<typeof impl.generateAuthUrl>>;
  try {
    generated = await impl.generateAuthUrl({
      redirectUri,
      state: flow.id,
      ...(impl.connectInput === 'site_url' ? { siteUrl: answers.siteUrl } : {}),
    });
  } catch (err) {
    await db()
      .update(schema.oauthFlows)
      .set({ status: 'consumed' })
      .where(eq(schema.oauthFlows.id, flow.id));
    throw err;
  }
  const { url, codeVerifier } = generated;
  if (codeVerifier) {
    await db()
      .update(schema.oauthFlows)
      .set({ codeVerifier })
      .where(eq(schema.oauthFlows.id, flow.id));
  }
  return {
    url,
    flowId: flow.id,
    ...(impl.credentialInCallback ? { proof: signConnectFlow(flow.id) } : {}),
  };
}

/**
 * Step 2 (public callback): exchange the code. `state` is the opaque flow id — if it doesn't match a
 * live, unconsumed, unexpired flow, we reject (defeats tampering + replay). Single-step providers get
 * a connection immediately; two-step providers return an account list for the finish step.
 *
 * A flow started from a connect invite is only ever completed in the browser that started it:
 * `proof` is that browser's cookie (see `signConnectFlow`). Without it the code is never exchanged
 * and the flow is burned — otherwise someone holding an invite link could start a flow, send the
 * platform's consent URL to a person who manages the account, and take over once they approved.
 *
 * A provider whose callback carries the credential itself (`credentialInCallback` — WordPress hands
 * back an application password in the query string) is held to more, because there is no code
 * exchange for a forged callback to fail at:
 *  - EVERY flow needs the starting browser's proof, dashboard-started ones included, so knowing a
 *    flow id (it is in the URL the site was sent) is not enough to finish the flow;
 *  - the flow is claimed atomically BEFORE the provider is asked anything, so it gets exactly one
 *    attempt: a replayed, raced or guessed-again callback finds nothing to act on.
 * `callback` is the redirect's query, passed through for such providers to validate.
 */
export async function handleCallback(
  state: string,
  code: string,
  proof?: string | null,
  callback?: Readonly<Record<string, string | undefined>>,
): Promise<CallbackResult> {
  // Checked before the lookup: `state` is a stranger's text, and only a uuid can name a flow.
  if (!UUID.test(state)) {
    throw new ConnectError('invalid_state', 'invalid, already-used, or unknown connect state');
  }
  const [flow] = await db()
    .select()
    .from(schema.oauthFlows)
    .where(and(eq(schema.oauthFlows.id, state), eq(schema.oauthFlows.status, 'pending')))
    .limit(1);
  if (!flow) {
    throw new ConnectError('invalid_state', 'invalid, already-used, or unknown connect state');
  }
  if (flow.expiresAt.getTime() < Date.now())
    throw new ConnectError('expired', 'connect flow expired');
  const impl = getProvider(flow.provider as ProviderIdentifier);
  if (flow.inviteId || impl.credentialInCallback) {
    if (!verifyConnectFlowProof(flow.id, proof)) {
      await db()
        .update(schema.oauthFlows)
        .set({ status: 'consumed' })
        .where(eq(schema.oauthFlows.id, flow.id));
      throw new ConnectError(
        'different_browser',
        flow.inviteId
          ? 'this approval was opened in a different browser from the one the link was opened in'
          : undefined,
      );
    }
  }
  if (flow.inviteId && (await inviteClosed(flow.inviteId)) !== null) {
    throw new InviteClosedError('this invite link is no longer valid');
  }
  if (impl.credentialInCallback) {
    const claimed = await db()
      .update(schema.oauthFlows)
      .set({ status: 'consumed' })
      .where(and(eq(schema.oauthFlows.id, flow.id), eq(schema.oauthFlows.status, 'pending')))
      .returning({ id: schema.oauthFlows.id });
    if (claimed.length === 0) {
      throw new ConnectError('invalid_state', 'invalid, already-used, or unknown connect state');
    }
  }

  const tokens = await impl.authenticate({
    code,
    codeVerifier: flow.codeVerifier ?? undefined,
    redirectUri: flow.redirectUri,
    ...(callback ? { callback } : {}),
  });

  if (impl.isBetweenSteps) {
    const accounts = impl.listAccounts ? await impl.listAccounts(tokens) : [];
    await db()
      .update(schema.oauthFlows)
      .set({
        encryptedTokens: encryptToken(serialize(tokens)),
        accounts,
        status: 'awaiting_account',
        expiresAt: new Date(Date.now() + ACCOUNT_PICK_TTL_MS),
      })
      .where(eq(schema.oauthFlows.id, flow.id));
    return {
      status: 'choose_account',
      provider: flow.provider as ProviderIdentifier,
      flowId: flow.id,
      accounts,
    };
  }

  const connectionId = await createFlowConnection(
    flow,
    tokens,
    tokens.externalId,
    tokens.displayName,
  );
  return { status: 'connected', provider: flow.provider as ProviderIdentifier, connectionId };
}

/**
 * True when a callback's query carries a credential rather than a one-time code. The API must then
 * answer with a redirect, never a page: the secret is in the address bar, and a page rendered at
 * that URL leaves it in the tab's history and hands it to anything the page loads.
 */
export function callbackCarriesCredential(
  query: Readonly<Record<string, string | undefined>>,
): boolean {
  return query.password !== undefined || query.user_login !== undefined;
}

/**
 * `handleCallback` for a credential-bearing callback, reduced to a query string for the redirect
 * that reports it (`/connect/done?…`). Never throws: every failure becomes a `reason` code. The
 * string is sealed, so the public page it is sent to cannot be made to announce a result this
 * server did not produce — and it carries nothing from the callback itself.
 */
export async function completeCredentialCallback(
  query: Readonly<Record<string, string | undefined>>,
  proof?: string | null,
): Promise<string> {
  let outcome: { status: 'connected'; connectionId: string } | { status: 'error'; reason: string };
  try {
    if (!query.state) throw new ConnectError('invalid_state');
    const result = await handleCallback(query.state, query.code ?? '', proof, query);
    // A credential-bearing callback is single-step by construction; anything else is a bug.
    outcome =
      result.status === 'connected'
        ? { status: 'connected', connectionId: result.connectionId }
        : { status: 'error', reason: 'failed' satisfies ConnectFailureCode };
  } catch (err) {
    outcome = { status: 'error', reason: connectFailureCode(err) };
  }
  const detail = outcome.status === 'connected' ? outcome.connectionId : outcome.reason;
  return new URLSearchParams({
    status: outcome.status,
    detail,
    seal: signConnectOutcome(`${outcome.status}:${detail}`),
  }).toString();
}

/**
 * Read a sealed outcome back off the result page's query, as the `CallbackResult`-shaped payload
 * the popup page already knows how to show. An unsealed or altered query is a plain failure.
 */
export function openCallbackOutcome(
  query: Readonly<Record<string, unknown>>,
): { status: 'connected'; connectionId: string } | { status: 'error'; error: string } {
  const { status, detail, seal } = query;
  if (
    typeof status !== 'string' ||
    typeof detail !== 'string' ||
    !verifyConnectOutcome(`${status}:${detail}`, seal)
  ) {
    return { status: 'error', error: connectFailureMessage('failed') };
  }
  return status === 'connected'
    ? { status: 'connected', connectionId: detail }
    : { status: 'error', error: connectFailureMessage(detail) };
}

/** How long a site check stays good for the login that follows it. */
export const SITE_CHECK_TTL_MS = 15 * 60 * 1000;

/** What a site-check ticket seals. Nothing secret: the browser already saw all of it. */
interface SiteTicket {
  workspaceId: string;
  provider: string;
  endpoint: string;
  entered: string;
  home: string | null;
  name: string | null;
  expiresAt: number;
}

function readSiteTicket(
  ticket: string,
  workspaceId: string,
  provider: ProviderIdentifier,
): SiteTicket | null {
  const payload = openSiteCheck(ticket);
  if (payload === null) return null;
  let parsed: SiteTicket;
  try {
    parsed = JSON.parse(payload) as SiteTicket;
  } catch {
    return null;
  }
  // A ticket is good for the client and provider it was made for, and not for long.
  if (
    parsed.workspaceId !== workspaceId ||
    parsed.provider !== provider ||
    typeof parsed.endpoint !== 'string' ||
    typeof parsed.entered !== 'string' ||
    !(parsed.expiresAt > Date.now())
  ) {
    return null;
  }
  return parsed;
}

/**
 * Look at a site address before anyone logs in to it (`POST /v1/connections/:provider/site-check`):
 * which connect methods the site can use, and why not when it cannot. Unauthenticated requests to
 * the site only, every one through the SSRF guard.
 *
 * When a username-and-password connect is possible the answer carries a `ticket`: the exact
 * endpoint the person is about to be shown, sealed for this workspace. `connectWithPassword`
 * sends a login to a sealed endpoint and to nothing else — so the address the password goes to is
 * always one this server found and the person saw, never one taken from a request body, and never
 * the result of a second, different discovery.
 */
export async function checkConnectSite(
  workspaceId: string,
  provider: ProviderIdentifier,
  siteUrl: string,
): Promise<SiteCheck> {
  const impl = getProvider(provider);
  if (!impl.inspectSite) {
    throw new ProviderBadRequestError('This platform is not connected by a site address.');
  }
  const inspection = await impl.inspectSite(siteUrl);
  if (!inspection.password.available) return inspection;
  if (!impl.connectMethods?.includes('password') || !impl.authenticateWithPassword) {
    return {
      ...inspection,
      password: {
        available: false,
        reason: 'not_offered',
        message: 'This platform cannot be connected with a username and password.',
      },
    };
  }
  const ticket: SiteTicket = {
    workspaceId,
    provider,
    endpoint: inspection.password.endpoint,
    entered: inspection.entered,
    home: inspection.homeAddress,
    name: inspection.name,
    expiresAt: Date.now() + SITE_CHECK_TTL_MS,
  };
  return { ...inspection, ticket: sealSiteCheck(JSON.stringify(ticket)) };
}

export type PasswordConnectOutcome =
  | { ok: true; connectionId: string; displayName: string; externalId: string; endpoint: string }
  | { ok: false; reason: 'rate_limited'; retryAfterSeconds: number }
  /** `message` is a sentence from the fixed vocabulary — safe to show, and all there is to show. */
  | { ok: false; reason: ConnectFailureCode; message: string };

/** Who is asking for a login to be tried, for the attempt limits. */
export interface PasswordConnectCaller {
  ip: string;
  /** A user id, or the workspace of an API key. */
  actor: string;
}

/**
 * Connect a site with a username and LOGIN password the person typed
 * (`POST /v1/connections/:provider/password`). The password is checked against the site, stored
 * only inside the connection's encrypted token, and appears nowhere else: not in the outcome, not
 * in an error (failures are fixed codes — whatever the provider threw is reduced to one), not in a
 * log (nothing here logs).
 *
 * This server is the one sending the guess, so attempts are limited before the site is asked
 * anything — per site, per caller and per address (`beginSiteLoginAttempt`). Only a login the
 * site ACCEPTED gives its attempt back. A wrong password, a firewall page and a site that did not
 * answer all stay counted: each is a request we made at somebody's login, and an attacker must
 * not get unlimited ones by picking a site that answers badly.
 */
export async function connectWithPassword(
  workspaceId: string,
  provider: ProviderIdentifier,
  input: { ticket: string; username: string; password: string },
  caller: PasswordConnectCaller,
): Promise<PasswordConnectOutcome> {
  const refuse = (reason: ConnectFailureCode): PasswordConnectOutcome => ({
    ok: false,
    reason,
    message: connectFailureMessage(reason),
  });
  const impl = getProvider(provider);
  if (!impl.connectMethods?.includes('password') || !impl.authenticateWithPassword) {
    return refuse('unavailable');
  }
  const ticket = readSiteTicket(input.ticket, workspaceId, provider);
  if (!ticket) return refuse('check_expired');

  const gate = await beginSiteLoginAttempt({
    ip: caller.ip,
    actor: caller.actor,
    site: new URL(ticket.endpoint).host,
  });
  if (!gate.allowed) {
    return { ok: false, reason: 'rate_limited', retryAfterSeconds: gate.retryAfterSeconds };
  }

  let tokens: AuthTokens;
  try {
    tokens = await impl.authenticateWithPassword({
      endpoint: ticket.endpoint,
      username: input.username,
      password: input.password,
      site: { entered: ticket.entered, home: ticket.home, name: ticket.name },
    });
  } catch (err) {
    // The code only — never the error's text, which a provider could have built from anything.
    const reason = connectFailureCode(err);
    // The right password for a user who may not publish is not a wrong guess.
    await gate.settle(reason === 'role_cannot_publish' ? 'not_a_guess' : 'failed');
    return refuse(reason);
  }
  await gate.settle('succeeded');
  const connectionId = await createConnection(
    workspaceId,
    provider,
    tokens,
    tokens.externalId,
    tokens.displayName,
  );
  return {
    ok: true,
    connectionId,
    displayName: tokens.displayName,
    externalId: tokens.externalId,
    endpoint: ticket.endpoint,
  };
}

/** Step 3 (two-phase only): the user picked an account; finalize the connection. */
export async function finishConnect(
  workspaceId: string,
  flowId: string,
  externalId: string,
): Promise<string> {
  const [flow] = await db()
    .select()
    .from(schema.oauthFlows)
    .where(and(eq(schema.oauthFlows.id, flowId), eq(schema.oauthFlows.status, 'awaiting_account')))
    .limit(1);
  if (!flow) throw new Error('no account-selection flow for this id');
  if (flow.workspaceId !== workspaceId) throw new AccessDeniedError();
  if (flow.expiresAt.getTime() < Date.now()) throw new Error('connect flow expired');

  return (await connectChosenAccount(flow, externalId)).connectionId;
}

type OAuthFlow = typeof schema.oauthFlows.$inferSelect;

function offeredAccounts(flow: OAuthFlow): ProviderAccountView[] {
  return (flow.accounts as ProviderAccountView[] | null) ?? [];
}

/** Create the connection for the account picked out of an `awaiting_account` flow, and consume it. */
async function connectChosenAccount(
  flow: OAuthFlow,
  externalId: string,
): Promise<{ connectionId: string; displayName: string }> {
  const chosen = offeredAccounts(flow).find((a) => a.externalId === externalId);
  if (!chosen) throw new Error('chosen account is not one of the offered accounts');
  if (!flow.encryptedTokens) throw new Error('flow is missing tokens');

  const userTokens = deserialize(decryptToken(flow.encryptedTokens));
  // Some two-phase providers must connect the chosen account with account-scoped tokens rather than
  // the user-level ones (Facebook: a Page's own non-expiring Page token). See SocialProvider.
  const impl = getProvider(flow.provider as ProviderIdentifier);
  const tokens = impl.finalizeAccount ? await impl.finalizeAccount(userTokens, chosen) : userTokens;
  const connectionId = await createFlowConnection(
    flow,
    tokens,
    chosen.externalId,
    chosen.displayName,
  );
  return { connectionId, displayName: chosen.displayName };
}

/**
 * Why a connect invite can no longer be used, or null while it still can. Read on the admin handle:
 * connect_invites is non-tenant (see schema).
 */
async function inviteClosed(inviteId: string): Promise<'used' | 'revoked' | 'expired' | null> {
  const [invite] = await db()
    .select({
      consumedAt: schema.connectInvites.consumedAt,
      revokedAt: schema.connectInvites.revokedAt,
      expiresAt: schema.connectInvites.expiresAt,
    })
    .from(schema.connectInvites)
    .where(eq(schema.connectInvites.id, inviteId))
    .limit(1);
  if (!invite || invite.revokedAt) return 'revoked';
  if (invite.consumedAt) return 'used';
  return invite.expiresAt.getTime() < Date.now() ? 'expired' : null;
}

/**
 * The one place a flow becomes a connection, and consumes the flow. For an invite-started flow it
 * also closes the invite: a link is good for retries until its first successful connection, then
 * stops — a forwarded link must not keep connecting accounts for the rest of its 14 days. The
 * invite is claimed atomically BEFORE the insert, so two flows racing on one link make one
 * connection, and handed back if the insert then fails.
 */
async function createFlowConnection(
  flow: OAuthFlow,
  tokens: AuthTokens,
  externalId: string,
  displayName: string,
): Promise<string> {
  if (flow.inviteId) {
    const claimed = await db()
      .update(schema.connectInvites)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(schema.connectInvites.id, flow.inviteId),
          isNull(schema.connectInvites.consumedAt),
          isNull(schema.connectInvites.revokedAt),
          gt(schema.connectInvites.expiresAt, new Date()),
        ),
      )
      .returning({ id: schema.connectInvites.id });
    if (claimed.length === 0) throw new InviteClosedError('this invite link is no longer valid');
  }
  let connectionId: string;
  try {
    connectionId = await createConnection(
      flow.workspaceId,
      flow.provider as ProviderIdentifier,
      tokens,
      externalId,
      displayName,
    );
  } catch (err) {
    if (flow.inviteId) {
      await db()
        .update(schema.connectInvites)
        .set({ consumedAt: null })
        .where(eq(schema.connectInvites.id, flow.inviteId));
    }
    throw err;
  }
  await db()
    .update(schema.oauthFlows)
    .set({ status: 'consumed' })
    .where(eq(schema.oauthFlows.id, flow.id));
  return connectionId;
}

/**
 * The account-pick step of a flow started from a connect invite, for a person with no session.
 *
 * `proof` (see `signConnectFlow`) is the whole credential: the server issues it only from the
 * invite start route, to the browser that started this flow. So a valid proof means both "this flow
 * came from an invite" and "this is the browser that started it" — a flow started from the
 * dashboard never has one and cannot be finished here. The workspace is always the flow's own (the
 * invite's); the caller cannot name another. A bad proof and an unknown flow get the same answer.
 */
export type InviteFlowState =
  | {
      status: 'choose_account';
      workspaceName: string;
      provider: ProviderIdentifier;
      providerDisplayName: string;
      accounts: ProviderAccountView[];
    }
  | { status: 'not_found' | 'used' | 'expired' };

type LiveInviteFlow = Extract<InviteFlowState, { status: 'choose_account' }> & { flow: OAuthFlow };

async function loadInviteFlow(
  flowId: string,
  proof: string | undefined | null,
): Promise<LiveInviteFlow | Exclude<InviteFlowState, { status: 'choose_account' }>> {
  // Checked before the lookup: only an id this server signed ever reaches the database.
  if (!verifyConnectFlowProof(flowId, proof)) return { status: 'not_found' };
  const [flow] = await db()
    .select()
    .from(schema.oauthFlows)
    .where(eq(schema.oauthFlows.id, flowId))
    .limit(1);
  if (!flow) return { status: 'not_found' };
  if (flow.status === 'consumed') return { status: 'used' };
  if (flow.expiresAt.getTime() < Date.now()) return { status: 'expired' };
  // Still 'pending': the platform never redirected back, so there is nothing to pick from yet.
  if (flow.status !== 'awaiting_account') return { status: 'not_found' };
  if (flow.inviteId) {
    // The link was cancelled, or another flow already connected through it, while this one waited.
    const closed = await inviteClosed(flow.inviteId);
    if (closed) return { status: closed === 'used' ? 'used' : 'expired' };
  }

  const [workspace] = await db()
    .select({ name: schema.workspaces.name })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, flow.workspaceId))
    .limit(1);
  if (!workspace) return { status: 'not_found' };
  const provider = flow.provider as ProviderIdentifier;
  return {
    status: 'choose_account',
    workspaceName: workspace.name,
    provider,
    providerDisplayName: getProvider(provider).displayName,
    accounts: offeredAccounts(flow),
    flow,
  };
}

/** What the invite's account picker shows: who is asking, for which platform, and the choices. */
export async function getInviteFlow(
  flowId: string,
  proof: string | undefined | null,
): Promise<InviteFlowState> {
  const loaded = await loadInviteFlow(flowId, proof);
  if (loaded.status !== 'choose_account') return loaded;
  const { flow: _flow, ...view } = loaded;
  return view;
}

export type InviteFinishResult =
  | {
      status: 'connected';
      connectionId: string;
      accountName: string;
      workspaceName: string;
      providerDisplayName: string;
    }
  | { status: 'not_found' | 'used' | 'expired' | 'invalid_account' }
  /** The platform refused the chosen account (e.g. it is no longer reachable). Nothing was created. */
  | { status: 'failed'; error: string };

/** Finish an invite-started flow: connect the picked account into the invite's workspace. */
export async function finishInviteConnect(
  flowId: string,
  proof: string | undefined | null,
  externalId: string,
): Promise<InviteFinishResult> {
  const loaded = await loadInviteFlow(flowId, proof);
  if (loaded.status !== 'choose_account') return loaded;
  if (!loaded.accounts.some((a) => a.externalId === externalId)) {
    return { status: 'invalid_account' };
  }
  try {
    const { connectionId, displayName } = await connectChosenAccount(loaded.flow, externalId);
    return {
      status: 'connected',
      connectionId,
      accountName: displayName,
      workspaceName: loaded.workspaceName,
      providerDisplayName: loaded.providerDisplayName,
    };
  } catch (err) {
    if (err instanceof InviteClosedError) return { status: 'used' };
    return { status: 'failed', error: err instanceof Error ? err.message : 'could not connect' };
  }
}

export async function listConnections(
  workspaceId: string,
  options: ConnectionExpiryOptions = {},
): Promise<ConnectionView[]> {
  return withWorkspace(workspaceId, async (tx) => {
    const rows = await tx.select().from(schema.connections);
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider as ConnectionView['provider'],
      externalId: r.externalId,
      displayName: r.displayName,
      needsReconnect: r.needsReconnect,
      expiresAt: r.expiresAt,
      expiresInDays: expiresInDaysFrom(r.expiresAt),
      health: computeHealth(r.tokenModel as TokenModel, r.needsReconnect, r.expiresAt),
      createdAt: r.createdAt,
      ...testingConnectionState({ ...r, tokenModel: r.tokenModel as TokenModel }, options),
      ...connectionMethod(r.meta),
      import: connectionImportView(r),
    }));
  });
}

/** How a connection was made, read from its non-secret `meta` — the token is never opened for it. */
export function connectionMethod(meta: unknown): Pick<ConnectionView, 'method'> {
  const method = connectMethod.safeParse((meta as { method?: unknown } | null)?.method);
  return method.success ? { method: method.data } : {};
}

/**
 * Account health for every connection of the workspace, or just `connectionIds` when given. Reads
 * stored state only — token expiry, the needs-reconnect flag, the last analytics sweep, the latest
 * failed post. It does NOT call the platform, so it cannot see a token revoked on the platform's
 * side; `source: 'stored'` on every item says so.
 */
export async function listConnectionHealth(
  workspaceId: string,
  connectionIds?: readonly string[],
  options: ConnectionExpiryOptions = {},
): Promise<ConnectionHealthView[]> {
  const checkedAt = new Date();
  return withWorkspace(workspaceId, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.connections)
      .where(connectionIds ? inArray(schema.connections.id, [...connectionIds]) : undefined);
    if (rows.length === 0) return [];

    // Newest failed post per connection: DISTINCT ON keeps the first row of each connection in
    // (connectionId, createdAt desc) order.
    const failed = await tx
      .selectDistinctOn([schema.posts.connectionId], {
        connectionId: schema.posts.connectionId,
        postId: schema.posts.id,
        error: schema.posts.error,
        publishAt: schema.posts.publishAt,
      })
      .from(schema.posts)
      .where(
        and(
          eq(schema.posts.status, 'failed'),
          inArray(
            schema.posts.connectionId,
            rows.map((r) => r.id),
          ),
        ),
      )
      .orderBy(schema.posts.connectionId, desc(schema.posts.createdAt));
    const failedByConnection = new Map(failed.map((f) => [f.connectionId, f]));

    return rows.map((r) => {
      const lastFailed = failedByConnection.get(r.id);
      const testing = testingConnectionState(
        { ...r, tokenModel: r.tokenModel as TokenModel },
        options,
      );
      return {
        connectionId: r.id,
        provider: r.provider as ConnectionHealthView['provider'],
        displayName: r.displayName,
        ...describeConnectionHealth({
          tokenModel: r.tokenModel as TokenModel,
          needsReconnect: r.needsReconnect,
          expiresAt: r.expiresAt,
          hasRefreshToken: r.refreshToken !== null,
        }),
        needsReconnect: r.needsReconnect,
        tokenModel: r.tokenModel as TokenModel,
        expiresAt: r.expiresAt,
        expiresInDays: expiresInDaysFrom(r.expiresAt),
        ...(testing
          ? {
              expiresAt: testing.expiresAt,
              expiresInDays: testing.expiresInDays,
              status: testing.health,
              reason:
                'Google app in testing: consent is expected to expire seven days after connection.',
              recommendedAction: `Reconnect by ${testing.expiresAt.toISOString().slice(0, 10)} — Google app in testing`,
              autoRefresh: false,
            }
          : {}),
        lastAnalyticsAt: r.lastAnalyticsAt,
        lastFailedPost: lastFailed
          ? { postId: lastFailed.postId, error: lastFailed.error, publishAt: lastFailed.publishAt }
          : null,
        source: 'stored' as const,
        checkedAt,
      };
    });
  });
}

/** Health of one connection; null when the workspace has no such connection. */
export async function getConnectionHealth(
  workspaceId: string,
  connectionId: string,
  options: ConnectionExpiryOptions = {},
): Promise<ConnectionHealthView | null> {
  const [health] = await listConnectionHealth(workspaceId, [connectionId], options);
  return health ?? null;
}

/**
 * Which of `connectionIds` this workspace does NOT have. RLS makes another workspace's connection
 * indistinguishable from one that never existed, which is exactly what callers must report.
 */
export async function findMissingConnectionIds(
  workspaceId: string,
  connectionIds: readonly string[],
): Promise<string[]> {
  const wanted = [...new Set(connectionIds)];
  if (wanted.length === 0) return [];
  const found = await withWorkspace(workspaceId, async (tx) =>
    tx
      .select({ id: schema.connections.id })
      .from(schema.connections)
      .where(inArray(schema.connections.id, wanted)),
  );
  const have = new Set(found.map((r) => r.id));
  return wanted.filter((id) => !have.has(id));
}

export async function deleteConnection(workspaceId: string, id: string): Promise<boolean> {
  return withWorkspace(workspaceId, async (tx) => {
    const deleted = await tx
      .delete(schema.connections)
      .where(eq(schema.connections.id, id))
      .returning({ id: schema.connections.id, provider: schema.connections.provider });
    const [conn] = deleted;
    if (!conn) return false;
    // A platform with a storage limit (YouTube, #61) also wants its data gone promptly when the
    // account is removed — Developer Policies III.E.4.g allows 7 days, and the retention sweep
    // would take ~29. Same transaction as the delete; other platforms keep their history.
    if (METRIC_RETENTION_DAYS[conn.provider as ProviderIdentifier] !== undefined) {
      await tx
        .delete(schema.metrics)
        .where(
          or(
            eq(schema.metrics.connectionId, id),
            inArray(
              schema.metrics.postId,
              tx
                .select({ id: schema.posts.id })
                .from(schema.posts)
                .where(eq(schema.posts.connectionId, id)),
            ),
          ),
        );
    }
    return true;
  });
}

async function createConnection(
  workspaceId: string,
  provider: ProviderIdentifier,
  tokens: AuthTokens,
  externalId: string,
  displayName: string,
): Promise<string> {
  const impl = getProvider(provider);
  return withWorkspace(workspaceId, async (tx) => {
    const [conn] = await tx
      .insert(schema.connections)
      .values({
        workspaceId,
        provider,
        externalId,
        displayName,
        accessToken: encryptToken(tokens.accessToken),
        refreshToken: tokens.refreshToken ? encryptToken(tokens.refreshToken) : null,
        tokenModel: impl.tokenModel,
        expiresAt: tokens.expiresAt ?? null,
        ...(tokens.connectionMeta ? { meta: tokens.connectionMeta } : {}),
        // Queued here, run by the worker: the connect request never waits on the platform's
        // history. Null for a provider that cannot list its posts.
        importState: initialImportState(provider, new Date()),
      })
      .returning({ id: schema.connections.id });
    if (!conn) throw new Error('failed to create connection');
    return conn.id;
  });
}

function serialize(t: AuthTokens): string {
  return JSON.stringify({
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    expiresAt: t.expiresAt?.toISOString(),
  });
}

function deserialize(s: string): AuthTokens {
  const o = JSON.parse(s) as { accessToken: string; refreshToken?: string; expiresAt?: string };
  return {
    accessToken: o.accessToken,
    refreshToken: o.refreshToken,
    expiresAt: o.expiresAt ? new Date(o.expiresAt) : undefined,
    externalId: '',
    displayName: '',
  };
}
