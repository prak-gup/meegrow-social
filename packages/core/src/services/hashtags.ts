import { eq } from 'drizzle-orm';
import { schema, withWorkspace } from '@meegrow-social/db';
import {
  createHashtagGroupInput,
  updateHashtagGroupInput,
  type CreateHashtagGroupInput,
  type HashtagGroupView,
  type UpdateHashtagGroupInput,
} from '@meegrow-social/contracts';

type HashtagGroupRow = typeof schema.hashtagGroups.$inferSelect;

function toView(row: HashtagGroupRow): HashtagGroupView {
  return { id: row.id, name: row.name, tags: row.tags, createdAt: row.createdAt };
}

export async function createHashtagGroup(
  workspaceId: string,
  rawInput: CreateHashtagGroupInput,
): Promise<HashtagGroupView> {
  const input = createHashtagGroupInput.parse(rawInput);
  return withWorkspace(workspaceId, async (tx) => {
    const [row] = await tx
      .insert(schema.hashtagGroups)
      .values({ workspaceId, name: input.name, tags: input.tags })
      .returning();
    if (!row) throw new Error('failed to create hashtag group');
    return toView(row);
  });
}

export async function listHashtagGroups(workspaceId: string): Promise<HashtagGroupView[]> {
  return withWorkspace(workspaceId, async (tx) => {
    const rows = await tx.select().from(schema.hashtagGroups);
    return rows.map(toView);
  });
}

export async function updateHashtagGroup(
  workspaceId: string,
  groupId: string,
  rawInput: UpdateHashtagGroupInput,
): Promise<HashtagGroupView | null> {
  const input = updateHashtagGroupInput.parse(rawInput);
  return withWorkspace(workspaceId, async (tx) => {
    const [row] = await tx
      .update(schema.hashtagGroups)
      .set(input)
      .where(eq(schema.hashtagGroups.id, groupId))
      .returning();
    return row ? toView(row) : null;
  });
}

export async function deleteHashtagGroup(workspaceId: string, groupId: string): Promise<boolean> {
  return withWorkspace(workspaceId, async (tx) => {
    const rows = await tx
      .delete(schema.hashtagGroups)
      .where(eq(schema.hashtagGroups.id, groupId))
      .returning({ id: schema.hashtagGroups.id });
    return rows.length > 0;
  });
}
