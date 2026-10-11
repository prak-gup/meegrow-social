import {
  createPostInput,
  groupDisplayStatus,
  listPostGroupsQuery,
  listPostsQuery,
  type CalendarPostsQuery,
  type CalendarView,
  type CreatePostInput,
  type ListPostGroupsQuery,
  type ListPostsQuery,
  captionLimitForProvider,
  optionsArmForProvider,
  parseStoredOptions,
  type MediaRef,
  type PostGroupSummary,
  type PostGroupView,
  type PostMediaView,
  type PostOptions,
  type PostVariant,
  type PostView,
  type UpdatePostInput,
} from '@meegrow-social/contracts';
import { withWorkspace, schema, type Tx } from '@meegrow-social/db';
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, lte, ne, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { getScheduler } from './scheduler.js';
import { nextFreeSlotForQueue } from './queues.js';
import { ConnectionNotFoundError, findMissingConnectionIds } from './connections.js';
import { tryGetProvider } from '../providers/registry.js';
import { ProviderBadRequestError } from '../errors.js';

/** Thrown when a lifecycle op targets a post in a state that doesn't allow it (→ 409 in the API). */
export class PostStateError extends Error {}

/** `posts.source` of a post found on the platform by a past-post import (`post-import.ts`). */
export const IMPORTED_SOURCE = 'imported';

/**
 * An imported post is already live on the platform and was never ours to send: it cannot be
 * edited, rescheduled, cancelled or retried here. Checked before the status in every lifecycle
 * call, so the reason given is this one and not a status that merely happens to refuse it.
 */
function assertNotImported(row: { source: string }, verb: string): void {
  if (row.source === IMPORTED_SOURCE) {
    throw new PostStateError(
      `an imported post cannot be ${verb}: it was published on the platform, not by this app`,
    );
  }
}

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
      return { status: 'scheduled', publishAt: null };
    case 'at':
      return { status: 'scheduled', publishAt: mode.publishAt };
  }
}

/**
 * Run every variant past its own provider's rules BEFORE anything is stored (#44). Contracts have
 * already validated the *shape* of `options`; this is where platform semantics land — YouTube needs
 * exactly one video, a GBP EVENT needs dates, a CALL button takes no url.
 *
 * At create time deliberately: a scheduled post whose rules are only checked in the worker fails
 * hours later, after the client believes it is booked.
 *
 * NB the media refs here may not carry resolved public URLs yet — `publish.ts` resolves those — so
 * a provider's check must key off `kind` and arity, never `url`.
 */
function assertVariantsPublishable(input: CreatePostInput): void {
  for (const v of input.variants) assertVariantPublishable(input, v);
}

/** One variant of `assertVariantsPublishable` — exported so the dry run reports per variant. */
export function assertVariantPublishable(input: CreatePostInput, v: PostVariant): void {
  // Non-throwing lookup: an unconfigured provider must not change what the API accepts, or CI
  // (fakes only, no platform secrets) would diverge from production.
  const provider = tryGetProvider(v.provider);
  if (!provider?.assertPublishable) return;
  provider.assertPublishable([
    {
      caption: v.caption ?? input.caption,
      media: v.media ?? input.media,
      options: v.options,
    },
  ]);
}

/**
 * The edit-time twin of `assertVariantsPublishable` (#44). A patch carries options but no provider,
 * so the `postVariant` refinement can't run — the arm is re-checked against the stored row here.
 */
function assertPatchPublishable(row: PostRow, patch: UpdatePostInput): void {
  const provider = row.provider as PostView['provider'];
  // `updatePostInput` only bounds a caption at the article-body limit: the patch names no provider.
  const limit = captionLimitForProvider(provider);
  if (patch.caption !== undefined && patch.caption.length > limit) {
    throw new ProviderBadRequestError(
      `caption is ${patch.caption.length} characters; "${provider}" takes at most ${limit}`,
    );
  }
  if (patch.options !== undefined) {
    const arm = optionsArmForProvider(provider);
    if (!arm) {
      throw new ProviderBadRequestError(`"${provider}" takes no per-platform options`);
    }
    if (patch.options.kind !== arm) {
      throw new ProviderBadRequestError(
        `"${provider}" needs options.kind "${arm}", got "${patch.options.kind}"`,
      );
    }
  }
  const impl = tryGetProvider(provider);
  if (!impl?.assertPublishable) return;
  impl.assertPublishable([
    {
      caption: patch.caption ?? row.caption,
      media: patch.media ?? (row.media as MediaRef[] | null) ?? [],
      options: patch.options ?? parseStoredOptions(row.options) ?? undefined,
    },
  ]);
}

