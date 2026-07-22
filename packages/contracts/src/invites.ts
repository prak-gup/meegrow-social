import { z } from 'zod';
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
