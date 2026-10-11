import { RedisConnection } from 'bullmq';
import type { AttemptCount, AttemptStore } from '@meegrow-social/core';

/**
 * Count one attempt and open the window on the first. One script, so a crash between INCR and
 * PEXPIRE cannot leave a counter with no expiry — which would be a lockout that never lifts. The
 * `ttl < 0` branch repairs such a key if one ever exists anyway.
 */
const HIT_LUA = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if count == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

/** Give one attempt back. Never creates the key: a DECR on a missing key would have no expiry. */
const UNHIT_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local count = redis.call('DECR', KEYS[1])
if count <= 0 then redis.call('DEL', KEYS[1]) end
return count
`;

const HIT_COMMAND = 'mgsAttemptHit';
const UNHIT_COMMAND = 'mgsAttemptUnhit';

/**
 * Redis-backed `AttemptStore`, so login/password attempt limits hold across API processes. Rides
 * on BullMQ's own Redis connection class — Redis is already in the stack for the job queues, and
 * this way no Redis client package becomes a direct dependency.
 *
 * It does not handle an unreachable Redis itself: commands simply reject or stall, and core's
 * `beginAuthAttempt` times them out and counts in-process instead.
 */
export function createRedisAttemptStore(redisUrl: string): AttemptStore & {
  close(): Promise<void>;
} {
  // Not a blocking (worker) connection, and no offline queue: while Redis is away a command must
  // reject at once so core falls back, not sit queued and land as a burst of stale counts later.
  const connection = new RedisConnection(
    { url: redisUrl, enableOfflineQueue: false },
    { blocking: false },
  );
  // An EventEmitter with no 'error' listener throws on emit; a Redis blip must not take the API down.
  connection.on('error', () => undefined);

  const ready = connection.client.then((client) => {
    client.defineCommand(HIT_COMMAND, { numberOfKeys: 1, lua: HIT_LUA });
    client.defineCommand(UNHIT_COMMAND, { numberOfKeys: 1, lua: UNHIT_LUA });
    return client;
  });
  // Surfaced by the first command instead; without this a failed first connect is an unhandled rejection.
  ready.catch(() => undefined);

  return {
    async hit(key, windowMs): Promise<AttemptCount> {
      const client = await ready;
      const [count, ttl] = (await client.runCommand(HIT_COMMAND, [key, windowMs])) as [
        number,
        number,
      ];
      return { count: Number(count), resetInMs: Number(ttl) };
    },
    async unhit(key) {
      await (await ready).runCommand(UNHIT_COMMAND, [key]);
    },
    async reset(key) {
      await (await ready).del(key);
    },
    async close() {
      await connection.close();
    },
  };
}
