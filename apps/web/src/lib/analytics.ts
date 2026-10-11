import type { ConnectionView, PostView } from '@meegrow-social/contracts';
import { parsePublishAt } from './postDate';

/**
 * Pure logic for the Analytics screen (#28): URL filters, period windows, totals, deltas, chart and
 * table shaping. Nothing here knows a metric name — names are whatever the API returned (BUILD-SPEC-V2
 * invariant 7), and a value that does not exist is `null` (rendered "—"), never 0.
 */

/**
 * The one name this file may spell out: the API itself singles it out with its own endpoint
 * (`GET /v1/connections/:id/followers`), so it is an account-level series, not a per-post metric.
 */
export const FOLLOWERS = 'followers';

export const RANGE_DAYS = [7, 30, 90] as const;
export type RangeDays = (typeof RANGE_DAYS)[number];
export const DEFAULT_DAYS: RangeDays = 30;

/** `listPostsQuery` caps `limit` at 100. */
export const LIST_PAGE = 100;
/** Stop paging the post list here; past it the newest posts may be missing and the page says so. */
export const LIST_MAX_PAGES = 20;
/** There is no bulk metrics read, so it is one request per post: this many at a time… */
export const METRICS_CHUNK = 10;
/** …and at most this many posts per view. */
export const POST_CAP = 300;
export const TABLE_PAGE = 50;

export const DASH = '—';

const DAY_MS = 86_400_000;

// --- Filters (kept in the URL: ?platform=&connection=&days=) ---

export interface AnalyticsFilters {
  /** Provider identifier, or '' for all platforms. */
  platform: string;
  /** Connection id, or '' for all profiles. */
  connection: string;
  days: RangeDays;
}

const isRangeDays = (n: number): n is RangeDays => (RANGE_DAYS as readonly number[]).includes(n);

/** Read the filters from the query string; anything missing or unrecognised falls back to the default. */
export function parseFilters(params: URLSearchParams): AnalyticsFilters {
  const days = Number(params.get('days'));
  return {
    platform: params.get('platform') ?? '',
    connection: params.get('connection') ?? '',
    days: isRangeDays(days) ? days : DEFAULT_DAYS,
  };
}

/** The query string for a filter set; defaults are left out so the plain URL stays plain. */
export function filtersToParams(f: AnalyticsFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (f.platform) params.set('platform', f.platform);
  if (f.connection) params.set('connection', f.connection);
  if (f.days !== DEFAULT_DAYS) params.set('days', String(f.days));
  return params;
}

type ConnectionRef = Pick<ConnectionView, 'id' | 'provider'>;

/**
 * Drop filter values that do not exist in this workspace (a stale link, or the previous client's
 * ids after a switch), and a profile that does not belong to the chosen platform.
 */
export function resolveFilters(
  f: AnalyticsFilters,
  connections: readonly ConnectionRef[],
): AnalyticsFilters {
  const platform = connections.some((c) => c.provider === f.platform) ? f.platform : '';
  const match = connections.find((c) => c.id === f.connection);
  const connection = match && (platform === '' || match.provider === platform) ? match.id : '';
  return { platform, connection, days: f.days };
}

/** Distinct providers among the connections, in first-seen order. Derived, never enumerated. */
export function platformsOf(connections: readonly ConnectionRef[]): string[] {
  return [...new Set(connections.map((c) => c.provider))];
}

/** Connections offered by the profile filter: all of them, or the chosen platform's. */
export function connectionsFor<C extends ConnectionRef>(
  connections: readonly C[],
  platform: string,
): C[] {
  return connections.filter((c) => platform === '' || c.provider === platform);
}

/** The connections the current filters cover. */
export function selectedConnections<C extends ConnectionRef>(
  connections: readonly C[],
  f: AnalyticsFilters,
): C[] {
  return connectionsFor(connections, f.platform).filter(
    (c) => f.connection === '' || c.id === f.connection,
  );
}

// --- Windows ---

/** The period `(start, end]` and the equally long one before it, `(priorStart, start]`. Epoch ms. */
export interface Windows {
  priorStart: number;
  start: number;
  end: number;
}

