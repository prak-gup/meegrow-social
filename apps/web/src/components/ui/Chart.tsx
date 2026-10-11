import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface ChartSeries {
  key: string;
  label: string;
  /** A CSS colour; defaults to the --chart-N tokens in order. */
  color?: string;
  /**
   * Which scale the series is drawn against (default `left`). `right` gets its own labelled axis;
   * `own` is scaled to itself with no axis drawn — for one series in a unit the others do not share
   * (a percentage among counts), whose values are then read from the tooltip and the table.
   */
  axis?: 'left' | 'right' | 'own';
  /** How this series' values read in the tooltip and the table, when not like the rest. */
  format?: (value: number) => string;
}

export interface ChartProps {
  type: 'bar' | 'line';
  data: Array<Record<string, string | number | null>>;
  /** Field holding the x-axis category (date, platform, …). */
  xKey: string;
  series: ChartSeries[];
  /** Accessible title: shown above the chart and used as its aria-label. */
  title: string;
  /** Column heading for the x values in the screen-reader table (default: `xKey`). */
  xLabel?: string;
  /** Controls shown beside the title (e.g. a metric picker). */
  actions?: ReactNode;
  /** Rendered under the plot, inside the frame (e.g. a values list). */
  footer?: ReactNode;
  /**
   * The series key under the title when there is more than one series (default true). Turn it off
   * when the `footer` already names every series beside its colour.
   */
  legend?: boolean;
  /** Line charts: mark each data point. Needed when a series may have a single point. */
  dots?: boolean;
  /** Bar charts: draw the series as segments of one bar per x value instead of side by side. */
  stacked?: boolean;
  /**
   * Bar charts: print a number above each bar. The row field holding it (for a stack, its total);
   * rows where it is null get no label.
   */
  totalKey?: string;
  /** How values read on the axis, in the tooltip and in the table (default: locale number). */
  format?: (value: number) => string;
  /**
   * Start the value axis at the data's own low end instead of zero. For a line whose change is
   * small against its size (followers), which a zero-based axis would flatten.
   */
  fitToData?: boolean;
  /** Leave gaps in a line where a value is null instead of bridging them (default: bridge). */
  gaps?: boolean;
  /**
   * Draw only the plot (with its text alternative): no frame, title row or key. For a chart that
   * sits inside a card with controls of its own. `title` still names it for assistive tech.
   */
  bare?: boolean;
  /** Tailwind height class for the plot area (default `h-64`); width is always responsive. */
  plotClassName?: string;
  className?: string;
}

const SERIES_TOKENS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
];
/** The colour series `index` is drawn in when it sets none — for a caller's own legend or list. */
export const chartColor = (index: number): string => SERIES_TOKENS[index % SERIES_TOKENS.length]!;
const GRID = 'hsl(var(--hairline-soft))';
const AXIS = 'hsl(var(--muted))';
const LABEL = 'hsl(var(--ink))';
// recharts takes numbers/inline styles for these (no className hook); mirrors the radius/type tokens.
const TICK_FONT_SIZE = '0.75rem'; // = text-xs
const TOOLTIP_FONT_SIZE = '0.8125rem'; // = text-caption
const TOOLTIP_RADIUS = '0.5rem'; // = rounded-sm
const Y_AXIS_WIDTH = 44; // px: fits 5-digit tick labels without clipping
const PLOT_MARGIN = { top: 8, right: 8, bottom: 0, left: 0 }; // px: keeps edge ticks/strokes unclipped
const BAR_RADIUS: [number, number, number, number] = [4, 4, 0, 0]; // px: = rounded-xs on the top corners
const LINE_WIDTH = 2; // px
const TOTAL_LABEL_ROOM = 20; // px: one line of tick-sized text above the plot
/** The series drawn on top of a row's stack: the last one with a value above zero. */
function topSegment(row: Record<string, unknown>, series: ChartSeries[]): string | undefined {
  return [...series].reverse().find((s) => typeof row[s.key] === 'number' && row[s.key] !== 0)?.key;
}
// Lines differ by dash pattern as well as colour, so a series is never identified by colour alone.
const LINE_DASHES = [undefined, '6 3', '2 3', '8 3 2 3'];
const compact = (v: unknown) =>
  typeof v === 'number' ? v.toLocaleString(undefined, { notation: 'compact' }) : String(v);
const full = (v: unknown) => (typeof v === 'number' ? v.toLocaleString() : String(v));
const AXIS_PROPS = {
  stroke: AXIS,
  tickLine: false,
  axisLine: false,
  fontSize: TICK_FONT_SIZE,
} as const;

