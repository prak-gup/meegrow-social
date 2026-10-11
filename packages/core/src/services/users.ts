import { db, schema } from '@meegrow-social/db';
import { and, eq } from 'drizzle-orm';
import { hashPassword, newPasswordProblem, verifyPassword } from './password.js';
import { keepOnlySession } from './sessions.js';
import { beginAuthAttempt, type AttemptResult } from './auth-throttle.js';

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

/** A password check refused because too many wrong ones came before it (→ 429 + Retry-After). */
export interface RateLimited {
  ok: false;
  reason: 'rate_limited';
  retryAfterSeconds: number;
}

export type LoginResult =
  | { ok: true; user: { id: string; email: string; name: string | null } }
  /** Unknown user, wrong password, or a user with no password — deliberately indistinguishable. */
  | { ok: false; reason: 'invalid_credentials' }
  | RateLimited;

/**
 * `verifyUserCredentials` behind the brute-force limits (see auth-throttle.ts) — what the login
 * route calls. Limited per client IP and per submitted email; the email is folded to lower case
 * for counting only, so case variants of one address share a budget.
 *
 * A rate-limited attempt is refused before the password is looked at, and reads the same for a
 * real account as for an unknown one. A successful login clears that account's count.
 */
export async function loginWithPassword(
  email: string,
  password: string,
  clientIp: string,
): Promise<LoginResult> {
  const gate = await beginAuthAttempt('login', {
    ip: clientIp,
    account: email.trim().toLowerCase(),
  });
  if (!gate.allowed) {
    return { ok: false, reason: 'rate_limited', retryAfterSeconds: gate.retryAfterSeconds };
  }
  let user: Awaited<ReturnType<typeof verifyUserCredentials>>;
  try {
    user = await verifyUserCredentials(email, password);
  } catch (err) {
    // A lookup that blew up was not a wrong guess; an outage must not use up anyone's attempts.
    await gate.settle('not_a_guess');
    throw err;
  }
  await gate.settle(user ? 'succeeded' : 'failed');
  return user ? { ok: true, user } : { ok: false, reason: 'invalid_credentials' };
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

/** How each `changePassword` outcome counts against the brute-force limits. */
function changePasswordAttemptResult(result: ChangePasswordResult): AttemptResult {
  if (result.ok) return 'succeeded';
  switch (result.reason) {
    case 'invalid_current_password':
      return 'failed';
    // Refused before the current password was looked at, so nothing was guessed.
    case 'invalid_new_password':
      return 'not_a_guess';
    // Both are only reported once the current password has been proven.
    case 'same_password':
    case 'session_not_found':
      return 'succeeded';
  }
}

/**
 * `changePassword` behind the brute-force limits (see auth-throttle.ts) — what the route calls.
 * Limited per client IP and per user: a stolen session cookie must not be a free oracle for the
 * account's password. A rate-limited attempt is refused before any password is looked at.
 */
export async function changePasswordWithLimit(
  userId: string,
  sessionId: string,
  currentPassword: string,
  newPassword: string,
  clientIp: string,
): Promise<ChangePasswordResult | RateLimited> {
  const gate = await beginAuthAttempt('password', { ip: clientIp, account: userId });
  if (!gate.allowed) {
    return { ok: false, reason: 'rate_limited', retryAfterSeconds: gate.retryAfterSeconds };
  }
  let result: ChangePasswordResult;
  try {
    result = await changePassword(userId, sessionId, currentPassword, newPassword);
  } catch (err) {
    await gate.settle('not_a_guess');
    throw err;
  }
  await gate.settle(changePasswordAttemptResult(result));
  return result;
}
