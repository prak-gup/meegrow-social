import { Queue } from 'bullmq';
import {
  createQueueScheduler,
  PUBLISH_QUEUE,
  type PublishJobData,
  type Scheduler,
} from '@meegrow-social/core';

export { PUBLISH_QUEUE, publishJobId, type PublishJobData } from '@meegrow-social/core';

/**
 * BullMQ-backed scheduler. THIN: this only opens the queue — the job id, retry policy and every
 * scheduling rule live in `core/services/publish-queue.ts`, shared with the worker's sweep.
 */
export function createBullScheduler(redisUrl: string): Scheduler {
  return createQueueScheduler(
    new Queue<PublishJobData>(PUBLISH_QUEUE, { connection: { url: redisUrl } }),
  );
}
