import { useRef, useState } from 'react';
import {
  Scatter,
  ScatterChart,
  CartesianGrid,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
} from 'recharts';
import type { MetricConcept } from '@meegrow-social/contracts';
import {
  CONCEPT_LABEL,
  formatNumber,
  formatRate,
  basisText,
  type Report,
} from '../../lib/analyticsReport';
import { Chart } from '../ui/Chart';
import { Table } from '../ui/Table';
import { InlineSelect, Section, platformLabel } from './parts';

const BLUE = '#0072B2';
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const RAMP = ['#E5F2EF', '#B8DDD4', '#72B7A5', '#277461', '#006650'];

export function PublishTrend({
  report,
  concepts,
  metric,
  onMetric,
}: {
  report: Report;
  concepts: readonly MetricConcept[];
  metric: MetricConcept | 'posts';
  onMetric: (metric: string) => void;
}) {
  if (report.summary.posts.value === 0) return null;
  const label = metric === 'posts' ? 'Posts' : CONCEPT_LABEL[metric];
  const rows = report.overTime.map((b) => ({
    bucket: `${b.key}${b.window?.partial ? ' · Partial' : ''}`,
    value: metric === 'posts' ? b.posts : b.totals[metric],
    published: b.posts,
    from: b.window?.from,
    to: b.window?.to,
  }));
  return (
    <Section
      title={`Results by publish ${report.bucket}`}
      subtitle={`Latest counts for posts published in each ${report.bucket}`}
      actions={
        <InlineSelect
          label="Chart metric"
          value={metric}
          onChange={onMetric}
          options={[
            ...concepts.map((c) => ({ value: c, label: CONCEPT_LABEL[c] })),
            { value: 'posts', label: 'Posts' },
          ]}
        />
      }
    >
      <Chart
        bare
        type="bar"
        title={`${label} by publication ${report.bucket}; latest reported counts`}
        data={rows.map((r) => ({ bucket: r.bucket, value: r.value }))}
        xKey="bucket"
        xLabel="Publish bucket"
        series={[{ key: 'value', label, color: BLUE }]}
        plotClassName="h-[180px] md:h-[220px] xl:h-[260px]"
      />
      {rows.some((r) => r.value === null) && (
        <p className="text-caption text-muted">
          — Missing reported counts:{' '}
          {rows
            .filter((r) => r.value === null)
            .map((r) => r.bucket)
            .join(', ')}
        </p>
      )}
      <details className="mt-2">
        <summary className="min-h-11 cursor-pointer py-3 text-caption font-medium text-ink">
          Chart data
        </summary>
        <Table
          caption={`${label} by publish bucket`}
          dense
          rows={rows}
          rowKey={(r) => r.bucket}
          columns={[
            { key: 'bucket', header: 'Publish bucket', cell: (r) => r.bucket },
            {
              key: 'range',
              header: 'Included date range',
              cell: (r) =>
                r.from && r.to
                  ? `${new Date(r.from).toLocaleString([], { timeZone: report.timezone })} – ${new Date(r.to).toLocaleString([], { timeZone: report.timezone })}`
                  : 'Not supplied',
            },
            {
              key: 'posts',
              header: 'Published posts',
              align: 'right',
              cell: (r) => formatNumber(r.published),
            },
            { key: 'value', header: label, align: 'right', cell: (r) => formatNumber(r.value) },
          ]}
        />
      </details>
    </Section>
  );
}

export function FormatBreakdown({ report }: { report: Report }) {
  if (!report.formats.length) return null;
  return (
    <Section
      title="Formats"
      subtitle="First media kind; Text can include unavailable imported media"
    >
      <Table
        caption="Descriptive format totals"
        dense
        rows={report.formats}
        rowKey={(r) => r.format}
        columns={[
          {
            key: 'format',
            header: 'Format',
            cell: (r) => ({ video: 'Video', image: 'Image', text: 'Text' })[r.format],
          },
          { key: 'posts', header: 'Posts', align: 'right', cell: (r) => formatNumber(r.posts) },
          {
            key: 'rate',
            header: 'Rate / basis',
            align: 'right',
            cell: (r) => (
              <>
                {formatRate(r.engagementRate.rate)} {basisText(r.engagementRate)}
              </>
            ),
          },
          {
            key: 'counted',
            header: 'Counted',
            align: 'right',
            cell: (r) => `${r.engagementRate.postsCounted}/${r.posts}`,
          },
        ]}
      />
    </Section>
  );
}

