import { createPostInput, type CreatePostInput, type PostView } from '@meegrow-social/contracts';
import { withWorkspace, schema } from '@meegrow-social/db';
import { eq } from 'drizzle-orm';
import { getScheduler } from './scheduler.js';

function statusFor(mode: CreatePostInput['schedule']): { status: string; publishAt: Date | null } {
  switch (mode.type) {
    case 'draft':
      return { status: 'draft', publishAt: null };
    case 'now':
      return { status: 'scheduled', publishAt: new Date(0) };
    case 'at':
      return { status: 'scheduled', publishAt: mode.publishAt };
    case 'queue':
      // Scaffold: queue slotting resolves to draft until the queue service lands (PRD F3.4).
      return { status: 'draft', publishAt: null };
  }
}

/**
 * Create a post-group and one per-platform child post per variant (PRD F3.1). One call → N posts.
 * If scheduled, hands each post to the scheduler port. Returns the created post views.
 */
export async function createPost(
  workspaceId: string,
  rawInput: CreatePostInput,
  createdBy?: string,
): Promise<PostView[]> {
  const input = createPostInput.parse(rawInput);
  const { status, publishAt } = statusFor(input.schedule);

  const created = await withWorkspace(workspaceId, async (tx) => {
    const [group] = await tx
      .insert(schema.postGroups)
      .values({
        workspaceId,
        caption: input.caption,
        media: input.media,
        createdBy: createdBy ?? null,
      })
      .returning();
    if (!group) throw new Error('failed to create post group');

    const rows = input.variants.map((v) => ({
      workspaceId,
      groupId: group.id,
      connectionId: v.connectionId,
      provider: v.provider,
      status,
      caption: v.caption ?? input.caption,
      media: v.media ?? input.media,
      publishAt,
    }));
    return tx.insert(schema.posts).values(rows).returning();
  });

  if (input.schedule.type === 'now' || input.schedule.type === 'at') {
    const when = input.schedule.type === 'now' ? ('now' as const) : input.schedule.publishAt;
    await Promise.all(
      created.map((p) => getScheduler().schedulePublish({ workspaceId, postId: p.id, when })),
    );
  }

  return created.map(toView);
}

export async function getPost(workspaceId: string, postId: string): Promise<PostView | null> {
  return withWorkspace(workspaceId, async (tx) => {
    const [row] = await tx.select().from(schema.posts).where(eq(schema.posts.id, postId)).limit(1);
    return row ? toView(row) : null;
  });
}

export async function listPosts(workspaceId: string): Promise<PostView[]> {
  return withWorkspace(workspaceId, async (tx) => {
    const rows = await tx.select().from(schema.posts);
    return rows.map(toView);
  });
}

type PostRow = typeof schema.posts.$inferSelect;

function toView(row: PostRow): PostView {
  return {
    id: row.id,
    groupId: row.groupId,
    provider: row.provider as PostView['provider'],
    connectionId: row.connectionId,
    status: row.status as PostView['status'],
    caption: row.caption,
    publishAt: row.publishAt,
    releaseUrl: row.releaseUrl,
    error: row.error,
  };
}
