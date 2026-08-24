/**
 * Platform-wide Token Whale and Deep-Dive Usage Analysis (PostgreSQL / Neon backend).
 * Computes multi-dimensional breakdowns (Projects, Tools, Models, Sessions, Files, Timelines)
 * for both Team Admin and Superadmin scopes.
 */
import { query } from '@/lib/team/db';
import { statsCache } from '@/lib/team/cache';

export interface WhaleFilterOptions {
  range?: string | null; // '7d' | '30d' | '90d' | 'all'
  teamId?: string | null;
  minTokens?: number | null;
  search?: string | null;
  limit?: number;
}

export interface MemberDeepDiveOptions {
  range?: string | null;
  from?: string | null;
  to?: string | null;
  source?: string | null;
  model?: string | null;
  teamId?: string | null;
}

const EFF_IN = `CASE WHEN s.tokens_in = 0 AND (s.tool_calls + s.edits) > 0 THEN GREATEST(500, (s.tool_calls + s.edits) * 350 + s.changed_lines * 10) ELSE s.tokens_in END`;
const EFF_OUT = `CASE WHEN s.tokens_out = 0 AND (s.tool_calls + s.edits) > 0 THEN GREATEST(200, (s.tool_calls + s.edits) * 150 + s.changed_lines * 5) ELSE s.tokens_out END`;

/**
 * Fetch platform-wide token spenders (Whales) across all teams or filtered by team.
 */
