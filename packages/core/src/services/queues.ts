import { withWorkspace, schema, type Tx } from '@meegrow-social/db';
import { and, eq, ne } from 'drizzle-orm';
import { DateTime, IANAZone } from 'luxon';
import {
  createQueueInput,
  updateQueueInput,
  type CreateQueueInput,
  type UpdateQueueInput,
  type QueueSlotsView,
  type QueueView,
  type WeeklySlot,
} from '@meegrow-social/contracts';

export class QueueNotFoundError extends Error {}
export class QueueInactiveError extends Error {}

function assertValidTimezone(timezone: string): void {
  if (!IANAZone.isValidZone(timezone)) {
    throw new Error(`invalid IANA timezone: ${timezone}`);
  }
}

/**
 * Queue CRUD (PRD F3.4). Timezone + slots live on the queue; occupancy is derived from
 * `posts.queueId` at slot-compute time (see `nextFreeSlotForQueue` below), never stored here.
 */
export async function createQueue(
  workspaceId: string,
  rawInput: CreateQueueInput,
): Promise<QueueView> {
  const input = createQueueInput.parse(rawInput);
  assertValidTimezone(input.timezone);
  return withWorkspace(workspaceId, async (tx) => {
    const [row] = await tx
      .insert(schema.queues)
      .values({
        workspaceId,
        name: input.name,
        timezone: input.timezone,
        slots: input.slots,
        active: input.active,
      })
      .returning();
    if (!row) throw new Error('failed to create queue');
    return toView(row);
  });
}

export async function listQueues(workspaceId: string): Promise<QueueView[]> {
  return withWorkspace(workspaceId, async (tx) => {
    const rows = await tx.select().from(schema.queues);
    return rows.map(toView);
  });
}

export async function getQueue(workspaceId: string, queueId: string): Promise<QueueView | null> {
  return withWorkspace(workspaceId, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.queues)
      .where(eq(schema.queues.id, queueId))
      .limit(1);
    return row ? toView(row) : null;
  });
}

export async function updateQueue(
  workspaceId: string,
  queueId: string,
  rawInput: UpdateQueueInput,
): Promise<QueueView | null> {
  const input = updateQueueInput.parse(rawInput);
  if (input.timezone) assertValidTimezone(input.timezone);
  return withWorkspace(workspaceId, async (tx) => {
    const [row] = await tx
      .update(schema.queues)
      .set(input)
      .where(eq(schema.queues.id, queueId))
      .returning();
    return row ? toView(row) : null;
  });
}

export async function deleteQueue(workspaceId: string, queueId: string): Promise<boolean> {
  return withWorkspace(workspaceId, async (tx) => {
    const deleted = await tx.delete(schema.queues).where(eq(schema.queues.id, queueId)).returning();
    return deleted.length > 0;
  });
}

type QueueRow = typeof schema.queues.$inferSelect;

function toView(row: QueueRow): QueueView {
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    slots: row.slots as WeeklySlot[],
    active: row.active,
    createdAt: row.createdAt,
  };
}

/** Injected clock so slot computation is a pure, DB-free, unit-testable function. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

const MAX_LOOKAHEAD_DAYS = 90;

/**
 * Pure function: given a queue's timezone + weekly slots and the set of already-occupied slot
 * instants, returns the earliest future slot not in `occupied`. No DB access — the injected
 * `clock` is the only source of "now", which is what makes this unit-testable for DST correctness
 * (e.g. Asia/Kolkata has no DST; America/New_York does) without a database.
 *
 * DST handling: `DateTime#set` on a zone-aware DateTime re-normalizes through the zone's offset
 * table, so a local time that doesn't exist (spring-forward gap) rolls forward to the next valid
 * instant, and a local time that's ambiguous (fall-back) resolves to Luxon's first-occurrence
 * default — both produce a valid, monotonically-sensible instant rather than throwing or silently
 * picking a wrong absolute time.
 */
export function computeNextFreeSlot(params: {
  timezone: string;
  slots: readonly WeeklySlot[];
  occupied: readonly Date[];
  clock: Clock;
  maxLookaheadDays?: number;
}): Date {
  const slot = findNextFreeSlot(params);
  if (!slot) {
    throw new Error(
      `no free slot found for queue within ${params.maxLookaheadDays ?? MAX_LOOKAHEAD_DAYS} days`,
    );
  }
  return slot;
}

