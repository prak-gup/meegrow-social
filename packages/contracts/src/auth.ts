import { z } from 'zod';

export const loginInput = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginInput>;

/**
 * Password policy for a password a user sets (change-password). Length is the only rule: at least
 * 12 characters, and a ceiling so one request cannot make argon2id hash an arbitrarily large input.
 * Lengths are UTF-16 code units, the same thing `String.length` and the browser's `maxlength` count.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
/**
 * Ceiling for a password being *verified* rather than set. Deliberately looser than
 * PASSWORD_MAX_LENGTH: existing passwords (seed script, login) were never length-checked, and a
 * tighter bound here would lock such a user out of changing theirs.
 */
export const PASSWORD_VERIFY_MAX_LENGTH = 1024;

export const newPassword = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

export const changePasswordInput = z
  .object({
    currentPassword: z.string().min(1).max(PASSWORD_VERIFY_MAX_LENGTH),
    newPassword,
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    message: 'new password must differ from the current password',
    path: ['newPassword'],
  });
export type ChangePasswordInput = z.infer<typeof changePasswordInput>;

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
