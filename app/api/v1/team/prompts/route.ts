import { NextRequest, NextResponse } from 'next/server';
import { getAuthorizedTeamId, getSessionFromCookie } from '@/lib/auth';
import { query } from '@/lib/team/db';

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
    const offset = (page - 1) * limit;

    // Filter by memberId if role === 'user', or optional global-member-filter parameter if admin
    let memberId = searchParams.get('memberIds') || searchParams.get('memberId') || 'all';
    if (session?.role === 'user') {
      memberId = session.memberId || 'all';
    }

    const from = searchParams.get('from');
    const to = searchParams.get('to');
    const source = searchParams.get('source');
    const minTokens = searchParams.get('minTokens');

    const conditions = ["ss.team_id = $1", "st.turn_role = 'user'"];
    const params: any[] = [teamId];
    let paramIdx = 2;

    let memberIdsArr: string[] = [];
    if (memberId && memberId !== 'all') {
      memberIdsArr = memberId.split(',').map((id) => id.trim()).filter((id) => Boolean(id) && id !== 'all');
    }

    if (memberIdsArr.length === 1) {
      conditions.push(`ss.member_id = $${paramIdx}`);
      params.push(memberIdsArr[0]);
      paramIdx++;
    } else if (memberIdsArr.length > 1) {
      conditions.push(`ss.member_id = ANY($${paramIdx}::text[])`);
      params.push(memberIdsArr);
      paramIdx++;
    }
    if (from) {
      conditions.push(`COALESCE(ss.ended_at, ss.started_at, ss.synced_at)::date >= $${paramIdx}::date`);
      params.push(from);
      paramIdx++;
    }
    if (to) {
      conditions.push(`COALESCE(ss.ended_at, ss.started_at, ss.synced_at)::date <= $${paramIdx}::date`);
      params.push(to);
      paramIdx++;
    }
    if (source && source !== 'all') {
      conditions.push(`ss.source = $${paramIdx}`);
      params.push(source);
      paramIdx++;
    }
    if (minTokens && Number(minTokens) > 0) {
      conditions.push(`(ss.tokens_in + ss.tokens_out) >= $${paramIdx}`);
      params.push(Number(minTokens));
      paramIdx++;
    }

    const whereClause = conditions.join(' AND ');

    // Get total count
    const countQuery = `
      SELECT COUNT(*)::int AS total
      FROM session_turns st
      JOIN sync_sessions ss ON ss.session_id = st.session_id
                           AND st.org_id = ss.team_id::text
                           AND st.user_id = ss.member_id::text
                           AND st.tool = ss.source
      WHERE ${whereClause}
    `;
    const countResult = await query(countQuery, params);
    const totalCount = countResult.rows[0]?.total || 0;

    // Get prompt turns
    const listParams = [...params, limit, offset];
    const listQuery = `
      SELECT 
        st.id::text,
        st.session_id AS "sessionId",
        st.turn_index AS "turnIndex",
        st.prompt_text_sanitized AS "promptText",
        COALESCE(ast.input_tokens, 0) AS "inputTokens",
        COALESCE(ast.output_tokens, 0) AS "outputTokens",
        COALESCE(ast.cache_read_tokens, 0) AS "cacheRead",
        COALESCE(ast.cache_write_tokens, 0) AS "cacheWrite",
        st.model,
        st.tool,
        COALESCE(m.display_name, 'Unknown User') AS "userName",
        ss.started_at AS "createdAt"
      FROM session_turns st
      JOIN sync_sessions ss ON ss.session_id = st.session_id
                           AND st.org_id = ss.team_id::text
                           AND st.user_id = ss.member_id::text
                           AND st.tool = ss.source
      LEFT JOIN session_turns ast ON ast.session_id = st.session_id 
                                 AND ast.org_id = st.org_id
                                 AND ast.user_id = st.user_id
                                 AND ast.tool = st.tool
                                 AND ast.turn_index = st.turn_index 
                                 AND ast.turn_role = 'assistant'
      LEFT JOIN members m ON m.id = ss.member_id
      WHERE ${whereClause}
      ORDER BY ss.started_at DESC, st.turn_index DESC
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
    `;
    const listResult = await query(listQuery, listParams);

    return NextResponse.json({
      prompts: listResult.rows,
      page,
      limit,
      totalPages: Math.ceil(totalCount / limit),
      totalCount
    });
  } catch (err: any) {
    console.error('[team-prompts GET error]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
