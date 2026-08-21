import { NextRequest, NextResponse } from 'next/server';
import { queryCol, getDocById } from '@/lib/team/db';
import { effIn, effOut } from '@/lib/team/ingest';

export const dynamic = 'force-dynamic';

function parseDateInput(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const fromParam = searchParams.get('from');
    const toParam = searchParams.get('to');
    const memberIdParam = searchParams.get('memberId');
    const src = searchParams.get('source');
    const all = searchParams.get('all') === 'true';

    const from = parseDateInput(fromParam);
    const to = parseDateInput(toParam);
    const useAll = all || (!from && !to);

    // Resolve member: by explicit param, or fallback to first member
    let memberId = memberIdParam;
    if (!memberId) {
      const members = await queryCol<{ id: string }>('members', [{ type: 'limit', n: 1 }]);
      memberId = members[0]?.id;
    }

    if (!memberId) {
      return NextResponse.json({
        window: { from: null, to: null, all: true },
        totals: {
          sessions: 0,
          tokensIn: 0,
          tokensOut: 0,
          cacheRead: 0,
          cacheWrite: 0,
          edits: 0,
          editCalls: 0,
          additions: 0,
          deletions: 0,
          changedLines: 0,
          filesTouched: 0,
          toolCalls: 0,
          toolErrors: 0,
          reworkLoops: 0,
          corrections: 0,
          abandoned: 0,
          messages: 0,
          spawns: 0,
          errors: 0,
        },
        cost: {
          total: 0,
          pricedSessions: 0,
          unpricedSessions: 0,
          unpricedModels: [],
          coverage: 1,
          billableSessions: 0,
          perSession: null,
          perEdit: null,
          bySource: [],
          sessions: [],
          pricingUpdatedAt: null,
          currency: 'USD',
        },
        leaderboard: [],
        tokenLeaderboard: [],
        scoreboard: [],
        atRisk: [],
        bySource: [],
        byDay: [],
        punch: Array.from({ length: 7 }, () => Array(24).fill(0)),
        activity: { activeDays: 0, streak: 0, peakHour: { weekday: 0, hour: 0, n: 0 }, busiestDay: null },
        impact: { files: [], directories: [], totalEdits: 0, totalAdditions: 0, totalDeletions: 0, totalFiles: 0 },
        topTools: [],
        topFiles: [],
        recentLogs: [],
      });
    }

    // ── Fetch sessions for this member ────────────────────────────────────────
    const allSessionConstraints: Parameters<typeof queryCol>[1] = [
      { type: 'where', field: 'member_id', op: '==', value: memberId },
    ];
    if (src && src !== 'all') allSessionConstraints.push({ type: 'where', field: 'source', op: '==', value: src });

    const allSessions = await queryCol<any>('sync_sessions', allSessionConstraints);

    // Apply date filter in JS
    const sessions = useAll
      ? allSessions
      : allSessions.filter((s: any) => {
          const ts = s.ended_at || s.started_at || s.synced_at;
          if (!ts) return false;
          const dateStr = String(ts).slice(0, 10);
          if (from && dateStr < from) return false;
          if (to && dateStr > to) return false;
          return true;
        });

    // ── 1. Aggregate totals ───────────────────────────────────────────────────
    const totals = sessions.reduce(
      (acc: any, s: any) => {
        const eIn = effIn(s);
        const eOut = effOut(s);
        const isApprox = Number(s.tokens_in || 0) === 0 && Number(s.tool_calls || 0) + Number(s.edits || 0) > 0;
        return {
          sessions: acc.sessions + 1,
          tokens_in: acc.tokens_in + eIn,
          tokens_out: acc.tokens_out + eOut,
          cache_read: acc.cache_read + Number(s.tokens_cache_read || 0),
          cache_write: acc.cache_write + Number(s.tokens_cache_write || 0),
          api_cost: acc.api_cost + Number(s.api_cost || 0),
          edits: acc.edits + Number(s.edits || 0),
          additions: acc.additions + Number(s.additions || 0),
          deletions: acc.deletions + Number(s.deletions || 0),
          changed_lines: acc.changed_lines + Number(s.changed_lines || 0),
          files_touched: acc.files_touched + Number(s.files_touched || 0),
          tool_calls: acc.tool_calls + Number(s.tool_calls || 0),
          tool_errors: acc.tool_errors + Number(s.tool_errors || 0),
          rework_loops: acc.rework_loops + Number(s.rework_loops || 0),
          corrections: acc.corrections + Number(s.corrections || 0),
          abandoned: acc.abandoned + (s.abandoned ? 1 : 0),
          priced_sessions: acc.priced_sessions + (s.priced ? 1 : 0),
          approx_sessions: acc.approx_sessions + (isApprox ? 1 : 0),
        };
      },
      {
        sessions: 0,
        tokens_in: 0,
        tokens_out: 0,
        cache_read: 0,
        cache_write: 0,
        api_cost: 0,
        edits: 0,
        additions: 0,
        deletions: 0,
        changed_lines: 0,
        files_touched: 0,
        tool_calls: 0,
        tool_errors: 0,
        rework_loops: 0,
        corrections: 0,
        abandoned: 0,
        priced_sessions: 0,
        approx_sessions: 0,
      },
    );

    // ── 2. Aggregate per day ──────────────────────────────────────────────────
    const perDayMap = new Map<string, any>();
    for (const s of sessions) {
      const ts = s.ended_at || s.started_at || s.synced_at;
      if (!ts) continue;
      const dateStr = String(ts).slice(0, 10);
      const prev = perDayMap.get(dateStr) || {
        date: dateStr,
        sessions: 0,
        tokens_in: 0,
        tokens_out: 0,
        cache_read: 0,
        cache_write: 0,
        edits: 0,
        additions: 0,
        deletions: 0,
        changed_lines: 0,
        files_touched: 0,
        tool_calls: 0,
        tool_errors: 0,
        rework_loops: 0,
        corrections: 0,
        api_cost: 0,
      };
      prev.sessions += 1;
      prev.tokens_in += effIn(s);
      prev.tokens_out += effOut(s);
      prev.cache_read += Number(s.tokens_cache_read || 0);
      prev.cache_write += Number(s.tokens_cache_write || 0);
      prev.edits += Number(s.edits || 0);
      prev.additions += Number(s.additions || 0);
      prev.deletions += Number(s.deletions || 0);
      prev.changed_lines += Number(s.changed_lines || 0);
      prev.files_touched += Number(s.files_touched || 0);
      prev.tool_calls += Number(s.tool_calls || 0);
      prev.tool_errors += Number(s.tool_errors || 0);
      prev.rework_loops += Number(s.rework_loops || 0);
      prev.corrections += Number(s.corrections || 0);
      prev.api_cost += Number(s.api_cost || 0);
      perDayMap.set(dateStr, prev);
    }
    const perDayRows = [...perDayMap.values()].sort((a, b) => a.date.localeCompare(b.date));

    // ── 3. Aggregate per source ───────────────────────────────────────────────
    const perSourceMap = new Map<string, any>();
    for (const s of sessions) {
      const srcName = String(s.source || 'other');
      const prev = perSourceMap.get(srcName) || {
        source: srcName,
        sessions: 0,
        tokens_in: 0,
        tokens_out: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
        api_cost: 0,
        edits: 0,
        changed_lines: 0,
        files_touched: 0,
        tool_calls: 0,
        tool_errors: 0,
        rework_loops: 0,
        corrections: 0,
        abandoned: 0,
        priced_sessions: 0,
        unpriced_sessions: 0,
        approx_sessions: 0,
      };
      const eIn = effIn(s);
      const eOut = effOut(s);
      const isApprox = Number(s.tokens_in || 0) === 0 && Number(s.tool_calls || 0) + Number(s.edits || 0) > 0;
      prev.sessions += 1;
      prev.tokens_in += eIn;
      prev.tokens_out += eOut;
      prev.tokens_cache_read += Number(s.tokens_cache_read || 0);
      prev.tokens_cache_write += Number(s.tokens_cache_write || 0);
      prev.api_cost += Number(s.api_cost || 0);
      prev.edits += Number(s.edits || 0);
      prev.changed_lines += Number(s.changed_lines || 0);
      prev.files_touched += Number(s.files_touched || 0);
      prev.tool_calls += Number(s.tool_calls || 0);
      prev.tool_errors += Number(s.tool_errors || 0);
      prev.rework_loops += Number(s.rework_loops || 0);
      prev.corrections += Number(s.corrections || 0);
      prev.abandoned += s.abandoned ? 1 : 0;
      if (s.priced) prev.priced_sessions += 1;
      else prev.unpriced_sessions += 1;
      if (isApprox) prev.approx_sessions += 1;
      perSourceMap.set(srcName, prev);
    }
    const perSourceRows = [...perSourceMap.values()].sort((a, b) => b.tokens_in + b.tokens_out - (a.tokens_in + a.tokens_out));

    // ── 4. Aggregate per hour (punch card) ────────────────────────────────────
    const punch: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const s of sessions) {
      const ts = s.ended_at || s.started_at || s.synced_at;
      if (!ts) continue;
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) continue;
      const w = d.getUTCDay();
      const h = d.getUTCHours();
      if (w >= 0 && w < 7 && h >= 0 && h < 24) punch[w][h] += 1;
    }

    // ── 5. Tools breakdown ────────────────────────────────────────────────────
    const sessionDocIds = sessions.map((s) => s.id);
    const toolCountsMap = new Map<string, number>();

    // Chunk session ID queries for tools if needed
    for (let i = 0; i < sessionDocIds.length; i += 30) {
      const chunk = sessionDocIds.slice(i, i + 30);
      if (!chunk.length) continue;
      const toolDocs = await queryCol<{ tool_name: string; call_count: number }>('sync_session_tools', [
        { type: 'where', field: 'sync_session_id', op: 'in', value: chunk },
      ]);
      for (const td of toolDocs) {
        toolCountsMap.set(td.tool_name, (toolCountsMap.get(td.tool_name) || 0) + Number(td.call_count || 0));
      }
    }
    const topToolRows = [...toolCountsMap.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    // ── 6. Files breakdown ────────────────────────────────────────────────────
    const fileStatsMap = new Map<string, any>();
    for (let i = 0; i < sessionDocIds.length; i += 30) {
      const chunk = sessionDocIds.slice(i, i + 30);
      if (!chunk.length) continue;
      const fileDocs = await queryCol<any>('sync_session_files', [
        { type: 'where', field: 'sync_session_id', op: 'in', value: chunk },
      ]);
      for (const fd of fileDocs) {
        const prev = fileStatsMap.get(fd.path) || {
          path: fd.path,
          edits: 0,
          additions: 0,
          deletions: 0,
          sessions: 0,
        };
        prev.edits += Number(fd.edits || 0);
        prev.additions += Number(fd.additions || 0);
        prev.deletions += Number(fd.deletions || 0);
        prev.sessions += 1;
        fileStatsMap.set(fd.path, prev);
      }
    }
    const topFileRows = [...fileStatsMap.values()]
      .sort((a, b) => b.edits - a.edits || b.additions + b.deletions - (a.additions + a.deletions))
      .slice(0, 50);

    // ── Build per-day series with date gap-filling ────────────────────────────
    const dayMap = new Map<string, any>();
    for (const r of perDayRows) {
      const k = String(r.date).slice(0, 10);
      dayMap.set(k, {
        date: k,
        sessions: Number(r.sessions),
        toolCalls: Number(r.tool_calls),
        toolErrors: Number(r.tool_errors),
        reworkLoops: Number(r.rework_loops),
        corrections: Number(r.corrections),
        edits: Number(r.edits),
        additions: Number(r.additions),
        deletions: Number(r.deletions),
        changedLines: Number(r.changed_lines),
        filesTouched: Number(r.files_touched),
        tokensIn: Number(r.tokens_in),
        tokensOut: Number(r.tokens_out),
        cacheRead: Number(r.cache_read),
        cacheWrite: Number(r.cache_write),
        apiCost: Number(r.api_cost),
      });
    }

    let series: any[] = [];
    if (!useAll && from && to && from <= to) {
      const cur = new Date(from);
      const endD = new Date(to);
      while (cur <= endD) {
        const k = cur.toISOString().slice(0, 10);
        series.push(
          dayMap.get(k) ?? {
            date: k,
            sessions: 0,
            toolCalls: 0,
            toolErrors: 0,
            reworkLoops: 0,
            corrections: 0,
            edits: 0,
            additions: 0,
            deletions: 0,
            changedLines: 0,
            filesTouched: 0,
            tokensIn: 0,
            tokensOut: 0,
            cacheRead: 0,
            cacheWrite: 0,
            apiCost: 0,
          },
        );
        cur.setDate(cur.getDate() + 1);
      }
    } else {
      series = [...dayMap.values()];
    }

    // ── Records ───────────────────────────────────────────────────────────────
    let peak = { weekday: 0, hour: 0, n: 0 };
    for (let w = 0; w < 7; w++) {
      for (let h = 0; h < 24; h++) {
        if (punch[w][h] > peak.n) peak = { weekday: w, hour: h, n: punch[w][h] };
      }
    }
    const activeDays = series.filter((d) => d.toolCalls > 0 || d.sessions > 0).length;
    let streak = 0;
    for (let i = series.length - 1; i >= 0 && (series[i].toolCalls > 0 || series[i].sessions > 0); i--) streak++;
    const busiestDay = series.reduce((m: any, d) => (d.toolCalls > (m?.toolCalls || 0) ? d : m), null);

    // ── Impact map ────────────────────────────────────────────────────────────
    function riskLevel(score: number): string {
      return score >= 65 ? 'high' : score >= 30 ? 'watch' : 'low';
    }
    const fileRows = topFileRows.map((f: any) => {
      const s = Number(f.sessions);
      const e = Number(f.edits);
      const churn = Math.max(0, s - 1) + Math.max(0, e - s);
      const score = Math.round(
        Math.min(
          100,
          35 * Math.min(1, s / 4) +
            25 * Math.min(1, e / 8) +
            25 * Math.min(1, churn / 6) +
            15 * Math.min(1, (Number(f.additions) + Number(f.deletions)) / 500),
        ),
      );
      const parts = String(f.path).replace(/\\/g, '/').split('/').filter(Boolean);
      const directory = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
      return {
        path: f.path,
        directory,
        edits: e,
        additions: Number(f.additions),
        deletions: Number(f.deletions),
        changedLines: Number(f.additions) + Number(f.deletions),
        sessions: s,
        churn,
        riskScore: score,
        riskLevel: riskLevel(score),
      };
    });

    const dirMap = new Map<string, any>();
    for (const f of fileRows) {
      const d = dirMap.get(f.directory) ?? { path: f.directory, edits: 0, additions: 0, deletions: 0, files: 0, sessions: 0 };
      d.edits += f.edits;
      d.additions += f.additions;
      d.deletions += f.deletions;
      d.files++;
      d.sessions += f.sessions;
      dirMap.set(f.directory, d);
    }
    const directoryRows = [...dirMap.values()]
      .map((d) => ({ ...d, changedLines: d.additions + d.deletions }))
      .sort((a, b) => b.edits - a.edits || b.changedLines - a.changedLines);

    // ── Cost & scoreboard per source ──────────────────────────────────────────
    const totalApiCost = perSourceRows.reduce((n: number, r: any) => n + Number(r.api_cost), 0);
    const totalPricedSessions = Number(totals?.priced_sessions ?? 0);
    const totalSessions = Number(totals?.sessions ?? 0);
    const approxSessions = Number(totals?.approx_sessions ?? 0);
    const totalTokensIn = Number(totals?.tokens_in ?? 0);
    const totalTokensOut = Number(totals?.tokens_out ?? 0);
    const estimatedCost =
      totalApiCost > 0
        ? totalApiCost
        : (totalTokensIn / 1_000_000) * 3.0 + (totalTokensOut / 1_000_000) * 15.0;

    const scoreboard = perSourceRows.map((r: any) => {
      const sessions2 = Number(r.sessions);
      const edits = Number(r.edits);
      const changedLines = Number(r.changed_lines);
      const tokensOut = Number(r.tokens_out);
      const toolCalls = Number(r.tool_calls);
      const toolErrors = Number(r.tool_errors);
      const tokensIn = Number(r.tokens_in);
      const tokensCacheRead = Number(r.tokens_cache_read);
      const apiCost = Number(r.api_cost);
      const pricedSessions = Number(r.priced_sessions);
      const abandoned = Number(r.abandoned);
      const reworkLoops = Number(r.rework_loops);
      return {
        source: r.source,
        sessions: sessions2,
        tokensIn,
        tokensOut,
        tokensCacheRead,
        tokensCacheWrite: Number(r.tokens_cache_write),
        toolCalls,
        toolErrors,
        reworkLoops,
        corrections: Number(r.corrections),
        abandoned,
        edits,
        changedLines,
        filesTouched: Number(r.files_touched),
        apiCost,
        pricedSessions,
        unpricedSessions: Number(r.unpriced_sessions),
        approxSessions: Number(r.approx_sessions),
        linesPerEdit: edits ? changedLines / edits : null,
        editsPerSession: sessions2 ? edits / sessions2 : null,
        linesPerSession: sessions2 ? changedLines / sessions2 : null,
        tokensPerEdit: edits ? tokensOut / edits : null,
        tokensPerLine: changedLines ? tokensOut / changedLines : null,
        toolCallsPerEdit: edits ? toolCalls / edits : null,
        errorRate: toolCalls ? toolErrors / toolCalls : 0,
        abandonmentRate: sessions2 ? abandoned / sessions2 : 0,
        reworkRate: toolCalls ? reworkLoops / toolCalls : 0,
        cacheHitRate: tokensIn + tokensCacheRead ? tokensCacheRead / (tokensIn + tokensCacheRead) : 0,
        costPerSession: pricedSessions && sessions2 ? apiCost / sessions2 : null,
        costPerEdit: pricedSessions && edits ? apiCost / edits : null,
        costPer100Lines: pricedSessions && changedLines ? (apiCost / changedLines) * 100 : null,
      };
    });

    const costBySource = perSourceRows.map((r: any) => {
      const sessions2 = Number(r.sessions);
      const edits = Number(r.edits);
      const changedLines = Number(r.changed_lines);
      const tokensIn = Number(r.tokens_in);
      const tokensOut = Number(r.tokens_out);
      const tokensCacheRead = Number(r.tokens_cache_read);
      const apiCost = Number(r.api_cost);
      const pricedSessions = Number(r.priced_sessions);
      const unpricedSessions = Number(r.unpriced_sessions);
      const approxSessions2 = Number(r.approx_sessions);
      return {
        source: r.source,
        cost: apiCost,
        pricedSessions,
        unpricedSessions,
        approxSessions: approxSessions2,
        sessions: sessions2,
        tokensIn,
        tokensOut,
        tokensCacheRead,
        edits,
        changedLines,
        costPerSession: pricedSessions && sessions2 ? apiCost / sessions2 : null,
        costPerEdit: pricedSessions && edits ? apiCost / edits : null,
        costPer100Lines: pricedSessions && changedLines ? (apiCost / changedLines) * 100 : null,
      };
    });

    const coverage = totalSessions > 0 ? Math.min(1, (totalPricedSessions + approxSessions) / totalSessions) : 1;
    const totalEdits = Number(totals?.edits ?? 0);

    return NextResponse.json({
      window: { from: from ?? null, to: to ?? null, all: useAll },
      totals: {
        sessions: totalSessions,
        tokensIn: totalTokensIn,
        tokensOut: totalTokensOut,
        cacheRead: Number(totals?.cache_read ?? 0),
        cacheWrite: Number(totals?.cache_write ?? 0),
        edits: totalEdits,
        editCalls: totalEdits,
        additions: Number(totals?.additions ?? 0),
        deletions: Number(totals?.deletions ?? 0),
        changedLines: Number(totals?.changed_lines ?? 0),
        filesTouched: Number(totals?.files_touched ?? 0),
        toolCalls: Number(totals?.tool_calls ?? 0),
        toolErrors: Number(totals?.tool_errors ?? 0),
        reworkLoops: Number(totals?.rework_loops ?? 0),
        corrections: Number(totals?.corrections ?? 0),
        abandoned: Number(totals?.abandoned ?? 0),
        messages: 0,
        spawns: 0,
        errors: Number(totals?.tool_errors ?? 0),
      },
      cost: {
        total: estimatedCost,
        pricedSessions: totalPricedSessions + approxSessions,
        unpricedSessions: Math.max(0, totalSessions - totalPricedSessions - approxSessions),
        unpricedModels: [],
        coverage,
        billableSessions: totalSessions,
        perSession: totalSessions ? estimatedCost / totalSessions : null,
        perEdit: totalEdits ? estimatedCost / totalEdits : null,
        bySource: costBySource,
        sessions: [],
        pricingUpdatedAt: null,
        currency: 'USD',
      },
      leaderboard: [],
      tokenLeaderboard: [],
      scoreboard,
      atRisk: [],
      bySource: perSourceRows.map((r: any) => ({
        source: r.source,
        sessions: Number(r.sessions),
        toolCalls: Number(r.tool_calls),
        edits: Number(r.edits),
        tokensIn: Number(r.tokens_in),
        tokensOut: Number(r.tokens_out),
        tokensCacheRead: Number(r.tokens_cache_read),
        apiCost: Number(r.api_cost),
      })),
      byDay: series,
      punch,
      activity: { activeDays, streak, peakHour: peak, busiestDay },
      impact: {
        files: fileRows,
        directories: directoryRows,
        totalEdits,
        totalAdditions: Number(totals?.additions ?? 0),
        totalDeletions: Number(totals?.deletions ?? 0),
        totalFiles: fileRows.length,
      },
      topTools: topToolRows,
      topFiles: topFileRows,
      recentLogs: [],
    });
  } catch (err) {
    console.error('Stats endpoint error:', err);
    return NextResponse.json({ error: 'Failed to compute stats' }, { status: 500 });
  }
}
