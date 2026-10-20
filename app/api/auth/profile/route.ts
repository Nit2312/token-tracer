import { NextRequest, NextResponse } from 'next/server';
import {
  getSessionFromCookie,
  buildSessionCookie,
  hashPassword,
  verifyPassword,
  SessionPayload,
} from '@/lib/auth';
import { query } from '@/lib/team/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSessionFromCookie(req.headers.get('cookie'));
  if (!session) {
    return NextResponse.json({ error: 'not authenticated' }, { status: 401 });
  }

  let user = null;
  let teams: Array<{ id: string; name: string; role: string }> = [];

  const isUuid = (val: string | null | undefined): boolean =>
    Boolean(val && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val));

  if (isUuid(session.userId)) {
    const { rows } = await query(
      `SELECT id, username, display_name, role, member_id, team_id, api_key, created_at
       FROM users WHERE id = $1`,
      [session.userId],
    );
    user = rows[0] || null;
  }

  const memberId = user?.member_id || session.memberId;
  if (isUuid(memberId)) {
    const { rows: teamRows } = await query<{ id: string; name: string; role: string }>(
      `SELECT t.id, t.name, tm.role
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
       WHERE tm.member_id = $1
       ORDER BY t.name`,
      [memberId],
    );
    teams = teamRows;
  }

  return NextResponse.json({
    ok: true,
    user: {
      id: user?.id || session.userId,
      username: user?.username || session.username,
      displayName: user?.display_name || session.displayName,
      role: user?.role || session.role,
      memberId,
      teamId: user?.team_id || session.teamId,
      apiKey: user?.api_key || null,
      teams,
    },
  });
}

export async function PUT(req: NextRequest) {
  const session = getSessionFromCookie(req.headers.get('cookie'));
  if (!session) {
    return NextResponse.json({ error: 'not authenticated' }, { status: 401 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const isUuid = (val: string | null | undefined): boolean =>
    Boolean(val && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val));

  if (!isUuid(session.userId)) {
    return NextResponse.json({
      error: 'Cannot update profile for static admin session. Please log in with a user account.',
    }, { status: 400 });
  }

  // Fetch current user from database
  const { rows: userRows } = await query(
    `SELECT id, username, password_hash, display_name, role, member_id, team_id, api_key
     FROM users WHERE id = $1`,
    [session.userId],
  );
  const currentUser = userRows[0];
  if (!currentUser) {
    return NextResponse.json({ error: 'User account not found' }, { status: 404 });
  }

  let updatedDisplayName = currentUser.display_name;
  if (body.displayName !== undefined) {
    const rawName = String(body.displayName || '').trim();
    if (rawName.length < 2) {
      return NextResponse.json({ error: 'Display name must be at least 2 characters long' }, { status: 400 });
    }
    updatedDisplayName = rawName;
  }

  // Handle password change if requested
  const newPassword = body.newPassword ? String(body.newPassword) : '';
  const currentPassword = body.currentPassword ? String(body.currentPassword) : '';

  if (newPassword) {
    if (newPassword.length < 6) {
      return NextResponse.json({ error: 'New password must be at least 6 characters long' }, { status: 400 });
    }

    if (currentUser.password_hash) {
      if (!currentPassword) {
        return NextResponse.json({ error: 'Current password is required to set a new password' }, { status: 400 });
      }
      const valid = await verifyPassword(currentPassword, currentUser.password_hash);
      if (!valid) {
        return NextResponse.json({ error: 'Current password is incorrect' }, { status: 400 });
      }
    }

    const newHash = await hashPassword(newPassword);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, session.userId]);
  }

  // Update display_name in users table
  if (updatedDisplayName !== currentUser.display_name) {
    await query('UPDATE users SET display_name = $1 WHERE id = $2', [updatedDisplayName, session.userId]);

    // If linked to a member, also sync members.display_name
    if (currentUser.member_id) {
      await query('UPDATE members SET display_name = $1 WHERE id = $2', [updatedDisplayName, currentUser.member_id]);
    }
  }

  // Build new session payload with updated display name
  // Spread the existing session so issuedAt (absolute lifetime), MFA state and impersonation fields are preserved.
  const updatedPayload: SessionPayload = {
    ...session,
    username: currentUser.username,
    displayName: updatedDisplayName,
    role: currentUser.role,
    memberId: currentUser.member_id,
    teamId: currentUser.team_id,
    lastActive: Date.now(),
  };

  const isSecure = req.headers.get('x-forwarded-proto') === 'https' || req.nextUrl.protocol === 'https:';
  const cookieHeader = buildSessionCookie(updatedPayload, isSecure);

  const res = NextResponse.json({
    ok: true,
    message: 'Profile updated successfully',
    user: {
      id: currentUser.id,
      username: currentUser.username,
      displayName: updatedDisplayName,
      role: currentUser.role,
      memberId: currentUser.member_id,
      teamId: currentUser.team_id,
    },
  });

  res.headers.set('Set-Cookie', cookieHeader);
  return res;
}
