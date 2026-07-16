import { db, schema, withWorkspace } from '@meegrow-social/db';
import { and, eq } from 'drizzle-orm';
import type {
  CallbackResult,
  ConnectionView,
  ConnectionHealth,
  ProviderIdentifier,
  TokenModel,
} from '@meegrow-social/contracts';
import { getProvider } from '../providers/registry.js';
import type { AuthTokens } from '../providers/types.js';
import { decryptToken, encryptToken } from '../crypto.js';

const FLOW_TTL_MS = 10 * 60 * 1000;
/** Refreshable tokens (auto-refresh / refresh-cron) surface 'expiring' within 7d of expiry. */
export const EXPIRING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** One-time tokens can't be auto-refreshed, so they surface 'expiring' earlier (14d) for manual re-auth. */
export const ONE_TIME_EXPIRING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

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

/** Step 1: create a single-use flow row and return the provider auth URL to redirect the user to. */
export async function startConnect(
  workspaceId: string,
  provider: ProviderIdentifier,
  appUrl: string,
): Promise<{ url: string; flowId: string }> {
  const impl = getProvider(provider);
  const redirectUri = callbackUri(appUrl);
  const [flow] = await db()
    .insert(schema.oauthFlows)
    .values({
      workspaceId,
      provider,
      redirectUri,
      status: 'pending',
      expiresAt: new Date(Date.now() + FLOW_TTL_MS),
    })
    .returning();
  if (!flow) throw new Error('failed to create oauth flow');

  const { url, codeVerifier } = await impl.generateAuthUrl({ redirectUri, state: flow.id });
  if (codeVerifier) {
    await db()
      .update(schema.oauthFlows)
      .set({ codeVerifier })
      .where(eq(schema.oauthFlows.id, flow.id));
  }
  return { url, flowId: flow.id };
}

/**
 * Step 2 (public callback): exchange the code. `state` is the opaque flow id — if it doesn't match a
 * live, unconsumed, unexpired flow, we reject (defeats tampering + replay). Single-step providers get
 * a connection immediately; two-step providers return an account list for the finish step.
 */
export async function handleCallback(state: string, code: string): Promise<CallbackResult> {
  const [flow] = await db()
    .select()
    .from(schema.oauthFlows)
    .where(and(eq(schema.oauthFlows.id, state), eq(schema.oauthFlows.status, 'pending')))
    .limit(1);
  if (!flow) throw new Error('invalid, already-used, or unknown connect state');
  if (flow.expiresAt.getTime() < Date.now()) throw new Error('connect flow expired');

  const impl = getProvider(flow.provider as ProviderIdentifier);
  const tokens = await impl.authenticate({
    code,
    codeVerifier: flow.codeVerifier ?? undefined,
    redirectUri: flow.redirectUri,
  });

  if (impl.isBetweenSteps) {
    const accounts = impl.listAccounts ? await impl.listAccounts(tokens) : [];
    await db()
      .update(schema.oauthFlows)
      .set({
        encryptedTokens: encryptToken(serialize(tokens)),
        accounts,
        status: 'awaiting_account',
      })
      .where(eq(schema.oauthFlows.id, flow.id));
    return { status: 'choose_account', flowId: flow.id, accounts };
  }

  const connectionId = await createConnection(
    flow.workspaceId,
    flow.provider as ProviderIdentifier,
    tokens,
    tokens.externalId,
    tokens.displayName,
  );
  await db()
    .update(schema.oauthFlows)
    .set({ status: 'consumed' })
    .where(eq(schema.oauthFlows.id, flow.id));
  return { status: 'connected', connectionId };
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
  if (flow.workspaceId !== workspaceId) throw new Error('flow does not belong to this workspace');
  if (flow.expiresAt.getTime() < Date.now()) throw new Error('connect flow expired');

  const accounts = (flow.accounts as Array<{ externalId: string; displayName: string }>) ?? [];
  const chosen = accounts.find((a) => a.externalId === externalId);
  if (!chosen) throw new Error('chosen account is not one of the offered accounts');
  if (!flow.encryptedTokens) throw new Error('flow is missing tokens');

  const userTokens = deserialize(decryptToken(flow.encryptedTokens));
  // Some two-phase providers must connect the chosen account with account-scoped tokens rather than
  // the user-level ones (Facebook: a Page's own non-expiring Page token). See SocialProvider.
  const impl = getProvider(flow.provider as ProviderIdentifier);
  const tokens = impl.finalizeAccount ? await impl.finalizeAccount(userTokens, chosen) : userTokens;
  const connectionId = await createConnection(
    flow.workspaceId,
    flow.provider as ProviderIdentifier,
    tokens,
    chosen.externalId,
    chosen.displayName,
  );
  await db()
    .update(schema.oauthFlows)
    .set({ status: 'consumed' })
    .where(eq(schema.oauthFlows.id, flow.id));
  return connectionId;
}

export async function listConnections(workspaceId: string): Promise<ConnectionView[]> {
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
    }));
  });
}

export async function deleteConnection(workspaceId: string, id: string): Promise<boolean> {
  return withWorkspace(workspaceId, async (tx) => {
    const deleted = await tx
      .delete(schema.connections)
      .where(eq(schema.connections.id, id))
      .returning({ id: schema.connections.id });
    return deleted.length > 0;
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
