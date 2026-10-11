import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

/** Native <select> styled to match the input primitives — accessible + reliable, no extra deps. */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        'flex h-11 w-full rounded-sm border border-muted-soft bg-canvas px-2.5 text-lg text-ink focus:border-ink focus:outline-none focus:ring-1 focus:ring-ink disabled:opacity-60 md:h-8 md:text-sm',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  ),
);
Select.displayName = 'Select';
