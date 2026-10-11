import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { AnalyticsStatusView, ConnectionView, PostView } from '@meegrow-social/contracts';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { cn } from '../lib/cn';
import { providerVisible } from '../lib/devProviders';
import { platformMeta } from '../lib/platforms';
import {
  BULK_METRICS_MAX,
  compactNumber,
  idChunks,
  mediaThumb,
  shortDateTime,
} from '../lib/postGroups';
import { appendPage, captionSnippet, safeExternalUrl } from '../lib/postList';
import {
  FOLLOWERS,
  FOLLOWERS_CHUNK,
  LIST_MAX_PAGES,
  LIST_PAGE,
  RANGE_DAYS,
  TABLE_PAGE,
  bestPost,
  buildTiles,
  bulkEntries,
  bulkFailure,
  cadenceText,
  chunk,
  connectionsFor,
  countUndated,
  emptyPeriodNote,
  filtersToParams,
  followerSnapshot,
  followerTimeline,
  formatCapture,
  formatValue,
  groupTotals,
  humanizeMetric,
  isClientRole,
  lastCaptureByConnection,
  loadProgress,
  metricCell,
  metricHistories,
  needsReconnect,
  nextRefresh,
  parseFilters,
  parsePoints,
  platformsOf,
  postCount,
  resolveFilters,
  selectedConnections,
  splitPeriods,
  tableMetricColumns,
  uniqueLabels,
  windowPosts,
  windowsFor,
  type AnalyticsFilters,
  type FollowersByConnection,
  type MetricCell,
  type MetricPoint,
  type MetricsByPost,
  type PeriodPosts,
  type PostMetrics,
  type RangeDays,
  type Tile,
  type WindowedPost,
  type Windows,
} from '../lib/analytics';
import { PostThumb } from '../components/PostThumb';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Chart, chartColor } from '../components/ui/Chart';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { FilterBar, FilterSelect } from '../components/ui/FilterBar';
import { PageHeader } from '../components/ui/PageHeader';
import { Skeleton } from '../components/ui/Skeleton';
import { Sparkline } from '../components/ui/Sparkline';
import { StatTile } from '../components/ui/StatTile';
import { Table, type TableColumn } from '../components/ui/Table';
import {
  ArrowSquareOut,
  Article,
  CaretDown,
  CaretRight,
  ChartLineUp,
  Plugs,
  Trophy,
} from '../lib/icons';

// The page is in the sidebar for everyone, but its numbers have not been checked against the
// platforms yet (docs/dev/ANALYTICS-UI-BRIEF.md §7), so it says so. Setting VITE_ANALYTICS_UI=true at
// build time records that sign-off and drops the badge; this is the only read of the flag.
const VALIDATED = import.meta.env.VITE_ANALYTICS_UI === 'true';

const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Please try again.');

type Load<T> =
  { status: 'loading' } | { status: 'ok'; data: T } | { status: 'error'; message: string };
const LOADING = { status: 'loading' } as const;

type FollowerLoad = { status: 'ok'; points: MetricPoint[] } | { status: 'error'; message: string };

interface PostList {
  posts: PostView[];
  /** The list hit the paging limit; it is ordered oldest first, so the newest posts may be missing. */
  truncated: boolean;
}

const NO_CONNECTIONS: ConnectionView[] = [];

const platformLabel = (provider: string) =>
  platformMeta({ identifier: provider, displayName: provider }).label;

/** A distinct display label per connection id. Names only — ids never reach the screen. */
function profileLabels(connections: ConnectionView[], withPlatform: boolean): Map<string, string> {
  const labels = uniqueLabels(
    connections.map((c) =>
      withPlatform ? `${c.displayName} · ${platformLabel(c.provider)}` : c.displayName,
    ),
  );
  return new Map(connections.map((c, i) => [c.id, labels[i]!]));
}

/**
 * Every published post in the range — or, with no range, every published post there is, including
 * those without a publish time. The API pages at 100 and returns no total.
 */
async function listPublished(query: {
  provider?: string;
  connectionId?: string;
  from?: string;
  to?: string;
}): Promise<PostList> {
  let posts: PostView[] = [];
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const res = await api.listPosts({
      ...query,
      status: 'published',
      limit: LIST_PAGE,
      offset: page * LIST_PAGE,
    });
    posts = appendPage(posts, res.posts);
    if (res.posts.length < LIST_PAGE) return { posts, truncated: false };
  }
  return { posts, truncated: true };
}

/**
 * Loads everything the screen shows for one filter set: connections, the published posts of the
 * period and the one before it, their latest metrics (one bulk read per 200 posts), each selected
 * connection's follower series, and when the data was last collected. Per-post and per-connection
 * results are kept across filter changes, so narrowing a view costs no new requests.
 */
