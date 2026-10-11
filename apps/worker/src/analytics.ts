import { Queue, Worker } from 'bullmq';
import { ANALYTICS_SWEEP_INTERVAL_MS, sweepAnalytics } from './deps.js';

export const ANALYTICS_QUEUE = 'analytics';

/**
 * Analytics sweeper (issue #9, PRD F5). Fires hourly (`ANALYTICS_SWEEP_INTERVAL_MS`, defined in
 * core so `GET /v1/analytics/status` reports the cadence this worker really runs at); the
 * per-post/per-account cadence rules live in `core/services/analytics.ts` and decide what's
 * actually due on each tick — hourly is just the finest granularity anything needs, so the job is
 * cheap and mostly a no-op.
 *
 * THIN, like the token-health worker: schedule + dispatch only, no logic here.
 */
export function buildAnalyticsWorker(redisUrl: string): Worker {
  const connection = { url: redisUrl };
  const queue = new Queue(ANALYTICS_QUEUE, { connection });

  // Idempotent: re-adding the same repeatable jobId on each boot is a no-op if unchanged.
  // NOTE: no ':' in the jobId — BullMQ rejects custom ids containing a colon.
  void queue.add(
    'sweep',
    {},
    {
      repeat: { every: ANALYTICS_SWEEP_INTERVAL_MS },
      jobId: 'analytics-hourly',
      removeOnComplete: true,
      removeOnFail: false,
    },
  );

  // concurrency 1: overlapping sweeps would double-poll the same due rows and waste rate limit.
  return new Worker(ANALYTICS_QUEUE, async () => sweepAnalytics(), { connection, concurrency: 1 });
}
