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
import { query } from '@/lib/team/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSessionFromCookie(req.headers.get('cookie'));
  if (!session) {
    return NextResponse.json({ error: 'not authenticated' }, { status: 401 });
  }

  // For regular users, also fetch their raw API key (stored in member_keys).
  // We only expose the key label + creation date, not the hash.
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
    const { rows: userRows } = await query(
      `SELECT u.display_name, u.api_key, u.member_id, u.team_id FROM users u WHERE u.id = $1`,
      [session.userId],
    );
    if (userRows[0]) {
      apiKey = userRows[0].api_key ?? null;
      memberId = userRows[0].member_id ?? memberId;
      teamId = userRows[0].team_id ?? teamId;
      if (userRows[0].display_name) {
        currentDisplayName = userRows[0].display_name;
      }
    }
  }

  if (isUuid(memberId)) {
    const { rows: countRows } = await query(
      `SELECT count(*)::int AS count FROM sync_sessions WHERE member_id = $1`,
      [memberId],
    );
    sessionCount = countRows[0]?.count || 0;

    // Fetch all teams this member belongs to
    const { rows: teamRows } = await query<{ id: string; name: string; role: string }>(
      `SELECT t.id, t.name, tm.role
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
       WHERE tm.member_id = $1
       ORDER BY t.name`,
      [memberId],
    );
    userTeams = teamRows;
    if (session.role === 'user') {
      if (userTeams.length > 0 && !userTeams.some(t => t.id === teamId)) {
        teamId = userTeams[0].id;
      }
    } else {
      if (!teamId && userTeams.length > 0) {
        teamId = userTeams[0].id;
      }
    }
  }

  // Bypasses onboarding if running locally without a database and local files exist
  if (sessionCount === 0 && process.env.VERCEL !== '1' && !process.env.DATABASE_URL && !process.env.NEON_CONNECTION_STRING) {

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
