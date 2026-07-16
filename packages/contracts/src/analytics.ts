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