export interface CreatePostMeta {
  /** User id to attribute the group to. */
  createdBy?: string;
  /**
   * Caller-supplied idempotency key (D2). When present, a second create with the same key returns
   * the FIRST call's posts and writes nothing. Scoped per workspace by a partial unique index on
   * `post_groups`.
   */
  idempotencyKey?: string;
}

/** Postgres unique-violation. Drizzle surfaces the driver error unchanged. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/** Every post of the group that owns `idempotencyKey`, or null when the key is unused. */
async function findByIdempotencyKey(
  workspaceId: string,
  idempotencyKey: string,
): Promise<PostView[] | null> {
  return withWorkspace(workspaceId, async (tx) => {
    const [group] = await tx
      .select({ id: schema.postGroups.id })
      .from(schema.postGroups)
      .where(eq(schema.postGroups.idempotencyKey, idempotencyKey))
      .limit(1);
    if (!group) return null;
    const rows = await tx
      .select()
      .from(schema.posts)
      .where(eq(schema.posts.groupId, group.id))
      .orderBy(asc(schema.posts.createdAt), asc(schema.posts.id));
    return toViews(tx, rows);
  });
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
  meta: CreatePostMeta = {},
): Promise<PostView[]> {
  const input = createPostInput.parse(rawInput);
  assertVariantsPublishable(input);
  const { createdBy, idempotencyKey } = meta;

  // Fast path: a key we have already served. Checked BEFORE the queue-slot computation below,
  // because slotting is a side-effecting read (it consumes the next free slot) and a replay must
  // not move the queue on.
  if (idempotencyKey) {
    const replay = await findByIdempotencyKey(workspaceId, idempotencyKey);
    if (replay) return replay;
  }

  // Every variant must target a connection of THIS workspace. `posts.connection_id` has no FK, so
  // without this a post naming another tenant's (or a made-up) connection was stored and only
  // failed hours later, in the worker. After the replay check: a replay must still return its
  // posts when the connection has since been removed.
  const [missing] = await findMissingConnectionIds(
    workspaceId,
    input.variants.map((v) => v.connectionId),
  );
  if (missing) throw new ConnectionNotFoundError(`connection ${missing} not found`);

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

  const insertGroupAndPosts = () =>
    withWorkspace(workspaceId, async (tx) => {
      const [group] = await tx
        .insert(schema.postGroups)
        .values({
          workspaceId,
          caption: input.caption,
          media: input.media,
          idempotencyKey: idempotencyKey ?? null,
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
        // Options are per-platform by definition, so they never inherit from the group (#44).
        options: v.options ?? null,
        publishAt,
        queueId,
      }));
      return toViews(tx, await tx.insert(schema.posts).values(rows).returning());
    });

  let created: Awaited<ReturnType<typeof insertGroupAndPosts>>;
  try {
    created = await insertGroupAndPosts();
  } catch (err) {
    // Concurrent create with the same key: the index picked a winner and we are not it. Serve the
    // winner's posts rather than failing the caller — a retry storm is exactly what a key is for.
    if (idempotencyKey && isUniqueViolation(err)) {
      const replay = await findByIdempotencyKey(workspaceId, idempotencyKey);
      if (replay) return replay;
    }
    throw err;
  }

  if (scheduleWhen !== undefined) {
    const when = scheduleWhen;
    // The rows are committed; only now can the jobs be enqueued. allSettled, so every enqueue is
    // attempted and none is left running when the failure is handled (async, so a scheduler that
    // throws synchronously — not configured — is handled the same way).
    const enqueued = await Promise.allSettled(
      created.map(async (p) => getScheduler().schedulePublish({ workspaceId, postId: p.id, when })),
    );
    const failure = enqueued.find((r) => r.status === 'rejected');
    if (failure) {
      await abandonUnqueuedPosts(
        workspaceId,
        created.map((p) => p.id),
        failure.reason,
      );
      throw failure.reason;
    }
  }

  return created;
}

