import { Queue } from 'bullmq';
import type { Scheduler } from '@meegrow-social/core';

export const PUBLISH_QUEUE = 'publish';

export interface PublishJobData {
  workspaceId: string;
  postId: string;
}

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
 * BullMQ-backed scheduler. Delayed jobs give us the durable timer for scheduled publishing
 * (AX-PRD §1) without Temporal. The worker app consumes PUBLISH_QUEUE.
 */
export function createBullScheduler(redisUrl: string): Scheduler {
  const connection = { url: redisUrl };
  const queue = new Queue<PublishJobData>(PUBLISH_QUEUE, { connection });
  return {
    async schedulePublish({ workspaceId, postId, when }) {
      const delay = when === 'now' ? 0 : Math.max(0, when.getTime() - Date.now());
      await queue.add(
        'publish',
        { workspaceId, postId },
        {
          delay,
          jobId: publishJobId(postId),
          attempts: 3,
          backoff: { type: 'exponential', delay: 120_000 },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
    },
    async cancelPublish({ postId }) {
      // remove() targets the delayed/waiting job by its deterministic jobId. Returns false (no throw)
      // if the job already completed/failed/was removed — i.e. a safe no-op for late cancels.
      await queue.remove(publishJobId(postId));
    },
  };
}
