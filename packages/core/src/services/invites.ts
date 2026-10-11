import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
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
  workspaceId: string;
  workspaceName: string;
  provider: ProviderIdentifier;
  providerDisplayName: string;
}

/** Look up a live (unconsumed, unexpired) invite by token — for the public landing page. */
export async function getConnectInvite(token: string): Promise<RedeemedInvite | null> {
  const [row] = await db()
    .select({
      workspaceId: schema.connectInvites.workspaceId,
      provider: schema.connectInvites.provider,
      expiresAt: schema.connectInvites.expiresAt,
      consumedAt: schema.connectInvites.consumedAt,
      workspaceName: schema.workspaces.name,
    })
    .from(schema.connectInvites)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.connectInvites.workspaceId))
    .where(and(eq(schema.connectInvites.token, token), isNull(schema.connectInvites.consumedAt)))
    .limit(1);
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  const providerId = row.provider as ProviderIdentifier;
  return {
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
  const { url, flowId } = await startConnect(invite.workspaceId, invite.provider, appUrl);
  return { url, flowId, proof: signConnectFlow(flowId) };
}
