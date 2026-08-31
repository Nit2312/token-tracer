#!/usr/bin/env node
/**
 * Standalone Rollup & Rolling Data Pruning Runner.
 * Usage: node scripts/run-rollup-prune.js
 *
 * 1. Pre-computes and backfills 100% of historical analytics into daily rollup tables.
 * 2. Prunes raw events JSONB (>7 days).
 * 3. Prunes debug turn logs (>14 days).
 * 4. Prunes raw sync_sessions older than 30 days.
 */
const fs = require('node:fs');
const path = require('node:path');
const pg = require('pg');

function loadEnv() {
  const files = ['.env.local', '.env'];
  for (const f of files) {
    const filePath = path.join(process.cwd(), f);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!val) continue;
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    } catch {
      // ignore
    }
  }
}

loadEnv();

const dbUrl = process.env.DATABASE_URL || process.env.NEON_CONNECTION_STRING;
if (!dbUrl) {
  console.error('❌ Error: DATABASE_URL not set in environment or .env.local');
  process.exit(1);
}

const parsed = new URL(dbUrl);
parsed.searchParams.delete('sslmode');
const pool = new pg.Pool({
  connectionString: parsed.toString(),
  ssl: { rejectUnauthorized: false },
});

async function main() {
  console.log('🚀 Starting Automated Rolling Rollup & Pruning Process...\n');
  const startTime = Date.now();

  const client = await pool.connect();
  try {
    // 0. Ensure base schema exists (teams, members, sync_sessions, etc.)
    const schemaPath = path.join(__dirname, '..', 'lib', 'team', 'schema.sql');
    if (fs.existsSync(schemaPath)) {
      console.log('📦 Step 0: Ensuring core schema (teams, members, sync_sessions)...');
      await client.query(fs.readFileSync(schemaPath, 'utf8'));
    }

    // 1. Ensure rollup tables exist
    console.log('📦 Step 1: Verifying rollup tables schema...');
    await client.query(`
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

      CREATE TABLE IF NOT EXISTS daily_org_usage (
        day DATE NOT NULL,
        org_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens BIGINT DEFAULT 0,
        output_tokens BIGINT DEFAULT 0,
        cache_read_tokens BIGINT DEFAULT 0,
        cache_write_tokens BIGINT DEFAULT 0,
        list_price_cost NUMERIC(12,4) DEFAULT 0,
        actual_cost NUMERIC(12,4) DEFAULT 0,
        session_count INT DEFAULT 0,
        PRIMARY KEY (day, org_id, tool, model)
      );

      CREATE TABLE IF NOT EXISTS daily_behavior_rollup (
        day DATE NOT NULL,
        org_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        rework_loop_count INT DEFAULT 0,
        tool_error_count INT DEFAULT 0,
        total_turns INT DEFAULT 0,
        PRIMARY KEY (day, org_id, tool)
      );
    `);

    // Initial database size
    const initialSizeRes = await client.query(`SELECT pg_size_pretty(pg_database_size(current_database())) as size`);
    console.log(`📊 Initial Database Size: ${initialSizeRes.rows[0].size}\n`);

    // 1. Pre-compute Member Usage Rollup
    console.log('🔄 Step 2: Pre-computing historical daily_member_usage...');
    const memberUsageRes = await client.query(`
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
      WHERE COALESCE(s.ended_at, s.started_at, s.synced_at) IS NOT NULL
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
      RETURNING 1
    `);
    console.log(`   ✅ Upserted ${memberUsageRes.rowCount} rows into daily_member_usage`);

    // 2. Pre-compute Member Tools Rollup
    console.log('🔄 Step 3: Pre-computing historical daily_member_tools...');
    const toolsRes = await client.query(`
      INSERT INTO daily_member_tools (day, team_id, member_id, tool_name, call_count)
      SELECT
        COALESCE(s.ended_at, s.started_at, s.synced_at)::date AS day,
        s.team_id,
        s.member_id,
        t.tool_name,
        SUM(t.call_count)::int AS call_count
      FROM sync_session_tools t
      JOIN sync_sessions s ON s.id = t.sync_session_id
      WHERE COALESCE(s.ended_at, s.started_at, s.synced_at) IS NOT NULL
      GROUP BY 1, 2, 3, 4
      ON CONFLICT (day, team_id, member_id, tool_name) DO UPDATE SET
        call_count = EXCLUDED.call_count
      RETURNING 1
    `);
    console.log(`   ✅ Upserted ${toolsRes.rowCount} rows into daily_member_tools`);

    // 3. Pre-compute Member Files Rollup
    console.log('🔄 Step 4: Pre-computing historical daily_member_files...');
    const filesRes = await client.query(`
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
      WHERE COALESCE(s.ended_at, s.started_at, s.synced_at) IS NOT NULL
      GROUP BY 1, 2, 3, 4
      ON CONFLICT (day, team_id, member_id, path) DO UPDATE SET
        edits         = EXCLUDED.edits,
        additions     = EXCLUDED.additions,
        deletions     = EXCLUDED.deletions,
        changed_lines = EXCLUDED.changed_lines,
        session_count = EXCLUDED.session_count
      RETURNING 1
    `);
    console.log(`   ✅ Upserted ${filesRes.rowCount} rows into daily_member_files`);

    // 4. Pre-compute Punch Card Rollup
    console.log('🔄 Step 5: Pre-computing historical daily_punch_card...');
    const punchRes = await client.query(`
      INSERT INTO daily_punch_card (day, team_id, member_id, weekday, hour, session_count)
      SELECT
        COALESCE(s.ended_at, s.started_at, s.synced_at)::date AS day,
        s.team_id,
        s.member_id,
        EXTRACT(DOW FROM COALESCE(s.ended_at, s.started_at, s.synced_at))::int AS weekday,
        EXTRACT(HOUR FROM COALESCE(s.ended_at, s.started_at, s.synced_at))::int AS hour,
        COUNT(*)::int AS session_count
      FROM sync_sessions s
      WHERE COALESCE(s.ended_at, s.started_at, s.synced_at) IS NOT NULL
      GROUP BY 1, 2, 3, 4, 5
      ON CONFLICT (day, team_id, member_id, weekday, hour) DO UPDATE SET
        session_count = EXCLUDED.session_count
      RETURNING 1
    `);
    console.log(`   ✅ Upserted ${punchRes.rowCount} rows into daily_punch_card`);

    // 5. Pre-compute Org Usage & Behavior
    console.log('🔄 Step 6: Pre-computing daily_org_usage & daily_behavior_rollup...');
    await client.query(`
      INSERT INTO daily_org_usage (day, org_id, tool, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, list_price_cost, actual_cost, session_count)
      SELECT
        COALESCE(s.ended_at, s.started_at, s.synced_at)::date AS day,
        s.team_id::text AS org_id,
        COALESCE(NULLIF(s.source, ''), 'unknown') AS tool,
        COALESCE(NULLIF(s.model, ''), 'unknown') AS model,
        SUM(s.tokens_in) AS input_tokens,
        SUM(s.tokens_out) AS output_tokens,
        SUM(s.tokens_cache_read) AS cache_read_tokens,
        SUM(s.tokens_cache_write) AS cache_write_tokens,
        SUM(COALESCE(s.api_cost, 0))::numeric(12,4) AS list_price_cost,
        SUM(COALESCE(s.api_cost, 0))::numeric(12,4) AS actual_cost,
        COUNT(*)::int AS session_count
      FROM sync_sessions s
      WHERE COALESCE(s.ended_at, s.started_at, s.synced_at) IS NOT NULL
      GROUP BY 1, 2, 3, 4
      ON CONFLICT (day, org_id, tool, model) DO UPDATE SET
        input_tokens       = EXCLUDED.input_tokens,
        output_tokens      = EXCLUDED.output_tokens,
        cache_read_tokens  = EXCLUDED.cache_read_tokens,
        cache_write_tokens = EXCLUDED.cache_write_tokens,
        list_price_cost    = EXCLUDED.list_price_cost,
        actual_cost        = EXCLUDED.actual_cost,
        session_count      = EXCLUDED.session_count;

      INSERT INTO daily_behavior_rollup (day, org_id, tool, rework_loop_count, tool_error_count, total_turns)
      SELECT
        COALESCE(s.ended_at, s.started_at, s.synced_at)::date AS day,
        s.team_id::text AS org_id,
        COALESCE(NULLIF(s.source, ''), 'unknown') AS tool,
        SUM(s.rework_loops)::int AS rework_loop_count,
        SUM(s.tool_errors)::int AS tool_error_count,
        SUM(s.tool_calls)::int AS total_turns
      FROM sync_sessions s
      WHERE COALESCE(s.ended_at, s.started_at, s.synced_at) IS NOT NULL
      GROUP BY 1, 2, 3
      ON CONFLICT (day, org_id, tool) DO UPDATE SET
        rework_loop_count = EXCLUDED.rework_loop_count,
        tool_error_count  = EXCLUDED.tool_error_count,
        total_turns       = EXCLUDED.total_turns;
    `);
    console.log('   ✅ Org & Behavior rollups synchronized.\n');

    // ── 6. Execute Rolling Retention Pruning (Neon Free Tier Budget < 50 MB) ─
    console.log('🧹 Step 7: Executing Rolling Retention Pruning...');

    // A. Nullify events JSONB older than 2 days (events account for ~80% of DB storage)
    const pruneEventsRes = await client.query(`
      UPDATE sync_sessions
      SET events = NULL
      WHERE synced_at < NOW() - INTERVAL '2 days' AND events IS NOT NULL
    `);
    console.log(`   ✂️  Nullified raw events JSONB on ${pruneEventsRes.rowCount} sessions (> 2 days old)`);

    // B. Prune debug turns and errors older than 7 days
    const pruneErrorsRes = await client.query(`
      DELETE FROM session_tool_errors WHERE created_at < NOW() - INTERVAL '7 days'
    `);
    console.log(`   ✂️  Deleted ${pruneErrorsRes.rowCount} tool error logs (> 7 days old)`);

    const pruneTurnsRes = await client.query(`
      DELETE FROM session_turns WHERE created_at < NOW() - INTERVAL '7 days'
    `);
    console.log(`   ✂️  Deleted ${pruneTurnsRes.rowCount} session turn logs (> 7 days old)`);

    // C. Prune raw sessions older than 14 days (daily rollups retain 100% of historical analytics)
    const pruneSessionsRes = await client.query(`
      DELETE FROM sync_sessions WHERE synced_at < NOW() - INTERVAL '14 days'
    `);
    console.log(`   ✂️  Deleted ${pruneSessionsRes.rowCount} raw sessions (> 14 days old)`);

    // D. Prune ingest audit logs older than 7 days
    const pruneIngestRes = await client.query(`
      DELETE FROM ingest_events WHERE created_at < NOW() - INTERVAL '7 days'
    `);
    console.log(`   ✂️  Deleted ${pruneIngestRes.rowCount} ingest log events (> 7 days old)`);

    // E. Reclaim space with VACUUM ANALYZE
    console.log('🧹 Step 8: Reclaiming disk space via VACUUM ANALYZE...');
    try {
      await client.query('VACUUM ANALYZE sync_sessions');
      await client.query('VACUUM ANALYZE session_turns');
      await client.query('VACUUM ANALYZE ingest_events');
      console.log('   ✅ VACUUM ANALYZE completed successfully');
    } catch (vErr) {
      console.warn('   ⚠️  VACUUM skipped or limited by permission:', vErr.message);
    }

    // Final database size
    const finalSizeRes = await client.query(`SELECT pg_size_pretty(pg_database_size(current_database())) as size`);
    console.log(`\n📊 Final Database Size: ${finalSizeRes.rows[0].size}`);
    console.log(`⏱️  Total Duration: ${((Date.now() - startTime) / 1000).toFixed(2)}s`);
    console.log('\n🎉 First-time rollup & rolling data pruning completed successfully!');
  } catch (err) {
    console.error('❌ Error during rollup/pruning:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
