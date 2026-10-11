import { withWorkspace, schema } from '@meegrow-social/db';
import { and, eq, inArray } from 'drizzle-orm';
import { parseStoredOptions, type MediaRef } from '@meegrow-social/contracts';
import { getProvider } from '../providers/registry.js';
import type { AuthTokens, PostDetails } from '../providers/types.js';
import { decryptToken } from '../crypto.js';
import { ProviderAuthError, ProviderBadRequestError } from '../errors.js';
import { resolveMediaRefs } from './media.js';

export interface PublishOutcome {
  postId: string;
  /** `skipped`: the job was refused and nothing was sent or written to the post (see `skipped`). */
  status: 'published' | 'failed' | 'skipped';
  releaseUrl?: string;
  error?: string;
  /** Why a `skipped` job did nothing. */
  skipped?: PublishRefusal;
}

/**
 * The only status a publish job may act on. Everything else means the job is stale: the post was
 * cancelled, moved back to draft, already failed, or (`publishing`) is owned by another run.
 */
export const PUBLISHABLE_STATUS = 'scheduled';

/**
 * How far ahead of `publishAt` a job may fire and still publish. Covers clock skew between the
 * process that computed the job's delay, Redis, and this worker — not a scheduling feature.
 */
export const EARLY_PUBLISH_TOLERANCE_MS = 60_000;

export type PublishRefusal =
  /** The post was imported from the platform: it is already there, and never ours to send. */
  | 'imported'
  /** The post is not `scheduled` (cancelled, draft, failed, ...). */
  | 'not_scheduled'
  /** The post was rescheduled to a later time after this job was queued. */
  | 'not_due';

/**
 * Whether a publish job that fired for this post must be refused. Pure: `publishPost` evaluates it
 * on the row it has just locked, so the answer cannot change before the post is sent.
 *
 * A `published` post is not handled here — `publishPost` reports it as the success it already is.
 */
export function publishRefusal(
  post: { status: string; publishAt: Date | null; source?: string },
  now: Date,
): PublishRefusal | null {
  // First, and whatever its status says: nothing may send a post that is already on the platform.
  if (post.source === 'imported') return 'imported';
  if (post.status !== PUBLISHABLE_STATUS) return 'not_scheduled';
  // publishAt is null for a publish-now post, which is due the moment it exists.
  if (post.publishAt && post.publishAt.getTime() - now.getTime() > EARLY_PUBLISH_TOLERANCE_MS) {
    return 'not_due';
  }
  return null;
}

function refusalMessage(
  refusal: PublishRefusal,
  post: { status: string; publishAt: Date | null },
): string {
  if (refusal === 'imported') {
    return 'Publish job ignored: the post was imported from the platform and is never published by this app';
  }
  return refusal === 'not_due'
    ? `Publish job ignored: the post is now scheduled for ${post.publishAt!.toISOString()}`
    : `Publish job ignored: the post is '${post.status}', not '${PUBLISHABLE_STATUS}'`;
}

/**
 * Publish one post to its platform. Called by the worker's BullMQ processor. Idempotent-ish:
 * a post already `published` is a no-op. Transient provider errors propagate (BullMQ retries);
 * auth/bad-request errors mark the post failed (and, for auth, the connection needs_reconnect).
 *
 * Only a `scheduled` post that is due is sent. The row is locked (`FOR UPDATE`) before its status
 * is read and stays locked until this transaction ends, so the check and the send are one step:
 * a second job for the same post, or a cancel/edit, waits here and then sees what this run
 * committed. Anything else — cancelled, draft, failed, rescheduled to later — returns `skipped`
 * without touching the post, so the job completes instead of retrying or failing the post.
 *
 * A propagated error rolls this transaction back, so the post still reads `scheduled` afterwards.
 * That is right while the job runner has attempts left; once it has none, the runner must call
 * `recordPublishExhaustion`. If that never happens (the job stalled out, the write was lost) the
 * post is left `scheduled` with a dead job, which `sweepStrandedPublishes` finds and fails.
 */
