import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSessionFromCookie } from '@/lib/auth';
import { queryCol } from '@/lib/team/db';

export const dynamic = 'force-dynamic';

function parseDays(range: string | null): number {
  if (range === '7d') return 7;
  if (range === '90d') return 90;
  if (range === '60d') return 60;
  return 30;
}

export async function GET(req: NextRequest) {
  const cookieStore = await cookies();
  const session = getSessionFromCookie(cookieStore.toString());
  if (!session || session.role !== 'superadmin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const searchParams = req.nextUrl.searchParams;
    const days = parseDays(searchParams.get('range'));
    const org = searchParams.get('org');
    const tool = searchParams.get('tool');
    const search = searchParams.get('search');
    const membersFilter = searchParams.get('members');

    const page = Math.max(1, Number(searchParams.get('page') || 1));
    const limit = Math.max(1, Math.min(250, Number(searchParams.get('limit') || 50)));

    const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();

    // Fetch session_turns from Firestore
    const turnConstraints: Parameters<typeof queryCol>[1] = [
      { type: 'where', field: 'turn_role', op: '==', value: 'user' },
    ];
    let allTurns = await queryCol<any>('session_turns', turnConstraints);

    // Fetch sync_sessions to join
    const sessionDocs = await queryCol<any>('sync_sessions', [
      { type: 'where', field: 'started_at', op: '>=', value: cutoff },
    ]);
    const sessionBySessionId = new Map(sessionDocs.map((s: any) => [s.session_id || s.id, s]));

    // Fetch member/team info for display
    const memberDocs = await queryCol<any>('members');
    const teamDocs = await queryCol<any>('teams');
    const memberById = new Map(memberDocs.map((m: any) => [m.id, m]));
    const teamById = new Map(teamDocs.map((t: any) => [t.id, t]));

    // Filter turns
    let filteredTurns = allTurns.filter((t: any) => {
      const ss = sessionBySessionId.get(t.session_id);
      if (!ss) return false;
      if (ss.started_at < cutoff) return false;
      if (org && ss.team_id !== org) return false;
      if (tool && t.tool !== tool) return false;
      if (search && !String(t.prompt_text_sanitized || '').toLowerCase().includes(search.toLowerCase())) return false;
      if (membersFilter) {
        const mIds = membersFilter.split(',').filter(Boolean);
        if (!mIds.includes(ss.member_id)) return false;
      }
      return true;
    });

    // Build assistant turns index for token lookups
    const assistantTurns = await queryCol<any>('session_turns', [
      { type: 'where', field: 'turn_role', op: '==', value: 'assistant' },
    ]);
    const assistantByKey = new Map<string, any>();
    for (const at of assistantTurns) {
      const key = `${at.session_id}:${at.turn_index}`;
      assistantByKey.set(key, at);
    }

    // Aggregate stats
    let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0;
    for (const t of filteredTurns) {
      const at = assistantByKey.get(`${t.session_id}:${t.turn_index}`);
      totalInput += Number(at?.input_tokens || 0);
      totalOutput += Number(at?.output_tokens || 0);
      totalCacheRead += Number(at?.cache_read_tokens || 0);
      totalCacheWrite += Number(at?.cache_write_tokens || 0);
    }
    const stats = { totalPrompts: filteredTurns.length, totalInput, totalOutput, totalCacheRead, totalCacheWrite };

    // Sort and paginate
    filteredTurns.sort((a: any, b: any) => {
      const ssA = sessionBySessionId.get(a.session_id);
      const ssB = sessionBySessionId.get(b.session_id);
      const ts = (String(ssB?.started_at || '') + String(b.turn_index || 0))
        .localeCompare(String(ssA?.started_at || '') + String(a.turn_index || 0));
      return ts;
    });
    const paginated = filteredTurns.slice((page - 1) * limit, page * limit);

    const prompts = paginated.map((t: any) => {
      const ss = sessionBySessionId.get(t.session_id);
      const at = assistantByKey.get(`${t.session_id}:${t.turn_index}`);
      const member = ss ? memberById.get(ss.member_id) : null;
      const team = ss ? teamById.get(ss.team_id) : null;
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
        intentCategory: t.intent_category,
        userName: member?.display_name || 'Unknown User',
        projectName: team?.name || 'Unknown Team',
        createdAt: ss?.started_at || null,
      };
    });

    // Members for filter dropdown
    let members: any[];
    if (org) {
      const tmDocs = await queryCol<any>('team_members', [{ type: 'where', field: 'team_id', op: '==', value: org }]);
      const memberIdsInOrg = new Set(tmDocs.map((tm: any) => tm.member_id));
      members = memberDocs.filter((m: any) => memberIdsInOrg.has(m.id)).map((m: any) => ({ id: m.id, name: m.display_name }));
    } else {
      members = memberDocs.map((m: any) => ({ id: m.id, name: m.display_name }));
    }
    members.sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));

    return NextResponse.json({ stats, prompts, page, limit, totalPages: Math.ceil(filteredTurns.length / limit), members });
  } catch (err: any) {
    console.error('[admin-prompts-error]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
