/**
 * Personal session detail endpoint — DB-backed.
 * GET /api/session?id=<sessionId>
 *
 * Returns aggregated stats for a single session. Since DB doesn't store
 * individual events, this returns the summary + tool/file breakdowns.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/auth';
import { query } from '@/lib/team/db';
import { publicError } from '@/lib/security/errors';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const appSession = getSessionFromCookie(req.headers.get('cookie'));
  if (!appSession) {
    return NextResponse.json({ error: 'not authenticated', redirect: '/login' }, { status: 401 });
  }

  if (appSession.role !== 'user') {
    return NextResponse.json({ error: 'personal dashboard is for regular users only' }, { status: 403 });
  }

  let memberId = appSession.memberId;
  try {
    const { rows: userRows } = await query('SELECT member_id FROM users WHERE id = $1', [appSession.userId]);
    if (userRows[0]?.member_id) {
      memberId = userRows[0].member_id;
    }
  } catch (err) {
    console.warn('[session route member lookup failed]', err);
  }

  if (!memberId) {
    return NextResponse.json({ error: 'user account is not linked to any member profile' }, { status: 403 });
  }

  try {
    const sessionId = (req.nextUrl.searchParams.get('id') || '').toLowerCase();
    if (!sessionId) {
      return NextResponse.json({ error: 'id parameter is required' }, { status: 400 });
    }

    // If running locally without a database, try to read from the local files first to get prompts and events!
    if (process.env.VERCEL !== '1' && !process.env.DATABASE_URL && !process.env.NEON_CONNECTION_STRING) {

      try {
        const { scanSessions } = await import('@/lib/scan.mjs');
        const { sessionSummary } = await import('@/lib/analytics.mjs');
        const pricingData = (await import('@/lib/pricing.json')).default;
        
        const { byId } = scanSessions({});
        const localSession = byId.get(sessionId);
        if (localSession) {
          return NextResponse.json(sessionSummary(localSession, pricingData, true));
        }
      } catch (err) {
        console.warn('[local session scan failed, falling back to DB]', err);
      }
    }

    // Look up by session_id OR the UUID id column, scoped to this member
    const { rows: [row] } = await query(`
      SELECT s.*
      FROM sync_sessions s
      WHERE s.member_id = $1
        AND (lower(s.session_id) = $2 OR lower(s.id::text) = $2)
      LIMIT 1
    `, [memberId, sessionId]);

    if (!row) {
      return NextResponse.json({ error: 'session not found' }, { status: 404 });
    }

    // Fetch tool and file breakdowns in parallel
    const [toolsRes, filesRes] = await Promise.all([
      query(`
        SELECT tool_name, call_count
        FROM sync_session_tools
        WHERE sync_session_id = $1
        ORDER BY call_count DESC
      `, [row.id]),
      query(`
        SELECT path, edits, additions, deletions
        FROM sync_session_files
        WHERE sync_session_id = $1
        ORDER BY edits DESC
      `, [row.id]),
    ]);

    return NextResponse.json({
      id: row.session_id || row.id,
      source: row.source,
      agent: row.agent,
      label: row.label,
      model: row.model,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      syncedAt: row.synced_at,
      // parent/children: not stored in DB schema — safe defaults for app.js renderTrajectory
      parent: null,
      children: [],
      intelligence: {
        edits: row.edits,
        additions: row.additions,
        deletions: row.deletions,
        changedLines: row.changed_lines,
        filesTouched: row.files_touched,
        toolCalls: row.tool_calls,
        toolErrors: row.tool_errors,
        reworkLoops: row.rework_loops,
        corrections: row.corrections,
        abandoned: row.abandoned,
        apiCost: row.api_cost,
        // Not available from DB — return null so app.js renders '—'
        timeToFirstEditMs: null,
        medianToolLatencyMs: null,
      },
      stats: {
        tokensIn: Number(row.tokens_in),
        tokensOut: Number(row.tokens_out),
        tokensCacheRead: Number(row.tokens_cache_read),
        tokensCacheWrite: Number(row.tokens_cache_write),
        toolCounts: {},
        errors: row.tool_errors || 0,
      },
      tools: toolsRes.rows,
      files: filesRes.rows,
      events: row.events || [], // Returned from the newly synced DB column
    });
  } catch (err) {
    return NextResponse.json({ error: publicError(err) }, { status: 500 });
  }
}
