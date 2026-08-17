/**
 * POST /api/admin/impersonate
 * Allows a superadmin to impersonate any user.
 * Sets the session cookie to the target user's identity while preserving
 * the original superadmin session in a backup cookie.
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  getSessionFromCookie,
  buildSessionCookie,
  encodeSessionToken,
  buildImpersonationCookie,
  getRawImpersonationToken,
  IMPERSONATION_COOKIE,
  type SessionPayload,
} from '@/lib/auth';
import { query } from '@/lib/team/db';
import { recordAuditEvent } from '@/lib/team/audit';

export const dynamic = 'force-dynamic';

function isSecure(req: NextRequest): boolean {
  return process.env.VERCEL === '1' ||
    req.headers.get('x-forwarded-proto') === 'https' ||
    process.env.NODE_ENV === 'production';
}

export async function POST(req: NextRequest) {
  try {
    const cookieHeader = req.headers.get('cookie');
    const session = getSessionFromCookie(cookieHeader);

    // Must be authenticated
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    // Must be superadmin
    if (session.role !== 'superadmin') {
      return NextResponse.json({ error: 'Only superadmin can impersonate users' }, { status: 403 });
    }

    // Prevent nested impersonation — check both the session flag AND the presence of
    // the backup cookie, since a stale session token might not carry impersonatedBy
    // but a backup cookie from a prior session could still exist.
    const cookieHeaderForCheck = req.headers.get('cookie') || '';
    const hasBackupCookie = cookieHeaderForCheck.split(';').some((p) => p.trim().startsWith(`${IMPERSONATION_COOKIE}=`));
    if (session.impersonatedBy || hasBackupCookie) {
      return NextResponse.json({ error: 'Cannot impersonate while already impersonating. Return to your superadmin session first.' }, { status: 403 });
    }

    // Parse body
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const targetUserId = String(body.userId ?? '').trim();
    if (!targetUserId) {
      return NextResponse.json({ error: 'userId is required' }, { status: 400 });
    }

    // Look up the target user
    const { rows } = await query(
      `SELECT id, username, display_name, role, member_id, team_id, active
       FROM users WHERE id = $1`,
      [targetUserId],
    );
    const targetUser = rows[0] as any;

    if (!targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    if (!targetUser.active) {
      return NextResponse.json({ error: 'Cannot impersonate an inactive user' }, { status: 400 });
    }

    let targetTeamId = targetUser.team_id;
    if (targetUser.role === 'user' && targetUser.member_id) {
      const { rows: tmRows } = await query(
        'SELECT team_id FROM team_members WHERE member_id = $1 ORDER BY created_at ASC LIMIT 1',
        [targetUser.member_id]
      );
      if (tmRows[0]?.team_id) {
        targetTeamId = tmRows[0].team_id;
      }
    } else if (!targetTeamId && targetUser.member_id) {
      const { rows: tmRows } = await query(
        'SELECT team_id FROM team_members WHERE member_id = $1 LIMIT 1',
        [targetUser.member_id]
      );
      if (tmRows[0]?.team_id) {
        targetTeamId = tmRows[0].team_id;
      }
    }

    // Build the impersonated session payload
    const impersonatedPayload: SessionPayload = {
      userId: targetUser.id,
      username: targetUser.username,
      displayName: targetUser.display_name,
      role: targetUser.role,
      memberId: targetUser.member_id,
      teamId: targetTeamId,
      issuedAt: Date.now(),
      impersonatedBy: session.userId,
      impersonatedByName: session.displayName || session.username,
    };

    // Determine redirect based on target role
    let redirectUrl = '/';
    if (targetUser.role === 'admin') {
      redirectUrl = '/team';
    } else if (targetUser.role === 'superadmin') {
      redirectUrl = '/admin';
    }

    const secure = isSecure(req);

    // Save the current superadmin session token as backup
    const originalToken = encodeSessionToken(session);

    const res = NextResponse.json({ ok: true, redirect: redirectUrl, username: targetUser.username });
    res.headers.append('Set-Cookie', buildSessionCookie(impersonatedPayload, secure));
    res.headers.append('Set-Cookie', buildImpersonationCookie(originalToken, secure));

    console.log(`[impersonate] Superadmin "${session.username}" is now impersonating "${targetUser.username}" (${targetUser.role})`);
    await recordAuditEvent({
      actorUserId: session.userId,
      actorUsername: session.username,
      action: 'impersonate.start',
      targetType: 'user',
      targetId: targetUser.id,
      metadata: { targetUsername: targetUser.username, targetRole: targetUser.role },
    });

    return res;
  } catch (err) {
    console.error('[impersonate error]', err);
    return NextResponse.json({ error: String((err as Error).message || err) }, { status: 500 });
  }
}
