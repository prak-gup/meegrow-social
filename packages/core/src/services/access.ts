import { and, eq } from 'drizzle-orm';
import { db, schema } from '@meegrow-social/db';
import type { AuthContext } from './auth.js';

export class AccessDeniedError extends Error {
  constructor() {
    super('not allowed for this workspace');
  }
}

/** Identity tables have no RLS: always require both the actor and the target workspace. */
export async function requireWorkspaceRole(
  ctx: AuthContext,
  workspaceId: string,
  roles: readonly string[],
): Promise<void> {
  if (!ctx.userId || !ctx.sessionId) throw new AccessDeniedError();
  const [membership] = await db()
    .select({ role: schema.memberships.role })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.userId, ctx.userId),
        eq(schema.memberships.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (!membership || !roles.includes(membership.role)) throw new AccessDeniedError();
}

/** Owners are operators; other client roles cannot bootstrap themselves into ownership. */
export async function requireWorkspaceCreator(userId: string): Promise<void> {
  const [owner] = await db()
    .select({ id: schema.memberships.id })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.role, 'owner')))
    .limit(1);
  if (!owner) throw new AccessDeniedError();
}
