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
  const toolFilter = searchParams.get('tool');

  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();

  try {
    const [assistantTurns, syncSessions] = await Promise.all([
      queryCol<any>('session_turns', [{ type: 'where', field: 'turn_role', op: '==', value: 'assistant' }]),
      queryCol<any>('sync_sessions'),
    ]);

    const sessionMap = new Map(syncSessions.map((s: any) => [s.session_id || s.id, s]));

    const filtered = assistantTurns.filter((st: any) => {
      if (!st.cumulative_input_tokens || st.cumulative_input_tokens <= 0) return false;
      const ss = sessionMap.get(st.session_id);
      if (!ss || !ss.started_at || ss.started_at < cutoff) return false;
      if (modelFilter && st.model !== modelFilter) return false;
      if (toolFilter && st.tool !== toolFilter) return false;
      return true;
    });

    // Bucket calculation: fillBucket 0-9
    const maxContextTokens = 200000;
    const bucketMap = new Map<string, { model: string; fillBucket: number; errors: number; totalTurns: number; validTools: number; totalTools: number }>();

    for (const st of filtered) {
      const fillBucket = Math.min(9, Math.floor((Number(st.cumulative_input_tokens || 0) / maxContextTokens) * 10));
      const key = `${st.model}_${fillBucket}`;
      if (!bucketMap.has(key)) {
        bucketMap.set(key, { model: st.model, fillBucket, errors: 0, totalTurns: 0, validTools: 0, totalTools: 0 });
      }
      const b = bucketMap.get(key)!;
      b.totalTurns += 1;
      if (st.tool_error_flag) b.errors += 1;
      b.validTools += Number(st.tool_call_valid_count || 0);
      b.totalTools += Number(st.tool_call_count || 0);
    }

    const rows = Array.from(bucketMap.values())
      .map(b => ({
        model: b.model,
        fillBucket: b.fillBucket,
        toolErrorRate: b.totalTurns > 0 ? b.errors / b.totalTurns : 0,
        validToolCallRate: b.totalTools > 0 ? b.validTools / b.totalTools : 0,
        sampleSize: b.totalTurns,
      }))
      .sort((a, b) => a.model.localeCompare(b.model) || a.fillBucket - b.fillBucket);

    // Compute inflection points per model
    const inflectionPoints: Record<string, number | null> = {};
    const models = [...new Set(rows.map(r => r.model))];

    for (const m of models) {
      const modelRows = rows.filter(r => r.model === m).sort((a, b) => a.fillBucket - b.fillBucket);
      const baselineRows = modelRows.filter(r => r.fillBucket <= 1);
      const baselineSum = baselineRows.reduce((sum, r) => sum + r.toolErrorRate, 0);
      const baselineError = baselineRows.length ? (baselineSum / baselineRows.length) : 0;

      let inflectionBucket: number | null = null;
      for (const r of modelRows) {
        if (r.fillBucket > 1 && baselineError > 0 && r.toolErrorRate > 1.5 * baselineError) {
          inflectionBucket = r.fillBucket;
          break;
        }
      }
      inflectionPoints[m] = inflectionBucket;
    }

    // Scatter samples
    const scatter = filtered.slice(0, 500).map(st => ({
      model: st.model,
      fillPct: Number(st.cumulative_input_tokens || 0) / maxContextTokens,
      toolErrorFlag: Boolean(st.tool_error_flag),
      sessionId: st.session_id,
      turnIndex: st.turn_index,
    })).sort((a, b) => a.model.localeCompare(b.model) || a.fillPct - b.fillPct);

    return NextResponse.json({ rows, inflectionPoints, scatter });
  } catch (err: any) {
    console.error('[research-saturation-error]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
