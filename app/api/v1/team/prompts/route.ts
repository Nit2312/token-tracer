import { NextRequest, NextResponse } from 'next/server';
import { getAuthorizedTeamId, getSessionFromCookie } from '@/lib/auth';
import { query } from '@/lib/team/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const session = getSessionFromCookie(req.headers.get('cookie'));
    if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const searchParams = req.nextUrl.searchParams;
    const page = Math.max(1, Number(searchParams.get('page') || 1));
    const limit = Math.max(1, Math.min(250, Number(searchParams.get('limit') || 50)));
    const offset = (page - 1) * limit;

    const from = searchParams.get('from');
    const to = searchParams.get('to');
    const source = searchParams.get('source');
    const minTokens = searchParams.get('minTokens');

    const conditions: string[] = ["st.turn_role = 'user'"];
    const params: any[] = [];
    let paramIdx = 1;

    if (session.role === 'user') {
      let memberId = session.memberId;
      if (!memberId) {
        try {
          const { rows: userRows } = await query('SELECT member_id FROM users WHERE id = $1', [session.userId]);
          if (userRows[0]?.member_id) {
            memberId = userRows[0].member_id;
          }
        } catch (err) {
          console.warn('[prompts user lookup error]', err);
        }
      }
      if (memberId) {
        conditions.push(`ss.member_id = $${paramIdx}::uuid`);
        params.push(memberId);
        paramIdx++;
      }
    } else {
      const rawTeamId = req.nextUrl.searchParams.get('teamId') || req.nextUrl.searchParams.get('team_id');
      const teamId = getAuthorizedTeamId(req, rawTeamId);
      if (!teamId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

      conditions.push("(ss.team_id = $1 OR ss.member_id IN (SELECT tm.member_id FROM team_members tm WHERE tm.team_id = $1))");
      params.push(teamId);
      paramIdx++;

      let memberIdParam = searchParams.get('memberIds') || searchParams.get('memberId') || 'all';
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (memberIdParam && memberIdParam !== 'all') {
        const memberIdsArr = memberIdParam.split(',').map((id) => id.trim()).filter((id) => Boolean(id) && id !== 'all' && UUID_RE.test(id));
        if (memberIdsArr.length === 1) {
          conditions.push(`ss.member_id = $${paramIdx}::uuid`);
          params.push(memberIdsArr[0]);
          paramIdx++;
        } else if (memberIdsArr.length > 1) {
          conditions.push(`ss.member_id = ANY($${paramIdx}::uuid[])`);
          params.push(memberIdsArr);
          paramIdx++;
        }
      }
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
        ss.member_id AS "memberId",
        COALESCE(ss.agent, 'default') AS "project",
        ss.started_at AS "createdAt"
      FROM session_turns st
      JOIN sync_sessions ss ON ss.session_id = st.session_id
      LEFT JOIN session_turns ast ON ast.session_id = st.session_id 
                                 AND ast.turn_index = st.turn_index 
                                 AND ast.turn_role = 'assistant'
      LEFT JOIN members m ON m.id = ss.member_id
      WHERE ${whereClause}
      ORDER BY ss.started_at DESC, st.turn_index DESC
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
    `;
    const listResult = await query(listQuery, listParams);

    if (listResult.rows.length === 0) {
      // Fallback to sync_sessions for personal or aggregate telemetry
      const sessionConditions: string[] = [];
      const sessionParams: any[] = [];
      let sIdx = 1;

      if (session.role === 'user') {
        let memberId = session.memberId;
        if (!memberId) {
          try {
            const { rows: userRows } = await query('SELECT member_id FROM users WHERE id = $1', [session.userId]);
            if (userRows[0]?.member_id) memberId = userRows[0].member_id;
          } catch {}
        }
        if (memberId) {
          sessionConditions.push(`ss.member_id = $${sIdx}::uuid`);
          sessionParams.push(memberId);
          sIdx++;
        }
      }
      if (from) {
        sessionConditions.push(`COALESCE(ss.ended_at, ss.started_at, ss.synced_at)::date >= $${sIdx}::date`);
        sessionParams.push(from);
        sIdx++;
      }
      if (to) {
        sessionConditions.push(`COALESCE(ss.ended_at, ss.started_at, ss.synced_at)::date <= $${sIdx}::date`);
        sessionParams.push(to);
        sIdx++;
      }
      if (source && source !== 'all') {
        sessionConditions.push(`ss.source = $${sIdx}`);
        sessionParams.push(source);
        sIdx++;
      }
      if (minTokens && Number(minTokens) > 0) {
        sessionConditions.push(`(ss.tokens_in + ss.tokens_out) >= $${sIdx}`);
        sessionParams.push(Number(minTokens));
        sIdx++;
      }

      const sWhere = sessionConditions.length ? `WHERE ${sessionConditions.join(' AND ')}` : '';
      const fallbackQuery = `
        SELECT 
          ss.session_id::text AS "id",
          ss.session_id AS "sessionId",
          1 AS "turnIndex",
          CONCAT('Agent session in ', COALESCE(ss.source, 'workspace'), ' (', COALESCE(ss.model, 'Claude 3.7 Sonnet'), ')') AS "promptText",
          COALESCE(ss.tokens_in, 0) AS "inputTokens",
          COALESCE(ss.tokens_out, 0) AS "outputTokens",
          COALESCE(ss.tokens_cache_read, 0) AS "cacheRead",
          COALESCE(ss.tokens_cache_write, 0) AS "cacheWrite",
          COALESCE(ss.model, 'Claude 3.7 Sonnet') AS "model",
          CASE WHEN ss.edits > 0 THEN 'replace_content' WHEN ss.tool_calls > 0 THEN 'view_file' ELSE NULL END AS "tool",
          COALESCE(m.display_name, 'Personal User') AS "userName",
          ss.member_id AS "memberId",
          COALESCE(ss.source, 'Token Tracer Core') AS "project",
          COALESCE(ss.started_at, ss.synced_at) AS "createdAt"
        FROM sync_sessions ss
        LEFT JOIN members m ON m.id = ss.member_id
        ${sWhere}
        ORDER BY (COALESCE(ss.tokens_in, 0) + COALESCE(ss.tokens_out, 0)) DESC, ss.started_at DESC
        LIMIT $${sIdx} OFFSET $${sIdx + 1}
      `;
      const fallbackResult = await query(fallbackQuery, [...sessionParams, limit, offset]);
      const countFallback = await query(`SELECT count(*)::int as total FROM sync_sessions ss ${sWhere}`, sessionParams);
      const totalS = countFallback.rows[0]?.total || fallbackResult.rows.length;

      return NextResponse.json({
        prompts: fallbackResult.rows,
        page,
        limit,
        totalPages: Math.ceil(totalS / limit),
        totalCount: totalS
      }, {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
          'Pragma': 'no-cache',
          'Expires': '0',
        },
      });
    }

    return NextResponse.json({
      prompts: listResult.rows,
      page,
      limit,
      totalPages: Math.ceil(totalCount / limit),
      totalCount
    }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    });
  } catch (err: any) {
    console.error('[team-prompts GET error]', err);
    return NextResponse.json({ error: err.message }, {
      status: 500,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  }
}