export async function getPlatformWhales(options: WhaleFilterOptions = {}) {
  const range = options.range || 'all';
  const teamId = options.teamId && options.teamId !== 'all' ? options.teamId : null;
  const minTokens = Number(options.minTokens) || 0;
  const search = (options.search || '').trim().toLowerCase();
  const limit = options.limit || 100;

  const cacheKey = `whale_analysis_pg_${range}_${teamId || 'all'}_${minTokens}_${search}_${limit}`;

  return statsCache.getOrSet(cacheKey, 45, async () => {
    const params: unknown[] = [];
    let dateWhere = '';

    if (range && range !== 'all') {
      const match = range.match(/^(\d+)d$/);
      const days = match ? Number(match[1]) : 30;
      params.push(`${days} days`);
      dateWhere += ` AND COALESCE(s.ended_at, s.started_at, s.synced_at) >= (NOW() - $${params.length}::interval)`;
    }

    let teamWhere = '';
    if (teamId) {
      params.push(teamId);
      teamWhere = ` AND s.team_id = $${params.length}`;
    }

    // 1. Fetch per-member stats with SQL aggregates
    const memberQuery = `
      SELECT
        s.member_id,
        COALESCE(m.display_name, 'Unknown Member') AS display_name,
        s.team_id,
        COALESCE(t.name, 'Independent') AS team_name,
        COUNT(s.id)::int AS sessions_count,
        COALESCE(SUM(${EFF_IN}), 0)::bigint AS tokens_in,
        COALESCE(SUM(${EFF_OUT}), 0)::bigint AS tokens_out,
        COALESCE(SUM(s.tokens_cache_read), 0)::bigint AS tokens_cache_read,
        COALESCE(SUM(s.tokens_cache_write), 0)::bigint AS tokens_cache_write,
        COALESCE(SUM(${EFF_IN} + ${EFF_OUT}), 0)::bigint AS total_tokens,
        COALESCE(SUM(s.api_cost), 0)::double precision AS api_cost,
        COALESCE(SUM(s.edits), 0)::int AS edits,
        COALESCE(SUM(s.changed_lines), 0)::int AS changed_lines,
        COALESCE(SUM(s.tool_calls), 0)::int AS tool_calls,
        COALESCE(SUM(s.tool_errors), 0)::int AS tool_errors,
        COALESCE(SUM(s.rework_loops), 0)::int AS rework_loops,
        COUNT(CASE WHEN (${EFF_IN} + ${EFF_OUT}) > 5000000 OR s.tool_errors > 15 OR s.rework_loops > 5 THEN 1 END)::int AS runaway_count,
        MIN(COALESCE(s.started_at, s.synced_at)) AS first_active,
        MAX(COALESCE(s.ended_at, s.synced_at)) AS last_active
      FROM sync_sessions s
      LEFT JOIN members m ON m.id = s.member_id
      LEFT JOIN teams t ON t.id = s.team_id
      WHERE 1=1 ${dateWhere} ${teamWhere}
      GROUP BY s.member_id, m.display_name, s.team_id, t.name
      ORDER BY total_tokens DESC
    `;

    const { rows: memberRows } = await query(memberQuery, params);

    // 2. Fetch top project, model, source per member in bulk
    const breakdownQuery = `
      WITH ranked_projects AS (
        SELECT
          s.member_id,
          COALESCE(s.agent, 'default') AS project_name,
          SUM(${EFF_IN} + ${EFF_OUT})::bigint AS project_tokens,
          SUM(s.api_cost)::double precision AS project_cost,
          ROW_NUMBER() OVER (PARTITION BY s.member_id ORDER BY SUM(${EFF_IN} + ${EFF_OUT}) DESC) AS rn
        FROM sync_sessions s
        WHERE 1=1 ${dateWhere} ${teamWhere}
        GROUP BY s.member_id, s.agent
      ),
      ranked_models AS (
        SELECT
          s.member_id,
          COALESCE(s.model, 'default') AS model_name,
          ROW_NUMBER() OVER (PARTITION BY s.member_id ORDER BY SUM(${EFF_IN} + ${EFF_OUT}) DESC) AS rn
        FROM sync_sessions s
        WHERE 1=1 ${dateWhere} ${teamWhere}
        GROUP BY s.member_id, s.model
      ),
      ranked_sources AS (
        SELECT
          s.member_id,
          COALESCE(s.source, 'cursor') AS source_name,
          ROW_NUMBER() OVER (PARTITION BY s.member_id ORDER BY SUM(${EFF_IN} + ${EFF_OUT}) DESC) AS rn
        FROM sync_sessions s
        WHERE 1=1 ${dateWhere} ${teamWhere}
        GROUP BY s.member_id, s.source
      )
      SELECT
        p.member_id,
        p.project_name,
        p.project_tokens,
        p.project_cost,
        m.model_name,
        src.source_name
      FROM ranked_projects p
      LEFT JOIN ranked_models m ON m.member_id = p.member_id AND m.rn = 1
      LEFT JOIN ranked_sources src ON src.member_id = p.member_id AND src.rn = 1
      WHERE p.rn = 1
    `;

    const { rows: breakdownRows } = await query(breakdownQuery, params);
    const breakdownMap = new Map(breakdownRows.map((r: any) => [r.member_id, r]));

    let whales = memberRows.map((row: any) => {
      const b = breakdownMap.get(row.member_id);
      const totalTok = Number(row.total_tokens || 0);
      const projTok = Number(b?.project_tokens || 0);
      const projPct = totalTok > 0 ? (projTok / totalTok) * 100 : 0;

      return {
        memberId: row.member_id,
        displayName: row.display_name,
        teamId: row.team_id,
        teamName: row.team_name,
        sessionsCount: Number(row.sessions_count || 0),
        tokensIn: Number(row.tokens_in || 0),
        tokensOut: Number(row.tokens_out || 0),
        tokensCacheRead: Number(row.tokens_cache_read || 0),
        tokensCacheWrite: Number(row.tokens_cache_write || 0),
        totalTokens: totalTok,
        apiCost: Number(row.api_cost || 0),
        edits: Number(row.edits || 0),
        changedLines: Number(row.changed_lines || 0),
        toolCalls: Number(row.tool_calls || 0),
        toolErrors: Number(row.tool_errors || 0),
        reworkLoops: Number(row.rework_loops || 0),
        runawayCount: Number(row.runaway_count || 0),
        firstActive: row.first_active,
        lastActive: row.last_active,
        topProject: {
          name: b?.project_name || 'none',
          tokens: projTok,
          cost: Number(b?.project_cost || 0),
          percentage: projPct,
        },
        topModel: b?.model_name || 'default',
        topSource: b?.source_name || 'cursor',
        avgTokensPerSession: Number(row.sessions_count) > 0 ? Math.round(totalTok / Number(row.sessions_count)) : 0,
      };
    });

    if (minTokens > 0) {
      whales = whales.filter((w) => w.totalTokens >= minTokens);
    }
    if (search) {
      whales = whales.filter((w) =>
        w.displayName.toLowerCase().includes(search) ||
        w.teamName.toLowerCase().includes(search) ||
        w.topProject.name.toLowerCase().includes(search) ||
        w.topModel.toLowerCase().includes(search)
      );
    }

    // 3. Platform totals & top global projects / models & extreme sessions in parallel
    const totalsQuery = `
      SELECT
        COALESCE(SUM(${EFF_IN}), 0)::bigint AS tokens_in,
        COALESCE(SUM(${EFF_OUT}), 0)::bigint AS tokens_out,
        COALESCE(SUM(s.tokens_cache_read), 0)::bigint AS tokens_cache_read,
        COALESCE(SUM(s.api_cost), 0)::double precision AS total_cost,
        COUNT(s.id)::int AS total_sessions
      FROM sync_sessions s
      WHERE 1=1 ${dateWhere} ${teamWhere}
    `;

    const topProjGlobalQuery = `
      SELECT
        COALESCE(s.agent, 'default') AS name,
        COALESCE(SUM(${EFF_IN} + ${EFF_OUT}), 0)::bigint AS tokens,
        COALESCE(SUM(s.api_cost), 0)::double precision AS cost,
        COUNT(s.id)::int AS sessions
      FROM sync_sessions s
      WHERE 1=1 ${dateWhere} ${teamWhere}
      GROUP BY s.agent
      ORDER BY tokens DESC
      LIMIT 10
    `;

    const topModelsGlobalQuery = `
      SELECT
        COALESCE(s.model, 'default') AS name,
        COALESCE(SUM(${EFF_IN} + ${EFF_OUT}), 0)::bigint AS tokens,
        COALESCE(SUM(s.api_cost), 0)::double precision AS cost,
        COUNT(s.id)::int AS sessions
      FROM sync_sessions s
      WHERE 1=1 ${dateWhere} ${teamWhere}
      GROUP BY s.model
      ORDER BY tokens DESC
      LIMIT 10
    `;

    // 4. Extreme Runaway Sessions
    const extremeSessionsQuery = `
      SELECT
        s.id AS doc_id,
        s.session_id,
        s.member_id,
        COALESCE(m.display_name, 'Unknown') AS member_name,
        COALESCE(t.name, 'Independent') AS team_name,
        COALESCE(s.agent, 'default') AS project,
        COALESCE(s.source, 'cursor') AS source,
        COALESCE(s.model, 'default') AS model,
        (${EFF_IN})::bigint AS tokens_in,
        (${EFF_OUT})::bigint AS tokens_out,
        COALESCE(s.tokens_cache_read, 0)::bigint AS tokens_cache_read,
        (${EFF_IN} + ${EFF_OUT})::bigint AS total_tokens,
        COALESCE(s.api_cost, 0)::double precision AS api_cost,
        COALESCE(s.tool_calls, 0)::int AS tool_calls,
        COALESCE(s.tool_errors, 0)::int AS tool_errors,
        COALESCE(s.rework_loops, 0)::int AS rework_loops,
        s.started_at,
        s.ended_at,
        s.synced_at
      FROM sync_sessions s
      LEFT JOIN members m ON m.id = s.member_id
      LEFT JOIN teams t ON t.id = s.team_id
      WHERE 1=1 ${dateWhere} ${teamWhere}
      ORDER BY total_tokens DESC, api_cost DESC
      LIMIT 10
    `;

    const [totalRes, topProjRes, topModRes, extremeRes] = await Promise.all([
      query(totalsQuery, params),
      query(topProjGlobalQuery, params),
      query(topModelsGlobalQuery, params),
      query(extremeSessionsQuery, params),
    ]);

    const totalsRow = totalRes.rows[0] || {};
    const globalTokIn = Number(totalsRow.tokens_in || 0);
    const globalTokOut = Number(totalsRow.tokens_out || 0);
    const topProjectsGlobal = topProjRes.rows;
    const topModelsGlobal = topModRes.rows;
    const extremeSessions = extremeRes.rows;

    return {
      whales: whales.slice(0, limit),
      totalWhales: whales.length,
      totals: {
        totalTokens: globalTokIn + globalTokOut,
        tokensIn: globalTokIn,
        tokensOut: globalTokOut,
        tokensCacheRead: Number(totalsRow.tokens_cache_read || 0),
        totalCost: Number(totalsRow.total_cost || 0),
        totalSessions: Number(totalsRow.total_sessions || 0),
      },
      topProjectsGlobal: topProjectsGlobal.map((p: any) => ({
        name: p.name,
        tokens: Number(p.tokens),
        cost: Number(p.cost),
        sessions: Number(p.sessions),
      })),
      topModelsGlobal: topModelsGlobal.map((m: any) => ({
        name: m.name,
        tokens: Number(m.tokens),
        cost: Number(m.cost),
        sessions: Number(m.sessions),
      })),
      extremeSessions: extremeSessions.map((s: any) => ({
        docId: s.doc_id,
        sessionId: s.session_id,
        memberId: s.member_id,
        memberName: s.member_name,
        teamName: s.team_name,
        project: s.project,
        source: s.source,
        model: s.model,
        tokensIn: Number(s.tokens_in),
        tokensOut: Number(s.tokens_out),
        tokensCacheRead: Number(s.tokens_cache_read),
        totalTokens: Number(s.total_tokens),
        apiCost: Number(s.api_cost),
        toolCalls: Number(s.tool_calls),
        toolErrors: Number(s.tool_errors),
        reworkLoops: Number(s.rework_loops),
        startedAt: s.started_at,
        endedAt: s.ended_at,
        syncedAt: s.synced_at,
      })),
    };
  });
}

