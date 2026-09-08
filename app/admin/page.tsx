import type { Metadata } from 'next';
import Script from 'next/script';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSessionFromCookie } from '@/lib/auth';
import { SuperadminDashboardView } from '@/components/admin/SuperadminDashboardView';

export const metadata: Metadata = {
  title: 'Superadmin Portal — Token Tracer',
  description: 'Superadmin infrastructure monitoring, platform whale leaderboards, and user management.',
};

export default async function AdminPage() {
  const cookieStore = await cookies();
  const session = getSessionFromCookie(cookieStore.toString());

  if (!session || session.role !== 'superadmin') {
    redirect('/');
  }

  return (
    <div suppressHydrationWarning>
      <Script src="/impersonation.js" strategy="afterInteractive" />
      <SuperadminDashboardView session={session} />
    </div>
  );
}
