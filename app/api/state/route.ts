/**
 * Personal dashboard state endpoint — DB-backed.
 * GET /api/state?from=YYYY-MM-DD&to=YYYY-MM-DD&source=cursor&all=1
 *
 * Requires valid app_session cookie. Returns session list for the logged-in member.
 * Falls back to local filesystem scan if no session (backward compat for local-only mode).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/auth';
import { query } from '@/lib/team/db';
import { normalizeDateParam } from '@/lib/analytics.mjs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const session = getSessionFromCookie(req.headers.get('cookie'));
  if (!session) {
    return NextResponse.json({ error: 'not authenticated', redirect: '/login' }, { status: 401 });
  }

  if (session.role !== 'user') {
    return NextResponse.json({ error: 'personal dashboard is for regular users only' }, { status: 403 });
  }

  let memberId = session.memberId;
  try {
    const { rows: userRows } = await query('SELECT member_id FROM users WHERE id = $1', [session.userId]);
    if (userRows[0]?.member_id) {
      memberId = userRows[0].member_id;
    }
  } catch (err) {
    console.warn('[state route member lookup failed]', err);
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

    // If running locally without a database, try to read from local filesystem first
    if (process.env.VERCEL !== '1' && !process.env.DATABASE_URL && !process.env.NEON_CONNECTION_STRING) {

      try {
        const { scanSessions } = await import('@/lib/scan.mjs');
        const { roots, sessions: localSessions } = scanSessions({ sources: src ? [src] : null });
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

          // Count per source
          const counts: Record<string, number> = {};
          for (const s of filtered as any[]) counts[s.source] = (counts[s.source] || 0) + 1;
          
          // Map to expected shape
          const sessionRows = filtered.map((s: any) => ({
            id: s.id,
            source: s.source,
            agent: s.agent || 'unknown',
            label: s.label || s.title || '(local session)',
            model: s.model,
            startedAt: s.startedAt || s.started_at,
            endedAt: s.endedAt || s.ended_at,
            eventCount: s.events?.length || 0,
            intelligence: s.intelligence || {},
            stats: s.stats || {},
            children: s.children || [],
            parent: s.parent || null,
          }));

          return NextResponse.json({
            roots,
            counts,
            from: from ?? null,
            to: to ?? null,
            all: useAll,
            generatedAt: new Date().toISOString(),
            sessions: sessionRows,
            sessionCount: filtered.length,
          });
        }
      } catch (err) {
        console.warn('Local state scan fallback failed:', err);
      }
    }

    const params: unknown[] = [memberId];
    // BUG-10 fix: add timezone handling (matching the stats route pattern)
    const tzParam = url.searchParams.get('tz') || 'UTC';
    let validTz = 'UTC';
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tzParam });
      validTz = tzParam;
    } catch {
      validTz = 'UTC';
    }
    params.push(validTz); // $2
    const tzIdx = 2;
    let dateFilter = '';
    if (!useAll) {
      if (from) { params.push(from); dateFilter += ` AND (COALESCE(s.ended_at, s.started_at, s.synced_at) AT TIME ZONE $${tzIdx})::date >= ($${params.length}::text)::date`; }
      if (to)   { params.push(to);   dateFilter += ` AND (COALESCE(s.ended_at, s.started_at, s.synced_at) AT TIME ZONE $${tzIdx})::date <= ($${params.length}::text)::date`; }
    }
    if (src && src !== 'all') { params.push(src); dateFilter += ` AND s.source = $${params.length}`; }

    const { rows: sessions } = await query(`
      SELECT s.id, s.session_id, s.source, s.agent, s.label, s.model,
             s.started_at, s.ended_at, s.synced_at,
             s.tokens_in, s.tokens_out, s.tokens_cache_read, s.tokens_cache_write,
             s.api_cost, s.edits, s.additions, s.deletions, s.changed_lines,
             s.files_touched, s.tool_calls, s.tool_errors, s.rework_loops,
             s.corrections, s.abandoned
      FROM sync_sessions s
      WHERE s.member_id = $1 ${dateFilter}
      ORDER BY COALESCE(s.ended_at, s.started_at, s.synced_at) DESC
      LIMIT 500
    `, params);

    // Count per source
    const counts: Record<string, number> = {};
    for (const s of sessions) counts[s.source] = (counts[s.source] || 0) + 1;

    // Map to shape expected by app.js (sessionSummary-compatible)
    const sessionRows = sessions.map((s: any) => ({
      id: s.session_id || s.id,
      source: s.source,
      agent: s.agent || 'unknown',
      label: s.label || '(synced session)',
      model: s.model,
      startedAt: s.started_at,
      endedAt: s.ended_at,
      eventCount: s.tool_calls + (s.edits || 0),
      intelligence: {
        edits: s.edits,
        additions: s.additions,
        deletions: s.deletions,
        changedLines: s.changed_lines,
        filesTouched: s.files_touched,
        toolCalls: s.tool_calls,
        toolErrors: s.tool_errors,
        reworkLoops: s.rework_loops,
        corrections: s.corrections,
        abandoned: s.abandoned,
        apiCost: s.api_cost,
      },
      stats: {
        tokensIn: Number(s.tokens_in),
        tokensOut: Number(s.tokens_out),
        tokensCacheRead: Number(s.tokens_cache_read),
        tokensCacheWrite: Number(s.tokens_cache_write),
        toolCounts: {},
        errors: s.tool_errors || 0,
      },
      children: [],
      parent: null,
    }));

    return NextResponse.json({
      roots: [`DB: ${session.displayName}`],
      counts,
      from: from ?? null,
      to: to ?? null,
      all: useAll,
      generatedAt: new Date().toISOString(),
      sessions: sessionRows,
      sessionCount: sessions.length,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
