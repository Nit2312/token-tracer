import { NextRequest, NextResponse } from 'next/server';
import { getAuthorizedTeamId } from '@/lib/auth';
import { queryCol, getDocById, setDocById } from '@/lib/team/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const rawTeamId = req.nextUrl.searchParams.get('teamId');
    const teamId = getAuthorizedTeamId(req, rawTeamId);
    if (!teamId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const [allMembers, allTeamMembers, allTeams] = await Promise.all([
      queryCol<any>('members'),
      queryCol<any>('team_members'),
      queryCol<any>('teams'),
    ]);

    const teamById = new Map(allTeams.map((t: any) => [t.id, t]));
    const teamIdsByMember = new Map<string, string[]>();
    for (const tm of allTeamMembers) {
      if (!teamIdsByMember.has(tm.member_id)) teamIdsByMember.set(tm.member_id, []);
      teamIdsByMember.get(tm.member_id)!.push(tm.team_id);
    }

    const currentTeamMemberIds = new Set(
      allTeamMembers.filter((tm: any) => tm.team_id === teamId).map((tm: any) => tm.member_id)
    );

    const members = allMembers
      .filter((m: any) => !currentTeamMemberIds.has(m.id))
      .map((m: any) => {
        const tIds = teamIdsByMember.get(m.id) || [];
        const tNames = tIds.map((tid) => teamById.get(tid)?.name).filter(Boolean);
        return {
          id: m.id,
          display_name: m.display_name,
          existing_teams: tNames.length > 0 ? tNames.join(', ') : 'Independent',
        };
      })
      .sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)));

    return NextResponse.json({ members });
  } catch (err) {
    console.error('[team/members/link GET error]', err);
    return NextResponse.json({ error: String((err as Error).message || err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
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

    // Link the member into the new team via team_members
    const tmId = `${teamId}_${memberId}`;
    await setDocById('team_members', tmId, {
      team_id: teamId,
      member_id: memberId,
      role: 'member',
      created_at: new Date().toISOString(),
    }, true);

    // If members.team_id is unset, populate it
    const member = await getDocById('members', memberId);
    if (member && !member.team_id) {
      await setDocById('members', memberId, { team_id: teamId }, true);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[team/members/link POST error]', err);
    return NextResponse.json({ error: String((err as Error).message || err) }, { status: 500 });
  }
}
