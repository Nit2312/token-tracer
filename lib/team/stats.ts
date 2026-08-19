/**
 * Team statistics queries and member management.
 * Provides deep analytics per member, per project, per agent source, per file,
 * custom model pricing rates, and API cost recalculations.
 */
import crypto from 'node:crypto';
import { query } from './db';
import { generateApiKey, hashApiKey } from './auth';
import { hashPassword } from '@/lib/auth';
import { statsCache } from './cache';

interface StatsOptions {
  from?: string | null;
  to?: string | null;
  memberId?: string | null;
  minTokens?: number | null;
  maxTokens?: number | null;
  source?: string | null;
}

/**
 * Team rollup stats for admin dashboard with per-member, per-project, file-level drilldowns,
 * and custom filter parameters.
 */
// Inline SQL token approximation — matches ingest.ts fallback formula.
// Prevents zero-token charts when sessions were synced without real token counts.
const EFF_IN = `CASE WHEN s.tokens_in = 0 AND (s.tool_calls + s.edits) > 0 THEN GREATEST(500, (s.tool_calls + s.edits) * 350 + s.changed_lines * 10) ELSE s.tokens_in END`;
const EFF_OUT = `CASE WHEN s.tokens_out = 0 AND (s.tool_calls + s.edits) > 0 THEN GREATEST(200, (s.tool_calls + s.edits) * 150 + s.changed_lines * 5) ELSE s.tokens_out END`;

const fmtPctReason = (n: number): string => `${(n * 100).toFixed(0)}%`;

