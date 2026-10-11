import { cn } from '../../lib/cn';

export interface HeatmapCell {
  row: number;
  col: number;
  /** 0 (empty) to 4 (strongest): how deeply the cell is shaded. */
  level: 0 | 1 | 2 | 3 | 4;
  /** What the cell says in words — its tooltip and its line in the text alternative. */
  label: string;
  /** A short mark drawn in the cell (a rank), so the best cells are not told by shade alone. */
  mark?: string;
}

export interface HeatmapProps {
  /** Accessible name. */
  title: string;
  /** Row names, top to bottom. */
  rows: string[];
  /** Column count, and the names drawn under the columns that have one. */
  cols: number;
  colLabel: (col: number) => string | null;
  /** Only the cells with something in them; the rest are drawn empty. */
  cells: HeatmapCell[];
  className?: string;
}

const SHADE = [
  'bg-surface-strong',
  'bg-status-ok/20',
  'bg-status-ok/40',
  'bg-status-ok/70',
  'bg-status-ok',
] as const;

/**
 * A rows × columns grid shaded by value (a weekday × hour map). The picture is decorative: every
 * non-empty cell is also a row of a screen-reader table, and `mark` puts a rank inside the cells
 * that matter most. The columns share the width, so it fits a phone without scrolling.
 * Usage: <Heatmap title="…" rows={DAYS} cols={24} colLabel={hour} cells={cells} />
 */
export function Heatmap({ title, rows, cols, colLabel, cells, className }: HeatmapProps) {
  const at = new Map(cells.map((c) => [`${c.row}:${c.col}`, c]));
  const columns = { gridTemplateColumns: `auto repeat(${cols}, minmax(0, 1fr))` };
  return (
    <div className={cn('min-w-0', className)}>
      <div role="img" aria-label={title} className="grid gap-0.5" style={columns}>
        {rows.map((name, row) => (
          <div key={name} className="contents">
            <span className="pr-1.5 text-right text-micro leading-4 text-muted">{name}</span>
            {Array.from({ length: cols }, (_, col) => {
              const cell = at.get(`${row}:${col}`);
              return (
                <span
                  key={col}
                  title={cell?.label}
                  className={cn(
                    'grid h-4 min-w-0 place-items-center rounded-xs text-micro font-semibold leading-none',
                    SHADE[cell?.level ?? 0],
                    (cell?.level ?? 0) >= 3 ? 'text-white' : 'text-ink',
                  )}
                >
                  {cell?.mark}
                </span>
              );
            })}
          </div>
        ))}
        <span />
        {Array.from({ length: cols }, (_, col) => (
          // A name is wider than its column: it overflows to the right over the unnamed ones.
          <span key={col} className="relative h-4 min-w-0 text-micro text-muted">
            <span className="absolute left-0 top-0.5 whitespace-nowrap">{colLabel(col)}</span>
          </span>
        ))}
      </div>
      <div className="sr-only">
        <table>
          <caption>{title}</caption>
          <tbody>
            {cells.map((c) => (
              <tr key={`${c.row}:${c.col}`}>
                <td>{c.label}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
