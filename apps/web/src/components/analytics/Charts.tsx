import { useState } from 'react';
import type { MetricConcept } from '@meegrow-social/contracts';
import { CONCEPT_LABEL, compact, formatRate, type Report } from '../../lib/analyticsReport';
import { platformColor } from '../../lib/platforms';
import { ChartLineUp, Clock, Lightning, PlayCircle, ShareNetwork } from '../../lib/icons';
import { Delta } from './Kpis';
import {
  InlineSelect,
  Insufficient,
  PlatformKey,
  PlatformName,
  Section,
  platformLabel,
} from './parts';
import { Plot, friendlyDay } from './Plot';

export type TrendMetric = MetricConcept | 'posts' | 'rate';
const DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const hourLabel = (h: number) => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;
const slotLabel = (day: number, hour: number) => `${DAY[day]} ${hourLabel(hour)}`;
const RAMP = ['#e5f2ef', '#b8ddd4', '#72b7a5', '#277461', '#006650'];

export function Insights({ report }: { report: Report }) {
  if (!report.insights?.length) return null;
  const icons = {
    format: PlayCircle,
    time: Clock,
    post: Lightning,
    platform: ShareNetwork,
    delta: ChartLineUp,
  };
  return (
    <section aria-label="Insights" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {report.insights.map((i) => {
        const Icon = icons[i.kind];
        return (
          <article
            key={i.kind}
            className="flex min-w-0 items-start gap-3 rounded-lg border border-hairline bg-surface-soft/50 p-4"
          >
            <span className="rounded-md bg-canvas p-2 text-ink">
              <Icon size={18} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-ink">{i.title}</h2>
              <p className="mt-1 truncate text-caption text-muted" title={i.detail}>
                {i.detail}
              </p>
            </div>
          </article>
        );
      })}
    </section>
  );
}

export function PublishTrend({
  report,
  metric,
  onMetric,
}: {
  report: Report;
  concepts?: readonly MetricConcept[];
  metric: TrendMetric;
  onMetric: (metric: string) => void;
}) {
  const label =
    metric === 'rate' ? 'Engagement rate' : metric === 'posts' ? 'Posts' : CONCEPT_LABEL[metric];
  const total =
    metric === 'rate'
      ? formatRate(report.summary.engagementRate.rate)
      : compact(
          metric === 'posts' ? report.summary.posts.value : report.summary.totals[metric].value,
        );
  const delta =
    metric === 'rate'
      ? report.summary.engagementRateDeltaPct
      : metric === 'posts'
        ? report.summary.posts.deltaPct
        : report.summary.totals[metric].deltaPct;
  const providers = report.byPlatform.map((p) => p.provider);
  const series = providers.map((provider) => ({
    key: provider,
    label: platformLabel(provider),
    color: platformColor(provider),
  }));
  const rows: Array<Record<string, string | number | null>> = (
    report.weeklySeries ?? report.overTime
  ).map((b) => ({
    date: friendlyDay(b.key),
    ...Object.fromEntries(
      providers.map((provider) => {
        const p = b.byPlatform.find((p) => p.provider === provider);
        return [
          provider,
          metric === 'posts'
            ? (p?.posts ?? 0)
            : metric === 'rate'
              ? (p?.engagementRate ?? null)
              : (p?.totals[metric] ?? null),
        ];
      }),
    ),
  }));
  return (
    <Section
      title={`${label} over time`}
      subtitle={'By publish week'}
      actions={
        <div className="flex items-center gap-2">
          <span className="tnum text-xl font-semibold text-ink">{total}</span>
          <Delta value={delta} />
        </div>
      }
    >
      <div role="group" aria-label="Trend metric" className="mb-5 flex flex-wrap gap-1.5">
        {(['views', 'reach', 'likes', 'comments', 'saves', 'rate'] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={metric === m}
            onClick={() => onMetric(m)}
            className={`min-h-11 rounded-full px-3 text-caption font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink md:min-h-8 ${metric === m ? 'bg-ink text-canvas' : 'bg-surface-soft text-muted hover:text-ink'}`}
          >
            {m === 'rate' ? 'Engagement rate' : CONCEPT_LABEL[m]}
          </button>
        ))}
      </div>
      {rows.some((r) => series.some((s) => r[s.key] !== null)) ? (
        <Plot
          tall
          rows={rows}
          series={series}
          title={`${label} by publish week`}
          percent={metric === 'rate'}
        />
      ) : (
        <Insufficient className="h-52" title="No reported values for this metric yet" />
      )}
      <PlatformKey providers={providers} />
    </Section>
  );
}

