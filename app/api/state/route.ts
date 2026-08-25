/**
 * Personal dashboard state endpoint — DB-backed.
 * GET /api/state?from=YYYY-MM-DD&to=YYYY-MM-DD&source=cursor&all=1
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/auth';
import { getDocById, queryCol } from '@/lib/team/db';
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
    const userDoc = await getDocById('users', session.userId);
    if (userDoc?.member_id) memberId = userDoc.member_id;
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

    // If running locally without Firebase, try to read from local filesystem first
    if (process.env.VERCEL !== '1' && !process.env.FIREBASE_PROJECT_ID) {
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

          const counts: Record<string, number> = {};
          for (const s of filtered as any[]) counts[s.source] = (counts[s.source] || 0) + 1;
          
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
            roots, counts,
            from: from ?? null, to: to ?? null, all: useAll,
            generatedAt: new Date().toISOString(),
            sessions: sessionRows, sessionCount: filtered.length,
          });
        }
      } catch (err) {
        console.warn('Local state scan fallback failed:', err);
      }
    }

    // Fetch sessions from Firestore
    const constraints: Parameters<typeof queryCol>[1] = [
      { type: 'where', field: 'member_id', op: '==', value: memberId },
      { type: 'orderBy', field: 'synced_at', direction: 'desc' },
      { type: 'limit', n: 500 },
    ];
    if (src && src !== 'all') constraints.push({ type: 'where', field: 'source', op: '==', value: src });

    const allSessionDocs = await queryCol<any>('sync_sessions', [
      { type: 'where', field: 'member_id', op: '==', value: memberId },
    ]);

    const sessions = (useAll ? allSessionDocs : allSessionDocs.filter((s: any) => {
      const ts = s.ended_at || s.started_at || s.synced_at;
      if (!ts) return false;
      const dateStr = String(ts).slice(0, 10);
      if (from && dateStr < from) return false;
      if (to && dateStr > to) return false;
      return true;
    })).filter((s: any) => !src || src === 'all' || s.source === src)
      .sort((a: any, b: any) => {
        const ta = a.ended_at || a.started_at || a.synced_at || '';
        const tb = b.ended_at || b.started_at || b.synced_at || '';
        return tb.localeCompare(ta);
      })
      .slice(0, 500);

    const counts: Record<string, number> = {};
    for (const s of sessions) counts[s.source] = (counts[s.source] || 0) + 1;

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
        edits: s.edits, additions: s.additions, deletions: s.deletions,
        changedLines: s.changed_lines, filesTouched: s.files_touched,
        toolCalls: s.tool_calls, toolErrors: s.tool_errors,
        reworkLoops: s.rework_loops, corrections: s.corrections,
        abandoned: s.abandoned, apiCost: s.api_cost,
      },
      stats: {
        tokensIn: Number(s.tokens_in), tokensOut: Number(s.tokens_out),
        tokensCacheRead: Number(s.tokens_cache_read),
        tokensCacheWrite: Number(s.tokens_cache_write),
        toolCounts: {}, errors: s.tool_errors || 0,
      },
      children: [],
      parent: null,
    }));

    return NextResponse.json({
      roots: [`DB: ${session.displayName}`],
      counts, from: from ?? null, to: to ?? null, all: useAll,
      generatedAt: new Date().toISOString(),
      sessions: sessionRows, sessionCount: sessions.length,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
