import { createPostInput, type CreatePostInput, type PostView } from '@meegrow-social/contracts';
import { withWorkspace, schema } from '@meegrow-social/db';
import { eq } from 'drizzle-orm';
import { getScheduler } from './scheduler.js';
import { nextFreeSlotForQueue } from './queues.js';

/** Non-queue schedule modes resolve status/publishAt synchronously, no DB access needed. */
function statusFor(mode: Exclude<CreatePostInput['schedule'], { type: 'queue' }>): {
  status: string;
  publishAt: Date | null;
} {
  switch (mode.type) {
    case 'draft':
      return { status: 'draft', publishAt: null };
    case 'now':
      return { status: 'scheduled', publishAt: new Date(0) };
    case 'at':
      return { status: 'scheduled', publishAt: mode.publishAt };
  }
}

/**
 * Create a post-group and one per-platform child post per variant (PRD F3.1). One call → N posts.
 * Queue mode (F3.4) computes the next free timezone-aware slot and applies it to every variant in
 * the group (one group = one slot, mirroring how `at`/`now` apply one publishAt to the whole group).
 * If scheduled (now/at/queue), hands each post to the scheduler port. Returns the created post views.
 */
export async function createPost(
  workspaceId: string,
  rawInput: CreatePostInput,
  createdBy?: string,
): Promise<PostView[]> {
  const input = createPostInput.parse(rawInput);

  let status: string;
  let publishAt: Date | null;
  let queueId: string | null = null;
  /** What to hand the scheduler port; undefined means "don't schedule" (draft). */
  let scheduleWhen: Date | 'now' | undefined;

  if (input.schedule.type === 'queue') {
    queueId = input.schedule.queueId;
    const slot = await nextFreeSlotForQueue(workspaceId, queueId);
    publishAt = slot.publishAt;
    status = 'scheduled';
    scheduleWhen = slot.publishAt;
  } else {
    ({ status, publishAt } = statusFor(input.schedule));
    if (input.schedule.type === 'now') scheduleWhen = 'now';
    else if (input.schedule.type === 'at') scheduleWhen = input.schedule.publishAt;
  }

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
      queueId,
    }));
    return tx.insert(schema.posts).values(rows).returning();
  });

  if (scheduleWhen !== undefined) {
    const when = scheduleWhen;
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
    queueId: row.queueId,
  };
}
