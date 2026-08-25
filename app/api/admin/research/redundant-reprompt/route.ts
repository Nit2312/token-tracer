import { NextRequest, NextResponse } from 'next/server';
import { queryCol } from '@/lib/team/db';
import { parseRangeDays, requireSuperadminApi } from '@/lib/team/researchQuery';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const forbidden = requireSuperadminApi(req);
  if (forbidden) return forbidden;

  const searchParams = req.nextUrl.searchParams;
  const days = parseRangeDays(searchParams.get('range'));
  const org = searchParams.get('org');

  const pilotOrgId = process.env.ENABLE_REPROMPT_ANALYSIS_ORG_ID;

  // Study 5 is gated strictly to the pilot org
  if (!pilotOrgId || org !== pilotOrgId) {
    return NextResponse.json({
      pilotOnly: true,
      eligibleOrg: pilotOrgId || 'None configured (Set ENABLE_REPROMPT_ANALYSIS_ORG_ID)'
    });
  }

  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();

  try {
    const [repromptEvents, syncSessions, members, teams, userTurns] = await Promise.all([
      queryCol<any>('redundant_reprompt_events'),
      queryCol<any>('sync_sessions', [{ type: 'where', field: 'team_id', op: '==', value: org }]),
      queryCol<any>('members'),
      queryCol<any>('teams'),
      queryCol<any>('session_turns', [{ type: 'where', field: 'turn_role', op: '==', value: 'user' }]),
    ]);

    const sessionMap = new Map(syncSessions.map((s: any) => [s.session_id || s.id, s]));
    const memberMap = new Map(members.map((m: any) => [m.id, m]));
    const teamMap = new Map(teams.map((t: any) => [t.id, t]));
    const userTurnsByKey = new Map<string, any>();
    for (const ut of userTurns) {
      userTurnsByKey.set(`${ut.session_id}:${ut.turn_index}`, ut);
    }

    const filtered = repromptEvents.filter((rre: any) => {
      const ss = sessionMap.get(rre.session_id);
      if (!ss || !ss.started_at || ss.started_at < cutoff) return false;
      return true;
    });

    const events = filtered.map((rre: any) => {
      const ss = sessionMap.get(rre.session_id);
      const m = ss ? memberMap.get(ss.member_id) : null;
      const t = ss ? teamMap.get(ss.team_id) : null;
      const st = userTurnsByKey.get(`${rre.session_id}:${rre.turn_index}`);
      const prevSt = userTurnsByKey.get(`${rre.session_id}:${rre.turn_index - 1}`);

      const totalSessionTokens = Number(ss?.tokens_in || 0) + Number(ss?.tokens_out || 0);
      const costWasted = totalSessionTokens > 0 ? (Number(rre.tokens_cost_of_following_turn || 0) / totalSessionTokens) * Number(ss?.api_cost || 0) : 0;

      return {
        sessionId: rre.session_id,
        turnIndex: rre.turn_index,
        similarityScore: Number(rre.similarity_score || 0),
        tokensCost: Number(rre.tokens_cost_of_following_turn || 0),
        costWasted,
        createdAt: rre.created_at,
        tool: ss?.source || 'cursor',
        model: ss?.model || 'default',
        userName: m?.display_name || 'Unknown User',
        projectName: t?.name || 'Unknown Team',
        promptText: st?.prompt_text_sanitized || null,
        prevPromptText: prevSt?.prompt_text_sanitized || null,
      };
    }).sort((a, b) => b.tokensCost - a.tokensCost);

    return NextResponse.json({
      pilotOnly: false,
      eligibleOrg: pilotOrgId,
      events,
    });
  } catch (err: any) {
    console.error('[research-reprompt-error]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