export function PlatformSplit({ report }: { report: Report }) {
  return (
    <Section title="Platform split" subtitle="Published posts and reported reach">
      {report.byPlatform.some((p) => p.posts > 0) ? (
        <div className="space-y-5 py-2">
          {report.byPlatform.map((p) => {
            const share = report.platformShares?.find((s) => s.provider === p.provider)?.reachPct;
            return (
              <div key={p.provider}>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-caption">
                  <PlatformName provider={p.provider} className="font-semibold text-ink" />
                  <span className="tnum text-muted">
                    {p.posts} posts · {share == null ? '—' : `${share.toFixed(1)}%`} reach ·{' '}
                    {formatRate(p.engagementRate.rate)} ER
                  </span>
                </div>
                <div className="h-2 rounded-full bg-surface-soft">
                  <div
                    className="h-2 rounded-full"
                    style={{
                      width: share == null ? '0%' : `${share}%`,
                      background: platformColor(p.provider),
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <Insufficient className="h-52" title="No platforms in this period" />
      )}
    </Section>
  );
}

export function FormatBreakdown({ report }: { report: Report }) {
  const max = Math.max(1, ...report.formats.map((f) => f.engagementRate.rate ?? 0));
  return (
    <Section title="Format performance" subtitle="Engagement rate by post format">
      {report.formats.some((f) => f.engagementRate.rate !== null) ? (
        <div className="space-y-5 py-2">
          {(['video', 'image', 'text'] as const).map((format) => {
            const f = report.formats.find((f) => f.format === format);
            const rate = f?.engagementRate.rate ?? null;
            const best = report.formatWinner === format;
            return (
              <div key={format}>
                <div className="mb-2 flex items-center justify-between gap-2 text-sm">
                  <span className="flex items-center gap-2 font-medium text-ink">
                    {{ video: 'Video', image: 'Image', text: 'Text' }[format]}
                    {best && (
                      <span className="rounded-full bg-status-ok/10 px-2 py-0.5 text-micro text-status-ok">
                        Best
                      </span>
                    )}
                  </span>
                  <span className="tnum text-muted">
                    {f ? `${f.posts} posts` : '—'}{' '}
                    <span className="ml-3 font-semibold text-ink">{formatRate(rate)}</span>
                  </span>
                </div>
                <div className="h-2 rounded-full bg-surface-soft">
                  <div
                    className={`h-2 rounded-full ${best ? 'bg-status-ok' : 'bg-muted-soft'}`}
                    style={{ width: `${rate === null ? 0 : (rate / max) * 100}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <Insufficient className="h-52" title="Publish posts to compare formats" />
      )}
    </Section>
  );
}

export function BestTimes({ report }: { report: Report }) {
  const { bestTimes: b } = report;
  const [active, setActive] = useState<string | null>(null);
  return (
    <Section
      title="Best time to post"
      subtitle={`Average ${b.by ?? 'engagements'} per post · ${report.timezone}`}
    >
      {!b.cells.some((c) => c.average !== null) ? (
        <Insufficient className="h-52" title="No measured publishing slots yet" />
      ) : (
        <>
          <div
            className="grid gap-1"
            style={{ gridTemplateColumns: '28px repeat(24, minmax(0, 1fr))' }}
          >
            <span />
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h} className="text-center text-micro text-muted">
                {h % 6 === 0 ? hourLabel(h) : ''}
              </span>
            ))}
            {DAY.map((day, d) => (
              <Row
                key={day}
                day={day}
                index={d}
                cells={b.cells}
                active={active}
                setActive={setActive}
              />
            ))}
          </div>
          <div
            className="mt-2 flex items-center justify-end gap-1 text-micro text-muted"
            aria-label="Heatmap intensity: less to more"
          >
            <span>Less</span>
            {RAMP.map((color) => (
              <span
                key={color}
                aria-hidden="true"
                className="h-2 w-3 rounded-xs"
                style={{ background: color }}
              />
            ))}
            <span>More</span>
          </div>
          <p role="status" className="mt-2 min-h-8 text-caption text-muted">
            {active ?? 'Select a slot for its measured average and post count'}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {report.bestSlots?.map((c) => (
              <span
                key={`${c.weekday}:${c.hour}`}
                className="tnum rounded-full bg-status-ok/10 px-2 py-1 text-micro text-status-ok"
              >
                {slotLabel(c.weekday, c.hour)} · {c.average.toFixed(0)} avg · {c.posts} posts
              </span>
            ))}
          </div>
        </>
      )}
    </Section>
  );
}
function Row({
  day,
  index,
  cells,
  active,
  setActive,
}: {
  day: string;
  index: number;
  cells: Report['bestTimes']['cells'];
  active: string | null;
  setActive: (s: string) => void;
}) {
  return (
    <>
      <span className="self-center text-micro text-muted">{day}</span>
      {Array.from({ length: 24 }, (_, h) => {
        const c = cells.find((c) => c.weekday === index && c.hour === h);
        const text = `${slotLabel(index, h)}: ${c?.average == null ? 'no measured data' : `${c.average.toFixed(1)} average across ${c.postsCounted ?? c.posts} measured posts`}`;
        return (
          <button
            key={h}
            type="button"
            aria-label={text}
            aria-pressed={active === text}
            title={text}
            onFocus={() => setActive(text)}
            onClick={() => setActive(text)}
            className="h-6 min-w-0 rounded-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
            style={{ background: c?.level == null ? 'hsl(var(--surface-soft))' : RAMP[c.level] }}
          >
            <span className="sr-only">{text}</span>
          </button>
        );
      })}
    </>
  );
}

export function FollowerEvolution({ report }: { report: Report }) {
  const accounts = report.accounts.filter((a) => a.selected);
  const [choice, setChoice] = useState('');
  const account = accounts.find((a) => a.id === choice) ?? accounts[0];
  const s = report.followerSeries.find((s) => s.connectionId === account?.id);
  const change = s?.change;
  return (
    <Section
      title="Follower growth"
      subtitle={
        account
          ? `${account.displayName} · ${platformLabel(account.provider)}`
          : 'Followers per connected account'
      }
      actions={
        <span className="tnum text-sm font-semibold text-ink">
          {change == null ? '— net' : `${change >= 0 ? '+' : ''}${change.toLocaleString()} net`}
        </span>
      }
    >
      {accounts.length > 1 && (
        <div className="mb-3">
          <InlineSelect
            label="Follower account"
            value={account?.id ?? ''}
            onChange={setChoice}
            options={accounts.map((a) => ({
              value: a.id,
              label: `${a.displayName} · ${platformLabel(a.provider)}`,
            }))}
          />
        </div>
      )}
      {s?.points.length ? (
        <Plot
          rows={(s.dailyPoints ?? s.points).map((p) => ({
            date: friendlyDay(p.day),
            value: p.value,
          }))}
          series={[
            {
              key: 'value',
              label: account?.displayName ?? 'Followers',
              color: platformColor(account?.provider ?? ''),
            },
          ]}
          title={`Follower captures for ${account?.displayName ?? 'account'}`}
          fitted
        />
      ) : (
        <Insufficient className="h-52" title="No follower captures for this account yet" />
      )}
    </Section>
  );
}

export function FrequencyVsEngagement({ report }: { report: Report }) {
  const providers = report.byPlatform.map((p) => p.provider);
  return (
    <Section title="Posting rhythm" subtitle={'Posts published per week'}>
      {(report.weeklySeries ?? report.overTime).some((b) => b.posts > 0) ? (
        <>
          <Plot
            bars
            rows={(report.weeklySeries ?? report.overTime).map((b) => ({
              date: friendlyDay(b.key),
              ...Object.fromEntries(
                providers.map((p) => [p, b.byPlatform.find((s) => s.provider === p)?.posts ?? 0]),
              ),
            }))}
            series={providers.map((p) => ({
              key: p,
              label: platformLabel(p),
              color: platformColor(p),
            }))}
            title={'Published posts per week by platform'}
          />
          <PlatformKey providers={providers} />
        </>
      ) : (
        <Insufficient className="h-52" title="No posts published in this period" />
      )}
    </Section>
  );
}
export function EngagementAccumulation({ report }: { report: Report }) {
  const points = report.accumulation.displayPoints ?? [];
  return (
    <Section title="Engagement by post age" subtitle="Captured share of latest engagement">
      {points.length >= 2 ? (
        <Plot
          percent
          rows={points.map((p) => ({
            date: p.untilHours < 24 ? `${p.untilHours}h` : `${p.untilHours / 24}d`,
            value: p.pct,
          }))}
          series={[{ key: 'value', label: 'Captured engagement %', color: '#475569' }]}
          title="Captured engagement share by post age"
        />
      ) : (
        <Insufficient
          className="h-52"
          title="More early snapshots needed to show post-age engagement"
        />
      )}
    </Section>
  );
}
