import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
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
  /** Line charts: mark each data point. Needed when a series may have a single point. */
  dots?: boolean;
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
const GRID = 'hsl(var(--hairline-soft))';
const AXIS = 'hsl(var(--muted))';
// recharts takes numbers/inline styles for these (no className hook); mirrors the radius/type tokens.
const TICK_FONT_SIZE = '0.75rem'; // = text-xs
const TOOLTIP_FONT_SIZE = '0.8125rem'; // = text-caption
const TOOLTIP_RADIUS = '0.5rem'; // = rounded-sm
const Y_AXIS_WIDTH = 44; // px: fits 5-digit tick labels without clipping
const PLOT_MARGIN = { top: 8, right: 8, bottom: 0, left: 0 }; // px: keeps edge ticks/strokes unclipped
const BAR_RADIUS: [number, number, number, number] = [4, 4, 0, 0]; // px: = rounded-xs on the top corners
const LINE_WIDTH = 2; // px
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
  dots = false,
  plotClassName = 'h-64',
  className,
}: ChartProps) {
  const colorOf = (s: ChartSeries, i: number) =>
    s.color ?? SERIES_TOKENS[i % SERIES_TOKENS.length]!;
  const common = { data, margin: PLOT_MARGIN };
  const axes = (
    <>
      <CartesianGrid stroke={GRID} vertical={false} />
      <XAxis dataKey={xKey} {...AXIS_PROPS} />
      <YAxis width={Y_AXIS_WIDTH} tickFormatter={compact} {...AXIS_PROPS} />
      <Tooltip
        formatter={full}
        cursor={{ fill: 'hsl(var(--surface-soft))' }}
        contentStyle={{
          border: '1px solid hsl(var(--hairline))',
          borderRadius: TOOLTIP_RADIUS,
          boxShadow: 'var(--shadow-1)',
          fontSize: TOOLTIP_FONT_SIZE,
        }}
      />
      {series.length > 1 && <Legend iconType={type === 'line' ? 'plainline' : 'circle'} />}
    </>
  );
  return (
    <figure className={cn('rounded-md border border-hairline bg-canvas p-4', className)}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <figcaption className="text-body font-semibold text-ink">{title}</figcaption>
        {actions}
      </div>
      <div role="img" aria-label={title} className={plotClassName}>
        <ResponsiveContainer width="100%" height="100%">
          {type === 'bar' ? (
            <BarChart {...common}>
              {axes}
              {series.map((s, i) => (
                <Bar
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  fill={colorOf(s, i)}
                  radius={BAR_RADIUS}
                />
              ))}
            </BarChart>
          ) : (
            <LineChart {...common}>
              {axes}
              {series.map((s, i) => (
                <Line
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  stroke={colorOf(s, i)}
                  strokeWidth={LINE_WIDTH}
                  strokeDasharray={LINE_DASHES[i % LINE_DASHES.length]}
                  dot={dots}
                  connectNulls
                />
              ))}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
      <table className="sr-only">
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
                <td key={s.key}>{row[s.key] ?? '—'}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {footer}
    </figure>
  );
}
