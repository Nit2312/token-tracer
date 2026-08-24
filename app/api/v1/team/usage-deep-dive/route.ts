import { NextRequest, NextResponse } from 'next/server';
import { getAuthorizedTeamId, getSessionFromCookie } from '@/lib/auth';
import { buildMemberUsageDeepDive } from '@/lib/admin/whale-analysis';

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

    // If user role, restrict to their own memberId
    if (session?.role === 'user') {
      memberIds = session.memberId || memberIds;
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
    return NextResponse.json({ error: err?.message || 'Internal server error' }, { status: 500 });
  }
}
