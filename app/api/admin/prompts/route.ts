import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSessionFromCookie } from '@/lib/auth';
import { query } from '@/lib/team/db';

export const dynamic = 'force-dynamic';

function parseDays(range: string | null): number {
  if (range === '7d') return 7;
  if (range === '90d') return 90;
  if (range === '60d') return 60;
  return 30; // default 30d
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
    const members = searchParams.get('members');
    
    const page = Math.max(1, Number(searchParams.get('page') || 1));
    const limit = Math.max(1, Math.min(250, Number(searchParams.get('limit') || 50)));
    const offset = (page - 1) * limit;

    // Build filter conditions
    const conditions = ["ss.started_at >= NOW() - $1::int * INTERVAL '1 day'"];
    const params: any[] = [days];
    let paramIdx = 2;

    if (org) {
      conditions.push(`(ss.team_id::text = $${paramIdx} OR ss.member_id IN (SELECT tm.member_id FROM team_members tm WHERE tm.team_id::text = $${paramIdx}))`);
      params.push(org);
      paramIdx++;
    }
    if (tool) {
      conditions.push(`st.tool = $${paramIdx}`);
      params.push(tool);
      paramIdx++;
    }
    if (search) {
      conditions.push(`st.prompt_text_sanitized ILIKE $${paramIdx}`);
      params.push(`%${search}%`);
      paramIdx++;
    }
    if (members) {
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const memberIds = members.split(',').filter((id) => id && UUID_RE.test(id.trim()));
      if (memberIds.length > 0) {
        conditions.push(`ss.member_id = ANY($${paramIdx}::uuid[])`);
        params.push(memberIds);
        paramIdx++;
      }
    }

    const whereClause = conditions.join(' AND ');

    // 1. Fetch aggregates matching filters
    const statsQuery = `
      SELECT 
        COUNT(*)::int AS "totalPrompts",
        COALESCE(SUM(ast.input_tokens), 0)::bigint AS "totalInput",
        COALESCE(SUM(ast.output_tokens), 0)::bigint AS "totalOutput",
        COALESCE(SUM(ast.cache_read_tokens), 0)::bigint AS "totalCacheRead",
        COALESCE(SUM(ast.cache_write_tokens), 0)::bigint AS "totalCacheWrite"
      FROM session_turns st
      JOIN sync_sessions ss ON ss.session_id = st.session_id
      LEFT JOIN session_turns ast ON ast.session_id = st.session_id 
                                 AND ast.turn_index = st.turn_index 
                                 AND ast.turn_role = 'assistant'
      WHERE st.turn_role = 'user' AND ${whereClause}
    `;
    const statsResult = await query(statsQuery, params);
    const stats = statsResult.rows[0];

    // 2. Fetch detailed prompt turns
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
        st.intent_category AS "intentCategory",
        COALESCE(m.display_name, 'Unknown User') AS "userName",
        COALESCE(t.name, 'Unknown Team') AS "projectName",
        ss.started_at AS "createdAt"
      FROM session_turns st
      JOIN sync_sessions ss ON ss.session_id = st.session_id
      LEFT JOIN session_turns ast ON ast.session_id = st.session_id 
                                 AND ast.turn_index = st.turn_index 
                                 AND ast.turn_role = 'assistant'
      LEFT JOIN members m ON m.id = ss.member_id
      LEFT JOIN teams t ON t.id = ss.team_id
      WHERE st.turn_role = 'user' AND ${whereClause}
      ORDER BY ss.started_at DESC, st.turn_index DESC
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
    `;
    const listResult = await query(listQuery, listParams);

    // 3. Fetch scoped members matching current organization filter
    let membersQuery = '';
    let membersParams: any[] = [];
    if (org) {
      membersQuery = `
        SELECT DISTINCT m.id::text, m.display_name AS name
        FROM members m
        JOIN team_members tm ON tm.member_id = m.id
        WHERE tm.team_id::text = $1
        ORDER BY name
      `;
      membersParams = [org];
    } else {
      membersQuery = `
        SELECT id::text, display_name AS name
        FROM members
        ORDER BY name
      `;
    }
    const membersResult = await query(membersQuery, membersParams);

    return NextResponse.json({
      stats,
      prompts: listResult.rows,
      page,
      limit,
      totalPages: Math.ceil((stats?.totalPrompts || 0) / limit),
      members: membersResult.rows
    });
  } catch (err: any) {
    console.error('[admin-prompts-error]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
