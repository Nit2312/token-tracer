import pg from 'pg';
import { requireDatabaseUrl } from './env';

const { Pool } = pg;

const globalForDb = globalThis as unknown as {
  conn: pg.Pool | undefined;
};

/** Shared Postgres pool (Neon serverless compatible). */
export function getPool(): pg.Pool {
  if (!globalForDb.conn) {
    const rawUrl = requireDatabaseUrl();
    const parsed = new URL(rawUrl);
    parsed.searchParams.delete('sslmode');
    const url = parsed.toString();
    globalForDb.conn = new Pool({
      connectionString: url,
      ssl: { rejectUnauthorized: false },
      // Kept small: Fluid Compute runs many concurrent instances, each with its
      // own pool, so pool size multiplies by instance count against Neon's
      // connection limit — rely on the Neon pooler to fan this in, not a large
      // per-instance pool. See lib/team/env.ts's requireDatabaseUrl() check.
      max: 5,
      connectionTimeoutMillis: 20000, // Allow 20s for Neon compute endpoint wake up
      idleTimeoutMillis: 30000,
    });
  }
  return globalForDb.conn;
}

let schemaChecked = false;
let schemaPromise: Promise<void> | null = null;

/**
 * Idempotently ensures core tables (team_members, model_pricing, users, etc.) exist.
 */
export async function ensureSchema(): Promise<void> {
  if (schemaChecked) return;
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const pool = getPool();
      try {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS teams (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );

          CREATE TABLE IF NOT EXISTS members (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            team_id UUID REFERENCES teams(id) ON DELETE SET NULL,
            display_name TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            sync_requested_at TIMESTAMPTZ
          );

          CREATE TABLE IF NOT EXISTS team_members (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
            member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
            role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (team_id, member_id)
          );

          CREATE TABLE IF NOT EXISTS member_keys (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
            key_hash TEXT NOT NULL UNIQUE,
            label TEXT NOT NULL DEFAULT 'default',
            last_used_at TIMESTAMPTZ,
            revoked_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );

          CREATE TABLE IF NOT EXISTS users (
            id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            username      TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            display_name  TEXT NOT NULL,
            member_id     UUID REFERENCES members(id) ON DELETE SET NULL,
            team_id       UUID REFERENCES teams(id) ON DELETE SET NULL,
            role          TEXT NOT NULL DEFAULT 'user'
                            CHECK (role IN ('user', 'admin', 'superadmin')),
            active        BOOLEAN NOT NULL DEFAULT true,
            api_key       TEXT,
            last_login_at TIMESTAMPTZ,
            failed_login_attempts INT NOT NULL DEFAULT 0,
            locked_until          TIMESTAMPTZ,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
          );

          CREATE TABLE IF NOT EXISTS model_pricing (
            id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            team_id               UUID REFERENCES teams(id) ON DELETE CASCADE,
            model_pattern         TEXT NOT NULL,
            cost_in_per_m         DOUBLE PRECISION NOT NULL DEFAULT 0,
            cost_out_per_m        DOUBLE PRECISION NOT NULL DEFAULT 0,
            cost_cache_read_per_m DOUBLE PRECISION NOT NULL DEFAULT 0,
            created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
          );

          -- Allow global pricing rules (team_id IS NULL)
          ALTER TABLE model_pricing ALTER COLUMN team_id DROP NOT NULL;
          CREATE UNIQUE INDEX IF NOT EXISTS idx_model_pricing_global_unique ON model_pricing (LOWER(model_pattern)) WHERE team_id IS NULL;
          CREATE UNIQUE INDEX IF NOT EXISTS idx_model_pricing_team_unique ON model_pricing (team_id, LOWER(model_pattern)) WHERE team_id IS NOT NULL;

          CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);
          CREATE INDEX IF NOT EXISTS idx_team_members_member ON team_members(member_id);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username));

          -- Backfill team_members from existing members
          INSERT INTO team_members (team_id, member_id, role, created_at)
          SELECT m.team_id, m.id, m.role, m.created_at
          FROM members m
          WHERE m.team_id IS NOT NULL
          ON CONFLICT (team_id, member_id) DO NOTHING;

          -- Backfill team_members from users table team_id & member_id
          INSERT INTO team_members (team_id, member_id, role, created_at)
          SELECT u.team_id, u.member_id, 'member', u.created_at
          FROM users u
          WHERE u.team_id IS NOT NULL AND u.member_id IS NOT NULL
          ON CONFLICT (team_id, member_id) DO NOTHING;

          -- Ensure missing columns exist on existing users/members tables
          ALTER TABLE members ADD COLUMN IF NOT EXISTS daemon_version TEXT;
          ALTER TABLE members ADD COLUMN IF NOT EXISTS daemon_last_seen_at TIMESTAMPTZ;
          ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key TEXT;
          ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INT NOT NULL DEFAULT 0;
          ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

          -- Add events JSONB column if not present
          ALTER TABLE sync_sessions ADD COLUMN IF NOT EXISTS events JSONB;

          -- ── Rollup tables for superadmin analytics ─────────────────────────
          -- one row per org+tool+model+day (nightly rollup)
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

          -- one row per sync daemon (member) per day
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

          -- one row per org+tool+day for behaviour patterns
          CREATE TABLE IF NOT EXISTS daily_behavior_rollup (
            day DATE NOT NULL,
            org_id TEXT NOT NULL,
            tool TEXT NOT NULL,
            rework_loop_count INT DEFAULT 0,
            tool_error_count INT DEFAULT 0,
            total_turns INT DEFAULT 0,
            PRIMARY KEY (day, org_id, tool)
          );

           -- Indexes for fast range queries on rollup tables
           CREATE INDEX IF NOT EXISTS idx_daily_org_usage_day ON daily_org_usage(day DESC);
           CREATE INDEX IF NOT EXISTS idx_daily_pipeline_health_day ON daily_pipeline_health(day DESC);
           CREATE INDEX IF NOT EXISTS idx_daily_behavior_day ON daily_behavior_rollup(day DESC);

           -- ── Research Analytics Tables (Study 1-5) ─────────────────────────
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

           -- Per-tool-call detail (previously discarded after being reduced to tool_error_flag)
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

           INSERT INTO model_context_limits (model, max_context_tokens) VALUES
             ('claude-3-7-sonnet', 200000),
             ('claude-3-5-sonnet', 200000),
             ('claude-3-5-haiku', 200000),
             ('gpt-4o', 128000),
             ('gpt-4o-mini', 128000),
             ('o1', 200000),
             ('o3-mini', 200000),
             ('deepseek-r1', 64000),
             ('deepseek-v3', 64000),
             ('default', 200000)
           ON CONFLICT (model) DO NOTHING;

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
           -- ── Daemon auto-update tables ─────────────────────────────────
           -- Stores admin-controlled daemon release records
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

           -- Track per-member daemon version (updated on each ingest / update-check)
           ALTER TABLE members ADD COLUMN IF NOT EXISTS daemon_version TEXT;
           ALTER TABLE members ADD COLUMN IF NOT EXISTS daemon_last_seen_at TIMESTAMPTZ;

           -- Track user login lockout state
           ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INT NOT NULL DEFAULT 0;
           ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

           -- Audit trail for sensitive superadmin actions (impersonation, password resets, pricing changes)
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

            -- ── Pre-Computed Daily Rollup Tables ──
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
        schemaChecked = true;
      } catch (err) {
        console.warn('[db auto-schema notice]', (err as Error).message);
      } finally {
        schemaPromise = null;
      }
    })();
  }
  await schemaPromise;
}

