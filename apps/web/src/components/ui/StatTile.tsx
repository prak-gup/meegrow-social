import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import type { IconComponent } from '../../lib/icons';
import { ArrowDown, ArrowUp } from '../../lib/icons';

export interface StatTileProps {
  label: string;
  value: ReactNode;
  /** Change vs the prior period, as a percentage (e.g. 12.5 = +12.5%). Omit to hide. */
  delta?: number | null;
  /** For metrics where down is good (failures, errors): flips the up/down colouring. */
  invertDelta?: boolean;
  deltaLabel?: string;
  /** Render a muted "—" in the delta slot when there is no prior value, instead of leaving it empty. */
  showMissingDelta?: boolean;
  /** How the number is defined, shown on hover. */
  hint?: string;
  icon?: IconComponent;
  className?: string;
}

/** A single KPI: label, big tabular value, optional delta vs prior with up/down colour. */
export function StatTile({
  label,
  value,
  delta,
  invertDelta = false,
  deltaLabel = 'vs prior',
  showMissingDelta = false,
  hint,
  icon: Icon,
  className,
}: StatTileProps) {
  const hasDelta = delta != null && Number.isFinite(delta);
  const up = hasDelta && delta > 0;
  const flat = hasDelta && delta === 0;
  const good = up !== invertDelta;
  const DeltaIcon = up ? ArrowUp : ArrowDown;
  return (
    <div className={cn('rounded-md border border-hairline bg-canvas p-3', className)} title={hint}>
      <div className="flex items-center justify-between gap-2 text-caption font-medium text-muted">
        {/* One line: a long metric name must not make one tile taller than its neighbours. */}
        <span className="min-w-0 truncate" title={label}>
          {label}
        </span>
        {Icon && <Icon size={16} className="flex-none" />}
      </div>
      <div className="tnum mt-0.5 text-2xl font-semibold text-ink">{value}</div>
      {hasDelta && (
        <div
          className={cn(
            'tnum mt-0.5 flex items-center gap-1 whitespace-nowrap text-caption font-medium',
            flat ? 'text-muted' : good ? 'text-status-ok' : 'text-status-bad',
          )}
        >
          {!flat && <DeltaIcon size={12} weight="bold" aria-hidden="true" />}
          {!flat && <span className="sr-only">{up ? 'Up ' : 'Down '}</span>}
          {Math.abs(delta).toLocaleString(undefined, { maximumFractionDigits: 1 })}%
          <span className="font-normal text-muted">{deltaLabel}</span>
        </div>
      )}
      {!hasDelta && showMissingDelta && (
        <div className="mt-0.5 flex items-center gap-1 text-caption text-muted">
          <span aria-hidden="true">—</span>
          <span className="sr-only">No comparison</span>
          <span>{deltaLabel}</span>
        </div>
      )}
    </div>
  );
}
