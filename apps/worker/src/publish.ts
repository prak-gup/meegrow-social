import { Worker, type Job } from 'bullmq';
import { publishPost, recordPublishExhaustion } from './deps.js';

// Must match apps/api/src/scheduler.ts PUBLISH_QUEUE.
export const PUBLISH_QUEUE = 'publish';

export interface PublishJobData {
  workspaceId: string;
  postId: string;
}

/** The slice of a BullMQ job the failure handler reads. */
export type FailedPublishJob = Pick<Job<PublishJobData>, 'data' | 'attemptsMade' | 'finishedOn'> & {
  opts: Pick<Job<PublishJobData>['opts'], 'attempts'>;
};

/**
 * True once BullMQ will not run the job again. `finishedOn` is only set when the job reached the
 * failed set (out of attempts, or an unrecoverable error); the attempt count is the fallback.
 */
export function isFinalFailure(job: FailedPublishJob): boolean {
  return job.finishedOn !== undefined || job.attemptsMade >= (job.opts.attempts ?? 1);
}

/**
 * `failed` listener for the publish queue. BullMQ emits it after EVERY failed attempt; only the
 * last one is acted on — earlier ones are retried by BullMQ and the post must stay `scheduled`.
 * On the last, core marks the post `failed` and parks the job in the DLQ table (AX-PRD §1).
 *
 * Never rejects: this runs as an event listener, where a rejection is an unhandled one and takes
 * the whole worker (and every publish in flight) down with it.
 */
export async function onPublishJobFailed(
  job: FailedPublishJob | undefined,
  err: Error,
): Promise<void> {
  if (!job || !isFinalFailure(job)) return;
  try {
    await recordPublishExhaustion({
      workspaceId: job.data.workspaceId,
      postId: job.data.postId,
      queue: PUBLISH_QUEUE,
      payload: job.data,
      error: err.message,
      attempts: job.attemptsMade,
    });
  } catch (recordErr) {
    // Nothing more can be done from here. The post may still read `scheduled` with no job behind
    // it, so say which one, loudly, for whoever reads the worker log.
    console.error(
      `publish job for post ${job.data.postId} (workspace ${job.data.workspaceId}) exhausted its attempts but could not be fully recorded`,
      recordErr,
    );
  }
}

export function buildPublishWorker(redisUrl: string): Worker<PublishJobData> {
  const worker = new Worker<PublishJobData>(
    PUBLISH_QUEUE,
    async (job) => {
      const { workspaceId, postId } = job.data;
      return publishPost(workspaceId, postId); // throws on transient → BullMQ retries
    },
    { connection: { url: redisUrl }, concurrency: 5 },
  );
  worker.on('failed', (job, err) => void onPublishJobFailed(job, err));
  return worker;
}
