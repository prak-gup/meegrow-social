import { z } from 'zod';

export const loginInput = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginInput>;

export const switchWorkspaceInput = z.object({
  workspaceId: z.string().uuid(),
});
export type SwitchWorkspaceInput = z.infer<typeof switchWorkspaceInput>;

export const workspaceMembershipView = z.object({
  workspaceId: z.string().uuid(),
  role: z.string(),
  name: z.string(),
  slug: z.string(),
});
export type WorkspaceMembershipView = z.infer<typeof workspaceMembershipView>;

export const userView = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string().nullable(),
  memberships: z.array(workspaceMembershipView),
});
export type UserView = z.infer<typeof userView>;

/** Response shape for login + GET /v1/auth/me: the user, plus the workspace their session targets. */
export const authMeView = z.object({
  user: userView,
  activeWorkspaceId: z.string().uuid().nullable(),
});
export type AuthMeView = z.infer<typeof authMeView>;
