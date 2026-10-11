import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { ConnectionView, PostView } from '@meegrow-social/contracts';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { providerVisible } from '../lib/devProviders';
import { platformMeta } from '../lib/platforms';
import { formatPublishAt } from '../lib/postDate';
import { appendPage, captionSnippet, safeExternalUrl } from '../lib/postList';
import {
  FOLLOWERS,
  LIST_MAX_PAGES,
  LIST_PAGE,
  METRICS_CHUNK,
  POST_CAP,
  RANGE_DAYS,
  TABLE_PAGE,
  buildTiles,
  capPosts,
  chunk,
  connectionsFor,
  filtersToParams,
  followerSnapshot,
  followerTimeline,
  formatCapture,
  formatValue,
  groupTotals,
  humanizeMetric,
  lastCaptureByConnection,
  latestCapture,
  loadProgress,
  metricCell,
  metricHistories,
  needsReconnect,
  parseFilters,
  parsePoints,
  platformsOf,
  resolveFilters,
  selectedConnections,
  tableMetricColumns,
  uniqueLabels,
  windowPosts,
  windowsFor,
  type AnalyticsFilters,
  type CappedPosts,
  type FollowersByConnection,
  type MetricCell,
  type MetricPoint,
  type MetricsByPost,
  type PostMetrics,
  type RangeDays,
  type Tile,
  type WindowedPost,
  type Windows,
} from '../lib/analytics';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Chart } from '../components/ui/Chart';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { Label } from '../components/ui/Label';
import { PageHeader } from '../components/ui/PageHeader';
import { Select } from '../components/ui/Select';
import { Skeleton } from '../components/ui/Skeleton';
import { Sparkline } from '../components/ui/Sparkline';
import { StatTile } from '../components/ui/StatTile';
import { Table, type TableColumn } from '../components/ui/Table';
import { ArrowSquareOut, Article, CaretDown, CaretRight, ChartLineUp, Plugs } from '../lib/icons';

// Until the numbers are checked against the platforms (docs/dev/ANALYTICS-UI-BRIEF.md §7) the page is
// reachable by URL only and says so. The other read of this flag is the nav entry in AppLayout.
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