/**
 * Deep-dive analysis for single or multiple team members (or entire team):
 * Returns the multi-dimensional breakdown (Projects, Tools, Models, Top Heavy Sessions, Files, Daily Timeline, Member Comparisons).
 */
export async function buildMemberUsageDeepDive(
  memberInput: string | string[],
  options: MemberDeepDiveOptions = {}
) {
  const { range = 'all', from = null, to = null, source = null, model = null, teamId = null } = options;

  let memberIds: string[] = [];
  if (Array.isArray(memberInput)) {
    memberIds = memberInput.map((id) => String(id).trim()).filter(Boolean);
  } else if (typeof memberInput === 'string') {
    memberIds = memberInput.split(',').map((id) => id.trim()).filter(Boolean);
  }

  const isAll = memberIds.includes('all') || memberIds.length === 0;
  const sortedIdsKey = isAll ? 'all' : [...memberIds].sort().join('_');
  const cacheKey = `member_deep_dive_pg_${sortedIdsKey}_${teamId || 'any'}_${range}_${from || ''}_${to || ''}_${source || ''}_${model || ''}`;

  return statsCache.getOrSet(cacheKey, 300, async () => {
    // 1. Fetch Member(s) & Team metadata
    let memberRes;
    let memberWhere = '';
    const params: unknown[] = [];

    if (isAll && teamId) {
      params.push(teamId);
      memberWhere = `s.team_id = $1`;
      memberRes = await query(
        `SELECT m.id, m.display_name, m.created_at, m.team_id, t.name AS team_name
         FROM members m
         LEFT JOIN teams t ON t.id = m.team_id
         WHERE m.team_id = $1
         ORDER BY m.display_name ASC`,
        [teamId]
      );
    } else if (memberIds.length === 1 && !isAll) {
      params.push(memberIds[0]);
      memberWhere = `s.member_id = $1`;
      memberRes = await query(
        `SELECT m.id, m.display_name, m.created_at, m.team_id, t.name AS team_name
         FROM members m
         LEFT JOIN teams t ON t.id = m.team_id
         WHERE m.id = $1`,
        [memberIds[0]]
      );
    } else {
      params.push(memberIds);
      memberWhere = `s.member_id = ANY($1::uuid[])`;
      memberRes = await query(
        `SELECT m.id, m.display_name, m.created_at, m.team_id, t.name AS team_name
         FROM members m
         LEFT JOIN teams t ON t.id = m.team_id
         WHERE m.id = ANY($1::uuid[])
         ORDER BY m.display_name ASC`,
        [memberIds]
      );
    }

    if (!memberRes.rows.length && !isAll) {
      return null;
    }

    const memberRows = memberRes.rows;
    const isMulti = memberRows.length > 1 || isAll;
    const firstRow = memberRows[0] || {};

    const member = {
      id: isAll ? 'all' : memberRows.map((r) => r.id).join(','),
      displayName: isAll
        ? `All Team Members (${memberRows.length})`
        : memberRows.length === 1
        ? firstRow.display_name
        : `${memberRows.length} Members (${memberRows.slice(0, 3).map((r) => r.display_name).join(', ')}${memberRows.length > 3 ? '…' : ''})`,
      teamId: firstRow.team_id || teamId,
      teamName: firstRow.team_name || 'Independent',
      createdAt: firstRow.created_at,
      isMulti,
      count: memberRows.length,
      selectedMembers: memberRows.map((r) => ({ id: r.id, displayName: r.display_name })),
    };

    let filters = '';

    if (range && range !== 'all') {
      const match = range.match(/^(\d+)d$/);
      const days = match ? Number(match[1]) : 30;
      params.push(`${days} days`);
      filters += ` AND COALESCE(s.ended_at, s.started_at, s.synced_at) >= (NOW() - $${params.length}::interval)`;
    }
    if (from) {
      params.push(from);
      filters += ` AND COALESCE(s.ended_at, s.started_at, s.synced_at) >= ($${params.length}::date)::timestamptz`;
    }
    if (to) {
      params.push(to);
      filters += ` AND COALESCE(s.ended_at, s.started_at, s.synced_at) < (($${params.length}::date) + INTERVAL '1 day')`;
    }
    if (source && source !== 'all') {
      params.push(source);
      filters += ` AND s.source = $${params.length}`;
    }
    if (model && model !== 'all') {
      params.push(model);
      filters += ` AND s.model = $${params.length}`;
    }

    // 2. Execute all independent aggregation queries in parallel
    const totalsQuery = `SELECT
        COALESCE(SUM(${EFF_IN}), 0)::bigint AS tokens_in,
        COALESCE(SUM(${EFF_OUT}), 0)::bigint AS tokens_out,
        COALESCE(SUM(s.tokens_cache_read), 0)::bigint AS tokens_cache_read,
        COALESCE(SUM(s.tokens_cache_write), 0)::bigint AS tokens_cache_write,
        COALESCE(SUM(${EFF_IN} + ${EFF_OUT}), 0)::bigint AS total_tokens,
        COALESCE(SUM(s.api_cost), 0)::double precision AS total_cost,
        COUNT(s.id)::int AS session_count,
        COUNT(DISTINCT COALESCE(s.ended_at, s.started_at, s.synced_at)::date)::int AS active_days,
        COALESCE(SUM(s.edits), 0)::int AS edits,
        COALESCE(SUM(s.changed_lines), 0)::int AS changed_lines,
        COALESCE(SUM(s.tool_calls), 0)::int AS tool_calls,
        COALESCE(SUM(s.tool_errors), 0)::int AS tool_errors,
        COALESCE(SUM(s.rework_loops), 0)::int AS rework_loops,
        COUNT(CASE WHEN (${EFF_IN} + ${EFF_OUT}) > 5000000 OR s.tool_errors > 15 OR s.rework_loops > 5 THEN 1 END)::int AS runaway_count
       FROM sync_sessions s
       WHERE ${memberWhere} ${filters}`;

    const projectsQuery = `SELECT
        COALESCE(s.agent, 'default') AS project,
        array_agg(DISTINCT s.source) AS sources,
        array_agg(DISTINCT s.model) AS models,
        COUNT(s.id)::int AS sessions,
        COALESCE(SUM(${EFF_IN}), 0)::bigint AS tokens_in,
        COALESCE(SUM(${EFF_OUT}), 0)::bigint AS tokens_out,
        COALESCE(SUM(s.tokens_cache_read), 0)::bigint AS tokens_cache_read,
        COALESCE(SUM(${EFF_IN} + ${EFF_OUT}), 0)::bigint AS total_tokens,
        COALESCE(SUM(s.api_cost), 0)::double precision AS api_cost,
        COALESCE(SUM(s.edits), 0)::int AS edits,
        COALESCE(SUM(s.changed_lines), 0)::int AS changed_lines,
        MAX(COALESCE(s.ended_at, s.started_at, s.synced_at)) AS last_active
       FROM sync_sessions s
       WHERE ${memberWhere} ${filters}
       GROUP BY s.agent
       ORDER BY total_tokens DESC`;

    const toolsQuery = `SELECT
        COALESCE(s.source, 'cursor') AS source,
        COUNT(s.id)::int AS sessions,
        COALESCE(SUM(${EFF_IN}), 0)::bigint AS tokens_in,
        COALESCE(SUM(${EFF_OUT}), 0)::bigint AS tokens_out,
        COALESCE(SUM(s.tokens_cache_read), 0)::bigint AS tokens_cache_read,
        COALESCE(SUM(${EFF_IN} + ${EFF_OUT}), 0)::bigint AS total_tokens,
        COALESCE(SUM(s.api_cost), 0)::double precision AS api_cost
       FROM sync_sessions s
       WHERE ${memberWhere} ${filters}
       GROUP BY s.source
       ORDER BY total_tokens DESC`;

    const modelsQuery = `SELECT
        COALESCE(s.model, 'default') AS model,
        COALESCE(s.source, 'cursor') AS source,
        COUNT(s.id)::int AS sessions,
        COALESCE(SUM(${EFF_IN}), 0)::bigint AS tokens_in,
        COALESCE(SUM(${EFF_OUT}), 0)::bigint AS tokens_out,
        COALESCE(SUM(s.tokens_cache_read), 0)::bigint AS tokens_cache_read,
        COALESCE(SUM(${EFF_IN} + ${EFF_OUT}), 0)::bigint AS total_tokens,
        COALESCE(SUM(s.api_cost), 0)::double precision AS api_cost
       FROM sync_sessions s
       WHERE ${memberWhere} ${filters}
       GROUP BY s.model, s.source
       ORDER BY total_tokens DESC`;

    const sessionsQuery = `SELECT
        s.id AS doc_id,
        s.session_id,
        s.member_id,
        COALESCE(m.display_name, 'Unknown Member') AS member_name,
        COALESCE(s.agent, 'default') AS project,
        COALESCE(s.source, 'cursor') AS source,
        COALESCE(s.model, 'default') AS model,
        (${EFF_IN})::bigint AS tokens_in,
        (${EFF_OUT})::bigint AS tokens_out,
        COALESCE(s.tokens_cache_read, 0)::bigint AS tokens_cache_read,
        COALESCE(s.tokens_cache_write, 0)::bigint AS tokens_cache_write,
        (${EFF_IN} + ${EFF_OUT})::bigint AS total_tokens,
        COALESCE(s.api_cost, 0)::double precision AS api_cost,
        COALESCE(s.edits, 0)::int AS edits,
        COALESCE(s.changed_lines, 0)::int AS changed_lines,
        COALESCE(s.tool_calls, 0)::int AS tool_calls,
        COALESCE(s.tool_errors, 0)::int AS tool_errors,
        COALESCE(s.rework_loops, 0)::int AS rework_loops,
        CASE WHEN (${EFF_IN} + ${EFF_OUT}) > 5000000 OR s.tool_errors > 15 OR s.rework_loops > 5 THEN true ELSE false END AS is_runaway,
        s.started_at,
        s.ended_at,
        s.synced_at
       FROM sync_sessions s
       LEFT JOIN members m ON m.id = s.member_id
       WHERE ${memberWhere} ${filters}
       ORDER BY total_tokens DESC, api_cost DESC
       LIMIT 25`;

    const filesQuery = `
      WITH heavy_sessions AS (
        SELECT s.id
        FROM sync_sessions s
        WHERE ${memberWhere} ${filters}
        ORDER BY (${EFF_IN} + ${EFF_OUT}) DESC
        LIMIT 100
      )
      SELECT
        f.path,
        COALESCE(SUM(f.edits), 0)::int AS edits,
        COALESCE(SUM(f.additions), 0)::int AS additions,
        COALESCE(SUM(f.deletions), 0)::int AS deletions,
        COALESCE(SUM(f.additions + f.deletions), 0)::int AS changed_lines
      FROM sync_session_files f
      JOIN heavy_sessions hs ON hs.id = f.sync_session_id
      GROUP BY f.path
      ORDER BY changed_lines DESC, edits DESC
      LIMIT 20`;

    const timelineQuery = `SELECT
        COALESCE(s.ended_at, s.started_at, s.synced_at)::date::text AS day,
        COUNT(s.id)::int AS sessions,
        COALESCE(SUM(${EFF_IN}), 0)::bigint AS tokens_in,
        COALESCE(SUM(${EFF_OUT}), 0)::bigint AS tokens_out,
        COALESCE(SUM(s.tokens_cache_read), 0)::bigint AS tokens_cache_read,
        COALESCE(SUM(${EFF_IN} + ${EFF_OUT}), 0)::bigint AS total_tokens,
        COALESCE(SUM(s.api_cost), 0)::double precision AS api_cost,
        COALESCE(SUM(s.edits), 0)::int AS edits
       FROM sync_sessions s
       WHERE ${memberWhere} ${filters}
       GROUP BY day
       ORDER BY day ASC`;

    const memberBreakdownQuery = isMulti
      ? `SELECT
          s.member_id,
          COALESCE(m.display_name, 'Unknown Member') AS display_name,
          COUNT(s.id)::int AS sessions,
          COALESCE(SUM(${EFF_IN}), 0)::bigint AS tokens_in,
          COALESCE(SUM(${EFF_OUT}), 0)::bigint AS tokens_out,
          COALESCE(SUM(s.tokens_cache_read), 0)::bigint AS tokens_cache_read,
          COALESCE(SUM(${EFF_IN} + ${EFF_OUT}), 0)::bigint AS total_tokens,
          COALESCE(SUM(s.api_cost), 0)::double precision AS api_cost,
          COALESCE(SUM(s.edits), 0)::int AS edits,
          COALESCE(SUM(s.changed_lines), 0)::int AS changed_lines,
          COALESCE(SUM(s.tool_calls), 0)::int AS tool_calls,
          COALESCE(SUM(s.tool_errors), 0)::int AS tool_errors,
          COALESCE(SUM(s.rework_loops), 0)::int AS rework_loops
         FROM sync_sessions s
         LEFT JOIN members m ON m.id = s.member_id
         WHERE ${memberWhere} ${filters}
         GROUP BY s.member_id, m.display_name
         ORDER BY total_tokens DESC`
      : null;

    const [
      totalsRes,
      projectsRes,
      toolsRes,
      modelsRes,
      sessionsRes,
      filesRes,
      timelineRes,
      memberBreakdownRes,
    ] = await Promise.all([
      query(totalsQuery, params),
      query(projectsQuery, params),
      query(toolsQuery, params),
      query(modelsQuery, params),
      query(sessionsQuery, params),
      query(filesQuery, params),
      query(timelineQuery, params),
      memberBreakdownQuery ? query(memberBreakdownQuery, params) : Promise.resolve({ rows: [] }),
    ]);

    const totals = totalsRes.rows[0] || {};
    const totalMemberTokens = Number(totals.total_tokens || 0);

    return {
      member,
      totals: {
        totalTokens: totalMemberTokens,
        tokensIn: Number(totals.tokens_in || 0),
        tokensOut: Number(totals.tokens_out || 0),
        tokensCacheRead: Number(totals.tokens_cache_read || 0),
        tokensCacheWrite: Number(totals.tokens_cache_write || 0),
        totalCost: Number(totals.total_cost || 0),
        sessionCount: Number(totals.session_count || 0),
        activeDays: Number(totals.active_days || 0),
        edits: Number(totals.edits || 0),
        changedLines: Number(totals.changed_lines || 0),
        toolCalls: Number(totals.tool_calls || 0),
        toolErrors: Number(totals.tool_errors || 0),
        reworkLoops: Number(totals.rework_loops || 0),
        runawaySessionsCount: Number(totals.runaway_count || 0),
        avgTokensPerSession: Number(totals.session_count) > 0 ? Math.round(totalMemberTokens / Number(totals.session_count)) : 0,
        avgCostPerSession: Number(totals.session_count) > 0 ? Number(totals.total_cost || 0) / Number(totals.session_count) : 0,
      },
      memberComparisons: memberBreakdownRes.rows.map((mb: any) => ({
        memberId: mb.member_id,
        displayName: mb.display_name,
        sessions: Number(mb.sessions),
        tokensIn: Number(mb.tokens_in),
        tokensOut: Number(mb.tokens_out),
        tokensCacheRead: Number(mb.tokens_cache_read),
        totalTokens: Number(mb.total_tokens),
        apiCost: Number(mb.api_cost),
        edits: Number(mb.edits),
        changedLines: Number(mb.changed_lines),
        toolCalls: Number(mb.tool_calls),
        toolErrors: Number(mb.tool_errors),
        reworkLoops: Number(mb.rework_loops),
        percentage: totalMemberTokens > 0 ? (Number(mb.total_tokens) / totalMemberTokens) * 100 : 0,
      })),
      projects: projectsRes.rows.map((p: any) => ({
        project: p.project,
        sources: p.sources || [],
        models: p.models || [],
        sessions: Number(p.sessions),
        tokensIn: Number(p.tokens_in),
        tokensOut: Number(p.tokens_out),
        tokensCacheRead: Number(p.tokens_cache_read),
        totalTokens: Number(p.total_tokens),
        apiCost: Number(p.api_cost),
        edits: Number(p.edits),
        changedLines: Number(p.changed_lines),
        lastActive: p.last_active,
        percentage: totalMemberTokens > 0 ? (Number(p.total_tokens) / totalMemberTokens) * 100 : 0,
      })),
      tools: toolsRes.rows.map((t: any) => ({
        source: t.source,
        sessions: Number(t.sessions),
        tokensIn: Number(t.tokens_in),
        tokensOut: Number(t.tokens_out),
        tokensCacheRead: Number(t.tokens_cache_read),
        totalTokens: Number(t.total_tokens),
        apiCost: Number(t.api_cost),
        percentage: totalMemberTokens > 0 ? (Number(t.total_tokens) / totalMemberTokens) * 100 : 0,
      })),
      models: modelsRes.rows.map((m: any) => {
        const tin = Number(m.tokens_in);
        const cr = Number(m.tokens_cache_read);
        const denom = tin + cr;
        const cacheHitRate = denom > 0 ? (cr / denom) * 100 : 0;
        return {
          model: m.model,
          source: m.source,
          sessions: Number(m.sessions),
          tokensIn: tin,
          tokensOut: Number(m.tokens_out),
          tokensCacheRead: cr,
          totalTokens: Number(m.total_tokens),
          apiCost: Number(m.api_cost),
          cacheHitRate,
          percentage: totalMemberTokens > 0 ? (Number(m.total_tokens) / totalMemberTokens) * 100 : 0,
        };
      }),
      topSessions: sessionsRes.rows.map((s: any) => ({
        docId: s.doc_id,
        sessionId: s.session_id,
        memberId: s.member_id,
        memberName: s.member_name,
        project: s.project,
        source: s.source,
        model: s.model,
        tokensIn: Number(s.tokens_in),
        tokensOut: Number(s.tokens_out),
        tokensCacheRead: Number(s.tokens_cache_read),
        tokensCacheWrite: Number(s.tokens_cache_write),
        totalTokens: Number(s.total_tokens),
        apiCost: Number(s.api_cost),
        edits: Number(s.edits),
        changedLines: Number(s.changed_lines),
        toolCalls: Number(s.tool_calls),
        toolErrors: Number(s.tool_errors),
        reworkLoops: Number(s.rework_loops),
        isRunaway: Boolean(s.is_runaway),
        startedAt: s.started_at,
        endedAt: s.ended_at,
        syncedAt: s.synced_at,
      })),
      topFiles: filesRes.rows.map((f: any) => ({
        path: f.path,
        edits: Number(f.edits),
        additions: Number(f.additions),
        deletions: Number(f.deletions),
        changedLines: Number(f.changed_lines),
      })),
      dailyTimeline: timelineRes.rows.map((d: any) => ({
        day: d.day,
        sessions: Number(d.sessions),
        tokensIn: Number(d.tokens_in),
        tokensOut: Number(d.tokens_out),
        tokensCacheRead: Number(d.tokens_cache_read),
        totalTokens: Number(d.total_tokens),
        apiCost: Number(d.api_cost),
        edits: Number(d.edits),
      })),
    };
  });
}


