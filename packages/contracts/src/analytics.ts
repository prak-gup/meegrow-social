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
    /**
     * Posts older than `afterMs` are polled every `intervalMs` instead of `postIntervalMs`, oldest
     * rule last. Optional so an older payload still parses; absent means no such rule.
     */
    olderPosts: z
      .array(
        z.object({
          afterMs: z.number().int().positive(),
          intervalMs: z.number().int().positive(),
        }),
      )
      .optional(),
  }),
});
export type AnalyticsStatusView = z.infer<typeof analyticsStatusView>;

// --- Aggregate report (`GET /v1/analytics/report`) ----------------------------------------------

/**
 * Display concepts: the columns a person compares platforms by. They exist ONLY at read time — the
 * `metrics` table keeps each platform's own names (BUILD-SPEC-V2 invariant 7), and core's
 * `services/metric-concepts.ts` is the one place a concept is tied to native names. A platform with
 * no equivalent has no value for the concept (null, rendered "—"), never 0.
 */
export const METRIC_CONCEPTS = [
  'views',
  'reach',
  'likes',
  'comments',
  'shares',
  'saves',
  'clicks',
  'follows',
] as const;
export const metricConcept = z.enum(METRIC_CONCEPTS);
export type MetricConcept = z.infer<typeof metricConcept>;

/** The concepts an engagement counts: the numerator of the engagement rate. */
export const ENGAGEMENT_CONCEPTS = [
  'likes',
  'comments',
  'shares',
  'saves',
] as const satisfies readonly MetricConcept[];

const nullableNumber = z.number().nullable();

/** An object with one `value` per concept — a full record, where `z.record` would make each optional. */
const perConcept = <T extends z.ZodTypeAny>(value: T) =>
  z.object({
    views: value,
    reach: value,
    likes: value,
    comments: value,
    shares: value,
    saves: value,
    clicks: value,
    follows: value,
  });

/** One value per concept; null where nothing reported it. */
export const conceptValues = perConcept(nullableNumber);
export type ConceptValues = z.infer<typeof conceptValues>;

/** What an engagement rate was divided by. `mixed`: some posts by reach, others by views. */
export const engagementBasis = z.enum(['reach', 'views', 'mixed']);
export type EngagementBasis = z.infer<typeof engagementBasis>;

/**
 * Engagement rate of a set of posts: (likes + comments + shares + saves) ÷ reach × 100, a post
 * without reach divided by its views instead. Sums over the posts that have both an engagement
 * count and a denominator — a ratio of sums, not a mean of per-post rates.
 */
export const engagementRateStat = z.object({
  /** Percentage (4.2 = 4.2%). Null when no post in the set has both halves. */
  rate: nullableNumber,
  /** Engagements over every post that reports any, whether or not it has a denominator. */
  engagements: nullableNumber,
  basis: engagementBasis.nullable(),
  /** Posts in the set, and how many of them the rate is computed from. */
  posts: z.number().int(),
  postsCounted: z.number().int(),
  /** Of the counted posts: how many were divided by reach, and how many by views. */
  byReach: z.number().int(),
  byViews: z.number().int(),
  /** The engagement concepts at least one counted post reports — the rest are not in the numerator. */
  components: z.array(metricConcept),
});
export type EngagementRateStat = z.infer<typeof engagementRateStat>;

/** A period value against the period before it. `deltaPct` is null when there is nothing to compare. */
export const comparedNumber = z.object({
  value: nullableNumber,
  prior: nullableNumber,
  deltaPct: nullableNumber,
});
export type ComparedNumber = z.infer<typeof comparedNumber>;

export const ANALYTICS_REPORT_MAX_DAYS = 366;
/** Most rows of `topPosts`; the rest are counted in `postsOmitted`. */
export const ANALYTICS_REPORT_MAX_POSTS = 1000;

/**
 * `days` (ending now) or an explicit `from`/`to`. `timezone` is the VIEWER's IANA zone: workspaces
 * carry none, so weeks, days and the best-time grid are bucketed where the person reading sits.
 * `scope=all` adds up every workspace the session's user belongs to (session auth only).
 */