export async function publishPost(
  workspaceId: string,
  postId: string,
  now: Date = new Date(),
): Promise<PublishOutcome> {
  return withWorkspace(workspaceId, async (tx) => {
    const [post] = await tx
      .select()
      .from(schema.posts)
      .where(eq(schema.posts.id, postId))
      .limit(1)
      .for('update');
    if (!post) throw new Error(`post ${postId} not found`);
    // An imported post is `published` too, but it is refused below rather than reported as a
    // publish that succeeded: no job should ever exist for it, and one that does is worth a log line.
    if (post.status === 'published' && post.source !== 'imported') {
      return { postId, status: 'published', releaseUrl: post.releaseUrl ?? undefined };
    }
    const refusal = publishRefusal(post, now);
    if (refusal) {
      const [account] = await tx
        .select({ displayName: schema.connections.displayName })
        .from(schema.connections)
        .where(eq(schema.connections.id, post.connectionId))
        .limit(1);
      await tx.insert(schema.eventLogs).values({
        workspaceId,
        kind: 'publish',
        status: 'skipped',
        platform: post.provider,
        account: account?.displayName ?? null,
        message: refusalMessage(refusal, post),
      });
      return { postId, status: 'skipped', skipped: refusal };
    }

    const [conn] = await tx
      .select()
      .from(schema.connections)
      .where(eq(schema.connections.id, post.connectionId))
      .limit(1);
    if (!conn) throw new Error(`connection ${post.connectionId} not found`);

    const provider = getProvider(post.provider as never);
    const tokens: AuthTokens = {
      accessToken: conn.accessToken ? decryptToken(conn.accessToken) : '',
      refreshToken: conn.refreshToken ? decryptToken(conn.refreshToken) : undefined,
      externalId: conn.externalId,
      displayName: conn.displayName,
    };
    // Posts may be created with only a mediaId (no url yet) — resolve public URLs here (PRD F3.3:
    // IG/GBP require them at publish time).
    const media = await resolveMediaRefs(tx, (post.media as MediaRef[]) ?? []);
    const details: PostDetails[] = [
      {
        caption: post.caption,
        media,
        // Per-platform options (#44) — validated at create time, re-parsed here because jsonb
        // round-trips Dates to strings (see parseStoredOptions).
        options: parseStoredOptions(post.options) ?? undefined,
      },
    ];

    await tx.update(schema.posts).set({ status: 'publishing' }).where(eq(schema.posts.id, postId));

    try {
      const result = await provider.post(tokens, details);
      await tx
        .update(schema.posts)
        .set({
          status: 'published',
          releaseUrl: result.releaseUrl ?? null,
          // For a publish-now post, publishAt records the moment it actually went out. Scheduled
          // posts keep their intended time because the calendar depends on it.
          publishAt: post.publishAt ?? new Date(),
          // The platform's own id — the analytics sweeper (#9) polls insights by it. Without this
          // it was discarded at publish time and unrecoverable except by parsing releaseUrl.
          externalPostId: result.externalPostId ?? null,
          error: null,
        })
        .where(eq(schema.posts.id, postId));
      await tx.insert(schema.eventLogs).values({
        workspaceId,
        kind: 'publish',
        status: 'published',
        platform: post.provider,
        account: conn.displayName,
        // A provider notice ("YouTube set this to private") rides along with the link. A platform
        // that reports no link (PostResult) leaves the notice, or the plain fact, on its own.
        message: [result.releaseUrl, result.notice].filter(Boolean).join(' — ') || 'Published.',
      });
      return { postId, status: 'published', releaseUrl: result.releaseUrl };
    } catch (err) {
      if (err instanceof ProviderAuthError) {
        await tx
          .update(schema.connections)
          .set({ needsReconnect: true })
          .where(eq(schema.connections.id, conn.id));
      } else if (!(err instanceof ProviderBadRequestError)) {
        throw err; // transient → let the job runner retry
      }
      const message = err instanceof Error ? err.message : String(err);
      await tx
        .update(schema.posts)
        .set({ status: 'failed', error: message })
        .where(eq(schema.posts.id, postId));
      await tx.insert(schema.eventLogs).values({
        workspaceId,
        kind: 'publish',
        status: 'failed',
        platform: post.provider,
        account: conn.displayName,
        message,
      });
      return { postId, status: 'failed', error: message };
    }
  });
}

/** Statuses a post can be left in by a publish job that threw: nothing was committed. */
const UNFINISHED_PUBLISH_STATUSES = ['scheduled', 'publishing'];

/** Tries per write in `recordPublishExhaustion`, and the pause before each re-try. */
const EXHAUSTION_WRITE_RETRY_DELAYS_MS = [250, 1000];

