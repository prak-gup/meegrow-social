import { db, schema, withWorkspace } from '@meegrow-social/db';
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import type {
  CallbackResult,
  ConnectionView,
  ConnectionHealth,
  ConnectionHealthStatus,
  ConnectionHealthView,
  ProviderAccountView,
  ProviderIdentifier,
  TokenModel,
} from '@meegrow-social/contracts';
import { getProvider } from '../providers/registry.js';
import { METRIC_RETENTION_DAYS } from './metrics-retention.js';
import type { AuthTokens } from '../providers/types.js';
import { decryptToken, encryptToken, verifyConnectFlowProof } from '../crypto.js';

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
        expiresAt: new Date(Date.now() + ACCOUNT_PICK_TTL_MS),
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
  return { connectionId, displayName: chosen.displayName };
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
    return { status: 'failed', error: err instanceof Error ? err.message : 'could not connect' };
  }
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

/**
 * Account health for every connection of the workspace, or just `connectionIds` when given. Reads
 * stored state only — token expiry, the needs-reconnect flag, the last analytics sweep, the latest
 * failed post. It does NOT call the platform, so it cannot see a token revoked on the platform's
 * side; `source: 'stored'` on every item says so.
 */
export async function listConnectionHealth(
  workspaceId: string,
  connectionIds?: readonly string[],
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
): Promise<ConnectionHealthView | null> {
  const [health] = await listConnectionHealth(workspaceId, [connectionId]);
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