export async function buildTeamStats(
  teamId: string,
  { from = null, to = null, memberId = null, minTokens = null, maxTokens = null, source = null }: StatsOptions = {},
) {
  const isUuid = (val: string | null | undefined): boolean =>
    Boolean(val && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val));

  if (!isUuid(teamId)) {
    return {
      members: [],
      totals: { totalSessions: 0, totalTokens: 0, totalCost: 0, totalEdits: 0, totalLines: 0, totalFiles: 0, totalTools: 0, totalLoops: 0, totalCorrections: 0 },
      leaderboard: [],
      tokenLeaderboard: [],
      scoreboard: [],
      atRisk: [],
      bySource: [],
      byDay: [],
      punch: Array.from({ length: 7 }, () => Array(24).fill(0)),
      activity: { activeDays: 0, streak: 0, peakHour: { weekday: 0, hour: 0, n: 0 }, busiestDay: null },
      topTools: [],
      topFiles: [],
      recentLogs: [],
      memberSources: [],
      memberProjects: [],
      memberFiles: [],
      memberModels: [],
      projectRollup: [],
      modelPricing: [],
    };
  }

  const cacheKey = `team_stats_${teamId}_${from || ''}_${to || ''}_${memberId || ''}_${minTokens || ''}_${maxTokens || ''}_${source || ''}`;
  return statsCache.getOrSet(cacheKey, 60, async () => {
    const params: unknown[] = [teamId];
  let dateFilter = '';

  if (from) {
    params.push(from);
    dateFilter += ` AND COALESCE(s.ended_at, s.started_at, s.synced_at)::date >= $${params.length}::date`;
  }
  if (to) {
    params.push(to);
    dateFilter += ` AND COALESCE(s.ended_at, s.started_at, s.synced_at)::date <= $${params.length}::date`;
  }
  if (memberId && memberId !== 'all') {
    params.push(memberId);
    dateFilter += ` AND s.member_id = $${params.length}`;
  }
  if (source && source !== 'all') {
    params.push(source);
    dateFilter += ` AND s.source = $${params.length}`;
  }
  if (minTokens != null && Number(minTokens) > 0) {
    params.push(Number(minTokens));
    dateFilter += ` AND (s.tokens_in + s.tokens_out) >= $${params.length}`;
  }
  if (maxTokens != null && Number(maxTokens) > 0) {
    params.push(Number(maxTokens));
    dateFilter += ` AND (s.tokens_in + s.tokens_out) <= $${params.length}`;
  }

  // 1. Members list
  const { rows: members } = await query(
    `SELECT m.id, m.display_name, tm.role, m.created_at,
            (SELECT max(created_at) FROM ingest_events e WHERE e.member_id = m.id) AS last_sync_at
     FROM team_members tm
     JOIN members m ON m.id = tm.member_id
     WHERE tm.team_id = $1
     ORDER BY m.display_name`,
    [teamId],
  );

  // 2. Member leaderboard & aggregate token totals
  const { rows: memberStats } = await query(
    `SELECT m.id AS member_id, m.display_name,
            count(s.id)::int AS sessions,
            coalesce(sum(s.edits), 0)::int AS edits,
            coalesce(sum(s.additions), 0)::int AS additions,
            coalesce(sum(s.deletions), 0)::int AS deletions,
            coalesce(sum(s.changed_lines), 0)::int AS changed_lines,
            coalesce(sum(s.files_touched), 0)::int AS files_touched,
            coalesce(sum(s.tool_calls), 0)::int AS tool_calls,
            coalesce(sum(s.tool_errors), 0)::int AS tool_errors,
            coalesce(sum(s.rework_loops), 0)::int AS rework_loops,
            coalesce(sum(s.corrections), 0)::int AS corrections,
            coalesce(sum(CASE WHEN s.abandoned THEN 1 ELSE 0 END), 0)::int AS abandoned,
            coalesce(sum(${EFF_IN}), 0)::bigint AS tokens_in,
            coalesce(sum(${EFF_OUT}), 0)::bigint AS tokens_out,
            coalesce(sum(s.tokens_cache_read), 0)::bigint AS tokens_cache_read,
            coalesce(sum(s.tokens_cache_write), 0)::bigint AS tokens_cache_write,
            coalesce(sum(s.api_cost), 0)::float AS api_cost,
            coalesce(sum(CASE WHEN s.priced THEN 1 ELSE 0 END), 0)::int AS priced_sessions
     FROM team_members tm
     JOIN members m ON m.id = tm.member_id
     LEFT JOIN sync_sessions s ON s.member_id = m.id AND s.team_id = tm.team_id ${dateFilter}
     WHERE tm.team_id = $1 ${memberId && memberId !== 'all' ? `AND m.id = $${params.length + 1}` : ''}
     GROUP BY m.id, m.display_name
     ORDER BY api_cost DESC, edits DESC, sessions DESC`,
    memberId && memberId !== 'all' ? [...params, memberId] : params,
  );

  // 3. Per-member breakdown by agent source
  const { rows: memberSources } = await query(
    `SELECT s.member_id,
            s.source,
            count(s.id)::int AS sessions,
            coalesce(sum(${EFF_IN}), 0)::bigint AS tokens_in,
            coalesce(sum(${EFF_OUT}), 0)::bigint AS tokens_out,
            coalesce(sum(s.tokens_cache_read), 0)::bigint AS tokens_cache_read,
            coalesce(sum(s.api_cost), 0)::float AS api_cost,
            coalesce(sum(s.edits), 0)::int AS edits,
            coalesce(sum(s.changed_lines), 0)::int AS changed_lines
     FROM sync_sessions s
     WHERE s.team_id = $1 ${dateFilter}
     GROUP BY s.member_id, s.source
     ORDER BY api_cost DESC`,
    params,
  );

  // 4. Per-member breakdown by project / workspace (agent)
  const { rows: memberProjects } = await query(
    `SELECT s.member_id,
            COALESCE(s.agent, 'default') AS project,
            s.source,
            count(s.id)::int AS sessions,
            coalesce(sum(${EFF_IN}), 0)::bigint AS tokens_in,
            coalesce(sum(${EFF_OUT}), 0)::bigint AS tokens_out,
            coalesce(sum(s.tokens_cache_read), 0)::bigint AS tokens_cache_read,
            coalesce(sum(s.api_cost), 0)::float AS api_cost,
            coalesce(sum(s.edits), 0)::int AS edits,
            coalesce(sum(s.changed_lines), 0)::int AS changed_lines,
            max(COALESCE(s.ended_at, s.started_at, s.synced_at)) AS last_activity
     FROM sync_sessions s
     WHERE s.team_id = $1 ${dateFilter}
     GROUP BY s.member_id, COALESCE(s.agent, 'default'), s.source
     ORDER BY api_cost DESC, sessions DESC`,
    params,
  );

  // 5. Per-member top files touched
  const { rows: memberFiles } = await query(
    `SELECT s.member_id,
            f.path,
            sum(f.edits)::int AS edits,
            sum(f.additions)::int AS additions,
            sum(f.deletions)::int AS deletions,
            sum(f.additions + f.deletions)::int AS changed_lines
     FROM sync_session_files f
     JOIN sync_sessions s ON s.id = f.sync_session_id
     WHERE s.team_id = $1 ${dateFilter}
     GROUP BY s.member_id, f.path
     ORDER BY changed_lines DESC`,
    params,
  );

  // 5b. Per-member breakdown by LLM model used
  const { rows: memberModels } = await query(
    `SELECT s.member_id,
            m.display_name AS member_name,
            COALESCE(s.model, 'default') AS model,
            s.source,
            count(s.id)::int AS sessions,
            coalesce(sum(s.tokens_in), 0)::bigint AS tokens_in,
            coalesce(sum(s.tokens_out), 0)::bigint AS tokens_out,
            coalesce(sum(s.tokens_cache_read), 0)::bigint AS tokens_cache_read,
            coalesce(sum(s.api_cost), 0)::float AS api_cost
     FROM sync_sessions s
     JOIN members m ON m.id = s.member_id
     WHERE s.team_id = $1 ${dateFilter}
     GROUP BY s.member_id, m.display_name, COALESCE(s.model, 'default'), s.source
     ORDER BY api_cost DESC, sessions DESC`,
    params,
  );

  // 6. Project-level rollup (across the team)
  const { rows: projectRollup } = await query(
    `SELECT COALESCE(s.agent, 'default') AS project,
            count(DISTINCT s.member_id)::int AS member_count,
            count(DISTINCT s.source)::int AS source_count,
            count(s.id)::int AS sessions,
            coalesce(sum(s.tokens_in), 0)::bigint AS tokens_in,
            coalesce(sum(s.tokens_out), 0)::bigint AS tokens_out,
            coalesce(sum(s.tokens_cache_read), 0)::bigint AS tokens_cache_read,
            coalesce(sum(s.api_cost), 0)::float AS api_cost,
            coalesce(sum(s.edits), 0)::int AS edits,
            coalesce(sum(s.changed_lines), 0)::int AS changed_lines,
            max(COALESCE(s.ended_at, s.started_at, s.synced_at)) AS last_activity
     FROM sync_sessions s
     WHERE s.team_id = $1 ${dateFilter}
     GROUP BY COALESCE(s.agent, 'default')
     ORDER BY api_cost DESC, sessions DESC`,
    params,
  );

  // 7. Team-wide source breakdown (Cursor, Claude Code, etc.)
  const { rows: bySource } = await query(
    `SELECT s.source,
            count(*)::int AS sessions,
            count(DISTINCT s.member_id)::int AS member_count,
            coalesce(sum(${EFF_IN}), 0)::bigint AS tokens_in,
            coalesce(sum(${EFF_OUT}), 0)::bigint AS tokens_out,
            coalesce(sum(s.tokens_cache_read), 0)::bigint AS tokens_cache_read,
            coalesce(sum(s.edits), 0)::int AS edits,
            coalesce(sum(s.api_cost), 0)::float AS api_cost
     FROM sync_sessions s
     WHERE s.team_id = $1 ${dateFilter}
     GROUP BY s.source ORDER BY api_cost DESC, edits DESC`,
    params,
  );

  // 8. Daily activity flow
  const { rows: byDay } = await query(
    `SELECT to_char(COALESCE(s.ended_at, s.started_at, s.synced_at)::date, 'YYYY-MM-DD') AS date,
            count(*)::int AS sessions,
            coalesce(sum(${EFF_IN}), 0)::bigint AS tokens_in,
            coalesce(sum(${EFF_OUT}), 0)::bigint AS tokens_out,
            coalesce(sum(s.edits), 0)::int AS edits,
            coalesce(sum(s.api_cost), 0)::float AS api_cost
     FROM sync_sessions s
     WHERE s.team_id = $1 ${dateFilter}
     GROUP BY 1 ORDER BY 1 DESC`,
    params,
  );

  // 8b. Hourly activity punch-card (weekday 0-6, hour 0-23) — same shape/window as dateFilter above
  const { rows: punchRows } = await query(
    `SELECT
       EXTRACT(DOW FROM COALESCE(s.ended_at, s.started_at, s.synced_at))::int AS weekday,
       EXTRACT(HOUR FROM COALESCE(s.ended_at, s.started_at, s.synced_at))::int AS hour,
       count(*)::int AS n
     FROM sync_sessions s
     WHERE s.team_id = $1 ${dateFilter}
     GROUP BY 1, 2`,
    params,
  );
  const punch: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const r of punchRows) {
    const w = Number(r.weekday);
    const h = Number(r.hour);
    if (w >= 0 && w < 7 && h >= 0 && h < 24) punch[w][h] += Number(r.n);
  }
  let peakHour = { weekday: 0, hour: 0, n: 0 };
  for (let w = 0; w < 7; w++) for (let h = 0; h < 24; h++) if (punch[w][h] > peakHour.n) peakHour = { weekday: w, hour: h, n: punch[w][h] };

  // Activity streak & active-day count, derived from byDay (a day only appears there if it had sessions).
  const activeDayKeys = byDay.map((d) => String(d.date)).sort();
  let streak = 0;
  if (activeDayKeys.length) {
    let cursor = new Date(`${activeDayKeys[activeDayKeys.length - 1]}T00:00:00Z`);
    const daySet = new Set(activeDayKeys);
    while (daySet.has(cursor.toISOString().slice(0, 10))) {
      streak++;
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
  }
  const busiestDay = byDay.reduce(
    (m: any, d: any) => (Number(d.tokens_in) + Number(d.tokens_out) > (m ? Number(m.tokens_in) + Number(m.tokens_out) : -1) ? d : m),
    null,
  );
  const activity = {
    activeDays: byDay.length,
    streak,
    peakHour,
    busiestDay: busiestDay ? { date: busiestDay.date, sessions: busiestDay.sessions, tokensIn: Number(busiestDay.tokens_in), tokensOut: Number(busiestDay.tokens_out) } : null,
  };

  // 9. Top tools used team-wide
  const { rows: topTools } = await query(
    `SELECT t.tool_name AS name, sum(t.call_count)::int AS count
     FROM sync_session_tools t
     JOIN sync_sessions s ON s.id = t.sync_session_id
     WHERE s.team_id = $1 ${dateFilter}
     GROUP BY t.tool_name ORDER BY count DESC LIMIT 20`,
    params,
  );

  // 10. Top files team-wide
  const { rows: topFiles } = await query(
    `SELECT f.path,
            sum(f.edits)::int AS edits,
            sum(f.additions)::int AS additions,
            sum(f.deletions)::int AS deletions,
            sum(f.additions + f.deletions)::int AS changed_lines,
            count(DISTINCT s.member_id)::int AS member_count
     FROM sync_session_files f
     JOIN sync_sessions s ON s.id = f.sync_session_id
     WHERE s.team_id = $1 ${dateFilter}
     GROUP BY f.path ORDER BY changed_lines DESC LIMIT 40`,
    params,
  );

  // 11. Recent session log
  const { rows: recentLogs } = await query(
    `SELECT s.id,
            s.source,
            COALESCE(s.agent, 'default') AS project,
            s.model,
            s.member_id,
            m.display_name AS member_name,
            s.tokens_in,
            s.tokens_out,
            s.tokens_cache_read,
            s.api_cost,
            s.edits,
            s.additions,
            s.deletions,
            s.changed_lines,
            s.tool_calls,
            s.tool_errors,
            COALESCE(s.ended_at, s.started_at, s.synced_at) AS timestamp
     FROM sync_sessions s
     JOIN members m ON m.id = s.member_id
     WHERE s.team_id = $1 ${dateFilter}
     ORDER BY timestamp DESC
     LIMIT 50`,
    params,
  );

  // 12. Model Pricing Rates Table (team overrides first, then global overrides)
  const { rows: modelPricing } = await query(
    `SELECT id, team_id, model_pattern, cost_in_per_m, cost_out_per_m, cost_cache_read_per_m, created_at
     FROM model_pricing WHERE team_id = $1 OR team_id IS NULL ORDER BY (team_id IS NOT NULL) DESC, model_pattern`,
    [teamId],
  );

  const totalTeamTokens = memberStats.reduce(
    (acc, r) => acc + Number(r.tokens_in) + Number(r.tokens_out),
    0,
  );

  // Token Leaderboard
  const tokenLeaderboard = memberStats
    .map((m) => {
      const totalTokens = Number(m.tokens_in) + Number(m.tokens_out);
      const sharePct = totalTeamTokens > 0 ? (totalTokens / totalTeamTokens) * 100 : 0;
      return {
        member_id: m.member_id,
        display_name: m.display_name,
        sessions: m.sessions,
        tokens_in: Number(m.tokens_in),
        tokens_out: Number(m.tokens_out),
        tokens_cache_read: Number(m.tokens_cache_read),
        total_tokens: totalTokens,
        share_pct: sharePct,
        api_cost: m.api_cost,
        edits: m.edits,
      };
    })
    .sort((a, b) => b.total_tokens - a.total_tokens);

  // Head to head scoreboard
  const scoreboard = memberStats.map((m) => {
    const s = Math.max(1, m.sessions);
    const edits = Math.max(1, m.edits);
    const toolCalls = Math.max(1, m.tool_calls);
    const tokensIn = Math.max(1, Number(m.tokens_in));
    const changedLines = Math.max(0.01, m.changed_lines / 100);

    return {
      member_id: m.member_id,
      display_name: m.display_name,
      sessions: m.sessions,
      editsPerSession: m.edits / s,
      outputTokensPerEdit: (Number(m.tokens_in) + Number(m.tokens_out)) / edits,
      toolErrorRate: m.tool_errors / toolCalls,
      correctionRate: m.corrections / s,
      abandonedRate: m.abandoned / s,
      cacheEfficiency: Number(m.tokens_cache_read) / tokensIn,
      costPerEdit: m.api_cost / edits,
      costPer100Lines: m.api_cost / changedLines,
    };
  });

  // At-risk callouts: members whose error/correction/abandonment rate runs well above the
  // team average, flagged so an admin doesn't have to eyeball the raw scoreboard table.
  // Members with too few sessions are excluded — a single bad session isn't a signal.
  const MIN_SESSIONS_FOR_RISK = 3;
  const RISK_THRESHOLD_MULTIPLIER = 1.5;
  const riskEligible = scoreboard.filter((s) => s.sessions >= MIN_SESSIONS_FOR_RISK);
  const avg = (key: 'toolErrorRate' | 'correctionRate' | 'abandonedRate') =>
    riskEligible.length ? riskEligible.reduce((sum, s) => sum + s[key], 0) / riskEligible.length : 0;
  const avgToolErrorRate = avg('toolErrorRate');
  const avgCorrectionRate = avg('correctionRate');
  const avgAbandonedRate = avg('abandonedRate');
  const atRisk = riskEligible
    .map((s) => {
      const reasons: string[] = [];
      if (avgToolErrorRate > 0 && s.toolErrorRate > avgToolErrorRate * RISK_THRESHOLD_MULTIPLIER) {
        reasons.push(`tool error rate ${fmtPctReason(s.toolErrorRate)} (team avg ${fmtPctReason(avgToolErrorRate)})`);
      }
      if (avgCorrectionRate > 0 && s.correctionRate > avgCorrectionRate * RISK_THRESHOLD_MULTIPLIER) {
        reasons.push(`${s.correctionRate.toFixed(1)} corrections/session (team avg ${avgCorrectionRate.toFixed(1)})`);
      }
      if (avgAbandonedRate > 0 && s.abandonedRate > avgAbandonedRate * RISK_THRESHOLD_MULTIPLIER) {
        reasons.push(`abandoned-session rate ${fmtPctReason(s.abandonedRate)} (team avg ${fmtPctReason(avgAbandonedRate)})`);
      }
      return { member_id: s.member_id, display_name: s.display_name, sessions: s.sessions, reasons };
    })
    .filter((r) => r.reasons.length > 0);

  const memberMap = new Map<string, Record<string, unknown>>();
  for (const m of memberStats) {
    memberMap.set(m.member_id, {
      ...m,
      tokens_in: Number(m.tokens_in || 0),
      tokens_out: Number(m.tokens_out || 0),
      tokens_cache_read: Number(m.tokens_cache_read || 0),
      tokens_cache_write: Number(m.tokens_cache_write || 0),
      sources: memberSources
        .filter((s) => s.member_id === m.member_id)
        .map((s) => ({
          ...s,
          tokens_in: Number(s.tokens_in || 0),
          tokens_out: Number(s.tokens_out || 0),
          tokens_cache_read: Number(s.tokens_cache_read || 0),
        })),
      projects: memberProjects
        .filter((p) => p.member_id === m.member_id)
        .map((p) => ({
          ...p,
          tokens_in: Number(p.tokens_in || 0),
          tokens_out: Number(p.tokens_out || 0),
          tokens_cache_read: Number(p.tokens_cache_read || 0),
        })),
      models: memberModels
        .filter((mod) => mod.member_id === m.member_id)
        .map((mod) => ({
          ...mod,
          tokens_in: Number(mod.tokens_in || 0),
          tokens_out: Number(mod.tokens_out || 0),
          tokens_cache_read: Number(mod.tokens_cache_read || 0),
        })),
      topFiles: memberFiles.filter((f) => f.member_id === m.member_id).slice(0, 10),
    });
  }

  const projects = projectRollup.map((p) => {
    const projProjects = memberProjects.filter((mp) => mp.project === p.project);
    return {
      ...p,
      tokens_in: Number(p.tokens_in || 0),
      tokens_out: Number(p.tokens_out || 0),
      tokens_cache_read: Number(p.tokens_cache_read || 0),
      members: projProjects.map((mp) => {
        const mem = members.find((m) => m.id === mp.member_id);
        return {
          member_id: mp.member_id,
          display_name: mem?.display_name || 'Unknown',
          source: mp.source,
          sessions: mp.sessions,
          tokens_in: Number(mp.tokens_in || 0),
          tokens_out: Number(mp.tokens_out || 0),
          api_cost: mp.api_cost,
          edits: mp.edits,
        };
      }),
    };
  });

  const totals = memberStats.reduce(
    (acc, r) => ({
      sessions: acc.sessions + r.sessions,
      edits: acc.edits + r.edits,
      additions: acc.additions + r.additions,
      deletions: acc.deletions + r.deletions,
      changedLines: acc.changedLines + Number(r.changed_lines),
      filesTouched: acc.filesTouched + r.files_touched,
      toolCalls: acc.toolCalls + r.tool_calls,
      toolErrors: acc.toolErrors + r.tool_errors,
      reworkLoops: acc.reworkLoops + r.rework_loops,
      corrections: acc.corrections + r.corrections,
      abandoned: acc.abandoned + r.abandoned,
      tokensIn: acc.tokensIn + Number(r.tokens_in),
      tokensOut: acc.tokensOut + Number(r.tokens_out),
      tokensCacheRead: acc.tokensCacheRead + Number(r.tokens_cache_read),
      apiCost: acc.apiCost + Number(r.api_cost),
    }),
    {
      sessions: 0,
      edits: 0,
      additions: 0,
      deletions: 0,
      changedLines: 0,
      filesTouched: 0,
      toolCalls: 0,
      toolErrors: 0,
      reworkLoops: 0,
      corrections: 0,
      abandoned: 0,
      tokensIn: 0,
      tokensOut: 0,
      tokensCacheRead: 0,
      apiCost: 0,
    },
  );

  return {
    window: { from: from ?? null, to: to ?? null, memberId: memberId ?? null, minTokens: minTokens ?? null, maxTokens: maxTokens ?? null, source: source ?? null },
    members,
    leaderboard: Array.from(memberMap.values()),
    tokenLeaderboard,
    scoreboard,
    atRisk,
    projects,
    bySource: bySource.map((s) => ({
      ...s,
      tokens_in: Number(s.tokens_in || 0),
      tokens_out: Number(s.tokens_out || 0),
      tokens_cache_read: Number(s.tokens_cache_read || 0),
    })),
    byDay: byDay.map((d) => ({
      ...d,
      tokens_in: Number(d.tokens_in || 0),
      tokens_out: Number(d.tokens_out || 0),
    })),
    punch,
    activity,
    topTools,
    topFiles,
    recentLogs,
    modelPricing,
    memberModels,
    totals,
  };
  });
}

