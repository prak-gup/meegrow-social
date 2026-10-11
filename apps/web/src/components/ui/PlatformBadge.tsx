import { cn } from '../../lib/cn';
import { platformMeta } from '../../lib/platforms';

export interface PlatformBadgeProps {
  /** Provider identifier, e.g. "instagram". */
  provider: string;
  /** The account's name: its first letter is the avatar. */
  name: string;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * An account's avatar (its initial) with a small platform-coloured badge on the corner. Platform
 * colour lives only here; everything else in a row stays neutral.
 * Usage: <PlatformBadge provider="instagram" name="Acme Official" />
 */
export function PlatformBadge({ provider, name, size = 'md', className }: PlatformBadgeProps) {
  const m = platformMeta({ identifier: provider, displayName: provider });
  const dim = size === 'sm' ? 'h-6 w-6 text-xs' : 'h-8 w-8 text-sm';
  const mark = size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5';
  return (
    <span className={cn('relative inline-flex flex-none', className)}>
      <span
        aria-hidden="true"
        className={cn(
          'grid place-items-center rounded-md bg-surface-strong font-semibold text-body-ink',
          dim,
        )}
      >
        {(name.trim()[0] ?? '?').toUpperCase()}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          'absolute -bottom-1 -right-1 grid place-items-center rounded-full text-white ring-2 ring-canvas',
          mark,
          m.brand,
        )}
      >
        <m.Icon size={size === 'sm' ? 8 : 9} weight="fill" />
      </span>
      <span className="sr-only">{m.label}</span>
    </span>
  );
}
