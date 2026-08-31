-- Team analytics schema (Neon Postgres)

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
  daemon_version TEXT,
  daemon_last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sync_requested_at TIMESTAMPTZ
);

-- Junction table for many-to-many relationship between teams and members
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

CREATE TABLE IF NOT EXISTS sync_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent TEXT,
  label TEXT,
  model TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  tokens_in BIGINT NOT NULL DEFAULT 0,
  tokens_out BIGINT NOT NULL DEFAULT 0,
  tokens_cache_read BIGINT NOT NULL DEFAULT 0,
  tokens_cache_write BIGINT NOT NULL DEFAULT 0,
  api_cost DOUBLE PRECISION,
  priced BOOLEAN NOT NULL DEFAULT false,
  edits INT NOT NULL DEFAULT 0,
  additions INT NOT NULL DEFAULT 0,
  deletions INT NOT NULL DEFAULT 0,
  changed_lines INT NOT NULL DEFAULT 0,
  files_touched INT NOT NULL DEFAULT 0,
  tool_calls INT NOT NULL DEFAULT 0,
  tool_errors INT NOT NULL DEFAULT 0,
  rework_loops INT NOT NULL DEFAULT 0,
  corrections INT NOT NULL DEFAULT 0,
  abandoned BOOLEAN NOT NULL DEFAULT false,
  payload_hash TEXT NOT NULL,
  events JSONB,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, member_id, source, session_id)
);

CREATE TABLE IF NOT EXISTS sync_session_tools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_session_id UUID NOT NULL REFERENCES sync_sessions(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  call_count INT NOT NULL DEFAULT 0,
  UNIQUE (sync_session_id, tool_name)
);

CREATE TABLE IF NOT EXISTS sync_session_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_session_id UUID NOT NULL REFERENCES sync_sessions(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  edits INT NOT NULL DEFAULT 0,
  additions INT NOT NULL DEFAULT 0,
  deletions INT NOT NULL DEFAULT 0,
  UNIQUE (sync_session_id, path)
);

-- Custom global and per-team model pricing overrides (falls back to hardcoded defaults in lib/team/stats.ts)
CREATE TABLE IF NOT EXISTS model_pricing (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id               UUID REFERENCES teams(id) ON DELETE CASCADE,
  model_pattern         TEXT NOT NULL,
  cost_in_per_m         DOUBLE PRECISION NOT NULL DEFAULT 0,
  cost_out_per_m        DOUBLE PRECISION NOT NULL DEFAULT 0,
  cost_cache_read_per_m DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_pricing_global_unique ON model_pricing (LOWER(model_pattern)) WHERE team_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_pricing_team_unique ON model_pricing (team_id, LOWER(model_pattern)) WHERE team_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ingest_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  session_count INT NOT NULL DEFAULT 0,
  accepted INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- User accounts for dashboard login
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

-- Idempotent column migrations for existing databases
ALTER TABLE members ADD COLUMN IF NOT EXISTS daemon_version TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS daemon_last_seen_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_sync_sessions_team_member ON sync_sessions(team_id, member_id);
CREATE INDEX IF NOT EXISTS idx_sync_sessions_ended ON sync_sessions(ended_at);
CREATE INDEX IF NOT EXISTS idx_sync_sessions_activity ON sync_sessions((COALESCE(ended_at, started_at, synced_at)));
CREATE INDEX IF NOT EXISTS idx_sync_sessions_team_activity ON sync_sessions(team_id, (COALESCE(ended_at, started_at, synced_at)));
CREATE INDEX IF NOT EXISTS idx_sync_sessions_member_activity ON sync_sessions(member_id, (COALESCE(ended_at, started_at, synced_at)));
CREATE INDEX IF NOT EXISTS idx_sync_session_tools_session ON sync_session_tools(sync_session_id);
CREATE INDEX IF NOT EXISTS idx_sync_session_files_session ON sync_session_files(sync_session_id);
CREATE INDEX IF NOT EXISTS idx_ingest_events_member ON ingest_events(member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username));
CREATE INDEX IF NOT EXISTS idx_users_member ON users(member_id);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_team_members_member ON team_members(member_id);

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



