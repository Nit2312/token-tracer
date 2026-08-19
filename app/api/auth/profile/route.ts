import { NextRequest, NextResponse } from 'next/server';
import {
  getSessionFromCookie,
  buildSessionCookie,
  hashPassword,
  verifyPassword,
  SessionPayload,
} from '@/lib/auth';
import { getDocById, queryCol, setDocById } from '@/lib/team/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSessionFromCookie(req.headers.get('cookie'));
  if (!session) {
    return NextResponse.json({ error: 'not authenticated' }, { status: 401 });
  }

  let user: any = null;
  let teams: Array<{ id: string; name: string; role: string }> = [];

  const isUuid = (val: string | null | undefined): boolean =>
    Boolean(val && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val));

  if (isUuid(session.userId)) {
    user = await getDocById('users', session.userId);
  }

  const memberId = user?.member_id || session.memberId;
  if (isUuid(memberId)) {
    const tmDocs = await queryCol<{ team_id: string; role: string }>('team_members', [
      { type: 'where', field: 'member_id', op: '==', value: memberId },
    ]);
    const teamDocs = await Promise.all(
      tmDocs.map((tm) => getDocById('teams', tm.team_id).then((t) => t ? { id: t.id, name: t.name, role: tm.role } : null)),
    );
    teams = (teamDocs.filter(Boolean) as any[]).sort((a, b) => String(a.name).localeCompare(String(b.name)));
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

  // Fetch current user from Firestore
  const currentUser = await getDocById('users', session.userId) as any;
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
    await setDocById('users', session.userId, { password_hash: newHash, updated_at: new Date().toISOString() }, true);
  }

  // Update display_name
  if (updatedDisplayName !== currentUser.display_name) {
    await setDocById('users', session.userId, { display_name: updatedDisplayName, updated_at: new Date().toISOString() }, true);
    if (currentUser.member_id) {
      await setDocById('members', currentUser.member_id, { display_name: updatedDisplayName, updated_at: new Date().toISOString() }, true);
    }
  }

  // Build new session payload with updated display name
  const updatedPayload: SessionPayload = {
    userId: session.userId,
    username: currentUser.username,
    displayName: updatedDisplayName,
    role: currentUser.role,
    memberId: currentUser.member_id,
    teamId: currentUser.team_id,
    issuedAt: Date.now(),
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
