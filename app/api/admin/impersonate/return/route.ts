/**
 * POST /api/admin/impersonate/return
 * Ends an impersonation session and restores the original superadmin session.
 * Reads the backup cookie, validates it, restores it as the active session,
 * and clears the backup cookie.
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  getSessionFromCookie,
  getOriginalSessionFromCookie,
  getRawImpersonationToken,
  buildSessionCookie,
  clearImpersonationCookie,
} from '@/lib/auth';
import { recordAuditEvent } from '@/lib/team/audit';
import { publicError } from '@/lib/security/errors';

export const dynamic = 'force-dynamic';

function isSecure(req: NextRequest): boolean {
  return process.env.VERCEL === '1' ||
    req.headers.get('x-forwarded-proto') === 'https' ||
    process.env.NODE_ENV === 'production';
}

export async function POST(req: NextRequest) {
  try {
    const cookieHeader = req.headers.get('cookie');
    const currentSession = getSessionFromCookie(cookieHeader);

    // Must be in an impersonation session
    if (!currentSession || !currentSession.impersonatedBy) {
      return NextResponse.json({ error: 'Not currently impersonating anyone' }, { status: 400 });
    }

    // Read the backup superadmin session
    const originalSession = getOriginalSessionFromCookie(cookieHeader);
    const originalToken = getRawImpersonationToken(cookieHeader);

    if (!originalSession || !originalToken) {
      return NextResponse.json({ error: 'Original superadmin session not found. Please log in again.' }, { status: 401 });
    }

    // Verify the original session is actually a superadmin
    if (originalSession.role !== 'superadmin') {
      return NextResponse.json({ error: 'Original session is not a superadmin' }, { status: 403 });
    }

    const secure = isSecure(req);

    // Restore the original superadmin session and clear the backup
    const res = NextResponse.json({ ok: true, redirect: '/admin' });
    // Set the active session back to the original superadmin token
    // Re-issue with a fresh activity timestamp (the backup token sat idle during impersonation).
    res.headers.append('Set-Cookie', buildSessionCookie({ ...originalSession, lastActive: Date.now() }, secure));
    // Clear the backup cookie
    res.headers.append('Set-Cookie', clearImpersonationCookie());

    console.log(`[impersonate/return] Superadmin "${originalSession.username}" returned from impersonating "${currentSession.username}"`);
    await recordAuditEvent({
      actorUserId: originalSession.userId,
      actorUsername: originalSession.username,
      action: 'impersonate.end',
      targetType: 'user',
      targetId: currentSession.userId,
      metadata: { targetUsername: currentSession.username },
    });

    return res;
  } catch (err) {
    console.error('[impersonate/return error]', err);
    return NextResponse.json({ error: publicError(err) }, { status: 500 });
  }
}
