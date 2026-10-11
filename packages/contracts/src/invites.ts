import { z } from 'zod';
import { providerAccount } from './connections.js';
import { connectInputKind, providerIdentifier } from './providers.js';

/**
 * Per-platform connect invites (client onboarding link). An operator mints a link for one client +
 * platform; the client opens the public link and connects their own account into that workspace.
 */

/**
 * Optional body of POST /v1/connections/:provider/invite. `workspaceId` mints for a named client
 * instead of the session's active one (the Clients page lists every client at once); the caller
 * must be a member of it.
 */
export const createInviteInput = z.object({ workspaceId: z.string().uuid().optional() });
export type CreateInviteInput = z.infer<typeof createInviteInput>;

/** Response of POST /v1/connections/:provider/invite — the shareable link. */
export const createdInviteView = z.object({
  url: z.string().url(),
  token: z.string(),
  provider: providerIdentifier,
  expiresAt: z.coerce.date(),
});
export type CreatedInviteView = z.infer<typeof createdInviteView>;

/** Public GET /v1/invite/:token — what the landing page renders. */
export const inviteView = z.object({
  workspaceName: z.string(),
  provider: providerIdentifier,
  providerDisplayName: z.string(),
  /** Set when the landing page must ask something (a site address) before Connect can work. */
  connectInput: connectInputKind.optional(),
});
export type InviteView = z.infer<typeof inviteView>;

/**
 * Public GET /v1/invite/flow/:flowId — the account picker a client lands on after approving on the
 * platform. `accounts` may be empty: the platform login returned nothing this person can connect.
 */
export const inviteFlowView = inviteView.extend({ accounts: z.array(providerAccount) });
export type InviteFlowView = z.infer<typeof inviteFlowView>;

/** Body of public POST /v1/invite/flow/:flowId/finish — the account the client picked. */
export const finishInviteFlowInput = z.object({ externalId: z.string().min(1) });
export type FinishInviteFlowInput = z.infer<typeof finishInviteFlowInput>;

/** Response of that finish call: a connection now exists, and this is what it joined to what. */
export const inviteConnectedView = z.object({
  connectionId: z.string().uuid(),
  accountName: z.string(),
  workspaceName: z.string(),
  providerDisplayName: z.string(),
});
export type InviteConnectedView = z.infer<typeof inviteConnectedView>;

/**
 * Query of GET /v1/connections/invites and DELETE /v1/connections/invites/:id. `workspaceId` names
 * a client other than the session's active one, under the same membership rule as the mint route.
 */
export const inviteScopeQuery = z.object({ workspaceId: z.string().uuid().optional() });
export type InviteScopeQuery = z.infer<typeof inviteScopeQuery>;

/** The `:id` of DELETE /v1/connections/invites/:id. */
export const inviteIdParam = z.string().uuid();

/**
 * One link that still works: not yet used for a connection, not cancelled, not expired.
 * `lastStartedAt` is when someone last opened it and went on to the platform without finishing.
 */
export const outstandingInviteView = z.object({
  id: z.string().uuid(),
  url: z.string().url(),
  provider: providerIdentifier,
  createdAt: z.coerce.date(),
  expiresAt: z.coerce.date(),
  lastStartedAt: z.coerce.date().nullable(),
});
export type OutstandingInviteView = z.infer<typeof outstandingInviteView>;
