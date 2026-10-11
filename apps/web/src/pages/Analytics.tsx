import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { ConnectionView, PostView } from '@meegrow-social/contracts';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { providerVisible } from '../lib/devProviders';
import { platformMeta } from '../lib/platforms';
import { appendPage } from '../lib/postList';
import {
  FOLLOWERS,
  LIST_MAX_PAGES,
  LIST_PAGE,
  METRICS_CHUNK,
  POST_CAP,
  RANGE_DAYS,
  buildTiles,
  capPosts,
  chunk,
  connectionsFor,
  filtersToParams,
  formatCapture,
  formatValue,
  humanizeMetric,
  lastCaptureByConnection,
  latestCapture,
  loadProgress,
  needsReconnect,
  parseFilters,
  parsePoints,
  platformsOf,
  resolveFilters,
  selectedConnections,
  windowPosts,
  windowsFor,
  type AnalyticsFilters,
  type CappedPosts,
  type FollowersByConnection,
  type MetricPoint,
  type MetricsByPost,
  type PostMetrics,
  type RangeDays,
  type Tile,
  type Windows,
} from '../lib/analytics';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { Label } from '../components/ui/Label';
import { PageHeader } from '../components/ui/PageHeader';
import { Select } from '../components/ui/Select';
import { Skeleton } from '../components/ui/Skeleton';
import { StatTile } from '../components/ui/StatTile';
import { ChartLineUp, Plugs } from '../lib/icons';

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
        <section aria-label="Totals" className="space-y-2">
          {sectionError ? (
            <ErrorState title="Couldn't load totals" message={sectionError} onRetry={data.retry} />
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
