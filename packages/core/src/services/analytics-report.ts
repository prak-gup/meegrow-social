import { and, asc, count, desc, eq, gt, inArray, isNull, lte } from 'drizzle-orm';
import { DateTime, IANAZone } from 'luxon';
import { db, schema, withWorkspace } from '@meegrow-social/db';
import {
  ANALYTICS_REPORT_MAX_POSTS,
  METRIC_CONCEPTS,
  type AnalyticsReportQuery,
  type AnalyticsReportView,
  type ComparedNumber,
  type ConceptValues,
  type MetricConcept,
  type PostFormat,
  type ReportAccount,
  type ReportPost,
} from '@meegrow-social/contracts';
import { providerVisible } from '../providers/registry.js';
import {
  allEngagementMetricNames,
  allFollowerMetricNames,
  conceptOf,
  conceptSources,
  deltaPct,
  engagementRate,
  engagementsOf,
  followerSources,
  postEngagementRate,
  sumConcepts,
  toConcepts,
} from './metric-concepts.js';
import { IMPORTED_SOURCE, mediaViewsByPost } from './posts.js';
import { systemClock, type Clock } from './queues.js';

/**
 * The Analytics screen's read model (`GET /v1/analytics/report`): one call returns every section,
 * computed here so that no app holds the arithmetic (BUILD-SPEC-V2 invariant 2).
 *
 * Two things it is strict about:
 *
 * - **Names.** Storage keeps each platform's metric names; they are read as display concepts
 *   through `metric-concepts.ts` and nowhere else. A concept a platform lacks is null. Every native
 *   name is also returned untouched in `rawMetrics`.
 * - **Time.** A stored value is a running total as of its capture. So "over time" groups posts by
 *   when they were PUBLISHED and adds up their current totals; it is never growth measured on
 *   those dates. Only `accumulation` uses the capture history, and only for posts that have
 *   enough of it. Nothing is interpolated.
 *
 * Everything below `--- loading ---` is pure and takes plain rows, so the arithmetic is unit-tested
 * without a database.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_DAYS = 30;
/** A period up to this long is charted per day; a longer one per Monday week. */
const DAILY_BUCKET_MAX_DAYS = 14;

/** A bad `timezone` (or other input only core can judge). The API answers 400. */
export class AnalyticsQueryError extends Error {}

export interface ReportPeriod {
  priorStart: Date;
  start: Date;
  end: Date;
}

/** The period asked for and the equally long one before it. `days` ends now; `from`/`to` is as given. */
export function resolvePeriod(
  query: Pick<AnalyticsReportQuery, 'days' | 'from' | 'to'>,
  now: Date,
): ReportPeriod {
  const end = query.from && query.to ? query.to : now;
  const start =
    query.from && query.to
      ? query.from
      : new Date(now.getTime() - (query.days ?? DEFAULT_DAYS) * DAY_MS);
  return { priorStart: new Date(2 * start.getTime() - end.getTime()), start, end };
}

const inCurrent = (at: Date, p: ReportPeriod): boolean => at > p.start && at <= p.end;
const inPrior = (at: Date, p: ReportPeriod): boolean => at > p.priorStart && at <= p.start;

// --- rows the report is built from ---------------------------------------------------------------

export interface RawPost {
  id: string;
  connectionId: string;
  provider: string;
  caption: string;
  publishAt: Date;
  releaseUrl: string | null;
  source: 'app' | 'imported';
  format: PostFormat;
  thumbnailUrl: string | null;
  /** Newest value per native metric name, exactly as stored. */
  native: Record<string, number>;
  /** Newest capture behind `native`; null when nothing was collected. */
  capturedAt: Date | null;
}

export interface RawFollowerPoint {
  connectionId: string;
  value: number;
  capturedAt: Date;
}

export interface RawSnapshot {
  postId: string;
  metric: string;
  value: number;
  capturedAt: Date;
}

export interface ReportInput {
  now: Date;
  period: ReportPeriod;
  timezone: string;
  accounts: ReportAccount[];
  /** Published posts of the period and of the one before it. */
  posts: RawPost[];
  followerPoints: RawFollowerPoint[];
  /** Capture history of the engagement metrics of `accumulationCandidates`. */
  snapshots: RawSnapshot[];
  undatedPosts: number;
}

// --- time buckets --------------------------------------------------------------------------------