export function FollowerEvolution({ report }: { report: Report }) {
  const accounts = report.accounts.filter(
    (a) =>
      a.selected && report.mapping.some((m) => m.provider === a.provider && m.followers.length > 0),
  );
  const [choice, setChoice] = useState('');
  const account = accounts.find((a) => a.id === choice) ?? accounts[0];
  if (!account) return null;
  const series = report.followerSeries.find((s) => s.connectionId === account.id);
  const rows = series?.dailyPoints;
  const label = account.provider === 'youtube' ? 'Subscribers' : 'Followers';
  return (
    <Section
      title={label}
      subtitle={`${account.displayName} · ${platformLabel(account.provider)} · ${report.timezone}`}
      actions={
        <InlineSelect
          label="Follower account"
          value={account.id}
          onChange={setChoice}
          options={accounts.map((a) => ({
            value: a.id,
            label: `${a.displayName} · ${platformLabel(a.provider)} · ${a.workspaceName}`,
          }))}
        />
      }
    >
      {!series?.points.length ? (
        <p className="text-sm text-muted">No follower captures</p>
      ) : (
        <>
          <p className="tnum mb-2 text-sm text-ink">
            Latest capture: {formatNumber(series.points.at(-1)?.value ?? null)}{' '}
            {label.toLowerCase()}
          </p>
          {rows && (
            <Chart
              bare
              type="line"
              gaps
              dots
              title={`${label} for ${account.displayName}; missing days are gaps`}
              xKey="day"
              xLabel="Day"
              data={rows}
              series={[{ key: 'value', label, color: BLUE }]}
              plotClassName="h-[180px] md:h-[220px]"
            />
          )}
          <details className="mt-2">
            <summary className="min-h-11 cursor-pointer py-3 text-caption font-medium text-ink">
              Capture data
            </summary>
            <Table
              caption={`${label} captures for ${account.displayName}`}
              dense
              rows={rows ?? series.points}
              rowKey={(r) => r.day}
              columns={[
                { key: 'day', header: 'Day', cell: (r) => r.day },
                { key: 'value', header: label, align: 'right', cell: (r) => formatNumber(r.value) },
              ]}
            />
          </details>
        </>
      )}
    </Section>
  );
}

/** One roving desktop grid; 24 touch-sized hourly rows for the selected day on phones. */
export function BestTimes({ report }: { report: Report }) {
  const [slot, setSlot] = useState(0);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const { bestTimes } = report;
  if (!bestTimes.by || !bestTimes.cells.length) return null;
  const day = Math.floor(slot / 24);
  const hour = slot % 24;
  const cell = (d: number, h: number) =>
    bestTimes.cells.find((c) => c.weekday === d && c.hour === h);
  const selected = cell(day, hour);
  const choose = (index: number, focus = false) => {
    setSlot(index);
    if (focus) refs.current[index]?.focus();
  };
  return (
    <Section
      title="Publishing times"
      subtitle={`Historical post response, not audience online activity · ${report.timezone}`}
    >
      <div className="hidden md:block">
        <div role="grid" aria-label="Publication day and hour" className="space-y-1">
          {WEEKDAYS.map((name, d) => (
            <div role="row" key={name} className="flex items-center gap-1">
              <span className="w-16 flex-none text-caption text-muted">{name.slice(0, 3)}</span>
              {Array.from({ length: 24 }, (_, h) => {
                const index = d * 24 + h;
                const c = cell(d, h);
                const level = c?.level;
                const background =
                  c?.average == null ? undefined : level == null ? RAMP[0] : RAMP[level];
                return (
                  <span role="gridcell" key={h} className="min-w-0 flex-1">
                    <button
                      ref={(el) => {
                        refs.current[index] = el;
                      }}
                      type="button"
                      tabIndex={slot === index ? 0 : -1}
                      aria-pressed={slot === index}
                      aria-label={`${name} ${h}:00: ${formatNumber(c?.average ?? null)} mean ${bestTimes.by}; Published: ${c?.posts ?? 0}`}
                      onClick={() => choose(index)}
                      onFocus={() => setSlot(index)}
                      onKeyDown={(e) => {
                        const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -24, ArrowDown: 24 }[
                          e.key
                        ];
                        if (delta !== undefined) {
                          e.preventDefault();
                          choose(Math.max(0, Math.min(167, index + delta)), true);
                        }
                      }}
                      style={{
                        background:
                          background ??
                          'repeating-linear-gradient(45deg,#fff,#fff 3px,#ddd 3px,#ddd 4px)',
                        color:
                          level !== undefined && level !== null && level >= 3 ? '#fff' : '#222',
                        borderColor: '#6a6a6a',
                      }}
                      className="h-8 w-full rounded-xs border text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                    >
                      {c?.average == null ? '—' : h}
                    </button>
                  </span>
                );
              })}
            </div>
          ))}
        </div>
        <p aria-live="polite" className="tnum mt-2 text-caption text-ink">
          {WEEKDAYS[day]} {hour}:00 · Mean {bestTimes.by}: {formatNumber(selected?.average ?? null)}{' '}
          · Published: {selected?.posts ?? 0}
        </p>
      </div>
      <div className="md:hidden">
        <InlineSelect
          label="Publication day"
          value={String(day)}
          onChange={(v) => setSlot(Number(v) * 24)}
          options={WEEKDAYS.map((name, d) => ({ value: String(d), label: name }))}
        />
      </div>
      <details className="mt-2" open>
        <summary className="hidden min-h-11 cursor-pointer py-3 text-caption font-medium text-ink md:block">
          Hourly data
        </summary>
        <Table
          caption={`${WEEKDAYS[day]} publication hours; mean ${bestTimes.by}`}
          rows={Array.from({ length: 24 }, (_, h) => ({ hour: h, cell: cell(day, h) }))}
          rowKey={(r) => String(r.hour)}
          columns={[
            { key: 'hour', header: 'Hour', className: 'h-11', cell: (r) => `${r.hour}:00` },
            {
              key: 'mean',
              header: `Mean ${bestTimes.by}`,
              align: 'right',
              cell: (r) => formatNumber(r.cell?.average ?? null),
            },
            {
              key: 'posts',
              header: 'Published',
              align: 'right',
              cell: (r) => formatNumber(r.cell?.posts ?? 0),
            },
          ]}
        />
      </details>
    </Section>
  );
}