export interface PublishExhaustionInput {
  workspaceId: string;
  postId: string;
  /** Queue the job ran on and its payload, stored verbatim on the DLQ row for manual replay. */
  queue: string;
  payload: unknown;
  /** Message of the error that ended the last attempt. */
  error: string;
  /** How many attempts the job runner made. */
  attempts: number;
}

export interface PublishExhaustionOutcome {
  /** False when the post had already left `scheduled` (published, cancelled, ...) or is gone. */
  postMarkedFailed: boolean;
  dlqRecorded: boolean;
}

/** Thrown when a write of `recordPublishExhaustion` still fails after its re-tries. */
export class PublishExhaustionError extends Error {
  constructor(
    readonly postId: string,
    /** What did get written — `postMarkedFailed: false` here can mean the post is stuck. */
    readonly outcome: PublishExhaustionOutcome,
    readonly causes: unknown[],
  ) {
    const detail = causes.map((c) => (c instanceof Error ? c.message : String(c))).join('; ');
    super(`could not fully record the exhausted publish of post ${postId}: ${detail}`);
  }
}

/** The error a user sees on a post whose publish job ran out of attempts. */
export function exhaustedPublishMessage(attempts: number, error: string): string {
  const tries = attempts === 1 ? '1 attempt' : `${attempts} attempts`;
  return `Publishing failed after ${tries}: ${error || 'unknown error'}`;
}

/**
 * The job runner calls this once a publish job has used its last attempt. It marks the post
 * `failed` — so the dashboard stops showing it as scheduled and `retryPost` accepts it — and parks
 * the job in `jobs_dlq`.
 *
 * Only a post still `scheduled` (or `publishing`) is touched, under a row lock: a post that went
 * out, was cancelled, or was moved back to draft keeps its status, so this can never turn a
 * published post into a retryable one. A missing post is left alone too.
 *
 * The two writes are separate transactions, each re-tried a few times, so a failure of one never
 * costs the other. If either still fails this throws `PublishExhaustionError` AFTER attempting
 * both; the caller must log it, because a post that could not be marked is stuck in `scheduled`
 * until `sweepStrandedPublishes` fails it.
 */
export async function recordPublishExhaustion(
  input: PublishExhaustionInput,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<PublishExhaustionOutcome> {
  const { workspaceId, postId } = input;
  const message = exhaustedPublishMessage(input.attempts, input.error);

  const withRetries = async <T>(write: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await write();
      } catch (err) {
        const delay = EXHAUSTION_WRITE_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) throw err;
        await sleep(delay);
      }
    }
  };

  const outcome: PublishExhaustionOutcome = { postMarkedFailed: false, dlqRecorded: false };
  const causes: unknown[] = [];

  try {
    outcome.postMarkedFailed = await withRetries(() =>
      withWorkspace(workspaceId, async (tx) => {
        const [post] = await tx
          .select({
            status: schema.posts.status,
            provider: schema.posts.provider,
            connectionId: schema.posts.connectionId,
          })
          .from(schema.posts)
          .where(eq(schema.posts.id, postId))
          .limit(1)
          .for('update');
        if (!post || !UNFINISHED_PUBLISH_STATUSES.includes(post.status)) return false;

        const [conn] = await tx
          .select({ displayName: schema.connections.displayName })
          .from(schema.connections)
          .where(eq(schema.connections.id, post.connectionId))
          .limit(1);
        await tx
          .update(schema.posts)
          .set({ status: 'failed', error: message })
          .where(
            and(
              eq(schema.posts.id, postId),
              inArray(schema.posts.status, UNFINISHED_PUBLISH_STATUSES),
            ),
          );
        await tx.insert(schema.eventLogs).values({
          workspaceId,
          kind: 'publish',
          status: 'failed',
          platform: post.provider,
          account: conn?.displayName ?? null,
          message,
        });
        return true;
      }),
    );
  } catch (err) {
    causes.push(err);
  }

  try {
    await withRetries(() =>
      withWorkspace(workspaceId, async (tx) => {
        await tx.insert(schema.jobsDlq).values({
          workspaceId,
          queue: input.queue,
          payload: input.payload,
          error: input.error,
        });
      }),
    );
    outcome.dlqRecorded = true;
  } catch (err) {
    causes.push(err);
  }

  if (causes.length > 0) throw new PublishExhaustionError(postId, outcome, causes);
  return outcome;
}
