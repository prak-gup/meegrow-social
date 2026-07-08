import { and, desc, eq, gte, lte, lt, or, type SQL } from 'drizzle-orm';
import { db, withWorkspace, schema } from '@meegrow-social/db';
import type {
  LogEntryView,
  LogsAggregateBucket,
  LogsAggregateInput,
  LogsAggregateResult,
  LogsQueryInput,
  LogsQueryResult,
} from '@meegrow-social/contracts';

/**
 * Logs service (PRD F8). Filter/pagination/bucketing math is kept in PURE functions (no DB
 * handle, no I/O) so it is unit-testable in isolation; the exported `query*`/`aggregate*`/
 * `prune*` functions are the thin DB-touching wrappers around that math (AX-PRD §4).
 */

const RETENTION_DAYS = 90;

// --- Pure helpers ---------------------------------------------------------

/**
 * Classifies a stored `status` string as an error for aggregation purposes. `event_logs.status`
 * is free-text and means different things per `kind` — publish/connection/webhook rows store
 * `'published' | 'failed' | ...`, api_request rows store an HTTP status code as a string. Both
 * shapes are covered: known failure words, or a numeric code >= 400.
 */
export function isErrorStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  const normalized = status.trim().toLowerCase();
  if (normalized === 'failed' || normalized === 'error') return true;
  const code = Number(normalized);
  return Number.isFinite(code) && code >= 400;
}

export interface LogCursor {
  createdAt: Date;
  id: string;
}

/** Opaque keyset-pagination cursor: base64url of `{createdAt, id}`. Never throws on decode. */
export function encodeLogCursor(row: LogCursor): string {
  const payload = JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeLogCursor(cursor: string): LogCursor | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as { createdAt?: unknown; id?: unknown };
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') return null;
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

/** Cutoff timestamp for retention pruning: rows created before this are eligible for deletion. */
export function retentionCutoff(now: Date, retentionDays = RETENTION_DAYS): Date {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}

/** Floors `date` to the start of its `bucketMinutes`-wide window (UTC epoch-aligned). */
export function bucketStartFor(date: Date, bucketMinutes: number): Date {
  const bucketMs = bucketMinutes * 60_000;
  return new Date(Math.floor(date.getTime() / bucketMs) * bucketMs);
}

export interface AggregatableRow {
  createdAt: Date;
  status: string | null;
}

/**
 * Reduces raw `(createdAt, status)` rows into fixed-width time buckets covering `[from, to]`.
 * Buckets with no matching rows are still emitted (zero-filled) so the UI can chart a continuous
 * window. Pure — no DB access, so it is unit-testable with fabricated rows.
 */
export function aggregateEventRows(
  rows: AggregatableRow[],
  from: Date,
  to: Date,
  bucketMinutes: number,
): LogsAggregateBucket[] {
  const bucketMs = bucketMinutes * 60_000;
  const startMs = bucketStartFor(from, bucketMinutes).getTime();
  const endMs = to.getTime();

  const buckets = new Map<
    number,
    { total: number; errorCount: number; byStatus: Record<string, number> }
  >();
  for (let t = startMs; t <= endMs; t += bucketMs) {
    buckets.set(t, { total: 0, errorCount: 0, byStatus: {} });
  }

  for (const row of rows) {
    const key = bucketStartFor(row.createdAt, bucketMinutes).getTime();
    const bucket = buckets.get(key);
    if (!bucket) continue; // row falls outside [from, to] after bucketing — ignore
    bucket.total += 1;
    const statusKey = row.status ?? 'unknown';
    bucket.byStatus[statusKey] = (bucket.byStatus[statusKey] ?? 0) + 1;
    if (isErrorStatus(row.status)) bucket.errorCount += 1;
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([bucketStartMs, v]) => ({
      bucketStart: new Date(bucketStartMs),
      total: v.total,
      errorCount: v.errorCount,
      byStatus: v.byStatus,
    }));
}

// --- DB-touching wrappers --------------------------------------------------

type EventLogRow = typeof schema.eventLogs.$inferSelect;

function toLogView(row: EventLogRow): LogEntryView {
  return {
    id: row.id,
    kind: row.kind as LogEntryView['kind'],
    route: row.route,
    status: row.status,
    platform: row.platform,
    account: row.account,
    durationMs: row.durationMs,
    message: row.message,
    createdAt: row.createdAt,
  };
}

/**
 * `GET /v1/logs` data layer. Filters are ANDed together; pagination is keyset-based on
 * `(createdAt DESC, id DESC)` so results stay stable even as new rows are inserted concurrently.
 */
export async function queryEventLogs(
  workspaceId: string,
  filters: LogsQueryInput,
): Promise<LogsQueryResult> {
  const cursor = filters.cursor ? decodeLogCursor(filters.cursor) : null;

  return withWorkspace(workspaceId, async (tx) => {
    const conditions: SQL[] = [];
    if (filters.kind) conditions.push(eq(schema.eventLogs.kind, filters.kind));
    if (filters.status) conditions.push(eq(schema.eventLogs.status, filters.status));
    if (filters.platform) conditions.push(eq(schema.eventLogs.platform, filters.platform));
    if (filters.route) conditions.push(eq(schema.eventLogs.route, filters.route));
    if (filters.from) conditions.push(gte(schema.eventLogs.createdAt, filters.from));
    if (filters.to) conditions.push(lte(schema.eventLogs.createdAt, filters.to));
    if (cursor) {
      conditions.push(
        or(
          lt(schema.eventLogs.createdAt, cursor.createdAt),
          and(eq(schema.eventLogs.createdAt, cursor.createdAt), lt(schema.eventLogs.id, cursor.id)),
        )!,
      );
    }

    const rows = await tx
      .select()
      .from(schema.eventLogs)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(schema.eventLogs.createdAt), desc(schema.eventLogs.id))
      .limit(filters.limit + 1);

    const hasMore = rows.length > filters.limit;
    const page = hasMore ? rows.slice(0, filters.limit) : rows;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeLogCursor(last) : null;

    return { items: page.map(toLogView), nextCursor };
  });
}

