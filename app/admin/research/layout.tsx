import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSessionFromCookie } from '@/lib/auth';
import ResearchQueryProvider from '@/lib/admin/research/QueryProvider';
import { SignOutButton } from '@/components/admin/SignOutButton';
import './research-tailwind.css';

export const metadata: Metadata = {
  title: 'Research — Admin — Token Tracer',
  description: 'Superadmin research analytics: error spikes, context saturation, and behavioral studies.',
};

const NAV = [
  { href: '/admin/research', label: 'Overview' },
  { href: '/admin/research/error-spikes', label: 'Error Spikes' },
  { href: '/admin/research/context-saturation', label: 'Context Saturation' },
  { href: '/admin/research/prompt-specificity', label: 'Prompt Specificity' },
  { href: '/admin/research/verbosity-elasticity', label: 'Verbosity Elasticity' },
  { href: '/admin/research/cost-performance', label: 'Cost / Performance' },
  { href: '/admin/research/redundant-reprompt', label: 'Redundant Re-prompting' },
  { href: '/admin/research/daemon-cohorts', label: 'Daemon Cohorts' },
];

export default async function ResearchLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const session = getSessionFromCookie(cookieStore.toString());
  if (!session || session.role !== 'superadmin') {
    redirect('/');
  }

  return (
    <div className="min-h-screen bg-page text-ink font-body">
      <div className="sticky top-0 z-30 border-b border-border bg-surface/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between px-6 py-3.5">
          <div className="flex items-center gap-3">
            <a href="/admin" className="text-xs font-semibold text-brand hover:text-brand-hi transition-colors flex items-center gap-1">
              <span>←</span> Admin Dashboard
            </a>
            <span className="text-border">/</span>
            <span className="text-sm font-semibold text-ink flex items-center gap-1.5">
              <span>🔬</span> Research Analytics
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full bg-brand/10 px-2.5 py-0.5 text-[11px] font-medium text-brand border border-brand/20">
              <span className="h-1.5 w-1.5 rounded-full bg-brand animate-pulse" />
              Real-time Agent Telemetry
            </span>
            <div className="flex items-center gap-2 border-l border-border pl-3">
              <span className="text-xs font-mono text-muted hidden md:inline">
                {session.displayName || session.username}
              </span>
              <SignOutButton
                variant="outline"
                size="sm"
                className="border-red-500/30 text-red-400 hover:text-white hover:bg-red-500/20 bg-surface text-xs"
              />
            </div>
          </div>
        </div>
        <div className="mx-auto flex max-w-[1400px] gap-1 overflow-x-auto px-6 pb-2.5 pt-1 scrollbar-none">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium text-muted transition-all hover:bg-raised hover:text-ink hover:border-brand/30 border border-transparent"
            >
              {item.label}
            </Link>
          ))}
        </div>
      </div>
      <div className="mx-auto max-w-[1400px] px-6 py-8">
        <ResearchQueryProvider>{children}</ResearchQueryProvider>
      </div>
    </div>
  );
}
