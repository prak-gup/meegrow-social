import { z } from 'zod';

/**
 * One weekly recurring slot. `dow` follows JS `Date#getDay()` convention (0=Sunday..6=Saturday)
 * so it round-trips with `Date` without an extra day-of-week library on either side of the wire.
 * `time` is the local wall-clock time in the queue's `timezone` — DST is resolved at slot-compute
 * time (core/services/queues.ts), never baked into the stored slot.
 */
export const weeklySlot = z.object({
  dow: z.number().int().min(0).max(6),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time must be 24h "HH:mm"'),
});
export type WeeklySlot = z.infer<typeof weeklySlot>;

/** Queue CRUD input (PRD F3.4). `timezone` must be a valid IANA zone — validated in core. */
export const createQueueInput = z.object({
  name: z.string().min(1).max(200),
  timezone: z.string().min(1),
  slots: z.array(weeklySlot).min(1),
  active: z.boolean().default(true),
});
export type CreateQueueInput = z.infer<typeof createQueueInput>;

export const updateQueueInput = z.object({
  name: z.string().min(1).max(200).optional(),
  timezone: z.string().min(1).optional(),
  slots: z.array(weeklySlot).min(1).optional(),
  active: z.boolean().optional(),
});
export type UpdateQueueInput = z.infer<typeof updateQueueInput>;

export const queueView = z.object({
  id: z.string().uuid(),
  name: z.string(),
  timezone: z.string(),
  slots: z.array(weeklySlot),
  active: z.boolean(),
  createdAt: z.coerce.date(),
});
export type QueueView = z.infer<typeof queueView>;

/** `GET /v1/queues/:id/slots` — how many upcoming slots to preview. */
export const queueSlotsQuery = z.object({
  count: z.coerce.number().int().min(1).max(50).default(5),
});
export type QueueSlotsQuery = z.infer<typeof queueSlotsQuery>;

export const queueSlot = z.object({
  publishAt: z.coerce.date(),
  /** The same instant as wall-clock time in the queue's `timezone` (ISO 8601 with offset). */
  localTime: z.string(),
});
export type QueueSlot = z.infer<typeof queueSlot>;

/**
 * The next slots a queue would hand out, in order: the first is what the next add-to-queue gets,
 * the second what the one after it gets, and so on. A snapshot — nothing is reserved. May hold
 * fewer than asked when the queue runs out of free slots inside its look-ahead window.
 */
export const queueSlotsView = z.object({
  queueId: z.string().uuid(),
  timezone: z.string(),
  slots: z.array(queueSlot),
});
export type QueueSlotsView = z.infer<typeof queueSlotsView>;