/** Responsive bar/line chart in token colours. Ships a screen-reader data table alongside. */
export function Chart({
  type,
  data,
  xKey,
  series,
  title,
  xLabel,
  actions,
  footer,
  legend = true,
  dots = false,
  stacked = false,
  totalKey,
  format,
  gaps = false,
  fitToData = false,
  bare = false,
  plotClassName = 'h-56',
  className,
}: ChartProps) {
  const colorOf = (s: ChartSeries, i: number) => s.color ?? chartColor(i);
  const formatOf = (key: unknown) => series.find((s) => s.key === key)?.format ?? format ?? full;
  const show = (value: unknown, key: unknown) =>
    typeof value === 'number' ? formatOf(key)(value) : String(value);
  const hasRight = series.some((s) => s.axis === 'right');
  const hasOwn = series.some((s) => s.axis === 'own');
  const common = {
    data,
    // A total printed above the tallest bar needs the headroom.
    margin: totalKey ? { ...PLOT_MARGIN, top: TOTAL_LABEL_ROOM } : PLOT_MARGIN,
  };
  const axes = (
    <>
      <CartesianGrid stroke={GRID} vertical={false} />
      <XAxis dataKey={xKey} {...AXIS_PROPS} />
      <YAxis
        yAxisId="left"
        width={Y_AXIS_WIDTH}
        domain={fitToData ? ['auto', 'auto'] : undefined}
        // Compact ticks ("2.4k") cannot tell apart the close values a fitted axis exists to show.
        tickFormatter={format ? (v: unknown) => show(v, null) : fitToData ? full : compact}
        allowDecimals={format !== undefined}
        {...AXIS_PROPS}
      />
      {hasRight && (
        <YAxis
          yAxisId="right"
          orientation="right"
          width={Y_AXIS_WIDTH}
          tickFormatter={compact}
          {...AXIS_PROPS}
        />
      )}
      {hasOwn && <YAxis yAxisId="own" hide />}
      <Tooltip
        formatter={(value: unknown, _name: unknown, item: { dataKey?: unknown }) =>
          show(value, item.dataKey)
        }
        cursor={{ fill: 'hsl(var(--surface-soft))' }}
        contentStyle={{
          border: '1px solid hsl(var(--hairline))',
          borderRadius: TOOLTIP_RADIUS,
          boxShadow: 'var(--shadow-1)',
          fontSize: TOOLTIP_FONT_SIZE,
        }}
      />
    </>
  );
  return (
    // min-w-0: as a grid or flex item the figure must be allowed to shrink below the plot's width.
    <figure
      className={cn(
        'min-w-0',
        !bare && 'rounded-md border border-hairline bg-canvas p-3',
        className,
      )}
    >
      {!bare && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <figcaption className="text-body font-semibold text-ink">{title}</figcaption>
          {actions}
        </div>
      )}
      {/* Our own key, above the plot: recharts' legend floats under it and wraps unpredictably. */}
      {!bare && legend && series.length > 1 && (
        <ul aria-hidden="true" className="mb-2 flex flex-wrap gap-x-4 gap-y-1">
          {series.map((s, i) => (
            <li key={s.key} className="flex min-w-0 items-center gap-1.5 text-caption text-muted">
              <span
                className={cn('flex-none', type === 'line' ? 'h-0.5 w-3' : 'h-2 w-2 rounded-full')}
                style={{ background: colorOf(s, i) }}
              />
              <span className="truncate">{s.label}</span>
            </li>
          ))}
        </ul>
      )}
      <div role="img" aria-label={title} className={plotClassName}>
        <ResponsiveContainer width="100%" height="100%">
          {type === 'bar' ? (
            <BarChart {...common}>
              {axes}
              {series.map((s, i) => (
                <Bar
                  key={s.key}
                  yAxisId="left"
                  dataKey={s.key}
                  name={s.label}
                  fill={colorOf(s, i)}
                  stackId={stacked ? 'stack' : undefined}
                  radius={stacked ? undefined : BAR_RADIUS}
                >
                  {totalKey && (
                    <LabelList
                      position="top"
                      fill={LABEL}
                      fontSize={TICK_FONT_SIZE}
                      // In a stack only the segment on top carries the bar's number.
                      valueAccessor={(entry: { payload?: Record<string, unknown> }) => {
                        const row = entry.payload ?? {};
                        const total = row[totalKey];
                        if (typeof total !== 'number') return undefined;
                        if (stacked && topSegment(row, series) !== s.key) return undefined;
                        return show(total, null);
                      }}
                    />
                  )}
                </Bar>
              ))}
            </BarChart>
          ) : (
            <LineChart {...common}>
              {axes}
              {series.map((s, i) => (
                <Line
                  key={s.key}
                  yAxisId={s.axis ?? 'left'}
                  dataKey={s.key}
                  name={s.label}
                  stroke={colorOf(s, i)}
                  strokeWidth={LINE_WIDTH}
                  strokeDasharray={LINE_DASHES[i % LINE_DASHES.length]}
                  dot={dots}
                  connectNulls={!gaps}
                />
              ))}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
      {/* The wrapper is what is visually hidden: a <table> ignores the 1px width `sr-only` sets
          and would stretch the page sideways on a phone. */}
      <div className="sr-only">
        <table>
          <caption>{title}</caption>
          <thead>
            <tr>
              <th scope="col">{xLabel ?? xKey}</th>
              {series.map((s) => (
                <th key={s.key} scope="col">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row, i) => (
              <tr key={i}>
                <th scope="row">{row[xKey]}</th>
                {series.map((s) => (
                  <td key={s.key}>{row[s.key] == null ? '—' : show(row[s.key], s.key)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footer}
    </figure>
  );
}