export interface TimeBucket {
  /** First local day, `YYYY-MM-DD`. */
  key: string;
  start: Date;
  /** Exclusive. */
  end: Date;
}

const local = (at: Date, zone: string): DateTime => DateTime.fromJSDate(at, { zone });

/** The local day (`YYYY-MM-DD`) or Monday-week start an instant falls in, in `zone`. */
export function bucketKey(at: Date, zone: string, unit: 'day' | 'week'): string {
  return local(at, zone).startOf(unit).toFormat('yyyy-MM-dd');
}

export function bucketUnit(period: ReportPeriod): 'day' | 'week' {
  return period.end.getTime() - period.start.getTime() <= DAILY_BUCKET_MAX_DAYS * DAY_MS
    ? 'day'
    : 'week';
}

/**
 * Every bucket the period touches, oldest first, cut on local midnights of `zone` (weeks on
 * Monday). The first and last are usually partial — the period starts and ends mid-bucket.
 */
export function timeBuckets(
  period: ReportPeriod,
  zone: string,
  unit: 'day' | 'week',
): TimeBucket[] {
  const out: TimeBucket[] = [];
  // The period is `(start, end]`, so the first instant inside it is just after `start`.
  let cursor = local(new Date(period.start.getTime() + 1), zone).startOf(unit);
  while (cursor.toMillis() <= period.end.getTime()) {
    const next = cursor.plus(unit === 'day' ? { days: 1 } : { weeks: 1 });
    out.push({
      key: cursor.toFormat('yyyy-MM-dd'),
      start: cursor.toJSDate(),
      end: next.toJSDate(),
    });
    cursor = next;
  }
  return out;
}

/** Monday = 0 … Sunday = 6, and the hour 0–23, of an instant in `zone`. */
export function publishSlot(at: Date, zone: string): { weekday: number; hour: number } {
  const dt = local(at, zone);
  return { weekday: dt.weekday - 1, hour: dt.hour };
}

// --- sections ------------------------------------------------------------------------------------

interface Measured extends RawPost {
  values: ConceptValues;
  engagements: number | null;
}

const measure = (post: RawPost): Measured => {
  const values = toConcepts(post.provider, post.native);
  return { ...post, values, engagements: engagementsOf(values) };
};

const compared = (value: number | null, prior: number | null): ComparedNumber => ({
  value,
  prior,
  deltaPct: deltaPct(value, prior),
});

const mean = (values: readonly number[]): number =>
  values.reduce((a, b) => a + b, 0) / values.length;

/** Which number ranks posts and time slots: engagements, or views when no post reports any. */
function rankingBasis(posts: readonly Measured[]): 'engagements' | 'views' | null {
  if (posts.some((p) => p.engagements !== null)) return 'engagements';
  if (posts.some((p) => p.values.views !== null)) return 'views';
  return null;
}

const rankValue = (post: Measured, by: 'engagements' | 'views'): number | null =>
  by === 'engagements' ? post.engagements : post.values.views;

function toReportPost(post: Measured): ReportPost {
  const { rate, basis } = postEngagementRate(post.values);
  return {
    id: post.id,
    provider: post.provider,
    connectionId: post.connectionId,
    caption: post.caption,
    publishAt: post.publishAt,
    releaseUrl: post.releaseUrl,
    source: post.source,
    format: post.format,
    thumbnailUrl: post.thumbnailUrl,
    metrics: post.values,
    engagements: post.engagements,
    engagementRate: rate,
    basis,
    capturedAt: post.capturedAt,
  };
}

/** Most engagements first; a post without the number sorts after every post that has it. */
function byEngagement(a: Measured, b: Measured): number {
  return (
    (b.engagements ?? -1) - (a.engagements ?? -1) ||
    (b.values.views ?? -1) - (a.values.views ?? -1) ||
    b.publishAt.getTime() - a.publishAt.getTime()
  );
}

/**
 * Publish slots (weekday × hour in `zone`) scored by the mean of `by` over the slot's posts that
 * report it. The top three are the best-scoring slots above zero; more posts wins a tie.
 */