export function windowsFor(now: number, days: number): Windows {
  const start = now - days * DAY_MS;
  return { priorStart: start - days * DAY_MS, start, end: now };
}

export type WindowName = 'current' | 'prior';

export function windowOf(at: number, w: Windows): WindowName | null {
  if (at > w.start && at <= w.end) return 'current';
  if (at > w.priorStart && at <= w.start) return 'prior';
  return null;
}

// --- Posts ---

export interface WindowedPost {
  post: PostView;
  /** Publish time, epoch ms. */
  at: number;
  window: WindowName;
}

/** Posts that fall in either window, newest first. Undated and out-of-range posts are dropped. */
export function windowPosts(posts: readonly PostView[], w: Windows): WindowedPost[] {
  const out: WindowedPost[] = [];
  for (const post of posts) {
    const at = parsePublishAt(post.publishAt)?.getTime();
    if (at === undefined) continue;
    const window = windowOf(at, w);
    if (window) out.push({ post, at, window });
  }
  return out.sort((a, b) => b.at - a.at);
}

export interface CappedPosts {
  /** Posts in the period whose metrics are loaded, newest first. */
  current: WindowedPost[];
  /** Posts in the prior period whose metrics are loaded, newest first. */
  prior: WindowedPost[];
  /** Posts in the period before the cap. */
  currentTotal: number;
  /** False when the cap cut prior-period posts, so a comparison against them would be wrong. */
  priorComplete: boolean;
}

/** Apply the per-view cap: the period's newest posts first, the prior period with what is left. */
export function capPosts(windowed: readonly WindowedPost[], cap: number = POST_CAP): CappedPosts {
  const current = windowed.filter((p) => p.window === 'current');
  const prior = windowed.filter((p) => p.window === 'prior');
  const keptCurrent = current.slice(0, cap);
  const keptPrior = prior.slice(0, Math.max(0, cap - keptCurrent.length));
  return {
    current: keptCurrent,
    prior: keptPrior,
    currentTotal: current.length,
    priorComplete: keptPrior.length === prior.length,
  };
}

/**
 * Published posts with no usable publish time (legacy "publish now" posts, which are not being
 * backfilled). The date-bounded list never returns them, so they can appear in no period.
 */
export function countUndated(posts: readonly Pick<PostView, 'publishAt'>[]): number {
  return posts.filter((p) => parsePublishAt(p.publishAt) === null).length;
}

export const EMPTY_PERIOD_HINT = 'A longer date range may have some.';

/**
 * The line under "No published posts in this period". `undated` is the count from the unbounded
 * published list, or null when that check has not answered (or failed) — then only the generic hint
 * is honest. `atLeast` marks a count taken from a list that hit the paging limit.
 */
