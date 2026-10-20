import { NextRequest, NextResponse } from 'next/server';
import { getAuthorizedTeamId, getSessionFromCookie, isSystemAdmin } from '@/lib/auth';
import { query } from '@/lib/team/db';
import { publicError } from '@/lib/security/errors';

export const dynamic = 'force-dynamic';

/** Linking pulls other people's data into a team, so only the platform owner may do it. */
function denyUnlessSystemAdmin(req: NextRequest): NextResponse | null {
  const session = getSessionFromCookie(req.headers.get('cookie'));
  return isSystemAdmin(session) ? null : NextResponse.json({ error: 'platform administrator access required' }, { status: 403 });
}

export async function GET(req: NextRequest) {
  try {
    const denied = denyUnlessSystemAdmin(req);
    if (denied) return denied;
    const rawTeamId = req.nextUrl.searchParams.get('teamId');
    const teamId = getAuthorizedTeamId(req, rawTeamId);
    if (!teamId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    // Find members that do not belong to the current team
    const { rows: members } = await query(
      `SELECT m.id, m.display_name,
              COALESCE(
                (SELECT string_agg(t.name, ', ')
                 FROM team_members tm
                 JOIN teams t ON t.id = tm.team_id
                 WHERE tm.member_id = m.id),
                'Independent'
              ) AS existing_teams
       FROM members m
       WHERE m.id NOT IN (
         SELECT member_id FROM team_members WHERE team_id = $1
       )
       ORDER BY m.display_name`,
      [teamId],
    );

    return NextResponse.json({ members });
  } catch (err) {
    console.error('[team/members/link GET error]', err);
    return NextResponse.json({ error: publicError(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const denied = denyUnlessSystemAdmin(req);
    if (denied) return denied;
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
    }

    const rawTeamId = body.teamId ? String(body.teamId) : null;
    const teamId = getAuthorizedTeamId(req, rawTeamId);
    if (!teamId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const memberId = body.memberId ? String(body.memberId) : null;
    if (!memberId) return NextResponse.json({ error: 'memberId required' }, { status: 400 });

    // Link the member into the new team via team_members junction table
    await query(
      `INSERT INTO team_members (team_id, member_id, role)
       VALUES ($1, $2, 'member')
       ON CONFLICT (team_id, member_id) DO NOTHING`,
      [teamId, memberId],
    );

    // If members.team_id is unset, populate it
    await query(
      `UPDATE members SET team_id = COALESCE(team_id, $1) WHERE id = $2`,
      [teamId, memberId],
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[team/members/link POST error]', err);
    return NextResponse.json({ error: publicError(err) }, { status: 500 });
  }
}
