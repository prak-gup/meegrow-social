import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '@meegrow-social/db';
import {
  createConnection,
  createWorkspace,
  resetDb,
  useRecordingScheduler,
} from '@meegrow-social/testing';
import type { WeeklySlot } from '@meegrow-social/contracts';
import { DateTime } from 'luxon';
import {
  createQueue,
  getQueue,
  listQueues,
  updateQueue,
  deleteQueue,
  nextFreeSlotForQueue,
  QueueNotFoundError,
  QueueInactiveError,
  type Clock,
} from './queues.js';
import { createPost } from './posts.js';

beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgres://mgs:mgs@localhost:5433/meegrow_social';
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
});
beforeEach(resetDb);
afterAll(closeDb);

function clockAt(iso: string, zone: string): Clock {
  const dt = DateTime.fromISO(iso, { zone });
  if (!dt.isValid) throw new Error(`bad test fixture time: ${iso} (${dt.invalidReason})`);
  return { now: () => dt.toJSDate() };
}

describe('queues — CRUD', () => {
  it('creates, lists, updates, and deletes a queue', async () => {
    const ws = await createWorkspace();
    const slots: WeeklySlot[] = [{ dow: 1, time: '09:00' }];

    const created = await createQueue(ws, {
      name: 'Morning',
      timezone: 'Asia/Kolkata',
      slots,
      active: true,
    });
    expect(created.name).toBe('Morning');
    expect(created.active).toBe(true);

    const fetched = await getQueue(ws, created.id);
    expect(fetched?.id).toBe(created.id);

    const listed = await listQueues(ws);
    expect(listed).toHaveLength(1);

    const updated = await updateQueue(ws, created.id, { name: 'Renamed', active: false });
    expect(updated?.name).toBe('Renamed');
    expect(updated?.active).toBe(false);

    const deleted = await deleteQueue(ws, created.id);
    expect(deleted).toBe(true);
    expect(await getQueue(ws, created.id)).toBeNull();
  });

  it('rejects an invalid IANA timezone', async () => {
    const ws = await createWorkspace();
    await expect(
      createQueue(ws, {
        name: 'Bad TZ',
        timezone: 'Not/A_Zone',
        slots: [{ dow: 1, time: '09:00' }],
        active: true,
      }),
    ).rejects.toThrow(/invalid IANA timezone/);
  });
});

describe('createPost — queue mode (PRD F3.4)', () => {
  it('computes the next free slot in the queue timezone and schedules the post (replaces the draft fallback)', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const connectionId = await createConnection(ws, 'fake');
    const queue = await createQueue(ws, {
      name: 'Daily',
      timezone: 'Asia/Kolkata',
      slots: [{ dow: 1, time: '09:00' }],
      active: true,
    });

    const [post] = await createPost(ws, {
      caption: 'queued post',
      media: [],
      variants: [{ connectionId, provider: 'fake' }],
      schedule: { type: 'queue', queueId: queue.id },
    });

    expect(post?.status).toBe('scheduled');
    expect(post?.publishAt).toBeInstanceOf(Date);
    expect(post?.queueId).toBe(queue.id);
  });

  it('lands two consecutive add-to-queue calls on two different slots, in order', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const connectionId = await createConnection(ws, 'fake');
    // Every day at 23:59 — deterministic regardless of what day the suite runs on, and Asia/Kolkata
    // has no DST so the 24h gap between consecutive daily slots is exact.
    const slots: WeeklySlot[] = Array.from({ length: 7 }, (_, dow) => ({ dow, time: '23:59' }));
    const queue = await createQueue(ws, {
      name: 'Daily',
      timezone: 'Asia/Kolkata',
      slots,
      active: true,
    });

    const [first] = await createPost(ws, {
      caption: 'first',
      media: [],
      variants: [{ connectionId, provider: 'fake' }],
      schedule: { type: 'queue', queueId: queue.id },
    });
    const [second] = await createPost(ws, {
      caption: 'second',
      media: [],
      variants: [{ connectionId, provider: 'fake' }],
      schedule: { type: 'queue', queueId: queue.id },
    });

    expect(first?.publishAt).toBeInstanceOf(Date);
    expect(second?.publishAt).toBeInstanceOf(Date);
    expect(second!.publishAt!.getTime()).toBeGreaterThan(first!.publishAt!.getTime());
    expect(second!.publishAt!.getTime() - first!.publishAt!.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('rejects add-to-queue on a deactivated queue', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const connectionId = await createConnection(ws, 'fake');
    const queue = await createQueue(ws, {
      name: 'Paused',
      timezone: 'Asia/Kolkata',
      slots: [{ dow: 1, time: '09:00' }],
      active: false,
    });

    await expect(
      createPost(ws, {
        caption: 'should be rejected',
        media: [],
        variants: [{ connectionId, provider: 'fake' }],
        schedule: { type: 'queue', queueId: queue.id },
      }),
    ).rejects.toThrow(QueueInactiveError);
  });

  it('rejects add-to-queue on a queue that does not exist', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const connectionId = await createConnection(ws, 'fake');

    await expect(
      createPost(ws, {
        caption: 'no such queue',
        media: [],
        variants: [{ connectionId, provider: 'fake' }],
        schedule: { type: 'queue', queueId: '00000000-0000-0000-0000-000000000000' },
      }),
    ).rejects.toThrow(QueueNotFoundError);
  });
});

describe('nextFreeSlotForQueue — DST-safe against a real queue row', () => {
  it('Asia/Kolkata (no DST): resolves the configured weekly slot with a fixed offset', async () => {
    const ws = await createWorkspace();
    const queue = await createQueue(ws, {
      name: 'IST',
      timezone: 'Asia/Kolkata',
      slots: [{ dow: 1, time: '09:00' }], // Monday
      active: true,
    });

    const { publishAt } = await nextFreeSlotForQueue(
      ws,
      queue.id,
      clockAt('2026-07-05T10:00:00', 'Asia/Kolkata'), // a Sunday
    );
    const zoned = DateTime.fromJSDate(publishAt, { zone: 'Asia/Kolkata' });
    expect(zoned.toISODate()).toBe('2026-07-06'); // the following Monday
    expect(zoned.offset).toBe(330); // UTC+5:30 year-round
  });

  it('America/New_York (DST-observing): offset flips across the spring-forward boundary', async () => {
    const ws = await createWorkspace();
    const dailySlot: WeeklySlot[] = Array.from({ length: 7 }, (_, dow) => ({ dow, time: '09:00' }));
    const queue = await createQueue(ws, {
      name: 'NYC',
      timezone: 'America/New_York',
      slots: dailySlot,
      active: true,
    });

    const before = await nextFreeSlotForQueue(
      ws,
      queue.id,
      clockAt('2026-03-06T08:00:00', 'America/New_York'),
    );
    expect(DateTime.fromJSDate(before.publishAt, { zone: 'America/New_York' }).offset).toBe(-300); // EST

    const after = await nextFreeSlotForQueue(
      ws,
      queue.id,
      clockAt('2026-03-09T08:00:00', 'America/New_York'),
    );
    expect(DateTime.fromJSDate(after.publishAt, { zone: 'America/New_York' }).offset).toBe(-240); // EDT
  });
});
