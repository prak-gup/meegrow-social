import type {
  AnalyticsReportView,
  EngagementRateStat,
  MetricConcept,
  ReportAccount,
  ReportPost,
} from '@meegrow-social/contracts';

/**
 * Pure logic for the Analytics screen: URL filters, the report query, labels, sorting
 * and the CSV export. No arithmetic about the numbers themselves lives here — totals, rates,
 * deltas and buckets all arrive computed from `GET /v1/analytics/report` (core), and a value that
 * does not exist is `null` (drawn "—"), never 0.
 */

export type Report = AnalyticsReportView;

export const DASH = '—';

// --- Concepts ---

/**
 * `METRIC_CONCEPTS` of contracts, repeated because the contracts root is not imported at runtime
 * (it would bundle the zod schemas). analyticsReport.test.ts holds the two equal.
 */
export const CONCEPTS: readonly MetricConcept[] = [
  'views',
  'reach',
  'likes',
  'comments',
  'shares',
  'saves',
  'clicks',
  'follows',
];

export const CONCEPT_LABEL: Record<MetricConcept, string> = {
  views: 'Views',
  reach: 'Reach',
  likes: 'Likes',
  comments: 'Comments',
  shares: 'Shares',
  saves: 'Saves',
  clicks: 'Clicks',
  follows: 'Follows',
};

/** The one definition of engagement rate, as the screen states it. */
export const ENGAGEMENT_RATE_FORMULA =
  'Engagement rate = (likes + comments + shares + saves) ÷ reach. A post with no reach is divided by its views instead.';

/** Concepts at least one platform in view can report, and the ones none of them can. */
export function conceptsInView(mapping: Report['mapping']): {
  shown: MetricConcept[];
  absent: MetricConcept[];
} {
  const shown = CONCEPTS.filter((c) => mapping.some((m) => m.concepts[c].length > 0));
  return { shown, absent: CONCEPTS.filter((c) => !shown.includes(c)) };
}

// --- Filters (kept in the URL) ---

export const RANGE_DAYS = [7, 30, 90] as const;
export type RangeKey = '7' | '30' | '90' | 'custom';
export const DEFAULT_RANGE: RangeKey = '30';

export interface ReportFilters {
  /** Provider identifier, or '' for all platforms. */
  platform: string;
  /** Connection id, or '' for all accounts. */
  connection: string;
  /** '' = every post; `app` = published here; `imported` = found on the platform. */
  source: '' | 'app' | 'imported';
  range: RangeKey;
  /** Local calendar days, `YYYY-MM-DD`, both inclusive. Used only when `range` is `custom`. */
  from: string;
  to: string;
  /** `all`: every client the user can see. */
  scope: 'workspace' | 'all';
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isRange = (v: string | null): v is RangeKey =>
  v === '7' || v === '30' || v === '90' || v === 'custom';

/** Read the filters from the query string; anything missing or unrecognised falls back to the default. */
export function parseReportFilters(params: URLSearchParams): ReportFilters {
  const source = params.get('source');
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const range = params.get('range') ?? params.get('days');
  const custom = range === 'custom' && DAY.test(from) && DAY.test(to) && from <= to;
  return {
    platform: params.get('platform') ?? '',
    connection: params.get('connection') ?? '',
    source: source === 'app' || source === 'imported' ? source : '',
    range: custom ? 'custom' : isRange(range) && range !== 'custom' ? range : DEFAULT_RANGE,
    from: custom ? from : '',
    to: custom ? to : '',
    scope: params.get('scope') === 'all' ? 'all' : 'workspace',
  };
}

/** The query string for a filter set; defaults are left out so the plain URL stays plain. */
export function reportFiltersToParams(f: ReportFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (f.scope === 'all') params.set('scope', 'all');
  if (f.platform) params.set('platform', f.platform);
  if (f.connection) params.set('connection', f.connection);
  if (f.source) params.set('source', f.source);
  if (f.range !== DEFAULT_RANGE) params.set('range', f.range);
  if (f.range === 'custom') {
    params.set('from', f.from);
    params.set('to', f.to);
  }
  return params;
}

type AccountRef = Pick<ReportAccount, 'id' | 'provider'>;

/**
 * Drop filter values that do not exist among the accounts in scope (a stale link, or the previous
 * client's ids after a switch), and an account that does not belong to the chosen platform.
 */
export function resolveReportFilters(
  f: ReportFilters,
  accounts: readonly AccountRef[],
): ReportFilters {
  const platform = accounts.some((a) => a.provider === f.platform) ? f.platform : '';
  const match = accounts.find((a) => a.id === f.connection);
  const connection = match && (platform === '' || match.provider === platform) ? match.id : '';
  return { ...f, platform, connection };
}

/** Distinct providers among the accounts, in first-seen order. Derived, never enumerated. */
export function platformsOf(accounts: readonly AccountRef[]): string[] {
  return [...new Set(accounts.map((a) => a.provider))];
}

const localDay = (day: string, addDays = 0): Date => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d + addDays);
};

