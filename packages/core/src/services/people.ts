import { randomBytes } from 'node:crypto';
import { and, eq, ne, sql } from 'drizzle-orm';
import { db, schema } from '@meegrow-social/db';
import {
  addClientPersonInput,
  type ClientPersonView,
  type CreatedClientPersonView,
} from '@meegrow-social/contracts';
import type { AuthContext } from './auth.js';
import { AccessDeniedError, requireWorkspaceRole } from './access.js';
import { hashPassword } from './password.js';
import { beginAuthAttempt } from './auth-throttle.js';

export class PersonExistsError extends Error {
  constructor() {
    super('that email cannot be added; use a new email');
  }
}

export async function listClientPeople(
  ctx: AuthContext,
  workspaceId: string,
): Promise<ClientPersonView[]> {
  await requireWorkspaceRole(ctx, workspaceId, ['owner']);
  return db()
    .select({
      userId: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      role: schema.memberships.role,
    })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(eq(schema.memberships.workspaceId, workspaceId));
}

/** New identities only: never reset an existing user's credential or attach their other clients. */
export async function addClientPerson(
  ctx: AuthContext,
  workspaceId: string,
  input: unknown,
  clientIp: string,
): Promise<CreatedClientPersonView | { rateLimited: true; retryAfterSeconds: number }> {
  await requireWorkspaceRole(ctx, workspaceId, ['owner']);
  const parsed = addClientPersonInput.parse(input);
  const gate = await beginAuthAttempt('people', { ip: clientIp, account: ctx.userId! });
  if (!gate.allowed) return { rateLimited: true, retryAfterSeconds: gate.retryAfterSeconds };
  // Count successful provisioning too: this is an issuance budget, not a wrong-password budget.
  const temporaryPassword = randomBytes(24).toString('base64url');
  try {
    const passwordHash = await hashPassword(temporaryPassword);
    return await db().transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(sql`lower(${schema.users.email}) = ${parsed.email}`)
        .limit(1);
      if (existing) throw new PersonExistsError();
      const [user] = await tx
        .insert(schema.users)
        .values({ email: parsed.email, passwordHash })
        .returning({ id: schema.users.id, email: schema.users.email, name: schema.users.name });
      if (!user) throw new Error('could not create person');
      await tx
        .insert(schema.memberships)
        .values({ userId: user.id, workspaceId, role: parsed.role });
      return {
        person: { userId: user.id, email: user.email, name: user.name, role: parsed.role },
        temporaryPassword,
      };
    });
  } catch (err) {
    if (
      err instanceof PersonExistsError ||
      (typeof err === 'object' && err && (err as { code?: string }).code === '23505')
    ) {
      throw new PersonExistsError();
    }
    await gate.settle('not_a_guess');
    throw err;
  }
}

/** Cannot remove an owner (or yourself); deletes just this membership and revokes all user sessions. */
export async function removeClientPerson(
  ctx: AuthContext,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  await requireWorkspaceRole(ctx, workspaceId, ['owner']);
  if (userId === ctx.userId) throw new AccessDeniedError();
  return db().transaction(async (tx) => {
    const removed = await tx
      .delete(schema.memberships)
      .where(
        and(
          eq(schema.memberships.workspaceId, workspaceId),
          eq(schema.memberships.userId, userId),
          ne(schema.memberships.role, 'owner'),
        ),
      )
      .returning({ id: schema.memberships.id });
    if (!removed.length) return false;
    await tx.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
    return true;
  });
}