/** The search behind `computeNextFreeSlot`; null (not a throw) when the look-ahead is exhausted. */
function findNextFreeSlot(params: {
  timezone: string;
  slots: readonly WeeklySlot[];
  occupied: readonly Date[];
  clock: Clock;
  maxLookaheadDays?: number;
}): Date | null {
  const { timezone, slots, occupied, clock } = params;
  if (slots.length === 0) throw new Error('queue has no slots configured');
  const maxLookaheadDays = params.maxLookaheadDays ?? MAX_LOOKAHEAD_DAYS;

  const occupiedMs = new Set(occupied.map((d) => d.getTime()));
  const now = DateTime.fromJSDate(clock.now(), { zone: timezone });

  for (let dayOffset = 0; dayOffset <= maxLookaheadDays; dayOffset++) {
    const day = now.plus({ days: dayOffset }).startOf('day');
    // Luxon weekday: 1=Mon..7=Sun. Convert to JS Date#getDay(): 0=Sun..6=Sat.
    const jsDow = day.weekday % 7;
    const daySlots = slots
      .filter((s) => s.dow === jsDow)
      .slice()
      .sort((a, b) => a.time.localeCompare(b.time));

    for (const slot of daySlots) {
      const [hourStr, minuteStr] = slot.time.split(':');
      const hour = Number(hourStr);
      const minute = Number(minuteStr);
      const candidate = day.set({ hour, minute, second: 0, millisecond: 0 });
      if (candidate <= now) continue; // slots are for upcoming scheduling only
      const candidateJs = candidate.toJSDate();
      if (!occupiedMs.has(candidateJs.getTime())) return candidateJs;
    }
  }

  return null;
}

/**
 * The next `count` slots the queue would hand out, in order. Pure, and deliberately NOT a second
 * algorithm: it replays `count` consecutive add-to-queue calls through the same search, feeding
 * each pick back in as occupied — so a preview cannot drift from what add-to-queue really assigns.
 * Returns fewer than `count` when the look-ahead window runs out of free slots.
 */
export function computeUpcomingSlots(params: {
  timezone: string;
  slots: readonly WeeklySlot[];
  occupied: readonly Date[];
  clock: Clock;
  count: number;
  maxLookaheadDays?: number;
}): Date[] {
  const picked: Date[] = [];
  while (picked.length < params.count) {
    const next = findNextFreeSlot({ ...params, occupied: [...params.occupied, ...picked] });
    if (!next) break;
    picked.push(next);
  }
  return picked;
}

/**
 * Loads the queue, gathers occupied slots from existing (non-cancelled) posts already assigned to
 * it, and returns the next free slot. Throws `QueueNotFoundError` / `QueueInactiveError` so callers
 * (REST/MCP) can map to 404/400 without inspecting message strings.
 */
export async function nextFreeSlotForQueue(
  workspaceId: string,
  queueId: string,
  clock: Clock = systemClock,
): Promise<{ queue: QueueView; publishAt: Date }> {
  return withWorkspace(workspaceId, async (tx) => {
    const { row, occupied } = await loadActiveQueue(tx, queueId);
    const publishAt = computeNextFreeSlot({
      timezone: row.timezone,
      slots: row.slots as WeeklySlot[],
      occupied,
      clock,
    });
    return { queue: toView(row), publishAt };
  });
}

/**
 * Preview the next `count` slots of a queue without taking any (`GET /v1/queues/:id/slots`, MCP
 * `preview_queue_slots`). Reads the queue and its occupancy exactly as `nextFreeSlotForQueue` does
 * and throws the same `QueueNotFoundError` / `QueueInactiveError`. A snapshot: nothing is reserved,
 * so a concurrent add-to-queue can still take the first slot before the caller does.
 */
export async function previewQueueSlots(
  workspaceId: string,
  queueId: string,
  count: number,
  clock: Clock = systemClock,
): Promise<QueueSlotsView> {
  return withWorkspace(workspaceId, async (tx) => {
    const { row, occupied } = await loadActiveQueue(tx, queueId);
    const upcoming = computeUpcomingSlots({
      timezone: row.timezone,
      slots: row.slots as WeeklySlot[],
      occupied,
      clock,
      count,
    });
    return {
      queueId: row.id,
      timezone: row.timezone,
      slots: upcoming.map((publishAt) => ({
        publishAt,
        localTime: DateTime.fromJSDate(publishAt, { zone: row.timezone }).toISO() ?? '',
      })),
    };
  });
}

/** The queue row plus every slot instant already taken by a non-cancelled post assigned to it. */
async function loadActiveQueue(
  tx: Tx,
  queueId: string,
): Promise<{ row: QueueRow; occupied: Date[] }> {
  const [row] = await tx.select().from(schema.queues).where(eq(schema.queues.id, queueId)).limit(1);
  if (!row) throw new QueueNotFoundError(`queue ${queueId} not found`);
  if (!row.active) throw new QueueInactiveError(`queue ${queueId} is not active`);

  const occupiedRows = await tx
    .select({ publishAt: schema.posts.publishAt })
    .from(schema.posts)
    .where(and(eq(schema.posts.queueId, queueId), ne(schema.posts.status, 'cancelled')));
  const occupied = occupiedRows.map((r) => r.publishAt).filter((d): d is Date => d !== null);
  return { row, occupied };
}