/** Create a member + API key for an existing team and record in team_members. */
export async function createMemberWithKey(teamId: string, displayName: string, role = 'member') {
  return createTeamUserWithMember({ teamId, displayName, role });
}

export interface CreateTeamUserOptions {
  teamId: string;
  displayName: string;
  username?: string | null;
  password?: string | null;
  role?: string;
}

/**
 * Creates a team user account and member record:
 * - Generates clean unique username if not provided
 * - Generates secure temporary password if not provided
 * - Links member to BOTH the admin's team and the Independent team by default
 * - Generates active API key for the member
 * - Creates user account in `users` table linked to member and admin team
 */
export async function createTeamUserWithMember({
  teamId,
  displayName,
  username: providedUsername,
  password: providedPassword,
  role = 'member',
}: CreateTeamUserOptions) {
  // 1. Fetch admin team details
  const { rows: teamRows } = await query<{ id: string; name: string }>('SELECT id, name FROM teams WHERE id = $1', [teamId]);
  const adminTeamName = teamRows[0]?.name || 'Team';

  // 2. Fetch or create Independent team
  let independentTeamId: string;
  const { rows: indepRows } = await query<{ id: string }>('SELECT id FROM teams WHERE name = $1 LIMIT 1', ['Independent']);
  if (indepRows[0]?.id) {
    independentTeamId = indepRows[0].id;
  } else {
    const { rows: newIndep } = await query<{ id: string }>("INSERT INTO teams (name) VALUES ('Independent') RETURNING id");
    independentTeamId = newIndep[0].id;
  }

  // 3. Resolve username
  let cleanUsername = String(providedUsername || '').trim().toLowerCase();
  const reservedUsernames = ['team', 'superadmin', 'admin', 'root', 'api', 'system', 'dashboard'];
  if (!cleanUsername) {
    // Generate clean username from display name
    const base = displayName.toLowerCase().replace(/[^a-z0-9]/g, '.').replace(/\.+/g, '.').replace(/^\.|\.$/g, '') || 'user';
    let candidate = base;
    let counter = 1;
    while (true) {
      if (!reservedUsernames.includes(candidate)) {
        const { rows: existing } = await query('SELECT id FROM users WHERE LOWER(username) = $1', [candidate]);
        if (existing.length === 0) {
          cleanUsername = candidate;
          break;
        }
      }
      candidate = `${base}${counter}`;
      counter++;
    }
  } else {
    if (cleanUsername.length < 2) {
      throw new Error('Username must be at least 2 characters long');
    }
    if (!/^[a-z0-9_.-]+$/.test(cleanUsername)) {
      throw new Error('Username can only contain letters, numbers, dots, hyphens, and underscores');
    }
    if (reservedUsernames.includes(cleanUsername)) {
      throw new Error('This username is reserved. Please choose another username.');
    }
    const { rows: existing } = await query('SELECT id FROM users WHERE LOWER(username) = $1', [cleanUsername]);
    if (existing.length > 0) {
      throw new Error(`Username "${cleanUsername}" is already taken.`);
    }
  }

  // 4. Resolve temporary password
  const tempPassword = providedPassword?.trim() || `Tracer-${crypto.randomBytes(3).toString('hex')}`;
  const passwordHash = await hashPassword(tempPassword);

  // 5. Create member in members table
  const { rows: memberRows } = await query(
    'INSERT INTO members (team_id, display_name, role) VALUES ($1, $2, $3) RETURNING id, display_name, role',
    [teamId, displayName, role],
  );
  const member = memberRows[0];

  // 6. Associate member in team_members for BOTH the admin's team and Independent team
  await query(
    'INSERT INTO team_members (team_id, member_id, role) VALUES ($1, $2, $3) ON CONFLICT (team_id, member_id) DO NOTHING',
    [teamId, member.id, role],
  );
  if (independentTeamId && independentTeamId !== teamId) {
    await query(
      'INSERT INTO team_members (team_id, member_id, role) VALUES ($1, $2, $3) ON CONFLICT (team_id, member_id) DO NOTHING',
      [independentTeamId, member.id, 'member'],
    );
  }

  // 7. Generate API key
  const apiKey = generateApiKey();
  await query(
    'INSERT INTO member_keys (member_id, key_hash, label) VALUES ($1, $2, $3)',
    [member.id, hashApiKey(apiKey), 'default'],
  );

  // 8. Create user account in users table
  const userRole = role === 'admin' ? 'admin' : 'user';
  const { rows: userRows } = await query(
    `INSERT INTO users (username, password_hash, display_name, member_id, team_id, role, api_key, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true)
     RETURNING id, username, display_name, role, member_id, team_id, active, created_at`,
    [cleanUsername, passwordHash, displayName, member.id, teamId, userRole, apiKey],
  );
  const user = userRows[0];

  const assignedTeams = [adminTeamName];
  if (adminTeamName !== 'Independent') {
    assignedTeams.push('Independent');
  }

  return {
    member,
    user,
    tempPassword,
    apiKey,
    teams: assignedTeams,
  };
}