/** The error a user sees on a post that was stored but could not be handed to the job queue. */
export function unqueuedPublishMessage(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return `Could not be queued for publishing: ${detail || 'unknown error'}. Nothing was sent — retry to queue it again.`;
}

/**
 * Called when enqueueing a publish job threw AFTER the posts were committed. Without this the
 * posts read `scheduled` with no job behind them: the dashboard promises a publish that will never
 * happen. Every post of the call that is still `scheduled` is marked `failed` with the reason, so
 * the caller's error means "nothing from this call will go out" and each post can be retried.
 *
 * All of them, not only the ones whose enqueue threw: the caller sees one error for the call, and
 * a caller that repeats the call must not get a second copy of a sibling that did enqueue. The
 * status is what stops a sibling's job (`publishPost` refuses a `failed` post); removing the jobs
 * is tidying. A sibling a worker has already picked up holds its row lock, is not `scheduled` by
 * the time the update reaches it, and is left to finish.
 *
 * Never throws — the caller rethrows the enqueue error. If the write itself fails the posts stay
 * `scheduled` with no job, which is what `sweepStrandedPublishes` exists to resolve.
 */
export async function abandonUnqueuedPosts(
  workspaceId: string,
  postIds: string[],
  cause: unknown,
): Promise<void> {
  const message = unqueuedPublishMessage(cause);
  try {
    await withWorkspace(workspaceId, async (tx) => {
      const failed = await tx
        .update(schema.posts)
        .set({ status: 'failed', error: message })
        .where(and(inArray(schema.posts.id, postIds), eq(schema.posts.status, 'scheduled')))
        .returning({ provider: schema.posts.provider });
      if (failed.length === 0) return;
      await tx.insert(schema.eventLogs).values(
        failed.map((p) => ({
          workspaceId,
          kind: 'publish',
          status: 'failed',
          platform: p.provider,
          message,
        })),
      );
    });
  } catch {
    // Left for the sweep; see above.
  }
  await Promise.allSettled(postIds.map(async (postId) => getScheduler().cancelPublish({ postId })));
}

export async function getPost(workspaceId: string, postId: string): Promise<PostView | null> {
  return withWorkspace(workspaceId, async (tx) => {
    const [row] = await tx.select().from(schema.posts).where(eq(schema.posts.id, postId)).limit(1);
    return row ? ((await toViews(tx, [row]))[0] ?? null) : null;
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
          query.source ? eq(schema.posts.source, query.source) : undefined,
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
    return toViews(tx, rows);
  });
}

/**
 * Cancel a draft/scheduled post (PRD F3.5): marks it cancelled AND interrupts its pending BullMQ job
 * via the scheduler port (no-op if the job already fired). Rejects posts past the point of no return.
 *
 * The status write is what stops the post going out: `publishPost` refuses anything not `scheduled`,
 * so a job that could not be removed (already running, or Redis unreachable) does nothing.
 */
