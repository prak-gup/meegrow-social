import { z } from 'zod';
import { providerAccount } from './connections.js';
import { providerIdentifier } from './providers.js';

/**
 * Per-platform connect invites (client onboarding link). An operator mints a link for one client +
 * platform; the client opens the public link and connects their own account into that workspace.
 */

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