function useAnalyticsData(raw: AnalyticsFilters) {
  const [run, setRun] = useState(() => ({ attempt: 0, now: Date.now() }));
  // Results that land after a retry belong to the run before it and are dropped.
  const liveAttempt = useRef(0);

  const [connections, setConnections] = useState<Load<ConnectionView[]>>(LOADING);
  const [status, setStatus] = useState<Load<AnalyticsStatusView>>(LOADING);
  const [postList, setPostList] = useState<{ key: string; load: Load<PostList> }>({
    key: '',
    load: LOADING,
  });
  const [undated, setUndated] = useState<{
    key: string;
    result: { count: number; atLeast: boolean } | null;
  }>({ key: '', result: null });
  const metricsCache = useRef(new Map<string, PostMetrics>());
  const metricsAsked = useRef(new Set<string>());
  const [metrics, setMetrics] = useState<MetricsByPost>(metricsCache.current);
  const followersCache = useRef(new Map<string, FollowerLoad>());
  const [followerLoads, setFollowerLoads] = useState<ReadonlyMap<string, FollowerLoad>>(
    followersCache.current,
  );

  const retry = () => {
    liveAttempt.current += 1;
    metricsCache.current = new Map();
    metricsAsked.current = new Set();
    followersCache.current = new Map();
    setMetrics(metricsCache.current);
    setFollowerLoads(followersCache.current);
    setRun({ attempt: liveAttempt.current, now: Date.now() });
  };

  useEffect(() => {
    let stale = false;
    setConnections(LOADING);
    api
      .listConnections()
      .then((res) => {
        // Dev/fake connections stay out of every view in production (lib/devProviders).
        const visible = res.connections.filter((c) => providerVisible(c.provider));
        if (!stale) setConnections({ status: 'ok', data: visible });
      })
      .catch((e: unknown) => {
        if (!stale) setConnections({ status: 'error', message: errorText(e) });
      });
    return () => {
      stale = true;
    };
  }, [run.attempt]);

  // When the numbers were last collected and when the next collection falls due. A failure here
  // costs the sync line its facts, never the page.
  useEffect(() => {
    let stale = false;
    setStatus(LOADING);
    api
      .analyticsStatus()
      .then((data) => {
        if (!stale) setStatus({ status: 'ok', data });
      })
      .catch((e: unknown) => {
        if (!stale) setStatus({ status: 'error', message: errorText(e) });
      });
    return () => {
      stale = true;
    };
  }, [run.attempt]);

  const all = connections.status === 'ok' ? connections.data : NO_CONNECTIONS;
  const ready = connections.status === 'ok' && all.length > 0;
  // Until the connections are known the URL's values are taken as written.
  const filters = useMemo(
    () => (connections.status === 'ok' ? resolveFilters(raw, all) : raw),
    [raw, connections.status, all],
  );
  const selected = useMemo(() => selectedConnections(all, filters), [all, filters]);
  const windows = useMemo(() => windowsFor(run.now, filters.days), [run.now, filters.days]);

  const listKey = `${run.attempt}|${filters.platform}|${filters.connection}|${filters.days}`;
  useEffect(() => {
    if (!ready) return;
    let stale = false;
    const settle = (load: Load<PostList>) => {
      if (!stale) setPostList({ key: listKey, load });
    };
    listPublished({
      provider: filters.platform || undefined,
      connectionId: filters.connection || undefined,
      from: new Date(windows.priorStart).toISOString(),
      to: new Date(windows.end).toISOString(),
    })
      .then((list) =>
        settle({
          status: 'ok',
          data: { ...list, posts: list.posts.filter((p) => providerVisible(p.provider)) },
        }),
      )
      .catch((e: unknown) => settle({ status: 'error', message: errorText(e) }));
    return () => {
      stale = true;
    };
  }, [ready, listKey, filters.platform, filters.connection, windows]);
  // A list loaded for other filters is not this view's list.
  const posts: Load<PostList> = postList.key === listKey ? postList.load : LOADING;

  const period = useMemo(
    () => (posts.status === 'ok' ? splitPeriods(windowPosts(posts.data.posts, windows)) : null),
    [posts, windows],
  );

  // An empty period has two very different causes: nothing was published, or what was published has
  // no stored publish time (legacy posts) and so falls in no period at all. Only then is it worth
  // one more read of the list, without the date bounds, to tell them apart.
  const periodEmpty = period !== null && period.current.length === 0;
  const undatedKey = `${run.attempt}|${filters.platform}|${filters.connection}`;
  useEffect(() => {
    if (!periodEmpty) return;
    let stale = false;
    listPublished({
      provider: filters.platform || undefined,
      connectionId: filters.connection || undefined,
    })
      .then((list) => {
        if (stale) return;
        const count = countUndated(list.posts.filter((p) => providerVisible(p.provider)));
        setUndated({ key: undatedKey, result: { count, atLeast: list.truncated } });
      })
      // The generic empty state stays; this check is a refinement, not something to fail the page on.
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [periodEmpty, undatedKey, filters.platform, filters.connection]);
  const undatedPosts = periodEmpty && undated.key === undatedKey ? undated.result : null;

  // Latest metrics for every post of both periods: one bulk read per 200 ids. An id is asked for
  // once; a failed read marks its posts, not the page.
  useEffect(() => {
    if (!period) return;
    const attempt = run.attempt;
    const missing = [...period.current, ...period.prior]
      .map((p) => p.post.id)
      .filter((id) => !metricsAsked.current.has(id));
    for (const id of missing) metricsAsked.current.add(id);
    for (const ids of idChunks(missing, BULK_METRICS_MAX)) {
      void api
        .latestPostMetrics(ids)
        .then((res) => bulkEntries(ids, res.metrics))
        .catch((e: unknown) => bulkFailure(ids, errorText(e)))
        .then((settled) => {
          if (liveAttempt.current !== attempt) return;
          metricsCache.current = new Map([...metricsCache.current, ...settled]);
          setMetrics(metricsCache.current);
        });
    }
  }, [period, run.attempt]);

  const selectedIds = selected.map((c) => c.id).join(',');
  useEffect(() => {
    if (!selectedIds) return;
    const attempt = run.attempt;
    const missing = selectedIds.split(',').filter((id) => !followersCache.current.has(id));
    for (const ids of chunk(missing, FOLLOWERS_CHUNK)) {
      void Promise.all(
        ids.map(async (id): Promise<[string, FollowerLoad]> => {
          try {
            const res = await api.connectionFollowers(id);
            return [id, { status: 'ok', points: parsePoints(res.followers) }];
          } catch (e) {
            return [id, { status: 'error', message: errorText(e) }];
          }
        }),
      ).then((settled) => {
        if (liveAttempt.current !== attempt) return;
        followersCache.current = new Map([...followersCache.current, ...settled]);
        setFollowerLoads(followersCache.current);
      });
    }
  }, [selectedIds, run.attempt]);

  // Follower series of the selected connections that have arrived so far…
  const followersSoFar = useMemo(() => {
    const map = new Map<string, MetricPoint[]>();
    for (const c of selected) {
      const load = followerLoads.get(c.id);
      if (load?.status === 'ok') map.set(c.id, load.points);
    }
    return map;
  }, [selected, followerLoads]);
  // …and the same thing as one load: ready only when every one of them is in.
  const followers = useMemo((): Load<FollowersByConnection> => {
    const failed = selected.map((c) => followerLoads.get(c.id)).find((l) => l?.status === 'error');
    if (failed?.status === 'error') return { status: 'error', message: failed.message };
    return followersSoFar.size === selected.length
      ? { status: 'ok', data: followersSoFar }
      : LOADING;
  }, [selected, followerLoads, followersSoFar]);

  return {
    connections,
    status,
    now: run.now,
    all,
    filters,
    selected,
    windows,
    posts,
    period,
    undatedPosts,
    metrics,
    followers,
    followersSoFar,
    retry,
  };
}

/** Analytics: how one client's published posts and connected accounts are performing. */
export function Analytics() {
  const { me } = useAuth();
  const [params, setParams] = useSearchParams();
  const raw = useMemo(() => parseFilters(params), [params]);
  const data = useAnalyticsData(raw);
  const { connections, all, filters, selected, windows, posts, period, metrics, followers } = data;

  const workspace = me?.user.memberships.find((m) => m.workspaceId === me.activeWorkspaceId);
  // Clients see the same numbers without operator affordances. Cosmetic until #20 enforces the
  // role at the API.
  const isClient = isClientRole(workspace?.role);
  // The metric the comparison chart and "best post" use. Kept in the URL beside the filters; a
  // name the data does not have (a stale link) falls back to the first one that exists.
  const wantedMetric = params.get('metric') ?? '';
  const write = (next: AnalyticsFilters, metric: string) => {
    const out = filtersToParams(next);
    if (metric) out.set('metric', metric);
    setParams(out, { replace: true });
  };
  const setFilters = (patch: Partial<AnalyticsFilters>) =>
    write(resolveFilters({ ...filters, ...patch }, all), wantedMetric);

  const loaded = useMemo(() => (period ? [...period.current, ...period.prior] : []), [period]);
  const progress = useMemo(() => loadProgress(loaded, metrics), [loaded, metrics]);
  const metricsSettled = period !== null && progress.done === progress.total;
  const lastByConnection = useMemo(
    () => lastCaptureByConnection(loaded, metrics, data.followersSoFar),
    [loaded, metrics, data.followersSoFar],
  );
  // A list cut short at the paging limit is missing posts on one side or the other: no comparison.
  const complete = posts.status === 'ok' && !posts.data.truncated;

  const sectionError =
    posts.status === 'error'
      ? posts.message
      : followers.status === 'error'
        ? followers.message
        : null;
  const settled = period !== null && metricsSettled && followers.status === 'ok';
  const tiles = useMemo(
    () =>
      period && followers.status === 'ok' && metricsSettled
        ? buildTiles(period, metrics, followers.data.values(), windows, complete)
        : [],
    [period, followers, metricsSettled, metrics, windows, complete],
  );
  // The metric picker lists the per-post names by period total, largest first, so the default is
  // the headline number and a metric a post can be "best" at; followers (an account's number, not
  // a post's) comes last and stays pickable for the comparison chart. All from the data.
  const postNames = tiles
    .filter((t) => t.name !== FOLLOWERS)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || a.name.localeCompare(b.name))
    .map((t) => t.name);
  const names = tiles.some((t) => t.name === FOLLOWERS) ? [...postNames, FOLLOWERS] : postNames;
  const metric = names.includes(wantedMetric) ? wantedMetric : names[0];
  const bestMetric = metric && metric !== FOLLOWERS ? metric : postNames[0];
  const nothingYet =
    period !== null &&
    period.current.length === 0 &&
    followers.status === 'ok' &&
    [...followers.data.values()].every((points) => points.length === 0);

  const header = (
    <PageHeader
      title="Analytics"
      subtitle={
        workspace
          ? `Published posts and connected accounts for ${workspace.name}.`
          : 'Published posts and connected accounts for this client.'
      }
      actions={
        !VALIDATED && (
          <Badge variant="neutral">
            {isClient ? 'Beta' : 'Preview — numbers not yet validated'}
          </Badge>
        )
      }
    />
  );

  if (connections.status === 'error') {
    return (
      <div>
        {header}
        <ErrorState
          title="Couldn't load analytics"
          message={connections.message}
          onRetry={data.retry}
        />
      </div>
    );
  }

  if (connections.status === 'ok' && all.length === 0) {
    return (
      <div>
        {header}
        <EmptyState
          title="Connect an account to start collecting analytics."
          icon={Plugs}
          action={
            !isClient && (
              <Button asChild>
                <Link to="/connections">Connect an account</Link>
              </Button>
            )
          }
        />
      </div>
    );
  }

  const booting = connections.status === 'loading';
  const rangeText = `${new Date(windows.start).toLocaleDateString()} – ${new Date(windows.end).toLocaleDateString()}`;

  return (
    <div>
      {header}

      <FilterBar
        className="mb-2"
        filters={
          <>
            <FilterSelect
              label="Platform"
              value={filters.platform}
              onChange={(v) => setFilters({ platform: v })}
              options={[
                { value: '', label: 'All platforms' },
                ...platformsOf(all).map((p) => ({ value: p, label: platformLabel(p) })),
              ]}
            />
            <FilterSelect
              label="Profile"
              value={filters.connection}
              onChange={(v) => setFilters({ connection: v })}
              options={[
                { value: '', label: 'All profiles' },
                ...connectionsFor(all, filters.platform).map((c) => ({
                  value: c.id,
                  // Without a platform filter two accounts can share a name, so the platform is spelled out.
                  label: filters.platform
                    ? c.displayName
                    : `${c.displayName} · ${platformLabel(c.provider)}`,
                })),
              ]}
            />
            <FilterSelect
              label="Date range"
              value={String(filters.days)}
              onChange={(v) => setFilters({ days: Number(v) as RangeDays })}
              // The default first, so the pill reads as "no filter" until the range is changed.
              options={[30, ...RANGE_DAYS.filter((d) => d !== 30)].map((days) => ({
                value: String(days),
                label: `Last ${days} days`,
              }))}
            />
            {metric !== undefined && (
              <FilterSelect
                label="Metric for the comparison chart and best post"
                value={metric}
                onChange={(v) => write(filters, v === names[0] ? '' : v)}
                options={names.map((name) => ({ value: name, label: humanizeMetric(name) }))}
              />
            )}
          </>
        }
        actions={<p className="tnum text-caption text-muted">{rangeText}</p>}
      />

      <SyncLine
        status={data.status}
        now={data.now}
        stale={selected.filter(needsReconnect)}
        lastByConnection={lastByConnection}
        canReconnect={!isClient}
      />

      {/* Announces load progress and filter results to screen readers. */}
      <p role="status" className="sr-only">
        {sectionError
          ? 'Analytics failed to load'
          : !settled
            ? 'Loading analytics'
            : `${tiles.length} metrics shown for the last ${filters.days} days`}
      </p>

      {nothingYet ? (
        <EmptyState
          title="Nothing collected yet"
          description={
            data.undatedPosts?.count
              ? emptyPeriodNote(data.undatedPosts)
              : 'Metrics appear within an hour of the first published post. A longer date range may have data.'
          }
          icon={ChartLineUp}
        />
      ) : (
        <div className="space-y-4">
          <section aria-label="Totals" className="space-y-1.5">
            {sectionError ? (
              <ErrorState
                title="Couldn't load totals"
                message={sectionError}
                onRetry={data.retry}
              />
            ) : !settled || !period ? (
              <KpiSkeleton progress={period ? progress : null} />
            ) : (
              <Kpis
                tiles={tiles}
                period={period}
                complete={complete}
                days={filters.days}
                failed={progress.failed}
                best={
                  bestMetric
                    ? { name: bestMetric, hit: bestPost(period.current, metrics, bestMetric) }
                    : null
                }
              />
            )}
          </section>

          <section aria-label="Charts" className="grid gap-3 lg:grid-cols-2">
            {sectionError ? (
              <ChartFrame title="By platform">
                <ErrorState
                  title="Couldn't load this chart"
                  message={sectionError}
                  onRetry={data.retry}
                />
              </ChartFrame>
            ) : !settled || !period || followers.status !== 'ok' ? (
              <ChartFrame title="By platform">
                <Skeleton className="h-56 w-full" />
              </ChartFrame>
            ) : (
              <ComparisonChart
                metric={metric}
                byProfile={filters.platform !== ''}
                connections={selected}
                period={period}
                metrics={metrics}
                followers={followers.data}
                windows={windows}
              />
            )}
            {followers.status === 'error' ? (
              <ChartFrame title="Followers over time">
                <ErrorState
                  title="Couldn't load this chart"
                  message={followers.message}
                  onRetry={data.retry}
                />
              </ChartFrame>
            ) : followers.status === 'loading' || booting ? (
              <ChartFrame title="Followers over time">
                <Skeleton className="h-56 w-full" />
              </ChartFrame>
            ) : (
              <FollowersChart
                connections={selected}
                withPlatform={filters.platform === ''}
                followers={followers.data}
                windows={windows}
                days={filters.days}
              />
            )}
          </section>

          <section aria-label="Posts" className="space-y-2">
            <h2 className="text-body font-semibold text-ink">Posts published in this period</h2>
            {posts.status === 'error' ? (
              <ErrorState
                title="Couldn't load posts"
                message={posts.message}
                onRetry={data.retry}
              />
            ) : !period ? (
              <PostsTableSkeleton />
            ) : (
              <PostsTable
                // A new filter set starts again from the first page with every row collapsed.
                key={`${filters.platform}|${filters.connection}|${filters.days}`}
                period={period}
                undated={data.undatedPosts}
                metrics={metrics}
                connections={all}
              />
            )}
          </section>
        </div>
      )}
    </div>
  );
}

