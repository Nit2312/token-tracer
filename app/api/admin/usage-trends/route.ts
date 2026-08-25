/**
 * GET /api/admin/usage-trends?range=30d&groupBy=tool
 * Superadmin-only. Returns platform-wide usage and growth data.
 */
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSessionFromCookie } from '@/lib/auth';
import { queryCol, getCachedCollection } from '@/lib/team/db';
import { statsCache } from '@/lib/team/cache';

export const dynamic = 'force-dynamic';

function parseDays(range: string | null): number {
  if (!range) return 30;
  const m = range.match(/^(\d+)d$/);
  return m ? Math.min(Math.max(1, Number(m[1])), 90) : 30;
}

export async function GET(req: NextRequest) {
  const cookieStore = await cookies();
  const session = getSessionFromCookie(cookieStore.toString());
  if (!session || session.role !== 'superadmin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const days = parseDays(req.nextUrl.searchParams.get('range'));
  const groupBy = req.nextUrl.searchParams.get('groupBy') || 'tool';

  const cacheKey = `admin_usage_trends_${days}_${groupBy}`;
  const responseData = await statsCache.getOrSet(cacheKey, 90, async () => {
    const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();
    const cutoffDate = cutoff.slice(0, 10);

    const [sessionDocs, memberDocs, eventDocs, teamDocs] = await Promise.all([
      queryCol<any>('sync_sessions'),
      getCachedCollection<any>('members', [], 300),
      getCachedCollection<any>('ingest_events', [], 120),
      getCachedCollection<any>('teams', [], 300),
    ]);

  const inRangeSessions = sessionDocs.filter((s) => {
    const ts = s.ended_at || s.started_at || s.synced_at;
    return ts && String(ts).slice(0, 10) >= cutoffDate;
  });

  // 1. Token trend by tool/source
  const toolMap = new Map<string, { day: string; tool: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; session_count: number }>();
  for (const s of inRangeSessions) {
    const ts = s.ended_at || s.started_at || s.synced_at;
    const day = String(ts).slice(0, 10);
    const tool = s.source || 'unknown';
    const key = `${day}_${tool}`;
    if (!toolMap.has(key)) {
      toolMap.set(key, { day, tool, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, session_count: 0 });
    }
    const row = toolMap.get(key)!;
    row.input_tokens += Number(s.tokens_in || 0);
    row.output_tokens += Number(s.tokens_out || 0);
    row.cache_read_tokens += Number(s.tokens_cache_read || 0);
    row.session_count += 1;
  }
  const tokensByTool = Array.from(toolMap.values()).sort((a, b) => a.day.localeCompare(b.day) || a.tool.localeCompare(b.tool));

  // 2. Model mix over time
  const modelMap = new Map<string, { day: string; model: string; total_tokens: number; session_count: number }>();
  for (const s of inRangeSessions) {
    const ts = s.ended_at || s.started_at || s.synced_at;
    const day = String(ts).slice(0, 10);
    const model = s.model || 'unknown';
    const key = `${day}_${model}`;
    if (!modelMap.has(key)) {
      modelMap.set(key, { day, model, total_tokens: 0, session_count: 0 });
    }
    const row = modelMap.get(key)!;
    row.total_tokens += Number(s.tokens_in || 0) + Number(s.tokens_out || 0);
    row.session_count += 1;
  }
  const modelMix = Array.from(modelMap.values()).sort((a, b) => a.day.localeCompare(b.day) || b.total_tokens - a.total_tokens);

  // 3. Top models overall
  const topModelMap = new Map<string, { model: string; total_tokens: number; session_count: number }>();
  for (const s of inRangeSessions) {
    const model = s.model || 'unknown';
    if (!topModelMap.has(model)) {
      topModelMap.set(model, { model, total_tokens: 0, session_count: 0 });
    }
    const row = topModelMap.get(model)!;
    row.total_tokens += Number(s.tokens_in || 0) + Number(s.tokens_out || 0);
    row.session_count += 1;
  }
  const topModels = Array.from(topModelMap.values())
    .sort((a, b) => b.total_tokens - a.total_tokens)
    .slice(0, 10);

  // 4. Daemon activity
  const now = Date.now();
  const h24Ago = new Date(now - 24 * 3600 * 1000).toISOString();
  const d7Ago = new Date(now - 7 * 86400 * 1000).toISOString();

  const active24hSet = new Set<string>();
  const active7dSet = new Set<string>();
  for (const ie of eventDocs) {
    if (!ie.member_id || !ie.created_at) continue;
    if (ie.created_at >= h24Ago) active24hSet.add(ie.member_id);
    if (ie.created_at >= d7Ago) active7dSet.add(ie.member_id);
  }

  const daemonActivity = {
    total_registered: memberDocs.length,
    active_24h: active24hSet.size,
    active_7d: active7dSet.size,
  };

  // 5. New orgs over time
  const orgGrowthMap = new Map<string, number>();
  for (const t of teamDocs) {
    if (!t.created_at) continue;
    const day = String(t.created_at).slice(0, 10);
    if (day >= cutoffDate) {
      orgGrowthMap.set(day, (orgGrowthMap.get(day) || 0) + 1);
    }
  }
  const orgGrowth = Array.from(orgGrowthMap.entries())
    .map(([day, new_orgs]) => ({ day, new_orgs }))
    .sort((a, b) => a.day.localeCompare(b.day));

  // 6. Platform daily summary
  const dailySummaryMap = new Map<string, { day: string; total_tokens: number; total_sessions: number; orgs: Set<string> }>();
  for (const s of inRangeSessions) {
    const ts = s.ended_at || s.started_at || s.synced_at;
    const day = String(ts).slice(0, 10);
    if (!dailySummaryMap.has(day)) {
      dailySummaryMap.set(day, { day, total_tokens: 0, total_sessions: 0, orgs: new Set() });
    }
    const row = dailySummaryMap.get(day)!;
    row.total_tokens += Number(s.tokens_in || 0) + Number(s.tokens_out || 0) + Number(s.tokens_cache_read || 0);
    row.total_sessions += 1;
    if (s.team_id) row.orgs.add(s.team_id);
  }
  const dailySummary = Array.from(dailySummaryMap.values())
    .map(r => ({ day: r.day, total_tokens: r.total_tokens, total_sessions: r.total_sessions, active_orgs: r.orgs.size }))
    .sort((a, b) => a.day.localeCompare(b.day));

    return {
      range_days: days,
      group_by: groupBy,
      tokens_by_tool: tokensByTool,
      model_mix: modelMix,
      top_models: topModels,
      daemon_activity: daemonActivity,
      org_growth: orgGrowth,
      daily_summary: dailySummary,
    };
  });

  return NextResponse.json(responseData);
}