export async function cancelPost(workspaceId: string, postId: string): Promise<boolean> {
  const outcome = await withWorkspace(workspaceId, async (tx) => {
    // Row lock: a publish job that already holds this post finishes first, and we then read what it
    // committed — so a post that just went out is refused below, never overwritten as `cancelled`.
    const [row] = await tx
      .select({ status: schema.posts.status, source: schema.posts.source })
      .from(schema.posts)
      .where(eq(schema.posts.id, postId))
      .limit(1)
      .for('update');
    if (!row) return 'missing' as const;
    assertNotImported(row, 'cancelled');
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
 * side-effects run AFTER the tx commits so a failed reschedule never half-edits the row; if the
 * job cannot be (re)scheduled the edit stands but the post is marked `failed` and the error rethrown.
 */
export async function updatePost(
  workspaceId: string,
  postId: string,
  patch: UpdatePostInput,
): Promise<PostView | null> {
  type Action = 'none' | 'schedule' | 'cancel' | 'reschedule';
  const result = await withWorkspace(workspaceId, async (tx) => {
    // Row lock, for the same reason as `cancelPost`: an edit must not land on top of a publish that
    // is in flight and turn a published post back into a draft or a scheduled one.
    const [row] = await tx
      .select()
      .from(schema.posts)
      .where(eq(schema.posts.id, postId))
      .limit(1)
      .for('update');
    if (!row) return null;
    assertNotImported(row, 'edited or rescheduled');
    if (!EDITABLE_STATUSES.has(row.status)) {
      throw new PostStateError(`a '${row.status}' post cannot be edited`);
    }

    assertPatchPublishable(row, patch);

    const set: Record<string, unknown> = {};
    if (patch.caption !== undefined) set.caption = patch.caption;
    if (patch.media !== undefined) set.media = patch.media;
    if (patch.options !== undefined) set.options = patch.options;

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
    return { updated: (await toViews(tx, [updated!]))[0]!, action, when };
  });
  if (!result) return null;

  if (result.action === 'cancel') {
    // Demoted to draft. If this throws the job survives, but `publishPost` refuses a draft.
    await getScheduler().cancelPublish({ postId });
  }
  if (result.action === 'schedule' || result.action === 'reschedule') {
    try {
      if (result.action === 'reschedule') await getScheduler().cancelPublish({ postId });
      await getScheduler().schedulePublish({ workspaceId, postId, when: result.when! });
    } catch (err) {
      // The new time is committed but no job stands behind it (or the old job still holds the old
      // time). Fail it where it can be seen and retried rather than leave it to go out at the
      // wrong time or not at all.
      await abandonUnqueuedPosts(workspaceId, [postId], err);
      throw err;
    }
  }
  return result.updated;
}

/**
 * Retry a `failed` post: put it back to `scheduled` and hand it to the scheduler — to publish now,
 * or at its `publishAt` when that is still ahead (a post that failed to be queued for tomorrow must
 * not go out today because someone pressed retry; `publishPost` would refuse it as not due anyway).
 * It goes through the same job → `publishPost` path as a first attempt, never inline. Any other
 * status is a `PostStateError`; `failed` is the only failure status — there is no partial one,
 * because every variant is its own post and is retried on its own.
 *
 * Cannot double-post a variant that went out: `published` is refused here, the flip
 * happens under a row lock (so of two concurrent retries exactly one enqueues), and
 * `publishPost` itself no-ops on a published post. What it CANNOT see is a post the platform
 * accepted but that was recorded as failed (the provider threw after the platform took it) — that
 * is indistinguishable from a real failure in stored state, and a retry publishes it again.
 */
export async function retryPost(workspaceId: string, postId: string): Promise<PostView | null> {
  const outcome = await withWorkspace(workspaceId, async (tx) => {
    // Row lock: a concurrent retry waits here, then reads `scheduled` and is refused below.
    const [row] = await tx
      .select({
        status: schema.posts.status,
        source: schema.posts.source,
        error: schema.posts.error,
        publishAt: schema.posts.publishAt,
      })
      .from(schema.posts)
      .where(eq(schema.posts.id, postId))
      .limit(1)
      .for('update');
    if (!row) return 'missing' as const;
    assertNotImported(row, 'retried');
    if (row.status !== 'failed') return row.status;
    const [updated] = await tx
      .update(schema.posts)
      .set({ status: 'scheduled', error: null })
      // Belt and braces with the check above: an imported row is never moved to `scheduled`.
      .where(and(eq(schema.posts.id, postId), ne(schema.posts.source, IMPORTED_SOURCE)))
      .returning();
    return { updated: (await toViews(tx, [updated!]))[0]!, previousError: row.error };
  });
  if (outcome === 'missing') return null;
  if (typeof outcome === 'string') {
    throw new PostStateError(`a '${outcome}' post cannot be retried`);
  }

  try {
    // The job engine keys a post's publish job on the post id and drops a second add while one
    // still exists in any state — so clear a leftover job first, or the retry could silently vanish.
    // The job that just failed this post may still be running for another instant and cannot be
    // removed; `schedulePublish` waits that out (see createQueueScheduler).
    await getScheduler().cancelPublish({ postId });
    const { publishAt } = outcome.updated;
    const when = publishAt && publishAt.getTime() > Date.now() ? publishAt : 'now';
    await getScheduler().schedulePublish({ workspaceId, postId, when });
  } catch (err) {
    // Nothing was enqueued: put the post back so it reads `failed` (and can be retried again)
    // instead of sitting `scheduled` with no job behind it.
    await withWorkspace(workspaceId, async (tx) => {
      await tx
        .update(schema.posts)
        .set({ status: 'failed', error: outcome.previousError })
        .where(and(eq(schema.posts.id, postId), eq(schema.posts.status, 'scheduled')));
    });
    throw err;
  }
  return outcome.updated;
}

/**
 * Copy one post into a NEW post-group as a draft (D1 `duplicate_post`). Carries the source's own
 * caption/media/options — the per-platform values, not the group's — onto the same connection.
 *
 * Always a draft, whatever the source's status or schedule: duplicating a published or scheduled
 * post must never publish by itself. Any status may be duplicated (reposting a published post is
 * the main use). Goes through `createPost`, so the provider's rules and idempotency apply as usual.
 *
 * An imported post may be duplicated too — it is how an operator reuses one — and the copy is an
 * ordinary draft of this app (`source: 'app'`) carrying the CAPTION ONLY: see `copyableMedia`.
 */
export async function duplicatePost(
  workspaceId: string,
  postId: string,
  meta: CreatePostMeta = {},
): Promise<PostView | null> {
  const source = await withWorkspace(workspaceId, async (tx) => {
    const [row] = await tx.select().from(schema.posts).where(eq(schema.posts.id, postId)).limit(1);
    return row ?? null;
  });
  if (!source) return null;

  const [copy] = await createPost(
    workspaceId,
    {
      caption: source.caption,
      media: copyableMedia(source),
      variants: [
        {
          connectionId: source.connectionId,
          provider: source.provider as PostView['provider'],
          options: parseStoredOptions(source.options) ?? undefined,
        },
      ],
      schedule: { type: 'draft' },
    },
    meta,
  );
  return copy ?? null;
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

  const views = await withWorkspace(workspaceId, async (tx) =>
    toViews(
      tx,
      await tx
        .select()
        .from(schema.posts)
        .where(
          and(
            isNotNull(schema.posts.publishAt),
            gte(schema.posts.publishAt, fromUtc),
            lte(schema.posts.publishAt, toUtc),
          ),
        ),
    ),
  );

  const buckets = new Map<string, PostView[]>();
  for (const view of views) {
    const date = DateTime.fromJSDate(view.publishAt!, { zone }).toFormat('yyyy-MM-dd');
    const bucket = buckets.get(date) ?? [];
    bucket.push(view);
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
      posts: await toViews(tx, posts),
    };
  });
}

type GroupRow = Pick<
  typeof schema.postGroups.$inferSelect,
  'id' | 'caption' | 'media' | 'createdAt'
>;

/**
 * Group rows → list items, in the order given: every post of each group, the group's media, and the
 * headline status. Two queries (posts, media urls) however many groups there are.
 */
async function toGroupSummaries(tx: Tx, groups: GroupRow[]): Promise<PostGroupSummary[]> {
  if (groups.length === 0) return [];
  const rows = await tx
    .select()
    .from(schema.posts)
    .where(
      inArray(
        schema.posts.groupId,
        groups.map((g) => g.id),
      ),
    )
    .orderBy(asc(schema.posts.createdAt), asc(schema.posts.id));
  const urls = await storedMediaUrls(tx, [
    ...groups.map((g) => mediaRefsOf(g.media)),
    ...rows.map((r) => mediaRefsOf(r.media)),
  ]);
  const byGroup = new Map<string, PostView[]>();
  for (const row of rows) {
    byGroup.set(row.groupId, [...(byGroup.get(row.groupId) ?? []), toView(row, urls)]);
  }
  return groups.map((g) => {
    const posts = byGroup.get(g.id) ?? [];
    return {
      id: g.id,
      caption: g.caption,
      media: toMediaViews(mediaRefsOf(g.media), urls),
      createdAt: g.createdAt,
      status: groupDisplayStatus(posts.map((p) => p.status)),
      posts,
    };
  });
}

/** `%`, `_` and the escape character itself are literal in a caption search, not wildcards. */
const likeLiteral = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * One page of post groups — one item per composed post, with all of its per-platform posts
 * (`listPostGroupsQuery` documents the filter and ordering rules). Paginated by GROUP, which is why
 * this exists: grouping the per-post list client-side splits a group across two pages.
 *
 * Three queries a page: the group page, its posts, their media urls.
 */
export async function listPostGroups(
  workspaceId: string,
  query: ListPostGroupsQuery = listPostGroupsQuery.parse({}),
): Promise<PostGroupSummary[]> {
  return withWorkspace(workspaceId, async (tx) => {
    // Earliest publish time among the variants that match; a group with none (drafts, legacy
    // "publish now" posts) sorts by when it was created. Never shown as a publish time.
    const sortAt = sql`coalesce(min(${schema.posts.publishAt}), ${schema.postGroups.createdAt})`;
    const direction = query.order === 'asc' ? asc : desc;
    const groups = await tx
      .select({
        id: schema.postGroups.id,
        caption: schema.postGroups.caption,
        media: schema.postGroups.media,
        createdAt: schema.postGroups.createdAt,
      })
      .from(schema.postGroups)
      .innerJoin(schema.posts, eq(schema.posts.groupId, schema.postGroups.id))
      .where(
        and(
          query.status ? eq(schema.posts.status, query.status) : undefined,
          query.provider ? eq(schema.posts.provider, query.provider) : undefined,
          query.connectionId ? eq(schema.posts.connectionId, query.connectionId) : undefined,
          query.source ? eq(schema.posts.source, query.source) : undefined,
          query.from ? gte(schema.posts.publishAt, query.from) : undefined,
          query.to ? lte(schema.posts.publishAt, query.to) : undefined,
          query.q ? ilike(schema.posts.caption, `%${likeLiteral(query.q)}%`) : undefined,
        ),
      )
      // Grouping by the primary key lets the group's other columns be selected as they are.
      .groupBy(schema.postGroups.id)
      .orderBy(direction(sortAt), direction(schema.postGroups.id))
      .limit(query.limit)
      .offset(query.offset);
    return toGroupSummaries(tx, groups);
  });
}

/**
 * Copy a whole group — every per-platform post, each with its own caption, media and options —
 * into a NEW group of drafts. The group-level twin of `duplicatePost`, which copies one post into
 * a group of its own and so would turn a three-platform post into three unrelated ones.
 *
 * Always drafts, whatever the source's statuses: duplicating must never publish by itself. Goes
 * through `createPost`, so provider rules, the connection check and idempotency apply as usual — a
 * source whose account has since been disconnected is refused (`ConnectionNotFoundError`).
 */
export async function duplicatePostGroup(
  workspaceId: string,
  groupId: string,
  meta: CreatePostMeta = {},
): Promise<PostGroupSummary | null> {
  const source = await withWorkspace(workspaceId, async (tx) => {
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
    return { group, posts };
  });
  if (!source || source.posts.length === 0) return null;

  const created = await createPost(
    workspaceId,
    {
      caption: source.group.caption,
      // A group holding an imported post has only that post (imports never pair platforms).
      media: source.posts.some((p) => p.source === IMPORTED_SOURCE)
        ? []
        : mediaRefsOf(source.group.media),
      variants: source.posts.map((p) => ({
        connectionId: p.connectionId,
        provider: p.provider as PostView['provider'],
        caption: p.caption,
        media: copyableMedia(p),
        options: parseStoredOptions(p.options) ?? undefined,
      })),
      schedule: { type: 'draft' },
    },
    meta,
  );
  const newGroupId = created[0]?.groupId;
  if (!newGroupId) return null;
  return withWorkspace(workspaceId, async (tx) => {
    const groups = await tx
      .select()
      .from(schema.postGroups)
      .where(eq(schema.postGroups.id, newGroupId))
      .limit(1);
    return (await toGroupSummaries(tx, groups))[0] ?? null;
  });
}

type PostRow = typeof schema.posts.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Media refs as stored in a jsonb column. Anything that is not a list of refs reads as none. An
 * imported post's ref may also carry `thumbnailUrl` — the stored still of a video we do not hold.
 */
type StoredMediaRef = MediaRef & { thumbnailUrl?: string };

function mediaRefsOf(value: unknown): StoredMediaRef[] {
  return Array.isArray(value) ? (value as StoredMediaRef[]) : [];
}

/**
 * The media a copy of this post may carry. None for an imported post: what is stored for it is a
 * reduced still for the card (at most 720px, and for a video not the video at all), and a draft
 * that silently carried that would publish a thumbnail. The operator attaches the original.
 */
function copyableMedia(row: Pick<PostRow, 'source' | 'media'>): MediaRef[] {
  if (row.source === IMPORTED_SOURCE) return [];
  return mediaRefsOf(row.media).map(({ mediaId, kind, url }) => ({
    mediaId,
    kind,
    ...(url ? { url } : {}),
  }));
}

/**
 * The stored public url of every media a ref points at without carrying a url of its own — ONE
 * query however many posts, so a list never costs a query per post. Only `id` and `url` are read:
 * the storage key stays in the table. Ids that are not uuids are skipped rather than sent to a
 * uuid column, where one bad stored ref would fail the whole list.
 */
async function storedMediaUrls(
  tx: Tx,
  refLists: readonly MediaRef[][],
): Promise<Map<string, string | null>> {
  const ids = [
    ...new Set(
      refLists
        .flat()
        // A ref with a still of its own (an imported video) names the still's media row: its url
        // is a picture, never this video's.
        .filter((r) => !r.url && !(r as StoredMediaRef).thumbnailUrl && UUID.test(r.mediaId))
        .map((r) => r.mediaId),
    ),
  ];
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: schema.media.id, url: schema.media.url })
    .from(schema.media)
    .where(inArray(schema.media.id, ids));
  return new Map(rows.map((r) => [r.id, r.url]));
}

