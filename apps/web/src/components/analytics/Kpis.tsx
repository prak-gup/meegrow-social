import { compact, formatRate, type Report } from '../../lib/analyticsReport';
import { Skeleton } from '../ui/Skeleton';
import { Help } from './parts';
import { Plot, friendlyDay } from './Plot';

export function Delta({ value }: { value: number | null }) {
  const valid = value !== null && Number.isFinite(value);
  return (
    <span
      className={`tnum inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-caption font-medium ${!valid || value === 0 ? 'bg-surface-soft text-muted' : value > 0 ? 'bg-status-ok/10 text-status-ok' : 'bg-status-bad/10 text-status-bad'}`}
    >
      {valid ? `${value > 0 ? '↑' : value < 0 ? '↓' : ''} ${Math.abs(value).toFixed(1)}%` : '—'}
      <span className="sr-only">vs prior period</span>
    </span>
  );
}
export function Kpis({ report }: { report: Report }) {
  const { summary: s } = report;
  const cells = [
    {
      key: 'rate',
      label: 'Engagement rate',
      value: formatRate(s.engagementRate.rate),
      delta: s.engagementRateDeltaPct,
      color: '#7c3aed',
      help: `Reported likes + comments + shares + saves ÷ reach × 100; views are the fallback. Basis: ${s.engagementRate.basis ?? 'none'}. Counted ${s.engagementRate.postsCounted}/${s.engagementRate.posts} posts. Relative change vs prior publication period.`,
    },
    {
      key: 'reach',
      label: 'Reach',
      value: compact(s.totals.reach.value),
      delta: s.totals.reach.deltaPct,
      color: '#0d9488',
      help: 'Sum of latest reported post reach for posts published in this period; not unique people across posts. Compared with the previous equally long publication window.',
    },
    {
      key: 'views',
      label: 'Views',
      value: compact(s.totals.views.value),
      delta: s.totals.views.deltaPct,
      color: '#2563eb',
      help: 'Latest reported views of posts published in this period compared with the previous publication window; not views gained during the period.',
    },
    {
      key: 'followers',
      label: 'Followers',
      value: compact(s.followers.value),
      delta: s.followers.deltaPct,
      color: '#db2777',
      help: `Latest follower captures summed across ${s.followers.accountsCounted}/${s.followers.accounts} accounts. Net change compares each account with its prior-period capture. Gaps are never filled.`,
    },
    {
      key: 'posts',
      label: 'Posts published',
      value: compact(s.posts.value),
      delta: s.posts.deltaPct,
      color: '#475569',
      help: 'Posts published in the selected window compared with the previous equally long window. Undated posts are excluded.',
    },
  ];
  return (
    <section
      aria-label="Reported totals"
      className="grid grid-cols-1 gap-3 min-[390px]:grid-cols-2 xl:grid-cols-5"
    >
      {cells.map((c) => {
        const rows =
          c.key === 'followers'
            ? (report.followerTrend ?? []).map((p) => ({
                date: friendlyDay(p.day),
                value: p.value,
              }))
            : (report.weeklySeries ?? report.overTime).map((b) => ({
                date: friendlyDay(b.key),
                value:
                  c.key === 'rate'
                    ? b.engagementRate
                    : c.key === 'posts'
                      ? b.posts
                      : b.totals[c.key as 'reach' | 'views'],
              }));
        return (
          <article
            key={c.key}
            className="min-w-0 rounded-lg border border-hairline bg-canvas p-4 shadow-[0_2px_8px_rgba(0,0,0,0.025)]"
          >
            <div className="flex items-center justify-between text-caption text-muted">
              <span>{c.label}</span>
              <Help label={c.label} text={c.help} />
            </div>
            <p className="tnum mt-1 text-3xl font-semibold tracking-tight text-ink">{c.value}</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Delta value={c.delta} />
              <span className="text-micro text-muted">
                {c.key === 'followers' && s.followers.change !== null
                  ? `${s.followers.change >= 0 ? '+' : ''}${s.followers.change.toLocaleString()} net`
                  : 'vs prior period'}
              </span>
            </div>
            <div className="mt-3">
              <Plot
                spark
                fitted={c.key === 'followers'}
                rows={rows}
                series={[{ key: 'value', label: c.label, color: c.color }]}
                title={`${c.label} ${c.key === 'followers' ? 'by capture week' : 'by publish week'}`}
              />
            </div>
          </article>
        );
      })}
    </section>
  );
}
export function KpiSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-5" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((n) => (
        <div key={n} className="rounded-lg border border-hairline p-4">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="mt-3 h-8 w-24" />
          <Skeleton className="mt-3 h-16 w-full" />
        </div>
      ))}
    </div>
  );
}
