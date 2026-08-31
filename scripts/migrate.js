#!/usr/bin/env node
/**
 * Standalone database migration and index sync script.
 * Usage: node scripts/migrate.js
 */
const fs = require('node:fs');
const path = require('node:path');
const pg = require('pg');

// 1. Load environment variables
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
  console.error('❌ Error: DATABASE_URL or NEON_CONNECTION_STRING not found in environment.');
  process.exit(1);
}

const parsed = new URL(dbUrl);
parsed.searchParams.delete('sslmode');
const pool = new pg.Pool({
  connectionString: parsed.toString(),
  ssl: { rejectUnauthorized: false },
});

async function runMigration() {
  console.log('🚀 Running database schema & index migrations...');
  const client = await pool.connect();
  try {
    const schemaPath = path.join(__dirname, '..', 'lib', 'team', 'schema.sql');
    let schemaSql = '';
    if (fs.existsSync(schemaPath)) {
      schemaSql = fs.readFileSync(schemaPath, 'utf8');
    }

    // Run core schema
    if (schemaSql) {
      console.log('📝 Applying schema.sql...');
      await client.query(schemaSql);
    }

    // Run analytics and research extensions
    console.log('📝 Applying analytics & research schema extensions and performance indexes...');
    await client.query(`
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

      CREATE TABLE IF NOT EXISTS daily_pipeline_health (
        day DATE NOT NULL,
        daemon_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        last_heartbeat TIMESTAMPTZ,
        batches_received INT DEFAULT 0,
        batches_failed INT DEFAULT 0,
        avg_ingestion_lag_seconds INT,
        parse_errors INT DEFAULT 0,
        sanitize_errors INT DEFAULT 0,
        PRIMARY KEY (day, daemon_id)
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

      CREATE INDEX IF NOT EXISTS idx_daily_org_usage_day ON daily_org_usage(day DESC);
      CREATE INDEX IF NOT EXISTS idx_daily_pipeline_health_day ON daily_pipeline_health(day DESC);
      CREATE INDEX IF NOT EXISTS idx_daily_behavior_day ON daily_behavior_rollup(day DESC);

      CREATE TABLE IF NOT EXISTS session_turns (
        id BIGSERIAL PRIMARY KEY,
        session_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        model TEXT NOT NULL,
        turn_index INT NOT NULL,
        turn_role TEXT NOT NULL,
        input_tokens INT DEFAULT 0,
        output_tokens INT DEFAULT 0,
        cache_read_tokens INT DEFAULT 0,
        cache_write_tokens INT DEFAULT 0,
        cumulative_input_tokens INT,
        prompt_text_sanitized TEXT,
        prompt_char_len INT,
        has_code_block BOOLEAN DEFAULT FALSE,
        has_file_path BOOLEAN DEFAULT FALSE,
        has_traceback BOOLEAN DEFAULT FALSE,
        intent_category TEXT,
        files_touched INT DEFAULT 0,
        lines_added INT DEFAULT 0,
        lines_removed INT DEFAULT 0,
        tool_call_count INT DEFAULT 0,
        tool_call_valid_count INT DEFAULT 0,
        tool_error_flag BOOLEAN DEFAULT FALSE,
        rework_flag BOOLEAN DEFAULT FALSE,
        revert_flag BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_session_turns_session ON session_turns(session_id, turn_index);
      CREATE INDEX IF NOT EXISTS idx_session_turns_org_model ON session_turns(org_id, model, tool);

      CREATE TABLE IF NOT EXISTS session_tool_errors (
        id BIGSERIAL PRIMARY KEY,
        turn_id BIGINT REFERENCES session_turns(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        model TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        tool_args_summary TEXT,
        is_error BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_session_tool_errors_name ON session_tool_errors(tool_name, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_session_tool_errors_session ON session_tool_errors(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_tool_errors_org ON session_tool_errors(org_id, model, created_at DESC);

      CREATE TABLE IF NOT EXISTS model_context_limits (
        model TEXT PRIMARY KEY,
        max_context_tokens INT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_outcomes (
        session_id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        model TEXT NOT NULL,
        intent_category TEXT,
        total_input_tokens INT,
        total_output_tokens INT,
        total_cost NUMERIC(12,4),
        files_touched INT,
        lines_changed INT,
        tool_call_count INT,
        had_rework BOOLEAN,
        had_revert BOOLEAN,
        had_tool_error BOOLEAN,
        success BOOLEAN,
        complexity_score NUMERIC
      );

      CREATE TABLE IF NOT EXISTS prompt_embeddings (
        turn_id BIGINT REFERENCES session_turns(id) PRIMARY KEY,
        embedding FLOAT8[]
      );

      CREATE TABLE IF NOT EXISTS redundant_reprompt_events (
        id BIGSERIAL PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_index INT NOT NULL,
        similarity_score NUMERIC,
        tokens_cost_of_following_turn INT,
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS daemon_releases (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        version      TEXT NOT NULL UNIQUE,
        download_url TEXT NOT NULL,
        sha256       TEXT NOT NULL,
        mandatory    BOOLEAN NOT NULL DEFAULT false,
        active       BOOLEAN NOT NULL DEFAULT true,
        release_notes TEXT,
        released_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_daemon_releases_active ON daemon_releases(active, released_at DESC);

      ALTER TABLE members ADD COLUMN IF NOT EXISTS daemon_version TEXT;
      ALTER TABLE members ADD COLUMN IF NOT EXISTS daemon_last_seen_at TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INT NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

      CREATE TABLE IF NOT EXISTS audit_log (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
        actor_username TEXT,
        action         TEXT NOT NULL,
        target_type    TEXT,
        target_id      TEXT,
        metadata       JSONB,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_user_id);

      -- High-Performance Composite & Expression Indexes
      CREATE INDEX IF NOT EXISTS idx_sync_sessions_activity ON sync_sessions((COALESCE(ended_at, started_at, synced_at)));
      CREATE INDEX IF NOT EXISTS idx_sync_sessions_team_activity ON sync_sessions(team_id, (COALESCE(ended_at, started_at, synced_at)));
      CREATE INDEX IF NOT EXISTS idx_sync_sessions_member_activity ON sync_sessions(member_id, (COALESCE(ended_at, started_at, synced_at)));
      CREATE INDEX IF NOT EXISTS idx_sync_session_tools_session ON sync_session_tools(sync_session_id);
      CREATE INDEX IF NOT EXISTS idx_sync_session_files_session ON sync_session_files(sync_session_id);

      -- ── Pre-Computed Daily Rollup Tables (Preserves analytics when raw data is pruned) ──
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

    console.log('✅ Database migration completed successfully.');
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration();