export const analyticsReportQuery = z
  .object({
    days: z.coerce.number().int().min(1).max(ANALYTICS_REPORT_MAX_DAYS).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    provider: z.string().min(1).max(64).optional(),
    connectionId: z.string().uuid().optional(),
    source: z.enum(['app', 'imported']).optional(),
    timezone: z.string().min(1).max(64).default('UTC'),
    scope: z.enum(['workspace', 'all']).default('workspace'),
  })
  .refine((q) => (q.from === undefined) === (q.to === undefined), {
    message: '`from` and `to` go together',
  })
  .refine((q) => !q.from || !q.to || q.from < q.to, { message: '`from` must be before `to`' })
  .refine(
    (q) =>
      !q.from ||
      !q.to ||
      q.to.getTime() - q.from.getTime() <= ANALYTICS_REPORT_MAX_DAYS * 86_400_000,
    { message: `a range is at most ${ANALYTICS_REPORT_MAX_DAYS} days` },
  );
export type AnalyticsReportQuery = z.infer<typeof analyticsReportQuery>;

export const postFormat = z.enum(['video', 'image', 'text']);
export type PostFormat = z.infer<typeof postFormat>;

export const reportAccount = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  workspaceName: z.string(),
  provider: z.string(),
  displayName: z.string(),
  needsReconnect: z.boolean(),
  /** False for an account the platform / account filter leaves out: listed, but in no number. */
  selected: z.boolean(),
});
export type ReportAccount = z.infer<typeof reportAccount>;

export const reportPost = z.object({
  id: z.string().uuid(),
  provider: z.string(),
  connectionId: z.string().uuid(),
  caption: z.string(),
  publishAt: z.coerce.date(),
  releaseUrl: z.string().nullable(),
  source: z.enum(['app', 'imported']),
  format: postFormat,
  /** A picture for the row: the first image, or a video's still. Null when there is none. */
  thumbnailUrl: z.string().nullable(),
  metrics: conceptValues,
  /** likes + comments + shares + saves over the ones reported; null when none is. */
  engagements: nullableNumber,
  /** Percentage; null without both an engagement count and a denominator. */
  engagementRate: nullableNumber,
  /** What this post's rate was divided by. */
  basis: z.enum(['reach', 'views']).nullable(),
  /** Newest capture behind these numbers; null when nothing was collected. */
  capturedAt: z.coerce.date().nullable(),
});
export type ReportPost = z.infer<typeof reportPost>;

const platformSlice = z.object({
  provider: z.string(),
  posts: z.number().int(),
  totals: conceptValues,
  engagementRate: engagementRateStat,
});