export function emptyPeriodNote(undated: { count: number; atLeast: boolean } | null): string {
  if (!undated || undated.count === 0) return EMPTY_PERIOD_HINT;
  const n = `${undated.atLeast ? 'At least ' : ''}${undated.count.toLocaleString()}`;
  const posts = undated.count === 1 ? 'published post has' : 'published posts have';
  return `${n} ${posts} no recorded publish time and cannot be placed in a period.`;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// --- Metric points ---

export interface MetricPoint {
  metric: string;
  value: number;
  /** Capture time, epoch ms. */
  at: number;
}

/** The API client returns JSON as-is, so `capturedAt` is an ISO string despite the contract's Date. */
interface WirePoint {
  metric: string;
  value: number;
  capturedAt: Date | string;
}

/**
 * Parse capture times and order the points oldest first, whichever way they arrived (post series
 * come oldest first, follower series newest first). Points with an unreadable time are dropped.
 */
export function parsePoints(points: readonly WirePoint[]): MetricPoint[] {
  return points
    .map((p) => ({ metric: p.metric, value: p.value, at: new Date(p.capturedAt).getTime() }))
    .filter((p) => !Number.isNaN(p.at))
    .sort((a, b) => a.at - b.at);
}

/** One post's metrics once its request settled. A post still loading has no entry. */
export type PostMetrics =
  | { status: 'ok'; latest: Record<string, number>; series: MetricPoint[] }
  | { status: 'error'; message: string };

export type MetricsByPost = ReadonlyMap<string, PostMetrics>;

/** Follower points per connection id, oldest first. */
export type FollowersByConnection = ReadonlyMap<string, readonly MetricPoint[]>;

export function loadProgress(
  posts: readonly WindowedPost[],
  metrics: MetricsByPost,
): { total: number; done: number; failed: number } {
  let done = 0;
  let failed = 0;
  for (const p of posts) {
    const entry = metrics.get(p.post.id);
    if (entry) done += 1;
    if (entry?.status === 'error') failed += 1;
  }
  return { total: posts.length, done, failed };
}

/** Union of metric names across a set of `latest` maps, alphabetical. */
export function metricNames(latests: Iterable<Record<string, number>>): string[] {
  const names = new Set<string>();
  for (const latest of latests) for (const name of Object.keys(latest)) names.add(name);
  return [...names].sort((a, b) => a.localeCompare(b));
}

// --- Tiles ---

export interface Tile {
  name: string;
  /** null = nothing captured in the period. */
  value: number | null;
  /** Percentage change vs the prior period; null = no honest comparison exists. */
  delta: number | null;
}

/** Percentage change, or null when there is no prior value (or it is zero) to compare against. */
export function percentChange(current: number, prior: number | null | undefined): number | null {
  if (prior === null || prior === undefined || prior === 0) return null;
  const change = ((current - prior) / Math.abs(prior)) * 100;
  return Number.isFinite(change) ? change : null;
}

function sumLatest(posts: readonly WindowedPost[], metrics: MetricsByPost): Map<string, number> {
  const sums = new Map<string, number>();
  for (const p of posts) {
    const entry = metrics.get(p.post.id);
    if (entry?.status !== 'ok') continue;
    for (const [name, value] of Object.entries(entry.latest)) {
      sums.set(name, (sums.get(name) ?? 0) + value);
    }
  }
  return sums;
}

/**
 * One tile per metric name returned for posts published in the period: the sum of each post's
 * latest (all-time) value, against the same sum for posts published in the prior period. The
 * comparison is withheld when either side is incomplete (a post failed or is still loading, or the
 * cap cut the prior period) — a partial sum would produce a confident wrong percentage.
 */
export function postTiles(capped: CappedPosts, metrics: MetricsByPost): Tile[] {
  const current = sumLatest(capped.current, metrics);
  const prior = sumLatest(capped.prior, metrics);
  const comparable =
    capped.priorComplete &&
    [...capped.current, ...capped.prior].every((p) => metrics.get(p.post.id)?.status === 'ok');
  return [...current.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      value: current.get(name) ?? null,
      delta: comparable ? percentChange(current.get(name) ?? 0, prior.get(name)) : null,
    }));
}

/**
 * A follower series (oldest first) reduced to the two points a period needs: the newest inside the
 * window, and the newest at or before its start.
 */
export function followerSnapshot(
  points: readonly MetricPoint[],
  w: Windows,
): { current: MetricPoint | null; baseline: MetricPoint | null } {
  let current: MetricPoint | null = null;
  let baseline: MetricPoint | null = null;
  for (const p of points) {
    if (p.at <= w.start) baseline = p;
    else if (p.at <= w.end) current = p;
  }
  return { current, baseline };
}

/**
 * Followers across the given connections. No tile at all when none of them has a follower series
 * (a platform without the concept); a value only from connections captured inside the window; a
 * delta only when every one of those also has a point from before the window.
 */
export function followersTile(series: Iterable<readonly MetricPoint[]>, w: Windows): Tile | null {
  let any = false;
  let value: number | null = null;
  let baseline = 0;
  let comparable = true;
  for (const points of series) {
    if (points.length === 0) continue;
    any = true;
    const snap = followerSnapshot(points, w);
    if (!snap.current) continue;
    value = (value ?? 0) + snap.current.value;
    if (snap.baseline) baseline += snap.baseline.value;
    else comparable = false;
  }
  if (!any) return null;
  return {
    name: FOLLOWERS,
    value,
    delta: value !== null && comparable ? percentChange(value, baseline) : null,
  };
}

