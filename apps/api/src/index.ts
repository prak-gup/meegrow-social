import { setAttemptStore, setScheduler } from '@meegrow-social/core';
import { buildServer } from './server.js';
import { createBullScheduler } from './scheduler.js';
import { createRedisAttemptStore } from './attempt-store.js';

async function main(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('REDIS_URL is not set');
  setScheduler(createBullScheduler(redisUrl));
  // Shared login/password attempt counters, so the limits hold across API processes.
  setAttemptStore(createRedisAttemptStore(redisUrl));

  const app = await buildServer();
  const port = Number(process.env.API_PORT ?? 8990);
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`meegrow-social api on :${port} (REST + /mcp)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
