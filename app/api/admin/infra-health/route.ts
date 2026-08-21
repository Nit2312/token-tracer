/**
 * GET /api/admin/infra-health
 * Superadmin-only endpoint for monitoring database compute, storage limits (Neon 500MB),
 * serverless invocation estimates (Vercel 100k/day), cache efficiency, and daemon version migration.
 */
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSessionFromCookie } from '@/lib/auth';
import { query } from '@/lib/team/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  // ── Auth: superadmin only ─────────────────────────────────────────────────
  const cookieStore = await cookies();
  const session = getSessionFromCookie(cookieStore.toString());
  if (!session || session.role !== 'superadmin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const [
      dbSizeRes,
      tableSizesRes,
      cacheHitRes,
      connectionsRes,
      ingestStatsRes,
      hourlyIngestRes,
      daemonVersionsRes,
      retentionStatusRes,
    ] = await Promise.all([
      // 1. Total database storage in bytes
      query(`
        SELECT
          pg_database_size(current_database())::bigint AS total_bytes,
          pg_size_pretty(pg_database_size(current_database())) AS pretty_size
      `).catch(() => ({ rows: [{ total_bytes: 0, pretty_size: '0 MB' }] })),

      // 2. Table storage breakdown (top 15 tables by size)
      query(`
        SELECT
          relname AS table_name,
          pg_total_relation_size(relid)::bigint AS total_bytes,
          pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
          pg_size_pretty(pg_relation_size(relid)) AS table_size,
          pg_size_pretty(pg_total_relation_size(relid) - pg_relation_size(relid)) AS index_size,
          COALESCE(n_live_tup, 0)::bigint AS row_estimate
        FROM pg_stat_user_tables
        ORDER BY pg_total_relation_size(relid) DESC
        LIMIT 15
      `).catch(() => ({ rows: [] })),

      // 3. Buffer cache hit ratio
      query(`
        SELECT
          COALESCE(
            ROUND(
              (sum(heap_blks_hit)::numeric / NULLIF(sum(heap_blks_hit) + sum(heap_blks_read), 0)::numeric) * 100,
              2
            ),
            100.00
          )::float AS cache_hit_ratio
        FROM pg_statio_user_tables
      `).catch(() => ({ rows: [{ cache_hit_ratio: 100.0 }] })),

      // 4. Active connections
      query(`
        SELECT count(*)::int AS active_connections
        FROM pg_stat_activity
        WHERE state = 'active'
      `).catch(() => ({ rows: [{ active_connections: 1 }] })),

      // 5. Ingestion volume today and yesterday
      query(`
        SELECT
          COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)::int AS batches_today,
          COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - 1 AND created_at < CURRENT_DATE)::int AS batches_yesterday,
          COALESCE(SUM(session_count) FILTER (WHERE created_at >= CURRENT_DATE), 0)::int AS sessions_today,
          COALESCE(SUM(session_count) FILTER (WHERE created_at >= CURRENT_DATE - 1 AND created_at < CURRENT_DATE), 0)::int AS sessions_yesterday
        FROM ingest_events
      `).catch(() => ({ rows: [{ batches_today: 0, batches_yesterday: 0, sessions_today: 0, sessions_yesterday: 0 }] })),

      // 6. Hourly ingestion distribution over last 24h (traffic leveling check)
      query(`
        SELECT
          EXTRACT(HOUR FROM created_at)::int AS hour,
          COUNT(*)::int AS batch_count,
          COALESCE(SUM(session_count), 0)::int AS session_count
        FROM ingest_events
        WHERE created_at >= NOW() - INTERVAL '24 hours'
        GROUP BY 1
        ORDER BY 1 ASC
      `).catch(() => ({ rows: [] })),

      // 7. Active daemon version distribution
      query(`
        SELECT
          COALESCE(NULLIF(daemon_version, ''), 'untracked') AS version,
          COUNT(*)::int AS member_count,
          COUNT(*) FILTER (WHERE daemon_last_seen_at >= NOW() - INTERVAL '7 days')::int AS active_count
        FROM members
        GROUP BY 1
        ORDER BY member_count DESC
      `).catch(() => ({ rows: [] })),

      // 8. Retention & Pruning status
      query(`
        SELECT
          COUNT(*) FILTER (WHERE events IS NOT NULL AND synced_at < NOW() - INTERVAL '7 days')::int AS unpruned_events_count,
          MIN(synced_at) AS oldest_session_date,
          COUNT(*)::int AS total_sessions_in_db
        FROM sync_sessions
      `).catch(() => ({ rows: [{ unpruned_events_count: 0, oldest_session_date: null, total_sessions_in_db: 0 }] })),
    ]);

    const totalBytes = Number(dbSizeRes.rows[0]?.total_bytes || 0);
    const prettyDbSize = dbSizeRes.rows[0]?.pretty_size || '0 MB';
    const NEON_FREE_STORAGE_BYTES = 500 * 1024 * 1024; // 500 MB limit
    const storageUsedPct = Math.min(100, Math.round((totalBytes / NEON_FREE_STORAGE_BYTES) * 1000) / 10);

    const ingestStats = ingestStatsRes.rows[0] || { batches_today: 0, batches_yesterday: 0, sessions_today: 0, sessions_yesterday: 0 };
    const batchesToday = Number(ingestStats.batches_today || 0);
    
    // Estimate daily invocations: daemon syncs + estimated dashboard requests
    const estimatedDailyInvocations = batchesToday + Math.round(batchesToday * 0.2) + 500;
    const VERCEL_FREE_INVOCATIONS_LIMIT = 100000;
    const invocationsUsedPct = Math.min(100, Math.round((estimatedDailyInvocations / VERCEL_FREE_INVOCATIONS_LIMIT) * 1000) / 10);

    const cacheHitRatio = Number(cacheHitRes.rows[0]?.cache_hit_ratio || 100);
    const activeConnections = Number(connectionsRes.rows[0]?.active_connections || 1);

    const daemonVersions = daemonVersionsRes.rows;
    const totalMembers = daemonVersions.reduce((sum: number, r: any) => sum + Number(r.member_count), 0);
    const v130Members = Number(daemonVersions.find((r: any) => r.version === '1.3.0')?.member_count || 0);
    const v130RolloutPct = totalMembers > 0 ? Math.round((v130Members / totalMembers) * 1000) / 10 : 0;

    const retention = retentionStatusRes.rows[0] || { unpruned_events_count: 0, oldest_session_date: null, total_sessions_in_db: 0 };

    return NextResponse.json({
      timestamp: new Date().toISOString(),
      limits: {
        neonStorage: {
          usedBytes: totalBytes,
          prettySize: prettyDbSize,
          limitBytes: NEON_FREE_STORAGE_BYTES,
          limitPretty: '500 MB',
          usedPct: storageUsedPct,
          status: storageUsedPct >= 85 ? 'critical' : storageUsedPct >= 70 ? 'warning' : 'healthy',
        },
        vercelInvocations: {
          estimatedToday: estimatedDailyInvocations,
          batchesToday,
          sessionsToday: Number(ingestStats.sessions_today || 0),
          limit: VERCEL_FREE_INVOCATIONS_LIMIT,
          usedPct: invocationsUsedPct,
          status: invocationsUsedPct >= 85 ? 'critical' : invocationsUsedPct >= 70 ? 'warning' : 'healthy',
        },
        cacheEfficiency: {
          hitRatio: cacheHitRatio,
          status: cacheHitRatio >= 95 ? 'excellent' : cacheHitRatio >= 85 ? 'good' : 'warning',
        },
        activeConnections: {
          count: activeConnections,
          status: activeConnections <= 10 ? 'healthy' : 'elevated',
        },
      },
      daemonRollout: {
        totalMembers,
        v130Count: v130Members,
        v130Pct: v130RolloutPct,
        breakdown: daemonVersions,
      },
      tableStorage: tableSizesRes.rows,
      hourlyTraffic: hourlyIngestRes.rows,
      retentionStatus: {
        unprunedEventsCount: Number(retention.unpruned_events_count || 0),
        oldestSessionDate: retention.oldest_session_date,
        totalSessionsInDb: Number(retention.total_sessions_in_db || 0),
      },
    });
  } catch (err) {
    console.error('[infra-health error]', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
