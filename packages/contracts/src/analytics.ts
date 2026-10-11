import { z } from 'zod';

/**
 * Analytics read models (issue #9, PRD F5).
 *
 * `metric` is a free-form string on purpose — platforms rename their metrics (Meta retired the
 * `impressions` family for views-era names across Nov 2025–Jun 2026, and `page_fans` for a
 * `followers_count` node field). A closed enum here would turn every platform rename into a
 * migration, so provider-native names are stored and passed through verbatim.
 */
export const metricPoint = z.object({
  metric: z.string(),
  value: z.number(),
  /** The provider's own capture time where it gives one; otherwise when we swept. */
  capturedAt: z.coerce.date(),
});
export type MetricPointView = z.infer<typeof metricPoint>;

/** Per-post metrics: newest value per metric name, plus the full append-only history. */
export const postMetricsView = z.object({
  latest: z.record(z.string(), z.number()),
  series: z.array(metricPoint),
});
export type PostMetricsView = z.infer<typeof postMetricsView>;

/** Follower trend for one connection, newest first. */
export const followerSeriesView = z.object({
  followers: z.array(metricPoint),
});
export type FollowerSeriesView = z.infer<typeof followerSeriesView>;

/** Most post ids one bulk metrics read takes (`POST /v1/posts/metrics/latest`). */
export const BULK_METRICS_MAX_POSTS = 200;

export const bulkPostMetricsInput = z.object({
  postIds: z.array(z.string().uuid()).min(1).max(BULK_METRICS_MAX_POSTS),
});
export type BulkPostMetricsInput = z.infer<typeof bulkPostMetricsInput>;

/** One post's newest value per metric name, and when the newest of those was captured. */
export const postLatestMetrics = z.object({
  latest: z.record(z.string(), z.number()),
  /** Null when nothing has been collected for the post (yet, or any more — rows can be pruned). */
  capturedAt: z.coerce.date().nullable(),
});
export type PostLatestMetrics = z.infer<typeof postLatestMetrics>;

/**
 * Latest metrics for many posts at once, keyed by post id. A requested id that is not a post of
 * this workspace has NO entry; a post with nothing collected has an entry with an empty `latest`.
 */
export const bulkPostMetricsView = z.object({
  metrics: z.record(z.string().uuid(), postLatestMetrics),
});
export type BulkPostMetricsView = z.infer<typeof bulkPostMetricsView>;

/**
 * When this workspace's numbers were last collected and when the next collection falls due
 * (`GET /v1/analytics/status`), so a screen can say "data as of … · next refresh …" from facts.
 */
export const analyticsStatusView = z.object({
  /** Newest `capturedAt` of any metric in the workspace; null when nothing has been collected. */
  lastCapturedAt: z.coerce.date().nullable(),
  /** Last time the sweep polled any post or account of the workspace, with or without a result. */
  lastSweptAt: z.coerce.date().nullable(),
  /**
   * Earliest time a post or account becomes due for its next poll. It is polled by the first sweep
   * at or after this — so up to `cadence.sweepIntervalMs` later. A time in the past means "due at
   * the next sweep". Null when nothing can be polled (no account with a usable connection).
   */
  nextDueAt: z.coerce.date().nullable(),
  /** The collection rules, in milliseconds, as core applies them. */
  cadence: z.object({
    sweepIntervalMs: z.number().int().positive(),
    freshPostWindowMs: z.number().int().positive(),
    freshPostIntervalMs: z.number().int().positive(),
    postIntervalMs: z.number().int().positive(),
    accountIntervalMs: z.number().int().positive(),
  }),
});
export type AnalyticsStatusView = z.infer<typeof analyticsStatusView>;
