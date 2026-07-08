import {
  createPostInput,
  listPostsQuery,
  type CalendarPostsQuery,
  type CalendarView,
  type CreatePostInput,
  type ListPostsQuery,
  type MediaRef,
  type PostGroupView,
  type PostView,
  type UpdatePostInput,
} from '@meegrow-social/contracts';
import { withWorkspace, schema } from '@meegrow-social/db';
import { and, asc, eq, gte, isNotNull, lte, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { getScheduler } from './scheduler.js';
import { nextFreeSlotForQueue } from './queues.js';

/** Thrown when a lifecycle op targets a post in a state that doesn't allow it (→ 409 in the API). */
export class PostStateError extends Error {}

const CANCELABLE_STATUSES = new Set(['draft', 'scheduled']);
const EDITABLE_STATUSES = new Set(['draft', 'scheduled']);

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

/**
 * Filterable post list (PRD F3.6). Stable ordering (publishAt asc nulls-last, then createdAt, then
 * id) so pagination is deterministic; offset pagination. Filters are optional single values.
 */
export async function listPosts(
  workspaceId: string,
  query: ListPostsQuery = listPostsQuery.parse({}),
): Promise<PostView[]> {
  return withWorkspace(workspaceId, async (tx) => {
    // RLS scopes to this workspace — no explicit workspaceId predicate needed. `and()` ignores
    // undefined args, so inactive filters simply drop out.
    const rows = await tx
      .select()
      .from(schema.posts)
      .where(
        and(
          query.status ? eq(schema.posts.status, query.status) : undefined,
          query.provider ? eq(schema.posts.provider, query.provider) : undefined,
          query.connectionId ? eq(schema.posts.connectionId, query.connectionId) : undefined,
          query.from ? gte(schema.posts.publishAt, query.from) : undefined,
          query.to ? lte(schema.posts.publishAt, query.to) : undefined,
        ),
      )
      .orderBy(
        sql`${schema.posts.publishAt} asc nulls last`,
        asc(schema.posts.createdAt),
        asc(schema.posts.id),
      )
      .limit(query.limit)
      .offset(query.offset);
    return rows.map(toView);
  });
}

/**
 * Cancel a draft/scheduled post (PRD F3.5): marks it cancelled AND interrupts its pending BullMQ job
 * via the scheduler port (no-op if the job already fired). Rejects posts past the point of no return.
 */
export async function cancelPost(workspaceId: string, postId: string): Promise<boolean> {
  const outcome = await withWorkspace(workspaceId, async (tx) => {
    const [row] = await tx
      .select({ status: schema.posts.status })
      .from(schema.posts)
      .where(eq(schema.posts.id, postId))
      .limit(1);
    if (!row) return 'missing' as const;
    if (!CANCELABLE_STATUSES.has(row.status)) return row.status;
    await tx.update(schema.posts).set({ status: 'cancelled' }).where(eq(schema.posts.id, postId));
    return 'cancelled' as const;
  });
  if (outcome === 'missing') return false;
  if (outcome !== 'cancelled') {
    throw new PostStateError(`a '${outcome}' post cannot be cancelled`);
  }
  await getScheduler().cancelPublish({ postId });
  return true;
}

/**
 * Edit a draft/scheduled post (PRD F3.5). caption/media update in place; publishAt is tri-state —
 * a date (re)schedules the job, null demotes to draft + cancels the job, omitted leaves it. The job
 * side-effects run AFTER the tx commits so a failed reschedule never half-edits the row.
 */
export async function updatePost(
  workspaceId: string,
  postId: string,
  patch: UpdatePostInput,
): Promise<PostView | null> {
  type Action = 'none' | 'schedule' | 'cancel' | 'reschedule';
  const result = await withWorkspace(workspaceId, async (tx) => {
    const [row] = await tx.select().from(schema.posts).where(eq(schema.posts.id, postId)).limit(1);
    if (!row) return null;
    if (!EDITABLE_STATUSES.has(row.status)) {
      throw new PostStateError(`a '${row.status}' post cannot be edited`);
    }

    const set: Record<string, unknown> = {};
    if (patch.caption !== undefined) set.caption = patch.caption;
    if (patch.media !== undefined) set.media = patch.media;

    let action: Action = 'none';
    let when: Date | null = null;
    if (patch.publishAt !== undefined) {
      if (patch.publishAt === null) {
        set.status = 'draft';
        set.publishAt = null;
        action = 'cancel';
      } else {
        set.status = 'scheduled';
        set.publishAt = patch.publishAt;
        action = row.status === 'scheduled' ? 'reschedule' : 'schedule';
        when = patch.publishAt;
      }
    }

    const [updated] = await tx
      .update(schema.posts)
      .set(set)
      .where(eq(schema.posts.id, postId))
      .returning();
    return { updated: updated!, action, when };
  });
  if (!result) return null;

  if (result.action === 'cancel' || result.action === 'reschedule') {
    await getScheduler().cancelPublish({ postId });
  }
  if (result.action === 'schedule' || result.action === 'reschedule') {
    await getScheduler().schedulePublish({ workspaceId, postId, when: result.when! });
  }
  return toView(result.updated);
}

/** Day-bucketed posts for a month window in the requested timezone (PRD F3.6 calendar). */
export async function calendarPosts(
  workspaceId: string,
  query: CalendarPostsQuery,
): Promise<CalendarView> {
  const zone = query.timezone;
  const monthStart = DateTime.fromObject(
    { year: query.year, month: query.month, day: 1 },
    { zone },
  ).startOf('month');
  const fromUtc = monthStart.toUTC().toJSDate();
  const toUtc = monthStart.endOf('month').toUTC().toJSDate();

  const rows = await withWorkspace(workspaceId, async (tx) =>
    tx
      .select()
      .from(schema.posts)
      .where(
        and(
          isNotNull(schema.posts.publishAt),
          gte(schema.posts.publishAt, fromUtc),
          lte(schema.posts.publishAt, toUtc),
        ),
      ),
  );

  const buckets = new Map<string, PostView[]>();
  for (const r of rows) {
    const date = DateTime.fromJSDate(r.publishAt!, { zone }).toFormat('yyyy-MM-dd');
    const bucket = buckets.get(date) ?? [];
    bucket.push(toView(r));
    buckets.set(date, bucket);
  }
  const days = [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, posts]) => ({ date, posts }));
  return { days };
}

/** A post-group with all its per-platform children (PRD F3.1/F3.6). */
export async function getPostGroup(
  workspaceId: string,
  groupId: string,
): Promise<PostGroupView | null> {
  return withWorkspace(workspaceId, async (tx) => {
    const [group] = await tx
      .select()
      .from(schema.postGroups)
      .where(eq(schema.postGroups.id, groupId))
      .limit(1);
    if (!group) return null;
    const posts = await tx
      .select()
      .from(schema.posts)
      .where(eq(schema.posts.groupId, groupId))
      .orderBy(asc(schema.posts.createdAt), asc(schema.posts.id));
    return {
      id: group.id,
      caption: group.caption,
      media: (group.media as MediaRef[] | null) ?? [],
      createdAt: group.createdAt,
      posts: posts.map(toView),
    };
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
    createdAt: row.createdAt,
  };
}
