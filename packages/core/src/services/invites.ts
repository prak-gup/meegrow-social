import { randomBytes } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, max } from 'drizzle-orm';
import { db, schema } from '@meegrow-social/db';
import type { ProviderIdentifier } from '@meegrow-social/contracts';
import { getProvider } from '../providers/registry.js';
import { signConnectFlow } from '../crypto.js';
import { startConnect } from './connections.js';

/**
 * Per-platform connect invites (client onboarding). The operator mints a link for a
 * {workspace, provider}; the client opens the PUBLIC link and runs the OAuth, which connects the
 * account into that workspace. The token is the credential — no session on the client's side — so
 * redemption is by opaque token on the admin handle (this table is non-tenant, like oauth_flows).
 *
 * A link lives until the first of: 14 days, an operator cancelling it (`revokeConnectInvite`), or
 * the first successful connection made through it (`consumedAt`, set in connections.ts). Until then
 * it can be opened again, so a client who gives up halfway or picks nothing can retry.
 *
 * Note: for a Meta account the client doesn't already have a role on, the grant still requires the
 * app's Advanced Access / Tech-Provider approval (#53). This plumbing is ready for that; until then
 * it works for accounts the operator can already reach.
 */

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export interface CreatedInvite {
  token: string;
  provider: ProviderIdentifier;
  expiresAt: Date;
}

/** Mint an invite for a workspace + provider. Validates the provider is real (registered). */
export async function createConnectInvite(
  workspaceId: string,
  provider: ProviderIdentifier,
  createdBy: string,
): Promise<CreatedInvite> {
  getProvider(provider); // throws if the provider isn't registered in this environment
  const token = randomBytes(18).toString('base64url');
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const [row] = await db()
    .insert(schema.connectInvites)
    .values({ token, workspaceId, provider, createdBy, expiresAt })
    .returning();
  if (!row) throw new Error('failed to create invite');
  return {
    token: row.token,
    provider: row.provider as ProviderIdentifier,
    expiresAt: row.expiresAt,
  };
}

export interface RedeemedInvite {
  id: string;
  workspaceId: string;
  workspaceName: string;
  provider: ProviderIdentifier;
  providerDisplayName: string;
}

/** Look up a live (unused, uncancelled, unexpired) invite by token — for the public landing page. */
export async function getConnectInvite(token: string): Promise<RedeemedInvite | null> {
  const [row] = await db()
    .select({
      id: schema.connectInvites.id,
      workspaceId: schema.connectInvites.workspaceId,
      provider: schema.connectInvites.provider,
      expiresAt: schema.connectInvites.expiresAt,
      consumedAt: schema.connectInvites.consumedAt,
      workspaceName: schema.workspaces.name,
    })
    .from(schema.connectInvites)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.connectInvites.workspaceId))
    .where(
      and(
        eq(schema.connectInvites.token, token),
        isNull(schema.connectInvites.consumedAt),
        isNull(schema.connectInvites.revokedAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  const providerId = row.provider as ProviderIdentifier;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
    provider: providerId,
    providerDisplayName: getProvider(providerId).displayName,
  };
}

/**
 * The client clicked Connect on the invite landing: start the OAuth for the invite's workspace +
 * provider. `proof` goes to that browser as an HttpOnly cookie and is what later lets it — and only
 * it — pick the account without a session (see `finishInviteConnect`). Null for a dead invite.
 */
export async function startInviteConnect(
  token: string,
  appUrl: string,
): Promise<{ url: string; flowId: string; proof: string } | null> {
  const invite = await getConnectInvite(token);
  if (!invite) return null;
  const { url, flowId } = await startConnect(
    invite.workspaceId,
    invite.provider,
    appUrl,
    invite.id,
  );
  return { url, flowId, proof: signConnectFlow(flowId) };
}

export interface OutstandingInvite {
  id: string;
  token: string;
  provider: ProviderIdentifier;
  createdAt: Date;
  expiresAt: Date;
  /**
   * When someone last opened the link and went on to the platform, or null if nobody has. A link
   * that connected an account is no longer outstanding, so this is always "started, not finished".
   */
  lastStartedAt: Date | null;
}

/**
 * A workspace's links that still work — unused, uncancelled, unexpired — newest first. The token is
 * included so the operator can copy the link again; it is no more than they were shown at mint.
 */
export async function listConnectInvites(workspaceId: string): Promise<OutstandingInvite[]> {
  const rows = await db()
    .select()
    .from(schema.connectInvites)
    .where(
      and(
        eq(schema.connectInvites.workspaceId, workspaceId),
        isNull(schema.connectInvites.consumedAt),
        isNull(schema.connectInvites.revokedAt),
        gt(schema.connectInvites.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(schema.connectInvites.createdAt));
  if (rows.length === 0) return [];

  const started = await db()
    .select({ inviteId: schema.oauthFlows.inviteId, at: max(schema.oauthFlows.createdAt) })
    .from(schema.oauthFlows)
    .where(
      inArray(
        schema.oauthFlows.inviteId,
        rows.map((r) => r.id),
      ),
    )
    .groupBy(schema.oauthFlows.inviteId);
  const startedAt = new Map(started.map((s) => [s.inviteId, s.at]));

  return rows.map((r) => ({
    id: r.id,
    token: r.token,
    provider: r.provider as ProviderIdentifier,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    lastStartedAt: startedAt.get(r.id) ?? null,
  }));
}

/**
 * Cancel a link: it stops opening, and a flow already started from it can no longer connect
 * anything. False when this workspace has no such live link — another workspace's invite and one
 * that never existed get the same answer.
 */
export async function revokeConnectInvite(workspaceId: string, inviteId: string): Promise<boolean> {
  const revoked = await db()
    .update(schema.connectInvites)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.connectInvites.id, inviteId),
        eq(schema.connectInvites.workspaceId, workspaceId),
        isNull(schema.connectInvites.consumedAt),
        isNull(schema.connectInvites.revokedAt),
      ),
    )
    .returning({ id: schema.connectInvites.id });
  return revoked.length > 0;
}