/** `GET /v1/logs/aggregate` data layer: fetch the window, reduce with the pure bucketing fn. */
export async function aggregateEventLogs(
  workspaceId: string,
  params: LogsAggregateInput,
): Promise<LogsAggregateResult> {
  return withWorkspace(workspaceId, async (tx) => {
    const conditions = [
      gte(schema.eventLogs.createdAt, params.from),
      lte(schema.eventLogs.createdAt, params.to),
    ];
    if (params.kind) conditions.push(eq(schema.eventLogs.kind, params.kind));
    if (params.platform) conditions.push(eq(schema.eventLogs.platform, params.platform));

    const rows = await tx
      .select({ createdAt: schema.eventLogs.createdAt, status: schema.eventLogs.status })
      .from(schema.eventLogs)
      .where(and(...conditions));

    return { buckets: aggregateEventRows(rows, params.from, params.to, params.bucketMinutes) };
  });
}

/**
 * Insert one `api_request` event_log row. Called from the Fastify `onResponse` hook —
 * deliberately a single small insert (no batching) so a slow DB never compounds request latency
 * beyond the fire-and-forget call site in `apps/api`.
 */
export async function recordApiRequestLog(entry: {
  workspaceId: string;
  route: string;
  status: number;
  durationMs: number;
}): Promise<void> {
  await withWorkspace(entry.workspaceId, async (tx) => {
    await tx.insert(schema.eventLogs).values({
      workspaceId: entry.workspaceId,
      kind: 'api_request',
      route: entry.route,
      status: String(entry.status),
      durationMs: Math.round(entry.durationMs),
    });
  });
}

/**
 * Retention guard (PRD F8): deletes `event_logs` rows older than `retentionDays` (default 90),
 * across every workspace. `event_logs` is RLS-forced tenant data, so — per the `withWorkspace`
 * contract — pruning loops per-workspace rather than issuing one cross-tenant DELETE; `workspaces`
 * itself is the one non-tenant table this reads directly (same pattern as auth.ts). Meant to be
 * invoked by a repeatable job (see apps/worker); returns the total rows deleted for logging.
 */
export async function pruneEventLogs(
  now: Date = new Date(),
  retentionDays = RETENTION_DAYS,
): Promise<number> {
  const cutoff = retentionCutoff(now, retentionDays);
  const workspaces = await db().select({ id: schema.workspaces.id }).from(schema.workspaces);

  let deleted = 0;
  for (const ws of workspaces) {
    await withWorkspace(ws.id, async (tx) => {
      const removed = await tx
        .delete(schema.eventLogs)
        .where(lt(schema.eventLogs.createdAt, cutoff))
        .returning({ id: schema.eventLogs.id });
      deleted += removed.length;
    });
  }
  return deleted;
}
