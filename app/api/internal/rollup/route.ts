/**
 * Internal cron endpoint — nightly rollup.
 * Called by Vercel Cron (see vercel.json). Protected by CRON_SECRET.
 *
 * Aggregates raw session / ingest data into:
 *   - daily_org_usage        (cost + token totals per org/tool/model/day)
 *   - daily_pipeline_health  (ingest health per daemon/day)
 *   - daily_behavior_rollup  (rework loops + errors per org/tool/day)
 *
 * All upserts are ON CONFLICT DO UPDATE — safe to re-run for the same day.
 */
import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/team/db';
import { cronSecret } from '@/lib/team/env';
import { getSessionFromCookie } from '@/lib/auth';

function isCronAuthorized(req: NextRequest): boolean {
  const cookieHeader = req.headers.get('cookie') || '';
  const session = getSessionFromCookie(cookieHeader);
  if (session && session.role === 'superadmin') return true;

  const secret = cronSecret();
  if (!secret) return false; // CRON_SECRET not set → deny
  const auth = req.headers.get('authorization');
  if (auth === `Bearer ${secret}`) return true;
  // Also allow direct header for Vercel Cron
  const cronHeader = req.headers.get('x-cron-secret');
  return cronHeader === secret;
}

export async function POST(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return runRollup();
}

// Vercel Cron hits GET
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return runRollup();
}

