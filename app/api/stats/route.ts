/**
 * Personal dashboard stats endpoint — DB-backed, full-fidelity.
 * GET /api/stats?from=YYYY-MM-DD&to=YYYY-MM-DD&source=cursor&all=1
 *
 * Returns the SAME rich data shape as the local buildStats() function so
 * app.js renders correctly for DB-backed users (identical to local-file mode).
 * All independent queries run in parallel via Promise.all for performance.
 *
 * Token approximation: sessions synced before real token capture had tokens_in=0.
 * We apply the same formula as ingest.ts inline in SQL so charts always show data:
 *   effective_in  = CASE WHEN tokens_in=0 AND (tool_calls+edits)>0
 *                        THEN GREATEST(500, (tool_calls+edits)*350 + changed_lines*10)
 *                        ELSE tokens_in END
 *   effective_out = CASE WHEN tokens_out=0 AND (tool_calls+edits)>0
 *                        THEN GREATEST(200, (tool_calls+edits)*150 + changed_lines*5)
 *                        ELSE tokens_out END
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/auth';
import { query } from '@/lib/team/db';
import { normalizeDateParam } from '@/lib/analytics.mjs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ── Inline SQL token approximation expressions ────────────────────────────────
// Mirrors the logic in lib/team/ingest.ts: estimate tokens from tool+edit counts
// when the actual token values were not captured at sync time.
const EFF_IN = `
  CASE
    WHEN s.tokens_in = 0 AND (s.tool_calls + s.edits) > 0
    THEN GREATEST(500, (s.tool_calls + s.edits) * 350 + s.changed_lines * 10)
    ELSE s.tokens_in
  END
`.trim();
const EFF_OUT = `
  CASE
    WHEN s.tokens_out = 0 AND (s.tool_calls + s.edits) > 0
    THEN GREATEST(200, (s.tool_calls + s.edits) * 150 + s.changed_lines * 5)
    ELSE s.tokens_out
  END
`.trim();

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
    const { rows: userRows } = await query('SELECT member_id FROM users WHERE id = $1', [session.userId]);
    if (userRows[0]?.member_id) {
      memberId = userRows[0].member_id;
    }
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

    // ── Local file fallback (dev only, only if not database-backed) ──────────
    if (process.env.VERCEL !== '1' && !process.env.DATABASE_URL && !process.env.NEON_CONNECTION_STRING) {

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

    // ── Timezone resolution ──────────────────────────────────────────────────
    const tzParam = url.searchParams.get('tz') || 'UTC';
    let validTz = 'UTC';
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tzParam });
      validTz = tzParam;
    } catch {
      validTz = 'UTC';
    }

    // ── Build parameterised WHERE clauses ────────────────────────────────────
    const params: unknown[] = [memberId, validTz];
    const tzIdx = 2;
    let dateFilter = '';
    if (!useAll) {
      if (from) { params.push(from); dateFilter += ` AND (COALESCE(s.ended_at, s.started_at, s.synced_at) AT TIME ZONE $${tzIdx})::date >= $${params.length}::date`; }
      if (to)   { params.push(to);   dateFilter += ` AND (COALESCE(s.ended_at, s.started_at, s.synced_at) AT TIME ZONE $${tzIdx})::date <= $${params.length}::date`; }
    }
    if (src && src !== 'all') { params.push(src); dateFilter += ` AND s.source = $${params.length}`; }

    // ── Fire all independent queries in parallel ──────────────────────────────
    const [
      totalsRes,
      perDayRes,
      perSourceRes,
      perModelRes,
      topToolsRes,
      perHourRes,
      topFilesRes,
      projectRollupRes,
    ] = await Promise.all([
        // 1. Aggregate totals — use effective tokens (with approximation for zero-token sessions)
        query(`
          SELECT
            count(*)::int AS sessions,
            coalesce(sum(${EFF_IN}), 0)::bigint AS tokens_in,
            coalesce(sum(${EFF_OUT}), 0)::bigint AS tokens_out,
            coalesce(sum(s.tokens_cache_read), 0)::bigint AS cache_read,
            coalesce(sum(s.tokens_cache_write), 0)::bigint AS cache_write,
            coalesce(sum(s.api_cost), 0)::float AS api_cost,
            coalesce(sum(s.edits), 0)::int AS edits,
            coalesce(sum(s.additions), 0)::int AS additions,
            coalesce(sum(s.deletions), 0)::int AS deletions,
            coalesce(sum(s.changed_lines), 0)::int AS changed_lines,
            coalesce(sum(s.files_touched), 0)::int AS files_touched,
            coalesce(sum(s.tool_calls), 0)::int AS tool_calls,
            coalesce(sum(s.tool_errors), 0)::int AS tool_errors,
            coalesce(sum(s.rework_loops), 0)::int AS rework_loops,
            coalesce(sum(s.corrections), 0)::int AS corrections,
            coalesce(sum(CASE WHEN s.abandoned THEN 1 ELSE 0 END), 0)::int AS abandoned,
            coalesce(sum(CASE WHEN s.priced THEN 1 ELSE 0 END), 0)::int AS priced_sessions,
            -- Count zero-token sessions that have activity (these have approximated costs)
            coalesce(sum(CASE WHEN s.tokens_in = 0 AND (s.tool_calls + s.edits) > 0 THEN 1 ELSE 0 END), 0)::int AS approx_sessions
          FROM sync_sessions s
          WHERE s.member_id = $1 ${dateFilter}
        `, params),

        // 2. Per-day breakdown in user's timezone — effective tokens for chart
        query(`
          SELECT
            TO_CHAR((COALESCE(s.ended_at, s.started_at, s.synced_at) AT TIME ZONE $${tzIdx})::date, 'YYYY-MM-DD') AS date,
            count(*)::int AS sessions,
            coalesce(sum(${EFF_IN}), 0)::bigint AS tokens_in,
            coalesce(sum(${EFF_OUT}), 0)::bigint AS tokens_out,
            coalesce(sum(s.tokens_cache_read), 0)::bigint AS tokens_cache,
            coalesce(sum(s.tokens_cache_write), 0)::bigint AS tokens_cache_write,
            coalesce(sum(s.api_cost), 0)::float AS api_cost,
            coalesce(sum(s.edits), 0)::int AS edits,
            coalesce(sum(s.additions), 0)::int AS additions,
            coalesce(sum(s.deletions), 0)::int AS deletions,
            coalesce(sum(s.tool_calls), 0)::int AS tool_calls
          FROM sync_sessions s
          WHERE s.member_id = $1 ${dateFilter}
          GROUP BY 1 ORDER BY 1
        `, params),

        // 3. Per-source breakdown (for scoreboard) — effective tokens
        query(`
          SELECT
            s.source,
            count(*)::int AS sessions,
            coalesce(sum(${EFF_IN}), 0)::bigint AS tokens_in,
            coalesce(sum(${EFF_OUT}), 0)::bigint AS tokens_out,
            coalesce(sum(s.tokens_cache_read), 0)::bigint AS tokens_cache_read,
            coalesce(sum(s.api_cost), 0)::float AS api_cost,
            coalesce(sum(s.edits), 0)::int AS edits,
            coalesce(sum(s.changed_lines), 0)::int AS changed_lines,
            coalesce(sum(s.tool_calls), 0)::int AS tool_calls,
            coalesce(sum(s.tool_errors), 0)::int AS tool_errors,
            coalesce(sum(s.rework_loops), 0)::int AS rework_loops,
            coalesce(sum(CASE WHEN s.abandoned THEN 1 ELSE 0 END), 0)::int AS abandoned,
            coalesce(sum(CASE WHEN s.priced THEN 1 ELSE 0 END), 0)::int AS priced_sessions
          FROM sync_sessions s
          WHERE s.member_id = $1 ${dateFilter}
          GROUP BY s.source ORDER BY sessions DESC
        `, params),

        // 4. Per-model breakdown — effective tokens
        query(`
          SELECT
            s.model,
            count(*)::int AS sessions,
            coalesce(sum(${EFF_IN} + ${EFF_OUT}), 0)::bigint AS tokens,
            coalesce(sum(s.api_cost), 0)::float AS api_cost
          FROM sync_sessions s
          WHERE s.member_id = $1 ${dateFilter} AND s.model IS NOT NULL
          GROUP BY s.model ORDER BY tokens DESC LIMIT 20
        `, params),

        // 5. Top tools (aggregated from sync_session_tools)
        query(`
          SELECT t.tool_name AS name, sum(t.call_count)::int AS count
          FROM sync_session_tools t
          JOIN sync_sessions s ON s.id = t.sync_session_id
          WHERE s.member_id = $1 ${dateFilter}
          GROUP BY t.tool_name ORDER BY count DESC LIMIT 20
        `, params),

        // 6. Hourly activity punch-card & velocity in user's timezone (weekday 0-6, hour 0-23)
        query(`
          SELECT
            EXTRACT(DOW FROM (COALESCE(s.ended_at, s.started_at, s.synced_at) AT TIME ZONE $${tzIdx}))::int AS weekday,
            EXTRACT(HOUR FROM (COALESCE(s.ended_at, s.started_at, s.synced_at) AT TIME ZONE $${tzIdx}))::int AS hour,
            count(*)::int AS n,
            coalesce(sum(${EFF_IN}), 0)::bigint AS tokens_in,
            coalesce(sum(${EFF_OUT}), 0)::bigint AS tokens_out,
            coalesce(sum(s.tokens_cache_read), 0)::bigint AS tokens_cache
          FROM sync_sessions s
          WHERE s.member_id = $1 ${dateFilter}
          GROUP BY 1, 2
        `, params),

        // 7. Top files (for impact map)
        query(`
          SELECT
            f.path,
            sum(f.edits)::int AS edits,
            sum(f.additions)::int AS additions,
            sum(f.deletions)::int AS deletions,
            sum(f.additions + f.deletions)::int AS changed_lines,
            count(DISTINCT s.id)::int AS sessions
          FROM sync_session_files f
          JOIN sync_sessions s ON s.id = f.sync_session_id
          WHERE (s.member_id = $1 OR s.team_id IN (SELECT tm.team_id FROM team_members tm WHERE tm.member_id = $1)) ${dateFilter}
          GROUP BY f.path ORDER BY changed_lines DESC, edits DESC LIMIT 50
        `, params),

        // 8. Project rollup (across projects/repos)
        query(`
          SELECT
            COALESCE(s.agent, 'default') AS project,
            count(s.id)::int AS sessions,
            coalesce(sum(${EFF_IN}), 0)::bigint AS tokens_in,
            coalesce(sum(${EFF_OUT}), 0)::bigint AS tokens_out,
            coalesce(sum(s.tokens_cache_read), 0)::bigint AS tokens_cache_read,
            coalesce(sum(s.api_cost), 0)::float AS api_cost,
            coalesce(sum(s.edits), 0)::int AS edits,
            coalesce(sum(s.changed_lines), 0)::int AS changed_lines
          FROM sync_sessions s
          WHERE (s.member_id = $1 OR s.team_id IN (SELECT tm.team_id FROM team_members tm WHERE tm.member_id = $1)) ${dateFilter}
          GROUP BY COALESCE(s.agent, 'default')
          ORDER BY api_cost DESC, sessions DESC
        `, params),
      ]);

      const totals = totalsRes.rows[0];
      const perDayRows = perDayRes.rows;
      const perSourceRows = perSourceRes.rows;
      const perModelRows = perModelRes.rows;
      const topToolRows = topToolsRes.rows;
      const perHourRows = perHourRes.rows;
      const topFileRows = topFilesRes.rows;
      const projectRollupRows = projectRollupRes.rows;

      // ── Build punch-card grid & hourly velocity ──────────────────────────────
      const punch: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
      const hourly = Array.from({ length: 24 }, (_, h) => ({
        hour: h,
        label: `${String(h).padStart(2, '0')}:00`,
        tokensIn: 0,
        tokensOut: 0,
        tokensCache: 0,
        sessions: 0,
      }));

      for (const r of perHourRows) {
        const w = Number(r.weekday);
        const h = Number(r.hour);
        if (w >= 0 && w < 7 && h >= 0 && h < 24) {
          punch[w][h] += Number(r.n);
        }
        if (h >= 0 && h < 24) {
          hourly[h].tokensIn += Number(r.tokens_in || 0);
          hourly[h].tokensOut += Number(r.tokens_out || 0);
          hourly[h].tokensCache += Number(r.tokens_cache || 0);
          hourly[h].sessions += Number(r.n || 0);
        }
      }

      // ── Build per-day series with date gap-filling ────────────────────────────
      const dayMap = new Map<string, any>();
      for (const r of perDayRows) {
        let k = '';
        if (r.date instanceof Date) {
          const y = r.date.getUTCFullYear();
          const m = String(r.date.getUTCMonth() + 1).padStart(2, '0');
          const d = String(r.date.getUTCDate()).padStart(2, '0');
          k = `${y}-${m}-${d}`;
        } else {
          k = String(r.date).slice(0, 10);
        }
        dayMap.set(k, {
          date: k,
          sessions: Number(r.sessions),
          tokensIn: Number(r.tokens_in),
          tokensOut: Number(r.tokens_out),
          tokensCache: Number(r.tokens_cache || 0),
          tokensCacheWrite: Number(r.tokens_cache_write || 0),
          apiCost: Number(r.api_cost),
          edits: Number(r.edits),
          additions: Number(r.additions),
          deletions: Number(r.deletions),
          toolCalls: Number(r.tool_calls),
        });
      }

      // Build series with gap-fill between from/to (or first/last record)
      const allKeys = [...dayMap.keys()].sort();
      const seriesFrom = from || (allKeys[0] ?? new Date().toISOString().slice(0, 10));
      const seriesTo = to || (allKeys[allKeys.length - 1] ?? new Date().toISOString().slice(0, 10));
      const series: any[] = [];
      {
        const [fy, fm, fd] = seriesFrom.split('-').map(Number);
        const [ty, tm, td] = seriesTo.split('-').map(Number);
        const cur = new Date(Date.UTC(fy, (fm || 1) - 1, fd || 1));
        const end = new Date(Date.UTC(ty, (tm || 1) - 1, td || 1));
        while (cur <= end) {
          const y = cur.getUTCFullYear();
          const m = String(cur.getUTCMonth() + 1).padStart(2, '0');
          const d = String(cur.getUTCDate()).padStart(2, '0');
          const k = `${y}-${m}-${d}`;
          series.push(dayMap.get(k) ?? {
            date: k, sessions: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0,
            tokensCacheWrite: 0, apiCost: 0, edits: 0, additions: 0, deletions: 0, toolCalls: 0,
          });
          cur.setUTCDate(cur.getUTCDate() + 1);
        }
      }

      // ── Records ──────────────────────────────────────────────────────────────
      let peak = { weekday: 0, hour: 0, n: 0 };
      for (let w = 0; w < 7; w++) for (let h = 0; h < 24; h++) if (punch[w][h] > peak.n) peak = { weekday: w, hour: h, n: punch[w][h] };
      const activeDays = series.filter((d) => d.toolCalls > 0 || d.sessions > 0).length;
      let streak = 0;
      for (let i = series.length - 1; i >= 0 && (series[i].toolCalls > 0 || series[i].sessions > 0); i--) streak++;
      const busiestDay = series.reduce((m: any, d) => (d.toolCalls > (m?.toolCalls || 0) ? d : m), null);

      // ── Impact map ───────────────────────────────────────────────────────────
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

      // Directory rollup
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

      // ── Cost & scoreboard per source ─────────────────────────────────────────
      const totalApiCost = perSourceRows.reduce((n: number, r: any) => n + Number(r.api_cost), 0);
      const totalPricedSessions = Number(totals?.priced_sessions ?? 0);
      const totalSessions = Number(totals?.sessions ?? 0);
      // Approximate cost for sessions missing actual token-based pricing:
      // use $3/M input + $15/M output as a conservative estimate (Claude Sonnet rates)
      const approxSessions = Number(totals?.approx_sessions ?? 0);
      const totalTokensIn = Number(totals?.tokens_in ?? 0);
      const totalTokensOut = Number(totals?.tokens_out ?? 0);
      const estimatedCost = totalApiCost > 0 ? totalApiCost
        : (totalTokensIn / 1_000_000) * 3.0 + (totalTokensOut / 1_000_000) * 15.0;

      // Scoreboard (per-source metrics)
      const scoreboard = perSourceRows.map((r: any) => {
        const sessions = Number(r.sessions);
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
          sessions,
          edits,
          reworkPerSession: sessions ? reworkLoops / sessions : 0,
          abandonedRate: sessions ? abandoned / sessions : 0,
          medianTimeToFirstEditMs: null,
          editsPerSession: sessions ? edits / sessions : null,
          outputTokensPerEdit: edits ? tokensOut / edits : null,
          toolErrorRate: toolCalls ? toolErrors / toolCalls : null,
          medianToolLatencyMs: null,
          cacheEfficiency: tokensIn ? tokensCacheRead / tokensIn : null,
          costPerEdit: pricedSessions && edits ? apiCost / edits : null,
          costPer100Lines: pricedSessions && changedLines ? apiCost / changedLines * 100 : null,
        };
      });

      // Cost breakdown by source
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
      const pricedEdits = perSourceRows
        .filter((r: any) => Number(r.priced_sessions) > 0)
        .reduce((n: number, r: any) => n + Number(r.edits), 0);
      const totalEdits = Number(totals?.edits ?? 0);

      // ── Assemble final response matching buildStats() shape ──────────────────
      const result = {
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

        impact: {
          files: fileRows,
          directories: directoryRows,
          churnFiles,
        },

        scoreboard,

        perDay: series,

        hourly,

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

        projectRollup: projectRollupRows.map((r: any) => ({
          project: r.project,
          name: r.project,
          sessions: Number(r.sessions),
          tokens_in: Number(r.tokens_in),
          tokens_out: Number(r.tokens_out),
          tokens: Number(r.tokens_in) + Number(r.tokens_out),
          tokens_cache_read: Number(r.tokens_cache_read || 0),
          api_cost: Number(r.api_cost),
          edits: Number(r.edits),
          changed_lines: Number(r.changed_lines),
        })),

        topFiles: fileRows,

        records: {
          longestSession: null,
          busiestDay: busiestDay && busiestDay.toolCalls > 0 ? busiestDay : null,
          peakHour: peak.n ? peak : null,
          activeDays,
          streak,
        },
      };

      return NextResponse.json(result, {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
          'Pragma': 'no-cache',
          'Expires': '0',
        },
      });
  } catch (err) {
    console.error('[stats GET error]', err);
    return NextResponse.json({ error: String(err) }, {
      status: 500,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  }
}
