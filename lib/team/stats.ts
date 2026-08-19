/**
 * Team statistics queries and member management.
 * Provides deep analytics per member, per project, per agent source, per file,
 * custom model pricing rates, and API cost recalculations.
 * All aggregation is done in JavaScript over Firestore reads (no SQL).
 */
import crypto from 'node:crypto';
import {
  queryCol, setDocById, addDocToCol, batchWrite, getDocById, newUuid,
} from './db';
import { generateApiKey, hashApiKey } from './auth';
import { hashPassword } from '@/lib/auth';

interface StatsOptions {
  from?: string | null;
  to?: string | null;
  memberId?: string | null;
  minTokens?: number | null;
  maxTokens?: number | null;
  source?: string | null;
}

// ── Helper: effective token counts (matches ingest.ts approximation) ──────────

function effIn(s: any): number {
  const ti = Number(s.tokens_in || 0);
  const tc = Number(s.tool_calls || 0);
  const ed = Number(s.edits || 0);
  const cl = Number(s.changed_lines || 0);
  if (ti === 0 && (tc + ed) > 0) return Math.max(500, (tc + ed) * 350 + cl * 10);
  return ti;
}

function effOut(s: any): number {
  const to = Number(s.tokens_out || 0);
  const tc = Number(s.tool_calls || 0);
  const ed = Number(s.edits || 0);
  const cl = Number(s.changed_lines || 0);
  if (to === 0 && (tc + ed) > 0) return Math.max(200, (tc + ed) * 150 + cl * 5);
  return to;
}

// ── Date filter helper ────────────────────────────────────────────────────────