/**
 * Refs → what a view shows. A ref's own url wins (it is what gets published); otherwise the stored
 * one; otherwise null — a missing media must not fail a read. `coverUrl` is the still of a `meta`
 * post and belongs to its first video; nothing else has a thumbnail today.
 */
export function toMediaViews(
  refs: readonly StoredMediaRef[],
  urls: ReadonlyMap<string, string | null>,
  coverUrl?: string,
): PostMediaView[] {
  let coverUsed = false;
  return refs.map((ref) => {
    const cover = ref.kind === 'video' && coverUrl && !coverUsed ? coverUrl : null;
    if (cover) coverUsed = true;
    return {
      id: ref.mediaId,
      kind: ref.kind,
      // A ref with its own still (an imported video) has no file of ours behind it: its media id
      // names the still, which must not be offered as the video's url.
      url: ref.url ?? (ref.thumbnailUrl ? null : urls.get(ref.mediaId)) ?? null,
      thumbnailUrl: ref.thumbnailUrl ?? cover,
    };
  });
}

/** Rows → views with their media resolved, in one extra query for the whole set. */
async function toViews(tx: Tx, rows: PostRow[]): Promise<PostView[]> {
  if (rows.length === 0) return [];
  const urls = await storedMediaUrls(
    tx,
    rows.map((r) => mediaRefsOf(r.media)),
  );
  return rows.map((r) => toView(r, urls));
}

