import { db, schema } from '@meegrow-social/db';
import { and, eq } from 'drizzle-orm';
import { hashPassword, newPasswordProblem, verifyPassword } from './password.js';
import { keepOnlySession } from './sessions.js';

export interface UserView {
  id: string;
  email: string;
  name: string | null;
  /** Workspaces this user can act in — drives the dashboard workspace switcher (#16). */
  memberships: Array<{ workspaceId: string; role: string; name: string; slug: string }>;
}

/** Raw user row lookup by email (identity table, pre-tenant-context → admin handle). */
export async function findUserByEmail(email: string) {
  const [row] = await db()
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);
  return row ?? null;
}

/** Build the dashboard-facing user view: profile + all memberships (joined to workspace name/slug). */
export async function buildUserView(userId: string): Promise<UserView | null> {
  const [user] = await db().select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!user) return null;
  const rows = await db()
    .select({
      workspaceId: schema.memberships.workspaceId,
      role: schema.memberships.role,
      name: schema.workspaces.name,
      slug: schema.workspaces.slug,
    })
    .from(schema.memberships)
    .innerJoin(schema.workspaces, eq(schema.memberships.workspaceId, schema.workspaces.id))
    .where(eq(schema.memberships.userId, userId));
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    memberships: rows.map((r) => ({
      workspaceId: r.workspaceId,
      role: r.role,
      name: r.name,
      slug: r.slug,
    })),
  };
}

/**
 * Verify an email+password credential pair. Returns the user's {id,email,name} on success, or null
 * for an unknown user OR a wrong password OR a user with no password (e.g. Google-SSO-only later).
 * Constant-time on the password check; the user-lookup timing leak is acceptable for v1.
 */
export async function verifyUserCredentials(
  email: string,
  password: string,
): Promise<{ id: string; email: string; name: string | null } | null> {
  const user = await findUserByEmail(email);
  if (!user || !user.passwordHash) return null;
  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok) return null;
  return { id: user.id, email: user.email, name: user.name };
}

export type ChangePasswordFailure =
  /** Wrong current password, unknown user, or a user with no password to change. */
  | 'invalid_current_password'
  /** The new password breaks the length policy (see `newPasswordProblem`). */
  | 'invalid_new_password'
  | 'same_password'
  /** The session that authenticated the request no longer exists; nothing was changed. */
  | 'session_not_found';

export type ChangePasswordResult =
  { ok: true; token: string; expiresAt: Date } | { ok: false; reason: ChangePasswordFailure };

/** Thrown inside the transaction to roll it back with a reason; never escapes `changePassword`. */
class ChangePasswordAbort extends Error {
  constructor(readonly reason: ChangePasswordFailure) {
    super(reason);
  }
}

/**
 * Change a signed-in user's own password. `sessionId` is the session that authenticated the
 * request — there is deliberately no way to call this for a caller without one (API keys have no
 * user). The policy is enforced here as well as in the contract, so no caller can skip it.
 *
 * On success, in ONE transaction: the new argon2id hash is stored, every other session of the user
 * is revoked, and the current session's token is rotated. The caller must hand the returned `token`
 * back as the session cookie — the old one stops working at commit.
 *
 * The hash update is a compare-and-swap on the hash that was just verified, so two concurrent
 * changes cannot both succeed against the same old password. Neither password is logged, stored
 * in plaintext, or put in an error.
 */
export async function changePassword(
  userId: string,
  sessionId: string,
  currentPassword: string,
  newPassword: string,
): Promise<ChangePasswordResult> {
  // Cheap checks first — nothing below runs argon2 for a request that could never succeed.
  if (newPasswordProblem(newPassword)) return { ok: false, reason: 'invalid_new_password' };

  const [user] = await db()
    .select({ passwordHash: schema.users.passwordHash })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  const currentHash = user?.passwordHash;
  if (!currentHash) return { ok: false, reason: 'invalid_current_password' };
  if (!(await verifyPassword(currentHash, currentPassword))) {
    return { ok: false, reason: 'invalid_current_password' };
  }
  // Only reported once the current password is proven, so it reveals nothing to a guesser.
  if (newPassword === currentPassword) return { ok: false, reason: 'same_password' };

  const passwordHash = await hashPassword(newPassword);
  try {
    return await db().transaction(async (tx) => {
      const updated = await tx
        .update(schema.users)
        .set({ passwordHash })
        .where(and(eq(schema.users.id, userId), eq(schema.users.passwordHash, currentHash)))
        .returning({ id: schema.users.id });
      if (updated.length === 0) throw new ChangePasswordAbort('invalid_current_password');
      const session = await keepOnlySession(tx, userId, sessionId);
      if (!session) throw new ChangePasswordAbort('session_not_found');
      return { ok: true as const, ...session };
    });
  } catch (err) {
    if (err instanceof ChangePasswordAbort) return { ok: false, reason: err.reason };
    throw err;
  }
}