export function bestTimes(
  posts: ReadonlyArray<{ publishAt: Date; value: number | null }>,
  zone: string,
): Pick<AnalyticsReportView['bestTimes'], 'cells' | 'top' | 'postsCounted'> {
  const slots = new Map<
    string,
    { weekday: number; hour: number; posts: number; values: number[] }
  >();
  let postsCounted = 0;
  for (const post of posts) {
    const { weekday, hour } = publishSlot(post.publishAt, zone);
    const key = `${weekday}:${hour}`;
    const slot = slots.get(key) ?? { weekday, hour, posts: 0, values: [] };
    slot.posts += 1;
    if (post.value !== null) {
      slot.values.push(post.value);
      postsCounted += 1;
    }
    slots.set(key, slot);
  }
  const cells = [...slots.values()]
    .map(({ weekday, hour, posts: n, values }) => ({
      weekday,
      hour,
      posts: n,
      average: values.length > 0 ? mean(values) : null,
    }))
    .sort((a, b) => a.weekday - b.weekday || a.hour - b.hour);
  const top = cells
    .flatMap((c) => (c.average !== null && c.average > 0 ? [{ ...c, average: c.average }] : []))
    .sort((a, b) => b.average - a.average || b.posts - a.posts)
    .slice(0, 3);
  return { cells, top, postsCounted };
}

/**
 * Followers now and against the period before, plus the daily series. An account counts toward the
 * total only with a capture inside the period; the change is stated only when every counted
 * account also has one from the period before — otherwise part of the "growth" would just be an
 * account whose history starts later.
 */
export function followerSection(
  accounts: readonly Pick<ReportAccount, 'id'>[],
  points: readonly RawFollowerPoint[],
  period: ReportPeriod,
  zone: string,
): Pick<AnalyticsReportView, 'followerSeries'> & {
  summary: AnalyticsReportView['summary']['followers'];
} {
  const byAccount = new Map<string, RawFollowerPoint[]>();
  for (const point of [...points].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime())) {
    byAccount.set(point.connectionId, [...(byAccount.get(point.connectionId) ?? []), point]);
  }
  let value: number | null = null;
  let baseline = 0;
  let comparable = true;
  let accountsCounted = 0;
  const followerSeries: AnalyticsReportView['followerSeries'] = [];
  for (const account of accounts) {
    const own = byAccount.get(account.id) ?? [];
    const inside = own.filter((p) => inCurrent(p.capturedAt, period));
    const before = own.filter((p) => inPrior(p.capturedAt, period)).at(-1);
    const latest = inside.at(-1);
    if (!latest) continue;
    accountsCounted += 1;
    value = (value ?? 0) + latest.value;
    if (before) baseline += before.value;
    else comparable = false;
    // Oldest first, so a later capture on the same local day overwrites the earlier one.
    const days = new Map<string, number>();
    for (const p of inside) days.set(bucketKey(p.capturedAt, zone, 'day'), p.value);
    followerSeries.push({
      connectionId: account.id,
      points: [...days].map(([day, v]) => ({ day, value: v })),
    });
  }
  const known = value !== null && comparable;
  return {
    followerSeries,
    summary: {
      value,
      change: known ? value! - baseline : null,
      deltaPct: known ? deltaPct(value, baseline) : null,
      accounts: accounts.length,
      accountsCounted,
    },
  };
}

/** Posts-per-week bands of the frequency section; `max` null = and above. */
export const FREQUENCY_BANDS: ReadonlyArray<{ min: number; max: number | null }> = [
  { min: 1, max: 2 },
  { min: 3, max: 5 },
  { min: 6, max: 10 },
  { min: 11, max: null },
];

/**
 * Posting frequency against engagement rate: the period's FULL weeks (a partial week would
 * understate its cadence), grouped per platform by how many posts went out in the week, with the
 * engagement rate of the posts of those weeks. `best` needs two bands with a rate — one band is
 * not a comparison.
 */
