/**
 * GET /api/admin/research/error-spikes?range=30d&model=&tool=&org=
 * Superadmin-only. Daily tool-error-rate series with rolling-baseline spike
 * detection, plus a per-day tool_name breakdown.
 */
import { NextRequest, NextResponse } from 'next/server';
import { queryCol } from '@/lib/team/db';
import { parseRangeDays, requireSuperadminApi } from '@/lib/team/researchQuery';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const forbidden = requireSuperadminApi(req);
  if (forbidden) return forbidden;

  const searchParams = req.nextUrl.searchParams;
  const days = parseRangeDays(searchParams.get('range'), { def: 30, max: 90 });
  const modelFilter = searchParams.get('model');
  const toolFilter = searchParams.get('tool');
  const orgFilter = searchParams.get('org');

  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();
  const cutoffDate = cutoff.slice(0, 10);

  try {
    const [assistantTurns, syncSessions, toolErrors, userTurns] = await Promise.all([
      queryCol<any>('session_turns', [{ type: 'where', field: 'turn_role', op: '==', value: 'assistant' }]),
      queryCol<any>('sync_sessions'),
      queryCol<any>('session_tool_errors'),
      queryCol<any>('session_turns', [{ type: 'where', field: 'turn_role', op: '==', value: 'user' }]),
    ]);

    const sessionMap = new Map(syncSessions.map((s: any) => [s.session_id || s.id, s]));

    // Filter assistant turns
    const filteredTurns = assistantTurns.filter((st: any) => {
      const ss = sessionMap.get(st.session_id);
      if (!ss || !ss.started_at || ss.started_at < cutoff) return false;
      if (modelFilter && st.model !== modelFilter) return false;
      if (toolFilter && st.tool !== toolFilter) return false;
      if (orgFilter && st.org_id !== orgFilter) return false;
      return true;
    });

    // 1. Group daily turns
    const dailyMap = new Map<string, { day: string; totalTurns: number; errorTurns: number }>();
    for (const st of filteredTurns) {
      const ss = sessionMap.get(st.session_id)!;
      const day = String(ss.started_at).slice(0, 10);
      if (!dailyMap.has(day)) {
        dailyMap.set(day, { day, totalTurns: 0, errorTurns: 0 });
      }
      const d = dailyMap.get(day)!;
      d.totalTurns += 1;
      if (st.tool_error_flag) d.errorTurns += 1;
    }

    const sortedDays = Array.from(dailyMap.values()).sort((a, b) => a.day.localeCompare(b.day));

    // Calculate rolling mean & stddev over 7 preceding days
    const series = sortedDays.map((d, idx) => {
      const errorRate = d.totalTurns > 0 ? d.errorTurns / d.totalTurns : 0;
      const window = sortedDays.slice(Math.max(0, idx - 7), idx);
      let rollingMean: number | null = null;
      let rollingStddev: number | null = null;

      if (window.length > 0) {
        const rates = window.map(w => w.totalTurns > 0 ? w.errorTurns / w.totalTurns : 0);
        const sum = rates.reduce((a, b) => a + b, 0);
        rollingMean = sum / rates.length;
        if (rates.length > 1) {
          const variance = rates.reduce((a, b) => a + (b - rollingMean!) ** 2, 0) / rates.length;
          rollingStddev = Math.sqrt(variance);
        } else {
          rollingStddev = 0;
        }
      }

      const isSpike = rollingMean != null && rollingStddev != null && rollingStddev > 0 && errorRate > rollingMean + 2 * rollingStddev;

      return {
        day: d.day,
        totalTurns: d.totalTurns,
        errorTurns: d.errorTurns,
        errorRate,
        rollingMean,
        rollingStddev,
        isSpike,
      };
    });

    // 2. Tool breakdown
    const filteredToolErrors = toolErrors.filter((ste: any) => {
      if (!ste.is_error || !ste.created_at || ste.created_at < cutoff) return false;
      if (modelFilter && ste.model !== modelFilter) return false;
      if (toolFilter && ste.tool !== toolFilter) return false;
      if (orgFilter && ste.org_id !== orgFilter) return false;
      return true;
    });

    const tbMap = new Map<string, { day: string; toolName: string; errorCount: number }>();
    for (const ste of filteredToolErrors) {
      const day = String(ste.created_at).slice(0, 10);
      const toolName = ste.tool_name || 'unknown';
      const key = `${day}_${toolName}`;
      if (!tbMap.has(key)) {
        tbMap.set(key, { day, toolName, errorCount: 0 });
      }
      tbMap.get(key)!.errorCount += 1;
    }

    const toolBreakdown = Array.from(tbMap.values()).sort((a, b) => a.day.localeCompare(b.day) || b.errorCount - a.errorCount);

    // 3. Drilldown for a specific day
    const drilldownDay = searchParams.get('day');
    let drilldown: any[] | null = null;

    if (drilldownDay) {
      const toolNameFilter = searchParams.get('toolName');
      const turnsById = new Map(userTurns.map((ut: any) => [ut.id, ut]));

      const ddErrors = toolErrors.filter((ste: any) => {
        if (!ste.is_error || !ste.created_at) return false;
        if (String(ste.created_at).slice(0, 10) !== drilldownDay) return false;
        if (modelFilter && ste.model !== modelFilter) return false;
        if (toolFilter && ste.tool !== toolFilter) return false;
        if (orgFilter && ste.org_id !== orgFilter) return false;
        if (toolNameFilter && ste.tool_name !== toolNameFilter) return false;
        return true;
      });

      drilldown = ddErrors
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, 200)
        .map((ste: any) => {
          const st = turnsById.get(ste.turn_id);
          return {
            sessionId: ste.session_id,
            toolName: ste.tool_name,
            toolArgsSummary: ste.tool_args_summary,
            createdAt: ste.created_at,
            model: ste.model,
            tool: ste.tool,
            promptText: st?.prompt_text_sanitized || null,
          };
        });
    }

    return NextResponse.json({ series, toolBreakdown, drilldown });
  } catch (err: any) {
    console.error('[research-error-spikes-error]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
