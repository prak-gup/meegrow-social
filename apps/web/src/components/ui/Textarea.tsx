import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      'flex min-h-textarea w-full rounded-sm border border-muted-soft bg-canvas px-3 py-2 text-lg text-ink placeholder:text-muted focus:border-ink focus:outline-none focus:ring-1 focus:ring-ink disabled:opacity-60 md:text-sm',
      className,
    )}
    {...props}
  />
));
Textarea.displayName = 'Textarea';
