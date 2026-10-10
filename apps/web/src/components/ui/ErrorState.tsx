import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { WarningCircle } from '../../lib/icons';
import { Button } from './Button';

export interface ErrorStateProps {
  title?: string;
  /** What went wrong, in words the operator can act on. */
  message?: ReactNode;
  onRetry?: () => void;
  className?: string;
}

/** A failed load. role="alert" so assistive tech announces it. */
export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center rounded-md border border-status-bad/30 bg-status-bad/5 px-5 py-10 text-center',
        className,
      )}
    >
      <WarningCircle size={28} className="mb-3 text-status-bad" />
      <p className="text-body font-medium text-ink">{title}</p>
      {message && <p className="mt-1 max-w-md text-sm text-muted">{message}</p>}
      {onRetry && (
        <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