/** Followers first (when any selected connection has the series), then the per-post names. */
export function buildTiles(
  capped: CappedPosts,
  metrics: MetricsByPost,
  followers: Iterable<readonly MetricPoint[]>,
  w: Windows,
): Tile[] {
  const account = followersTile(followers, w);
  const posts = postTiles(capped, metrics);
  // The account-level series owns the name if a platform ever reports a per-post metric called the same.
  return account ? [account, ...posts.filter((t) => t.name !== FOLLOWERS)] : posts;
}

// --- Per-platform / per-profile comparison ---

export interface GroupTotal {
  /** Provider identifier or connection id. */
  key: string;
  /** null = this platform/profile has no such metric in the period. */
  value: number | null;
}

/**
 * The period total of one metric for each platform (or each profile, once a platform is chosen).
 * Every selected connection's group is listed, including those with nothing to show.
 */
export function groupTotals(opts: {
  metric: string;
  groupBy: 'platform' | 'connection';
  connections: readonly ConnectionRef[];
  /** Posts published in the period. */
  posts: readonly WindowedPost[];
  metrics: MetricsByPost;
  followers: FollowersByConnection;
  windows: Windows;
}): GroupTotal[] {
  const byPlatform = opts.groupBy === 'platform';
  const totals = new Map<string, number | null>();
  for (const c of opts.connections) totals.set(byPlatform ? c.provider : c.id, null);
  const add = (key: string, value: number) => {
    if (totals.has(key)) totals.set(key, (totals.get(key) ?? 0) + value);
  };
  if (opts.metric === FOLLOWERS) {
    for (const c of opts.connections) {
      const current = followerSnapshot(opts.followers.get(c.id) ?? [], opts.windows).current;
      if (current) add(byPlatform ? c.provider : c.id, current.value);
    }
  } else {
    for (const p of opts.posts) {
      const entry = opts.metrics.get(p.post.id);
      const value = entry?.status === 'ok' ? entry.latest[opts.metric] : undefined;
      if (value !== undefined) add(byPlatform ? p.post.provider : p.post.connectionId, value);
    }
  }
  return [...totals].map(([key, value]) => ({ key, value }));
}

// --- Followers over time ---

/** Local calendar day, `YYYY-MM-DD`. */
export function dayKey(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight of every calendar day the period touches, oldest first. */
export function windowDays(w: Windows): number[] {
  const first = new Date(w.start);
  const days: number[] = [];
  for (
    let d = new Date(first.getFullYear(), first.getMonth(), first.getDate());
    d.getTime() <= w.end;
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
  ) {
    days.push(d.getTime());
  }
  return days;
}

const shortDay = (at: number) =>
  new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export type FollowerCoverage = 'charted' | 'outside' | 'none';

export interface FollowerTimeline {
  /** One row per day: `day` (label) plus one field per charted connection id, null on days without a capture. */
  rows: Array<Record<string, string | number | null>>;
  /**
   * Per connection: `charted` (captures inside the period), `outside` (a series exists, but nothing
   * in the period), `none` (no follower series at all).
   */
  coverage: Map<string, FollowerCoverage>;
  /** A charted series has a single day of data: a line cannot show it, so the chart needs dots. */
  sparse: boolean;
}

/** Follower series bucketed by local day (the day's last capture wins) across the period. */
export function followerTimeline(
  series: ReadonlyArray<{ id: string; points: readonly MetricPoint[] }>,
  w: Windows,
  formatDay: (at: number) => string = shortDay,
): FollowerTimeline {
  const coverage = new Map<string, FollowerCoverage>();
  const byDay = new Map<string, Map<string, number>>();
  let sparse = false;
  for (const { id, points } of series) {
    const inside = points.filter((p) => windowOf(p.at, w) === 'current');
    coverage.set(id, inside.length > 0 ? 'charted' : points.length > 0 ? 'outside' : 'none');
    const days = new Map<string, number>();
    // Oldest first, so a later capture on the same day overwrites the earlier one.
    for (const p of inside) days.set(dayKey(p.at), p.value);
    if (days.size === 1) sparse = true;
    byDay.set(id, days);
  }
  const charted = [...coverage].filter(([, c]) => c === 'charted').map(([id]) => id);
  const rows = windowDays(w).map((at) => {
    const row: Record<string, string | number | null> = { day: formatDay(at) };
    for (const id of charted) row[id] = byDay.get(id)?.get(dayKey(at)) ?? null;
    return row;
  });
  return { rows, coverage, sparse };
}

// --- Per-post table ---

/** Metric columns for the rows on screen: the union of names their loaded metrics carry, alphabetical. */
export function tableMetricColumns(
  rows: readonly WindowedPost[],
  metrics: MetricsByPost,
): string[] {
  const latests: Record<string, number>[] = [];
  for (const row of rows) {
    const entry = metrics.get(row.post.id);
    if (entry?.status === 'ok') latests.push(entry.latest);
  }
  return metricNames(latests);
}

export type MetricCell =
  | { kind: 'pending' }
  | { kind: 'error'; message: string }
  /** The post loaded fine and simply has no such metric: "—", never 0. */
  | { kind: 'missing' }
  | { kind: 'value'; value: number };

export function metricCell(entry: PostMetrics | undefined, name: string): MetricCell {
  if (!entry) return { kind: 'pending' };
  if (entry.status === 'error') return { kind: 'error', message: entry.message };
  const value = entry.latest[name];
  return value === undefined ? { kind: 'missing' } : { kind: 'value', value };
}

export interface MetricHistory {
  name: string;
  /** Oldest first. */
  points: MetricPoint[];
  /** Capture time of the newest point. */
  last: number;
}

/** A post's series split per metric name (alphabetical), for the expanded row. */
export function metricHistories(series: readonly MetricPoint[]): MetricHistory[] {
  const byName = new Map<string, MetricPoint[]>();
  for (const p of series) byName.set(p.metric, [...(byName.get(p.metric) ?? []), p]);
  return [...byName]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, points]) => ({ name, points, last: points[points.length - 1]!.at }));
}

