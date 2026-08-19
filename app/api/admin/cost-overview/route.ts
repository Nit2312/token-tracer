/**
 * GET /api/admin/cost-overview?range=30d
 * Superadmin-only. Returns platform-wide cost intelligence.
 */
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSessionFromCookie } from '@/lib/auth';
import { queryCol } from '@/lib/team/db';

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
  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();
  const cutoffDate = cutoff.slice(0, 10);

  const [sessionDocs, teamDocs, pricingDocs] = await Promise.all([
    queryCol<any>('sync_sessions'),
    queryCol<any>('teams'),
    queryCol<any>('model_pricing'),
  ]);

  const inRangeSessions = sessionDocs.filter((s) => {
    const ts = s.ended_at || s.started_at || s.synced_at;
    return ts && String(ts).slice(0, 10) >= cutoffDate;
  });

  const teamById = new Map(teamDocs.map((t: any) => [t.id, t]));

  // 1. Daily cost trend
  const costTrendMap = new Map<string, { day: string; list_price_total: number; actual_cost_total: number; session_count: number }>();
  for (const s of inRangeSessions) {
    const ts = s.ended_at || s.started_at || s.synced_at;
    const day = String(ts).slice(0, 10);
    if (!costTrendMap.has(day)) {
      costTrendMap.set(day, { day, list_price_total: 0, actual_cost_total: 0, session_count: 0 });
    }
    const row = costTrendMap.get(day)!;
    const cost = Number(s.api_cost || 0);
    row.list_price_total += cost;
    row.actual_cost_total += cost;
    row.session_count += 1;
  }
  const costTrend = Array.from(costTrendMap.values()).sort((a, b) => a.day.localeCompare(b.day));

  // 2. Cache savings
  const cacheSavingsMap = new Map<string, { day: string; cache_read_tokens: number; cache_write_tokens: number; estimated_cache_savings_usd: number }>();
  for (const s of inRangeSessions) {
    const ts = s.ended_at || s.started_at || s.synced_at;
    const day = String(ts).slice(0, 10);
    if (!cacheSavingsMap.has(day)) {
      cacheSavingsMap.set(day, { day, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cache_savings_usd: 0 });
    }
    const row = cacheSavingsMap.get(day)!;
    const cr = Number(s.tokens_cache_read || 0);
    const cw = Number(s.tokens_cache_write || 0);
    const tin = Number(s.tokens_in || 0);
    const cost = Number(s.api_cost || 0);

    row.cache_read_tokens += cr;
    row.cache_write_tokens += cw;
    if (tin > 0 && cost > 0) {
      row.estimated_cache_savings_usd += cr * (cost / tin) * 0.9;
    }
  }
  const cacheSavings = Array.from(cacheSavingsMap.values()).sort((a, b) => a.day.localeCompare(b.day));

  // 3. Top orgs by cost
  const orgCostMap = new Map<string, { org_id: string; org_name: string; total_actual_cost: number; total_list_cost: number; total_sessions: number; total_input_tokens: number; total_output_tokens: number }>();
  for (const s of inRangeSessions) {
    const orgId = s.team_id || 'unassigned';
    if (!orgCostMap.has(orgId)) {
      const org = teamById.get(orgId);
      orgCostMap.set(orgId, {
        org_id: orgId,
        org_name: org?.name || 'Independent',
        total_actual_cost: 0,
        total_list_cost: 0,
        total_sessions: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
      });
    }
    const row = orgCostMap.get(orgId)!;
    const cost = Number(s.api_cost || 0);
    row.total_actual_cost += cost;
    row.total_list_cost += cost;
    row.total_sessions += 1;
    row.total_input_tokens += Number(s.tokens_in || 0);
    row.total_output_tokens += Number(s.tokens_out || 0);
  }
  const topOrgs = Array.from(orgCostMap.values())
    .sort((a, b) => b.total_actual_cost - a.total_actual_cost)
    .slice(0, 20);

  // 4. Pricing override audit
  const overrideAudit = pricingDocs
    .filter((mp: any) => Boolean(mp.team_id))
    .map((mp: any) => ({
      org_id: mp.team_id,
      org_name: teamById.get(mp.team_id)?.name || 'Unknown',
      model_pattern: mp.model_pattern,
      cost_in_per_m: mp.cost_in_per_m,
      cost_out_per_m: mp.cost_out_per_m,
      cost_cache_read_per_m: mp.cost_cache_read_per_m,
      created_at: mp.created_at,
    }))
    .sort((a, b) => a.org_name.localeCompare(b.org_name) || String(a.model_pattern).localeCompare(String(b.model_pattern)));

  // 5. Platform totals
  let totalListPrice = 0;
  let totalActualCost = 0;
  let totalSessions = inRangeSessions.length;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;

  for (const s of inRangeSessions) {
    const cost = Number(s.api_cost || 0);
    totalListPrice += cost;
    totalActualCost += cost;
    totalInputTokens += Number(s.tokens_in || 0);
    totalOutputTokens += Number(s.tokens_out || 0);
    totalCacheReadTokens += Number(s.tokens_cache_read || 0);
  }

  const totals = {
    total_list_price: totalListPrice,
    total_actual_cost: totalActualCost,
    total_sessions: totalSessions,
    total_input_tokens: totalInputTokens,
    total_output_tokens: totalOutputTokens,
    total_cache_read_tokens: totalCacheReadTokens,
  };

  return NextResponse.json({
    range_days: days,
    cost_trend: costTrend,
    cache_savings: cacheSavings,
    top_orgs: topOrgs,
    override_audit: overrideAudit,
    totals,
  });
}