/**
 * When the data was last collected and when the next collection falls due — both facts from
 * `GET /v1/analytics/status`, with the collection rules worded from the cadence it reports. "Next
 * refresh from" because that is when something becomes due; the hourly run after it collects.
 */
function SyncLine({
  status,
  now,
  stale,
  lastByConnection,
  canReconnect,
}: {
  status: Load<AnalyticsStatusView>;
  now: number;
  stale: ConnectionView[];
  lastByConnection: ReadonlyMap<string, number>;
  canReconnect: boolean;
}) {
  const at = (ms: number) => (
    <time dateTime={new Date(ms).toISOString()}>{shortDateTime(new Date(ms), new Date(now))}</time>
  );
  let line: ReactNode;
  if (status.status === 'loading') line = 'Checking when data was last collected…';
  else if (status.status === 'error') line = 'Couldn’t check when data was last collected.';
  else {
    const captured = status.data.lastCapturedAt
      ? new Date(status.data.lastCapturedAt).getTime()
      : null;
    const next = nextRefresh(status.data, now);
    line = (
      <>
        {captured !== null ? <>Data as of {at(captured)}</> : 'No data collected yet'}
        {' · '}
        {next.kind === 'at' ? (
          <>next refresh from {at(next.at)}</>
        ) : next.kind === 'due' ? (
          'next refresh due now'
        ) : (
          'nothing to refresh: no account can be read'
        )}
        <span className="hidden sm:inline">
          {' · '}
          {cadenceText(status.data.cadence)}
        </span>
      </>
    );
  }
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <p className="tnum text-caption text-muted">{line}</p>
      {stale.map((c) => {
        const last = lastByConnection.get(c.id);
        return (
          <Badge key={c.id} variant="warning" className="tnum text-left">
            {c.displayName} needs reconnecting —{' '}
            {last !== undefined
              ? `its metrics stopped on ${formatCapture(last)}`
              : 'no metrics have been collected for it'}
          </Badge>
        );
      })}
      {canReconnect && stale.length > 0 && (
        <Link to="/connections" className="text-caption font-semibold text-ink underline">
          Reconnect
        </Link>
      )}
    </div>
  );
}

