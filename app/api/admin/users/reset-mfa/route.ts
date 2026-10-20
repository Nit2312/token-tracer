/**
 * POST /api/admin/users/reset-mfa  { id }
 * Superadmin removes a database user's authenticator (e.g. lost phone). They enroll a
 * new one on their next sign-in. The built-in `team`/`superadmin` accounts use env secrets instead.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/auth';
import { resetMfa } from '@/lib/security/auth-store';
import { recordAuditEvent } from '@/lib/team/audit';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSessionFromCookie(req.headers.get('cookie'));
  if (!session || session.role !== 'superadmin') {
    return NextResponse.json({ error: 'superadmin access required' }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const id = String(body?.id || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json({ error: 'valid user id required' }, { status: 400 });
  }
  await resetMfa(`user:${id}`);
  await recordAuditEvent({
    actorUserId: session.userId,
    actorUsername: session.username,
    action: 'user.reset-mfa',
    targetType: 'user',
    targetId: id,
  });
  return NextResponse.json({ ok: true });
}