export function FrequencyVsEngagement({ report }: { report: Report }) {
  if (!report.frequency.platforms.length) return null;
  const rows = report.frequency.platforms.flatMap((p) =>
    p.bands.map((b) => ({ ...b, provider: p.provider })),
  );
  return (
    <Section title="Cadence" subtitle="Full publishing weeks only; zero-post weeks are absent">
      {report.frequency.fullWeeks < 2 ? (
        <p className="text-sm text-muted">Needs two full publishing weeks</p>
      ) : (
        <Table
          caption="Descriptive provider cadence; accounts may be mixed"
          dense
          rows={rows}
          rowKey={(r) => `${r.provider}:${r.min}`}
          columns={[
            { key: 'platform', header: 'Platform', cell: (r) => platformLabel(r.provider) },
            {
              key: 'band',
              header: 'Posts / week',
              cell: (r) => (r.max === null ? `${r.min}+` : `${r.min}–${r.max}`),
            },
            { key: 'weeks', header: 'Weeks', align: 'right', cell: (r) => formatNumber(r.weeks) },
            { key: 'posts', header: 'Posts', align: 'right', cell: (r) => formatNumber(r.posts) },
            {
              key: 'rate',
              header: 'Reported rate',
              align: 'right',
              cell: (r) => formatRate(r.engagementRate),
            },
          ]}
        />
      )}
    </Section>
  );
}

export function EngagementAccumulation({ report }: { report: Report }) {
  if (
    !report.mapping.some((m) =>
      ['likes', 'comments', 'shares', 'saves'].some((c) => m.concepts[c as 'likes'].length > 0),
    )
  )
    return null;
  const points = report.accumulation.displayPoints ?? [];
  return (
    <Section
      title="Captured engagement by post age"
      subtitle="Share of latest captured engagement observed by each age"
    >
      {!points.length ? (
        <p className="text-sm text-muted">
          {report.accounts.filter((a) => a.selected).length !== 1
            ? 'Select one account'
            : 'Needs 10 posts with early captures'}
        </p>
      ) : (
        <>
          <div
            role="img"
            aria-label="Isolated shares by post age; changing samples are not a trajectory"
            className="h-[180px] md:h-[220px]"
          >
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
                <CartesianGrid vertical={false} />
                <XAxis type="number" dataKey="untilHours" name="Age in hours" />
                <YAxis type="number" domain={[0, 100]} dataKey="pct" name="Share %" width={44} />
                <Tooltip />
                <Scatter data={points} fill={BLUE} isAnimationActive={false} />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
          <ul className="flex flex-wrap gap-3 text-caption text-ink">
            {points.map((p) => (
              <li key={p.untilHours}>
                {p.untilHours}h · {formatRate(p.pct)} · n={p.posts}
              </li>
            ))}
          </ul>
        </>
      )}
      <Table
        className="mt-2"
        caption="All observed engagement-age points"
        dense
        rows={report.accumulation.points}
        rowKey={(r) => String(r.untilHours)}
        columns={[
          { key: 'age', header: 'Age (hours)', cell: (r) => formatNumber(r.untilHours) },
          { key: 'pct', header: 'Captured share', align: 'right', cell: (r) => formatRate(r.pct) },
          {
            key: 'n',
            header: 'Contributing posts',
            align: 'right',
            cell: (r) => formatNumber(r.posts),
          },
        ]}
      />
    </Section>
  );
}