/** Run a parameterized query. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  if (process.env.AUTO_ENSURE_SCHEMA === 'true' && !schemaChecked) {
    await ensureSchema();
  }
  try {
    return await getPool().query<T>(text, params);
  } catch (err: unknown) {
    // If it's a 42P01 error (relation does not exist), ensure schema and retry once
    const pgErr = err as { code?: string };
    if (pgErr && pgErr.code === '42P01') {
      schemaChecked = false;
      await ensureSchema();
      return await getPool().query<T>(text, params);
    }
    console.error('[DATABASE-QUERY-ERROR]', err, '\nQuery:', text, '\nParams:', params);
    throw err;
  }
}

/**
 * Insert many rows in a single round trip via unnest() instead of one query per row.
 * `columns`/`types` are internal constants, never user input — safe to interpolate.
 */
export async function insertMany<T extends pg.QueryResultRow = pg.QueryResultRow>(
  table: string,
  columns: string[],
  types: string[],
  rows: unknown[][],
  opts?: { returning?: string },
): Promise<pg.QueryResult<T>> {
  if (!rows.length) {
    return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as unknown as pg.QueryResult<T>;
  }
  const columnParams = columns.map((_, colIdx) => rows.map((row) => row[colIdx]));
  const placeholders = types.map((t, i) => `$${i + 1}::${t}[]`).join(', ');
  const sql = `
    INSERT INTO ${table} (${columns.join(', ')})
    SELECT * FROM unnest(${placeholders}) AS t(${columns.join(', ')})
    ${opts?.returning ? `RETURNING ${opts.returning}` : ''}
  `;
  return query<T>(sql, columnParams);
}
