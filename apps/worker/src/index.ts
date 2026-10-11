import { buildPublishWorker } from './publish.js';
import { buildRetentionWorker } from './retention.js';
import { buildTokenHealthWorker } from './token-health.js';
import { buildAnalyticsWorker } from './analytics.js';

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error('REDIS_URL is not set');
buildPublishWorker(redisUrl);
buildRetentionWorker(redisUrl);
buildTokenHealthWorker(redisUrl);
buildAnalyticsWorker(redisUrl);
console.log(
  'meegrow-social worker consuming publish + logs-retention + token-health + analytics queues',
);