export function frequencySection(
  posts: ReadonlyArray<Pick<RawPost, 'provider' | 'publishAt'> & { values: ConceptValues }>,
  period: ReportPeriod,
  zone: string,
): AnalyticsReportView['frequency'] {
  const weeks = timeBuckets(period, zone, 'week').filter(
    (w) => w.start >= period.start && w.end <= period.end,
  );
  const full = new Set(weeks.map((w) => w.key));
  const perPlatform = new Map<string, Map<string, ConceptValues[]>>();
  for (const post of posts) {
    const week = bucketKey(post.publishAt, zone, 'week');
    if (!full.has(week)) continue;
    const ofPlatform = perPlatform.get(post.provider) ?? new Map<string, ConceptValues[]>();
    ofPlatform.set(week, [...(ofPlatform.get(week) ?? []), post.values]);
    perPlatform.set(post.provider, ofPlatform);
  }
  const platforms = [...perPlatform]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, byWeek]) => {
      const bands = FREQUENCY_BANDS.map((band) => {
        const inBand = [...byWeek.values()].filter(
          (w) => w.length >= band.min && (band.max === null || w.length <= band.max),
        );
        const all = inBand.flat();
        return {
          ...band,
          weeks: inBand.length,
          posts: all.length,
          engagementRate: engagementRate(all).rate,
        };
      }).filter((band) => band.weeks > 0);
      const rated = bands.filter((b) => b.engagementRate !== null);
      const top =
        rated.length < 2
          ? null
          : rated.reduce((a, b) => (b.engagementRate! > a.engagementRate! ? b : a));
      return { provider, bands, best: top ? bands.indexOf(top) : null };
    });
  return { fullWeeks: weeks.length, platforms };
}

/** Ages after publishing, in hours, the accumulation curve is read at: 6h, 12h, 24h, 2d, 7d, 30d. */
export const ACCUMULATION_AGES_HOURS = [6, 12, 24, 48, 168, 720] as const;
/**
 * What a post needs before its history says anything about how engagement ARRIVED: several
 * snapshots, the first of them early (an imported post's history starts weeks after it went out,
 * so its early curve is unknown), and enough age that the fast part is over.
 */
export const ACCUMULATION_RULES = {
  minSnapshots: 3,
  firstWithinHours: 24,
  minAgeHours: 48,
  minPosts: 3,
} as const;
/** Snapshots are read for at most this many posts of the period, newest first. */
export const ACCUMULATION_MAX_POSTS = 200;

/** The posts whose capture history the accumulation section reads: the period's newest. */
export function accumulationCandidates<P extends Pick<RawPost, 'id' | 'publishAt'>>(
  posts: readonly P[],
  period: ReportPeriod,
): P[] {
  return posts
    .filter((p) => inCurrent(p.publishAt, period))
    .sort((a, b) => b.publishAt.getTime() - a.publishAt.getTime())
    .slice(0, ACCUMULATION_MAX_POSTS);
}

/**
 * A post's engagement count at each of its capture times, oldest first. Each metric carries its
 * last captured value forward, so a sweep that returned only some of the names does not read as a
 * drop. Ages are hours after publishing.
 */
export function engagementHistory(
  provider: string,
  publishAt: Date,
  snapshots: readonly Pick<RawSnapshot, 'metric' | 'value' | 'capturedAt'>[],
): Array<{ ageHours: number; engagements: number }> {
  const ordered = [...snapshots].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
  const asOf: Record<string, number> = {};
  const out: Array<{ ageHours: number; engagements: number }> = [];
  ordered.forEach((row, i) => {
    asOf[row.metric] = row.value;
    // Emit once per capture time, after its last row.
    if (ordered[i + 1]?.capturedAt.getTime() === row.capturedAt.getTime()) return;
    const engagements = engagementsOf(toConcepts(provider, asOf));
    if (engagements === null) return;
    out.push({
      ageHours: (row.capturedAt.getTime() - publishAt.getTime()) / HOUR_MS,
      engagements,
    });
  });
  return out;
}

/**
 * How fast engagement arrives: for each age, the mean over qualifying posts of
 * (engagements at the last snapshot taken by that age) ÷ (engagements at the latest snapshot).
 * A post contributes to an age only once it is that old and only if it has a snapshot by then —
 * otherwise that point is simply not known for it. A share is capped at 100%: engagement can fall
 * (an unlike), and the curve states how much of the final count had arrived.
 */
