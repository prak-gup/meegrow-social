import { Worker } from 'bullmq';
import { publishPost, withWorkspace, schema } from './deps.js';
import { buildRetentionWorker } from './retention.js';
import { buildTokenHealthWorker } from './token-health.js';
import { buildAnalyticsWorker } from './analytics.js';

// Must match apps/api/src/scheduler.ts PUBLISH_QUEUE.
const PUBLISH_QUEUE = 'publish';

interface PublishJobData {
  workspaceId: string;
  postId: string;
}

function buildWorker(redisUrl: string): Worker<PublishJobData> {
  const worker = new Worker<PublishJobData>(
    PUBLISH_QUEUE,
    async (job) => {
      const { workspaceId, postId } = job.data;
      return publishPost(workspaceId, postId); // throws on transient → BullMQ retries
    },
    { connection: { url: redisUrl }, concurrency: 5 },
  );

  // On final exhaustion, park the job in the DLQ table for manual replay (AX-PRD §1).
  worker.on('failed', async (job, err) => {
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    await withWorkspace(job.data.workspaceId, async (tx) => {
      await tx.insert(schema.jobsDlq).values({
        workspaceId: job.data.workspaceId,
        queue: PUBLISH_QUEUE,
        payload: job.data,
        error: err.message,
      });
    });
  });

  return worker;
}

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error('REDIS_URL is not set');
buildWorker(redisUrl);
buildRetentionWorker(redisUrl);
buildTokenHealthWorker(redisUrl);
buildAnalyticsWorker(redisUrl);
console.log(
  'meegrow-social worker consuming publish + logs-retention + token-health + analytics queues',
);
