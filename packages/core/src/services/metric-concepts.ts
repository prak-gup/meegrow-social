import {
  ENGAGEMENT_CONCEPTS,
  METRIC_CONCEPTS,
  type ConceptValues,
  type EngagementBasis,
  type EngagementRateStat,
  type MetricConcept,
} from '@meegrow-social/contracts';

/**
 * Display concepts → each platform's own metric names. READ-TIME ONLY.
 *
 * The `metrics` table stores whatever name a platform returned and nothing here changes that
 * (BUILD-SPEC-V2 invariant 7): this file is consulted when a report is built, so that "Likes" can
 * be one column across platforms. It is the only place a native name is tied to a concept. When a
 * platform renames a metric, the stored rows keep the old name, the new rows carry the new one, and
 * the fix is to list both here — no migration, no rewrite.
 *
 * Every name below was read from the provider that emits it (the constant is cited per platform),
 * not from memory. A concept a platform does not report has an empty list: its value is null
 * ("—"), never 0 and never borrowed from a neighbouring metric. Several names for one concept are
 * tried in order and the first one a post reports wins.
 *
 * A native name that feeds no concept is NOT dropped: `unmappedMetrics` returns it and the report
 * lists every native name in `rawMetrics`.
 */
type ConceptSources = Readonly<Record<MetricConcept, readonly string[]>>;

const NONE: ConceptSources = {
  views: [],
  reach: [],
  likes: [],
  comments: [],
  shares: [],
  saves: [],
  clicks: [],
  follows: [],
};

const POST_SOURCES: Readonly<Record<string, ConceptSources>> = {
  /**
   * `POST_METRICS` in providers/meta/facebook.ts. Meta documents `post_media_view` as the
   * replacement for `post_impressions` and `post_total_media_view_unique` for its unique variant.
   * `post_video_views` is left unmapped on purpose: it counts video plays only, a part of
   * `post_media_view`, so adding it to "views" would count them twice. The provider requests no
   * comment, share or save count, so those are gaps.
   */
  facebook: {
    ...NONE,
    views: ['post_media_view'],
    reach: ['post_total_media_view_unique'],
    likes: ['post_reactions_like_total'],
    clicks: ['post_clicks'],
  },
  /**
   * `MEDIA_METRICS` in providers/meta/instagram.ts. `total_interactions` is Meta's own sum of
   * interactions and stays unmapped: the engagement count is built from its parts so that it means
   * the same thing on every platform. `shares` is not requested by the provider — a gap.
   */
  instagram: {
    ...NONE,
    views: ['views'],
    reach: ['reach'],
    likes: ['likes'],
    comments: ['comments'],
    saves: ['saved'],
  },
  /**
   * providers/google/youtube.ts: the Data API counters (`viewCount`, `likeCount`, `commentCount`)
   * are current; the Analytics API totals (`VIDEO_REPORT_METRICS`) lag about two days, so a counter
   * is preferred where both exist. YouTube reports no reach and no saves.
   */
  youtube: {
    ...NONE,
    views: ['viewCount', 'views'],
    likes: ['likeCount', 'likes'],
    comments: ['commentCount', 'comments'],
    shares: ['shares'],
    follows: ['subscribersGained'],
  },
  /**
   * `POST_METRICS` in providers/google/gbp.ts. Both cover a trailing 30-day window rather than the
   * post's lifetime — the names are still the closest equivalents GBP has.
   */
  bluesky: {
    ...NONE,
    likes: ['likeCount'],
    comments: ['replyCount'],
    shares: ['repostCount'],
    saves: ['bookmarkCount'],
  },
  gmb: {
    ...NONE,
    views: ['LOCAL_POST_VIEWS_SEARCH'],
    clicks: ['LOCAL_POST_ACTIONS_CALL_TO_ACTION'],
  },
};

/** Account-level follower count. GBP has none; the three below all emit the literal `followers`. */
const FOLLOWER_SOURCES: Readonly<Record<string, readonly string[]>> = {
  facebook: ['followers'],
  instagram: ['followers'],
  youtube: ['followers'],
  bluesky: ['followers'],
};

/** The native names behind each concept on this platform; all empty for one that is not mapped. */
export function conceptSources(provider: string): ConceptSources {
  return POST_SOURCES[provider] ?? NONE;
}

/** The native names of this platform's follower count; empty when it has none. */
export function followerSources(provider: string): readonly string[] {
  return FOLLOWER_SOURCES[provider] ?? [];
}

/** Every native follower name any platform uses — what a follower read asks the table for. */
export function allFollowerMetricNames(): string[] {
  return [...new Set(Object.values(FOLLOWER_SOURCES).flat())];
}

/** Every native name that feeds an engagement concept on any platform (for snapshot reads). */
export function allEngagementMetricNames(): string[] {
  const names = new Set<string>();
  for (const sources of Object.values(POST_SOURCES)) {
    for (const concept of ENGAGEMENT_CONCEPTS) for (const name of sources[concept]) names.add(name);
  }
  return [...names];
}

/** The concept this native name feeds on this platform, or null when it feeds none. */
export function conceptOf(provider: string, metric: string): MetricConcept | null {
  const sources = conceptSources(provider);
  return METRIC_CONCEPTS.find((concept) => sources[concept].includes(metric)) ?? null;
}

