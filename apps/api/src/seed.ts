/**
 * Seed the first owner (issue #10). Invite-only: there is no public signup. Run once per environment
 * after `db:migrate`:
 *   OWNER_EMAIL=… OWNER_PASSWORD=… pnpm --filter @meegrow-social/api seed:owner
 * Idempotent — safe to re-run (resets the owner's password; reuses workspace + membership).
 */
import { and, eq } from 'drizzle-orm';
import { closeDb, db, schema } from '@meegrow-social/db';
import { hashPassword } from '@meegrow-social/core';

async function main(): Promise<void> {
  const email = process.env.OWNER_EMAIL;
  const password = process.env.OWNER_PASSWORD;
  const workspaceName = process.env.WORKSPACE_NAME ?? 'Meegrow';
  if (!email || !password) {
    console.error('OWNER_EMAIL and OWNER_PASSWORD must be set');
    process.exit(1);
  }
  const slug = workspaceName.toLowerCase().replace(/\s+/g, '-');

  const [existingWs] = await db()
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.slug, slug));
  let workspaceId: string;
  if (existingWs) {
    workspaceId = existingWs.id;
  } else {
    const [ws] = await db()
      .insert(schema.workspaces)
      .values({ name: workspaceName, slug })
      .returning();
    if (!ws) throw new Error('failed to create workspace');
    workspaceId = ws.id;
  }

  const passwordHash = await hashPassword(password);
  const [existingUser] = await db()
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, email));
  let userId: string;
  if (existingUser) {
    const [u] = await db()
      .update(schema.users)
      .set({ passwordHash })
      .where(eq(schema.users.id, existingUser.id))
      .returning();
    userId = u!.id;
  } else {
    const [u] = await db()
      .insert(schema.users)
      .values({ email, passwordHash, name: `${workspaceName} Owner` })
      .returning();
    userId = u!.id;
  }

  const [existingMembership] = await db()
    .select()
    .from(schema.memberships)
    .where(
      and(eq(schema.memberships.userId, userId), eq(schema.memberships.workspaceId, workspaceId)),
    );
  if (!existingMembership) {
    await db().insert(schema.memberships).values({ userId, workspaceId, role: 'owner' });
  }

  console.log(`✅ owner ready: ${email} (workspace "${workspaceName}" ${workspaceId})`);
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
