import { NextRequest, NextResponse } from 'next/server';
import { queryCol } from '@/lib/team/db';
import { parseRangeDays, requireSuperadminApi } from '@/lib/team/researchQuery';

export const dynamic = 'force-dynamic';

interface OutcomePoint {
  model: string;
  avgCost: number;
  successRate: number;
  sessionCount: number;
  isPareto?: boolean;
}

export async function GET(req: NextRequest) {
  const forbidden = requireSuperadminApi(req);
  if (forbidden) return forbidden;

  const searchParams = req.nextUrl.searchParams;
  const intentFilter = searchParams.get('intent');
  const days = parseRangeDays(searchParams.get('range'));
  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();

  try {
    const [outcomes, syncSessions] = await Promise.all([
      queryCol<any>('session_outcomes'),
      queryCol<any>('sync_sessions'),
    ]);

    const sessionMap = new Map(syncSessions.map((s: any) => [s.session_id || s.id, s]));

    const filtered = outcomes.filter((so: any) => {
      const ss = sessionMap.get(so.session_id);
      if (!ss || !ss.started_at || ss.started_at < cutoff) return false;
      if (intentFilter && (so.intent_category || 'other') !== intentFilter) return false;
      return true;
    });

    // Group by intentCategory and model
    const groupMap = new Map<string, { intentCategory: string; model: string; costs: number[]; successes: number[]; count: number }>();
    for (const so of filtered) {
      const intentCategory = so.intent_category || 'other';
      const model = so.model || 'default';
      const key = `${intentCategory}_${model}`;
      if (!groupMap.has(key)) {
        groupMap.set(key, { intentCategory, model, costs: [], successes: [], count: 0 });
      }
      const g = groupMap.get(key)!;
      g.costs.push(Number(so.total_cost || 0));
      g.successes.push(so.success ? 1 : 0);
      g.count += 1;
    }

    const rows: Array<{ intentCategory: string; model: string; avgCost: number; successRate: number; sessionCount: number }> = [];
    for (const g of groupMap.values()) {
      if (g.count < 2) continue;
      const avgCost = g.costs.reduce((a, b) => a + b, 0) / g.count;
      const successRate = g.successes.reduce((a, b) => a + b, 0) / g.count;
      rows.push({
        intentCategory: g.intentCategory,
        model: g.model,
        avgCost,
        successRate,
        sessionCount: g.count,
      });
    }

    // Group by intentCategory and calculate Pareto frontiers
    const grouped: Record<string, OutcomePoint[]> = {};
    for (const r of rows) {
      if (!grouped[r.intentCategory]) {
        grouped[r.intentCategory] = [];
      }
      grouped[r.intentCategory].push({
        model: r.model,
        avgCost: r.avgCost,
        successRate: r.successRate,
        sessionCount: r.sessionCount,
      });
    }

    const responseData: Record<string, OutcomePoint[]> = {};

    for (const category in grouped) {
      const points = grouped[category];
      points.forEach(p1 => {
        p1.isPareto = !points.some(p2 => {
          if (p1 === p2) return false;
          return p2.avgCost <= p1.avgCost && 
                 p2.successRate >= p1.successRate && 
                 (p2.avgCost < p1.avgCost || p2.successRate > p1.successRate);
        });
      });
      responseData[category] = points;
    }

    if (intentFilter) {
      return NextResponse.json({
        [intentFilter]: responseData[intentFilter] || []
      });
    }

    return NextResponse.json(responseData);
  } catch (err: any) {
    console.error('[research-frontier-error]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
