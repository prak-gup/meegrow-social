import type { PublishJobState, Scheduler } from './scheduler.js';

/** The queue publish jobs travel on. The API enqueues onto it; the worker consumes it. */
export const PUBLISH_QUEUE = 'publish';

export interface PublishJobData {
  workspaceId: string;
  postId: string;
}

/**
 * Publish retry policy: 3 attempts, the 2nd and 3rd roughly 2 and 4 minutes after the one before
 * (exponential from `PUBLISH_BACKOFF_MS`). Deliberately few and fast — a social post is tied to
 * its time, so one that cannot go out within minutes should fail where a person sees it rather
 * than appear hours late. Only transient provider errors are retried at all.
 */
export const PUBLISH_ATTEMPTS = 3;
export const PUBLISH_BACKOFF_MS = 120_000;

/**
 * Deterministic job id for a post's publish job — lets cancelPublish (#5) find it without storing
 * the id, and makes re-scheduling idempotent.
 *
 * The separator MUST NOT be ':' — BullMQ rejects custom job ids containing a colon ("Custom Id
 * cannot contain :") because it namespaces its own Redis keys with it. That mistake stranded every
 * scheduled post: createPost commits the row, then schedulePublish throws, leaving the post
 * 'scheduled' with no job behind it. Our integration tests use the recording scheduler, so they
 * never exercised this constraint.
 */
export function publishJobId(postId: string): string {
  return `publish-${postId}`;
}

/**
 * The slice of a BullMQ `Queue` the scheduler uses. Structural, so `core` needs no BullMQ import:
 * the apps pass `new Queue(PUBLISH_QUEUE, ...)` and tests pass a fake. Semantics relied on, all
 * BullMQ's: `add` with a `jobId` that still exists in ANY state is silently dropped; `remove`
 * returns 0 (it does not throw) for a job that is running or does not exist.
 */
export interface PublishJobQueue {
  add(
    name: string,
    data: PublishJobData,
    opts: {
      delay: number;
      jobId: string;
      attempts: number;
      backoff: { type: 'exponential'; delay: number };
      removeOnComplete: boolean;
      removeOnFail: boolean;
    },
  ): Promise<unknown>;
  getJob(jobId: string): Promise<{ getState(): Promise<string> } | undefined>;
  remove(jobId: string): Promise<number>;
}

/** Maps a BullMQ job state onto what the sweep needs to know. */
export function toPublishJobState(bullState: string | undefined): PublishJobState {
  // No job; or `completed` (removed on completion — one seen mid-removal stands behind nothing);
  // or `unknown`, BullMQ's answer for a job that vanished between the lookup and the state read.
  if (bullState === undefined || bullState === 'completed' || bullState === 'unknown') {
    return 'none';
  }
  if (bullState === 'failed') return 'dead';
  // waiting, delayed, active, prioritized, waiting-children — and any state a later BullMQ adds:
  // treating an unrecognised state as live means the sweep leaves the post alone.
  return 'live';
}

/**
 * The scheduler over a job queue. Delayed jobs give us the durable timer for scheduled publishing
 * (AX-PRD §1) without Temporal. One implementation for every process that enqueues publish jobs —
 * the API and the worker's stranded-post sweep — so the job id and retry policy cannot drift.
 */
export function createQueueScheduler(queue: PublishJobQueue): Scheduler {
  return {
    async schedulePublish({ workspaceId, postId, when }) {
      const delay = when === 'now' ? 0 : Math.max(0, when.getTime() - Date.now());
      await queue.add(
        'publish',
        { workspaceId, postId },
        {
          delay,
          jobId: publishJobId(postId),
          attempts: PUBLISH_ATTEMPTS,
          backoff: { type: 'exponential', delay: PUBLISH_BACKOFF_MS },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
    },
    async cancelPublish({ postId }) {
      // remove() targets the delayed/waiting job by its deterministic jobId. Returns 0 (no throw)
      // if the job is running or already gone — i.e. a safe no-op for late cancels.
      await queue.remove(publishJobId(postId));
    },
    async publishJobState({ postId }) {
      const job = await queue.getJob(publishJobId(postId));
      return toPublishJobState(job ? await job.getState() : undefined);
    },
  };
}
