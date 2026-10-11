import { Queue } from 'bullmq';
import { createQueueScheduler, PUBLISH_QUEUE, setScheduler, type PublishJobData } from './deps.js';
import { buildPublishWorker } from './publish.js';
import { buildPublishSweepWorker } from './publish-sweep.js';
import { buildMetricsRetentionWorker, buildRetentionWorker } from './retention.js';
import { buildTokenHealthWorker } from './token-health.js';
import { buildAnalyticsWorker } from './analytics.js';

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error('REDIS_URL is not set');
// The stranded-post sweep asks the job engine about publish jobs and re-enqueues them, so the
// worker needs the scheduler port too — the same core implementation the API uses.
setScheduler(
  createQueueScheduler(new Queue<PublishJobData>(PUBLISH_QUEUE, { connection: { url: redisUrl } })),
);
buildPublishWorker(redisUrl);
buildPublishSweepWorker(redisUrl);
buildRetentionWorker(redisUrl);
buildMetricsRetentionWorker(redisUrl);
buildTokenHealthWorker(redisUrl);
buildAnalyticsWorker(redisUrl);
console.log(
  'meegrow-social worker consuming publish + publish-sweep + logs-retention + metrics-retention + token-health + analytics queues',
);
