import { useId } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { compact, formatNumber } from '../../lib/analyticsReport';

export const friendlyDay = (day: string) =>
  new Date(`${day}T12:00:00Z`)
    .toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    })
    .replace('Sept', 'Sep');
export interface Series {
  key: string;
  label: string;
  color: string;
}
/** All missing values remain gaps. An exact, screen-reader table accompanies every plot. */
export function Plot({
  rows,
  series,
  title,
  bars = false,
  spark = false,
  percent = false,
  fitted = false,
  tall = false,
}: {
  rows: Array<Record<string, string | number | null>>;
  series: Series[];
  title: string;
  bars?: boolean;
  spark?: boolean;
  percent?: boolean;
  fitted?: boolean;
  tall?: boolean;
}) {
  const id = useId().replace(/:/g, '');
  const axes = spark ? (
    <YAxis hide domain={fitted ? ['auto', 'auto'] : [0, 'auto']} />
  ) : (
    <>
      <CartesianGrid vertical={false} stroke="hsl(var(--hairline-soft))" strokeDasharray="3 3" />
      <XAxis
        dataKey="date"
        tickLine={false}
        axisLine={false}
        tick={{ fill: 'hsl(var(--muted))', fontSize: 11 }}
        minTickGap={24}
      />
      <YAxis
        width={44}
        tickLine={false}
        axisLine={false}
        domain={fitted ? ['auto', 'auto'] : undefined}
        tick={{ fill: 'hsl(var(--muted))', fontSize: 11 }}
        tickFormatter={(n) => (percent ? `${n}%` : compact(n))}
      />
      <Tooltip
        filterNull={false}
        formatter={(value, name) => [
          typeof value === 'number'
            ? percent
              ? `${value.toFixed(2)}%`
              : formatNumber(value)
            : '—',
          name ?? '',
        ]}
        contentStyle={{ borderRadius: 12, border: '1px solid hsl(var(--hairline))', fontSize: 12 }}
      />
    </>
  );
  return (
    <figure className="min-w-0">
      <div
        role="img"
        aria-label={title}
        className={spark ? 'h-12' : tall ? 'h-60 md:h-72' : 'h-52 md:h-60'}
      >
        <ResponsiveContainer width="100%" height="100%">
          {bars ? (
            <BarChart data={rows} margin={{ top: 12, right: 8, bottom: 0, left: 0 }}>
              {axes}
              {series.map((s) => (
                <Bar
                  key={s.key}
                  name={s.label}
                  dataKey={s.key}
                  stackId="platform"
                  fill={s.color}
                  radius={[4, 4, 0, 0]}
                  maxBarSize={36}
                  isAnimationActive={false}
                />
              ))}
            </BarChart>
          ) : (
            <AreaChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <defs>
                {series.map((s, i) => (
                  <linearGradient key={s.key} id={`${id}-${i}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={s.color} stopOpacity={0.18} />
                    <stop offset="100%" stopColor={s.color} stopOpacity={0.01} />
                  </linearGradient>
                ))}
              </defs>
              {axes}
              {series.map((s, i) => (
                <Area
                  key={s.key}
                  type="linear"
                  name={s.label}
                  dataKey={s.key}
                  stroke={s.color}
                  strokeWidth={2}
                  strokeDasharray={i ? '5 3' : undefined}
                  fill={`url(#${id}-${i})`}
                  connectNulls={false}
                  dot={spark ? false : { r: 2 }}
                  isAnimationActive={false}
                />
              ))}
            </AreaChart>
          )}
        </ResponsiveContainer>
      </div>
      <div className="sr-only">
        <table>
          <caption>{title}</caption>
          <thead>
            <tr>
              <th>Date</th>
              {series.map((s) => (
                <th key={s.key}>{s.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <th>{r.date}</th>
                {series.map((s) => (
                  <td key={s.key}>{r[s.key] == null ? '—' : String(r[s.key])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
