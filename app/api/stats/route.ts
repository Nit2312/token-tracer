/**
 * Personal dashboard stats endpoint — DB-backed, full-fidelity.
 * GET /api/stats?from=YYYY-MM-DD&to=YYYY-MM-DD&source=cursor&all=1
 *
 * Returns the SAME rich data shape as the local buildStats() function so
 * app.js renders correctly for DB-backed users (identical to local-file mode).
 * All aggregation is done in JavaScript over Firestore reads.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/auth';
import { getDocById, queryCol } from '@/lib/team/db';
import { normalizeDateParam } from '@/lib/analytics.mjs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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

export async function GET(req: NextRequest) {
  const session = getSessionFromCookie(req.headers.get('cookie'));
  if (!session) {
    return NextResponse.json({ error: 'not authenticated', redirect: '/login' }, { status: 401 });
  }

  if (session.role !== 'user') {
    return NextResponse.json({ error: 'personal stats are for regular users only' }, { status: 403 });
  }

  let memberId = session.memberId;
  try {
    const userDoc = await getDocById('users', session.userId);
    if (userDoc?.member_id) memberId = userDoc.member_id;
  } catch (err) {
    console.warn('[stats route member lookup failed]', err);
  }

  if (!memberId) {
    return NextResponse.json({ error: 'user account is not linked to any member profile' }, { status: 403 });
  }

  try {
    const url = req.nextUrl;
    const src = url.searchParams.get('source');
    const allParam = url.searchParams.get('all');
    const all = allParam === '1' || allParam === 'true';
    let from = normalizeDateParam(url.searchParams.get('from'));
    let to = normalizeDateParam(url.searchParams.get('to'));
    if (from && to && from > to) { const tmp = from; from = to; to = tmp; }
    const useAll = all || (!from && !to);

    // ── Local file fallback (dev only, only if not Firebase-backed) ──────────
    if (process.env.VERCEL !== '1' && !process.env.FIREBASE_PROJECT_ID) {
      try {
        const { scanSessions } = await import('@/lib/scan.mjs');
        const { buildStats } = await import('@/lib/analytics.mjs');
        const pricingData = (await import('@/lib/pricing.json')).default;

        const { sessions: localSessions } = scanSessions({ sources: src ? [src] : null });
        if (localSessions.length > 0) {
          let filtered = localSessions;
          if (!useAll) {
            filtered = localSessions.filter((s: any) => {
              const dt = new Date(s.endedAt || s.startedAt || Date.now());
              const dateStr = dt.toISOString().slice(0, 10);
              if (from && dateStr < from) return false;
              if (to && dateStr > to) return false;
              return true;
            });
          }
          const localStats = buildStats(filtered, { from: from || undefined, to: to || undefined, pricing: pricingData });
          return NextResponse.json(localStats);
        }
      } catch (err) {
        console.warn('Local stats scan fallback failed:', err);
      }
    }

    // ── Fetch sessions for this member ────────────────────────────────────────
    const allSessionConstraints: Parameters<typeof queryCol>[1] = [
      { type: 'where', field: 'member_id', op: '==', value: memberId },
    ];
    if (src && src !== 'all') allSessionConstraints.push({ type: 'where', field: 'source', op: '==', value: src });

    const allSessions = await queryCol<any>('sync_sessions', allSessionConstraints);

    // Apply date filter in JS
    const sessions = useAll ? allSessions : allSessions.filter((s: any) => {
      const ts = s.ended_at || s.started_at || s.synced_at;
      if (!ts) return false;
      const dateStr = String(ts).slice(0, 10);
      if (from && dateStr < from) return false;
      if (to && dateStr > to) return false;
      return true;
    });

    // ── 1. Aggregate totals ───────────────────────────────────────────────────
    const totals = sessions.reduce((acc: any, s: any) => {
      const eIn = effIn(s);
      const eOut = effOut(s);
      const isApprox = Number(s.tokens_in || 0) === 0 && (Number(s.tool_calls || 0) + Number(s.edits || 0)) > 0;
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
    }, {
      sessions: 0, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0,
      api_cost: 0, edits: 0, additions: 0, deletions: 0, changed_lines: 0,
      files_touched: 0, tool_calls: 0, tool_errors: 0, rework_loops: 0,
      corrections: 0, abandoned: 0, priced_sessions: 0, approx_sessions: 0,
    });

    // ── 2. Per-day breakdown ──────────────────────────────────────────────────
    const dayMap = new Map<string, any>();
    for (const s of sessions) {
      const ts = s.ended_at || s.started_at || s.synced_at;
      if (!ts) continue;
      const k = String(ts).slice(0, 10);
      if (!dayMap.has(k)) dayMap.set(k, { date: k, sessions: 0, tokens_in: 0, tokens_out: 0, tokens_cache: 0, tokens_cache_write: 0, api_cost: 0, edits: 0, additions: 0, deletions: 0, tool_calls: 0 });
      const d = dayMap.get(k);
      d.sessions++;
      d.tokens_in += effIn(s);
      d.tokens_out += effOut(s);
      d.tokens_cache += Number(s.tokens_cache_read || 0);
      d.tokens_cache_write += Number(s.tokens_cache_write || 0);
      d.api_cost += Number(s.api_cost || 0);
      d.edits += Number(s.edits || 0);
      d.additions += Number(s.additions || 0);
      d.deletions += Number(s.deletions || 0);
      d.tool_calls += Number(s.tool_calls || 0);
    }

    // ── 3. Per-source breakdown ───────────────────────────────────────────────
    const sourceMap = new Map<string, any>();
    for (const s of sessions) {
      const src2 = s.source || 'unknown';
      if (!sourceMap.has(src2)) sourceMap.set(src2, { source: src2, sessions: 0, tokens_in: 0, tokens_out: 0, tokens_cache_read: 0, api_cost: 0, edits: 0, changed_lines: 0, tool_calls: 0, tool_errors: 0, rework_loops: 0, abandoned: 0, priced_sessions: 0 });
      const ss = sourceMap.get(src2);
      ss.sessions++;
      ss.tokens_in += effIn(s);
      ss.tokens_out += effOut(s);
      ss.tokens_cache_read += Number(s.tokens_cache_read || 0);
      ss.api_cost += Number(s.api_cost || 0);
      ss.edits += Number(s.edits || 0);
      ss.changed_lines += Number(s.changed_lines || 0);
      ss.tool_calls += Number(s.tool_calls || 0);
      ss.tool_errors += Number(s.tool_errors || 0);
      ss.rework_loops += Number(s.rework_loops || 0);
      ss.abandoned += s.abandoned ? 1 : 0;
      ss.priced_sessions += s.priced ? 1 : 0;
    }
    const perSourceRows = Array.from(sourceMap.values()).sort((a, b) => b.sessions - a.sessions);

    // ── 4. Per-model breakdown ────────────────────────────────────────────────
    const modelMap = new Map<string, any>();
    for (const s of sessions) {
      const model = s.model;
      if (!model) continue;
      if (!modelMap.has(model)) modelMap.set(model, { model, sessions: 0, tokens: 0, api_cost: 0 });
      const mm = modelMap.get(model);
      mm.sessions++;
      mm.tokens += effIn(s) + effOut(s);
      mm.api_cost += Number(s.api_cost || 0);
    }
    const perModelRows = Array.from(modelMap.values()).sort((a, b) => b.tokens - a.tokens).slice(0, 20);

    // ── 5. Top tools ──────────────────────────────────────────────────────────
    const sessionIds = sessions.map((s: any) => s.id).filter(Boolean);
    let allSessionTools: any[] = [];
    if (sessionIds.length) {
      for (let i = 0; i < sessionIds.length; i += 30) {
        const chunk = sessionIds.slice(i, i + 30);
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
    const topToolRows = Array.from(toolCountMap.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    // ── 6. Hourly punch-card ──────────────────────────────────────────────────
    const punch: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const s of sessions) {
      const ts = s.ended_at || s.started_at || s.synced_at;
      if (!ts) continue;
      const d = new Date(ts);
      if (isNaN(d.getTime())) continue;
      punch[d.getUTCDay()][d.getUTCHours()]++;
    }

    // ── 7. Top files ──────────────────────────────────────────────────────────
    const sessionIdSet = new Set(sessions.map((s: any) => s.id));
    let allFiles: any[] = [];
    if (sessionIds.length) {
      for (let i = 0; i < sessionIds.length; i += 30) {
        const chunk = sessionIds.slice(i, i + 30);
        const files = await queryCol('sync_session_files', [
          { type: 'where', field: 'sync_session_id', op: 'in', value: chunk },
        ]);
        allFiles.push(...files);
      }
    }
    const fileMap = new Map<string, any>();
    for (const f of allFiles) {
      const k = f.path;
      if (!fileMap.has(k)) fileMap.set(k, { path: k, edits: 0, additions: 0, deletions: 0, changed_lines: 0, sessions: new Set<string>() });
      const fm = fileMap.get(k);
      fm.edits += Number(f.edits || 0);
      fm.additions += Number(f.additions || 0);
      fm.deletions += Number(f.deletions || 0);
      fm.changed_lines += Number(f.additions || 0) + Number(f.deletions || 0);
      fm.sessions.add(f.sync_session_id);
    }
    const topFileRows = Array.from(fileMap.values())
      .map((f) => ({ ...f, sessions: f.sessions.size }))
      .sort((a, b) => b.changed_lines - a.changed_lines)
      .slice(0, 50);

    // ── Build per-day series with gap-filling ─────────────────────────────────
    const allKeys = [...dayMap.keys()].sort();
    const seriesFrom = from || (allKeys[0] ?? new Date().toISOString().slice(0, 10));
    const seriesTo = to || (allKeys[allKeys.length - 1] ?? new Date().toISOString().slice(0, 10));
    const series: any[] = [];
    {
      const cur = new Date(`${seriesFrom}T00:00:00`);
      const end = new Date(`${seriesTo}T00:00:00`);
      while (cur <= end) {
        const k = cur.toISOString().slice(0, 10);
        const r = dayMap.get(k);
        series.push(r ? {
          date: k, sessions: r.sessions,
          tokensIn: r.tokens_in, tokensOut: r.tokens_out,
          tokensCache: r.tokens_cache, tokensCacheWrite: r.tokens_cache_write,
          apiCost: r.api_cost, edits: r.edits,
          additions: r.additions, deletions: r.deletions, toolCalls: r.tool_calls,
        } : {
          date: k, sessions: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0,
          tokensCacheWrite: 0, apiCost: 0, edits: 0, additions: 0, deletions: 0, toolCalls: 0,
        });
        cur.setDate(cur.getDate() + 1);
      }
    }

    // ── Records ───────────────────────────────────────────────────────────────
    let peak = { weekday: 0, hour: 0, n: 0 };
    for (let w = 0; w < 7; w++) for (let h = 0; h < 24; h++) if (punch[w][h] > peak.n) peak = { weekday: w, hour: h, n: punch[w][h] };
    const activeDays = series.filter((d) => d.toolCalls > 0 || d.sessions > 0).length;
    let streak = 0;
    for (let i = series.length - 1; i >= 0 && (series[i].toolCalls > 0 || series[i].sessions > 0); i--) streak++;
    const busiestDay = series.reduce((m: any, d) => (d.toolCalls > (m?.toolCalls || 0) ? d : m), null);

    // ── Impact map ────────────────────────────────────────────────────────────
    function riskLevel(score: number): string { return score >= 65 ? 'high' : score >= 30 ? 'watch' : 'low'; }
    const fileRows = topFileRows.map((f: any) => {
      const s = Number(f.sessions);
      const e = Number(f.edits);
      const churn = Math.max(0, s - 1) + Math.max(0, e - s);
      const score = Math.round(Math.min(100,
        35 * Math.min(1, s / 4) + 25 * Math.min(1, e / 8)
        + 25 * Math.min(1, churn / 6) + 15 * Math.min(1, (Number(f.additions) + Number(f.deletions)) / 500)));
      const parts = String(f.path).replace(/\\/g, '/').split('/').filter(Boolean);
      const directory = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
      return {
        path: f.path, directory,
        edits: e, additions: Number(f.additions), deletions: Number(f.deletions),
        changedLines: Number(f.changed_lines), sessions: s, churn,
        sources: [], riskScore: score, risk: riskLevel(score),
      };
    }).sort((a: any, b: any) => b.riskScore - a.riskScore || b.changedLines - a.changedLines);

    const dirMap = new Map<string, any>();
    for (const f of fileRows) {
      const d = dirMap.get(f.directory) ?? { path: f.directory, edits: 0, additions: 0, deletions: 0, files: 0, sessions: 0 };
      d.edits += f.edits; d.additions += f.additions; d.deletions += f.deletions;
      d.files++; d.sessions += f.sessions;
      dirMap.set(f.directory, d);
    }
    const directoryRows = [...dirMap.values()]
      .map((d) => ({ ...d, changedLines: d.additions + d.deletions }))
      .sort((a, b) => b.edits - a.edits || b.changedLines - a.changedLines);

    const churnFiles = fileRows.filter((f: any) => f.sessions > 1 || f.churn > 1);

    // ── Cost & scoreboard per source ──────────────────────────────────────────
    const totalApiCost = perSourceRows.reduce((n: number, r: any) => n + Number(r.api_cost), 0);
    const totalPricedSessions = Number(totals?.priced_sessions ?? 0);
    const totalSessions = Number(totals?.sessions ?? 0);
    const approxSessions = Number(totals?.approx_sessions ?? 0);
    const totalTokensIn = Number(totals?.tokens_in ?? 0);
    const totalTokensOut = Number(totals?.tokens_out ?? 0);
    const estimatedCost = totalApiCost > 0 ? totalApiCost
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
        edits,
        reworkPerSession: sessions2 ? reworkLoops / sessions2 : 0,
        abandonedRate: sessions2 ? abandoned / sessions2 : 0,
        medianTimeToFirstEditMs: null,
        editsPerSession: sessions2 ? edits / sessions2 : null,
        outputTokensPerEdit: edits ? tokensOut / edits : null,
        toolErrorRate: toolCalls ? toolErrors / toolCalls : null,
        medianToolLatencyMs: null,
        cacheEfficiency: tokensIn ? tokensCacheRead / tokensIn : null,
        costPerEdit: pricedSessions && edits ? apiCost / edits : null,
        costPer100Lines: pricedSessions && changedLines ? apiCost / changedLines * 100 : null,
      };
    });

    const costBySource = perSourceRows.map((r: any) => {
      const apiCost = Number(r.api_cost);
      const edits = Number(r.edits);
      const changedLines = Number(r.changed_lines);
      const pricedSessions = Number(r.priced_sessions);
      return {
        source: r.source,
        total: apiCost,
        sessions: Number(r.sessions),
        pricedSessions,
        costPerEdit: pricedSessions && edits ? apiCost / edits : null,
        costPer100Lines: pricedSessions && changedLines ? apiCost / changedLines * 100 : null,
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
      workflow: {
        reworkLoops: Number(totals?.rework_loops ?? 0),
        abandoned: Number(totals?.abandoned ?? 0),
        corrections: Number(totals?.corrections ?? 0),
        medianTimeToFirstEditMs: null,
        sessionsCorrected: 0,
        sessionsWithRework: 0,
      },
      impact: { files: fileRows, directories: directoryRows, churnFiles },
      scoreboard,
      perDay: series,
      punch,
      sources: perSourceRows.map((r: any) => ({
        source: r.source,
        sessions: Number(r.sessions),
        tokens: Number(r.tokens_in) + Number(r.tokens_out),
        apiCost: Number(r.api_cost),
        edits: Number(r.edits),
      })),
      models: perModelRows.map((r: any) => ({
        model: r.model,
        name: r.model,
        sessions: Number(r.sessions),
        tokens: Number(r.tokens),
        apiCost: Number(r.api_cost),
        rate: null,
      })),
      tools: topToolRows.map((r: any) => ({
        name: r.name,
        count: Number(r.count),
        errors: 0,
      })),
      records: {
        longestSession: null,
        busiestDay: busiestDay && busiestDay.toolCalls > 0 ? busiestDay : null,
        peakHour: peak.n ? peak : null,
        activeDays,
        streak,
      },
    });
  } catch (err) {
    console.error('[stats GET error]', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
