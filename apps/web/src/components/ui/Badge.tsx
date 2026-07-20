import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

// Status chips through semantic tokens (not raw Tailwind pastels). White pill + colored dot/text,
// so status reads at a glance without competing with the Rausch accent or client hues.
const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border border-hairline bg-canvas px-2.5 py-1 text-xs font-semibold',
  {
    variants: {
      variant: {
        neutral: 'text-muted',
        success: 'text-status-ok',
        warning: 'text-status-warn',
        danger: 'text-status-bad',
        info: 'text-ink',
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
