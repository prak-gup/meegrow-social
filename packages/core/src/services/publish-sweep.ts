import { db, schema, withWorkspace } from '@meegrow-social/db';
import { and, asc, eq, isNotNull, isNull, lt, ne, or } from 'drizzle-orm';
import { PUBLISHABLE_STATUS } from './publish.js';
import { PUBLISH_QUEUE } from './publish-queue.js';
import { getScheduler, type PublishJobState } from './scheduler.js';

/** How often the worker runs the sweep. */
export const PUBLISH_SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * How overdue a `scheduled` post must be before the sweep looks at it. A post that is merely due
 * always has a live job (waiting, running, or delayed between retries), so this only has to cover
 * the moment between a post being committed and its job being enqueued, plus clock skew.
 */
export const PUBLISH_OVERDUE_GRACE_MS = 5 * 60_000;

/**
 * How overdue a post with NO job may be and still be queued again. Past this it is failed instead:
 * a post that silently goes out hours after its time is usually worse than one that visibly did
 * not go out and waits for a person to decide.
 */
export const PUBLISH_REQUEUE_WINDOW_MS = 30 * 60_000;

/**
 * Most overdue posts examined per workspace per sweep, oldest first. Overdue-and-still-scheduled
 * is a small set by construction; the cap only bounds a pathological backlog, and the rest are
 * picked up on the next sweep.
 */
export const PUBLISH_SWEEP_BATCH = 500;

export type OverdueDecision =
  /** Not the sweep's business: not scheduled, not overdue enough, or a live job stands behind it. */
  | { action: 'leave' }
  /** Never attempted and only slightly late: queue it again. */
  | { action: 'requeue'; overdueMs: number }
  /** Mark it failed. `job_died`: its job ran and died. `too_late`: no job, and past the window. */
  | { action: 'fail'; reason: 'job_died' | 'too_late'; overdueMs: number };

/**
 * What the sweep does with one post, given what the job engine holds for it. Pure.
 *
 * - A `live` job means the post is waiting its turn or being sent: never touched.
 * - A `dead` job means publishing was attempted and ended without the post being marked — the job
 *   stalled out (the worker died mid-publish, so BullMQ failed it without the worker's `failed`
 *   handler running) or the mark-failed write was lost. It is failed, never run again by itself:
 *   the platform may already have the post, and a job that killed its worker should not be retried
 *   unattended.
 * - No job means it was never attempted (the enqueue was lost). Queue it again while it is only
 *   slightly late; fail it once it is past `PUBLISH_REQUEUE_WINDOW_MS`.
 *
 * A publish-now post has no `publishAt`; it was due when it was created.
 */
export function decideOverduePublish(
  post: { status: string; publishAt: Date | null; createdAt: Date; source?: string },
  job: PublishJobState,
  now: Date,
): OverdueDecision {
  // An imported post is never queued and never failed by the sweep, whatever its row says.
  if (post.source === 'imported') return { action: 'leave' };
  if (post.status !== PUBLISHABLE_STATUS) return { action: 'leave' };
  const overdueMs = now.getTime() - (post.publishAt ?? post.createdAt).getTime();
  if (overdueMs < PUBLISH_OVERDUE_GRACE_MS) return { action: 'leave' };
  if (job === 'live') return { action: 'leave' };
  if (job === 'dead') return { action: 'fail', reason: 'job_died', overdueMs };
  return overdueMs <= PUBLISH_REQUEUE_WINDOW_MS
    ? { action: 'requeue', overdueMs }
    : { action: 'fail', reason: 'too_late', overdueMs };
}

function describeDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
}

/** The error a user sees on a post the sweep failed. */
export function strandedPublishMessage(reason: 'job_died' | 'too_late', overdueMs: number): string {
  return reason === 'job_died'
    ? 'Publishing stopped without recording a result: its job died. It may or may not have ' +
        'reached the platform — check the account before retrying.'
    : `Not published: no publish job was found ${describeDuration(overdueMs)} after it was due, ` +
        'and it was not sent late automatically. Retry to publish it now.';
}

export interface PublishSweepResult {
  /** Overdue `scheduled` posts looked at. */
  examined: number;
  requeued: number;
  failed: number;
  /** Posts that could not be resolved this time (database or job engine error); retried next sweep. */
  errors: string[];
}

/**
 * Backstop for posts stranded in `scheduled` with nothing that will ever publish them, across
 * every workspace. Enumerates workspaces on the admin handle (the table is non-tenant) and sweeps
 * each under `withWorkspace`, like the token-health sweep.
 */
export async function sweepStrandedPublishes(now: Date = new Date()): Promise<PublishSweepResult> {
  const workspaces = await db().select({ id: schema.workspaces.id }).from(schema.workspaces);
  const total: PublishSweepResult = { examined: 0, requeued: 0, failed: 0, errors: [] };
  for (const ws of workspaces) {
    const r = await sweepStrandedPublishesForWorkspace(ws.id, now);
    total.examined += r.examined;
    total.requeued += r.requeued;
    total.failed += r.failed;
    total.errors.push(...r.errors);
  }
  return total;
}