export const analyticsReportView = z.object({
  generatedAt: z.coerce.date(),
  /** The zone the buckets below were cut in — the one asked for. */
  timezone: z.string(),
  /** Posts published in `(start, end]` against those published in `(priorStart, start]`. */
  period: z.object({
    priorStart: z.coerce.date(),
    start: z.coerce.date(),
    end: z.coerce.date(),
  }),
  /** Width of an `overTime` bucket: days for a period of two weeks or less, else Monday weeks. */
  bucket: z.enum(['day', 'week']),
  /**
   * Every account in scope, with or without posts in the period, so a screen can offer them as
   * filters. Only the `selected` ones are behind the numbers.
   */
  accounts: z.array(reportAccount),
  /**
   * The mapping as applied: per platform in view, the native metric name(s) behind each concept
   * (first one a post reports wins), an empty list where the platform has no equivalent.
   */
  mapping: z.array(
    z.object({
      provider: z.string(),
      concepts: perConcept(z.array(z.string())),
      followers: z.array(z.string()),
    }),
  ),
  summary: z.object({
    posts: comparedNumber,
    totals: perConcept(comparedNumber),
    engagementRate: engagementRateStat,
    engagementRatePrior: nullableNumber,
    engagementRateDeltaPct: nullableNumber,
    /**
     * Followers at the newest capture inside the period, summed over the accounts that have one.
     * `change` is against each account's newest capture of the period before, and is null unless
     * every counted account has one.
     */
    followers: z.object({
      value: nullableNumber,
      change: nullableNumber,
      deltaPct: nullableNumber,
      accounts: z.number().int(),
      accountsCounted: z.number().int(),
    }),
    /** The period's post with the most engagements (views when no post reports any). */
    bestPost: z
      .object({ post: reportPost, by: z.enum(['engagements', 'views']), value: z.number() })
      .nullable(),
    /** Published posts with no publish time: they fall in no period and are in none of the numbers. */
    undatedPosts: z.number().int(),
    /** Newest capture of anything this report read; null when nothing was collected. */
    lastCapturedAt: z.coerce.date().nullable(),
  }),
  byPlatform: z.array(platformSlice),
  /**
   * Posts grouped by when they were PUBLISHED, each carrying its current all-time totals — not
   * growth measured on those dates. Oldest first, empty buckets included.
   */
  overTime: z.array(
    z.object({
      /** First local day of the bucket, `YYYY-MM-DD`. */
      key: z.string(),
      start: z.coerce.date(),
      posts: z.number().int(),
      totals: conceptValues,
      engagementRate: nullableNumber,
      byPlatform: z.array(
        z.object({ provider: z.string(), posts: z.number().int(), totals: conceptValues }),
      ),
    }),
  ),
  /** Publish slots in `timezone`. Only slots with a post are listed. */
  bestTimes: z.object({
    /** What a slot is scored by: mean engagements per post, or mean views where none report any. */
    by: z.enum(['engagements', 'views']).nullable(),
    postsCounted: z.number().int(),
    cells: z.array(
      z.object({
        /** 0 = Monday … 6 = Sunday. */
        weekday: z.number().int().min(0).max(6),
        hour: z.number().int().min(0).max(23),
        posts: z.number().int(),
        /** Mean of `by` over the slot's posts that report it; null when none does. */
        average: nullableNumber,
      }),
    ),
    /** The three best-scoring slots, best first. */
    top: z.array(
      z.object({
        weekday: z.number().int(),
        hour: z.number().int(),
        posts: z.number().int(),
        average: z.number(),
      }),
    ),
  }),
  /** Followers per account, the last capture of each local day inside the period. */
  followerSeries: z.array(
    z.object({
      connectionId: z.string().uuid(),
      points: z.array(z.object({ day: z.string(), value: z.number() })),
    }),
  ),
  formats: z.array(
    z.object({
      format: postFormat,
      posts: z.number().int(),
      engagementRate: engagementRateStat,
      /** This format's rate against the period's overall rate, in percent; null without both. */
      vsAveragePct: nullableNumber,
      best: z.boolean(),
    }),
  ),
  /** The period's posts, most engagements first. */
  topPosts: z.array(reportPost),
  postsOmitted: z.number().int(),
  /**
   * Every native metric name the period's posts carry, untouched: nothing collected is hidden by
   * the concept mapping. `concept` is the one it feeds on that platform, null when it feeds none.
   */
  rawMetrics: z.array(
    z.object({
      provider: z.string(),
      metric: z.string(),
      concept: metricConcept.nullable(),
      posts: z.number().int(),
      total: z.number(),
    }),
  ),
  /** Per platform: full weeks of the period grouped by how many posts went out in them. */
  frequency: z.object({
    fullWeeks: z.number().int(),
    platforms: z.array(
      z.object({
        provider: z.string(),
        bands: z.array(
          z.object({
            /** Posts per week, inclusive; `max` null = and above. */
            min: z.number().int(),
            max: z.number().int().nullable(),
            weeks: z.number().int(),
            posts: z.number().int(),
            engagementRate: nullableNumber,
          }),
        ),
        /** Index into `bands` of the highest rate; null with fewer than two bands to compare. */
        best: z.number().int().nullable(),
      }),
    ),
  }),
  /**
   * How fast engagement arrives after publishing, from the stored snapshots of the posts that have
   * enough of them. A point is the mean share of each post's latest engagement count that the last
   * snapshot taken by that age already showed; no value is interpolated. Empty when too few posts
   * qualify (`postsUsed < rules.minPosts`).
   */
  accumulation: z.object({
    /** Posts published in the period with any engagement, and how many of them qualify. */
    postsConsidered: z.number().int(),
    postsUsed: z.number().int(),
    /** The rules a post must meet, as applied (so the screen states them, not a copy). */
    rules: z.object({
      minSnapshots: z.number().int(),
      firstWithinHours: z.number(),
      minAgeHours: z.number(),
      minPosts: z.number().int(),
    }),
    points: z.array(
      z.object({
        /** The age, in hours after publishing, this point is the state at. */
        untilHours: z.number(),
        /** Mean share, 0–100; null when no qualifying post has reached this age. */
        pct: nullableNumber,
        posts: z.number().int(),
      }),
    ),
    /** `untilHours` of the first point at or past 50% / 80%; null when never reached or no curve. */
    halfByHours: nullableNumber,
    eightyByHours: nullableNumber,
  }),
});
export type AnalyticsReportView = z.infer<typeof analyticsReportView>;