/** Every published post in the range. The API pages at 100 and returns no total. */
async function listPublished(query: {
  provider?: string;
  connectionId?: string;
  from: string;
  to: string;
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
 * period and the one before it, each post's metrics (one request per post, in chunks, capped) and
 * each selected connection's follower series. Per-post and per-connection results are kept across
 * filter changes, so narrowing a view costs no new requests.
 */
function useAnalyticsData(raw: AnalyticsFilters) {
  const [run, setRun] = useState(() => ({ attempt: 0, now: Date.now() }));
  // Results that land after a retry belong to the run before it and are dropped.
  const liveAttempt = useRef(0);

  const [connections, setConnections] = useState<Load<ConnectionView[]>>(LOADING);
  const [postList, setPostList] = useState<{ key: string; load: Load<PostList> }>({
    key: '',
    load: LOADING,
  });
  const metricsCache = useRef(new Map<string, PostMetrics>());
  const [metrics, setMetrics] = useState<MetricsByPost>(metricsCache.current);
  const followersCache = useRef(new Map<string, FollowerLoad>());
  const [followerLoads, setFollowerLoads] = useState<ReadonlyMap<string, FollowerLoad>>(
    followersCache.current,
  );

  const retry = () => {
    liveAttempt.current += 1;
    metricsCache.current = new Map();
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

  const capped = useMemo(
    () => (posts.status === 'ok' ? capPosts(windowPosts(posts.data.posts, windows)) : null),
    [posts, windows],
  );

  useEffect(() => {
    if (!capped) return;
    const attempt = run.attempt;
    let stale = false;
    const missing = [...capped.current, ...capped.prior]
      .map((p) => p.post.id)
      .filter((id) => !metricsCache.current.has(id));
    void (async () => {
      for (const ids of chunk(missing, METRICS_CHUNK)) {
        if (stale) return;
        const settled = await Promise.all(
          ids.map(async (id): Promise<[string, PostMetrics]> => {
            try {
              const res = await api.postMetrics(id);
              return [id, { status: 'ok', latest: res.latest, series: parsePoints(res.series) }];
            } catch (e) {
              // One post failing marks its row, not the table.
              return [id, { status: 'error', message: errorText(e) }];
            }
          }),
        );
        if (liveAttempt.current !== attempt) return;
        metricsCache.current = new Map([...metricsCache.current, ...settled]);
        setMetrics(metricsCache.current);
      }
    })();
    return () => {
      stale = true;
    };
  }, [capped, run.attempt]);

  const selectedIds = selected.map((c) => c.id).join(',');
  useEffect(() => {
    if (!selectedIds) return;
    const attempt = run.attempt;
    const missing = selectedIds.split(',').filter((id) => !followersCache.current.has(id));
    for (const ids of chunk(missing, METRICS_CHUNK)) {
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
    all,
    filters,
    selected,
    windows,
    posts,
    capped,
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
  const { connections, all, filters, selected, windows, posts, capped, metrics, followers } = data;

  const workspace = me?.user.memberships.find((m) => m.workspaceId === me.activeWorkspaceId);
  const setFilters = (patch: Partial<AnalyticsFilters>) =>
    setParams(filtersToParams(resolveFilters({ ...filters, ...patch }, all)), { replace: true });

  const loaded = useMemo(() => (capped ? [...capped.current, ...capped.prior] : []), [capped]);
  const progress = useMemo(() => loadProgress(loaded, metrics), [loaded, metrics]);
  const metricsSettled = capped !== null && progress.done === progress.total;
  const lastByConnection = useMemo(
    () => lastCaptureByConnection(loaded, metrics, data.followersSoFar),
    [loaded, metrics, data.followersSoFar],
  );

  const sectionError =
    posts.status === 'error'
      ? posts.message
      : followers.status === 'error'
        ? followers.message
        : null;
  const settled = capped !== null && metricsSettled && followers.status === 'ok';
  const tiles = useMemo(
    () =>
      capped && followers.status === 'ok' && metricsSettled
        ? buildTiles(capped, metrics, followers.data.values(), windows)
        : [],
    [capped, followers, metricsSettled, metrics, windows],
  );
  const nothingYet =
    capped !== null &&
    capped.currentTotal === 0 &&
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
      className="mb-0"
      actions={!VALIDATED && <Badge variant="neutral">Preview — numbers not yet validated</Badge>}
    />
  );

  if (connections.status === 'error') {
    return (
      <div className="space-y-4">
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
      <div className="space-y-4">
        {header}
        <EmptyState
          title="Connect an account to start collecting analytics."
          icon={Plugs}
          action={
            <Button asChild>
              <Link to="/connections">Connect an account</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const booting = connections.status === 'loading';

  return (
    <div className="space-y-4">
      {header}

      <Filters
        filters={filters}
        connections={all}
        disabled={booting}
        onChange={setFilters}
        windows={windows}
      />

      <SyncLine
        asOf={latestCapture(lastByConnection)}
        settled={settled}
        stale={selected.filter(needsReconnect)}
        lastByConnection={lastByConnection}
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
          description="Metrics appear within an hour of the first published post. A longer date range may have data."
          icon={ChartLineUp}
        />
      ) : (
        <>
          <section aria-label="Totals" className="space-y-2">
            {sectionError ? (
              <ErrorState
                title="Couldn't load totals"
                message={sectionError}
                onRetry={data.retry}
              />
            ) : !settled || !capped ? (
              <TilesSkeleton progress={capped ? progress : null} />
            ) : (
              <Tiles
                tiles={tiles}
                days={filters.days}
                capped={capped}
                failed={progress.failed}
                truncated={posts.status === 'ok' && posts.data.truncated}
              />
            )}
          </section>

          <section aria-label="Charts" className="grid gap-4 lg:grid-cols-2">
            {sectionError ? (
              <ChartFrame title="By platform">
                <ErrorState
                  title="Couldn't load this chart"
                  message={sectionError}
                  onRetry={data.retry}
                />
              </ChartFrame>
            ) : !settled || !capped || followers.status !== 'ok' ? (
              <ChartFrame title="By platform">
                <Skeleton className="h-64 w-full" />
              </ChartFrame>
            ) : (
              <ComparisonChart
                names={tiles.map((t) => t.name)}
                byProfile={filters.platform !== ''}
                connections={selected}
                capped={capped}
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
                <Skeleton className="h-64 w-full" />
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
            ) : !capped ? (
              <PostsTableSkeleton />
            ) : (
              <PostsTable
                // A new filter set starts again from the first page with every row collapsed.
                key={`${filters.platform}|${filters.connection}|${filters.days}`}
                capped={capped}
                metrics={metrics}
                connections={all}
              />
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Filters({
  filters,
  connections,
  disabled,
  onChange,
  windows,
}: {
  filters: AnalyticsFilters;
  connections: ConnectionView[];
  disabled: boolean;
  onChange: (patch: Partial<AnalyticsFilters>) => void;
  windows: Windows;
}) {
  const period = `${new Date(windows.start).toLocaleDateString()} – ${new Date(windows.end).toLocaleDateString()}`;
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="space-y-1.5">
        <Label htmlFor="analytics-platform">Platform</Label>
        <Select
          id="analytics-platform"
          value={filters.platform}
          disabled={disabled}
          onChange={(e) => onChange({ platform: e.target.value })}
          className="w-48"
        >
          <option value="">All platforms</option>
          {platformsOf(connections).map((provider) => (
            <option key={provider} value={provider}>
              {platformLabel(provider)}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="analytics-profile">Profile</Label>
        <Select
          id="analytics-profile"
          value={filters.connection}
          disabled={disabled}
          onChange={(e) => onChange({ connection: e.target.value })}
          className="w-56"
        >
          <option value="">All profiles</option>
          {connectionsFor(connections, filters.platform).map((c) => (
            <option key={c.id} value={c.id}>
              {/* Without a platform filter two accounts can share a name, so the platform is spelled out. */}
              {filters.platform ? c.displayName : `${c.displayName} · ${platformLabel(c.provider)}`}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="analytics-days">Date range</Label>
        <Select
          id="analytics-days"
          value={filters.days}
          disabled={disabled}
          onChange={(e) => onChange({ days: Number(e.target.value) as RangeDays })}
          className="w-40"
        >
          {RANGE_DAYS.map((days) => (
            <option key={days} value={days}>
              Last {days} days
            </option>
          ))}
        </Select>
      </div>
      <p className="tnum pb-2.5 text-caption text-muted">{period}</p>
    </div>
  );
}

/**
 * When the data was last captured. The cadence is static text: the API exposes neither the last nor
 * the next sync, so the newest capture among what is loaded is the only honest "as of".
 */
function SyncLine({
  asOf,
  settled,
  stale,
  lastByConnection,
}: {
  asOf: number | null;
  settled: boolean;
  stale: ConnectionView[];
  lastByConnection: ReadonlyMap<string, number>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <p className="tnum text-caption text-muted">
        {asOf !== null ? (
          <>
            Data as of <time dateTime={new Date(asOf).toISOString()}>{formatCapture(asOf)}</time>
          </>
        ) : settled ? (
          'No data collected yet'
        ) : (
          'Loading…'
        )}
        {' · posts refresh hourly for 48 h then daily · followers daily'}
      </p>
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
      {stale.length > 0 && (
        <Link to="/connections" className="text-caption font-semibold text-ink underline">
          Reconnect
        </Link>
      )}
    </div>
  );
}

const TILE_HINT = 'Posts published in the period, all-time totals';
const FOLLOWERS_HINT = 'Latest capture in the period, summed across the selected profiles';

function Tiles({
  tiles,
  days,
  capped,
  failed,
  truncated,
}: {
  tiles: Tile[];
  days: number;
  capped: CappedPosts;
  failed: number;
  truncated: boolean;
}) {
  if (tiles.length === 0) {
    return (
      <EmptyState
        title="No metrics captured for this period yet"
        description="Posts are checked hourly for their first 48 hours, then daily."
      />
    );
  }
  const overCap = capped.currentTotal > capped.current.length;
  return (
    <>
      <div className="grid grid-cols-tiles gap-3">
        {tiles.map((tile) => (
          <StatTile
            key={tile.name}
            label={humanizeMetric(tile.name)}
            value={formatValue(tile.value)}
            delta={tile.delta}
            deltaLabel={`vs prior ${days} days`}
            showMissingDelta
            hint={tile.name === FOLLOWERS ? FOLLOWERS_HINT : TILE_HINT}
          />
        ))}
      </div>
      {/* The definitions are also on hover, but hover alone is not reachable by keyboard or touch. */}
      <p className="text-caption text-muted">
        Post metrics add up the all-time totals of posts published in the period, so an older post
        counts everything it has gathered since. Followers is the latest capture in the period.
      </p>
      {overCap && (
        <p className="text-caption font-semibold text-status-warn">
          Showing the newest {capped.current.length.toLocaleString()} of{' '}
          {capped.currentTotal.toLocaleString()} posts published in this period — totals cover those
          only.
        </p>
      )}
      {!overCap && !capped.priorComplete && (
        <p className="text-caption text-muted">
          The prior period has more posts than the {POST_CAP}-post limit can load, so post metrics
          show no change vs prior.
        </p>
      )}
      {failed > 0 && (
        <p className="text-caption font-semibold text-status-warn">
          Metrics for {failed.toLocaleString()} {failed === 1 ? 'post' : 'posts'} could not be
          loaded — totals leave them out and show no change vs prior.
        </p>
      )}
      {truncated && (
        <p className="text-caption font-semibold text-status-warn">
          There are more published posts in this range than could be listed; the newest may be
          missing.
        </p>
      )}
    </>
  );
}

/** Same box geometry as the loaded tiles, so nothing jumps when the numbers arrive. */
function TilesSkeleton({ progress }: { progress: { total: number; done: number } | null }) {
  return (
    <>
      <div className="grid grid-cols-tiles gap-3">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="rounded-md border border-hairline bg-canvas p-4">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="mt-1 h-8 w-20" />
            <Skeleton className="mt-1 h-5 w-28" />
          </div>
        ))}
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
    <Card className="p-4">
      <h2 className="mb-3 text-body font-semibold text-ink">{title}</h2>
      {children}
    </Card>
  );
}

/** The values behind a chart, as text: every platform/profile is listed, with "—" where it has none. */
function ValueList({ rows }: { rows: Array<{ key: string; label: string; value: ReactNode }> }) {
  return (
    <ul className="mt-3 divide-y divide-hairline-soft text-sm">
      {rows.map((row) => (
        <li key={row.key} className="flex items-baseline justify-between gap-3 py-1.5">
          <span className="min-w-0 truncate text-body-ink">{row.label}</span>
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
  names,
  byProfile,
  connections,
  capped,
  metrics,
  followers,
  windows,
}: {
  names: string[];
  byProfile: boolean;
  connections: ConnectionView[];
  capped: CappedPosts;
  metrics: MetricsByPost;
  followers: FollowersByConnection;
  windows: Windows;
}) {
  const [picked, setPicked] = useState('');
  const metric = names.includes(picked) ? picked : names[0];
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
    posts: capped.current,
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
      actions={
        <Select
          aria-label="Metric to compare"
          value={metric}
          onChange={(e) => setPicked(e.target.value)}
          className="h-9 w-48 text-sm"
        >
          {names.map((name) => (
            <option key={name} value={name}>
              {humanizeMetric(name)}
            </option>
          ))}
        </Select>
      }
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
  return (
    <Chart
      type="line"
      title={title}
      xKey="day"
      xLabel="Day"
      data={timeline.rows}
      series={charted.map((c) => ({ key: c.id, label: labels.get(c.id) ?? c.displayName }))}
      dots={timeline.sparse || days <= 30}
      footer={
        <ValueList
          rows={connections.map((c) => {
            const coverage = timeline.coverage.get(c.id);
            const current = followerSnapshot(followers.get(c.id) ?? [], windows).current;
            return {
              key: c.id,
              label: labels.get(c.id) ?? c.displayName,
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

const POST_COLUMNS = ['Published', 'Platform', 'Profile', 'Post'];

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
      return <>{formatValue(cell.value)}</>;
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

/** The expanded row: each metric's capture history as a sparkline with its point count. */
function PostHistory({ entry }: { entry: PostMetrics | undefined }) {
  if (!entry) return <p className="text-caption text-muted">Loading metrics…</p>;
  if (entry.status === 'error') {
    return (
      <p className="text-caption text-status-bad">
        Couldn’t load metrics for this post: {entry.message}
      </p>
    );
  }
  const histories = metricHistories(entry.series);
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
 * returned. Rows fill in as their metrics request settles.
 */
function PostsTable({
  capped,
  metrics,
  connections,
}: {
  capped: CappedPosts;
  metrics: MetricsByPost;
  connections: ConnectionView[];
}) {
  const [shown, setShown] = useState(TABLE_PAGE);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const rows = capped.current.slice(0, shown);
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
      cell: ({ post, at }) => (
        <time dateTime={new Date(at).toISOString()}>{formatPublishAt(post.publishAt)}</time>
      ),
    },
    {
      key: 'platform',
      header: 'Platform',
      className: 'whitespace-nowrap',
      cell: ({ post }) => {
        const platform = platformMeta({ identifier: post.provider, displayName: post.provider });
        return (
          <span className="inline-flex items-center gap-2">
            <platform.Icon size={18} aria-hidden="true" className="flex-none text-muted" />
            {platform.label}
          </span>
        );
      },
    },
    {
      key: 'profile',
      header: 'Profile',
      className: 'whitespace-nowrap',
      cell: ({ post }) => profiles.get(post.connectionId) ?? noValue('Unknown profile'),
    },
    {
      key: 'post',
      header: 'Post',
      className: 'w-full min-w-64',
      cell: ({ post }) => {
        const url = safeExternalUrl(post.releaseUrl);
        const text = captionSnippet(post.caption, 80);
        return url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-baseline gap-1 text-body-ink underline"
          >
            {text}
            <ArrowSquareOut size={14} aria-hidden="true" className="flex-none self-center" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        ) : (
          <span className="text-body-ink">{text}</span>
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
          open.has(row.post.id) ? <PostHistory entry={metrics.get(row.post.id)} /> : null
        }
        empty={{
          title: 'No published posts in this period',
          description: 'A longer date range may have some.',
          icon: Article,
        }}
      />
      {rows.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="tnum text-caption text-muted">
            Showing {rows.length.toLocaleString()} of {capped.current.length.toLocaleString()} posts
            {capped.currentTotal > capped.current.length &&
              ` — only the newest ${capped.current.length.toLocaleString()} of ${capped.currentTotal.toLocaleString()} in this period are loaded`}
            . Values are each post’s all-time totals as of its last capture.
          </p>
          {shown < capped.current.length && (
            <Button variant="outline" size="sm" onClick={() => setShown((n) => n + TABLE_PAGE)}>
              Load more
            </Button>
          )}
        </div>
      )}
    </>
  );
}
