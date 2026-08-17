import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSessionFromCookie } from '@/lib/auth';
import ResearchQueryProvider from '@/lib/admin/research/QueryProvider';
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
      <div className="block border-b border-border bg-surface">
        <div className="mx-auto flex max-w-[1400px] items-center gap-4 px-5 py-3">
          <a href="/admin" className="text-xs font-semibold text-brand hover:underline">
            ← Admin Dashboard
          </a>
          <span className="text-sm font-medium text-ink">Research Analytics</span>
        </div>
        <div className="mx-auto flex max-w-[1400px] gap-1 overflow-x-auto px-5 pb-2">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="whitespace-nowrap rounded-md px-2.5 py-1 text-xs text-muted hover:bg-wash hover:text-ink"
            >
              {item.label}
            </Link>
          ))}
        </div>
      </div>
      <div className="mx-auto max-w-[1400px] px-5 py-6">
        <ResearchQueryProvider>{children}</ResearchQueryProvider>
      </div>
    </div>
  );
}
