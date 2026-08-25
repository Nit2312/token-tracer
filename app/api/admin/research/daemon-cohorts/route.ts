/**
 * GET /api/admin/research/daemon-cohorts?range=30d&org=&tool=
 * Superadmin-only. Groups tool-error rate by `members.daemon_version`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { queryCol } from '@/lib/team/db';
import { parseRangeDays, requireSuperadminApi } from '@/lib/team/researchQuery';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const forbidden = requireSuperadminApi(req);
  if (forbidden) return forbidden;

  const searchParams = req.nextUrl.searchParams;
  const days = parseRangeDays(searchParams.get('range'), { def: 30, max: 90 });
  const orgFilter = searchParams.get('org');
  const toolFilter = searchParams.get('tool');

  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();

  try {
    const [syncSessions, members, assistantTurns] = await Promise.all([
      queryCol<any>('sync_sessions'),
      queryCol<any>('members'),
      queryCol<any>('session_turns', [{ type: 'where', field: 'turn_role', op: '==', value: 'assistant' }]),
    ]);

    const memberMap = new Map(members.map((m: any) => [m.id, m]));
    const sessionMap = new Map(syncSessions.map((s: any) => [s.session_id || s.id, s]));

    const filteredSessions = syncSessions.filter((s: any) => {
      if (!s.started_at || s.started_at < cutoff) return false;
      if (orgFilter && s.team_id !== orgFilter) return false;
      if (toolFilter && s.source !== toolFilter) return false;
      return true;
    });

    const validSessionIds = new Set(filteredSessions.map((s: any) => s.session_id || s.id));

    // Group turns by daemon_version
    const cohortMap = new Map<string, { daemonVersion: string; sessions: Set<string>; totalTurns: number; errorTurns: number; firstSeen: string | null; lastSeen: string | null }>();

    for (const st of assistantTurns) {
      if (!validSessionIds.has(st.session_id)) continue;
      const ss = sessionMap.get(st.session_id);
      if (!ss) continue;
      const m = memberMap.get(ss.member_id);
      const daemonVersion = m?.daemon_version || 'unknown';

      if (!cohortMap.has(daemonVersion)) {
        cohortMap.set(daemonVersion, {
          daemonVersion,
          sessions: new Set(),
          totalTurns: 0,
          errorTurns: 0,
          firstSeen: null,
          lastSeen: null,
        });
      }
      const c = cohortMap.get(daemonVersion)!;
      c.sessions.add(ss.session_id || ss.id);
      c.totalTurns += 1;
      if (st.tool_error_flag) c.errorTurns += 1;

      if (ss.started_at) {
        if (!c.firstSeen || ss.started_at < c.firstSeen) c.firstSeen = ss.started_at;
        if (!c.lastSeen || ss.started_at > c.lastSeen) c.lastSeen = ss.started_at;
      }
    }

    const cohorts = Array.from(cohortMap.values())
      .map(c => ({
        daemonVersion: c.daemonVersion,
        sessionCount: c.sessions.size,
        errorRate: c.totalTurns > 0 ? c.errorTurns / c.totalTurns : 0,
        firstSeen: c.firstSeen,
        lastSeen: c.lastSeen,
      }))
      .sort((a, b) => b.errorRate - a.errorRate);

    return NextResponse.json({ cohorts });
  } catch (err: any) {
    console.error('[research-daemon-cohorts-error]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
