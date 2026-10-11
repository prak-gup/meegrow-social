import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisConnection } from 'bullmq';
import { MemoryAttemptStore, type AttemptStore } from '@meegrow-social/core';
import { createRedisAttemptStore } from './attempt-store.js';

/**
 * The REAL Redis attempt store (needs Redis; CI provides it), and the in-process one through the
 * same cases: BUILD-SPEC-V2 invariant 4 — the store tests run on must not be more permissive than
 * the one production runs on.
 */
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const WINDOW_MS = 60_000;

let redisStore: ReturnType<typeof createRedisAttemptStore>;
let raw: RedisConnection;

beforeAll(() => {
  redisStore = createRedisAttemptStore(REDIS_URL);
  raw = new RedisConnection({ url: REDIS_URL }, { blocking: false });
  raw.on('error', () => undefined);
});
afterAll(async () => {
  await redisStore.close();
  await raw.close();
});

/** A key no other test (or run) has touched. */
const freshKey = () => `mgs:auth-attempts:test:${randomUUID()}`;

const stores: Array<[string, () => AttemptStore]> = [
  ['redis', () => redisStore],
  ['memory', () => new MemoryAttemptStore()],
];

describe.each(stores)('AttemptStore (%s)', (_name, store) => {
  it('counts hits on a key and reports the time left in its window', async () => {
    const key = freshKey();
    const first = await store().hit(key, WINDOW_MS);
    expect(first.count).toBe(1);
    expect(first.resetInMs).toBeGreaterThan(WINDOW_MS - 5_000);
    expect(first.resetInMs).toBeLessThanOrEqual(WINDOW_MS);
    expect((await store().hit(key, WINDOW_MS)).count).toBe(2);
    expect((await store().hit(key, WINDOW_MS)).count).toBe(3);
  });

  it('keeps separate keys apart', async () => {
    const s = store();
    const a = freshKey();
    await s.hit(a, WINDOW_MS);
    await s.hit(a, WINDOW_MS);
    expect((await s.hit(freshKey(), WINDOW_MS)).count).toBe(1);
  });

  it('does not extend the window on later hits', async () => {
    const s = store();
    const key = freshKey();
    const first = await s.hit(key, WINDOW_MS);
    await new Promise((r) => setTimeout(r, 30));
    const second = await s.hit(key, WINDOW_MS * 10);
    expect(second.resetInMs).toBeLessThanOrEqual(first.resetInMs);
  });

  it('starts over once the window has closed', async () => {
    const s = store();
    const key = freshKey();
    await s.hit(key, 40);
    await s.hit(key, 40);
    await new Promise((r) => setTimeout(r, 80));
    expect((await s.hit(key, WINDOW_MS)).count).toBe(1);
  });

  it('unhit gives one attempt back', async () => {
    const s = store();
    const key = freshKey();
    await s.hit(key, WINDOW_MS);
    await s.hit(key, WINDOW_MS);
    await s.unhit(key);
    expect((await s.hit(key, WINDOW_MS)).count).toBe(2);
  });

  it('unhit on an unknown key creates nothing', async () => {
    const s = store();
    const key = freshKey();
    await s.unhit(key);
    expect((await s.hit(key, WINDOW_MS)).count).toBe(1);
  });

  it('reset forgets the key', async () => {
    const s = store();
    const key = freshKey();
    await s.hit(key, WINDOW_MS);
    await s.hit(key, WINDOW_MS);
    await s.reset(key);
    expect((await s.hit(key, WINDOW_MS)).count).toBe(1);
  });

  it('counts concurrent hits exactly', async () => {
    const s = store();
    const key = freshKey();
    const counts = await Promise.all(Array.from({ length: 25 }, () => s.hit(key, WINDOW_MS)));
    expect(counts.map((c) => c.count).sort((x, y) => x - y)).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 1),
    );
  });
});

describe('redis attempt store — unhit', () => {
  it('unhit never leaves a counter at zero behind, and never creates one', async () => {
    const client = await raw.client;
    const key = freshKey();
    await redisStore.hit(key, WINDOW_MS);
    await redisStore.hit(key, WINDOW_MS);
    await redisStore.unhit(key);
    expect(await client.get(key)).toBe('1');
    await redisStore.unhit(key);
    // Unhit to zero deletes the key rather than leaving a zero with a TTL — or without one.
    expect(await client.get(key)).toBeNull();
    await redisStore.unhit(key);
    expect(await client.get(key)).toBeNull();
  });
});