export function accumulationSection(
  posts: ReadonlyArray<Pick<RawPost, 'id' | 'provider' | 'publishAt'>>,
  snapshots: readonly RawSnapshot[],
): AnalyticsReportView['accumulation'] {
  const byPost = new Map<string, RawSnapshot[]>();
  for (const row of snapshots) byPost.set(row.postId, [...(byPost.get(row.postId) ?? []), row]);

  const rules = ACCUMULATION_RULES;
  let postsConsidered = 0;
  const qualifying: Array<Array<{ ageHours: number; engagements: number }>> = [];
  for (const post of posts) {
    const history = engagementHistory(post.provider, post.publishAt, byPost.get(post.id) ?? []);
    const first = history[0];
    const last = history.at(-1);
    if (!first || !last || last.engagements <= 0) continue;
    postsConsidered += 1;
    if (
      history.length >= rules.minSnapshots &&
      first.ageHours <= rules.firstWithinHours &&
      last.ageHours >= rules.minAgeHours
    ) {
      qualifying.push(history);
    }
  }

  const base = { postsConsidered, postsUsed: qualifying.length, rules: { ...rules } };
  if (qualifying.length < rules.minPosts) {
    return { ...base, points: [], halfByHours: null, eightyByHours: null };
  }
  const points = ACCUMULATION_AGES_HOURS.map((untilHours) => {
    const shares: number[] = [];
    for (const history of qualifying) {
      const last = history.at(-1)!;
      if (last.ageHours < untilHours) continue;
      const by = history.filter((h) => h.ageHours <= untilHours).at(-1);
      if (by) shares.push(Math.min(1, by.engagements / last.engagements));
    }
    return {
      untilHours,
      pct: shares.length > 0 ? mean(shares) * 100 : null,
      posts: shares.length,
    };
  });
  const reached = (pct: number): number | null =>
    points.find((p) => p.pct !== null && p.pct >= pct)?.untilHours ?? null;
  return { ...base, points, halfByHours: reached(50), eightyByHours: reached(80) };
}

/** Engagement rate per content format, each against the period's overall rate. */
export function formatSection(
  posts: ReadonlyArray<{ format: PostFormat; values: ConceptValues }>,
): AnalyticsReportView['formats'] {
  const overall = engagementRate(posts.map((p) => p.values)).rate;
  const rows = (['video', 'image', 'text'] as const).flatMap((format) => {
    const own = posts.filter((p) => p.format === format).map((p) => p.values);
    if (own.length === 0) return [];
    const stat = engagementRate(own);
    return [
      {
        format,
        posts: own.length,
        engagementRate: stat,
        vsAveragePct: deltaPct(stat.rate, overall),
      },
    ];
  });
  // "Best" is a comparison: it needs two formats with a rate.
  const rated = rows.filter((r) => r.engagementRate.rate !== null);
  const top =
    rated.length < 2
      ? null
      : rated.reduce((a, b) => (b.engagementRate.rate! > a.engagementRate.rate! ? b : a));
  return rows.map((r) => ({ ...r, best: r === top }));
}

/** Every native metric name the posts carry, summed per platform, with the concept it feeds. */
export function rawMetricRows(
  posts: ReadonlyArray<Pick<RawPost, 'provider' | 'native'>>,
): AnalyticsReportView['rawMetrics'] {
  const rows = new Map<string, AnalyticsReportView['rawMetrics'][number]>();
  for (const post of posts) {
    for (const [metric, value] of Object.entries(post.native)) {
      const key = `${post.provider}\n${metric}`;
      const row = rows.get(key) ?? {
        provider: post.provider,
        metric,
        concept: conceptOf(post.provider, metric),
        posts: 0,
        total: 0,
      };
      row.posts += 1;
      row.total += value;
      rows.set(key, row);
    }
  }
  return [...rows.values()].sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.metric.localeCompare(b.metric),
  );
}