const TILE_HINT = 'Posts published in the period, all-time totals';
const FOLLOWERS_HINT = 'Latest capture in the period, summed across the selected profiles';
const POSTS_HINT = 'Posts published in the period';
// One cell of the strip: StatTile without its own frame, divided from its neighbours by hairlines.
// The grid's -1px margins hide the dividers on the strip's right and bottom edges.
const CELL = 'rounded-none border-0 border-b border-r border-hairline-soft';

/**
 * The headline numbers as one bordered strip: followers, posts published, then every metric the
 * period's posts report — whatever their names are — and the best post by the chosen metric.
 */
function Kpis({
  tiles,
  period,
  complete,
  days,
  failed,
  best,
}: {
  tiles: Tile[];
  period: PeriodPosts;
  complete: boolean;
  days: number;
  failed: number;
  best: { name: string; hit: { post: PostView; value: number } | null } | null;
}) {
  // Short, so a delta stays on one line in a narrow cell; the note under the strip names the period.
  const deltaLabel = 'vs prior';
  const count = postCount(period, complete);
  const account = tiles.find((t) => t.name === FOLLOWERS);
  const perPost = tiles.filter((t) => t.name !== FOLLOWERS);
  return (
    <>
      <div className="overflow-hidden rounded-md border border-hairline bg-canvas">
        <div className="-mb-px -mr-px grid grid-cols-2 sm:grid-cols-kpis">
          {account && (
            <StatTile
              className={CELL}
              label={humanizeMetric(account.name)}
              value={formatValue(account.value)}
              delta={account.delta}
              deltaLabel={deltaLabel}
              showMissingDelta
              hint={FOLLOWERS_HINT}
            />
          )}
          <StatTile
            className={CELL}
            label="Posts published"
            value={count.value.toLocaleString()}
            delta={count.delta}
            deltaLabel={deltaLabel}
            showMissingDelta
            hint={POSTS_HINT}
          />
          {perPost.map((tile) => (
            <StatTile
              key={tile.name}
              className={CELL}
              label={humanizeMetric(tile.name)}
              value={formatValue(tile.value)}
              delta={tile.delta}
              deltaLabel={deltaLabel}
              showMissingDelta
              hint={TILE_HINT}
            />
          ))}
          {best && <BestPost name={best.name} hit={best.hit} className={CELL} />}
        </div>
      </div>
      {/* The definitions are also on hover, but hover alone is not reachable by keyboard or touch. */}
      <p className="text-caption text-muted">
        {perPost.length > 0
          ? `Compared with the ${days} days before. Post metrics add up the all-time totals of posts published in the period, so an older post counts everything it has gathered since. Followers is the latest capture in the period.`
          : 'No post metrics captured for this period yet.'}
      </p>
      {failed > 0 && (
        <p className="text-caption font-semibold text-status-warn">
          Metrics for {failed.toLocaleString()} {failed === 1 ? 'post' : 'posts'} could not be
          loaded — totals leave them out and show no change vs prior.
        </p>
      )}
      {!complete && (
        <p className="text-caption font-semibold text-status-warn">
          There are more published posts in this range than could be listed; the newest may be
          missing, so nothing is compared with the prior period.
        </p>
      )}
    </>
  );
}

