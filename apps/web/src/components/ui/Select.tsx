import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

/** Native <select> styled to match the input primitives — accessible + reliable, no extra deps. */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        'flex h-11 w-full rounded-sm border border-hairline bg-canvas px-3.5 text-[15px] text-ink focus:border-2 focus:border-ink focus:outline-none disabled:opacity-60',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  ),
);
Select.displayName = 'Select';
