import { Queue, Worker } from 'bullmq';
import { METRIC_RETENTION_SWEEP_MS, pruneEventLogs, pruneExpiredMetrics } from './deps.js';

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

export const METRICS_RETENTION_QUEUE = 'metrics-retention';

/**
 * Metric retention (#61): deletes metric rows past their platform's storage limit — YouTube's 30
 * days. THIN like the job above; which rows and what cutoff live in
 * `core/services/metrics-retention.ts`, and the interval is that module's too because the cutoff
 * is computed against it.
 */
export function buildMetricsRetentionWorker(redisUrl: string): Worker {
  const connection = { url: redisUrl };
  const queue = new Queue(METRICS_RETENTION_QUEUE, { connection });

  void queue.add(
    'prune',
    {},
    {
      repeat: { every: METRIC_RETENTION_SWEEP_MS },
      jobId: 'metrics-retention-sweep',
      removeOnComplete: true,
      removeOnFail: false,
    },
  );

  return new Worker(METRICS_RETENTION_QUEUE, async () => pruneExpiredMetrics(), {
    connection,
    concurrency: 1,
  });
}
