import type { ReactNode } from 'react';
import {
  compact,
  formatNumber,
  formatRate,
  basisText,
  type Report,
} from '../../lib/analyticsReport';
import { Skeleton } from '../ui/Skeleton';
import { Help } from './parts';

/** Four factual outcomes, without unsupported publication-period comparisons. */
export function Kpis({
  report,
  onMetric,
  onFollowers,
  onRate,
}: {
  report: Report;
  onMetric: (metric: 'views' | 'reach' | 'clicks') => void;
  onFollowers: () => void;
  onRate: () => void;
}) {
  const supported = (concept: 'views' | 'reach' | 'clicks') =>
    report.mapping.some((m) => m.concepts[concept].length > 0);
  const followerSupported = report.mapping.some((m) => m.followers.length > 0);
  const youtube = report.mapping.length === 1 && report.mapping[0]?.provider === 'youtube';
  const rateSupported = report.mapping.some(
    (m) =>
      (m.concepts.views.length > 0 || m.concepts.reach.length > 0) &&
      ['likes', 'comments', 'shares', 'saves'].some((c) => m.concepts[c as 'likes'].length > 0),
  );
  const { summary } = report;
  const rate = summary.engagementRate;
  const followers = summary.followers;
  const countCell = (metric: 'views' | 'reach' | 'clicks', label: string) =>
    supported(metric) && (
      <Cell
        key={metric}
        label={label}
        value={compact(summary.totals[metric].value)}
        onClick={() => onMetric(metric)}
        help={`Exact total: ${formatNumber(summary.totals[metric].value)}. Latest reported counts for posts published in the selected period. ${metric === 'reach' ? 'Post reach is summed, not unique people across posts.' : ''} Missing values mean no count collected.`}
      />
    );
  return (
    <section aria-label="Reported totals" className="space-y-2">
      <p className="text-caption text-muted">Reported totals</p>
      {(supported('views') ||
        supported('reach') ||
        supported('clicks') ||
        rateSupported ||
        followerSupported) && (
        <div className="grid grid-cols-2 overflow-visible rounded-md border border-hairline bg-canvas lg:grid-cols-kpis">
          {countCell('views', 'Views')}
          {countCell('reach', 'Post reach')}
          {!rateSupported && countCell('clicks', 'CTA clicks')}
          {rateSupported && (
            <Cell
              label={youtube ? 'Post engagement rate' : 'Engagement rate'}
              value={formatRate(rate.rate)}
              onClick={onRate}
              help="Ratio of summed reported engagements to positive reach, with views as fallback. Components can differ by post. This is a descriptive total, not a performance winner."
              detail={
                <>
                  {rate.basis === 'mixed' ? 'Mixed basis' : basisText(rate)} · counted{' '}
                  {rate.postsCounted}/{rate.posts}
                  {rate.postsCounted < 5 && ' · Small sample'}
                </>
              }
            />
          )}
          {followerSupported && (
            <Cell
              label={youtube ? 'Subscribers' : 'Followers'}
              value={compact(followers.value)}
              onClick={onFollowers}
              help={`Exact total: ${formatNumber(followers.value)}. Each counted account's latest capture in this period, potentially on different dates; not a unique audience.`}
              detail={
                <>
                  {followers.accountsCounted}/{followers.accounts} accounts
                  {followers.change !== null && (
                    <span className="block">
                      {followers.change >= 0 ? '+' : '−'}
                      {formatNumber(Math.abs(followers.change))} vs prior capture
                    </span>
                  )}
                </>
              }
            />
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 text-caption text-muted">
        <p>
          Published:{' '}
          <span className="tnum font-semibold text-ink">{formatNumber(summary.posts.value)}</span>{' '}
          posts
        </p>
        <a
          href="#analytics-calculations"
          className="inline-flex min-h-11 items-center font-medium text-ink underline"
        >
          About totals
        </a>
      </div>
      {summary.posts.value !== 0 && report.rawMetrics.length === 0 && (
        <p className="text-caption text-muted">No metrics collected</p>
      )}
    </section>
  );
}

function Cell({
  label,
  value,
  detail,
  help,
  onClick,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  help: string;
  onClick: () => void;
}) {
  return (
    <div className="min-w-0 border-hairline p-3">
      <div className="flex items-center gap-1 text-caption text-muted">
        <span>{label}</span>
        <Help label={label} text={help} />
      </div>
      <button
        type="button"
        onClick={onClick}
        className="tnum min-h-11 rounded-sm text-left text-3xl font-semibold text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
      >
        {value}
      </button>
      {detail && <p className="tnum text-caption text-muted">{detail}</p>}
    </div>
  );
}

export function KpiSkeleton() {
  return (
    <div
      className="grid grid-cols-2 gap-3 rounded-md border border-hairline p-3 lg:grid-cols-4"
      aria-hidden="true"
    >
      {[0, 1, 2, 3].map((n) => (
        <div key={n}>
          <Skeleton className="h-4 w-20" />
          <Skeleton className="mt-2 h-8 w-24" />
        </div>
      ))}
    </div>
  );
}
