import { NextRequest, NextResponse } from 'next/server';
import { queryCol } from '@/lib/team/db';
import { parseRangeDays, requireSuperadminApi } from '@/lib/team/researchQuery';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const forbidden = requireSuperadminApi(req);
  if (forbidden) return forbidden;

  const searchParams = req.nextUrl.searchParams;
  const days = parseRangeDays(searchParams.get('range'));
  const orgFilter = searchParams.get('org');
  const toolFilter = searchParams.get('tool');
  const modelFilter = searchParams.get('model');

  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();

  try {
    const [outcomes, syncSessions, userTurns] = await Promise.all([
      queryCol<any>('session_outcomes'),
      queryCol<any>('sync_sessions'),
      queryCol<any>('session_turns', [{ type: 'where', field: 'turn_role', op: '==', value: 'user' }]),
    ]);

    const sessionMap = new Map(syncSessions.map((s: any) => [s.session_id || s.id, s]));

    const filteredOutcomes = outcomes.filter((so: any) => {
      const ss = sessionMap.get(so.session_id);
      if (!ss || !ss.started_at || ss.started_at < cutoff) return false;
      if (orgFilter && so.org_id !== orgFilter) return false;
      if (toolFilter && so.tool !== toolFilter) return false;
      if (modelFilter && so.model !== modelFilter) return false;
      return true;
    });

    if (!filteredOutcomes.length) {
      return NextResponse.json([]);
    }

    // Sort by complexity score to assign terciles (NTILE(3))
    filteredOutcomes.sort((a, b) => Number(a.complexity_score || 0) - Number(b.complexity_score || 0));
    const outcomeBucketMap = new Map<string, { bucket: number; so: any }>();
    const n = filteredOutcomes.length;
    filteredOutcomes.forEach((so, idx) => {
      const bucket = idx < n / 3 ? 1 : idx < (2 * n) / 3 ? 2 : 3;
      outcomeBucketMap.set(so.session_id, { bucket, so });
    });

    // Group user turns
    const groupMap = new Map<string, { tier: string; complexityBucket: string; sessions: Set<string>; totalTokens: number; linesChanged: number; reworkCount: number; revertCount: number }>();

    for (const ut of userTurns) {
      const info = outcomeBucketMap.get(ut.session_id);
      if (!info) continue;
      const { bucket, so } = info;

      let score = 0;
      if (ut.has_code_block) score += 1;
      if (ut.has_file_path) score += 1;
      if (ut.has_traceback) score += 1;

      const tier = score === 0 ? 'vague' : score === 1 ? 'partial' : 'specific';
      const complexityBucket = bucket === 1 ? 'Low Complexity' : bucket === 2 ? 'Medium Complexity' : 'High Complexity';

      const key = `${tier}_${complexityBucket}`;
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          tier,
          complexityBucket,
          sessions: new Set(),
          totalTokens: 0,
          linesChanged: 0,
          reworkCount: 0,
          revertCount: 0,
        });
      }
      const g = groupMap.get(key)!;
      if (!g.sessions.has(so.session_id)) {
        g.sessions.add(so.session_id);
        g.totalTokens += Number(so.total_input_tokens || 0) + Number(so.total_output_tokens || 0);
        g.linesChanged += Number(so.lines_changed || 0);
        if (so.had_rework) g.reworkCount += 1;
        if (so.had_revert) g.revertCount += 1;
      }
    }

    const tierOrder: Record<string, number> = { vague: 0, partial: 1, specific: 2 };
    const bucketOrder: Record<string, number> = { 'Low Complexity': 0, 'Medium Complexity': 1, 'High Complexity': 2 };

    const rows = Array.from(groupMap.values())
      .map(g => {
        const sampleSize = g.sessions.size;
        return {
          tier: g.tier,
          complexityBucket: g.complexityBucket,
          sampleSize,
          avgTokensPerLine: g.linesChanged > 0 ? g.totalTokens / g.linesChanged : 0,
          reworkRate: sampleSize > 0 ? g.reworkCount / sampleSize : 0,
          revertRate: sampleSize > 0 ? g.revertCount / sampleSize : 0,
        };
      })
      .sort((a, b) => (tierOrder[a.tier] - tierOrder[b.tier]) || (bucketOrder[a.complexityBucket] - bucketOrder[b.complexityBucket]));

    return NextResponse.json(rows);
  } catch (err: any) {
    console.error('[research-specificity-error]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