/** `YYYY-MM-DD` of a date in the browser's zone — the value of an `<input type="date">`. */
export function dayInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export type ReportQuery = Record<string, string | number | undefined>;

/**
 * What the filters ask the API for. A custom range runs from the start of its first local day to
 * the end of its last — or to `now`, when the last day is today or later, so "to today" does not
 * reach into hours that have not happened.
 */
export function reportQuery(f: ReportFilters, timezone: string, now: Date): ReportQuery {
  const query: ReportQuery = {
    timezone,
    provider: f.platform || undefined,
    connectionId: f.connection || undefined,
    source: f.source || undefined,
    scope: f.scope === 'all' ? 'all' : undefined,
  };
  if (f.range !== 'custom') return { ...query, days: Number(f.range) };
  const end = localDay(f.to, 1);
  return {
    ...query,
    from: localDay(f.from).toISOString(),
    to: (end > now ? now : end).toISOString(),
  };
}

/** The viewer's IANA zone, as the browser reports it; UTC when it reports none. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// --- Formatting ---

export function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? DASH : value.toLocaleString();
}

export function compact(value: number | null | undefined): string {
  return value === null || value === undefined
    ? DASH
    : value.toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 });
}

/** A rate in percent: two decimals under 10, one above ("4.25%", "12.3%"). */
export function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined) return DASH;
  const digits = Math.abs(value) < 10 ? 2 : 1;
  return `${value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}

/** "+12%" / "−8%"; "—" when there is nothing to compare with. Never "+∞%". */
export function signedPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  const rounded = Math.round(Math.abs(value) * 10) / 10;
  if (rounded === 0) return '0%';
  return `${value > 0 ? '+' : '−'}${rounded.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

/** A bucket's first day (`YYYY-MM-DD`) as a short axis label: "Sep 12". */
export function bucketLabel(key: string): string {
  return localDay(key).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** 0–23 as "12am", "9am", "1pm". */
export function hourLabel(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}${hour < 12 ? 'am' : 'pm'}`;
}

export function slotLabel(slot: { weekday: number; hour: number }): string {
  return `${WEEKDAYS[slot.weekday] ?? '?'} ${hourLabel(slot.hour)}`;
}

/** An age after publishing: "6h", "24h", "2d", "30d". */
export function ageLabel(hours: number): string {
  return hours <= 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/** A posts-per-week band: "1–2/wk", "11+/wk". */
export function bandLabel(band: { min: number; max: number | null }): string {
  if (band.max === null) return `${band.min}+/wk`;
  return band.min === band.max ? `${band.min}/wk` : `${band.min}–${band.max}/wk`;
}

// --- Engagement rate, in words ---

/** What a rate was divided by: "÷ reach", "÷ views", or the split when the two were mixed. */
export function basisText(
  stat: Pick<EngagementRateStat, 'basis' | 'byReach' | 'byViews'>,
): string | null {
  switch (stat.basis) {
    case 'reach':
      return '÷ reach';
    case 'views':
      return '÷ views';
    case 'mixed':
      return `mixed: ${stat.byReach.toLocaleString()} by reach, ${stat.byViews.toLocaleString()} by views`;
    default:
      return null;
  }
}

/**
 * Everything that qualifies a rate, as one sentence: how many posts it rests on, what it was
 * divided by, and which engagement concepts were in the numerator at all.
 */
export function rateNote(stat: EngagementRateStat): string {
  if (stat.rate === null) {
    return stat.posts === 0
      ? 'No posts in this period.'
      : 'No post reports both an engagement count and reach or views.';
  }
  const of =
    stat.postsCounted === stat.posts
      ? `${stat.posts.toLocaleString()} ${stat.posts === 1 ? 'post' : 'posts'}`
      : `${stat.postsCounted.toLocaleString()} of ${stat.posts.toLocaleString()} posts`;
  const counted = stat.components.map((c) => CONCEPT_LABEL[c].toLowerCase()).join(' + ');
  return `From ${of}, ${basisText(stat)}. Counted: ${counted}.`;
}

// --- Top posts ---

export type PostSortKey = MetricConcept | 'engagementRate' | 'engagements' | 'publishAt';

const sortValue = (post: ReportPost, key: PostSortKey): number | null => {
  switch (key) {
    case 'publishAt':
      return new Date(post.publishAt).getTime();
    case 'engagementRate':
      return post.engagementRate;
    case 'engagements':
      return post.engagements;
    default:
      return post.metrics[key];
  }
};

/**
 * Posts ordered by one column. A post with no value for it goes last in BOTH directions: "—" is
 * not the smallest number, it is no number. Ties keep the incoming (most-engagements-first) order.
 */
export function sortPosts(
  posts: readonly ReportPost[],
  key: PostSortKey,
  dir: 'asc' | 'desc',
): ReportPost[] {
  return posts
    .map((post, index) => ({ post, index, value: sortValue(post, key) }))
    .sort((a, b) => {
      if (a.value === null || b.value === null) {
        return a.value === b.value ? a.index - b.index : a.value === null ? 1 : -1;
      }
      return (dir === 'asc' ? a.value - b.value : b.value - a.value) || a.index - b.index;
    })
    .map((entry) => entry.post);
}

/** A caption on one line. */
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * One CSV cell. Quoted when it needs to be; and a cell a spreadsheet would run as a formula (a
 * caption is someone else's text) is prefixed so it stays text.
 */
export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  if (typeof value === 'number') return String(value);
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * The top-posts table as CSV, in the order given. A value that was not reported is an empty cell,
 * not 0. The engagement rate carries what it was divided by in the column beside it.
 */
export function postsCsv(
  posts: readonly ReportPost[],
  accounts: readonly Pick<ReportAccount, 'id' | 'displayName'>[],
  concepts: readonly MetricConcept[],
  platformLabel: (provider: string) => string,
): string {
  const names = new Map(accounts.map((a) => [a.id, a.displayName]));
  const header = [
    'Published (UTC)',
    'Platform',
    'Account',
    'Source',
    'Format',
    'Caption',
    'Link',
    ...concepts.map((c) => CONCEPT_LABEL[c]),
    'Engagements',
    'Engagement rate %',
    'Rate divided by',
  ];
  const rows = posts.map((p) => [
    new Date(p.publishAt).toISOString(),
    platformLabel(p.provider),
    names.get(p.connectionId) ?? '',
    p.source === 'imported' ? 'Imported' : 'Published here',
    p.format,
    flat(p.caption),
    p.releaseUrl ?? '',
    ...concepts.map((c) => p.metrics[c]),
    p.engagements,
    p.engagementRate === null ? null : Math.round(p.engagementRate * 100) / 100,
    p.basis ?? '',
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
