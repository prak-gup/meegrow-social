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
  /** Plot height in px; width is always responsive. */
  height?: number;
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
const AXIS_PROPS = {
  stroke: AXIS,
  tickLine: false,
  axisLine: false,
  fontSize: 12,
} as const;

/** Responsive bar/line chart in token colours. Ships a screen-reader data table alongside. */
export function Chart({ type, data, xKey, series, title, height = 260, className }: ChartProps) {
  const colorOf = (s: ChartSeries, i: number) =>
    s.color ?? SERIES_TOKENS[i % SERIES_TOKENS.length]!;
  const common = { data, margin: { top: 8, right: 8, bottom: 0, left: 0 } };
  const axes = (
    <>
      <CartesianGrid stroke={GRID} vertical={false} />
      <XAxis dataKey={xKey} {...AXIS_PROPS} />
      <YAxis width={44} {...AXIS_PROPS} />
      <Tooltip
        cursor={{ fill: 'hsl(var(--surface-soft))' }}
        contentStyle={{
          border: '1px solid hsl(var(--hairline))',
          borderRadius: 8,
          boxShadow: 'var(--shadow-1)',
          fontSize: 13,
        }}
      />
      {series.length > 1 && <Legend iconType="circle" />}
    </>
  );
  return (
    <figure className={cn('rounded-md border border-hairline bg-canvas p-4', className)}>
      <figcaption className="mb-3 text-body font-semibold text-ink">{title}</figcaption>
      <div role="img" aria-label={title} style={{ height }}>
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
                  radius={[4, 4, 0, 0]}
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
                  strokeWidth={2}
                  dot={false}
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
            <th scope="col">{xKey}</th>
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
    </figure>
  );
}