/**
 * Sweeps one workspace. Each overdue post is resolved in its own transaction, holding the post's
 * row lock from the job-state lookup to the write:
 *
 * - `FOR UPDATE SKIP LOCKED`: a post being published right now (the publisher holds the lock) or
 *   being handled by another worker's sweep is skipped, never waited on.
 * - The decision is made on the locked row, so a cancel, edit or publish that committed since the
 *   candidate list was read is honoured.
 * - A requeue goes through cancel-then-schedule on the post's deterministic job id, and
 *   `publishPost` sends only a `scheduled` post under this same lock — so however often the sweep
 *   runs, and on however many workers, a post is sent at most once.
 *
 * Idempotent: a post it failed is no longer `scheduled`; a post it requeued has a live job.
 * One post's error never stops the rest.
 */
export async function sweepStrandedPublishesForWorkspace(
  workspaceId: string,
  now: Date = new Date(),
): Promise<PublishSweepResult> {
  const cutoff = new Date(now.getTime() - PUBLISH_OVERDUE_GRACE_MS);
  const candidates = await withWorkspace(workspaceId, (tx) =>
    tx
      .select({ id: schema.posts.id })
      .from(schema.posts)
      .where(
        and(
          eq(schema.posts.status, PUBLISHABLE_STATUS),
          ne(schema.posts.source, 'imported'),
          or(
            and(isNotNull(schema.posts.publishAt), lt(schema.posts.publishAt, cutoff)),
            and(isNull(schema.posts.publishAt), lt(schema.posts.createdAt, cutoff)),
          ),
        ),
      )
      .orderBy(asc(schema.posts.createdAt), asc(schema.posts.id))
      .limit(PUBLISH_SWEEP_BATCH),
  );

  const result: PublishSweepResult = { examined: 0, requeued: 0, failed: 0, errors: [] };
  for (const { id: postId } of candidates) {
    result.examined += 1;
    try {
      const action = await resolveOverduePost(workspaceId, postId, now);
      if (action === 'requeue') result.requeued += 1;
      if (action === 'fail') result.failed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`post ${postId} (workspace ${workspaceId}): ${message}`);
    }
  }
  return result;
}

async function resolveOverduePost(
  workspaceId: string,
  postId: string,
  now: Date,
): Promise<OverdueDecision['action']> {
  return withWorkspace(workspaceId, async (tx) => {
    const [post] = await tx
      .select({
        status: schema.posts.status,
        source: schema.posts.source,
        publishAt: schema.posts.publishAt,
        createdAt: schema.posts.createdAt,
        provider: schema.posts.provider,
        connectionId: schema.posts.connectionId,
      })
      .from(schema.posts)
      .where(eq(schema.posts.id, postId))
      .limit(1)
      .for('update', { skipLocked: true });
    // No row: locked by a publish in flight (or another sweep), or deleted. Not ours to resolve.
    if (!post) return 'leave';

    // Asked while the row is locked. If the job engine cannot answer, this throws and the post is
    // left exactly as it is: without knowing a job's state, neither action is safe.
    const job = await getScheduler().publishJobState({ postId });
    const decision = decideOverduePublish(post, job, now);
    if (decision.action === 'leave') return 'leave';

    const [conn] = await tx
      .select({ displayName: schema.connections.displayName })
      .from(schema.connections)
      .where(eq(schema.connections.id, post.connectionId))
      .limit(1);
    const log = { workspaceId, kind: 'publish', platform: post.provider } as const;
    const account = conn?.displayName ?? null;

    if (decision.action === 'requeue') {
      // Clear whatever is left under the job id first — the queue drops an add whose id exists.
      await getScheduler().cancelPublish({ postId });
      await getScheduler().schedulePublish({ workspaceId, postId, when: 'now' });
      await tx.insert(schema.eventLogs).values({
        ...log,
        status: 'requeued',
        account,
        message: `No publish job was found ${describeDuration(decision.overdueMs)} after the post was due; queued again`,
      });
      return 'requeue';
    }

    const message = strandedPublishMessage(decision.reason, decision.overdueMs);
    await tx
      .update(schema.posts)
      .set({ status: 'failed', error: message })
      .where(
        and(
          eq(schema.posts.id, postId),
          eq(schema.posts.status, PUBLISHABLE_STATUS),
          ne(schema.posts.source, 'imported'),
        ),
      );
    await tx.insert(schema.eventLogs).values({ ...log, status: 'failed', account, message });
    await tx.insert(schema.jobsDlq).values({
      workspaceId,
      queue: PUBLISH_QUEUE,
      payload: { workspaceId, postId },
      error: message,
    });
    return 'fail';
  });
}
