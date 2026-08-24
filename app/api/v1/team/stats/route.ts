import { NextRequest, NextResponse } from 'next/server';
import { getAuthorizedTeamId, getSessionFromCookie } from '@/lib/auth';
import { buildTeamStats } from '@/lib/team/stats';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const rawTeamId = req.nextUrl.searchParams.get('teamId');
    const teamId = getAuthorizedTeamId(req, rawTeamId);
    if (!teamId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const session = getSessionFromCookie(req.headers.get('cookie'));
    let memberId = req.nextUrl.searchParams.get('memberIds') || req.nextUrl.searchParams.get('memberId');
    if (session?.role === 'user') {
      memberId = session.memberId;
    }

    const minTok = req.nextUrl.searchParams.get('minTokens');
    const maxTok = req.nextUrl.searchParams.get('maxTokens');

    const stats = await buildTeamStats(teamId, {
      from: req.nextUrl.searchParams.get('from'),
      to: req.nextUrl.searchParams.get('to'),
      memberId: memberId,
      source: req.nextUrl.searchParams.get('source'),
      minTokens: minTok ? Number(minTok) : null,
      maxTokens: maxTok ? Number(maxTok) : null,
    });
    return NextResponse.json(stats);
  } catch (err) {
    console.error('[team/stats GET error]', err);
    return NextResponse.json({ error: String((err as Error).message || err) }, { status: 500 });
  }
}
