import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

// Airbnb DLS buttons: Rausch primary (scarce), white+ink-outline secondary, ghost. 8px radius.
// Destructive is reserved strictly for irreversible actions — most "cancel"-style actions use ghost.
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-60',
  {
    variants: {
      variant: {
        default: 'bg-rausch text-white hover:bg-rausch-active',
        destructive: 'bg-error text-white hover:opacity-90',
        outline: 'border border-ink bg-canvas text-ink hover:bg-surface-soft',
        secondary: 'border border-ink bg-canvas text-ink hover:bg-surface-soft',
        ghost: 'bg-transparent text-ink hover:bg-surface-soft',
      },
      size: {
        default: 'h-11 px-4.5 text-body',
        sm: 'h-9 px-3 text-sm',
        icon: 'h-11 w-11 rounded-full',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
    );
  },
);
Button.displayName = 'Button';
