'use client';

import { Toaster as Sonner } from 'sonner';

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-[var(--surface)] group-[.toaster]:text-[var(--ink)] group-[.toaster]:border-[var(--border-bright)] group-[.toaster]:shadow-2xl group-[.toaster]:rounded-xl group-[.toaster]:backdrop-blur-xl',
          description: 'group-[.toast]:text-[var(--muted)]',
          actionButton:
            'group-[.toast]:bg-[var(--brand)] group-[.toast]:text-[var(--brand-ink)] font-semibold',
          cancelButton:
            'group-[.toast]:bg-[var(--wash)] group-[.toast]:text-[var(--ink-2)]',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
