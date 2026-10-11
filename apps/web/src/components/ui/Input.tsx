import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

// 16px text below `md` keeps iOS from zooming on focus; 32px control from `md` up.
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'flex h-11 w-full rounded-sm border border-muted-soft bg-canvas px-3 text-lg text-ink transition-colors placeholder:text-muted focus:border-ink focus:outline-none focus:ring-1 focus:ring-ink disabled:opacity-60 md:h-8 md:text-sm',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
