import { NextRequest, NextResponse } from 'next/server';
import { getAuthorizedTeamId, getSessionFromCookie } from '@/lib/auth';
import { buildMemberUsageDeepDive } from '@/lib/admin/whale-analysis';
import { query } from '@/lib/team/db';
import { publicError } from '@/lib/security/errors';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const rawTeamId = req.nextUrl.searchParams.get('teamId');
    const teamId = getAuthorizedTeamId(req, rawTeamId);
    if (!teamId) {
      return NextResponse.json({ error: 'Unauthorized — valid team session required' }, { status: 401 });
    }

    const session = getSessionFromCookie(req.headers.get('cookie'));
    let memberIds = req.nextUrl.searchParams.get('memberIds') || req.nextUrl.searchParams.get('memberId');

    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    if (session.role === 'user') {
      // Regular users can only ever see their own data — never fall back to a client-supplied id.
      if (!session.memberId) return NextResponse.json({ error: 'No member profile linked to this account' }, { status: 403 });
      memberIds = session.memberId;
    } else if (session.role !== 'superadmin' && memberIds && memberIds !== 'all') {
      // Admins may only look up members that belong to the team they are authorised for.
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const requested = memberIds.split(',').map((id) => id.trim()).filter((id) => UUID_RE.test(id));
      const rows: { member_id: string }[] = requested.length
        ? (await query<{ member_id: string }>('SELECT member_id FROM team_members WHERE team_id = $1 AND member_id = ANY($2::uuid[])', [teamId, requested])).rows
        : [];
      if (!rows.length) return NextResponse.json({ error: 'Members not found in this team' }, { status: 403 });
      memberIds = rows.map((r) => r.member_id).join(',');
    }

    if (!memberIds) {
      return NextResponse.json({ error: 'memberId or memberIds parameter is required' }, { status: 400 });
    }

    const range = req.nextUrl.searchParams.get('range') || 'all';
    const from = req.nextUrl.searchParams.get('from') || null;
    const to = req.nextUrl.searchParams.get('to') || null;
    const source = req.nextUrl.searchParams.get('source') || null;
    const model = req.nextUrl.searchParams.get('model') || null;

    const deepDive = await buildMemberUsageDeepDive(memberIds, {
      range,
      from,
      to,
      source,
      model,
      teamId,
    });

    if (!deepDive) {
      return NextResponse.json({ error: 'Members not found or no activity' }, { status: 404 });
    }

    return NextResponse.json(deepDive, {
      headers: {
        'Cache-Control': 'private, max-age=60, stale-while-revalidate=300',
      },
    });
  } catch (err: any) {
    console.error('[v1/team/usage-deep-dive error]', err);
    return NextResponse.json({ error: publicError(err) }, { status: 500 });
  }
}
