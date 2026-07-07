import { Queue, Worker } from 'bullmq';
import { pruneEventLogs } from './deps.js';

// Must match apps/api's naming convention for the publish queue (see scheduler.ts).
export const LOGS_RETENTION_QUEUE = 'logs-retention';
const DAILY_MS = 24 * 60 * 60 * 1000;

/**
 * Retention guard (PRD F8): a repeatable BullMQ job that prunes `event_logs` rows older than
 * 90 days once a day. THIN — the worker only schedules/dispatches; the cutoff + delete logic
 * lives in `core/services/logs.ts` (`pruneEventLogs`).
 */
export function buildRetentionWorker(redisUrl: string): Worker {
  const connection = { url: redisUrl };
  const queue = new Queue(LOGS_RETENTION_QUEUE, { connection });

  // Idempotent: re-adding the same repeatable jobId on every worker boot is a no-op if unchanged.
  void queue.add(
    'prune',
    {},
    {
      repeat: { every: DAILY_MS },
      jobId: 'logs-retention-daily',
      removeOnComplete: true,
      removeOnFail: false,
    },
  );

  return new Worker(
    LOGS_RETENTION_QUEUE,
    async () => {
      const deleted = await pruneEventLogs();
      return { deleted };
    },
    { connection, concurrency: 1 },
  );
}
