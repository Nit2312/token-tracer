import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getSessionFromCookie } from '@/lib/session-token';
import { sessionSecret } from '@/lib/team/env';
import { prepareAuthorize, type AuthorizeView } from '@/lib/mcp/oauth/authorize';
import ConsentForm from './consent-form';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Authorize access', robots: { index: false, follow: false }, referrer: 'no-referrer' };

function Message({ title, text }: { title: string; text: string }) {
  return (
    <div className="login-page">
      <div className="login-card" style={{ maxWidth: 520 }}>
        <h1 style={{ fontSize: 22, marginBottom: 8 }}>{title}</h1>
        <p>{text}</p>
      </div>
    </div>
  );
}

/** OAuth authorization endpoint (consent). All decisions live in lib/mcp/oauth/authorize.ts; this shell only maps the outcome to a response. */
export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const h = await headers();
  const session = getSessionFromCookie((await cookies()).toString());

  let view: AuthorizeView;
  try {
    view = await prepareAuthorize({ searchParams: sp, session, headers: new Headers(Array.from(h.entries())), secret: sessionSecret() });
  } catch {
    view = { kind: 'unavailable' }; // never show internal errors
  }

  switch (view.kind) {
    case 'not_found': notFound();
    case 'redirect': redirect(view.url);
    case 'login': redirect(`/?returnTo=${encodeURIComponent(view.returnTo)}`);
    case 'unavailable': return <Message title="Temporarily unavailable" text="Authorization is not available right now. Try again later." />;
    case 'fatal': return <Message title="Cannot authorize" text={view.message} />;
    case 'ineligible': return <Message title="Not allowed" text={view.message} />;
    case 'consent': return <ConsentForm {...view.view} />;
  }
}