export const EMPTY_CONCEPTS: ConceptValues = {
  views: null,
  reach: null,
  likes: null,
  comments: null,
  shares: null,
  saves: null,
  clicks: null,
  follows: null,
};

/** A post's native metrics read as concepts. A concept nothing reports is null, never 0. */
export function toConcepts(
  provider: string,
  native: Readonly<Record<string, number>>,
): ConceptValues {
  const sources = conceptSources(provider);
  const out: ConceptValues = { ...EMPTY_CONCEPTS };
  for (const concept of METRIC_CONCEPTS) {
    const name = sources[concept].find((n) => native[n] !== undefined);
    if (name !== undefined) out[concept] = native[name]!;
  }
  return out;
}

/** The native metrics of a post that feed no concept on its platform — kept, never discarded. */
export function unmappedMetrics(
  provider: string,
  native: Readonly<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(native)) {
    if (conceptOf(provider, name) === null) out[name] = value;
  }
  return out;
}

// --- Engagement -------------------------------------------------------------------------------

/**
 * Engagements of one post: likes + comments + shares + saves, over the ones its platform reports.
 * Null when it reports none of them — "no data", which is not the same as a post nobody engaged
 * with (0).
 */
export function engagementsOf(values: ConceptValues): number | null {
  let sum: number | null = null;
  for (const concept of ENGAGEMENT_CONCEPTS) {
    const value = values[concept];
    if (value !== null) sum = (sum ?? 0) + value;
  }
  return sum;
}

/**
 * What a post's engagement rate is divided by: its reach, or — where the platform reports no reach
 * (or reports 0) — its views. Null when it has neither above zero: there is no rate to state.
 *
 * Reach first because a rate is "of the people who saw it, how many acted"; views count repeat
 * plays by the same person and so read lower. Views is the fallback rather than a gap because two
 * of the four platforms (YouTube, GBP) have no reach at all.
 */
export function engagementDenominator(
  values: ConceptValues,
): { basis: 'reach' | 'views'; value: number } | null {
  if (values.reach !== null && values.reach > 0) return { basis: 'reach', value: values.reach };
  if (values.views !== null && values.views > 0) return { basis: 'views', value: values.views };
  return null;
}

/** One post's engagement rate in percent, with what it was divided by; nulls when it has none. */
export function postEngagementRate(values: ConceptValues): {
  rate: number | null;
  basis: 'reach' | 'views' | null;
} {
  const engagements = engagementsOf(values);
  const denominator = engagementDenominator(values);
  if (engagements === null || !denominator) return { rate: null, basis: null };
  return { rate: (engagements / denominator.value) * 100, basis: denominator.basis };
}

/**
 * Engagement rate of a set of posts: Σ engagements ÷ Σ denominators × 100 over the posts that have
 * both, so a post seen by ten people does not weigh as much as one seen by ten thousand. Posts
 * missing either half are left out of BOTH sums and counted (`posts` vs `postsCounted`). `basis`
 * is `mixed` when some counted posts were divided by reach and others by views — the number is
 * still stated, and the caller must say that it mixes the two.
 */
export function engagementRate(posts: readonly ConceptValues[]): EngagementRateStat {
  let engagements: number | null = null;
  let numerator = 0;
  let denominator = 0;
  let byReach = 0;
  let byViews = 0;
  const components = new Set<MetricConcept>();
  for (const values of posts) {
    const own = engagementsOf(values);
    if (own === null) continue;
    engagements = (engagements ?? 0) + own;
    const base = engagementDenominator(values);
    if (!base) continue;
    numerator += own;
    denominator += base.value;
    if (base.basis === 'reach') byReach += 1;
    else byViews += 1;
    for (const concept of ENGAGEMENT_CONCEPTS)
      if (values[concept] !== null) components.add(concept);
  }
  const postsCounted = byReach + byViews;
  const basis: EngagementBasis | null =
    postsCounted === 0 ? null : byReach === 0 ? 'views' : byViews === 0 ? 'reach' : 'mixed';
  return {
    rate: postsCounted === 0 ? null : (numerator / denominator) * 100,
    engagements,
    basis,
    posts: posts.length,
    postsCounted,
    byReach,
    byViews,
    components: ENGAGEMENT_CONCEPTS.filter((c) => components.has(c)),
  };
}

/** Each concept summed over the posts that report it; null where none does. */
export function sumConcepts(posts: readonly ConceptValues[]): ConceptValues {
  const out: ConceptValues = { ...EMPTY_CONCEPTS };
  for (const values of posts) {
    for (const concept of METRIC_CONCEPTS) {
      const value = values[concept];
      if (value !== null) out[concept] = (out[concept] ?? 0) + value;
    }
  }
  return out;
}

/**
 * Percentage change against the prior period. Null — shown as "—" — when either side is missing
 * or the prior value is zero: growth from nothing is not a percentage.
 */
export function deltaPct(current: number | null, prior: number | null): number | null {
  if (current === null || prior === null || prior === 0) return null;
  const change = ((current - prior) / Math.abs(prior)) * 100;
  return Number.isFinite(change) ? change : null;
}
