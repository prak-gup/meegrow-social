import { useState, type ReactNode } from 'react';
import type { MetricConcept } from '@meegrow-social/contracts';
import { cn } from '../../lib/cn';
import {
  CONCEPT_LABEL,
  WEEKDAYS,
  ageLabel,
  bandLabel,
  compact,
  followerRows,
  formatNumber,
  formatRate,
  heatLevel,
  hourLabel,
  platformRows,
  signedPercent,
  slotLabel,
  stackedRows,
  trendRows,
  type ChartRow,
  type Report,
  type TrendKey,
} from '../../lib/analyticsReport';
import { ImageIcon, Article, Play, Trophy } from '../../lib/icons';
import { platformColor } from '../../lib/platforms';
import { Badge } from '../ui/Badge';
import { Chart } from '../ui/Chart';
import { Heatmap } from '../ui/Heatmap';
import {
  InlineSelect,
  Insufficient,
  NoValue,
  PlatformKey,
  PlatformName,
  Section,
  platformLabel,
} from './parts';

const bucketWord = (report: Report) => (report.bucket === 'day' ? 'day' : 'week');
const byPublishDate = (report: Report) =>
  `By publish ${bucketWord(report)} (${report.bucket === 'week' ? 'weeks start Monday, ' : ''}${report.timezone})`;

/**
 * One number per platform and the same number over time, side by side: post counts, or one concept.
 * Over time means "posts published in that week, at their current totals" — said in the subtitle.
 */
