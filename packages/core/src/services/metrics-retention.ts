import { and, eq, inArray, isNotNull, isNull, lt, notInArray, or } from 'drizzle-orm';
import { db, schema, withWorkspace } from '@meegrow-social/db';
import type { ProviderIdentifier } from '@meegrow-social/contracts';
import { YOUTUBE_DATA_RETENTION_DAYS } from '../providers/google/youtube.js';

/**
 * Metric retention (issue #61). `metrics` is append-only and keeps its rows forever, which is the
 * product for most platforms and a policy breach for YouTube: Developer Policies III.E.4 and
 * III.D.2.c want stored API data deleted or refreshed within 30 calendar days. The analytics
 * sweeper already re-reads the current numbers every day (the "refresh"); this deletes the
 * snapshots that have aged past the limit (the "delete").
 *
 * The limit is keyed by provider here, not read off the registry, on purpose: YouTube is
 * registered only while its env switch is on, and rows must keep expiring after it is turned off.
 *
 * Rows are matched by where they came from (`posts.provider` / `connections.provider`), never by
 * metric name (BUILD-SPEC-V2 invariant 7). `metrics` has no foreign keys, so a row whose post or
 * connection has since been deleted can no longer be attributed to any platform; no read API can
 * reach such a row either, so past the shortest limit it is deleted too rather than kept as data
 * that might be YouTube's.
 */
export const METRIC_RETENTION_DAYS: Partial<Record<ProviderIdentifier, number>> = {
  youtube: YOUTUBE_DATA_RETENTION_DAYS,
};

/** How often the worker runs the prune. The cutoff is pulled in by this much — see below. */
export const METRIC_RETENTION_SWEEP_MS = 6 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A day of margin on top of the sweep interval, so a worker that is down overnight stays inside. */
const SAFETY_MARGIN_MS = DAY_MS;

/**
 * Rows stored before this are deleted. Measured on `created_at` — when WE stored the row — because
 * that is what the policy limits; `captured_at` is the day the number describes and can be older.
 *
 * Earlier than `now - retentionDays` by the margin plus one sweep interval: a row is only deleted
 * when a sweep runs, so without the allowance it could outlive the limit by up to an interval.
 */
export function metricRetentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(
    now.getTime() - retentionDays * DAY_MS + SAFETY_MARGIN_MS + METRIC_RETENTION_SWEEP_MS,
  );
}

export interface MetricsPruneResult {
  /** Rows deleted because their platform's limit passed, by provider. */
  expired: Partial<Record<ProviderIdentifier, number>>;
  /** Rows deleted because their post or connection no longer exists. */
  orphaned: number;
}

/**
 * Delete expired metric rows in every workspace. Loops per workspace under `withWorkspace` like
 * `pruneEventLogs` — `metrics` is RLS-forced tenant data. Meant for a repeatable job (apps/worker).
 */
export async function pruneExpiredMetrics(now: Date = new Date()): Promise<MetricsPruneResult> {
  const result: MetricsPruneResult = { expired: {}, orphaned: 0 };
  const limits = Object.entries(METRIC_RETENTION_DAYS) as Array<[ProviderIdentifier, number]>;
  if (limits.length === 0) return result;
  const shortest = Math.min(...limits.map(([, days]) => days));

  const workspaces = await db().select({ id: schema.workspaces.id }).from(schema.workspaces);
  for (const ws of workspaces) {
    await withWorkspace(ws.id, async (tx) => {
      for (const [provider, days] of limits) {
        const removed = await tx
          .delete(schema.metrics)
          .where(
            and(
              lt(schema.metrics.createdAt, metricRetentionCutoff(now, days)),
              or(
                inArray(
                  schema.metrics.postId,
                  tx
                    .select({ id: schema.posts.id })
                    .from(schema.posts)
                    .where(eq(schema.posts.provider, provider)),
                ),
                inArray(
                  schema.metrics.connectionId,
                  tx
                    .select({ id: schema.connections.id })
                    .from(schema.connections)
                    .where(eq(schema.connections.provider, provider)),
                ),
              ),
            ),
          )
          .returning({ id: schema.metrics.id });
        result.expired[provider] = (result.expired[provider] ?? 0) + removed.length;
      }

      const postIds = tx.select({ id: schema.posts.id }).from(schema.posts);
      const connectionIds = tx.select({ id: schema.connections.id }).from(schema.connections);
      const orphans = await tx
        .delete(schema.metrics)
        .where(
          and(
            lt(schema.metrics.createdAt, metricRetentionCutoff(now, shortest)),
            or(
              // A per-post row whose post is gone.
              and(isNotNull(schema.metrics.postId), notInArray(schema.metrics.postId, postIds)),
              // An account-level row whose connection is gone.
              and(
                isNull(schema.metrics.postId),
                isNotNull(schema.metrics.connectionId),
                notInArray(schema.metrics.connectionId, connectionIds),
              ),
            ),
          ),
        )
        .returning({ id: schema.metrics.id });
      result.orphaned += orphans.length;
    });
  }
  return result;
}