function passesDateFilter(
  s: any,
  from: string | null,
  to: string | null,
  memberId: string | null,
  source: string | null,
  minTokens: number | null,
  maxTokens: number | null,
): boolean {
  const ts = s.ended_at || s.started_at || s.synced_at || null;
  const dateStr = ts ? String(ts).slice(0, 10) : null;
  if (from && dateStr && dateStr < String(from).slice(0, 10)) return false;
  if (to && dateStr && dateStr > String(to).slice(0, 10)) return false;
  if (memberId && memberId !== 'all' && s.member_id !== memberId) return false;
  if (source && source !== 'all' && s.source !== source) return false;
  const totalTokens = Number(s.tokens_in || 0) + Number(s.tokens_out || 0);
  if (minTokens != null && Number(minTokens) > 0 && totalTokens < Number(minTokens)) return false;
  if (maxTokens != null && Number(maxTokens) > 0 && totalTokens > Number(maxTokens)) return false;
  return true;
}

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

  // 1. Members list (via team_members junction)
  const teamMemberDocs = await queryCol<{ member_id: string; role: string; created_at: string }>(
    'team_members',
    [{ type: 'where', field: 'team_id', op: '==', value: teamId }],
  );

  const memberIds = teamMemberDocs.map((tm) => tm.member_id);

  // Fetch all member docs in parallel (Firestore doesn't support IN queries > 30 items, chunk if needed)
  const memberDocs = await fetchDocsByIds('members', memberIds);
  const memberById = new Map(memberDocs.map((m) => [m.id, m]));

  // Fetch last ingest event per member
  const ingestDocs = await queryCol<{ member_id: string; created_at: string }>(
    'ingest_events',
    [{ type: 'where', field: 'team_id', op: '==', value: teamId }],
  );
  const lastIngestByMember = new Map<string, string>();
  for (const ie of ingestDocs) {
    const prev = lastIngestByMember.get(ie.member_id);
    if (!prev || ie.created_at > prev) lastIngestByMember.set(ie.member_id, ie.created_at);
  }

  const members = teamMemberDocs
    .map((tm) => {
      const m = memberById.get(tm.member_id);
      if (!m) return null;
      return {
        id: m.id,
        display_name: m.display_name,
        role: tm.role,
        created_at: m.created_at,
        last_sync_at: lastIngestByMember.get(m.id) || null,
      };
    })
    .filter(Boolean)
    .sort((a: any, b: any) => String(a.display_name).localeCompare(String(b.display_name)));

  // 2. Fetch all sessions for this team
  const allSessions = await queryCol<any>('sync_sessions', [
    { type: 'where', field: 'team_id', op: '==', value: teamId },
  ]);

  // Apply date/filter
  const sessions = allSessions.filter((s) =>
    passesDateFilter(s, from, to, memberId, source, minTokens, maxTokens),
  );

  // 3. Aggregate per-member stats
  const memberStatsMap = new Map<string, any>();
  for (const s of sessions) {
    const mid = String(s.member_id);
    if (!memberStatsMap.has(mid)) {
      const m = memberById.get(mid);
      memberStatsMap.set(mid, {
        member_id: mid,
        display_name: m?.display_name || 'Unknown',
        sessions: 0, edits: 0, additions: 0, deletions: 0,
        changed_lines: 0, files_touched: 0, tool_calls: 0, tool_errors: 0,
        rework_loops: 0, corrections: 0, abandoned: 0,
        tokens_in: 0, tokens_out: 0, tokens_cache_read: 0, tokens_cache_write: 0,
        api_cost: 0, priced_sessions: 0,
      });
    }
    const ms = memberStatsMap.get(mid);
    ms.sessions++;
    ms.edits += Number(s.edits || 0);
    ms.additions += Number(s.additions || 0);
    ms.deletions += Number(s.deletions || 0);
    ms.changed_lines += Number(s.changed_lines || 0);
    ms.files_touched += Number(s.files_touched || 0);
    ms.tool_calls += Number(s.tool_calls || 0);
    ms.tool_errors += Number(s.tool_errors || 0);
    ms.rework_loops += Number(s.rework_loops || 0);
    ms.corrections += Number(s.corrections || 0);
    ms.abandoned += s.abandoned ? 1 : 0;
    ms.tokens_in += effIn(s);
    ms.tokens_out += effOut(s);
    ms.tokens_cache_read += Number(s.tokens_cache_read || 0);
    ms.tokens_cache_write += Number(s.tokens_cache_write || 0);
    ms.api_cost += Number(s.api_cost || 0);
    if (s.priced) ms.priced_sessions++;
  }
  const memberStats = Array.from(memberStatsMap.values())
    .sort((a, b) => b.api_cost - a.api_cost || b.edits - a.edits || b.sessions - a.sessions);

  // 4. Per-member breakdown by source
  const memberSourcesMap = new Map<string, any>();
  for (const s of sessions) {
    const key = `${s.member_id}::${s.source}`;
    if (!memberSourcesMap.has(key)) {
      memberSourcesMap.set(key, {
        member_id: s.member_id, source: s.source,
        sessions: 0, tokens_in: 0, tokens_out: 0, tokens_cache_read: 0, api_cost: 0, edits: 0, changed_lines: 0,
      });
    }
    const ms = memberSourcesMap.get(key);
    ms.sessions++;
    ms.tokens_in += effIn(s);
    ms.tokens_out += effOut(s);
    ms.tokens_cache_read += Number(s.tokens_cache_read || 0);
    ms.api_cost += Number(s.api_cost || 0);
    ms.edits += Number(s.edits || 0);
    ms.changed_lines += Number(s.changed_lines || 0);
  }
  const memberSources = Array.from(memberSourcesMap.values())
    .sort((a, b) => b.api_cost - a.api_cost);

  // 5. Per-member by project
  const memberProjectsMap = new Map<string, any>();
  for (const s of sessions) {
    const project = s.agent || 'default';
    const key = `${s.member_id}::${project}::${s.source}`;
    if (!memberProjectsMap.has(key)) {
      memberProjectsMap.set(key, {
        member_id: s.member_id, project, source: s.source,
        sessions: 0, tokens_in: 0, tokens_out: 0, tokens_cache_read: 0,
        api_cost: 0, edits: 0, changed_lines: 0, last_activity: null,
      });
    }
    const mp = memberProjectsMap.get(key);
    mp.sessions++;
    mp.tokens_in += effIn(s);
    mp.tokens_out += effOut(s);
    mp.tokens_cache_read += Number(s.tokens_cache_read || 0);
    mp.api_cost += Number(s.api_cost || 0);
    mp.edits += Number(s.edits || 0);
    mp.changed_lines += Number(s.changed_lines || 0);
    const ts = s.ended_at || s.started_at || s.synced_at || null;
    if (!mp.last_activity || (ts && ts > mp.last_activity)) mp.last_activity = ts;
  }
  const memberProjects = Array.from(memberProjectsMap.values())
    .sort((a, b) => b.api_cost - a.api_cost || b.sessions - a.sessions);

  // 6. Per-member top files
  const sessionIds = sessions.map((s) => s.id).filter(Boolean);
  let allFiles: any[] = [];
  if (sessionIds.length) {
    // Chunk Firestore IN queries to 30
    for (const chunk of chunkArray(sessionIds, 30)) {
      const files = await queryCol('sync_session_files', [
        { type: 'where', field: 'sync_session_id', op: 'in', value: chunk },
      ]);
      allFiles.push(...files);
    }
  }

  // Map sync_session_id → member_id for file attribution
  const sessionToMember = new Map(sessions.map((s) => [s.id, s.member_id]));

  const memberFilesMap = new Map<string, any>();
  for (const f of allFiles) {
    const mid = sessionToMember.get(f.sync_session_id);
    if (!mid) continue;
    const key = `${mid}::${f.path}`;
    if (!memberFilesMap.has(key)) {
      memberFilesMap.set(key, { member_id: mid, path: f.path, edits: 0, additions: 0, deletions: 0, changed_lines: 0 });
    }
    const mf = memberFilesMap.get(key);
    mf.edits += Number(f.edits || 0);
    mf.additions += Number(f.additions || 0);
    mf.deletions += Number(f.deletions || 0);
    mf.changed_lines += Number(f.additions || 0) + Number(f.deletions || 0);
  }
  const memberFiles = Array.from(memberFilesMap.values())
    .sort((a, b) => b.changed_lines - a.changed_lines);

  // 7. Per-member by model
  const memberModelsMap = new Map<string, any>();
  for (const s of sessions) {
    const m = memberById.get(String(s.member_id));
    const model = s.model || 'default';
    const key = `${s.member_id}::${model}::${s.source}`;
    if (!memberModelsMap.has(key)) {
      memberModelsMap.set(key, {
        member_id: s.member_id,
        member_name: m?.display_name || 'Unknown',
        model, source: s.source,
        sessions: 0, tokens_in: 0, tokens_out: 0, tokens_cache_read: 0, api_cost: 0,
      });
    }
    const mm = memberModelsMap.get(key);
    mm.sessions++;
    mm.tokens_in += Number(s.tokens_in || 0);
    mm.tokens_out += Number(s.tokens_out || 0);
    mm.tokens_cache_read += Number(s.tokens_cache_read || 0);
    mm.api_cost += Number(s.api_cost || 0);
  }
  const memberModels = Array.from(memberModelsMap.values())
    .sort((a, b) => b.api_cost - a.api_cost || b.sessions - a.sessions);

  // 8. Project-level rollup (team-wide)
  const projectRollupMap = new Map<string, any>();
  for (const s of sessions) {
    const project = s.agent || 'default';
    if (!projectRollupMap.has(project)) {
      projectRollupMap.set(project, {
        project, memberSet: new Set(), sourceSet: new Set(),
        sessions: 0, tokens_in: 0, tokens_out: 0, tokens_cache_read: 0,
        api_cost: 0, edits: 0, changed_lines: 0, last_activity: null,
      });
    }
    const pr = projectRollupMap.get(project);
    pr.memberSet.add(s.member_id);
    pr.sourceSet.add(s.source);
    pr.sessions++;
    pr.tokens_in += Number(s.tokens_in || 0);
    pr.tokens_out += Number(s.tokens_out || 0);
    pr.tokens_cache_read += Number(s.tokens_cache_read || 0);
    pr.api_cost += Number(s.api_cost || 0);
    pr.edits += Number(s.edits || 0);
    pr.changed_lines += Number(s.changed_lines || 0);
    const ts = s.ended_at || s.started_at || s.synced_at || null;
    if (!pr.last_activity || (ts && ts > pr.last_activity)) pr.last_activity = ts;
  }
  const projectRollup = Array.from(projectRollupMap.values())
    .map((pr) => ({
      project: pr.project,
      member_count: pr.memberSet.size,
      source_count: pr.sourceSet.size,
      sessions: pr.sessions,
      tokens_in: pr.tokens_in,
      tokens_out: pr.tokens_out,
      tokens_cache_read: pr.tokens_cache_read,
      api_cost: pr.api_cost,
      edits: pr.edits,
      changed_lines: pr.changed_lines,
      last_activity: pr.last_activity,
    }))
    .sort((a, b) => b.api_cost - a.api_cost || b.sessions - a.sessions);

  // 9. Team-wide source breakdown
  const bySourceMap = new Map<string, any>();
  for (const s of sessions) {
    const src = s.source;
    if (!bySourceMap.has(src)) {
      bySourceMap.set(src, { source: src, sessions: 0, memberSet: new Set(), tokens_in: 0, tokens_out: 0, tokens_cache_read: 0, edits: 0, api_cost: 0 });
    }
    const bs = bySourceMap.get(src);
    bs.sessions++;
    bs.memberSet.add(s.member_id);
    bs.tokens_in += effIn(s);
    bs.tokens_out += effOut(s);
    bs.tokens_cache_read += Number(s.tokens_cache_read || 0);
    bs.edits += Number(s.edits || 0);
    bs.api_cost += Number(s.api_cost || 0);
  }
  const bySource = Array.from(bySourceMap.values())
    .map((bs) => ({ ...bs, member_count: bs.memberSet.size }))
    .sort((a, b) => b.api_cost - a.api_cost || b.edits - a.edits);

  // 10. Daily activity
  const byDayMap = new Map<string, any>();
  for (const s of sessions) {
    const ts = s.ended_at || s.started_at || s.synced_at;
    if (!ts) continue;
    const date = String(ts).slice(0, 10);
    if (!byDayMap.has(date)) byDayMap.set(date, { date, sessions: 0, tokens_in: 0, tokens_out: 0, edits: 0, api_cost: 0 });
    const bd = byDayMap.get(date);
    bd.sessions++;
    bd.tokens_in += effIn(s);
    bd.tokens_out += effOut(s);
    bd.edits += Number(s.edits || 0);
    bd.api_cost += Number(s.api_cost || 0);
  }
  const byDay = Array.from(byDayMap.values()).sort((a, b) => b.date.localeCompare(a.date));

  // 11. Punch card (weekday × hour)
  const punch: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const s of sessions) {
    const ts = s.ended_at || s.started_at || s.synced_at;
    if (!ts) continue;
    const d = new Date(ts);
    if (isNaN(d.getTime())) continue;
    const w = d.getUTCDay();
    const h = d.getUTCHours();
    if (w >= 0 && w < 7 && h >= 0 && h < 24) punch[w][h]++;
  }
  let peakHour = { weekday: 0, hour: 0, n: 0 };
  for (let w = 0; w < 7; w++) for (let h = 0; h < 24; h++) if (punch[w][h] > peakHour.n) peakHour = { weekday: w, hour: h, n: punch[w][h] };

  // Activity streak
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

  // 12. Top tools
  let allSessionTools: any[] = [];
  if (sessionIds.length) {
    for (const chunk of chunkArray(sessionIds, 30)) {
      const tools = await queryCol('sync_session_tools', [
        { type: 'where', field: 'sync_session_id', op: 'in', value: chunk },
      ]);
      allSessionTools.push(...tools);
    }
  }
  const toolCountMap = new Map<string, number>();
  for (const t of allSessionTools) {
    const name = String(t.tool_name);
    toolCountMap.set(name, (toolCountMap.get(name) || 0) + Number(t.call_count || 1));
  }
  const topTools = Array.from(toolCountMap.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  // 13. Top files team-wide
  const topFilesMap = new Map<string, any>();
  for (const f of allFiles) {
    if (!topFilesMap.has(f.path)) {
      topFilesMap.set(f.path, { path: f.path, edits: 0, additions: 0, deletions: 0, changed_lines: 0, memberSet: new Set() });
    }
    const tf = topFilesMap.get(f.path);
    tf.edits += Number(f.edits || 0);
    tf.additions += Number(f.additions || 0);
    tf.deletions += Number(f.deletions || 0);
    tf.changed_lines += Number(f.additions || 0) + Number(f.deletions || 0);
    const mid = sessionToMember.get(f.sync_session_id);
    if (mid) tf.memberSet.add(mid);
  }
  const topFiles = Array.from(topFilesMap.values())
    .map((tf) => ({ ...tf, member_count: tf.memberSet.size }))
    .sort((a, b) => b.changed_lines - a.changed_lines)
    .slice(0, 40);

  // 14. Recent session log
  const recentLogs = sessions
    .map((s) => {
      const m = memberById.get(String(s.member_id));
      return {
        id: s.id,
        source: s.source,
        project: s.agent || 'default',
        model: s.model,
        member_id: s.member_id,
        member_name: m?.display_name || 'Unknown',
        tokens_in: Number(s.tokens_in || 0),
        tokens_out: Number(s.tokens_out || 0),
        tokens_cache_read: Number(s.tokens_cache_read || 0),
        api_cost: Number(s.api_cost || 0),
        edits: Number(s.edits || 0),
        additions: Number(s.additions || 0),
        deletions: Number(s.deletions || 0),
        changed_lines: Number(s.changed_lines || 0),
        tool_calls: Number(s.tool_calls || 0),
        tool_errors: Number(s.tool_errors || 0),
        timestamp: s.ended_at || s.started_at || s.synced_at,
      };
    })
    .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))
    .slice(0, 50);

  // 15. Model pricing
  const teamPricing = await queryCol('model_pricing', [
    { type: 'where', field: 'team_id', op: '==', value: teamId },
  ]);
  const globalPricing = await queryCol('model_pricing', [
    { type: 'where', field: 'team_id', op: '==', value: null },
  ]);
  const modelPricing = [
    ...teamPricing.map((p) => ({ ...p })),
    ...globalPricing.map((p) => ({ ...p })),
  ].sort((a, b) => {
    if (a.team_id && !b.team_id) return -1;
    if (!a.team_id && b.team_id) return 1;
    return String(a.model_pattern).localeCompare(String(b.model_pattern));
  });

  // 16. Derived stats
  const totalTeamTokens = memberStats.reduce((acc, r) => acc + Number(r.tokens_in) + Number(r.tokens_out), 0);
  const tokenLeaderboard = memberStats
    .map((m) => {
      const totalTokens = Number(m.tokens_in) + Number(m.tokens_out);
      return {
        member_id: m.member_id,
        display_name: m.display_name,
        sessions: m.sessions,
        tokens_in: Number(m.tokens_in),
        tokens_out: Number(m.tokens_out),
        tokens_cache_read: Number(m.tokens_cache_read),
        total_tokens: totalTokens,
        share_pct: totalTeamTokens > 0 ? (totalTokens / totalTeamTokens) * 100 : 0,
        api_cost: m.api_cost,
        edits: m.edits,
      };
    })
    .sort((a, b) => b.total_tokens - a.total_tokens);

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
      if (avgToolErrorRate > 0 && s.toolErrorRate > avgToolErrorRate * RISK_THRESHOLD_MULTIPLIER)
        reasons.push(`tool error rate ${fmtPctReason(s.toolErrorRate)} (team avg ${fmtPctReason(avgToolErrorRate)})`);
      if (avgCorrectionRate > 0 && s.correctionRate > avgCorrectionRate * RISK_THRESHOLD_MULTIPLIER)
        reasons.push(`${s.correctionRate.toFixed(1)} corrections/session (team avg ${avgCorrectionRate.toFixed(1)})`);
      if (avgAbandonedRate > 0 && s.abandonedRate > avgAbandonedRate * RISK_THRESHOLD_MULTIPLIER)
        reasons.push(`abandoned-session rate ${fmtPctReason(s.abandonedRate)} (team avg ${fmtPctReason(avgAbandonedRate)})`);
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
      sources: memberSources.filter((s) => s.member_id === m.member_id),
      projects: memberProjects.filter((p) => p.member_id === m.member_id),
      models: memberModels.filter((mod) => mod.member_id === m.member_id),
      topFiles: memberFiles.filter((f) => f.member_id === m.member_id).slice(0, 10),
    });
  }

  const projects = projectRollup.map((p) => {
    const projMembers = memberProjects.filter((mp) => mp.project === p.project);
    return {
      ...p,
      members: projMembers.map((mp) => {
        const mem = members.find((m: any) => m!.id === mp.member_id) as any;
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
      sessions: 0, edits: 0, additions: 0, deletions: 0, changedLines: 0,
      filesTouched: 0, toolCalls: 0, toolErrors: 0, reworkLoops: 0, corrections: 0,
      abandoned: 0, tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, apiCost: 0,
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
    bySource,
    byDay,
    punch,
    activity,
    topTools,
    topFiles,
    recentLogs,
    modelPricing,
    memberModels,
    totals,
  };
}

// ── Chunk helper (Firestore IN queries max 30) ────────────────────────────────

function chunkArray<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}

async function fetchDocsByIds(collection: string, ids: string[]): Promise<any[]> {
  if (!ids.length) return [];
  const results: any[] = [];
  for (const chunk of chunkArray(ids, 30)) {
    const docs = await queryCol(collection, [
      { type: 'where', field: '__name__', op: 'in', value: chunk },
    ]);
    results.push(...docs);
  }
  return results;
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
 * - Creates user account in `users` collection linked to member and admin team
 */
export async function createTeamUserWithMember({
  teamId,
  displayName,
  username: providedUsername,
  password: providedPassword,
  role = 'member',
}: CreateTeamUserOptions) {
  // 1. Fetch admin team details
  const adminTeam = await getDocById('teams', teamId);
  const adminTeamName = adminTeam?.name || 'Team';

  // 2. Fetch or create Independent team
  let independentTeamId: string;
  const indepTeams = await queryCol<{ id: string; name: string }>('teams', [
    { type: 'where', field: 'name', op: '==', value: 'Independent' },
    { type: 'limit', n: 1 },
  ]);
  if (indepTeams[0]?.id) {
    independentTeamId = indepTeams[0].id;
  } else {
    independentTeamId = newUuid();
    await setDocById('teams', independentTeamId, {
      name: 'Independent',
      created_at: new Date().toISOString(),
    });
  }

  // 3. Resolve username
  let cleanUsername = String(providedUsername || '').trim().toLowerCase();
  const reservedUsernames = ['team', 'superadmin', 'admin', 'root', 'api', 'system', 'dashboard'];
  if (!cleanUsername) {
    const base = displayName.toLowerCase().replace(/[^a-z0-9]/g, '.').replace(/\.+/g, '.').replace(/^\.|\.$/g, '') || 'user';
    let candidate = base;
    let counter = 1;
    while (true) {
      if (!reservedUsernames.includes(candidate)) {
        const existing = await queryCol('users', [
          { type: 'where', field: 'username', op: '==', value: candidate },
          { type: 'limit', n: 1 },
        ]);
        if (existing.length === 0) { cleanUsername = candidate; break; }
      }
      candidate = `${base}${counter}`;
      counter++;
    }
  } else {
    if (cleanUsername.length < 2) throw new Error('Username must be at least 2 characters long');
    if (!/^[a-z0-9_.-]+$/.test(cleanUsername)) throw new Error('Username can only contain letters, numbers, dots, hyphens, and underscores');
    if (reservedUsernames.includes(cleanUsername)) throw new Error('This username is reserved. Please choose another username.');
    const existing = await queryCol('users', [
      { type: 'where', field: 'username', op: '==', value: cleanUsername },
      { type: 'limit', n: 1 },
    ]);
    if (existing.length > 0) throw new Error(`Username "${cleanUsername}" is already taken.`);
  }

  // 4. Resolve temporary password
  const tempPassword = providedPassword?.trim() || `Tracer-${crypto.randomBytes(3).toString('hex')}`;
  const passwordHash = await hashPassword(tempPassword);

  // 5. Create member doc
  const memberId = newUuid();
  const memberDoc = {
    id: memberId,
    team_id: teamId,
    display_name: displayName,
    role,
    created_at: new Date().toISOString(),
  };
  await setDocById('members', memberId, memberDoc);

  // 6. Associate member in team_members for BOTH teams
  const tmId1 = `${teamId}_${memberId}`;
  await setDocById('team_members', tmId1, {
    team_id: teamId, member_id: memberId, role,
    created_at: new Date().toISOString(),
  }, true);
  if (independentTeamId && independentTeamId !== teamId) {
    const tmId2 = `${independentTeamId}_${memberId}`;
    await setDocById('team_members', tmId2, {
      team_id: independentTeamId, member_id: memberId, role: 'member',
      created_at: new Date().toISOString(),
    }, true);
  }

  // 7. Generate API key
  const apiKey = generateApiKey();
  const keyId = newUuid();
  await setDocById('member_keys', keyId, {
    id: keyId,
    member_id: memberId,
    key_hash: hashApiKey(apiKey),
    label: 'default',
    created_at: new Date().toISOString(),
    revoked_at: null,
    last_used_at: null,
  });

  // 8. Create user account
  const userRole = role === 'admin' ? 'admin' : 'user';
  const userId = newUuid();
  const userDoc = {
    id: userId,
    username: cleanUsername,
    password_hash: passwordHash,
    display_name: displayName,
    member_id: memberId,
    team_id: teamId,
    role: userRole,
    api_key: apiKey,
    active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await setDocById('users', userId, userDoc);

  const assignedTeams = [adminTeamName];
  if (adminTeamName !== 'Independent') assignedTeams.push('Independent');

  return {
    member: { id: memberId, display_name: displayName, role },
    user: { id: userId, username: cleanUsername, display_name: displayName, role: userRole, member_id: memberId, team_id: teamId, active: true, created_at: userDoc.created_at },
    tempPassword,
    apiKey,
    teams: assignedTeams,
  };
}

/** Update a team member's display name and role in a team. */
export async function updateMember(memberId: string, teamId: string, displayName: string, role = 'member') {
  await setDocById('members', memberId, { display_name: displayName, updated_at: new Date().toISOString() }, true);
  if (teamId) {
    const tmId = `${teamId}_${memberId}`;
    await setDocById('team_members', tmId, { role }, true);
  }
  return { id: memberId, display_name: displayName, role };
}

/** Unlink a member from a specific team. */
export async function deleteMember(memberId: string, teamId: string) {
  const { deleteDocById } = await import('./db');
  const tmId = `${teamId}_${memberId}`;
  try {
    await deleteDocById('team_members', tmId);
    return { ok: true, deleted: true };
  } catch {
    return { ok: true, deleted: false };
  }
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
 * Recalculate API costs across all synced sessions for members of a team.
 */
export async function recalculateTeamCosts(teamId: string, forceAll: boolean = false) {
  const teamPricing = await queryCol<any>('model_pricing', [
    { type: 'where', field: 'team_id', op: '==', value: teamId },
  ]);
  const globalPricing = await queryCol<any>('model_pricing', [
    { type: 'where', field: 'team_id', op: '==', value: null },
  ]);
  const customRules = [...teamPricing, ...globalPricing];

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

  const sessionConstraints: Parameters<typeof queryCol>[1] = [
    { type: 'where', field: 'team_id', op: '==', value: teamId },
  ];
  if (!forceAll) sessionConstraints.push({ type: 'where', field: 'priced', op: '==', value: false });
  const sessions = await queryCol<any>('sync_sessions', sessionConstraints);

  let updatedCount = 0;
  const updateOps: Array<{ type: 'set'; col: string; id: string; data: object; merge: boolean }> = [];

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
    }

    const freshInput = Math.max(0, tokensIn - tokensCacheRead - tokensCacheWrite);
    const cost =
      (freshInput / 1_000_000) * Number(rule.cost_in_per_m || 0) +
      (tokensOut / 1_000_000) * Number(rule.cost_out_per_m || 0) +
      (tokensCacheRead / 1_000_000) * Number(rule.cost_cache_read_per_m || 0) +
      (tokensCacheWrite / 1_000_000) * Number(((rule as any).cost_cache_write_per_m ?? rule.cost_in_per_m) || 0);

    updateOps.push({
      type: 'set', col: 'sync_sessions', id: s.id,
      data: { api_cost: cost, priced: true, tokens_in: tokensIn, tokens_out: tokensOut },
      merge: true,
    });
    updatedCount++;
  }

  if (updateOps.length) await batchWrite(updateOps);
  return { updatedCount, totalSessions: sessions.length };
}

/**
 * Recalculate API costs across all synced sessions for ALL teams.
 */
export async function recalculateAllCosts(forceAll: boolean = true) {
  const allPricing = await queryCol<any>('model_pricing');
  const globalCustomRules = allPricing.filter((r) => !r.team_id);
  const teamCustomRules = allPricing.filter((r) => Boolean(r.team_id));

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

  const constraints: Parameters<typeof queryCol>[1] = [];
  if (!forceAll) constraints.push({ type: 'where', field: 'priced', op: '==', value: false });
  const sessions = await queryCol<any>('sync_sessions', constraints);

  let updatedCount = 0;
  const updateOps: Array<{ type: 'set'; col: string; id: string; data: object; merge: boolean }> = [];

  for (const s of sessions) {
    const modelName = (s.model || '').toLowerCase();
    const teamRules = s.team_id ? teamCustomRules.filter((r) => r.team_id === s.team_id) : [];
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
    }

    const freshInput = Math.max(0, tokensIn - tokensCacheRead - tokensCacheWrite);
    const cost =
      (freshInput / 1_000_000) * Number(rule.cost_in_per_m || 0) +
      (tokensOut / 1_000_000) * Number(rule.cost_out_per_m || 0) +
      (tokensCacheRead / 1_000_000) * Number(rule.cost_cache_read_per_m || 0) +
      (tokensCacheWrite / 1_000_000) * Number(((rule as any).cost_cache_write_per_m ?? rule.cost_in_per_m) || 0);

    updateOps.push({
      type: 'set', col: 'sync_sessions', id: s.id,
      data: { api_cost: cost, priced: true, tokens_in: tokensIn, tokens_out: tokensOut },
      merge: true,
    });
    updatedCount++;
  }

  if (updateOps.length) await batchWrite(updateOps);
  return { updatedCount, totalSessions: sessions.length };
}