/** The whole report from plain rows. Pure: same rows, same answer. */
export function buildAnalyticsReport(input: ReportInput): AnalyticsReportView {
  const { period, timezone: zone } = input;
  const measured = input.posts.map(measure);
  const current = measured.filter((p) => inCurrent(p.publishAt, period));
  const prior = measured.filter((p) => inPrior(p.publishAt, period));
  const currentValues = current.map((p) => p.values);
  const priorValues = prior.map((p) => p.values);

  // --- summary ---
  const totalsNow = sumConcepts(currentValues);
  const totalsPrior = sumConcepts(priorValues);
  const totals = Object.fromEntries(
    METRIC_CONCEPTS.map((c) => [c, compared(totalsNow[c], totalsPrior[c])]),
  ) as Record<MetricConcept, ComparedNumber>;
  const rate = engagementRate(currentValues);
  const ratePrior = engagementRate(priorValues).rate;
  const accounts = input.accounts.filter((a) => a.selected);
  const followers = followerSection(accounts, input.followerPoints, period, zone);

  const by = rankingBasis(current);
  const ranked = by
    ? current
        .flatMap((p) => {
          const value = rankValue(p, by);
          return value !== null && value > 0 ? [{ post: p, value }] : [];
        })
        .sort(
          (a, b) => b.value - a.value || b.post.publishAt.getTime() - a.post.publishAt.getTime(),
        )
    : [];
  const best = ranked[0];

  let lastCapturedAt: Date | null = null;
  const seen = (at: Date | null) => {
    if (at && (!lastCapturedAt || at > lastCapturedAt)) lastCapturedAt = at;
  };
  for (const p of measured) seen(p.capturedAt);
  for (const p of input.followerPoints) seen(p.capturedAt);

  // --- per platform ---
  const providers = [
    ...new Set([...accounts.map((a) => a.provider), ...current.map((p) => p.provider)]),
  ];
  const byPlatform = providers
    .map((provider) => {
      const own = current.filter((p) => p.provider === provider).map((p) => p.values);
      return {
        provider,
        posts: own.length,
        totals: sumConcepts(own),
        engagementRate: engagementRate(own),
      };
    })
    .sort((a, b) => b.posts - a.posts || a.provider.localeCompare(b.provider));

  // --- over time, by publish date ---
  const unit = bucketUnit(period);
  const inBucket = new Map<string, Measured[]>();
  for (const post of current) {
    const key = bucketKey(post.publishAt, zone, unit);
    inBucket.set(key, [...(inBucket.get(key) ?? []), post]);
  }
  const overTime = timeBuckets(period, zone, unit).map((bucket) => {
    const own = inBucket.get(bucket.key) ?? [];
    const values = own.map((p) => p.values);
    return {
      key: bucket.key,
      start: bucket.start,
      posts: own.length,
      totals: sumConcepts(values),
      engagementRate: engagementRate(values).rate,
      byPlatform: [...new Set(own.map((p) => p.provider))].sort().map((provider) => {
        const ofPlatform = own.filter((p) => p.provider === provider).map((p) => p.values);
        return { provider, posts: ofPlatform.length, totals: sumConcepts(ofPlatform) };
      }),
    };
  });

  const top = [...current].sort(byEngagement);

  return {
    generatedAt: input.now,
    timezone: zone,
    period,
    bucket: unit,
    accounts: input.accounts,
    mapping: providers.sort().map((provider) => ({
      provider,
      concepts: Object.fromEntries(
        METRIC_CONCEPTS.map((c) => [c, [...conceptSources(provider)[c]]]),
      ) as Record<MetricConcept, string[]>,
      followers: [...followerSources(provider)],
    })),
    summary: {
      posts: compared(current.length, prior.length),
      totals,
      engagementRate: rate,
      engagementRatePrior: ratePrior,
      engagementRateDeltaPct: deltaPct(rate.rate, ratePrior),
      followers: followers.summary,
      bestPost: best && by ? { post: toReportPost(best.post), by, value: best.value } : null,
      undatedPosts: input.undatedPosts,
      lastCapturedAt,
    },
    byPlatform,
    overTime,
    bestTimes: {
      by,
      ...bestTimes(
        by ? current.map((p) => ({ publishAt: p.publishAt, value: rankValue(p, by) })) : [],
        zone,
      ),
    },
    followerSeries: followers.followerSeries,
    formats: formatSection(current),
    topPosts: top.slice(0, ANALYTICS_REPORT_MAX_POSTS).map(toReportPost),
    postsOmitted: Math.max(0, top.length - ANALYTICS_REPORT_MAX_POSTS),
    rawMetrics: rawMetricRows(current),
    frequency: frequencySection(current, period, zone),
    accumulation: accumulationSection(accumulationCandidates(current, period), input.snapshots),
  };
}

// --- loading -------------------------------------------------------------------------------------

type Filters = Pick<AnalyticsReportQuery, 'provider' | 'connectionId' | 'source'>;

interface WorkspaceRows {
  accounts: ReportAccount[];
  posts: RawPost[];
  followerPoints: RawFollowerPoint[];
  snapshots: RawSnapshot[];
  undatedPosts: number;
}

/**
 * Everything one workspace contributes, under its own RLS context. Six queries whatever it holds:
 * accounts, posts of both periods, their media, the newest value per metric per post (one
 * DISTINCT ON over `metrics_post_metric_captured_idx`), follower captures, and the capture history
 * of the newest posts. Test-only providers are left out where production hides them, as everywhere
 * else.
 */