/** Update a team member's display name and role in a team. */
export async function updateMember(memberId: string, teamId: string, displayName: string, role = 'member') {
  const { rows } = await query(
    'UPDATE members SET display_name = $1 WHERE id = $2 RETURNING id, display_name',
    [displayName, memberId],
  );
  if (teamId) {
    await query(
      'UPDATE team_members SET role = $1 WHERE member_id = $2 AND team_id = $3',
      [role, memberId, teamId],
    );
  }
  return rows[0] ? { ...rows[0], role } : null;
}

/** Unlink a member from a specific team. */
export async function deleteMember(memberId: string, teamId: string) {
  const { rowCount } = await query(
    'DELETE FROM team_members WHERE member_id = $1 AND team_id = $2',
    [memberId, teamId],
  );
  return { ok: true, deleted: (rowCount || 0) > 0 };
}

export function matchesModelPattern(modelName: string, pattern: string): boolean {
  const normModel = (modelName || '').toLowerCase().trim();
  const normPattern = (pattern || '').toLowerCase().trim();
  if ((!normModel || normModel === 'default') && (!normPattern || normPattern === 'default')) return true;
  if (!normPattern || !normModel) return false;
  const subPatterns = normPattern.split(/[/,|,]/).map((p) => p.trim()).filter(Boolean);
  return subPatterns.some((p) => {
    if (!p) return false;
    if (normModel.includes(p)) return true;
    const cleanP = p.replace(/[-_.\s]/g, '');
    const cleanModel = normModel.replace(/[-_.\s]/g, '');
    return cleanModel.includes(cleanP);
  });
}

