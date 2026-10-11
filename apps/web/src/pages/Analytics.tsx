import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { AnalyticsStatusView, ConnectionView, MetricConcept } from '@meegrow-social/contracts';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { cn } from '../lib/cn';
import { cadenceText, isClientRole, nextRefresh } from '../lib/analytics';
import {
  RANGE_DAYS,
  browserTimezone,
  conceptsInView,
  dayInput,
  parseReportFilters,
  platformsOf,
  reportFiltersToParams,
  reportQuery,
  resolveReportFilters,
  type RangeKey,
  type Report,
  type ReportFilters,
} from '../lib/analyticsReport';
import { ChartLineUp, Plugs } from '../lib/icons';
import { shortDateTime } from '../lib/postGroups';
import { importingAnalyticsNote } from '../lib/postImport';
import {
  BestTimes,
  BreakdownCharts,
  ConceptCharts,
  EngagementAccumulation,
  EngagementTrend,
  FollowerEvolution,
  FormatBreakdown,
  FrequencyVsEngagement,
} from '../components/analytics/Charts';
import { KpiSkeleton, Kpis } from '../components/analytics/Kpis';
import { platformLabel } from '../components/analytics/parts';
import { PlatformTable, RawMetrics, TopPosts } from '../components/analytics/Tables';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { FilterBar, FilterSelect } from '../components/ui/FilterBar';
import { PageHeader } from '../components/ui/PageHeader';
import { Skeleton } from '../components/ui/Skeleton';

// The page is in the sidebar for everyone, but its numbers have not been checked against the
// platforms yet (docs/dev/ANALYTICS-UI-BRIEF.md §7), so it says so. Setting VITE_ANALYTICS_UI=true at
// build time records that sign-off and drops the badge; this is the only read of the flag.
const VALIDATED = import.meta.env.VITE_ANALYTICS_UI === 'true';

const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Please try again.');

type Load<T> =
  { status: 'loading' } | { status: 'ok'; data: T } | { status: 'error'; message: string };
const LOADING = { status: 'loading' } as const;

/**
 * Everything the screen shows, in one read per filter set (`GET /v1/analytics/report`), plus when
 * the data was last collected. The report on screen stays up while the next one loads, so changing
 * a filter dims the page instead of collapsing it to a skeleton.
 */
