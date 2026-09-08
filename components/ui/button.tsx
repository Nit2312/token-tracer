'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-glow)] disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98] select-none cursor-pointer',
  {
    variants: {
      variant: {
        default:
          'bg-[var(--raised)] text-[var(--ink)] border border-[var(--border)] hover:bg-[var(--surface)] hover:border-[var(--border-bright)] hover:text-white shadow-sm',
        primary:
          'bg-gradient-to-r from-[var(--brand-hi)] to-[var(--brand)] text-[var(--brand-ink)] font-semibold shadow-md shadow-[rgba(226,163,85,0.25)] hover:brightness-105 hover:shadow-[rgba(226,163,85,0.38)]',
        copper:
          'bg-[var(--brand-dim)] text-[var(--brand-hi)] border border-[rgba(226,163,85,0.3)] hover:bg-[rgba(226,163,85,0.2)] hover:border-[var(--brand)] font-semibold',
        outline:
          'border border-[var(--border)] bg-transparent hover:bg-[var(--wash)] text-[var(--ink)]',
        ghost:
          'hover:bg-[var(--wash)] hover:text-[var(--ink)] text-[var(--muted)]',
        destructive:
          'bg-[rgba(239,68,68,0.15)] text-[#ef4444] border border-[rgba(239,68,68,0.3)] hover:bg-[rgba(239,68,68,0.25)]',
      },
      size: {
        default: 'h-8 px-3.5 py-1.5',
        sm: 'h-7 rounded-md px-2.5 text-[11px]',
        lg: 'h-10 rounded-xl px-5 text-sm',
        icon: 'h-8 w-8',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
