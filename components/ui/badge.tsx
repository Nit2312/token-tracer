import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors select-none',
  {
    variants: {
      variant: {
        default:
          'border border-[var(--border)] bg-[var(--wash)] text-[var(--ink-2)]',
        copper:
          'border border-[rgba(226,163,85,0.35)] bg-[var(--brand-dim)] text-[var(--brand-hi)] font-semibold shadow-sm',
        success:
          'border border-[rgba(16,185,129,0.3)] bg-[rgba(16,185,129,0.12)] text-[#10b981]',
        warning:
          'border border-[rgba(245,158,11,0.3)] bg-[rgba(245,158,11,0.12)] text-[#f59e0b]',
        destructive:
          'border border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.12)] text-[#ef4444]',
        live:
          'border border-[rgba(16,185,129,0.4)] bg-[rgba(16,185,129,0.15)] text-[#10b981]',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {
  liveDot?: boolean;
}

function Badge({ className, variant, liveDot, children, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props}>
      {(variant === 'live' || liveDot) && (
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
        </span>
      )}
      {children}
    </div>
  );
}

export { Badge, badgeVariants };