function useAnalytics(filters: ReportFilters, timezone: string) {
  const [run, setRun] = useState(() => ({ attempt: 0, now: Date.now() }));
  const query = useMemo(
    () => reportQuery(filters, timezone, new Date(run.now)),
    [filters, timezone, run.now],
  );
  const key = `${run.attempt}|${JSON.stringify(query)}`;
  const [fetched, setFetched] = useState<{ key: string; load: Load<Report> }>({
    key: '',
    load: LOADING,
  });
  const [shown, setShown] = useState<Report | null>(null);
  const [status, setStatus] = useState<Load<AnalyticsStatusView>>(LOADING);
  const [connections, setConnections] = useState<ConnectionView[]>([]);

  useEffect(() => {
    let stale = false;
    api
      .analyticsReport(query)
      .then((data) => {
        if (stale) return;
        setFetched({ key, load: { status: 'ok', data } });
        setShown(data);
      })
      .catch((e: unknown) => {
        if (!stale) setFetched({ key, load: { status: 'error', message: errorText(e) } });
      });
    return () => {
      stale = true;
    };
  }, [key, query]);

  // When the numbers were last collected and when the next collection falls due, and whether an
  // import is still filling the account. A failure here costs a line of text, never the page.
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
    api
      .listConnections()
      .then((res) => {
        if (!stale) setConnections(res.connections);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [run.attempt]);

  const load: Load<Report> = fetched.key === key ? fetched.load : LOADING;
  return {
    load,
    /** The newest report that arrived — possibly for the previous filters while `load` is loading. */
    report: load.status === 'ok' ? load.data : load.status === 'loading' ? shown : null,
    status,
    connections,
    now: run.now,
    retry: () => setRun((r) => ({ attempt: r.attempt + 1, now: Date.now() })),
  };
}

/** Analytics: how a client's published posts and connected accounts are performing. */
export function Analytics() {
  const { me } = useAuth();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => parseReportFilters(params), [params]);
  const timezone = useMemo(browserTimezone, []);
  const data = useAnalytics(filters, timezone);
  const { load, report } = data;

  const workspace = me?.user.memberships.find((m) => m.workspaceId === me.activeWorkspaceId);
  // Clients see the same numbers without operator affordances. Cosmetic until #20 enforces the
  // role at the API.
  const isClient = isClientRole(workspace?.role);
  const manyClients = (me?.user.memberships.length ?? 0) > 1 && !isClient;
  const all = filters.scope === 'all';

  // The concept the second pair of charts shows. Kept in the URL beside the filters; a name the
  // view does not have (a stale link) falls back to the first one it does.
  const wantedConcept = params.get('metric') ?? '';
  const write = (next: ReportFilters, concept: string) => {
    const out = reportFiltersToParams(next);
    if (concept) out.set('metric', concept);
    setParams(out, { replace: true });
  };
  const accounts = report?.accounts ?? [];
  const setFilters = (patch: Partial<ReportFilters>) =>
    write(resolveReportFilters({ ...filters, ...patch }, accounts), wantedConcept);

  // A link that names a platform or account this view does not have is corrected once the
  // accounts are known, instead of showing an empty screen for a filter nobody can see.
  const loaded = load.status === 'ok' ? load.data : null;
  useEffect(() => {
    if (!loaded) return;
    const resolved = resolveReportFilters(filters, loaded.accounts);
    if (resolved.platform !== filters.platform || resolved.connection !== filters.connection) {
      write(resolved, wantedConcept);
    }
  }, [loaded]);

  const { shown: concepts, absent } = useMemo(
    () => conceptsInView(report?.mapping ?? []),
    [report],
  );
  const concept = (
    concepts.includes(wantedConcept as MetricConcept)
      ? wantedConcept
      : concepts.includes('likes')
        ? 'likes'
        : concepts[0]
  ) as MetricConcept | undefined;

  const header = (
    <PageHeader
      title="Analytics"
      subtitle={
        all
          ? 'Published posts and connected accounts across every client you can see.'
          : workspace
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

  if (load.status === 'error') {
    return (
      <div>
        {header}
        <ErrorState title="Couldn't load analytics" message={load.message} onRetry={data.retry} />
      </div>
    );
  }

  if (loaded && loaded.accounts.length === 0) {
    return (
      <div>
        {header}
        {manyClients && (
          <FilterBar
            filters={
              <ScopeSelect
                scope={filters.scope}
                name={workspace?.name}
                onChange={(scope) => setFilters({ scope })}
              />
            }
          />
        )}
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

  const periodDays = report
    ? Math.round(
        (new Date(report.period.end).getTime() - new Date(report.period.start).getTime()) /
          86_400_000,
      )
    : Number(filters.range) || 0;
  const rangeText = report
    ? `${new Date(report.period.start).toLocaleDateString()} – ${new Date(report.period.end).toLocaleDateString()}`
    : '';
  const importing = all ? null : importingAnalyticsNote(data.connections);
  const nothingYet =
    report !== null && report.summary.posts.value === 0 && report.summary.followers.value === null;
  const customDefault = (): Pick<ReportFilters, 'from' | 'to'> => ({
    from: dayInput(new Date(data.now - (Number(filters.range) || 30) * 86_400_000)),
    to: dayInput(new Date(data.now)),
  });

  return (
    <div>
      {header}

      <FilterBar
        className="mb-2"
        filters={
          <>
            {manyClients && (
              <ScopeSelect
                scope={filters.scope}
                name={workspace?.name}
                onChange={(scope) => setFilters({ scope })}
              />
            )}
            <FilterSelect
              label="Platform"
              value={filters.platform}
              onChange={(v) => setFilters({ platform: v })}
              options={[
                { value: '', label: 'All platforms' },
                ...platformsOf(accounts).map((p) => ({ value: p, label: platformLabel(p) })),
              ]}
            />
            <FilterSelect
              label="Account"
              value={filters.connection}
              onChange={(v) => setFilters({ connection: v })}
              options={[
                { value: '', label: 'All accounts' },
                ...accounts
                  .filter((a) => filters.platform === '' || a.provider === filters.platform)
                  .map((a) => ({
                    value: a.id,
                    // Two accounts can share a name: the platform (and the client) tell them apart.
                    label: [
                      a.displayName,
                      filters.platform ? null : platformLabel(a.provider),
                      all ? a.workspaceName : null,
                    ]
                      .filter(Boolean)
                      .join(' · '),
                  })),
              ]}
            />
            <FilterSelect
              label="Source"
              value={filters.source}
              onChange={(v) => setFilters({ source: v as ReportFilters['source'] })}
              options={[
                { value: '', label: 'All sources' },
                { value: 'app', label: 'Published here' },
                { value: 'imported', label: 'Imported' },
              ]}
            />
            <FilterSelect
              label="Period"
              value={filters.range}
              onChange={(v) =>
                setFilters(
                  v === 'custom'
                    ? { range: 'custom', ...customDefault() }
                    : { range: v as RangeKey, from: '', to: '' },
                )
              }
              // The default first, so the pill reads as "no filter" until the period is changed.
              options={[
                ...[30, ...RANGE_DAYS.filter((d) => d !== 30)].map((days) => ({
                  value: String(days),
                  label: `Last ${days} days`,
                })),
                { value: 'custom', label: 'Custom range' },
              ]}
            />
            {filters.range === 'custom' && (
              <>
                <DateInput
                  label="From"
                  value={filters.from}
                  max={filters.to}
                  onChange={(from) => from && from <= filters.to && setFilters({ from })}
                />
                <DateInput
                  label="To"
                  value={filters.to}
                  min={filters.from}
                  max={dayInput(new Date(data.now))}
                  onChange={(to) => to && to >= filters.from && setFilters({ to })}
                />
              </>
            )}
          </>
        }
        actions={
          <p className="tnum text-caption text-muted">
            {rangeText}
            <span className="hidden sm:inline"> · times in {timezone}</span>
          </p>
        }
      />

      <SyncLine
        status={data.status}
        now={data.now}
        all={all}
        report={report}
        canReconnect={!isClient}
      />

      {/* Announces load progress and filter results to screen readers. */}
      <p role="status" className="sr-only">
        {load.status === 'loading'
          ? 'Loading analytics'
          : report
            ? `Analytics for ${report.summary.posts.value ?? 0} posts published in the period`
            : ''}
      </p>

      {!report ? (
        <PageSkeleton />
      ) : nothingYet ? (
        <EmptyState
          // A newly connected account is not empty, it is still arriving.
          title={importing ? 'Importing past posts…' : 'Nothing collected for this period'}
          description={
            importing ??
            (report.summary.undatedPosts > 0
              ? undatedNote(report.summary.undatedPosts)
              : 'No post was published in it and no follower count was captured. Metrics appear within an hour of the first published post; a longer period may have data.')
          }
          icon={ChartLineUp}
        />
      ) : (
        <div
          aria-busy={load.status === 'loading'}
          className={cn('space-y-3 transition-opacity', load.status === 'loading' && 'opacity-60')}
        >
          <Kpis
            report={report}
            periodText={`the ${periodDays} ${periodDays === 1 ? 'day' : 'days'} before`}
          />
          {report.summary.undatedPosts > 0 && (
            <p className="text-caption text-muted">{undatedNote(report.summary.undatedPosts)}</p>
          )}
          {importing && <p className="text-caption font-semibold text-status-warn">{importing}</p>}
          <BreakdownCharts report={report} pick="posts" />
          <ConceptCharts
            report={report}
            concepts={concepts}
            concept={concept}
            onConcept={(c) => write(filters, c === 'likes' ? '' : c)}
          />
          <EngagementTrend report={report} concepts={concepts} />
          <div className="grid gap-3 lg:grid-cols-2">
            <BestTimes report={report} />
            <FollowerEvolution report={report} />
          </div>
          <FormatBreakdown report={report} />
          <PlatformTable report={report} concepts={concepts} absent={absent} />
          <TopPosts
            // A new filter set starts again from the first rows.
            key={params.toString()}
            report={report}
            concepts={concepts}
            absent={absent}
          />
          <div className="grid gap-3 lg:grid-cols-2">
            <FrequencyVsEngagement report={report} />
            <EngagementAccumulation report={report} />
          </div>
          <RawMetrics report={report} />
        </div>
      )}
    </div>
  );
}

const undatedNote = (count: number) =>
  `${count.toLocaleString()} published ${count === 1 ? 'post has' : 'posts have'} no recorded publish time, so ${count === 1 ? 'it falls' : 'they fall'} in no period and ${count === 1 ? 'is' : 'are'} in none of these numbers.`;

function ScopeSelect({
  scope,
  name,
  onChange,
}: {
  scope: ReportFilters['scope'];
  name: string | undefined;
  onChange: (scope: ReportFilters['scope']) => void;
}) {
  return (
    <FilterSelect
      label="Client"
      value={scope}
      onChange={(v) => onChange(v as ReportFilters['scope'])}
      options={[
        { value: 'workspace', label: name ?? 'This client' },
        { value: 'all', label: 'All clients' },
      ]}
    />
  );
}

/** A date pill of a custom period, sized like the filter pills beside it. */
function DateInput({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: string;
  min?: string;
  max?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="inline-flex items-center gap-1.5 text-caption text-muted">
      {label}
      <input
        type="date"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(e.target.value)}
        className="tnum h-11 rounded-full border border-ink bg-surface-strong px-3 text-lg font-medium text-ink focus:outline-none focus:ring-1 focus:ring-ink md:h-8 md:text-sm"
      />
    </label>
  );
}

/**
 * When the data was last collected and when the next collection falls due — facts from
 * `GET /v1/analytics/status` for the client in view, with the collection rules worded from the
 * cadence it reports. Across all clients there is no single schedule, so only the newest capture
 * the report read is stated.
 */
function SyncLine({
  status,
  now,
  all,
  report,
  canReconnect,
}: {
  status: Load<AnalyticsStatusView>;
  now: number;
  all: boolean;
  report: Report | null;
  canReconnect: boolean;
}) {
  const at = (ms: number) => (
    <time dateTime={new Date(ms).toISOString()}>{shortDateTime(new Date(ms), new Date(now))}</time>
  );
  let line: ReactNode;
  if (all) {
    const last = report?.summary.lastCapturedAt;
    line = !report ? (
      'Checking when data was last collected…'
    ) : last ? (
      <>Newest data in this view: {at(new Date(last).getTime())}</>
    ) : (
      'No data collected yet'
    );
  } else if (status.status === 'loading') line = 'Checking when data was last collected…';
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
  const stale = (report?.accounts ?? []).filter((a) => a.selected && a.needsReconnect);
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <p className="tnum text-caption text-muted">{line}</p>
      {stale.map((a) => (
        <Badge key={a.id} variant="warning" className="text-left">
          {a.displayName} needs reconnecting — its numbers have stopped updating
        </Badge>
      ))}
      {canReconnect && stale.length > 0 && (
        <Link to="/connections" className="text-caption font-semibold text-ink underline">
          Reconnect
        </Link>
      )}
    </div>
  );
}

/** The loaded page's blocks at their sizes, so nothing jumps when the report arrives. */
function PageSkeleton() {
  const card = 'rounded-md border border-hairline p-3';
  return (
    <div className="space-y-3" aria-hidden="true">
      <KpiSkeleton />
      {[0, 1].map((row) => (
        <div key={row} className="grid gap-3 lg:grid-cols-2">
          {[0, 1].map((col) => (
            <div key={col} className={card}>
              <Skeleton className="h-5 w-40" />
              <Skeleton className="mt-3 h-56 w-full" />
            </div>
          ))}
        </div>
      ))}
      <div className={card}>
        <Skeleton className="h-5 w-48" />
        <Skeleton className="mt-3 h-56 w-full" />
      </div>
      <div className={card}>
        <Skeleton className="h-5 w-48" />
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="mt-2 h-8 w-full" />
        ))}
      </div>
    </div>
  );
}
