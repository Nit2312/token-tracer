import type { Metadata } from 'next';
import Script from 'next/script';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSessionFromCookie } from '@/lib/auth';
import { TeamDashboardView } from '@/components/dashboard/TeamDashboardView';

export const metadata: Metadata = {
  title: 'Team Analytics — Token Tracer',
  description: 'Comprehensive team agent analytics — member token logs, custom model pricing, API cost recalculation, and scorecards.',
};

export default async function TeamDashboardPage() {
  const cookieStore = await cookies();
  const session = getSessionFromCookie(cookieStore.toString());

  if (!session || (session.role !== 'admin' && session.role !== 'superadmin')) {
    redirect('/');
  }

  return (
    <div suppressHydrationWarning>
      <Script src="/impersonation.js" strategy="afterInteractive" />
      <TeamDashboardView session={session} />
    </div>
  );
}
