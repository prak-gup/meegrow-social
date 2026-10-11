import { cn } from '../../lib/cn';

/** A placeholder block for content that is still loading. Size it with the classes of what it stands in for. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn('animate-pulse rounded-sm bg-surface-strong', className)}
    />
  );
}
