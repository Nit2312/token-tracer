import { NextRequest, NextResponse } from 'next/server';
import { queryCol } from '@/lib/team/db';
import { parseRangeDays, requireSuperadminApi } from '@/lib/team/researchQuery';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const forbidden = requireSuperadminApi(req);
  if (forbidden) return forbidden;

  const searchParams = req.nextUrl.searchParams;
  const days = parseRangeDays(searchParams.get('range'));
  const modelFilter = searchParams.get('model');
  const intentFilter = searchParams.get('intent');

  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();

  try {
    const [assistantTurns, userTurns, syncSessions] = await Promise.all([
      queryCol<any>('session_turns', [{ type: 'where', field: 'turn_role', op: '==', value: 'assistant' }]),
      queryCol<any>('session_turns', [{ type: 'where', field: 'turn_role', op: '==', value: 'user' }]),
      queryCol<any>('sync_sessions'),
    ]);

    const sessionMap = new Map(syncSessions.map((s: any) => [s.session_id || s.id, s]));
    const userTurnByKey = new Map<string, any>();
    for (const ut of userTurns) {
      userTurnByKey.set(`${ut.session_id}:${ut.turn_index}`, ut);
    }

    const filtered = assistantTurns.filter((st: any) => {
      if (!st.input_tokens || !st.output_tokens || st.input_tokens <= 0 || st.output_tokens <= 0) return false;
      const ss = sessionMap.get(st.session_id);
      if (!ss || !ss.started_at || ss.started_at < cutoff) return false;
      if (modelFilter && st.model !== modelFilter) return false;
      
      const ut = userTurnByKey.get(`${st.session_id}:${st.turn_index}`);
      const intent = ut?.intent_category || 'other';
      if (intentFilter && intent !== intentFilter) return false;
      return true;
    });

    // Group for linear regression
    const groups = new Map<string, { model: string; intentCategory: string; xs: number[]; ys: number[]; files: number[] }>();
    for (const st of filtered) {
      const ut = userTurnByKey.get(`${st.session_id}:${st.turn_index}`);
      const intentCategory = ut?.intent_category || 'other';
      const key = `${st.model}_${intentCategory}`;
      if (!groups.has(key)) {
        groups.set(key, { model: st.model, intentCategory, xs: [], ys: [], files: [] });
      }
      const g = groups.get(key)!;
      g.xs.push(Number(st.input_tokens));
      g.ys.push(Number(st.output_tokens));
      g.files.push(Number(st.files_touched || 0));
    }

    const stats: any[] = [];
    const points: any[] = [];

    for (const g of groups.values()) {
      const n = g.xs.length;
      if (n < 5) continue;

      let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
      for (let i = 0; i < n; i++) {
        const x = g.xs[i];
        const y = g.ys[i];
        sumX += x;
        sumY += y;
        sumXY += x * y;
        sumX2 += x * x;
        sumY2 += y * y;
      }

      const meanX = sumX / n;
      const meanY = sumY / n;
      const numerator = sumXY - n * meanX * meanY;
      const denominator = sumX2 - n * meanX * meanX;
      const slope = denominator !== 0 ? numerator / denominator : 0;
      const intercept = meanY - slope * meanX;

      const sxx = sumX2 - n * meanX * meanX;
      const syy = sumY2 - n * meanY * meanY;
      const r2 = sxx > 0 && syy > 0 ? (numerator * numerator) / (sxx * syy) : 0;

      stats.push({
        model: g.model,
        intentCategory: g.intentCategory,
        slope,
        intercept,
        r2,
        sampleSize: n,
      });

      // Sample up to 500 scatter points
      const indices = Array.from({ length: n }, (_, i) => i);
      // Simple random sample
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      const sampleIndices = indices.slice(0, 500);

      for (const idx of sampleIndices) {
        points.push({
          model: g.model,
          intentCategory: g.intentCategory,
          x: g.xs[idx],
          y: g.ys[idx],
          filesTouched: g.files[idx],
        });
      }
    }

    return NextResponse.json({ stats, points });
  } catch (err: any) {
    console.error('[research-elasticity-error]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