async function runRollup(): Promise<NextResponse> {
  const startedAt = Date.now();
  const errors: string[] = [];

  // Ensure rollup tables exist
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS daily_member_usage (
        day DATE NOT NULL,
        team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT 'default',
        project TEXT NOT NULL DEFAULT 'default',
        tokens_in BIGINT DEFAULT 0,
        tokens_out BIGINT DEFAULT 0,
        cache_read_tokens BIGINT DEFAULT 0,
        cache_write_tokens BIGINT DEFAULT 0,
        api_cost DOUBLE PRECISION DEFAULT 0,
        edits INT DEFAULT 0,
        additions INT DEFAULT 0,
        deletions INT DEFAULT 0,
        changed_lines INT DEFAULT 0,
        files_touched INT DEFAULT 0,
        tool_calls INT DEFAULT 0,
        tool_errors INT DEFAULT 0,
        rework_loops INT DEFAULT 0,
        corrections INT DEFAULT 0,
        abandoned_count INT DEFAULT 0,
        session_count INT DEFAULT 0,
        PRIMARY KEY (day, team_id, member_id, source, model, project)
      );
      CREATE INDEX IF NOT EXISTS idx_daily_member_usage_team_day ON daily_member_usage(team_id, day DESC);
      CREATE INDEX IF NOT EXISTS idx_daily_member_usage_member_day ON daily_member_usage(member_id, day DESC);

      CREATE TABLE IF NOT EXISTS daily_member_tools (
        day DATE NOT NULL,
        team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        call_count INT DEFAULT 0,
        PRIMARY KEY (day, team_id, member_id, tool_name)
      );
      CREATE INDEX IF NOT EXISTS idx_daily_member_tools_team ON daily_member_tools(team_id, day DESC);

      CREATE TABLE IF NOT EXISTS daily_member_files (
        day DATE NOT NULL,
        team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        edits INT DEFAULT 0,
        additions INT DEFAULT 0,
        deletions INT DEFAULT 0,
        changed_lines INT DEFAULT 0,
        session_count INT DEFAULT 0,
        PRIMARY KEY (day, team_id, member_id, path)
      );
      CREATE INDEX IF NOT EXISTS idx_daily_member_files_team ON daily_member_files(team_id, day DESC);

      CREATE TABLE IF NOT EXISTS daily_punch_card (
        day DATE NOT NULL,
        team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        weekday INT NOT NULL,
        hour INT NOT NULL,
        session_count INT DEFAULT 0,
        PRIMARY KEY (day, team_id, member_id, weekday, hour)
      );
      CREATE INDEX IF NOT EXISTS idx_daily_punch_card_team ON daily_punch_card(team_id, day DESC);
    `);
  } catch (err) {
    errors.push(`schema_ensure: ${(err as Error).message}`);
  }

  // ── 1. daily_org_usage ────────────────────────────────────────────────────
  try {
    await query(`
      INSERT INTO daily_org_usage (day, org_id, tool, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        list_price_cost, actual_cost, session_count)
      SELECT
        COALESCE(s.ended_at, s.started_at, s.synced_at)::date AS day,
        s.team_id::text AS org_id,
        COALESCE(NULLIF(s.source, ''), 'unknown') AS tool,
        COALESCE(NULLIF(s.model, ''), 'unknown') AS model,
        SUM(s.tokens_in)           AS input_tokens,
        SUM(s.tokens_out)          AS output_tokens,
        SUM(s.tokens_cache_read)   AS cache_read_tokens,
        SUM(s.tokens_cache_write)  AS cache_write_tokens,
        SUM(COALESCE(s.api_cost, 0))::numeric(12,4) AS list_price_cost,
        SUM(COALESCE(s.api_cost, 0))::numeric(12,4) AS actual_cost,
        COUNT(*)::int AS session_count
      FROM sync_sessions s
      WHERE
        COALESCE(s.ended_at, s.started_at, s.synced_at) IS NOT NULL
        AND COALESCE(s.ended_at, s.started_at, s.synced_at)::date <= CURRENT_DATE
      GROUP BY 1, 2, 3, 4
      ON CONFLICT (day, org_id, tool, model) DO UPDATE SET
        input_tokens       = EXCLUDED.input_tokens,
        output_tokens      = EXCLUDED.output_tokens,
        cache_read_tokens  = EXCLUDED.cache_read_tokens,
        cache_write_tokens = EXCLUDED.cache_write_tokens,
        list_price_cost    = EXCLUDED.list_price_cost,
        actual_cost        = EXCLUDED.actual_cost,
        session_count      = EXCLUDED.session_count
    `);
  } catch (err) {
    errors.push(`daily_org_usage: ${(err as Error).message}`);
  }

  // ── 2. daily_pipeline_health ──────────────────────────────────────────────
  try {
    await query(`
      WITH daily_lag AS (
        SELECT
          s.synced_at::date AS day,
          s.member_id,
          AVG(EXTRACT(EPOCH FROM (s.synced_at - COALESCE(s.ended_at, s.started_at))))::int AS avg_lag
        FROM sync_sessions s
        WHERE s.ended_at IS NOT NULL AND s.synced_at::date <= CURRENT_DATE
        GROUP BY 1, 2
      )
      INSERT INTO daily_pipeline_health (day, daemon_id, org_id,
        last_heartbeat, batches_received, batches_failed,
        avg_ingestion_lag_seconds, parse_errors, sanitize_errors)
      SELECT
        ie.created_at::date                      AS day,
        ie.member_id::text                       AS daemon_id,
        COALESCE(MAX(ie.team_id::text), 'default') AS org_id,
        MAX(ie.created_at)                       AS last_heartbeat,
        COUNT(*) FILTER (WHERE ie.status = 'ok')::int         AS batches_received,
        COUNT(*) FILTER (WHERE ie.status != 'ok')::int        AS batches_failed,
        COALESCE(MAX(dl.avg_lag), 0)             AS avg_ingestion_lag_seconds,
        0                                        AS parse_errors,
        0                                        AS sanitize_errors
      FROM ingest_events ie
      LEFT JOIN daily_lag dl ON dl.member_id = ie.member_id AND dl.day = ie.created_at::date
      WHERE ie.created_at::date <= CURRENT_DATE AND ie.member_id IS NOT NULL
      GROUP BY ie.created_at::date, ie.member_id::text
      ON CONFLICT (day, daemon_id) DO UPDATE SET
        org_id                  = EXCLUDED.org_id,
        last_heartbeat          = EXCLUDED.last_heartbeat,
        batches_received        = EXCLUDED.batches_received,
        batches_failed          = EXCLUDED.batches_failed,
        avg_ingestion_lag_seconds = EXCLUDED.avg_ingestion_lag_seconds,
        parse_errors            = EXCLUDED.parse_errors,
        sanitize_errors         = EXCLUDED.sanitize_errors
    `);
  } catch (err) {
    errors.push(`daily_pipeline_health: ${(err as Error).message}`);
  }

  // ── 3. daily_behavior_rollup ──────────────────────────────────────────────
  try {
    await query(`
      INSERT INTO daily_behavior_rollup (day, org_id, tool,
        rework_loop_count, tool_error_count, total_turns)
      SELECT
        COALESCE(s.ended_at, s.started_at, s.synced_at)::date AS day,
        s.team_id::text AS org_id,
        COALESCE(NULLIF(s.source, ''), 'unknown') AS tool,
        SUM(s.rework_loops)::int   AS rework_loop_count,
        SUM(s.tool_errors)::int    AS tool_error_count,
        SUM(s.tool_calls)::int     AS total_turns
      FROM sync_sessions s
      WHERE
        COALESCE(s.ended_at, s.started_at, s.synced_at) IS NOT NULL
        AND COALESCE(s.ended_at, s.started_at, s.synced_at)::date <= CURRENT_DATE
      GROUP BY 1, 2, 3
      ON CONFLICT (day, org_id, tool) DO UPDATE SET
        rework_loop_count = EXCLUDED.rework_loop_count,
        tool_error_count  = EXCLUDED.tool_error_count,
        total_turns       = EXCLUDED.total_turns
    `);
  } catch (err) {
    errors.push(`daily_behavior_rollup: ${(err as Error).message}`);
  }

  // ── 3b. daily_member_usage ───────────────────────────────────────────────
  try {
    await query(`
      INSERT INTO daily_member_usage (
        day, team_id, member_id, source, model, project,
        tokens_in, tokens_out, cache_read_tokens, cache_write_tokens,
        api_cost, edits, additions, deletions, changed_lines, files_touched,
        tool_calls, tool_errors, rework_loops, corrections, abandoned_count, session_count
      )
      SELECT
        COALESCE(s.ended_at, s.started_at, s.synced_at)::date AS day,
        s.team_id,
        s.member_id,
        COALESCE(NULLIF(s.source, ''), 'unknown') AS source,
        COALESCE(NULLIF(s.model, ''), 'default') AS model,
        COALESCE(NULLIF(s.agent, ''), 'default') AS project,
        SUM(s.tokens_in)::bigint AS tokens_in,
        SUM(s.tokens_out)::bigint AS tokens_out,
        SUM(s.tokens_cache_read)::bigint AS cache_read_tokens,
        SUM(s.tokens_cache_write)::bigint AS cache_write_tokens,
        SUM(COALESCE(s.api_cost, 0))::float AS api_cost,
        SUM(s.edits)::int AS edits,
        SUM(s.additions)::int AS additions,
        SUM(s.deletions)::int AS deletions,
        SUM(s.changed_lines)::int AS changed_lines,
        SUM(s.files_touched)::int AS files_touched,
        SUM(s.tool_calls)::int AS tool_calls,
        SUM(s.tool_errors)::int AS tool_errors,
        SUM(s.rework_loops)::int AS rework_loops,
        SUM(s.corrections)::int AS corrections,
        SUM(CASE WHEN s.abandoned THEN 1 ELSE 0 END)::int AS abandoned_count,
        COUNT(*)::int AS session_count
      FROM sync_sessions s
      WHERE
        COALESCE(s.ended_at, s.started_at, s.synced_at) IS NOT NULL
        AND COALESCE(s.ended_at, s.started_at, s.synced_at)::date <= CURRENT_DATE
      GROUP BY 1, 2, 3, 4, 5, 6
      ON CONFLICT (day, team_id, member_id, source, model, project) DO UPDATE SET
        tokens_in          = EXCLUDED.tokens_in,
        tokens_out         = EXCLUDED.tokens_out,
        cache_read_tokens  = EXCLUDED.cache_read_tokens,
        cache_write_tokens = EXCLUDED.cache_write_tokens,
        api_cost           = EXCLUDED.api_cost,
        edits              = EXCLUDED.edits,
        additions          = EXCLUDED.additions,
        deletions          = EXCLUDED.deletions,
        changed_lines      = EXCLUDED.changed_lines,
        files_touched      = EXCLUDED.files_touched,
        tool_calls         = EXCLUDED.tool_calls,
        tool_errors        = EXCLUDED.tool_errors,
        rework_loops       = EXCLUDED.rework_loops,
        corrections        = EXCLUDED.corrections,
        abandoned_count    = EXCLUDED.abandoned_count,
        session_count      = EXCLUDED.session_count
    `);
  } catch (err) {
    errors.push(`daily_member_usage: ${(err as Error).message}`);
  }

  // ── 3c. daily_member_tools ───────────────────────────────────────────────
  try {
    await query(`
      INSERT INTO daily_member_tools (day, team_id, member_id, tool_name, call_count)
      SELECT
        COALESCE(s.ended_at, s.started_at, s.synced_at)::date AS day,
        s.team_id,
        s.member_id,
        t.tool_name,
        SUM(t.call_count)::int AS call_count
      FROM sync_session_tools t
      JOIN sync_sessions s ON s.id = t.sync_session_id
      WHERE
        COALESCE(s.ended_at, s.started_at, s.synced_at) IS NOT NULL
        AND COALESCE(s.ended_at, s.started_at, s.synced_at)::date <= CURRENT_DATE
      GROUP BY 1, 2, 3, 4
      ON CONFLICT (day, team_id, member_id, tool_name) DO UPDATE SET
        call_count = EXCLUDED.call_count
    `);
  } catch (err) {
    errors.push(`daily_member_tools: ${(err as Error).message}`);
  }

  // ── 3d. daily_member_files ───────────────────────────────────────────────
  try {
    await query(`
      INSERT INTO daily_member_files (day, team_id, member_id, path, edits, additions, deletions, changed_lines, session_count)
      SELECT
        COALESCE(s.ended_at, s.started_at, s.synced_at)::date AS day,
        s.team_id,
        s.member_id,
        f.path,
        SUM(f.edits)::int AS edits,
        SUM(f.additions)::int AS additions,
        SUM(f.deletions)::int AS deletions,
        SUM(f.additions + f.deletions)::int AS changed_lines,
        COUNT(DISTINCT s.id)::int AS session_count
      FROM sync_session_files f
      JOIN sync_sessions s ON s.id = f.sync_session_id
      WHERE
        COALESCE(s.ended_at, s.started_at, s.synced_at) IS NOT NULL
        AND COALESCE(s.ended_at, s.started_at, s.synced_at)::date <= CURRENT_DATE
      GROUP BY 1, 2, 3, 4
      ON CONFLICT (day, team_id, member_id, path) DO UPDATE SET
        edits         = EXCLUDED.edits,
        additions     = EXCLUDED.additions,
        deletions     = EXCLUDED.deletions,
        changed_lines = EXCLUDED.changed_lines,
        session_count = EXCLUDED.session_count
    `);
  } catch (err) {
    errors.push(`daily_member_files: ${(err as Error).message}`);
  }

  // ── 3e. daily_punch_card ─────────────────────────────────────────────────
  try {
    await query(`
      INSERT INTO daily_punch_card (day, team_id, member_id, weekday, hour, session_count)
      SELECT
        COALESCE(s.ended_at, s.started_at, s.synced_at)::date AS day,
        s.team_id,
        s.member_id,
        EXTRACT(DOW FROM COALESCE(s.ended_at, s.started_at, s.synced_at))::int AS weekday,
        EXTRACT(HOUR FROM COALESCE(s.ended_at, s.started_at, s.synced_at))::int AS hour,
        COUNT(*)::int AS session_count
      FROM sync_sessions s
      WHERE
        COALESCE(s.ended_at, s.started_at, s.synced_at) IS NOT NULL
        AND COALESCE(s.ended_at, s.started_at, s.synced_at)::date <= CURRENT_DATE
      GROUP BY 1, 2, 3, 4, 5
      ON CONFLICT (day, team_id, member_id, weekday, hour) DO UPDATE SET
        session_count = EXCLUDED.session_count
    `);
  } catch (err) {
    errors.push(`daily_punch_card: ${(err as Error).message}`);
  }

  // ── 4. Rolling Retention & Data Pruning (Keeps Database < 250 MB) ──────────
  let nullifiedEvents = 0;
  let deletedErrors = 0;
  let deletedTurns = 0;
  let deletedSessions = 0;

  try {
    // A. Clear raw events JSONB payload older than 7 days
    const eventsRes = await query(`UPDATE sync_sessions SET events = NULL WHERE synced_at < NOW() - INTERVAL '7 days' AND events IS NOT NULL`);
    nullifiedEvents = eventsRes.rowCount ?? 0;

    // B. Prune granular turn and tool error logs older than 14 days
    const errorsRes = await query(`DELETE FROM session_tool_errors WHERE created_at < NOW() - INTERVAL '14 days'`);
    deletedErrors = errorsRes.rowCount ?? 0;

    const turnsRes = await query(`DELETE FROM session_turns WHERE created_at < NOW() - INTERVAL '14 days'`);
    deletedTurns = turnsRes.rowCount ?? 0;

    // C. Prune raw sync_sessions older than 30 days (pre-computed rollups retain 100% of historical analytics)
    const sessionsRes = await query(`DELETE FROM sync_sessions WHERE synced_at < NOW() - INTERVAL '30 days'`);
    deletedSessions = sessionsRes.rowCount ?? 0;
  } catch (err) {
    errors.push(`data_pruning: ${(err as Error).message}`);
  }

  const elapsed = Date.now() - startedAt;

  if (errors.length > 0) {
    return NextResponse.json({
      ok: false,
      elapsed_ms: elapsed,
      errors,
    }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    elapsed_ms: elapsed,
    pruning: {
      nullifiedEventsOlderThan7d: nullifiedEvents,
      deletedToolErrorsOlderThan14d: deletedErrors,
      deletedTurnsOlderThan14d: deletedTurns,
      deletedSessionsOlderThan30d: deletedSessions,
    }
  });
}
