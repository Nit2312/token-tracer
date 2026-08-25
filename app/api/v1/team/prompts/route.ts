import { NextRequest, NextResponse } from 'next/server';
import { getAuthorizedTeamId, getSessionFromCookie } from '@/lib/auth';
import { queryCol, getDocById } from '@/lib/team/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const rawTeamId = req.nextUrl.searchParams.get('teamId');
    const teamId = getAuthorizedTeamId(req, rawTeamId);
    if (!teamId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const session = getSessionFromCookie(req.headers.get('cookie'));
    
    // Default page & limit
    const searchParams = req.nextUrl.searchParams;
    const page = Math.max(1, Number(searchParams.get('page') || 1));
    const limit = Math.max(1, Math.min(250, Number(searchParams.get('limit') || 50)));

    // Filter by memberId if role === 'user', or optional global-member-filter parameter if admin
    let memberId = searchParams.get('memberIds') || searchParams.get('memberId') || 'all';
    if (session?.role === 'user') {
      memberId = session.memberId || 'all';
    }

    const from = searchParams.get('from');
    const to = searchParams.get('to');
    const source = searchParams.get('source');
    const minTokens = searchParams.get('minTokens');

    let memberIdsArr: string[] = [];
    if (memberId && memberId !== 'all') {
      memberIdsArr = memberId.split(',').map((id) => id.trim()).filter((id) => Boolean(id) && id !== 'all');
    }

    // Fetch session_turns for user role
    const turnConstraints: Parameters<typeof queryCol>[1] = [
      { type: 'where', field: 'turn_role', op: '==', value: 'user' },
    ];
    if (teamId) {
      turnConstraints.push({ type: 'where', field: 'org_id', op: '==', value: teamId });
    }

    const [userTurns, assistantTurns, syncSessions, memberDocs] = await Promise.all([
      queryCol<any>('session_turns', turnConstraints),
      queryCol<any>('session_turns', [
        { type: 'where', field: 'turn_role', op: '==', value: 'assistant' },
        { type: 'where', field: 'org_id', op: '==', value: teamId },
      ]),
      queryCol<any>('sync_sessions', [
        { type: 'where', field: 'team_id', op: '==', value: teamId },
      ]),
      queryCol<any>('members'),
    ]);

    const sessionBySessionId = new Map(syncSessions.map((s: any) => [s.session_id || s.id, s]));
    const memberById = new Map(memberDocs.map((m: any) => [m.id, m]));
    const assistantByKey = new Map<string, any>();
    for (const at of assistantTurns) {
      assistantByKey.set(`${at.session_id}:${at.turn_index}`, at);
    }

    // Filter turns
    let filteredTurns = userTurns.filter((t: any) => {
      const ss = sessionBySessionId.get(t.session_id);
      if (!ss) return false;
      if (memberIdsArr.length > 0 && !memberIdsArr.includes(ss.member_id)) return false;
      if (source && source !== 'all' && ss.source !== source) return false;

      const ts = ss.ended_at || ss.started_at || ss.synced_at;
      if (ts) {
        const dateStr = String(ts).slice(0, 10);
        if (from && dateStr < from) return false;
        if (to && dateStr > to) return false;
      }

      if (minTokens && Number(minTokens) > 0) {
        const totTokens = Number(ss.tokens_in || 0) + Number(ss.tokens_out || 0);
        if (totTokens < Number(minTokens)) return false;
      }

      return true;
    });

    // Sort by session started_at descending, then turn_index descending
    filteredTurns.sort((a: any, b: any) => {
      const ssA = sessionBySessionId.get(a.session_id);
      const ssB = sessionBySessionId.get(b.session_id);
      const tsA = ssA?.started_at || ssA?.synced_at || '';
      const tsB = ssB?.started_at || ssB?.synced_at || '';
      if (tsB !== tsA) return tsB.localeCompare(tsA);
      return Number(b.turn_index || 0) - Number(a.turn_index || 0);
    });

    const totalCount = filteredTurns.length;
    const paginated = filteredTurns.slice((page - 1) * limit, page * limit);

    const prompts = paginated.map((t: any) => {
      const ss = sessionBySessionId.get(t.session_id);
      const at = assistantByKey.get(`${t.session_id}:${t.turn_index}`);
      const member = ss ? memberById.get(ss.member_id) : null;
      return {
        id: t.id,
        sessionId: t.session_id,
        turnIndex: t.turn_index,
        promptText: t.prompt_text_sanitized,
        inputTokens: Number(at?.input_tokens || 0),
        outputTokens: Number(at?.output_tokens || 0),
        cacheRead: Number(at?.cache_read_tokens || 0),
        cacheWrite: Number(at?.cache_write_tokens || 0),
        model: t.model,
        tool: t.tool,
        userName: member?.display_name || 'Unknown User',
        createdAt: ss?.started_at || null,
      };
    });

    return NextResponse.json({
      prompts,
      page,
      limit,
      totalPages: Math.ceil(totalCount / limit),
      totalCount,
    });
  } catch (err: any) {
    console.error('[team-prompts GET error]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
