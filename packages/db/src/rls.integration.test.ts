import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, schema, withWorkspace } from './index.js';
import { createConnection, createWorkspace, resetDb } from '@meegrow-social/testing';
import { eq } from 'drizzle-orm';

// Crown-jewel test (AX-PRD §3 gate 5): FORCE RLS must make cross-tenant access impossible,
// even for the table owner. A failure here blocks any merge.
beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgres://mgs:mgs@localhost:5433/meegrow_social';
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
});
beforeEach(resetDb);
afterAll(closeDb);

describe('row-level tenant isolation', () => {
  it('a workspace can only read its own connections', async () => {
    const a = await createWorkspace('A');
    const b = await createWorkspace('B');
    const connA = await createConnection(a, 'fake', 'A account');
    await createConnection(b, 'fake', 'B account');

    const rows = await withWorkspace(a, (tx) => tx.select().from(schema.connections));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(connA);
    expect(rows[0]?.displayName).toBe('A account');
  });

  it('cannot write a row into another workspace (WITH CHECK)', async () => {
    const a = await createWorkspace('A');
    const b = await createWorkspace('B');
    await expect(
      withWorkspace(a, (tx) =>
        tx.insert(schema.connections).values({
          workspaceId: b, // lying about the tenant
          provider: 'fake',
          externalId: 'x',
          displayName: 'sneaky',
        }),
      ),
    ).rejects.toThrow();
  });

  it('a second workspace cannot read or write the first workspace hashtag groups', async () => {
    const a = await createWorkspace('A');
    const b = await createWorkspace('B');
    const [groupA] = await withWorkspace(a, (tx) =>
      tx.insert(schema.hashtagGroups).values({ workspaceId: a, name: 'A tags' }).returning(),
    );
    expect(groupA?.tags).toEqual([]);

    const visibleToB = await withWorkspace(b, (tx) =>
      tx.select().from(schema.hashtagGroups).where(eq(schema.hashtagGroups.id, groupA!.id)),
    );
    expect(visibleToB).toEqual([]);

    const updatedByB = await withWorkspace(b, (tx) =>
      tx
        .update(schema.hashtagGroups)
        .set({ name: 'stolen' })
        .where(eq(schema.hashtagGroups.id, groupA!.id))
        .returning(),
    );
    expect(updatedByB).toEqual([]);

    await expect(
      withWorkspace(b, (tx) =>
        tx.insert(schema.hashtagGroups).values({ workspaceId: a, name: 'sneaky' }),
      ),
    ).rejects.toThrow();

    const [unchanged] = await withWorkspace(a, (tx) =>
      tx.select().from(schema.hashtagGroups).where(eq(schema.hashtagGroups.id, groupA!.id)),
    );
    expect(unchanged?.name).toBe('A tags');
  });
});
