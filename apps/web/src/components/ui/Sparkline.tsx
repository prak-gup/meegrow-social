import { Line, LineChart, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { cn } from '../../lib/cn';

export interface SparklineProps {
  /** Oldest first. `at` is epoch ms, so uneven capture intervals keep their real spacing. */
  points: Array<{ at: number; value: number }>;
  /** Text alternative: say what the line shows (metric, range, number of points). */
  label: string;
  className?: string;
}

/** A small axis-less trend line. Decorative by nature, so the caller's `label` carries the meaning. */
export function Sparkline({ points, label, className }: SparklineProps) {
  return (
    <div role="img" aria-label={label} className={cn('h-8 w-full', className)}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
          <XAxis dataKey="at" type="number" domain={['dataMin', 'dataMax']} hide />
          <YAxis domain={['dataMin', 'dataMax']} hide />
          <Line
            dataKey="value"
            stroke="hsl(var(--chart-1))"
            strokeWidth={1.5}
            // A single capture has no line to draw; show it as a point.
            dot={points.length === 1}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