/**
 * Recalculate API costs across all synced sessions for members of a team using the latest model pricing rules.
 */
export async function recalculateTeamCosts(teamId: string, forceAll: boolean = false) {
  const { rows: customRules } = await query(
    'SELECT model_pattern, cost_in_per_m, cost_out_per_m, cost_cache_read_per_m FROM model_pricing WHERE team_id = $1 OR team_id IS NULL ORDER BY (team_id IS NOT NULL) DESC',
    [teamId],
  );

  const defaultRules = [
    { model_pattern: 'claude-3-7-sonnet', cost_in_per_m: 3.0, cost_out_per_m: 15.0, cost_cache_read_per_m: 0.3 },
    { model_pattern: 'claude-3-5-sonnet', cost_in_per_m: 3.0, cost_out_per_m: 15.0, cost_cache_read_per_m: 0.3 },
    { model_pattern: 'claude-3-5-haiku', cost_in_per_m: 0.8, cost_out_per_m: 4.0, cost_cache_read_per_m: 0.08 },
    { model_pattern: 'gpt-4o', cost_in_per_m: 2.5, cost_out_per_m: 10.0, cost_cache_read_per_m: 1.25 },
    { model_pattern: 'o1', cost_in_per_m: 15.0, cost_out_per_m: 60.0, cost_cache_read_per_m: 7.5 },
    { model_pattern: 'o3-mini', cost_in_per_m: 1.1, cost_out_per_m: 4.4, cost_cache_read_per_m: 0.55 },
    { model_pattern: 'deepseek-r1', cost_in_per_m: 0.55, cost_out_per_m: 2.19, cost_cache_read_per_m: 0.14 },
    { model_pattern: 'deepseek-v3', cost_in_per_m: 0.14, cost_out_per_m: 0.28, cost_cache_read_per_m: 0.014 },
    { model_pattern: '', cost_in_per_m: 3.0, cost_out_per_m: 15.0, cost_cache_read_per_m: 0.3 },
  ];

  const allRules = [...customRules, ...defaultRules];

  const { rows: sessions } = await query(
    forceAll
      ? 'SELECT id, model, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, edits, tool_calls, changed_lines FROM sync_sessions WHERE team_id = $1'
      : 'SELECT id, model, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, edits, tool_calls, changed_lines FROM sync_sessions WHERE team_id = $1 AND priced = false',
    [teamId],
  );

  let updatedCount = 0;
  for (const s of sessions) {
    const modelName = (s.model || '').toLowerCase();
    const rule = allRules.find((r) => r.model_pattern && matchesModelPattern(modelName, r.model_pattern)) || defaultRules[defaultRules.length - 1];

    let tokensIn = Number(s.tokens_in || 0);
    let tokensOut = Number(s.tokens_out || 0);
    const tokensCacheRead = Number(s.tokens_cache_read || 0);
    const tokensCacheWrite = Number(s.tokens_cache_write || 0);

    const edits = Number(s.edits || 0);
    const toolCalls = Number(s.tool_calls || 0);
    const changedLines = Number(s.changed_lines || 0);

    if (tokensIn === 0 && tokensOut === 0 && (edits > 0 || toolCalls > 0 || changedLines > 0)) {
      tokensIn = Math.max(500, (toolCalls + edits) * 350 + changedLines * 10);
      tokensOut = Math.max(200, (toolCalls + edits) * 150 + changedLines * 5);
      await query('UPDATE sync_sessions SET tokens_in = $1, tokens_out = $2 WHERE id = $3', [tokensIn, tokensOut, s.id]);
    }

    const freshInput = Math.max(0, tokensIn - tokensCacheRead - tokensCacheWrite);

    const cost =
      (freshInput / 1_000_000) * Number(rule.cost_in_per_m || 0) +
      (tokensOut / 1_000_000) * Number(rule.cost_out_per_m || 0) +
      (tokensCacheRead / 1_000_000) * Number(rule.cost_cache_read_per_m || 0) +
      (tokensCacheWrite / 1_000_000) * Number(((rule as any).cost_cache_write_per_m ?? rule.cost_in_per_m) || 0);

    await query('UPDATE sync_sessions SET api_cost = $1, priced = true WHERE id = $2', [cost, s.id]);
    updatedCount++;
  }

  return { updatedCount, totalSessions: sessions.length };
}

