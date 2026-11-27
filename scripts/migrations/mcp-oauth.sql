-- MCP OAuth 2.1 (Phase 2). ADDITIVE and idempotent: creates five NEW tables and six NEW functions; touches no existing table, row or privilege.
-- Run inside ONE transaction (scripts/migrate-mcp-oauth.mjs does that). Role grants are NOT here: scripts/setup-mcp-roles.mjs owns them.
-- Secrets (authorization codes, access/refresh tokens) are stored ONLY as SHA-256 digests (bytea, 32 bytes); plaintext never touches the database.
-- Run as the schema OWNER: the SECURITY DEFINER function below executes with the owner's rights (it is what lets mcp_auth write audit rows
-- WITHOUT holding any INSERT privilege on audit_log).

-- ── Preflight: prerequisites exist ────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.users') IS NULL THEN RAISE EXCEPTION 'prerequisite table public.users is missing'; END IF;
  IF to_regclass('public.audit_log') IS NULL THEN RAISE EXCEPTION 'prerequisite table public.audit_log is missing'; END IF;
END $$;

-- ── Tables ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id                  TEXT PRIMARY KEY,                       -- 'tt_' + 128-bit random (public identifier, not a secret)
  client_name                TEXT NOT NULL CHECK (char_length(client_name) BETWEEN 1 AND 100),
  redirect_uris              TEXT[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 5),
  grant_types                TEXT[] NOT NULL DEFAULT ARRAY['authorization_code','refresh_token']
                               CHECK (cardinality(grant_types) >= 1 AND grant_types <@ ARRAY['authorization_code','refresh_token']::text[]),
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none' CHECK (token_endpoint_auth_method = 'none'),  -- public clients only
  scope                      TEXT NOT NULL DEFAULT 'mcp:read' CHECK (scope = 'mcp:read'),                -- a new scope needs a migration AND a new consent
  registration               TEXT NOT NULL CHECK (registration IN ('dcr', 'static')),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_ip_hash            TEXT,                                   -- salted hash, never a raw IP
  last_used_at               TIMESTAMPTZ,
  disabled_at                TIMESTAMPTZ                             -- set/cleared by admin tooling (owner) only; mcp_auth cannot write it
);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  code_hash      BYTEA PRIMARY KEY CHECK (octet_length(code_hash) = 32),
  client_id      TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL CHECK (char_length(code_challenge) = 43),   -- S256 only
  resource       TEXT NOT NULL,
  scope          TEXT NOT NULL CHECK (scope = 'mcp:read'),
  family_id      UUID NOT NULL,                                            -- every token minted from this code shares it
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  consumed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires ON oauth_authorization_codes (expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_family  ON oauth_authorization_codes (family_id);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_client  ON oauth_authorization_codes (client_id);   -- FK cascade lookups
CREATE INDEX IF NOT EXISTS idx_oauth_codes_user    ON oauth_authorization_codes (user_id);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash          BYTEA NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  kind                TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  family_id           UUID NOT NULL,
  client_id           TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource            TEXT NOT NULL,
  scope               TEXT NOT NULL CHECK (scope = 'mcp:read'),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL,
  absolute_expires_at TIMESTAMPTZ NOT NULL,            -- refresh-family hard limit (60 days); access tokens copy it
  last_used_at        TIMESTAMPTZ,
  rotated_at          TIMESTAMPTZ,                      -- set when a refresh token is exchanged; presenting it again = reuse
  replaced_by_id      UUID,
  revoked_at          TIMESTAMPTZ,
  revoked_reason      TEXT
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_family  ON oauth_tokens (family_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user    ON oauth_tokens (user_id);   -- serves "all live tokens of a user" AND the FK cascade
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client  ON oauth_tokens (client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expires ON oauth_tokens (expires_at);

-- DB-backed fixed-window counters (an in-memory limiter does not work across serverless instances).
CREATE TABLE IF NOT EXISTS mcp_rate_limits (
  key          TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count        INT NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
CREATE INDEX IF NOT EXISTS idx_mcp_rate_limits_window ON mcp_rate_limits (window_start);

-- Tool-call / access events (Phase 4+). Append-only. NEVER contains prompt text or token material.
CREATE TABLE IF NOT EXISTS mcp_access_log (
  id                BIGSERIAL PRIMARY KEY,
  at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id           UUID,                                -- deliberately no FKs: the log must outlive users/clients
  team_id           UUID,
  client_id         TEXT,
  token_id          UUID,
  event             TEXT NOT NULL,
  tool              TEXT,
  target_member_ids UUID[],
  outcome           TEXT,
  status            INT,
  row_count         INT,
  duration_ms       INT,
  ip_hash           TEXT
);
CREATE INDEX IF NOT EXISTS idx_mcp_access_log_at   ON mcp_access_log (at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_access_log_user ON mcp_access_log (user_id, at DESC);

-- ── Shape check: CREATE TABLE IF NOT EXISTS never reconciles a pre-existing table, so fail loudly if one has the wrong columns ──
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(e.t || '.' || e.c, ', ') INTO missing
  FROM (VALUES
    ('oauth_clients','client_id'),
    ('oauth_clients','client_name'),
    ('oauth_clients','redirect_uris'),
    ('oauth_clients','grant_types'),
    ('oauth_clients','token_endpoint_auth_method'),
    ('oauth_clients','scope'),
    ('oauth_clients','registration'),
    ('oauth_clients','created_at'),
    ('oauth_clients','created_ip_hash'),
    ('oauth_clients','last_used_at'),
    ('oauth_clients','disabled_at'),
    ('oauth_authorization_codes','code_hash'),
    ('oauth_authorization_codes','client_id'),
    ('oauth_authorization_codes','user_id'),
    ('oauth_authorization_codes','redirect_uri'),
    ('oauth_authorization_codes','code_challenge'),
    ('oauth_authorization_codes','resource'),
    ('oauth_authorization_codes','scope'),
    ('oauth_authorization_codes','family_id'),
    ('oauth_authorization_codes','created_at'),
    ('oauth_authorization_codes','expires_at'),
    ('oauth_authorization_codes','consumed_at'),
    ('oauth_tokens','id'),
    ('oauth_tokens','token_hash'),
    ('oauth_tokens','kind'),
    ('oauth_tokens','family_id'),
    ('oauth_tokens','client_id'),
    ('oauth_tokens','user_id'),
    ('oauth_tokens','resource'),
    ('oauth_tokens','scope'),
    ('oauth_tokens','created_at'),
    ('oauth_tokens','expires_at'),
    ('oauth_tokens','absolute_expires_at'),
    ('oauth_tokens','last_used_at'),
    ('oauth_tokens','rotated_at'),
    ('oauth_tokens','replaced_by_id'),
    ('oauth_tokens','revoked_at'),
    ('oauth_tokens','revoked_reason'),
    ('mcp_rate_limits','key'),
    ('mcp_rate_limits','window_start'),
    ('mcp_rate_limits','count'),
    ('mcp_access_log','id'),
    ('mcp_access_log','at'),
    ('mcp_access_log','user_id'),
    ('mcp_access_log','team_id'),
    ('mcp_access_log','client_id'),
    ('mcp_access_log','token_id'),
    ('mcp_access_log','event'),
    ('mcp_access_log','tool'),
    ('mcp_access_log','target_member_ids'),
    ('mcp_access_log','outcome'),
    ('mcp_access_log','status'),
    ('mcp_access_log','row_count'),
    ('mcp_access_log','duration_ms'),
    ('mcp_access_log','ip_hash')
  ) AS e(t, c)
  WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = to_regclass('public.' || e.t) AND a.attname = e.c AND a.attnum > 0 AND NOT a.attisdropped);
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'pre-existing MCP table(s) have an unexpected shape (missing columns: %)', missing; END IF;
END $$;

-- ── Tamper guards (defence in depth against a compromised mcp_auth credential or an application bug) ─────────────────────────
-- Revocation, code consumption and rotation are ONE-WAY: once set they can never be cleared or changed, and identity columns never change.
-- INVOKER-rights triggers; they bind the table owner too, so no code path can un-revoke or re-arm a used code. Revoke hooks must therefore
-- only ever do:  UPDATE oauth_tokens SET revoked_at = now(), revoked_reason = $1 WHERE ... AND revoked_at IS NULL.
CREATE OR REPLACE FUNCTION mcp_guard_oauth_tokens() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF ROW(NEW.id, NEW.token_hash, NEW.kind, NEW.family_id, NEW.client_id, NEW.user_id, NEW.resource, NEW.scope, NEW.created_at, NEW.expires_at, NEW.absolute_expires_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.token_hash, OLD.kind, OLD.family_id, OLD.client_id, OLD.user_id, OLD.resource, OLD.scope, OLD.created_at, OLD.expires_at, OLD.absolute_expires_at) THEN
    RAISE EXCEPTION 'oauth_tokens: identity columns are immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_reason IS DISTINCT FROM OLD.revoked_reason) THEN
    RAISE EXCEPTION 'oauth_tokens: revocation is permanent' USING ERRCODE = '42501';
  END IF;
  IF OLD.rotated_at IS NOT NULL AND (NEW.rotated_at IS DISTINCT FROM OLD.rotated_at OR NEW.replaced_by_id IS DISTINCT FROM OLD.replaced_by_id) THEN
    RAISE EXCEPTION 'oauth_tokens: a rotated refresh token cannot be changed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION mcp_guard_oauth_codes() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF ROW(NEW.code_hash, NEW.client_id, NEW.user_id, NEW.redirect_uri, NEW.code_challenge, NEW.resource, NEW.scope, NEW.family_id, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM
     ROW(OLD.code_hash, OLD.client_id, OLD.user_id, OLD.redirect_uri, OLD.code_challenge, OLD.resource, OLD.scope, OLD.family_id, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'oauth_authorization_codes: only consumed_at may change' USING ERRCODE = '42501';
  END IF;
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'oauth_authorization_codes: a consumed code cannot be re-armed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION mcp_guard_oauth_clients() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF ROW(NEW.client_id, NEW.client_name, NEW.redirect_uris, NEW.grant_types, NEW.token_endpoint_auth_method, NEW.scope, NEW.registration, NEW.created_at, NEW.created_ip_hash)
     IS DISTINCT FROM
     ROW(OLD.client_id, OLD.client_name, OLD.redirect_uris, OLD.grant_types, OLD.token_endpoint_auth_method, OLD.scope, OLD.registration, OLD.created_at, OLD.created_ip_hash) THEN
    RAISE EXCEPTION 'oauth_clients: registration data is immutable (register a new client instead)' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_mcp_guard_oauth_tokens ON oauth_tokens;
CREATE TRIGGER trg_mcp_guard_oauth_tokens BEFORE UPDATE ON oauth_tokens FOR EACH ROW EXECUTE FUNCTION mcp_guard_oauth_tokens();
DROP TRIGGER IF EXISTS trg_mcp_guard_oauth_codes ON oauth_authorization_codes;
CREATE TRIGGER trg_mcp_guard_oauth_codes BEFORE UPDATE ON oauth_authorization_codes FOR EACH ROW EXECUTE FUNCTION mcp_guard_oauth_codes();
DROP TRIGGER IF EXISTS trg_mcp_guard_oauth_clients ON oauth_clients;
CREATE TRIGGER trg_mcp_guard_oauth_clients BEFORE UPDATE ON oauth_clients FOR EACH ROW EXECUTE FUNCTION mcp_guard_oauth_clients();

-- ── Audit: the ONLY way mcp_auth can write audit_log ─────────────────────────────────────────────────────────────────────────
-- mcp_auth holds NO privilege on audit_log; it may only EXECUTE this function (granted by setup-mcp-roles.mjs). The function runs with the
-- owner's rights and enforces: a fixed event allowlist, a fixed 'mcp.' action prefix, a known target type, a bounded charset/size target id,
-- an object-only metadata bounded to 2 KiB, and an actor that must be a real user whose username is looked up HERE (never supplied by the caller).
-- Tool-call events do NOT go here; they go to mcp_access_log. Callers must never put secrets in metadata (the code passes counts/ids only).
CREATE OR REPLACE FUNCTION mcp_audit_event(p_event text, p_actor uuid, p_target_type text, p_target_id text, p_meta jsonb DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_username text;
BEGIN
  IF p_event IS NULL OR NOT (p_event = ANY (ARRAY[
       'client_registered', 'authorization_granted', 'authorization_denied', 'code_replayed', 'token_issued',
       'token_refreshed', 'refresh_reuse_detected', 'token_revoked', 'tokens_revoked_for_user', 'access_denied'])) THEN
    RAISE EXCEPTION 'mcp_audit_event: event not allowed' USING ERRCODE = '22023';
  END IF;
  IF p_target_type IS NOT NULL AND NOT (p_target_type = ANY (ARRAY['oauth_client', 'oauth_token', 'oauth_code', 'user'])) THEN
    RAISE EXCEPTION 'mcp_audit_event: target type not allowed' USING ERRCODE = '22023';
  END IF;
  IF p_target_id IS NOT NULL AND (char_length(p_target_id) > 128 OR p_target_id !~ '^[A-Za-z0-9_.:-]+$') THEN
    RAISE EXCEPTION 'mcp_audit_event: invalid target id' USING ERRCODE = '22023';
  END IF;
  IF p_meta IS NOT NULL AND (jsonb_typeof(p_meta) <> 'object' OR octet_length(p_meta::text) > 2048) THEN
    RAISE EXCEPTION 'mcp_audit_event: metadata must be a JSON object of at most 2048 bytes' USING ERRCODE = '22023';
  END IF;
  IF p_actor IS NOT NULL THEN
    SELECT u.username INTO v_username FROM public.users u WHERE u.id = p_actor;
    IF NOT FOUND THEN RAISE EXCEPTION 'mcp_audit_event: unknown actor' USING ERRCODE = '22023'; END IF;
  END IF;
  INSERT INTO public.audit_log (actor_user_id, actor_username, action, target_type, target_id, metadata)
  VALUES (p_actor, v_username, 'mcp.' || p_event, p_target_type, p_target_id, p_meta);
END $$;

-- ── Retention (executed by the OWNER from the daily cron; mcp_auth has no DELETE) ───────────────────────────────────────────────
-- Expired authorization codes, dead tokens (access tokens a day after expiry; any token a day after its family's absolute expiry, so reuse
-- detection keeps working for the whole life of a family), stale rate-limit windows, access-log rows older than 180 days, and DCR clients
-- that were never used for 30 days and hold no codes/tokens. Returns the number of rows deleted per table.
CREATE OR REPLACE FUNCTION mcp_oauth_purge() RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE n_codes int; n_tokens int; n_rate int; n_log int; n_clients int;
BEGIN
  DELETE FROM oauth_authorization_codes WHERE expires_at < now() - interval '1 hour';
  GET DIAGNOSTICS n_codes = ROW_COUNT;
  DELETE FROM oauth_tokens WHERE (kind = 'access' AND expires_at < now() - interval '1 day') OR absolute_expires_at < now() - interval '1 day';
  GET DIAGNOSTICS n_tokens = ROW_COUNT;
  DELETE FROM mcp_rate_limits WHERE window_start < now() - interval '2 days';
  GET DIAGNOSTICS n_rate = ROW_COUNT;
  DELETE FROM mcp_access_log WHERE at < now() - interval '180 days';
  GET DIAGNOSTICS n_log = ROW_COUNT;
  DELETE FROM oauth_clients c
   WHERE c.registration = 'dcr' AND COALESCE(c.last_used_at, c.created_at) < now() - interval '30 days'
     AND NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.client_id = c.client_id)
     AND NOT EXISTS (SELECT 1 FROM oauth_authorization_codes a WHERE a.client_id = c.client_id);
  GET DIAGNOSTICS n_clients = ROW_COUNT;
  RETURN jsonb_build_object('codes', n_codes, 'tokens', n_tokens, 'rate_limits', n_rate, 'access_log', n_log, 'clients', n_clients);
END $$;

-- Functions default to EXECUTE for PUBLIC. Remove it from every function this migration creates; only the owner (and, for
-- mcp_audit_event, mcp_auth via setup-mcp-roles.mjs) may run them.
REVOKE ALL ON FUNCTION mcp_guard_oauth_tokens()  FROM PUBLIC;
REVOKE ALL ON FUNCTION mcp_guard_oauth_codes()   FROM PUBLIC;
REVOKE ALL ON FUNCTION mcp_guard_oauth_clients() FROM PUBLIC;
REVOKE ALL ON FUNCTION mcp_audit_event(text, uuid, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION mcp_oauth_purge() FROM PUBLIC;
