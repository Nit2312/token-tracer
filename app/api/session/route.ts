/**
 * Personal session detail endpoint — DB-backed.
 * GET /api/session?id=<sessionId>
 *
 * Returns aggregated stats for a single session. Since DB doesn't store
 * individual events, this returns the summary + tool/file breakdowns.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/auth';
import { getDocById, queryCol } from '@/lib/team/db';

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
    const userDoc = await getDocById('users', appSession.userId);
    if (userDoc?.member_id) {
      memberId = userDoc.member_id;
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
    if (process.env.VERCEL !== '1' && !process.env.FIREBASE_PROJECT_ID) {
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

    // Look up by session_id OR document ID, scoped to this member
    let sessionDocs = await queryCol<any>('sync_sessions', [
      { type: 'where', field: 'member_id', op: '==', value: memberId },
      { type: 'where', field: 'session_id', op: '==', value: sessionId },
      { type: 'limit', n: 1 },
    ]);

    if (!sessionDocs.length) {
      const docById = await getDocById('sync_sessions', sessionId);
      if (docById && docById.member_id === memberId) {
        sessionDocs = [docById];
      }
    }

    const row = sessionDocs[0];
    if (!row) {
      return NextResponse.json({ error: 'session not found' }, { status: 404 });
    }

    // Fetch tool and file breakdowns in parallel
    const [tools, files] = await Promise.all([
      queryCol<any>('sync_session_tools', [
        { type: 'where', field: 'sync_session_id', op: '==', value: row.id },
      ]),
      queryCol<any>('sync_session_files', [
        { type: 'where', field: 'sync_session_id', op: '==', value: row.id },
      ]),
    ]);

    tools.sort((a, b) => (b.call_count || 0) - (a.call_count || 0));
    files.sort((a, b) => (b.edits || 0) - (a.edits || 0));

    return NextResponse.json({
      id: row.session_id || row.id,
      source: row.source,
      agent: row.agent,
      label: row.label,
      model: row.model,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      syncedAt: row.synced_at,
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
        timeToFirstEditMs: null,
        medianToolLatencyMs: null,
      },
      stats: {
        tokensIn: Number(row.tokens_in || 0),
        tokensOut: Number(row.tokens_out || 0),
        tokensCacheRead: Number(row.tokens_cache_read || 0),
        tokensCacheWrite: Number(row.tokens_cache_write || 0),
        toolCounts: {},
        errors: row.tool_errors || 0,
      },
      tools: tools.map(t => ({ tool_name: t.tool_name, call_count: t.call_count })),
      files: files.map(f => ({ path: f.path, edits: f.edits, additions: f.additions, deletions: f.deletions })),
      events: row.events || [],
    });
  } catch (err) {
    console.error('[session GET error]', err);
    return NextResponse.json({ error: String((err as Error).message || err) }, { status: 500 });
  }
}
