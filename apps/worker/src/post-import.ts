import { Queue, Worker } from 'bullmq';
import { IMPORT_TICK_INTERVAL_MS, runDueImports } from './deps.js';

export const POST_IMPORT_QUEUE = 'post-import';

/**
 * Past-post import. Fires every minute (`IMPORT_TICK_INTERVAL_MS`) and asks core which connections
 * have an import due — one queued at connect, one an operator asked for, the six-hourly check for
 * posts made on the platform, or a run waiting out the rate limit. Usually none, so the tick is a
 * cheap read. What is due, how much is read and when to stop all live in
 * `core/services/post-import.ts`.
 *
 * THIN, like the analytics worker: schedule + dispatch only, no logic here. A separate queue from
 * `publish`, so a long backfill never sits in front of a post that is due.
 */
export function buildPostImportWorker(redisUrl: string): Worker {
  const connection = { url: redisUrl };
  const queue = new Queue(POST_IMPORT_QUEUE, { connection });

  // NOTE: no ':' in the jobId — BullMQ rejects custom ids containing a colon.
  void queue.add(
    'tick',
    {},
    {
      repeat: { every: IMPORT_TICK_INTERVAL_MS },
      jobId: 'post-import-tick',
      removeOnComplete: true,
      removeOnFail: false,
    },
  );

  // concurrency 1: one account is read at a time, so imports never add up against the rate limit.
  return new Worker(POST_IMPORT_QUEUE, async () => runDueImports(), { connection, concurrency: 1 });
}
