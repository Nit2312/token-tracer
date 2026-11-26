-- MCP data plane (Phase 3, P3-3). WRITTEN FOR REVIEW — NOT APPLIED ANYWHERE. Touches no existing table, row, column or privilege.
-- Creates: the NOLOGIN role mcp_data_owner, the schema mcp_data, and 13 functions (6 callable by mcp_reader, 7 internal helpers).
-- Grants are NOT here: scripts/migrations/mcp-data.grants.sql owns them (and lib/mcp/grants.json is their source of truth).
-- Run as the schema OWNER (the app's owner role) inside ONE transaction, on a TEST BRANCH first. Requires PostgreSQL 16 or later.
--
-- DESIGN (approved decisions 1-6, MCP.md section 16)
--  * Every reader function takes the caller's access-token SHA-256 hash and derives the team IN THE DATABASE (mcp_data._resolve_scope). No function
--    accepts a team id, and none reads a session setting, so pooling and SET LOCAL cannot weaken isolation.
--  * The scope predicate is the SAME as bearer authentication (lib/mcp/oauth/tokens.ts): live access token, enabled client, active user of role
--    'admin' whose team exists. A revoked, expired, demoted or deactivated principal fails on its NEXT data call.
--  * Strict tenant match: sync_sessions.team_id = scope team AND the developer is a CURRENT team_members row of that team (decision 3);
--    session_turns is tied to its owner by the full 4-key identity (session_id, org_id = team_id::text, user_id = member_id::text, tool = source).
--  * METADATA ONLY (privacy decision 2026-11-26): no function reads, selects, filters on, joins or returns session_turns.prompt_text_sanitized,
--    sync_sessions.label / events / agent / payload_hash, any file path, or daily_member_usage.project. The owner role is not even GRANTED those
--    columns, so a mistake in a function body cannot expose them. There is NO text-search parameter (it would be an oracle for prompt content).
--  * Free-text columns never pass through: intent is mapped onto a closed enum, tool/model/tool_name strings that do not match a short identifier
--    pattern are replaced or dropped, timestamps are returned as ISO-8601 UTC text.
--  * Limits are enforced HERE as well as in TypeScript: 7-day window span, 14-day lookback (7 days for prompts, whose turns are retained 7 days),
--    page sizes (page size + 1 for the next-page probe), batch of 20.
--  * Errors carry FIXED messages and never include a value: 'mcp_data: unauthorized' (28000), 'not_found' (P0002), 'invalid_argument' and
--    'window_too_large' and 'window_out_of_range' (22023), 'limit_exceeded' (54000). The service maps them; a missing row and another team's row
--    are indistinguishable.
--  * SECURITY DEFINER functions pin search_path = pg_catalog, pg_temp and schema-qualify every object (nothing resolves through public or a temp schema).
--  * No dynamic SQL (no EXECUTE), no writes, no temp tables, no sequences, no extension use.

DO $$
BEGIN
  IF current_setting('server_version_num')::int < 160000 THEN RAISE EXCEPTION 'mcp-data.sql requires PostgreSQL 16 or later'; END IF;
  IF to_regclass('public.oauth_tokens') IS NULL OR to_regclass('public.oauth_clients') IS NULL THEN RAISE EXCEPTION 'prerequisite: run the MCP OAuth migration first'; END IF;
  IF to_regclass('public.users') IS NULL OR to_regclass('public.teams') IS NULL OR to_regclass('public.members') IS NULL OR to_regclass('public.team_members') IS NULL THEN RAISE EXCEPTION 'prerequisite identity tables are missing'; END IF;
  IF to_regclass('public.sync_sessions') IS NULL OR to_regclass('public.sync_session_tools') IS NULL OR to_regclass('public.session_turns') IS NULL OR to_regclass('public.daily_member_usage') IS NULL THEN RAISE EXCEPTION 'prerequisite data tables are missing'; END IF;
END $$;

-- ── Shape check: every column a function reads must exist (CREATE FUNCTION bodies are not validated until first call) ──────────────────
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(e.t || '.' || e.c, ', ') INTO missing
  FROM (VALUES
    ('oauth_tokens','token_hash'),('oauth_tokens','kind'),('oauth_tokens','scope'),('oauth_tokens','user_id'),('oauth_tokens','client_id'),('oauth_tokens','revoked_at'),('oauth_tokens','expires_at'),('oauth_tokens','absolute_expires_at'),
    ('oauth_clients','client_id'),('oauth_clients','disabled_at'),
    ('users','id'),('users','team_id'),('users','role'),('users','active'),
    ('teams','id'),('members','id'),('members','display_name'),('team_members','team_id'),('team_members','member_id'),('team_members','role'),
    ('sync_sessions','id'),('sync_sessions','team_id'),('sync_sessions','member_id'),('sync_sessions','source'),('sync_sessions','session_id'),('sync_sessions','model'),('sync_sessions','started_at'),('sync_sessions','ended_at'),('sync_sessions','synced_at'),
    ('sync_sessions','tokens_in'),('sync_sessions','tokens_out'),('sync_sessions','tokens_cache_read'),('sync_sessions','tokens_cache_write'),('sync_sessions','api_cost'),('sync_sessions','priced'),
    ('sync_sessions','edits'),('sync_sessions','additions'),('sync_sessions','deletions'),('sync_sessions','changed_lines'),('sync_sessions','files_touched'),('sync_sessions','tool_calls'),('sync_sessions','tool_errors'),
    ('sync_sessions','rework_loops'),('sync_sessions','corrections'),('sync_sessions','abandoned'),
    ('sync_session_tools','sync_session_id'),('sync_session_tools','tool_name'),('sync_session_tools','call_count'),
    ('session_turns','id'),('session_turns','session_id'),('session_turns','org_id'),('session_turns','user_id'),('session_turns','tool'),('session_turns','model'),('session_turns','turn_index'),('session_turns','turn_role'),
    ('session_turns','input_tokens'),('session_turns','output_tokens'),('session_turns','cache_read_tokens'),('session_turns','cache_write_tokens'),('session_turns','prompt_char_len'),
    ('session_turns','has_code_block'),('session_turns','has_file_path'),('session_turns','has_traceback'),('session_turns','intent_category'),('session_turns','created_at'),
    ('daily_member_usage','day'),('daily_member_usage','team_id'),('daily_member_usage','member_id'),('daily_member_usage','tokens_in'),('daily_member_usage','tokens_out'),('daily_member_usage','cache_read_tokens'),
    ('daily_member_usage','cache_write_tokens'),('daily_member_usage','api_cost'),('daily_member_usage','edits'),('daily_member_usage','additions'),('daily_member_usage','deletions'),('daily_member_usage','changed_lines'),
    ('daily_member_usage','files_touched'),('daily_member_usage','tool_calls'),('daily_member_usage','tool_errors'),('daily_member_usage','rework_loops'),('daily_member_usage','corrections'),
    ('daily_member_usage','abandoned_count'),('daily_member_usage','session_count')
  ) AS e(t, c)
  WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.' || e.t) AND a.attname = e.c AND a.attnum > 0 AND NOT a.attisdropped);
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'tables have an unexpected shape (missing columns: %)', missing; END IF;
END $$;

-- ── The owner role: NOLOGIN, no attributes, no password, owns ONLY the mcp_data schema and its functions ─────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_data_owner') THEN
    CREATE ROLE mcp_data_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
  -- Ownership transfer needs the migration role to be able to SET ROLE to it. Kept after the migration: rollback needs it to drop the functions.
  IF NOT pg_has_role(current_user, 'mcp_data_owner', 'USAGE') OR NOT pg_has_role(current_user, 'mcp_data_owner', 'SET') THEN
    GRANT mcp_data_owner TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS mcp_data AUTHORIZATION mcp_data_owner;
REVOKE ALL ON SCHEMA mcp_data FROM PUBLIC;

-- Everything below is created AND its privileges set BY mcp_data_owner, so the owner is exactly that role (RESET ROLE at the very end).
SET LOCAL ROLE mcp_data_owner;

-- ── Internal helpers (EXECUTE is NOT granted to mcp_reader) ──────────────────────────────────────────────────────────────────────────
-- A string a stored column may pass through: short identifier charset only (client-controlled strings such as tool and model names).
CREATE OR REPLACE FUNCTION mcp_data._safe_ident(p text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN p OPERATOR(pg_catalog.~) '^[A-Za-z0-9_.:+/@-]{1,64}$' THEN p ELSE NULL END
$$;

-- Closed intent enum (the application's classifyIntent categories). Anything else, including NULL, becomes 'other': free text cannot pass through.
CREATE OR REPLACE FUNCTION mcp_data._norm_intent(p text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN p = ANY (ARRAY['bug_fix','feature','refactor','explain','test','other']) THEN p ELSE 'other' END
$$;

-- ISO-8601 UTC with millisecond precision ("2026-11-24T09:12:37.717Z"); the TypeScript contract validates exactly this shape.
CREATE OR REPLACE FUNCTION mcp_data._iso_utc(p timestamptz) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.to_char(p AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

-- Window and lookback rules: half-open [from, to); span <= 7 days (fixed); start no earlier than now() - p_lookback; end at most 5 minutes ahead.
-- The check order matches lib/mcp/data/time-window.ts.
CREATE OR REPLACE FUNCTION mcp_data._check_window(p_from timestamptz, p_to timestamptz, p_lookback interval) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_from >= p_to THEN RAISE EXCEPTION 'mcp_data: invalid_argument' USING ERRCODE = '22023'; END IF;
  IF p_to > pg_catalog.now() + interval '5 minutes' THEN RAISE EXCEPTION 'mcp_data: invalid_argument' USING ERRCODE = '22023'; END IF;
  IF p_to - p_from > interval '7 days' THEN RAISE EXCEPTION 'mcp_data: window_too_large' USING ERRCODE = '22023'; END IF;
  IF p_from < pg_catalog.now() - p_lookback THEN RAISE EXCEPTION 'mcp_data: window_out_of_range' USING ERRCODE = '22023'; END IF;
END $$;

-- The principal. Mirrors authenticateAccessToken in lib/mcp/oauth/tokens.ts (the resource/audience check is the application's: the database does
-- not know the public base URL). Returns exactly one row or raises; the caller's identity is NEVER an argument other than the token hash.
CREATE OR REPLACE FUNCTION mcp_data._resolve_scope(p_token bytea) RETURNS TABLE (user_id uuid, team_id uuid)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  IF p_token IS NULL OR pg_catalog.octet_length(p_token) <> 32 THEN RAISE EXCEPTION 'mcp_data: unauthorized' USING ERRCODE = '28000'; END IF;
  RETURN QUERY
    SELECT u.id, u.team_id
      FROM public.oauth_tokens t
      JOIN public.users u ON u.id = t.user_id
      JOIN public.oauth_clients c ON c.client_id = t.client_id
     WHERE t.token_hash = p_token AND t.kind = 'access' AND t.scope = 'mcp:read' AND t.revoked_at IS NULL
       AND t.expires_at > pg_catalog.now() AND t.absolute_expires_at > pg_catalog.now()
       AND u.active AND u.role = 'admin' AND EXISTS (SELECT 1 FROM public.teams tm WHERE tm.id = u.team_id)
       AND c.disabled_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'mcp_data: unauthorized' USING ERRCODE = '28000'; END IF;
END $$;

-- Sessions of ONE team (internal; the team is already derived). p_session NULL = list mode. Strict team match + current membership.
CREATE OR REPLACE FUNCTION mcp_data._session_rows(
  p_team uuid, p_session uuid, p_member uuid, p_from timestamptz, p_to timestamptz, p_tool text, p_model text, p_limit integer, p_after_ts timestamptz, p_after_id uuid)
RETURNS TABLE (id uuid, member_id uuid, source text, model text, started_at text, ended_at text, activity_at text,
               tokens_in bigint, tokens_out bigint, tokens_cache_read bigint, tokens_cache_write bigint, api_cost double precision, priced boolean,
               edits integer, additions integer, deletions integer, changed_lines integer, files_touched integer, tool_calls integer, tool_errors integer,
               rework_loops integer, corrections integer, abandoned boolean)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
    SELECT s.id, s.member_id, COALESCE(mcp_data._safe_ident(s.source), 'unknown'), mcp_data._safe_ident(s.model),
           mcp_data._iso_utc(s.started_at), mcp_data._iso_utc(s.ended_at),
           mcp_data._iso_utc(pg_catalog.date_trunc('milliseconds', COALESCE(s.ended_at, s.started_at, s.synced_at))),
           s.tokens_in, s.tokens_out, s.tokens_cache_read, s.tokens_cache_write, s.api_cost, s.priced,
           s.edits, s.additions, s.deletions, s.changed_lines, s.files_touched, s.tool_calls, s.tool_errors, s.rework_loops, s.corrections, s.abandoned
      FROM public.sync_sessions s
     WHERE s.team_id = p_team
       AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.team_id = p_team AND tm.member_id = s.member_id)
       AND COALESCE(s.ended_at, s.started_at, s.synced_at) >= p_from AND COALESCE(s.ended_at, s.started_at, s.synced_at) < p_to
       AND (p_session IS NULL OR s.id = p_session)
       AND (p_member IS NULL OR s.member_id = p_member)
       AND (p_tool IS NULL OR s.source = p_tool)
       AND (p_model IS NULL OR s.model = p_model)
       AND (p_after_ts IS NULL OR (pg_catalog.date_trunc('milliseconds', COALESCE(s.ended_at, s.started_at, s.synced_at)), s.id) < (p_after_ts, p_after_id))
     ORDER BY pg_catalog.date_trunc('milliseconds', COALESCE(s.ended_at, s.started_at, s.synced_at)) DESC, s.id DESC
     LIMIT p_limit;
END $$;

-- Prompt METADATA of ONE team (internal). User turns only. The text column is never referenced. The answering assistant turn contributes token counts only.
CREATE OR REPLACE FUNCTION mcp_data._prompt_rows(
  p_team uuid, p_ids bigint[], p_member uuid, p_from timestamptz, p_to timestamptz, p_intents text[], p_has_code boolean, p_has_path boolean, p_has_trace boolean,
  p_min_chars integer, p_max_chars integer, p_tool text, p_model text, p_limit integer, p_after_ts timestamptz, p_after_id bigint)
RETURNS TABLE (prompt_id bigint, session_uuid uuid, member_id uuid, turn_index integer, created_at text, tool text, model text, prompt_char_len integer,
               has_code_block boolean, has_file_path boolean, has_traceback boolean, intent_category text,
               answer_input_tokens bigint, answer_output_tokens bigint, answer_cache_read_tokens bigint, answer_cache_write_tokens bigint)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
    SELECT st.id, ss.id, ss.member_id, st.turn_index, mcp_data._iso_utc(pg_catalog.date_trunc('milliseconds', st.created_at)),
           COALESCE(mcp_data._safe_ident(st.tool), 'unknown'), mcp_data._safe_ident(st.model),
           GREATEST(COALESCE(st.prompt_char_len, 0), 0),
           COALESCE(st.has_code_block, false), COALESCE(st.has_file_path, false), COALESCE(st.has_traceback, false),
           mcp_data._norm_intent(st.intent_category),
           a.input_tokens::bigint, a.output_tokens::bigint, a.cache_read_tokens::bigint, a.cache_write_tokens::bigint
      FROM public.session_turns st
      JOIN public.sync_sessions ss
        ON ss.session_id = st.session_id AND st.org_id = ss.team_id::text AND st.user_id = ss.member_id::text AND st.tool = ss.source
      LEFT JOIN LATERAL (
        SELECT x.input_tokens, x.output_tokens, x.cache_read_tokens, x.cache_write_tokens
          FROM public.session_turns x
         WHERE x.session_id = st.session_id AND x.org_id = st.org_id AND x.user_id = st.user_id AND x.tool = st.tool
           AND x.turn_index = st.turn_index AND x.turn_role = 'assistant'
         ORDER BY x.id LIMIT 1) a ON true
     WHERE st.org_id = p_team::text
       AND ss.team_id = p_team
       AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.team_id = p_team AND tm.member_id = ss.member_id)
       AND st.turn_role = 'user'
       AND st.created_at >= p_from AND st.created_at < p_to
       AND (p_ids IS NULL OR st.id = ANY (p_ids))
       AND (p_member IS NULL OR ss.member_id = p_member)
       AND (p_intents IS NULL OR mcp_data._norm_intent(st.intent_category) = ANY (p_intents))
       AND (p_has_code IS NULL OR COALESCE(st.has_code_block, false) = p_has_code)
       AND (p_has_path IS NULL OR COALESCE(st.has_file_path, false) = p_has_path)
       AND (p_has_trace IS NULL OR COALESCE(st.has_traceback, false) = p_has_trace)
       AND (p_min_chars IS NULL OR COALESCE(st.prompt_char_len, 0) >= p_min_chars)
       AND (p_max_chars IS NULL OR COALESCE(st.prompt_char_len, 0) <= p_max_chars)
       AND (p_tool IS NULL OR st.tool = p_tool)
       AND (p_model IS NULL OR st.model = p_model)
       AND (p_after_ts IS NULL OR (pg_catalog.date_trunc('milliseconds', st.created_at), st.id) < (p_after_ts, p_after_id))
     ORDER BY pg_catalog.date_trunc('milliseconds', st.created_at) DESC, st.id DESC
     LIMIT p_limit;
END $$;

-- ── Reader-callable functions (SECURITY DEFINER: they run with mcp_data_owner's column-level read rights) ─────────────────────────────

-- 1. Developers (current members) of the caller's team, ordered by member id. p_after = keyset cursor. Page size at most 50 (+1 probe).
CREATE OR REPLACE FUNCTION mcp_data.list_developers(p_token bytea, p_limit integer, p_after uuid)
RETURNS TABLE (member_id uuid, display_name text, role text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE v_team uuid;
BEGIN
  SELECT sc.team_id INTO v_team FROM mcp_data._resolve_scope(p_token) sc;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 51 THEN RAISE EXCEPTION 'mcp_data: limit_exceeded' USING ERRCODE = '54000'; END IF;
  RETURN QUERY
    SELECT m.id, m.display_name, tm.role
      FROM public.team_members tm JOIN public.members m ON m.id = tm.member_id
     WHERE tm.team_id = v_team AND (p_after IS NULL OR m.id > p_after)
     ORDER BY m.id LIMIT p_limit;
END $$;

-- 2. Daily activity of ONE developer from the daily rollups, UTC days overlapping [p_from, p_to) (a partial day is included whole: the rollup is daily).
--    Lookback 14 days. A developer who is not a current member of the caller's team is "not found", the same as one that does not exist.
CREATE OR REPLACE FUNCTION mcp_data.developer_activity(p_token bytea, p_member uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (day text, tokens_in bigint, tokens_out bigint, cache_read_tokens bigint, cache_write_tokens bigint, api_cost double precision, session_count bigint,
               tool_calls bigint, tool_errors bigint, edits bigint, additions bigint, deletions bigint, changed_lines bigint, files_touched bigint,
               rework_loops bigint, corrections bigint, abandoned_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE v_team uuid; v_first date; v_end date;
BEGIN
  SELECT sc.team_id INTO v_team FROM mcp_data._resolve_scope(p_token) sc;
  IF p_member IS NULL THEN RAISE EXCEPTION 'mcp_data: invalid_argument' USING ERRCODE = '22023'; END IF;
  PERFORM mcp_data._check_window(p_from, p_to, interval '14 days');
  IF NOT EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.team_id = v_team AND tm.member_id = p_member) THEN RAISE EXCEPTION 'mcp_data: not_found' USING ERRCODE = 'P0002'; END IF;
  v_first := (p_from AT TIME ZONE 'UTC')::date;
  v_end := (p_to AT TIME ZONE 'UTC')::date + CASE WHEN (p_to AT TIME ZONE 'UTC')::time = time '00:00' THEN 0 ELSE 1 END;
  RETURN QUERY
    SELECT pg_catalog.to_char(d.day, 'YYYY-MM-DD'),
           COALESCE(pg_catalog.sum(d.tokens_in), 0)::bigint, COALESCE(pg_catalog.sum(d.tokens_out), 0)::bigint,
           COALESCE(pg_catalog.sum(d.cache_read_tokens), 0)::bigint, COALESCE(pg_catalog.sum(d.cache_write_tokens), 0)::bigint,
           COALESCE(pg_catalog.sum(d.api_cost), 0)::double precision, COALESCE(pg_catalog.sum(d.session_count), 0)::bigint,
           COALESCE(pg_catalog.sum(d.tool_calls), 0)::bigint, COALESCE(pg_catalog.sum(d.tool_errors), 0)::bigint,
           COALESCE(pg_catalog.sum(d.edits), 0)::bigint, COALESCE(pg_catalog.sum(d.additions), 0)::bigint, COALESCE(pg_catalog.sum(d.deletions), 0)::bigint,
           COALESCE(pg_catalog.sum(d.changed_lines), 0)::bigint, COALESCE(pg_catalog.sum(d.files_touched), 0)::bigint,
           COALESCE(pg_catalog.sum(d.rework_loops), 0)::bigint, COALESCE(pg_catalog.sum(d.corrections), 0)::bigint, COALESCE(pg_catalog.sum(d.abandoned_count), 0)::bigint
      FROM public.daily_member_usage d
     WHERE d.team_id = v_team AND d.member_id = p_member AND d.day >= v_first AND d.day < v_end
     GROUP BY d.day ORDER BY d.day;
END $$;

-- 3. Session summaries (aggregates only). Newest first, keyset (p_after_ts, p_after_id). Lookback 14 days. Page size at most 25 (+1 probe).
CREATE OR REPLACE FUNCTION mcp_data.list_sessions(p_token bytea, p_member uuid, p_from timestamptz, p_to timestamptz, p_tool text, p_model text, p_limit integer, p_after_ts timestamptz, p_after_id uuid)
RETURNS TABLE (id uuid, member_id uuid, source text, model text, started_at text, ended_at text, activity_at text,
               tokens_in bigint, tokens_out bigint, tokens_cache_read bigint, tokens_cache_write bigint, api_cost double precision, priced boolean,
               edits integer, additions integer, deletions integer, changed_lines integer, files_touched integer, tool_calls integer, tool_errors integer,
               rework_loops integer, corrections integer, abandoned boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE v_team uuid;
BEGIN
  SELECT sc.team_id INTO v_team FROM mcp_data._resolve_scope(p_token) sc;
  PERFORM mcp_data._check_window(p_from, p_to, interval '14 days');
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 26 THEN RAISE EXCEPTION 'mcp_data: limit_exceeded' USING ERRCODE = '54000'; END IF;
  IF (p_after_ts IS NULL) <> (p_after_id IS NULL) THEN RAISE EXCEPTION 'mcp_data: invalid_argument' USING ERRCODE = '22023'; END IF;
  IF (p_tool IS NOT NULL AND mcp_data._safe_ident(p_tool) IS NULL) OR (p_model IS NOT NULL AND mcp_data._safe_ident(p_model) IS NULL) THEN RAISE EXCEPTION 'mcp_data: invalid_argument' USING ERRCODE = '22023'; END IF;
  RETURN QUERY SELECT * FROM mcp_data._session_rows(v_team, NULL::uuid, p_member, p_from, p_to, p_tool, p_model, p_limit, p_after_ts, p_after_id);
END $$;

-- 4. One session: the summary plus per-tool call counts (at most 100, short identifier names only). Not found = absent, another team's, a non-member's,
--    or older than the 14-day lookback; all identical. Never reads files, label, events, agent or payload hash.
CREATE OR REPLACE FUNCTION mcp_data.session_details(p_token bytea, p_session uuid)
RETURNS TABLE (id uuid, member_id uuid, source text, model text, started_at text, ended_at text, activity_at text,
               tokens_in bigint, tokens_out bigint, tokens_cache_read bigint, tokens_cache_write bigint, api_cost double precision, priced boolean,
               edits integer, additions integer, deletions integer, changed_lines integer, files_touched integer, tool_calls integer, tool_errors integer,
               rework_loops integer, corrections integer, abandoned boolean, tools jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE v_team uuid;
BEGIN
  SELECT sc.team_id INTO v_team FROM mcp_data._resolve_scope(p_token) sc;
  IF p_session IS NULL THEN RAISE EXCEPTION 'mcp_data: invalid_argument' USING ERRCODE = '22023'; END IF;
  RETURN QUERY
    SELECT r.id, r.member_id, r.source, r.model, r.started_at, r.ended_at, r.activity_at, r.tokens_in, r.tokens_out, r.tokens_cache_read, r.tokens_cache_write, r.api_cost, r.priced,
           r.edits, r.additions, r.deletions, r.changed_lines, r.files_touched, r.tool_calls, r.tool_errors, r.rework_loops, r.corrections, r.abandoned,
           (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('tool_name', x.tool_name, 'call_count', x.call_count) ORDER BY x.call_count DESC, x.tool_name), '[]'::jsonb)
              FROM (SELECT t.tool_name, t.call_count FROM public.sync_session_tools t
                     WHERE t.sync_session_id = r.id AND mcp_data._safe_ident(t.tool_name) IS NOT NULL
                     ORDER BY t.call_count DESC, t.tool_name LIMIT 100) x)
      FROM mcp_data._session_rows(v_team, p_session, NULL::uuid, pg_catalog.now() - interval '14 days', pg_catalog.now() + interval '1 second', NULL::text, NULL::text, 1, NULL::timestamptz, NULL::uuid) r;
  IF NOT FOUND THEN RAISE EXCEPTION 'mcp_data: not_found' USING ERRCODE = 'P0002'; END IF;
END $$;

-- 5. Prompt metadata search. NO TEXT PARAMETER. Filters are booleans, a closed intent set, a character-length range, and short identifiers.
--    Lookback 7 days (turn retention). Page size at most 25 (+1 probe).
CREATE OR REPLACE FUNCTION mcp_data.search_prompt_metadata(
  p_token bytea, p_member uuid, p_from timestamptz, p_to timestamptz, p_intents text[], p_has_code boolean, p_has_path boolean, p_has_trace boolean,
  p_min_chars integer, p_max_chars integer, p_tool text, p_model text, p_limit integer, p_after_ts timestamptz, p_after_id bigint)
RETURNS TABLE (prompt_id bigint, session_uuid uuid, member_id uuid, turn_index integer, created_at text, tool text, model text, prompt_char_len integer,
               has_code_block boolean, has_file_path boolean, has_traceback boolean, intent_category text,
               answer_input_tokens bigint, answer_output_tokens bigint, answer_cache_read_tokens bigint, answer_cache_write_tokens bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE v_team uuid;
BEGIN
  SELECT sc.team_id INTO v_team FROM mcp_data._resolve_scope(p_token) sc;
  PERFORM mcp_data._check_window(p_from, p_to, interval '7 days');
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 26 THEN RAISE EXCEPTION 'mcp_data: limit_exceeded' USING ERRCODE = '54000'; END IF;
  IF (p_after_ts IS NULL) <> (p_after_id IS NULL) THEN RAISE EXCEPTION 'mcp_data: invalid_argument' USING ERRCODE = '22023'; END IF;
  IF p_intents IS NOT NULL AND (pg_catalog.cardinality(p_intents) NOT BETWEEN 1 AND 6 OR NOT (p_intents <@ ARRAY['bug_fix','feature','refactor','explain','test','other'])) THEN RAISE EXCEPTION 'mcp_data: invalid_argument' USING ERRCODE = '22023'; END IF;
  IF (p_min_chars IS NOT NULL AND p_min_chars NOT BETWEEN 0 AND 1000000) OR (p_max_chars IS NOT NULL AND p_max_chars NOT BETWEEN 0 AND 1000000)
     OR (p_min_chars IS NOT NULL AND p_max_chars IS NOT NULL AND p_min_chars > p_max_chars) THEN RAISE EXCEPTION 'mcp_data: invalid_argument' USING ERRCODE = '22023'; END IF;
  IF (p_tool IS NOT NULL AND mcp_data._safe_ident(p_tool) IS NULL) OR (p_model IS NOT NULL AND mcp_data._safe_ident(p_model) IS NULL) THEN RAISE EXCEPTION 'mcp_data: invalid_argument' USING ERRCODE = '22023'; END IF;
  RETURN QUERY SELECT * FROM mcp_data._prompt_rows(v_team, NULL::bigint[], p_member, p_from, p_to, p_intents, p_has_code, p_has_path, p_has_trace, p_min_chars, p_max_chars, p_tool, p_model, p_limit, p_after_ts, p_after_id);
END $$;

-- 6. Prompt metadata for up to 20 ids (decoded from references by the service). Same team/membership rules and 7-day retention; ids that do not
--    qualify are simply absent, so "missing" and "another team's" cannot be told apart.
CREATE OR REPLACE FUNCTION mcp_data.prompt_metadata_batch(p_token bytea, p_ids bigint[])
RETURNS TABLE (prompt_id bigint, session_uuid uuid, member_id uuid, turn_index integer, created_at text, tool text, model text, prompt_char_len integer,
               has_code_block boolean, has_file_path boolean, has_traceback boolean, intent_category text,
               answer_input_tokens bigint, answer_output_tokens bigint, answer_cache_read_tokens bigint, answer_cache_write_tokens bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE v_team uuid;
BEGIN
  SELECT sc.team_id INTO v_team FROM mcp_data._resolve_scope(p_token) sc;
  IF p_ids IS NULL OR pg_catalog.cardinality(p_ids) NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'mcp_data: limit_exceeded' USING ERRCODE = '54000'; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.unnest(p_ids) AS i(v) WHERE i.v IS NULL OR i.v < 1) THEN RAISE EXCEPTION 'mcp_data: invalid_argument' USING ERRCODE = '22023'; END IF;
  RETURN QUERY SELECT * FROM mcp_data._prompt_rows(v_team, p_ids, NULL::uuid, pg_catalog.now() - interval '7 days', pg_catalog.now() + interval '1 second', NULL::text[], NULL::boolean, NULL::boolean, NULL::boolean,
                                                   NULL::integer, NULL::integer, NULL::text, NULL::text, 20, NULL::timestamptz, NULL::bigint);
END $$;

-- ── Privileges on the functions: nobody by default ────────────────────────────────────────────────────────────────────────────────────
-- Functions default to EXECUTE for PUBLIC. Remove it from all thirteen; mcp-data.grants.sql re-grants EXECUTE on the six callable ones to mcp_reader only.
REVOKE ALL ON FUNCTION mcp_data._safe_ident(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION mcp_data._norm_intent(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION mcp_data._iso_utc(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION mcp_data._check_window(timestamptz, timestamptz, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION mcp_data._resolve_scope(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION mcp_data._session_rows(uuid, uuid, uuid, timestamptz, timestamptz, text, text, integer, timestamptz, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION mcp_data._prompt_rows(uuid, bigint[], uuid, timestamptz, timestamptz, text[], boolean, boolean, boolean, integer, integer, text, text, integer, timestamptz, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION mcp_data.list_developers(bytea, integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION mcp_data.developer_activity(bytea, uuid, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION mcp_data.list_sessions(bytea, uuid, timestamptz, timestamptz, text, text, integer, timestamptz, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION mcp_data.session_details(bytea, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION mcp_data.search_prompt_metadata(bytea, uuid, timestamptz, timestamptz, text[], boolean, boolean, boolean, integer, integer, text, text, integer, timestamptz, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION mcp_data.prompt_metadata_batch(bytea, bigint[]) FROM PUBLIC;

RESET ROLE;
