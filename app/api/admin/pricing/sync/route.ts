/**
 * Global Sync and Recalculation API — Superadmin only.
 *
 * POST /api/admin/pricing/sync
 *
 * 1. Marks all members as requiring sync (sync_requested_at = now()).
 * 2. Recalculates `api_cost` across all historical sessions with latest pricing rules.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/auth';
import { queryCol, setDocById } from '@/lib/team/db';
import { recalculateAllCosts } from '@/lib/team/stats';

export const dynamic = 'force-dynamic';

function requireSuperadmin(req: NextRequest): boolean {
  const session = getSessionFromCookie(req.headers.get('cookie'));
  return session?.role === 'superadmin';
}

export async function POST(req: NextRequest) {
  if (!requireSuperadmin(req)) {
    return NextResponse.json({ error: 'superadmin access required' }, { status: 403 });
  }

  try {
    // 1. Broadcast sync request to all members
    const memberDocs = await queryCol<{ id: string }>('members');
    await Promise.all(
      memberDocs.map((m) =>
        setDocById('members', m.id, { sync_requested_at: new Date().toISOString() }, true),
      ),
    );
    const membersNotified = memberDocs.length;

    // 2. Recalculate costs for all sessions
    const { updatedCount, totalSessions } = await recalculateAllCosts(true);

    // 3. Count teams
    const teamDocs = await queryCol('teams');
    const teamsCount = teamDocs.length;

    return NextResponse.json({
      ok: true,
      success: true,
      message: `Synchronized all teams and members! Recalculated ${updatedCount} session(s) across ${teamsCount} team(s) and broadcasted background sync to ${membersNotified} member(s).`,
      membersNotified,
      sessionsRecalculated: updatedCount,
      totalSessions,
      teamsCount,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('[admin/pricing/sync POST error]', err);
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