/** The post with the highest value of the chosen metric, linking to it. */
function BestPost({
  name,
  hit,
  className,
}: {
  name: string;
  hit: { post: PostView; value: number } | null;
  className?: string;
}) {
  const label = humanizeMetric(name);
  const url = hit ? safeExternalUrl(hit.post.releaseUrl) : null;
  const body = hit && (
    <>
      <PostThumb
        thumb={mediaThumb(hit.post.media)}
        caption={hit.post.caption}
        size="sm"
        className="h-10 w-10"
      />
      <span className="min-w-0 flex-1">
        <span className="tnum block text-lg font-semibold leading-tight text-ink">
          {formatValue(hit.value)}
        </span>
        <span className="block truncate text-caption text-muted">
          {captionSnippet(hit.post.caption, 60)}
        </span>
      </span>
    </>
  );
  const row = 'mt-1 flex min-w-0 items-center gap-2.5 rounded-sm';
  return (
    <div className={cn('col-span-2 min-w-0 bg-canvas p-3', className)}>
      <div className="flex items-center justify-between gap-2 text-caption font-medium text-muted">
        <span className="truncate" title={name}>
          Best post · {label}
        </span>
        <Trophy size={16} className="flex-none" aria-hidden="true" />
      </div>
      {!hit ? (
        <p className="mt-1 text-sm text-muted">
          <span aria-hidden="true">— </span>No post in this period reports {label}.
        </p>
      ) : url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Best post by ${label}, ${formatValue(hit.value)}: ${captionSnippet(hit.post.caption)} (opens on ${platformLabel(hit.post.provider)} in a new tab)`}
          className={cn(row, 'hover:bg-surface-soft')}
        >
          {body}
          <ArrowSquareOut size={14} className="flex-none text-muted" aria-hidden="true" />
        </a>
      ) : (
        // No link to the platform was stored for this post, so it opens where it can be found.
        <Link
          to="/content"
          aria-label={`Best post by ${label}, ${formatValue(hit.value)}: ${captionSnippet(hit.post.caption)}. Open Content`}
          className={cn(row, 'hover:bg-surface-soft')}
        >
          {body}
        </Link>
      )}
    </div>
  );
}

/** Same strip geometry as the loaded numbers, so nothing jumps when they arrive. */
function KpiSkeleton({ progress }: { progress: { total: number; done: number } | null }) {
  return (
    <>
      <div className="overflow-hidden rounded-md border border-hairline bg-canvas">
        <div className="-mb-px -mr-px grid grid-cols-2 sm:grid-cols-kpis">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className={cn('p-3', CELL)}>
              <Skeleton className="h-4 w-20" />
              <Skeleton className="mt-1.5 h-7 w-16" />
              <Skeleton className="mt-1.5 h-4 w-24" />
            </div>
          ))}
        </div>
      </div>
      <p className="tnum text-caption text-muted">
        {progress && progress.total > 0
          ? `Loading post metrics — ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}`
          : 'Loading…'}
      </p>
    </>
  );
}

/** The chart card's frame for the states that have no chart to draw. */
function ChartFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="p-3">
      <h2 className="mb-2 text-body font-semibold text-ink">{title}</h2>
      {children}
    </Card>
  );
}

/**
 * The values behind a chart, as text: every platform/profile is listed, with "—" where it has
 * none. With a `color` per row it is also the chart's key, so the series is named beside its number.
 */
function ValueList({
  rows,
}: {
  rows: Array<{ key: string; label: string; value: ReactNode; color?: string }>;
}) {
  return (
    <ul className="mt-2 grid gap-x-6 text-sm sm:grid-cols-2">
      {rows.map((row) => (
        <li
          key={row.key}
          className="flex items-baseline justify-between gap-3 border-t border-hairline-soft py-1"
        >
          <span className="flex min-w-0 items-center gap-1.5 text-body-ink">
            {row.color !== undefined && (
              <span
                aria-hidden="true"
                className="h-0.5 w-3 flex-none"
                style={{ background: row.color || 'transparent' }}
              />
            )}
            <span className="truncate">{row.label}</span>
          </span>
          <span className="tnum flex-none font-semibold text-ink">{row.value}</span>
        </li>
      ))}
    </ul>
  );
}

const noValue = (why: string) => (
  <>
    <span aria-hidden="true" className="font-normal text-muted">
      —
    </span>
    <span className="sr-only">{why}</span>
  </>
);

/** One metric's period total per platform, or per profile once a platform is chosen. */
function ComparisonChart({
  metric,
  byProfile,
  connections,
  period,
  metrics,
  followers,
  windows,
}: {
  /** The metric picked in the filter bar; undefined when the period has none. */
  metric: string | undefined;
  byProfile: boolean;
  connections: ConnectionView[];
  period: PeriodPosts;
  metrics: MetricsByPost;
  followers: FollowersByConnection;
  windows: Windows;
}) {
  const heading = byProfile ? 'By profile' : 'By platform';
  if (metric === undefined) {
    return (
      <ChartFrame title={heading}>
        <EmptyState title="No metrics captured for this period yet" />
      </ChartFrame>
    );
  }
  const totals = groupTotals({
    metric,
    groupBy: byProfile ? 'connection' : 'platform',
    connections,
    posts: period.current,
    metrics,
    followers,
    windows,
  });
  const profiles = profileLabels(connections, false);
  const rows = totals.map((t) => ({
    ...t,
    label: byProfile ? (profiles.get(t.key) ?? t.key) : platformLabel(t.key),
  }));
  const label = humanizeMetric(metric);
  return (
    <Chart
      type="bar"
      title={`${label} by ${byProfile ? 'profile' : 'platform'}`}
      xKey="group"
      xLabel={byProfile ? 'Profile' : 'Platform'}
      data={rows.map((r) => ({ group: r.label, value: r.value }))}
      series={[{ key: 'value', label }]}
      footer={
        <ValueList
          rows={rows.map((r) => ({
            key: r.key,
            label: r.label,
            value: r.value === null ? noValue(`No ${label} for ${r.label}`) : formatValue(r.value),
          }))}
        />
      }
    />
  );
}

/** Followers per selected profile across the period, one line each. */
function FollowersChart({
  connections,
  withPlatform,
  followers,
  windows,
  days,
}: {
  connections: ConnectionView[];
  withPlatform: boolean;
  followers: FollowersByConnection;
  windows: Windows;
  days: number;
}) {
  const title = 'Followers over time';
  const labels = profileLabels(connections, withPlatform);
  const timeline = followerTimeline(
    connections.map((c) => ({ id: c.id, points: followers.get(c.id) ?? [] })),
    windows,
  );
  const charted = connections.filter((c) => timeline.coverage.get(c.id) === 'charted');
  if (charted.length === 0) {
    const noSeries = connections.every((c) => timeline.coverage.get(c.id) === 'none');
    const platforms = [...new Set(connections.map((c) => platformLabel(c.provider)))].join(', ');
    return (
      <ChartFrame title={title}>
        {noSeries ? (
          <EmptyState
            title={`No follower data for ${platforms}`}
            description="The platform may not report followers, or the first daily capture has not run yet."
          />
        ) : (
          <EmptyState
            title="No follower captures in this period"
            description="A longer date range may have data."
          />
        )}
      </ChartFrame>
    );
  }
  // The colour each charted profile is drawn in, so the list under the plot can be its key.
  const colorOf = new Map(charted.map((c, i) => [c.id, chartColor(i)]));
  return (
    <Chart
      type="line"
      title={title}
      xKey="day"
      xLabel="Day"
      data={timeline.rows}
      series={charted.map((c) => ({ key: c.id, label: labels.get(c.id) ?? c.displayName }))}
      dots={timeline.sparse || days <= 7}
      // The list below names every profile beside its colour and its latest number.
      legend={false}
      footer={
        <ValueList
          rows={connections.map((c) => {
            const coverage = timeline.coverage.get(c.id);
            const current = followerSnapshot(followers.get(c.id) ?? [], windows).current;
            return {
              key: c.id,
              label: labels.get(c.id) ?? c.displayName,
              // A profile with no line still takes the swatch's width, so the names line up.
              color: colorOf.get(c.id) ?? '',
              value: current
                ? formatValue(current.value)
                : noValue(
                    coverage === 'outside'
                      ? 'No follower captures in this period'
                      : 'No follower data',
                  ),
            };
          })}
        />
      }
    />
  );
}

const POST_COLUMNS = ['Published', 'Profile', 'Post'];

/** Same header and row geometry as the loaded table. */
function PostsTableSkeleton() {
  return (
    <Table
      caption="Posts published in this period (loading)"
      dense
      rows={[0, 1, 2, 3, 4]}
      rowKey={(n) => String(n)}
      columns={POST_COLUMNS.map((header) => ({
        key: header,
        header,
        cell: () => <Skeleton className="h-5 w-24" />,
      }))}
    />
  );
}

function MetricValue({ cell }: { cell: MetricCell }) {
  switch (cell.kind) {
    case 'value':
      return <span title={cell.value.toLocaleString()}>{compactNumber(cell.value)}</span>;
    case 'pending':
      // Still loading: a dash, never a 0 that could be read as a number.
      return (
        <span className="animate-pulse text-muted-soft">
          <span aria-hidden="true">—</span>
          <span className="sr-only">Loading</span>
        </span>
      );
    case 'error':
      return (
        <span className="text-status-bad" title={`Couldn't load metrics: ${cell.message}`}>
          <span aria-hidden="true">—</span>
          <span className="sr-only">Couldn’t load</span>
        </span>
      );
    case 'missing':
      return noValue('Not reported for this post');
  }
}