// --- Sync line ---

/** Newest capture per connection, across its follower series and its loaded posts' series. */
export function lastCaptureByConnection(
  posts: readonly WindowedPost[],
  metrics: MetricsByPost,
  followers: FollowersByConnection,
): Map<string, number> {
  const last = new Map<string, number>();
  const see = (id: string, at: number) => {
    if (at > (last.get(id) ?? -Infinity)) last.set(id, at);
  };
  for (const [id, points] of followers) for (const p of points) see(id, p.at);
  for (const p of posts) {
    const entry = metrics.get(p.post.id);
    if (entry?.status === 'ok')
      for (const point of entry.series) see(p.post.connectionId, point.at);
  }
  return last;
}

/** Newest capture across everything loaded, or null when nothing has been collected. */
export function latestCapture(lastByConnection: ReadonlyMap<string, number>): number | null {
  let max: number | null = null;
  for (const at of lastByConnection.values()) if (max === null || at > max) max = at;
  return max;
}

/** The analytics sweep skips a connection in this state, so its numbers silently stop. */
export function needsReconnect(c: Pick<ConnectionView, 'needsReconnect' | 'health'>): boolean {
  return c.needsReconnect || c.health === 'needs_reconnect';
}

// --- Formatting ---

/** Cosmetic only — underscores to spaces, first letter capitalised. Never a rename map. */
export function humanizeMetric(name: string): string {
  const spaced = name.replace(/_/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A metric value for display; "—" when there is none. */
export function formatValue(value: number | null | undefined): string {
  return value === null || value === undefined ? DASH : value.toLocaleString();
}

export function formatCapture(at: number): string {
  return new Date(at).toLocaleString();
}

/** Make repeated labels distinguishable ("Acme", "Acme (2)") — chart categories must not collide. */
export function uniqueLabels(labels: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return labels.map((label) => {
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    return n === 1 ? label : `${label} (${n})`;
  });
}

// --- Roles ---

/**
 * Is this membership role a client's? Clients get the same screen without operator affordances.
 * `viewer` counts until the roles matrix (#20) adds `client`. Cosmetic only: the API does not
 * enforce the role yet.
 */
export function isClientRole(role: string | null | undefined): boolean {
  return role === 'client' || role === 'viewer';
}
