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
  icon: Icon,
  className,
}: StatTileProps) {
  const hasDelta = delta != null && Number.isFinite(delta);
  const up = hasDelta && delta > 0;
  const flat = hasDelta && delta === 0;
  const good = up !== invertDelta;
  const DeltaIcon = up ? ArrowUp : ArrowDown;
  return (
    <div className={cn('rounded-md border border-hairline bg-canvas p-4', className)}>
      <div className="flex items-center justify-between gap-2 text-caption font-semibold text-muted">
        <span>{label}</span>
        {Icon && <Icon size={18} className="flex-none" />}
      </div>
      <div className="tnum mt-1 text-title font-semibold text-ink">{value}</div>
      {hasDelta && (
        <div
          className={cn(
            'tnum mt-1 flex items-center gap-1 text-caption font-semibold',
            flat ? 'text-muted' : good ? 'text-status-ok' : 'text-status-bad',
          )}
        >
          {!flat && <DeltaIcon size={12} weight="bold" aria-hidden="true" />}
          {Math.abs(delta).toLocaleString(undefined, { maximumFractionDigits: 1 })}%
          <span className="font-normal text-muted">{deltaLabel}</span>
        </div>
      )}
    </div>
  );
}
