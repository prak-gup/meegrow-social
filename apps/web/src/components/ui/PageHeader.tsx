import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Right-aligned actions (buttons, view toggles). Wraps below the title on narrow screens. */
  actions?: ReactNode;
  className?: string;
}

/** The one page-header pattern: title + subtitle on the left, actions on the right. */
export function PageHeader({ title, subtitle, actions, className }: PageHeaderProps) {
  return (
    <header
      className={cn('mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2', className)}
    >
      <div className="min-w-0">
        <h1 className="text-title font-semibold text-ink">{title}</h1>
        {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
