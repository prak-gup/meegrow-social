import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

// The one chip look: 20px (grows if the text wraps), tinted by tone, text at >= 4.5:1 on its own tint. StatusChip maps the
// domain statuses onto these tones so every page shows a status the same way.
export const badgeVariants = cva(
  'inline-flex min-h-5 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
  {
    variants: {
      variant: {
        neutral: 'bg-surface-strong text-muted',
        success: 'bg-status-ok/10 text-status-ok',
        warning: 'bg-status-warn/10 text-status-warn',
        danger: 'bg-status-bad/10 text-status-bad',
        info: 'bg-surface-strong text-ink',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
