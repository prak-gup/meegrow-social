import { Queue, Worker } from 'bullmq';
import { PUBLISH_SWEEP_INTERVAL_MS, sweepStrandedPublishes } from './deps.js';

export const PUBLISH_SWEEP_QUEUE = 'publish-sweep';

/**
 * Runs one sweep and reports it. Posts the sweep could not resolve are logged, not thrown: they
 * are retried on the next tick, and a failed job here would only add noise to the failed set.
 */
export async function runPublishSweep(): Promise<{
  examined: number;
  requeued: number;
  failed: number;
  errors: number;
}> {
  const { examined, requeued, failed, errors } = await sweepStrandedPublishes();
  if (requeued > 0 || failed > 0) {
    console.warn(
      `publish sweep: ${requeued} stranded post(s) queued again, ${failed} marked failed`,
    );
  }
  for (const error of errors) console.error(`publish sweep could not resolve ${error}`);
  return { examined, requeued, failed, errors: errors.length };
}

/**
 * Stranded-post sweep: a repeatable BullMQ job that finds posts still `scheduled` well past their
 * time with no job that will publish them, and queues them again or marks them failed. THIN — the
 * worker only schedules/dispatches; which posts, the thresholds and the policy live in
 * `core/services/publish-sweep.ts`. Needs the scheduler port set (see index.ts).
 */
export function buildPublishSweepWorker(redisUrl: string): Worker {
  const connection = { url: redisUrl };
  const queue = new Queue(PUBLISH_SWEEP_QUEUE, { connection });

  // Idempotent: re-adding the same repeatable jobId on every worker boot is a no-op if unchanged.
  // NOTE: no ':' in the jobId — BullMQ rejects custom ids containing a colon.
  void queue.add(
    'sweep',
    {},
    {
      repeat: { every: PUBLISH_SWEEP_INTERVAL_MS },
      jobId: 'publish-sweep-repeat',
      removeOnComplete: true,
      removeOnFail: false,
    },
  );

  // concurrency 1: one sweep at a time per worker. Several workers are still safe — the repeat job
  // is one job per tick, and core resolves each post under its row lock.
  return new Worker(PUBLISH_SWEEP_QUEUE, async () => runPublishSweep(), {
    connection,
    concurrency: 1,
  });
}
