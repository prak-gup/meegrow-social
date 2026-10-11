import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import type { IconComponent } from '../../lib/icons';

export interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  icon?: IconComponent;
  /** A call to action, typically a <Button>. */
  action?: ReactNode;
  className?: string;
}

/** "Nothing here yet" — dashed, quiet, with an optional next step. */
export function EmptyState({ title, description, icon: Icon, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center rounded-md border border-dashed border-hairline-strong bg-surface-soft px-4 py-8 text-center',
        className,
      )}
    >
      {Icon && <Icon size={24} className="mb-2 text-muted" />}
      <p className="text-sm font-medium text-ink">{title}</p>
      {description && <p className="mt-1 max-w-md text-caption text-muted">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