/**
 * The expanded row: each metric's capture history as a sparkline with its point count. The history
 * is one read per post, made only when its row is opened — the table itself runs on the bulk read.
 */
function PostHistory({ postId }: { postId: string }) {
  const [load, setLoad] = useState<Load<MetricPoint[]>>(LOADING);
  useEffect(() => {
    let stale = false;
    api
      .postMetrics(postId)
      .then((res) => {
        if (!stale) setLoad({ status: 'ok', data: parsePoints(res.series) });
      })
      .catch((e: unknown) => {
        if (!stale) setLoad({ status: 'error', message: errorText(e) });
      });
    return () => {
      stale = true;
    };
  }, [postId]);

  if (load.status === 'loading') return <p className="text-caption text-muted">Loading history…</p>;
  if (load.status === 'error') {
    return (
      <p className="text-caption text-status-bad">
        Couldn’t load the history for this post: {load.message}
      </p>
    );
  }
  const histories = metricHistories(load.data);
  if (histories.length === 0) {
    return <p className="text-caption text-muted">No captures for this post yet.</p>;
  }
  return (
    <ul className="grid gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-4">
      {histories.map(({ name, points, last }) => {
        const label = humanizeMetric(name);
        const first = points[0]!.value;
        const latest = points[points.length - 1]!.value;
        return (
          <li key={name} className="min-w-0">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-caption font-semibold text-muted" title={name}>
                {label}
              </span>
              <span className="tnum text-sm font-semibold text-ink">{formatValue(latest)}</span>
            </div>
            <Sparkline
              points={points}
              label={`${label}: ${formatValue(first)} at first capture, ${formatValue(latest)} at the latest`}
            />
            <p className="tnum text-micro text-muted">
              {points.length.toLocaleString()} {points.length === 1 ? 'capture' : 'captures'}, last{' '}
              <time dateTime={new Date(last).toISOString()}>{formatCapture(last)}</time>
            </p>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Published posts of the period, newest first, with one column per metric name the rows on screen
 * returned. Cells fill in as the bulk read that carries their post settles.
 */
function PostsTable({
  period,
  undated,
  metrics,
  connections,
}: {
  period: PeriodPosts;
  /** Published posts with no publish time, counted only when the period is empty; null = unknown. */
  undated: { count: number; atLeast: boolean } | null;
  metrics: MetricsByPost;
  connections: ConnectionView[];
}) {
  const [shown, setShown] = useState(TABLE_PAGE);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const rows = period.current.slice(0, shown);
  const names = tableMetricColumns(rows, metrics);
  const profiles = new Map(connections.map((c) => [c.id, c.displayName]));
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const columns: TableColumn<WindowedPost>[] = [
    {
      key: 'expand',
      header: <span className="sr-only">Metric history</span>,
      cell: ({ post }) => {
        const isOpen = open.has(post.id);
        const Caret = isOpen ? CaretDown : CaretRight;
        return (
          <button
            type="button"
            aria-expanded={isOpen}
            aria-label={`Metric history: ${captionSnippet(post.caption)}`}
            // The row click already toggles; without this the button would toggle twice.
            onClick={(e) => {
              e.stopPropagation();
              toggle(post.id);
            }}
            className="grid h-7 w-7 place-items-center rounded-sm text-muted hover:bg-surface-strong hover:text-ink"
          >
            <Caret size={14} weight="bold" aria-hidden="true" />
          </button>
        );
      },
    },
    {
      key: 'published',
      header: 'Published',
      className: 'whitespace-nowrap',
      cell: ({ at }) => (
        <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>
          {shortDateTime(new Date(at))}
        </time>
      ),
    },
    {
      key: 'profile',
      header: 'Profile',
      className: 'whitespace-nowrap',
      cell: ({ post }) => {
        const platform = platformMeta({ identifier: post.provider, displayName: post.provider });
        return (
          <span className="inline-flex items-center gap-2" title={platform.label}>
            <platform.Icon size={16} aria-hidden="true" className="flex-none text-muted" />
            <span className="sr-only">{platform.label}: </span>
            {profiles.get(post.connectionId) ?? noValue('Unknown profile')}
          </span>
        );
      },
    },
    {
      key: 'post',
      header: 'Post',
      className: 'w-full min-w-64',
      cell: ({ post }) => {
        const url = safeExternalUrl(post.releaseUrl);
        const text = captionSnippet(post.caption, 80);
        return (
          <span className="flex min-w-0 items-center gap-2">
            <PostThumb thumb={mediaThumb(post.media)} caption={post.caption} size="sm" />
            {url ? (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex min-w-0 items-baseline gap-1 text-body-ink underline"
              >
                <span className="line-clamp-1">{text}</span>
                <ArrowSquareOut size={14} aria-hidden="true" className="flex-none self-center" />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            ) : (
              <span className="line-clamp-1 text-body-ink">{text}</span>
            )}
          </span>
        );
      },
    },
    ...names.map((name): TableColumn<WindowedPost> => ({
      key: `metric:${name}`,
      // The provider's own name stays one hover away from its humanised label.
      header: <span title={name}>{humanizeMetric(name)}</span>,
      align: 'right',
      className: 'whitespace-nowrap',
      cell: ({ post }) => <MetricValue cell={metricCell(metrics.get(post.id), name)} />,
    })),
  ];

  return (
    <>
      <Table
        caption="Posts published in this period, newest first, with their latest metrics"
        dense
        stickyHeader
        rows={rows}
        rowKey={(row) => row.post.id}
        columns={columns}
        onRowClick={(row) => toggle(row.post.id)}
        renderExpanded={(row) =>
          open.has(row.post.id) ? <PostHistory postId={row.post.id} /> : null
        }
        empty={{
          title: 'No published posts in this period',
          description: emptyPeriodNote(undated),
          icon: Article,
        }}
      />
      {rows.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="tnum text-caption text-muted">
            Showing {rows.length.toLocaleString()} of {period.current.length.toLocaleString()}{' '}
            posts. Values are each post’s all-time totals as of its last capture.
          </p>
          {shown < period.current.length && (
            <Button variant="outline" size="sm" onClick={() => setShown((n) => n + TABLE_PAGE)}>
              Load more
            </Button>
          )}
        </div>
      )}
    </>
  );
}
