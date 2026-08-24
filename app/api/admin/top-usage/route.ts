/**
 * GET /api/admin/top-usage
 * Superadmin-only API. Returns platform-wide token whales analysis,
 * top projects, extreme runaway sessions, and per-member deep dives.
 *
 * Query Params:
 * - range: '7d' | '30d' | '90d' | 'all' (default 'all')
 * - teamId: team UUID or 'all'
 * - minTokens: number threshold
 * - search: string
 * - memberId: (optional) if provided, returns full 6-dimensional deep-dive for that member
 */
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSessionFromCookie } from '@/lib/auth';
import { getPlatformWhales, buildMemberUsageDeepDive } from '@/lib/admin/whale-analysis';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const cookieStore = await cookies();
  const session = getSessionFromCookie(cookieStore.toString());

  if (!session || session.role !== 'superadmin') {
    return NextResponse.json({ error: 'Forbidden — Superadmin access required' }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const memberId = searchParams.get('memberId');
  const range = searchParams.get('range') || 'all';
  const teamId = searchParams.get('teamId') || null;
  const minTokens = searchParams.get('minTokens') ? Number(searchParams.get('minTokens')) : null;
  const search = searchParams.get('search') || null;
  const source = searchParams.get('source') || null;
  const model = searchParams.get('model') || null;

  try {
    // If specific member requested, return full deep dive
    if (memberId) {
      const deepDive = await buildMemberUsageDeepDive(memberId, {
        range,
        source,
        model,
      });

      if (!deepDive) {
        return NextResponse.json({ error: 'Member not found or no activity' }, { status: 404 });
      }

      return NextResponse.json(deepDive);
    }

    // Otherwise return platform whales leaderboard & aggregates
    const data = await getPlatformWhales({
      range,
      teamId,
      minTokens,
      search,
      limit: 100,
    });

    return NextResponse.json(data);
  } catch (error: any) {
    console.error('[admin/top-usage] error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
