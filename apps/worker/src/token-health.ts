import { Queue, Worker } from 'bullmq';
import { refreshExpiringTokens } from './deps.js';

export const TOKEN_HEALTH_QUEUE = 'token-health';
const HOURLY_MS = 60 * 60 * 1000;

/**
 * Token-health sweeper (PRD F1.3): a repeatable BullMQ job that refreshes tokens approaching expiry
 * for refreshable providers and flags failed refreshes needs_reconnect. THIN — the worker only
 * schedules/dispatches; all cutoff + refresh logic lives in `core/services/token-health.ts`.
 */
export function buildTokenHealthWorker(redisUrl: string): Worker {
  const connection = { url: redisUrl };
  const queue = new Queue(TOKEN_HEALTH_QUEUE, { connection });

  // Idempotent: re-adding the same repeatable jobId on every worker boot is a no-op if unchanged.
  void queue.add(
    'sweep',
    {},
    {
      repeat: { every: HOURLY_MS },
      jobId: 'token-health-hourly',
      removeOnComplete: true,
      removeOnFail: false,
    },
  );

  return new Worker(
    TOKEN_HEALTH_QUEUE,
    async () => {
      return refreshExpiringTokens();
    },
    { connection, concurrency: 1 },
  );
}