/**
 * Recalculate API costs across all synced sessions for all teams and members using global and team model pricing rules.
 */
export async function recalculateAllCosts(forceAll: boolean = true) {
  const { rows: customRules } = await query(
    'SELECT team_id, model_pattern, cost_in_per_m, cost_out_per_m, cost_cache_read_per_m FROM model_pricing',
  );

  const defaultRules = [
    { model_pattern: 'claude-3-7-sonnet', cost_in_per_m: 3.0, cost_out_per_m: 15.0, cost_cache_read_per_m: 0.3 },
    { model_pattern: 'claude-3-5-sonnet', cost_in_per_m: 3.0, cost_out_per_m: 15.0, cost_cache_read_per_m: 0.3 },
    { model_pattern: 'claude-3-5-haiku', cost_in_per_m: 0.8, cost_out_per_m: 4.0, cost_cache_read_per_m: 0.08 },
    { model_pattern: 'gpt-4o', cost_in_per_m: 2.5, cost_out_per_m: 10.0, cost_cache_read_per_m: 1.25 },
    { model_pattern: 'o1', cost_in_per_m: 15.0, cost_out_per_m: 60.0, cost_cache_read_per_m: 7.5 },
    { model_pattern: 'o3-mini', cost_in_per_m: 1.1, cost_out_per_m: 4.4, cost_cache_read_per_m: 0.55 },
    { model_pattern: 'deepseek-r1', cost_in_per_m: 0.55, cost_out_per_m: 2.19, cost_cache_read_per_m: 0.14 },
    { model_pattern: 'deepseek-v3', cost_in_per_m: 0.14, cost_out_per_m: 0.28, cost_cache_read_per_m: 0.014 },
    { model_pattern: '', cost_in_per_m: 3.0, cost_out_per_m: 15.0, cost_cache_read_per_m: 0.3 },
  ];

  const globalCustomRules = customRules.filter((r) => !r.team_id);
  const teamCustomRules = customRules.filter((r) => Boolean(r.team_id));

  const { rows: sessions } = await query(
    forceAll
      ? `SELECT s.id, s.team_id, s.member_id, s.model, s.tokens_in, s.tokens_out, s.tokens_cache_read, s.tokens_cache_write, s.edits, s.tool_calls, s.changed_lines
         FROM sync_sessions s`
      : `SELECT s.id, s.team_id, s.member_id, s.model, s.tokens_in, s.tokens_out, s.tokens_cache_read, s.tokens_cache_write, s.edits, s.tool_calls, s.changed_lines
         FROM sync_sessions s WHERE s.priced = false`
  );

  let updatedCount = 0;
  for (const s of sessions) {
    const modelName = (s.model || '').toLowerCase();
    const teamRules = s.team_id ? teamCustomRules.filter((r) => r.team_id === s.team_id) : [];
    
    // Check team overrides -> global overrides -> default system rates
    const rule =
      teamRules.find((r) => r.model_pattern && matchesModelPattern(modelName, r.model_pattern)) ||
      globalCustomRules.find((r) => r.model_pattern && matchesModelPattern(modelName, r.model_pattern)) ||
      defaultRules.find((r) => r.model_pattern && matchesModelPattern(modelName, r.model_pattern)) ||
      defaultRules[defaultRules.length - 1];

    let tokensIn = Number(s.tokens_in || 0);
    let tokensOut = Number(s.tokens_out || 0);
    const tokensCacheRead = Number(s.tokens_cache_read || 0);
    const tokensCacheWrite = Number(s.tokens_cache_write || 0);

    const edits = Number(s.edits || 0);
    const toolCalls = Number(s.tool_calls || 0);
    const changedLines = Number(s.changed_lines || 0);

    if (tokensIn === 0 && tokensOut === 0 && (edits > 0 || toolCalls > 0 || changedLines > 0)) {
      tokensIn = Math.max(500, (toolCalls + edits) * 350 + changedLines * 10);
      tokensOut = Math.max(200, (toolCalls + edits) * 150 + changedLines * 5);
      await query('UPDATE sync_sessions SET tokens_in = $1, tokens_out = $2 WHERE id = $3', [tokensIn, tokensOut, s.id]);
    }

    const freshInput = Math.max(0, tokensIn - tokensCacheRead - tokensCacheWrite);

    const cost =
      (freshInput / 1_000_000) * Number(rule.cost_in_per_m || 0) +
      (tokensOut / 1_000_000) * Number(rule.cost_out_per_m || 0) +
      (tokensCacheRead / 1_000_000) * Number(rule.cost_cache_read_per_m || 0) +
      (tokensCacheWrite / 1_000_000) * Number(((rule as any).cost_cache_write_per_m ?? rule.cost_in_per_m) || 0);

    await query('UPDATE sync_sessions SET api_cost = $1, priced = true WHERE id = $2', [cost, s.id]);
    updatedCount++;
  }

  return { updatedCount, totalSessions: sessions.length };
}

