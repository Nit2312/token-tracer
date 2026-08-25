/**
 * GET /api/admin/pipeline-health?range=7d
 * Superadmin-only. Reads directly from the collections daemons write to.
 */
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSessionFromCookie } from '@/lib/auth';
import { queryCol, getCachedCollection } from '@/lib/team/db';
import { statsCache } from '@/lib/team/cache';

export const dynamic = 'force-dynamic';

function parseDays(range: string | null): number {
  if (!range) return 7;
  const m = range.match(/^(\d+)d$/);
  return m ? Math.min(Math.max(1, Number(m[1])), 90) : 7;
}

export async function GET(req: NextRequest) {
  const cookieStore = await cookies();
  const session = getSessionFromCookie(cookieStore.toString());
  if (!session || session.role !== 'superadmin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const days = parseDays(req.nextUrl.searchParams.get('range'));
  const cacheKey = `admin_pipeline_health_${days}`;
  const responseData = await statsCache.getOrSet(cacheKey, 90, async () => {
    const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();
    const cutoffDate = cutoff.slice(0, 10);
    const now = Date.now();
    const h24Ago = new Date(now - 24 * 3600 * 1000).toISOString();

    const [members, teams, events, sessions, releases] = await Promise.all([
      getCachedCollection<any>('members', [], 300),
      getCachedCollection<any>('teams', [], 300),
      getCachedCollection<any>('ingest_events', [], 120),
      queryCol<any>('sync_sessions'),
      getCachedCollection<any>('daemon_releases', [
        { type: 'where', field: 'active', op: '==', value: true },
        { type: 'orderBy', field: 'released_at', direction: 'desc' },
        { type: 'limit', n: 1 },
      ], 300),
    ]);

  const teamById = new Map(teams.map((t: any) => [t.id, t]));

  // Events by member
  const eventsByMember = new Map<string, any[]>();
  for (const e of events) {
    if (!e.member_id) continue;
    if (!eventsByMember.has(e.member_id)) eventsByMember.set(e.member_id, []);
    eventsByMember.get(e.member_id)!.push(e);
  }

  // Sessions in window by member
  const lagSumsByMember = new Map<string, { totalLag: number; count: number }>();
  for (const s of sessions) {
    if (!s.member_id || !s.synced_at) continue;
    if (s.synced_at < cutoff) continue;
    const endTs = s.ended_at || s.started_at;
    if (endTs && s.synced_at > endTs) {
      const lag = (new Date(s.synced_at).getTime() - new Date(endTs).getTime()) / 1000;
      if (lag > 0) {
        if (!lagSumsByMember.has(s.member_id)) lagSumsByMember.set(s.member_id, { totalLag: 0, count: 0 });
        const entry = lagSumsByMember.get(s.member_id)!;
        entry.totalLag += lag;
        entry.count += 1;
      }
    }
  }

  // 1. Daemon health
  const daemonRows = members.map((m: any) => {
    const org = m.team_id ? teamById.get(m.team_id) : null;
    const mEvents = eventsByMember.get(m.id) || [];
    
    let lastHeartbeat: string | null = null;
    let batchesReceived = 0;
    let batchesFailed = 0;

    for (const e of mEvents) {
      if (e.created_at && (!lastHeartbeat || e.created_at > lastHeartbeat)) {
        lastHeartbeat = e.created_at;
      }
      if (e.created_at && e.created_at >= cutoff) {
        if (e.status === 'ok') {
          batchesReceived += 1;
        } else {
          batchesFailed += 1;
        }
      }
    }

    const lagData = lagSumsByMember.get(m.id);
    const avgLag = lagData && lagData.count > 0 ? Math.round(lagData.totalLag / lagData.count) : 0;

    return {
      daemon_id: m.id,
      daemon_name: m.display_name,
      daemon_version: m.daemon_version || null,
      org_id: org?.id || null,
      org_name: org?.name || 'Independent',
      last_heartbeat: lastHeartbeat,
      batches_received: batchesReceived,
      batches_failed: batchesFailed,
      avg_ingestion_lag_seconds: avgLag,
    };
  }).sort((a, b) => {
    if (!a.last_heartbeat) return 1;
    if (!b.last_heartbeat) return -1;
    return b.last_heartbeat.localeCompare(a.last_heartbeat);
  });

  // 2. Ingestion lag trend
  const lagTrendMap = new Map<string, { totalLag: number; count: number }>();
  for (const s of sessions) {
    if (!s.synced_at) continue;
    const day = String(s.synced_at).slice(0, 10);
    if (day < cutoffDate) continue;
    const endTs = s.ended_at || s.started_at;
    if (endTs && s.synced_at > endTs) {
      const lag = (new Date(s.synced_at).getTime() - new Date(endTs).getTime()) / 1000;
      if (lag > 0) {
        if (!lagTrendMap.has(day)) lagTrendMap.set(day, { totalLag: 0, count: 0 });
        const entry = lagTrendMap.get(day)!;
        entry.totalLag += lag;
        entry.count += 1;
      }
    }
  }
  const lagTrend = Array.from(lagTrendMap.entries())
    .map(([day, { totalLag, count }]) => ({
      day,
      avg_lag_seconds: count > 0 ? Math.round(totalLag / count) : 0,
    }))
    .sort((a, b) => a.day.localeCompare(b.day));

  // 3. Failure rate per daemon
  const failureRows = members
    .map((m: any) => {
      const mEvents = (eventsByMember.get(m.id) || []).filter((e) => e.created_at && e.created_at >= cutoff);
      if (mEvents.length === 0) return null;
      let totalReceived = 0;
      let totalFailed = 0;
      for (const e of mEvents) {
        if (e.status === 'ok') totalReceived += 1;
        else totalFailed += 1;
      }
      const total = totalReceived + totalFailed;
      const rate = total > 0 ? Number(((totalFailed / total) * 100).toFixed(2)) : 0;
      return {
        daemon_id: m.id,
        daemon_name: m.display_name,
        total_received: totalReceived,
        total_failed: totalFailed,
        failure_rate_pct: rate,
      };
    })
    .filter(Boolean)
    .sort((a: any, b: any) => b.failure_rate_pct - a.failure_rate_pct);

  // 4. Active vs total daemons
  const active24hSet = new Set<string>();
  for (const e of events) {
    if (e.member_id && e.created_at && e.created_at >= h24Ago) {
      active24hSet.add(e.member_id);
    }
  }

  const latestReleaseVersion = releases[0]?.version || null;

    return {
      range_days: days,
      daemons: daemonRows,
      lag_trend: lagTrend,
      failure_rates: failureRows,
      schema: {
        table_count: 10,
        last_analyzed: null,
      },
      active_24h: active24hSet.size,
      total_known: members.length,
      latest_version: latestReleaseVersion,
    };
  });

  return NextResponse.json(responseData);
}
