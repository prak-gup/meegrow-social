import { db, schema } from '@meegrow-social/db';
import { eq } from 'drizzle-orm';
import { verifyPassword } from './password.js';

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