const coverUrlOf = (options: PostOptions | null): string | undefined =>
  options?.kind === 'meta' ? options.coverUrl : undefined;

/**
 * The media of many post rows as views, keyed by post id, in one extra query for the whole set —
 * for a read model that is not a `PostView` (the analytics report).
 */
export async function mediaViewsByPost(
  tx: Tx,
  rows: ReadonlyArray<Pick<PostRow, 'id' | 'media' | 'options'>>,
): Promise<Map<string, PostMediaView[]>> {
  if (rows.length === 0) return new Map();
  const urls = await storedMediaUrls(
    tx,
    rows.map((r) => mediaRefsOf(r.media)),
  );
  return new Map(
    rows.map((r) => [
      r.id,
      toMediaViews(mediaRefsOf(r.media), urls, coverUrlOf(parseStoredOptions(r.options))),
    ]),
  );
}

function toView(row: PostRow, urls: ReadonlyMap<string, string | null>): PostView {
  const options = parseStoredOptions(row.options);
  return {
    id: row.id,
    groupId: row.groupId,
    provider: row.provider as PostView['provider'],
    connectionId: row.connectionId,
    status: row.status as PostView['status'],
    caption: row.caption,
    options,
    publishAt: row.publishAt,
    releaseUrl: row.releaseUrl,
    error: row.error,
    queueId: row.queueId,
    createdAt: row.createdAt,
    source: row.source === IMPORTED_SOURCE ? 'imported' : 'app',
    platformRemovedAt: row.platformRemovedAt,
    media: toMediaViews(mediaRefsOf(row.media), urls, coverUrlOf(options)),
  };
}
