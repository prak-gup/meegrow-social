import { cn } from '../../lib/cn';
import { CHIP, type ChipStatus } from '../../lib/statusChip';
import { Badge } from './Badge';

export interface StatusChipProps {
  status: ChipStatus;
  /** Replace the stock words (e.g. "3 failed") while keeping the status's colour. */
  label?: string;
  className?: string;
}

/**
 * The one status chip: a tinted pill with a dot and the status in words. Use it everywhere a
 * connection, client or post status is shown so the size and colour never drift between pages.
 * Usage: <StatusChip status="needs_reconnect" />   <StatusChip status="failed" label="3 failed" />
 */
export function StatusChip({ status, label, className }: StatusChipProps) {
  const { label: stock, tone } = CHIP[status];
  return (
    <Badge variant={tone} className={cn('whitespace-nowrap', className)}>
      <span aria-hidden="true" className={cn('h-1.5 w-1.5 flex-none rounded-full bg-current')} />
      {label ?? stock}
    </Badge>
  );
}
