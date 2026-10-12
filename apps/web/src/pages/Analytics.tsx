import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { AnalyticsStatusView, ConnectionView, MetricConcept } from '@meegrow-social/contracts';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { cn } from '../lib/cn';
import { isClientRole } from '../lib/analytics';
import {
  RANGE_DAYS,
  browserTimezone,
  conceptsInView,
  formatRate,
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
import { Plugs } from '../lib/icons';
import { importingAnalyticsNote } from '../lib/postImport';
import {
  Insights,
  PlatformSplit,
  type TrendMetric,
  BestTimes,
  EngagementAccumulation,
  PublishTrend,
  FollowerEvolution,
  FormatBreakdown,
  FrequencyVsEngagement,
} from '../components/analytics/Charts';
import { KpiSkeleton, Kpis } from '../components/analytics/Kpis';
import { platformColor } from '../lib/platforms';
import { platformLabel } from '../components/analytics/parts';
import { PlatformTable, RawMetrics, TopPosts } from '../components/analytics/Tables';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { FilterBar, FilterSelect } from '../components/ui/FilterBar';
import { PageHeader } from '../components/ui/PageHeader';
import { Skeleton } from '../components/ui/Skeleton';

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
    wantedConcept === 'rate'
      ? 'rate'
      : concepts.includes(wantedConcept as MetricConcept)
        ? wantedConcept
        : wantedConcept === 'posts'
          ? 'posts'
          : concepts.includes('views')
            ? 'views'
            : concepts.includes('likes')
              ? 'likes'
              : 'posts'
  ) as TrendMetric;

  const header = (
    <PageHeader
      title="Analytics"
      subtitle={all ? 'All clients' : (workspace?.name ?? 'This client')}
      actions={<Badge variant="neutral">Preview — numbers not yet validated</Badge>}
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

  const importing = all ? null : importingAnalyticsNote(data.connections);
  const customDefault = (): Pick<ReportFilters, 'from' | 'to'> => ({
    from: dayInput(new Date(data.now - (Number(filters.range) || 30) * 86_400_000)),
    to: dayInput(new Date(data.now)),
  });

  return (
    <div className="min-w-0 max-w-full">
      {header}

      <FilterBar
        className="mb-5"
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
            <div role="group" aria-label="Platform" className="flex max-w-full flex-wrap gap-1">
              {[
                { value: '', label: 'All platforms' },
                ...platformsOf(accounts).map((p) => ({ value: p, label: platformLabel(p) })),
              ].map((p) => (
                <button
                  key={p.value}
                  type="button"
                  aria-pressed={filters.platform === p.value}
                  onClick={() => setFilters({ platform: p.value })}
                  className={cn(
                    'inline-flex items-center gap-2 min-h-11 rounded-full border px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink md:min-h-8',
                    filters.platform === p.value
                      ? 'border-ink bg-surface-strong text-ink'
                      : 'border-muted bg-canvas text-muted',
                  )}
                >
                  {p.value && (
                    <span
                      aria-hidden="true"
                      className="h-2 w-2 rounded-full"
                      style={{ background: platformColor(p.value) }}
                    />
                  )}
                  {p.label}
                </button>
              ))}
            </div>
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
          </>
        }
        actions={
          <p className="tnum text-caption text-muted">
            {report?.summary.lastCapturedAt
              ? `Updated ${new Date(report.summary.lastCapturedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: timezone })}, ${new Date(report.summary.lastCapturedAt).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', timeZone: timezone })}`
              : 'No captures yet'}
          </p>
        }
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
      ) : (
        <div
          aria-busy={load.status === 'loading'}
          className={cn('space-y-4', load.status === 'loading' && 'opacity-60')}
        >
          {load.status === 'loading' && (
            <p role="status" className="sr-only">
              Updating · retained results: {new Date(report.period.start).toLocaleDateString()} –{' '}
              {new Date(report.period.end).toLocaleDateString()} ·{' '}
              {report.accounts
                .filter((a) => a.selected)
                .map((a) => `${a.workspaceName} / ${a.displayName}`)
                .join(', ')}
            </p>
          )}
          <fieldset
            disabled={load.status === 'loading'}
            {...(load.status === 'loading' ? { inert: '' } : {})}
            className="min-w-0 space-y-4"
          >
            {report.summary.posts.value === 0 && (
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-sm text-muted">No posts published in this period</p>
                <Button
                  variant="outline"
                  onClick={() => setFilters({ range: '90', from: '', to: '' })}
                >
                  Widen period
                </Button>
              </div>
            )}
            <Kpis report={report} />
            <Insights report={report} />
            <PublishTrend
              report={report}
              concepts={concepts}
              metric={concept}
              onMetric={(c) => write(filters, c)}
            />
            <div className="grid min-w-0 gap-4 md:grid-cols-2">
              <PlatformSplit report={report} />
              <FormatBreakdown report={report} />
              <BestTimes report={report} />
              <FollowerEvolution report={report} />
              <FrequencyVsEngagement report={report} />
              <EngagementAccumulation report={report} />
            </div>
            <TopPosts key={params.toString()} report={report} concepts={concepts} absent={absent} />
            <PlatformTable report={report} concepts={concepts} absent={absent} />
            <details
              id="analytics-calculations"
              className="rounded-lg border border-hairline bg-canvas p-4"
            >
              <summary className="min-h-11 cursor-pointer py-3 text-base font-semibold text-ink">
                How these numbers are calculated
              </summary>
              <div className="space-y-3 text-sm text-body-ink">
                <p>
                  Rate coverage: {report.summary.engagementRate.postsCounted}/
                  {report.summary.engagementRate.posts} posts. Basis:{' '}
                  {report.summary.engagementRate.basis ?? 'none'}.{' '}
                  {undatedNote(report.summary.undatedPosts)}. {report.postsOmitted} posts omitted
                  from the returned table.
                </p>
                {importing && <p>{importing}</p>}
                {report.accounts
                  .filter((a) => a.selected && a.needsReconnect)
                  .map((a) => (
                    <p key={a.id}>{a.displayName}: reconnect needed.</p>
                  ))}

                <p>
                  Latest counts for posts published in (start, end], not counts gained during each
                  day or week. Captures can be after the selected end date. Reach is summed post
                  reach, not unique people.
                </p>
                <p>
                  Engagement rate divides summed reported likes, comments, shares and saves by
                  positive reach, with views as fallback. Components are a union and can differ by
                  post. Mixed basis is descriptive. Missing is —; observed zero is 0. Unsupported
                  and uncollected counts are different.
                </p>
                <p>
                  Followers sum each counted account’s latest capture in the period, potentially on
                  different dates. Change compares prior captures, not followers acquired during
                  this date range. Latest capture can include prior-period posts and follower
                  records.
                </p>
                <p>
                  Prior comparisons use equally long publication windows. Older posts have longer to
                  accrue counts; these comparisons do not establish growth. Rate change is relative
                  percent, not percentage points.
                </p>
                <div className="tnum space-y-1">
                  {concepts.map((c) => (
                    <div key={c}>
                      {c}: {report.summary.totals[c].value?.toLocaleString() ?? '—'} · prior{' '}
                      {report.summary.totals[c].prior?.toLocaleString() ?? '—'} · relative change{' '}
                      {formatRate(report.summary.totals[c].deltaPct)}
                    </div>
                  ))}
                  <div>
                    Rate: {formatRate(report.summary.engagementRate.rate)} · prior{' '}
                    {formatRate(report.summary.engagementRatePrior)} · relative change{' '}
                    {formatRate(report.summary.engagementRateDeltaPct)}
                  </div>
                </div>
                <p>
                  Insights are descriptive: format comparisons need five measured posts per group,
                  matching bases and engagement components, and unequal rates. Time-slot findings
                  need three measured posts; chips show the top three qualified slots. Top-post
                  share needs five published posts and a positive engagement total. Platform reach
                  share needs two platforms reporting reach and five posts on the leading platform.
                  Change findings need positive prior data and a finite, nonzero change. At most
                  four findings appear in format, time, post, platform, then delta order.
                </p>
                <p>
                  Publishing times describe mean historical response by publication slot, not
                  audience activity. Formats use first media kind. Cadence mixes accounts by
                  platform and omits zero-post weeks. None establish causal recommendations.
                </p>
                <p>
                  Captured engagement uses up to the newest 200 candidate posts. Qualification:{' '}
                  {report.accumulation.rules.minSnapshots} capture times, first within{' '}
                  {report.accumulation.rules.firstWithinHours}h, latest at least{' '}
                  {report.accumulation.rules.minAgeHours}h, positive latest engagements. Display
                  needs one account and 10 contributors at each age. Values carry forward between
                  captures and cap at 100%; changing samples never form a trajectory or predict
                  lifetime engagement.
                </p>
                <RawMetrics report={report} />
              </div>
            </details>
          </fieldset>
        </div>
      )}
    </div>
  );
}

const undatedNote = (count: number) => `${count.toLocaleString()} undated posts excluded`;

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

/** The loaded page's blocks at their sizes, so nothing jumps when the report arrives. */
function PageSkeleton() {
  const card = 'rounded-lg border border-hairline p-4';
  return (
    <div className="space-y-3" aria-hidden="true">
      <KpiSkeleton />
      <div className={card}>
        <Skeleton className="h-5 w-48" />
        <Skeleton className="mt-3 h-56 w-full" />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className={card}>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="mt-3 h-52 w-full" />
          </div>
        ))}
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
