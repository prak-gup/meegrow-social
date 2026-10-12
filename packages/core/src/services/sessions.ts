import { createHash, randomBytes } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import { db, schema, type Tx } from '@meegrow-social/db';

/** Cookie name carrying the opaque session token. */
export const SESSION_COOKIE = 'mg_sid';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface SessionContext {
  workspaceId: string;
  userId: string;
  sessionId: string;
  role?: string;
}

export interface CreatedSession {
  token: string;
  id: string;
  userId: string;
  activeWorkspaceId: string | null;
  expiresAt: Date;
}

function newSessionToken(): string {
  return randomBytes(32).toString('hex');
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The user's earliest membership — the default workspace a fresh session targets. */
async function firstMembershipWorkspace(userId: string): Promise<string | null> {
  const [m] = await db()
    .select({ workspaceId: schema.memberships.workspaceId })
    .from(schema.memberships)
    .where(eq(schema.memberships.userId, userId))
    .orderBy(schema.memberships.createdAt)
    .limit(1);
  return m?.workspaceId ?? null;
}

/**
 * Create a login session. The cookie-bound `token` is random; only its sha-256 is persisted, so a
 * DB leak yields no usable sessions. The session targets the user's first workspace by default.
 */
export async function createSession(userId: string): Promise<CreatedSession> {
  const activeWorkspaceId = await firstMembershipWorkspace(userId);
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const [row] = await db()
    .insert(schema.sessions)
    .values({ userId, tokenHash: tokenHash(token), activeWorkspaceId, expiresAt })
    .returning();
  if (!row) throw new Error('failed to create session');
  return {
    token,
    id: row.id,
    userId,
    activeWorkspaceId: row.activeWorkspaceId,
    expiresAt: row.expiresAt,
  };
}

/**
 * Resolve a cookie token to a tenant context. Returns null for unknown/expired tokens (expired rows
 * are deleted on touch) or when the user no longer holds the active workspace's membership (e.g.
 * revoked) — so a stale session can never establish tenant scope.
 */
export async function authenticateSession(token: string): Promise<SessionContext | null> {
  const [row] = await db()
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.tokenHash, tokenHash(token)))
    .limit(1);
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    await db().delete(schema.sessions).where(eq(schema.sessions.id, row.id));
    return null;
  }
  if (!row.activeWorkspaceId) return null;
  const [membership] = await db()
    .select()
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.userId, row.userId),
        eq(schema.memberships.workspaceId, row.activeWorkspaceId),
      ),
    )
    .limit(1);
  if (!membership) return null;
  return {
    workspaceId: row.activeWorkspaceId,
    userId: row.userId,
    sessionId: row.id,
    role: membership.role,
  };
}

/** Revoke a session server-side (logout). No-op if already gone. */
export async function revokeSession(sessionId: string): Promise<void> {
  await db().delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
}

/**
 * Rotate a session's token (sliding renewal / credential rotation) without changing its user,
 * workspace, or expiry — the old token is invalidated the moment the row is updated.
 */
export async function rotateSession(
  sessionId: string,
): Promise<{ token: string; expiresAt: Date } | null> {
  const token = newSessionToken();
  const [row] = await db()
    .update(schema.sessions)
    .set({ tokenHash: tokenHash(token) })
    .where(eq(schema.sessions.id, sessionId))
    .returning();
  if (!row) return null;
  return { token, expiresAt: row.expiresAt };
}

/**
 * Session cleanup for a credential change, run inside the caller's transaction so it commits or
 * rolls back with the new credential: every OTHER session of the user is deleted (signed out
 * everywhere else) and this one's token is rotated, the same way `rotateSession` does — so a copy
 * of the pre-change cookie held by anyone else dies too. Expiry is unchanged. Returns null when
 * the session is no longer this user's (logged out meanwhile); the caller must then roll back.
 */
export async function keepOnlySession(
  tx: Tx,
  userId: string,
  sessionId: string,
): Promise<{ token: string; expiresAt: Date } | null> {
  await tx
    .delete(schema.sessions)
    .where(and(eq(schema.sessions.userId, userId), ne(schema.sessions.id, sessionId)));
  const token = newSessionToken();
  const [row] = await tx
    .update(schema.sessions)
    .set({ tokenHash: tokenHash(token) })
    .where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, userId)))
    .returning();
  if (!row) return null;
  return { token, expiresAt: row.expiresAt };
}

/** Does this user belong to this workspace? The gate for acting on a client other than the active one. */
export async function isWorkspaceMember(userId: string, workspaceId: string): Promise<boolean> {
  const [membership] = await db()
    .select({ id: schema.memberships.id })
    .from(schema.memberships)
    .where(
      and(eq(schema.memberships.userId, userId), eq(schema.memberships.workspaceId, workspaceId)),
    )
    .limit(1);
  return membership !== undefined;
}

/** Switch the workspace this session targets. Refuses a workspace the user isn't a member of. */
export async function switchActiveWorkspace(
  sessionId: string,
  userId: string,
  workspaceId: string,
): Promise<boolean> {
  const [membership] = await db()
    .select()
    .from(schema.memberships)
    .where(
      and(eq(schema.memberships.userId, userId), eq(schema.memberships.workspaceId, workspaceId)),
    )
    .limit(1);
  if (!membership) return false;
  await db()
    .update(schema.sessions)
    .set({ activeWorkspaceId: workspaceId })
    .where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, userId)));
  return true;
}