export function BreakdownCharts({
  report,
  pick,
  actions,
}: {
  report: Report;
  pick: 'posts' | MetricConcept;
  actions?: ReactNode;
}) {
  const label = pick === 'posts' ? 'Posts' : CONCEPT_LABEL[pick];
  const noun = label.toLowerCase();
  const providers = report.byPlatform.map((p) => p.provider);
  const perPlatform = platformRows(report.byPlatform, pick, platformLabel);
  const total = pick === 'posts' ? report.summary.posts.value : report.summary.totals[pick].value;
  // One bar per platform, in the platform's colour: a row carries only its own platform's field.
  const bars: ChartRow[] = perPlatform.map((p) => ({
    platform: p.platform,
    total: p.value,
    [p.provider]: p.value,
  }));
  const series = providers.map((provider) => ({
    key: provider,
    label: platformLabel(provider),
    color: platformColor(provider),
  }));
  const none = total === null || (pick === 'posts' && total === 0);
  const empty =
    pick === 'posts' ? (
      <Insufficient title="No posts published in this period" className="min-h-56">
        A longer period may have some.
      </Insufficient>
    ) : (
      <Insufficient title={`No ${noun} reported for this period`} className="min-h-56">
        No post published in the period carries a {noun} count from its platform.
      </Insufficient>
    );
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Section
        title={`${label} per platform`}
        subtitle={
          pick === 'posts'
            ? 'Posts published in the period'
            : `All-time ${noun} of the posts published in the period`
        }
        actions={
          <div className="flex items-center gap-3">
            {actions}
            <Total value={total} unit={noun} />
          </div>
        }
      >
        {none ? (
          empty
        ) : (
          <>
            <Chart
              bare
              type="bar"
              stacked
              totalKey="total"
              title={`${label} per platform`}
              xKey="platform"
              xLabel="Platform"
              data={bars}
              series={series}
            />
            <ul className="mt-2 grid gap-x-6 text-sm sm:grid-cols-2">
              {perPlatform.map((p) => (
                <li
                  key={p.provider}
                  className="flex min-w-0 items-baseline justify-between gap-3 border-t border-hairline-soft py-1"
                >
                  <PlatformName provider={p.provider} className="text-body-ink" />
                  <span className="tnum flex-none font-semibold text-ink">
                    {p.value === null ? (
                      <NoValue why={`${platformLabel(p.provider)} reports no ${noun}`} />
                    ) : (
                      formatNumber(p.value)
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>
      <Section
        title={`${label} over time`}
        subtitle={byPublishDate(report)}
        actions={<Total value={total} unit={noun} />}
        note={
          pick === 'posts'
            ? undefined
            : `Each bar adds up the current all-time ${noun} of the posts published in that ${bucketWord(report)}. It is not ${noun} gained during that ${bucketWord(report)}.`
        }
      >
        {none ? (
          empty
        ) : (
          <>
            <Chart
              bare
              type="bar"
              stacked
              totalKey="total"
              title={`${label} over time, by publish ${bucketWord(report)}, per platform`}
              xKey="bucket"
              xLabel={report.bucket === 'day' ? 'Day' : 'Week of'}
              data={stackedRows(report.overTime, providers, pick)}
              series={series}
            />
            <PlatformKey providers={providers} />
          </>
        )}
      </Section>
    </div>
  );
}

function Total({ value, unit }: { value: number | null; unit: string }) {
  return (
    <p className="text-right leading-tight">
      <span className="tnum block text-lg font-semibold text-ink">{formatNumber(value)}</span>
      <span className="block text-micro text-muted">{unit} total</span>
    </p>
  );
}

/** The posts charts, then one concept's charts with a picker for which. */
export function ConceptCharts({
  report,
  concepts,
  concept,
  onConcept,
}: {
  report: Report;
  concepts: readonly MetricConcept[];
  concept: MetricConcept | undefined;
  onConcept: (concept: MetricConcept) => void;
}) {
  if (!concept) return null;
  return (
    <BreakdownCharts
      report={report}
      pick={concept}
      actions={
        <InlineSelect
          label="Metric for these two charts"
          value={concept}
          onChange={(v) => onConcept(v as MetricConcept)}
          options={concepts.map((c) => ({ value: c, label: CONCEPT_LABEL[c] }))}
        />
      }
    />
  );
}

// --- Engagement over time -------------------------------------------------------------------------

// Stable per series, whichever are switched on: a line keeps its colour when another is toggled.
const TREND_COLOR: Record<TrendKey, string> = {
  likes: 'hsl(var(--chart-2))',
  comments: 'hsl(var(--chart-3))',
  shares: 'hsl(var(--chart-4))',
  saves: 'hsl(var(--chart-5))',
  clicks: 'hsl(var(--hue-7))',
  follows: 'hsl(var(--hue-3))',
  views: 'hsl(var(--chart-1))',
  reach: 'hsl(var(--hue-8))',
  engagementRate: 'hsl(var(--hue-12))',
};
/** Views and reach run a hundred times the interaction counts: they get the right-hand axis. */
const BIG: readonly TrendKey[] = ['views', 'reach'];
const DEFAULT_TREND: readonly TrendKey[] = ['likes', 'comments', 'saves', 'views'];

/** A line per chosen metric across the period, with each metric's total and change as its toggle. */
export function EngagementTrend({
  report,
  concepts,
}: {
  report: Report;
  concepts: readonly MetricConcept[];
}) {
  const keys: TrendKey[] = [...concepts, 'engagementRate'];
  const [chosen, setChosen] = useState<ReadonlySet<TrendKey>>(new Set(DEFAULT_TREND));
  const on = keys.filter((k) => chosen.has(k));
  const toggle = (key: TrendKey) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const { summary } = report;
  const stat = (key: TrendKey) =>
    key === 'engagementRate'
      ? {
          value: formatRate(summary.engagementRate.rate),
          has: summary.engagementRate.rate !== null,
          delta: summary.engagementRateDeltaPct,
        }
      : {
          value: compact(summary.totals[key].value),
          has: summary.totals[key].value !== null,
          delta: summary.totals[key].deltaPct,
        };
  const label = (key: TrendKey) => (key === 'engagementRate' ? 'Eng. rate' : CONCEPT_LABEL[key]);
  // With no small-number line switched on, the big ones take the left axis themselves.
  const split = on.some((k) => !BIG.includes(k) && k !== 'engagementRate');
  const bucketsWithPosts = report.overTime.filter((b) => b.posts > 0).length;
  const word = bucketWord(report);
  return (
    <Section
      title="Engagement over time"
      subtitle={byPublishDate(report)}
      note={
        <>
          Each point adds up the current all-time totals of the posts published in that {word} — not
          what was gained during it. {word === 'week' ? 'Weeks' : 'Days'} with no posts have no
          point.
          {split && on.some((k) => BIG.includes(k)) && ' Views and reach use the right-hand axis.'}
          {on.includes('engagementRate') &&
            ' Engagement rate is a percentage on its own scale: read its values from the tooltip.'}
        </>
      }
    >
      <div className="grid gap-3 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          {bucketsWithPosts === 0 ? (
            <Insufficient title="No posts published in this period" className="min-h-56">
              A longer period may have some.
            </Insufficient>
          ) : on.length === 0 ? (
            <Insufficient title="No metric selected" className="min-h-56">
              Switch one on to draw it.
            </Insufficient>
          ) : (
            <Chart
              bare
              type="line"
              dots
              gaps
              title={`Engagement over time, by publish ${word}`}
              xKey="bucket"
              xLabel={word === 'day' ? 'Day' : 'Week of'}
              data={trendRows(report.overTime, on)}
              series={on.map((key) => ({
                key,
                label: label(key),
                color: TREND_COLOR[key],
                axis:
                  key === 'engagementRate' ? 'own' : split && BIG.includes(key) ? 'right' : 'left',
                format: key === 'engagementRate' ? formatRate : undefined,
              }))}
            />
          )}
        </div>
        <ul className="grid grid-cols-2 content-start gap-x-3 gap-y-2 sm:grid-cols-3">
          {keys.map((key) => {
            const s = stat(key);
            const checked = chosen.has(key);
            return (
              <li key={key} className="min-w-0">
                <label className="flex cursor-pointer items-start gap-1.5">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(key)}
                    className="mt-0.5 h-3.5 w-3.5 flex-none accent-ink"
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1 text-caption text-muted">
                      <span
                        aria-hidden="true"
                        className="h-0.5 w-3 flex-none"
                        style={{ background: checked ? TREND_COLOR[key] : 'transparent' }}
                      />
                      <span className="truncate">{label(key)}</span>
                    </span>
                    <span className="tnum block text-base font-semibold text-ink">
                      {s.has ? s.value : <NoValue why={`No ${label(key)} reported`} />}
                    </span>
                    <span
                      className={cn(
                        'tnum block text-micro',
                        s.delta === null || s.delta === 0
                          ? 'text-muted'
                          : s.delta > 0
                            ? 'text-status-ok'
                            : 'text-status-bad',
                      )}
                    >
                      {signedPercent(s.delta)}
                      <span className="sr-only"> against the period before</span>
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </div>
    </Section>
  );
}

// --- Best time to post ----------------------------------------------------------------------------

/** Under this many posts a "best time" is one or two posts' luck; the section says so. */
const FEW_POSTS = 10;

export function BestTimes({ report }: { report: Report }) {
  const { bestTimes } = report;
  const by = bestTimes.by;
  const max = Math.max(0, ...bestTimes.cells.map((c) => c.average ?? 0));
  const rank = new Map(bestTimes.top.map((t, i) => [`${t.weekday}:${t.hour}`, i + 1]));
  return (
    <Section
      title="Best time to post"
      subtitle={`Average ${by ?? 'engagements'} per post, by the hour it was published · ${report.timezone}`}
      note={
        by && (
          <>
            From {bestTimes.postsCounted.toLocaleString()}{' '}
            {bestTimes.postsCounted === 1 ? 'post' : 'posts'} published in the period that report{' '}
            {by}. Darker = a higher average; 1–3 mark the best slots.
            {bestTimes.postsCounted < FEW_POSTS &&
              ' With this few posts a slot is one or two posts’ result, not a pattern.'}
            {by === 'views' && ' No post reports engagements, so slots are scored by views.'}
          </>
        )
      }
    >
      {!by || bestTimes.cells.length === 0 ? (
        <Insufficient title="Not enough to say">
          No post published in this period reports engagements or views.
        </Insufficient>
      ) : (
        <>
          <Heatmap
            title={`Average ${by} per post by weekday and hour of publishing, in ${report.timezone}`}
            rows={[...WEEKDAYS]}
            cols={24}
            colLabel={(hour) => (hour % 3 === 0 ? hourLabel(hour) : null)}
            cells={bestTimes.cells.map((c) => ({
              row: c.weekday,
              col: c.hour,
              level: heatLevel(c.average, max),
              mark: rank.has(`${c.weekday}:${c.hour}`)
                ? String(rank.get(`${c.weekday}:${c.hour}`))
                : undefined,
              label:
                c.average === null
                  ? `${slotLabel(c)}: ${c.posts} ${c.posts === 1 ? 'post' : 'posts'}, no ${by} reported`
                  : `${slotLabel(c)}: ${Math.round(c.average).toLocaleString()} ${by} per post on average, from ${c.posts} ${c.posts === 1 ? 'post' : 'posts'}`,
            }))}
          />
          {bestTimes.top.length > 0 ? (
            <p className="mt-2 flex flex-wrap items-center gap-1.5 text-caption text-muted">
              Best times:
              {bestTimes.top.map((t, i) => (
                <Badge key={`${t.weekday}:${t.hour}`} variant="success" className="tnum">
                  {i + 1}. {slotLabel(t)} · {Math.round(t.average).toLocaleString()} avg · {t.posts}{' '}
                  {t.posts === 1 ? 'post' : 'posts'}
                </Badge>
              ))}
            </p>
          ) : (
            <p className="mt-2 text-caption text-muted">
              No slot scored above zero, so none is named.
            </p>
          )}
        </>
      )}
    </Section>
  );
}

// --- Followers ------------------------------------------------------------------------------------

export function FollowerEvolution({ report }: { report: Report }) {
  const selected = report.accounts.filter((a) => a.selected);
  const withScope = new Set(selected.map((a) => a.workspaceId)).size > 1;
  const name = (a: (typeof selected)[number]) =>
    `${a.displayName} · ${platformLabel(a.provider)}${withScope ? ` · ${a.workspaceName}` : ''}`;
  const series = report.followerSeries;
  const charted = selected.filter((a) => series.some((s) => s.connectionId === a.id));
  const rows = followerRows(series);
  const noFollowerMetric = (provider: string) =>
    report.mapping.find((m) => m.provider === provider)?.followers.length === 0;
  const total = report.summary.followers;
  return (
    <Section
      title="Follower evolution"
      subtitle={`Followers per account, the last capture of each day · ${report.timezone}`}
      actions={
        <p className="text-right leading-tight">
          <span className="tnum block text-lg font-semibold text-ink">
            {formatNumber(total.value)}
          </span>
          <span className="block text-micro text-muted">followers total</span>
        </p>
      }
      note={
        charted.length > 0 &&
        'The axis starts near the lowest count, not at zero, so small changes show. Days without a capture are gaps, not carried forward. The history starts when collection began for the account.'
      }
    >
      {selected.length === 0 ? (
        <Insufficient title="No account selected" />
      ) : charted.length === 0 ? (
        <Insufficient title="No follower captures in this period">
          {selected.every((a) => noFollowerMetric(a.provider))
            ? 'The platforms in view report no follower count.'
            : 'Followers are collected once a day from when an account is connected. A longer period may have captures.'}
        </Insufficient>
      ) : (
        <Chart
          bare
          type="line"
          gaps
          fitToData
          dots={rows.length <= 14}
          title="Followers per account over the period"
          xKey="day"
          xLabel="Day"
          data={rows}
          series={charted.map((a) => ({
            key: a.id,
            label: name(a),
            color: platformColor(a.provider),
          }))}
        />
      )}
      {selected.length > 0 && (
        <ul className="mt-2 grid gap-x-6 text-sm sm:grid-cols-2">
          {selected.map((a) => {
            const latest = series.find((s) => s.connectionId === a.id)?.points.at(-1);
            return (
              <li
                key={a.id}
                className="flex min-w-0 items-baseline justify-between gap-3 border-t border-hairline-soft py-1"
              >
                <span className="flex min-w-0 items-center gap-1.5 text-body-ink">
                  <span
                    aria-hidden="true"
                    className="h-0.5 w-3 flex-none"
                    style={{ background: latest ? platformColor(a.provider) : 'transparent' }}
                  />
                  <span className="truncate">{name(a)}</span>
                </span>
                <span className="tnum flex-none font-semibold text-ink">
                  {latest ? (
                    formatNumber(latest.value)
                  ) : (
                    <NoValue
                      why={
                        noFollowerMetric(a.provider)
                          ? `${platformLabel(a.provider)} reports no follower count`
                          : 'No follower captures in this period'
                      }
                    />
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

// --- Content formats ------------------------------------------------------------------------------

const FORMAT = {
  video: { label: 'Video', Icon: Play },
  image: { label: 'Image', Icon: ImageIcon },
  text: { label: 'Text only', Icon: Article },
} as const;

export function FormatBreakdown({ report }: { report: Report }) {
  const { formats } = report;
  const overall = report.summary.engagementRate.rate;
  const max = Math.max(0, ...formats.map((f) => f.engagementRate.rate ?? 0));
  return (
    <Section
      title="Content format breakdown"
      subtitle="Engagement rate by what the post carries"
      actions={
        <p className="tnum text-caption text-muted">
          avg <span className="font-semibold text-ink">{formatRate(overall)}</span>
        </p>
      }
      note={
        formats.length > 0 &&
        'The format is the first media item of the post. “Best” needs two formats with a rate; with a handful of posts it is a hint, not a finding.'
      }
    >
      {formats.length === 0 ? (
        <Insufficient title="No posts published in this period" />
      ) : (
        <ul className="space-y-1.5">
          {formats.map((f) => {
            const { label, Icon } = FORMAT[f.format];
            const rate = f.engagementRate.rate;
            return (
              <li
                key={f.format}
                className={cn(
                  'flex items-center gap-3 rounded-sm border px-3 py-2',
                  f.best ? 'border-status-ok/40 bg-status-ok/10' : 'border-hairline-soft',
                )}
              >
                <span className="grid h-8 w-8 flex-none place-items-center rounded-sm bg-surface-strong text-muted">
                  <Icon size={16} aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                    {label}
                    {f.best && (
                      <Badge variant="success">
                        <Trophy size={10} weight="fill" aria-hidden="true" />
                        Best
                      </Badge>
                    )}
                  </span>
                  <span className="tnum block text-caption text-muted">
                    {f.posts.toLocaleString()} {f.posts === 1 ? 'post' : 'posts'}
                    {f.engagementRate.postsCounted < f.posts &&
                      `, ${f.engagementRate.postsCounted.toLocaleString()} with a rate`}
                    {f.vsAveragePct !== null && ` · ${signedPercent(f.vsAveragePct)} vs avg`}
                  </span>
                </span>
                <span
                  aria-hidden="true"
                  className="hidden h-1.5 w-24 rounded-full bg-surface-strong sm:block"
                >
                  <span
                    className={cn(
                      'block h-full rounded-full',
                      f.best ? 'bg-status-ok' : 'bg-muted-soft',
                    )}
                    style={{ width: `${rate !== null && max > 0 ? (rate / max) * 100 : 0}%` }}
                  />
                </span>
                <span className="tnum w-16 flex-none text-right text-base font-semibold text-ink">
                  {rate === null ? (
                    <NoValue why="No rate: no engagement count or no reach or views" />
                  ) : (
                    formatRate(rate)
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

// --- Posting frequency ----------------------------------------------------------------------------

export function FrequencyVsEngagement({ report }: { report: Report }) {
  const { frequency } = report;
  const comparable = frequency.platforms.filter((p) => p.best !== null);
  // Band labels in order, across the platforms that can be compared.
  const bands = [
    ...new Map(
      comparable
        .flatMap((p) => p.bands)
        .sort((a, b) => a.min - b.min)
        .map((b) => [bandLabel(b), b]),
    ).keys(),
  ];
  const rows: ChartRow[] = bands.map((band) => {
    const row: ChartRow = { band };
    for (const p of comparable) {
      row[p.provider] = p.bands.find((b) => bandLabel(b) === band)?.engagementRate ?? null;
    }
    return row;
  });
  return (
    <Section
      title="Posting frequency vs engagement"
      subtitle={`Engagement rate of the posts of a week, by how many went out in it · ${frequency.fullWeeks} full ${frequency.fullWeeks === 1 ? 'week' : 'weeks'}`}
      note={
        frequency.platforms.length > 0 &&
        'Only whole Monday-to-Sunday weeks inside the period are counted — a partial week would understate its cadence. A higher rate at a cadence is what happened in those weeks, not proof the cadence caused it.'
      }
    >
      {frequency.fullWeeks < 2 ? (
        <Insufficient title="Needs at least two full weeks">
          This period holds {frequency.fullWeeks === 0 ? 'no' : 'one'} whole Monday-to-Sunday week
          {frequency.fullWeeks === 1 ? '' : 's'}. Choose a longer period to compare cadences.
        </Insufficient>
      ) : frequency.platforms.length === 0 ? (
        <Insufficient title="No posts in the full weeks of this period" />
      ) : comparable.length === 0 ? (
        <Insufficient title="Nothing to compare yet">
          Every full week had the same cadence on each platform (or only one cadence has a rate), so
          there is no second point to set it against. The cadences seen are listed below.
        </Insufficient>
      ) : (
        <Chart
          bare
          type="line"
          dots
          gaps
          format={formatRate}
          title="Engagement rate by posts per week, per platform"
          xKey="band"
          xLabel="Posts per week"
          data={rows}
          series={comparable.map((p) => ({
            key: p.provider,
            label: platformLabel(p.provider),
            color: platformColor(p.provider),
          }))}
        />
      )}
      {frequency.fullWeeks >= 2 && frequency.platforms.length > 0 && (
        <ul className="mt-2 space-y-1 text-caption">
          {frequency.platforms.map((p) => (
            <li key={p.provider} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <PlatformName provider={p.provider} className="font-semibold text-ink" />
              {p.bands.map((b, i) => (
                <span
                  key={bandLabel(b)}
                  className={cn(
                    'tnum rounded-full px-2 py-0.5',
                    p.best === i
                      ? 'bg-status-ok/10 font-semibold text-status-ok'
                      : 'bg-surface-strong text-muted',
                  )}
                >
                  {bandLabel(b)} · {formatRate(b.engagementRate)} · {b.weeks}{' '}
                  {b.weeks === 1 ? 'week' : 'weeks'}
                  {p.best === i && <span className="sr-only"> (highest rate)</span>}
                </span>
              ))}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// --- Engagement accumulation ----------------------------------------------------------------------

export function EngagementAccumulation({ report }: { report: Report }) {
  const acc = report.accumulation;
  const { rules } = acc;
  const requirement = `A post qualifies with at least ${rules.minSnapshots} snapshots, the first within ${ageLabel(rules.firstWithinHours)} of publishing, and once it is ${ageLabel(rules.minAgeHours)} old.`;
  const points = acc.points.filter((p) => p.pct !== null);
  return (
    <Section
      title="Engagement accumulation"
      subtitle="How much of a post’s engagement had arrived by each age after publishing"
      note={
        points.length > 0 && (
          <>
            From the stored snapshots of {acc.postsUsed.toLocaleString()} of{' '}
            {acc.postsConsidered.toLocaleString()} posts with engagement in this period.{' '}
            {requirement} Imported posts start with recent snapshots only, so they are left out.
            Each point is the last snapshot taken by that age, never an estimate between two; the
            number of posts old enough is under each age.
          </>
        )
      }
    >
      {points.length === 0 ? (
        <Insufficient title="Not enough snapshots yet">
          {acc.postsConsidered === 0
            ? 'No post published in this period has an engagement count.'
            : `${acc.postsUsed.toLocaleString()} of ${acc.postsConsidered.toLocaleString()} posts with engagement ${acc.postsUsed === 1 ? 'has' : 'have'} enough history; a curve needs ${rules.minPosts}.`}{' '}
          {requirement} Imported posts only have snapshots from after they were imported.
        </Insufficient>
      ) : (
        <>
          <Chart
            bare
            type="line"
            dots
            format={(v) => `${Math.round(v)}%`}
            title="Share of final engagement by age after publishing"
            xKey="age"
            xLabel="Age after publishing"
            data={points.map((p) => ({
              age: `${ageLabel(p.untilHours)} (${p.posts})`,
              share: p.pct,
            }))}
            series={[{ key: 'share', label: 'Share of latest engagement' }]}
          />
          <p className="mt-2 text-caption text-body-ink">
            {acc.halfByHours !== null ? (
              <>
                Half of engagement by <strong>{ageLabel(acc.halfByHours)}</strong>
              </>
            ) : (
              'Half of engagement: not reached at any measured age'
            )}
            {' · '}
            {acc.eightyByHours !== null ? (
              <>
                80% within <strong>{ageLabel(acc.eightyByHours)}</strong>
              </>
            ) : (
              '80%: not reached at any measured age'
            )}
          </p>
        </>
      )}
    </Section>
  );
}
