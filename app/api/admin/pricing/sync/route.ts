/**
 * Global Sync and Recalculation API — Superadmin only.
 *
 * POST /api/admin/pricing/sync
 *
 * 1. Broadcasts background sync request to ALL members in the system (`sync_requested_at = now()`).
 * 2. Recalculates `api_cost` across all historical sessions for all teams and members with latest pricing rules.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/auth';
import { query } from '@/lib/team/db';
import { recalculateAllCosts } from '@/lib/team/stats';
import { publicError } from '@/lib/security/errors';

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
    // 1. Broadcast sync request to all members so local client daemons immediately sync
    const memberRes = await query(`
      UPDATE members
      SET sync_requested_at = now()
    `);
    const membersNotified = memberRes.rowCount || 0;

    // 2. Recalculate costs for all sessions across all teams and members
    const { updatedCount, totalSessions } = await recalculateAllCosts(true);

    // 3. Get team statistics
    const { rows: teamRows } = await query(`SELECT count(*)::int as count FROM teams`);
    const teamsCount = teamRows[0]?.count || 0;

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
    return NextResponse.json({ error: publicError(err) }, { status: 500 });
  }
}