async function loadWorkspace(
  workspace: { id: string; name: string },
  filters: Filters,
  period: ReportPeriod,
): Promise<WorkspaceRows> {
  return withWorkspace(workspace.id, async (tx) => {
    const connections = await tx
      .select({
        id: schema.connections.id,
        provider: schema.connections.provider,
        displayName: schema.connections.displayName,
        needsReconnect: schema.connections.needsReconnect,
      })
      .from(schema.connections)
      .orderBy(asc(schema.connections.createdAt));
    const accounts: ReportAccount[] = connections
      .filter((c) => providerVisible(c.provider))
      .map((c) => ({
        ...c,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        selected:
          (!filters.provider || c.provider === filters.provider) &&
          (!filters.connectionId || c.id === filters.connectionId),
      }));
    const selected = accounts.filter((a) => a.selected);

    const published = and(
      eq(schema.posts.status, 'published'),
      filters.provider ? eq(schema.posts.provider, filters.provider) : undefined,
      filters.connectionId ? eq(schema.posts.connectionId, filters.connectionId) : undefined,
      filters.source ? eq(schema.posts.source, filters.source) : undefined,
    );
    const inRange = and(
      published,
      gt(schema.posts.publishAt, period.priorStart),
      lte(schema.posts.publishAt, period.end),
    );
    const rows = (
      await tx
        .select({
          id: schema.posts.id,
          connectionId: schema.posts.connectionId,
          provider: schema.posts.provider,
          caption: schema.posts.caption,
          media: schema.posts.media,
          options: schema.posts.options,
          publishAt: schema.posts.publishAt,
          releaseUrl: schema.posts.releaseUrl,
          source: schema.posts.source,
        })
        .from(schema.posts)
        .where(inRange)
    ).filter((r) => providerVisible(r.provider));

    const [undated] = await tx
      .select({ n: count() })
      .from(schema.posts)
      .where(and(published, isNull(schema.posts.publishAt)));

    const media = await mediaViewsByPost(tx, rows);

    // Newest capture per (post, metric); of two at the same instant, the one written last. The
    // posts are named by the same predicate as above rather than by a list of thousands of ids.
    const latest =
      rows.length === 0
        ? []
        : await tx
            .selectDistinctOn([schema.metrics.postId, schema.metrics.metric], {
              postId: schema.metrics.postId,
              metric: schema.metrics.metric,
              value: schema.metrics.value,
              capturedAt: schema.metrics.capturedAt,
            })
            .from(schema.metrics)
            .where(
              inArray(
                schema.metrics.postId,
                tx.select({ id: schema.posts.id }).from(schema.posts).where(inRange),
              ),
            )
            .orderBy(
              schema.metrics.postId,
              schema.metrics.metric,
              desc(schema.metrics.capturedAt),
              desc(schema.metrics.createdAt),
            );
    const native = new Map<string, { values: Record<string, number>; capturedAt: Date | null }>();
    for (const r of latest) {
      if (!r.postId) continue;
      const entry = native.get(r.postId) ?? { values: {}, capturedAt: null };
      entry.values[r.metric] = Number(r.value);
      if (!entry.capturedAt || r.capturedAt > entry.capturedAt) entry.capturedAt = r.capturedAt;
      native.set(r.postId, entry);
    }

    const posts: RawPost[] = rows.flatMap((r) => {
      if (!r.publishAt) return [];
      const first = media.get(r.id)?.[0];
      return [
        {
          id: r.id,
          connectionId: r.connectionId,
          provider: r.provider,
          caption: r.caption,
          publishAt: r.publishAt,
          releaseUrl: r.releaseUrl,
          source: r.source === IMPORTED_SOURCE ? 'imported' : 'app',
          format: first ? first.kind : 'text',
          thumbnailUrl: first ? (first.kind === 'image' ? first.url : first.thumbnailUrl) : null,
          native: native.get(r.id)?.values ?? {},
          capturedAt: native.get(r.id)?.capturedAt ?? null,
        },
      ];
    });

    // Follower captures of both periods. A name counts only on a platform that uses it.
    const followerNames = allFollowerMetricNames();
    const followerRows =
      selected.length === 0
        ? []
        : await tx
            .select({
              connectionId: schema.metrics.connectionId,
              metric: schema.metrics.metric,
              value: schema.metrics.value,
              capturedAt: schema.metrics.capturedAt,
            })
            .from(schema.metrics)
            .where(
              and(
                isNull(schema.metrics.postId),
                inArray(
                  schema.metrics.connectionId,
                  selected.map((a) => a.id),
                ),
                inArray(schema.metrics.metric, followerNames),
                gt(schema.metrics.capturedAt, period.priorStart),
                lte(schema.metrics.capturedAt, period.end),
              ),
            )
            .orderBy(asc(schema.metrics.capturedAt), asc(schema.metrics.createdAt));
    const providerOf = new Map(selected.map((a) => [a.id, a.provider]));
    const followerPoints: RawFollowerPoint[] = followerRows.flatMap((r) =>
      r.connectionId && followerSources(providerOf.get(r.connectionId) ?? '').includes(r.metric)
        ? [{ connectionId: r.connectionId, value: Number(r.value), capturedAt: r.capturedAt }]
        : [],
    );

    const candidates = accumulationCandidates(posts, period).map((p) => p.id);
    const history =
      candidates.length === 0
        ? []
        : await tx
            .select({
              postId: schema.metrics.postId,
              metric: schema.metrics.metric,
              value: schema.metrics.value,
              capturedAt: schema.metrics.capturedAt,
            })
            .from(schema.metrics)
            .where(
              and(
                inArray(schema.metrics.postId, candidates),
                inArray(schema.metrics.metric, allEngagementMetricNames()),
              ),
            )
            .orderBy(asc(schema.metrics.capturedAt), asc(schema.metrics.createdAt));
    const snapshots: RawSnapshot[] = history.flatMap((r) =>
      r.postId
        ? [{ postId: r.postId, metric: r.metric, value: Number(r.value), capturedAt: r.capturedAt }]
        : [],
    );

    return { accounts, posts, followerPoints, snapshots, undatedPosts: undated?.n ?? 0 };
  });
}

