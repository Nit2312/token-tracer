/**
 * GET  /api/auth/me   → returns current session info (200) or 401
 * POST /api/auth/me   → clears the session cookie (acts as logout)
 *
 * NOTE: The POST handler doubles as the logout endpoint for both the main session
 * and any active impersonation backup cookie. The JS client calls this as:
 *   await fetch('/api/auth/me', { method: 'POST' });
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie, clearSessionCookie } from '@/lib/auth';
import { queryCol, getDocById } from '@/lib/team/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSessionFromCookie(req.headers.get('cookie'));
  if (!session) {
    return NextResponse.json({ error: 'not authenticated' }, { status: 401 });
  }

  let apiKey: string | null = null;
  let installCommandMac: string | null = null;
  let installCommandWin: string | null = null;

  let sessionCount = 0;
  let memberId = session.memberId;
  let teamId = session.teamId;

  let userTeams: Array<{ id: string; name: string; role: string }> = [];

  const isUuid = (val: string | null | undefined): boolean =>
    Boolean(val && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val));

  let currentDisplayName = session.displayName;

  if (isUuid(session.userId)) {
    const userDoc = await getDocById('users', session.userId);
    if (userDoc) {
      apiKey = userDoc.api_key ?? null;
      memberId = userDoc.member_id ?? memberId;
      teamId = userDoc.team_id ?? teamId;
      if (userDoc.display_name) currentDisplayName = userDoc.display_name;
    }
  }

  if (isUuid(memberId)) {
    // Count sessions for this member
    const sessionDocs = await queryCol('sync_sessions', [
      { type: 'where', field: 'member_id', op: '==', value: memberId },
    ]);
    sessionCount = sessionDocs.length;

    // Fetch all teams this member belongs to
    const tmDocs = await queryCol<{ team_id: string; role: string }>('team_members', [
      { type: 'where', field: 'member_id', op: '==', value: memberId },
    ]);
    const teamDocs = await Promise.all(
      tmDocs.map((tm) => getDocById('teams', tm.team_id).then((t) => t ? { id: t.id, name: t.name, role: tm.role } : null)),
    );
    userTeams = (teamDocs.filter(Boolean) as any[]).sort((a, b) => String(a.name).localeCompare(String(b.name)));

    if (session.role === 'user') {
      if (userTeams.length > 0 && !userTeams.some((t) => t.id === teamId)) {
        teamId = userTeams[0].id;
      }
    } else {
      if (!teamId && userTeams.length > 0) teamId = userTeams[0].id;
    }
  }

  // Bypasses onboarding if running locally without a database and local files exist
  if (sessionCount === 0 && process.env.VERCEL !== '1' && !process.env.FIREBASE_PROJECT_ID) {
    try {
      const { scanSessions } = await import('@/lib/scan.mjs');
      const local = scanSessions({});
      sessionCount = local.sessions.length;
    } catch (err) {
      console.warn('Local scan fallback in auth/me failed:', err);
    }
  }

  const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || 'https://token-tracer-three.vercel.app';
  if (apiKey) {
    installCommandMac = `curl -fsSL ${serverUrl}/install.sh | bash -s -- --key ${apiKey}`;
    installCommandWin = `$ApiKey="${apiKey}"; iex (irm ${serverUrl}/install.ps1)`;
  }

  return NextResponse.json({
    userId: session.userId,
    username: session.username,
    displayName: currentDisplayName,
    role: session.role,
    memberId,
    teamId,
    teams: userTeams,
    apiKey,
    installCommandMac,
    installCommandWin,
    sessionCount,
    impersonatedBy: session.impersonatedBy || null,
    impersonatedByName: session.impersonatedByName || null,
  });
}

export async function POST(req: NextRequest) {
  const { clearImpersonationCookie } = await import('@/lib/auth');
  const secure = process.env.VERCEL === '1' ||
    req.headers.get('x-forwarded-proto') === 'https' ||
    process.env.NODE_ENV === 'production';
  const res = NextResponse.json({ ok: true });
  res.headers.append('Set-Cookie', clearSessionCookie(secure));
  res.headers.append('Set-Cookie', clearImpersonationCookie(secure));
  return res;
}
