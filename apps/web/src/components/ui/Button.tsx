import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

// Density: 32px controls from `md` up, 44px touch targets below it. `default` is a neutral ink
// button. `accent` is the single pink call to action: use it once per screen (the shell's Create
// post), never for ordinary page actions. Destructive is reserved for irreversible actions.
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-60',
  {
    variants: {
      variant: {
        default: 'bg-ink text-white hover:bg-body-ink',
        accent: 'bg-rausch text-white hover:bg-rausch-active',
        destructive: 'bg-error text-white hover:opacity-90',
        outline: 'border border-hairline-strong bg-canvas text-ink hover:bg-surface-soft',
        secondary: 'border border-hairline-strong bg-canvas text-ink hover:bg-surface-soft',
        ghost: 'bg-transparent text-ink hover:bg-surface-strong',
      },
      size: {
        default: 'h-11 px-4 text-base md:h-8 md:px-3 md:text-sm',
        sm: 'h-11 px-3 text-base md:h-7 md:px-2.5 md:text-xs',
        lg: 'h-11 px-4 text-base md:h-9 md:px-4 md:text-sm',
        icon: 'h-11 w-11 rounded-sm md:h-8 md:w-8',
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