async function reportFor(
  workspaces: ReadonlyArray<{ id: string; name: string }>,
  query: AnalyticsReportQuery,
  clock: Clock,
): Promise<AnalyticsReportView> {
  if (!IANAZone.isValidZone(query.timezone)) {
    throw new AnalyticsQueryError(`invalid IANA timezone: ${query.timezone}`);
  }
  const now = clock.now();
  const period = resolvePeriod(query, now);
  const input: ReportInput = {
    now,
    period,
    timezone: query.timezone,
    accounts: [],
    posts: [],
    followerPoints: [],
    snapshots: [],
    undatedPosts: 0,
  };
  // One workspace at a time, each under its own RLS context: the rows are only ever joined here,
  // in memory, after the database has already scoped them.
  for (const workspace of workspaces) {
    const rows = await loadWorkspace(workspace, query, period);
    input.accounts.push(...rows.accounts);
    input.posts.push(...rows.posts);
    input.followerPoints.push(...rows.followerPoints);
    input.snapshots.push(...rows.snapshots);
    input.undatedPosts += rows.undatedPosts;
  }
  return buildAnalyticsReport(input);
}

/** The report for one workspace (API key or session). */
export async function getAnalyticsReport(
  workspaceId: string,
  query: AnalyticsReportQuery,
  clock: Clock = systemClock,
): Promise<AnalyticsReportView> {
  // `workspaces` is a non-tenant table: the id predicate is the scoping, as in `getWorkspace`.
  const [workspace] = await db()
    .select({ id: schema.workspaces.id, name: schema.workspaces.name })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  return reportFor(workspace ? [workspace] : [], query, clock);
}

/**
 * The report across every workspace the user belongs to (`scope=all`). Like `overviewForUser`, it
 * fans out over the user's memberships and reads each workspace under `withWorkspace`; a workspace
 * the user is not a member of is never opened.
 */
export async function getAnalyticsReportForUser(
  userId: string,
  query: AnalyticsReportQuery,
  clock: Clock = systemClock,
): Promise<AnalyticsReportView> {
  const workspaces = await db()
    .select({ id: schema.workspaces.id, name: schema.workspaces.name })
    .from(schema.memberships)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.memberships.workspaceId))
    .where(eq(schema.memberships.userId, userId))
    .orderBy(asc(schema.workspaces.name));
  return reportFor(workspaces, query, clock);
}
