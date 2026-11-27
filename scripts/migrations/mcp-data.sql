-- MCP data plane (Phase 3, P3-3, revision 2). WRITTEN FOR REVIEW — NOT APPLIED ANYWHERE. Touches no existing table, row, column or privilege.
-- Creates: the NOLOGIN role mcp_data_owner (or validates an exactly-matching pre-existing one), the schema mcp_data, and 13 functions
-- (6 callable by mcp_reader, 7 internal helpers). Privileges are NOT here: scripts/migrations/mcp-data.grants.sql owns them (lib/mcp/grants.json is
-- the source of truth). Rollback: scripts/migrations/mcp-data.rollback.sql. Read-only effective-privilege report: scripts/migrations/mcp-data.audit.sql.
--
-- TRANSACTION BOUNDARY (enforced by this file, not just documented)
--  * Run as the schema OWNER's LOGIN role, in ONE explicit transaction: BEGIN; \i mcp-data.sql; COMMIT;  (psql: --single-transaction with
--    ON_ERROR_STOP=1; or the future runner's BEGIN/COMMIT). Requires PostgreSQL 16 or later.
--  * SET LOCAL ROLE has NO effect outside a transaction block, and a function created while it silently had no effect would be owned by the
--    application owner role (and, being SECURITY DEFINER, would run with ITS rights). So the first two statements prove the transaction: a LOCAL
--    setting must survive from one statement to the next, otherwise the script stops before changing anything. After SET LOCAL ROLE an assertion
--    proves current_user really is mcp_data_owner, and a final assertion proves every object in mcp_data is owned by it.
--  * Everything (role creation, its marker comment, the temporary membership, the schema, the functions) commits or rolls back TOGETHER.
--
-- ROLE HANDLING
--  * mcp_data_owner is created here if absent and marked (COMMENT ON ROLE) so a rollback knows this migration created it.
--  * If it already exists it must match EXACTLY: NOLOGIN, no attributes, default connection limit, no expiry, no role settings, member of no role,
--    owner of nothing except the mcp_data schema and its functions, and not a member of / granted to anything except the migration role's own
--    ADMIN-only link, AND it must appear in no ACL at all (a clean privilege baseline). Anything else aborts the migration (fail closed). A pre-existing
--    role is adopted, NOT marked, and is never dropped by the rollback. Consequence: this migration is not re-runnable after grants.sql; roll back first.
--  * The migration role holds membership of mcp_data_owner ONLY for the duration of this transaction (SET option, no INHERIT), granted after the
--    ADMIN OPTION check; ONLY what is missing is added, and at the end only that is removed, after which the membership rows are proven identical to their
--    state before the script (an existing ADMIN-only link, with any grantor, is preserved). A superuser needs no membership and none is created.
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

-- ── 0. Transaction proof (must be the first statements; nothing above changes anything) ────────────────────────────────────────────────
SELECT pg_catalog.set_config('mcp_data.tx_guard', 'on', true);
DO $$
BEGIN
  IF pg_catalog.current_setting('mcp_data.tx_guard', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'mcp-data.sql must run inside ONE explicit transaction (BEGIN ... COMMIT); nothing was changed';
  END IF;
  IF current_user <> session_user THEN RAISE EXCEPTION 'mcp-data.sql must run as the login role, not under SET ROLE; nothing was changed'; END IF;
  IF pg_catalog.current_setting('transaction_read_only') <> 'off' THEN RAISE EXCEPTION 'mcp-data.sql needs a read-write transaction; nothing was changed'; END IF;
END $$;

-- ── 1. Prerequisites ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
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

-- ── 2. The owner role: create and mark it, or validate a pre-existing one EXACTLY (fail closed), then a TEMPORARY membership ────────────
DO $$
DECLARE
  r pg_catalog.pg_roles%ROWTYPE;
  v_schema oid := COALESCE(to_regnamespace('mcp_data')::oid, 0);
  v_me oid := (SELECT x.oid FROM pg_catalog.pg_roles x WHERE x.rolname = current_user);
  v_super boolean := (SELECT x.rolsuper FROM pg_catalog.pg_roles x WHERE x.rolname = current_user);
BEGIN
  SELECT * INTO r FROM pg_catalog.pg_roles WHERE rolname = 'mcp_data_owner';
  IF NOT FOUND THEN
    CREATE ROLE mcp_data_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT -1;
    COMMENT ON ROLE mcp_data_owner IS 'mcp-data v1: created by scripts/migrations/mcp-data.sql';   -- the marker the rollback looks for
    SELECT * INTO r FROM pg_catalog.pg_roles WHERE rolname = 'mcp_data_owner';
  ELSE
    IF r.rolsuper OR r.rolcanlogin OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolinherit OR r.rolconnlimit <> -1 OR r.rolvaliduntil IS NOT NULL THEN
      RAISE EXCEPTION 'pre-existing role mcp_data_owner has unexpected attributes; refusing (nothing was changed)';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s WHERE s.setrole = r.oid) THEN RAISE EXCEPTION 'pre-existing role mcp_data_owner has role settings; refusing'; END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid) THEN RAISE EXCEPTION 'pre-existing role mcp_data_owner is a member of another role; refusing'; END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.roleid = r.oid AND (m.member <> v_me OR m.set_option OR m.inherit_option)) THEN
      RAISE EXCEPTION 'pre-existing role mcp_data_owner has members other than this role''s ADMIN-only link; refusing';
    END IF;
    -- CLEAN PRIVILEGE BASELINE: an adopted role must appear in NO ACL (pg_shdepend 'a' entries: tables, columns, schemas, functions, databases...).
    -- Otherwise grants.sql would add to privileges this migration cannot account for, and the rollback could not restore the true prior state.
    -- (Consequence: this migration cannot be re-run after grants.sql has been applied; run the rollback first.)
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend d WHERE d.refclassid = 'pg_catalog.pg_authid'::regclass AND d.refobjid = r.oid AND d.deptype = 'a'
                AND d.dbid IN (0, (SELECT db.oid FROM pg_catalog.pg_database db WHERE db.datname = pg_catalog.current_database()))) THEN
      RAISE EXCEPTION 'pre-existing role mcp_data_owner already appears in ACL entries (existing grants); refusing (if this is a previous installation, run the rollback first)';
    END IF;
  END IF;
  -- ownership: it may own only the mcp_data schema and the functions inside it
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_shdepend d
     WHERE d.refclassid = 'pg_catalog.pg_authid'::regclass AND d.refobjid = r.oid AND d.deptype = 'o'
       AND d.dbid IN (0, (SELECT db.oid FROM pg_catalog.pg_database db WHERE db.datname = pg_catalog.current_database()))
       AND NOT COALESCE((d.classid = 'pg_catalog.pg_namespace'::regclass AND d.objid = v_schema)
                     OR (d.classid = 'pg_catalog.pg_proc'::regclass AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = d.objid AND p.pronamespace = v_schema)), false)
  ) THEN RAISE EXCEPTION 'role mcp_data_owner owns objects outside the mcp_data schema; refusing'; END IF;
  -- a pre-existing mcp_data schema must be owned by it and hold nothing but our function names (a partial earlier run)
  IF v_schema <> 0 THEN
    IF (SELECT n.nspowner FROM pg_catalog.pg_namespace n WHERE n.oid = v_schema) <> r.oid THEN RAISE EXCEPTION 'schema mcp_data exists but is not owned by mcp_data_owner; refusing'; END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace = v_schema) THEN
      RAISE EXCEPTION 'schema mcp_data holds unexpected objects; refusing';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = v_schema AND p.proname NOT IN (
         '_safe_ident','_norm_intent','_iso_utc','_check_window','_resolve_scope','_session_rows','_prompt_rows',
         'list_developers','developer_activity','list_sessions','session_details','search_prompt_metadata','prompt_metadata_batch')) THEN
      RAISE EXCEPTION 'schema mcp_data holds unexpected functions; refusing';
    END IF;
  END IF;
  -- TEMPORARY membership: ownership transfer needs the right to SET ROLE to it. Granted only after the ADMIN OPTION check, revoked at the end of this
  -- transaction (section 6). A superuser needs none. The SET option is enough: no INHERIT, so the migration role never ACQUIRES its privileges.
  IF NOT v_super THEN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.roleid = r.oid AND m.member = v_me AND m.admin_option) THEN
      RAISE EXCEPTION 'the migration role lacks ADMIN OPTION on mcp_data_owner (it must be the role that created it, or a superuser)';
    END IF;
    -- MEMBERSHIP PRESERVATION: snapshot every existing membership row of the migration role in mcp_data_owner first, add ONLY what is missing, and remember exactly what was
    -- added, so the end of the transaction removes only that and then proves the rows are identical to the snapshot (an existing ADMIN-only link survives).
    PERFORM pg_catalog.set_config('mcp_data.membership_snapshot', COALESCE((SELECT pg_catalog.string_agg(m.grantor::text || ':' || m.admin_option::text || ':' || m.inherit_option::text || ':' || m.set_option::text, ',' ORDER BY m.grantor) FROM pg_catalog.pg_auth_members m WHERE m.roleid = r.oid AND m.member = v_me), ''), true);
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.roleid = r.oid AND m.member = v_me AND m.set_option) THEN
      PERFORM pg_catalog.set_config('mcp_data.membership_mode', 'none', true);          -- already able to SET ROLE: nothing is added, nothing will be removed
    ELSIF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.roleid = r.oid AND m.member = v_me AND m.grantor = v_me) THEN
      GRANT mcp_data_owner TO CURRENT_USER WITH SET TRUE GRANTED BY CURRENT_USER;                                -- my own existing row: add the SET option only (admin / inherit untouched)
      PERFORM pg_catalog.set_config('mcp_data.membership_mode', 'set_option', true);
    ELSE
      GRANT mcp_data_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE GRANTED BY CURRENT_USER;                  -- no row of mine: a new one, which is removed again in full
      PERFORM pg_catalog.set_config('mcp_data.membership_mode', 'row', true);
    END IF;
  END IF;
END $$;

-- ── 3. The schema, created BY mcp_data_owner (AUTHORIZATION) so ownership is right from the first moment; no ownership transfer is needed ──
CREATE SCHEMA IF NOT EXISTS mcp_data AUTHORIZATION mcp_data_owner;

-- ── 4. From here every statement runs AS mcp_data_owner; the assertion proves SET LOCAL ROLE took effect ───────────────────────────────
SET LOCAL ROLE mcp_data_owner;
DO $$
BEGIN
  IF current_user <> 'mcp_data_owner' OR session_user = 'mcp_data_owner' THEN RAISE EXCEPTION 'SET LOCAL ROLE did not take effect; refusing to create functions under the wrong owner'; END IF;
END $$;
REVOKE ALL ON SCHEMA mcp_data FROM PUBLIC;

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

-- ── 5. Privileges on the functions: nobody by default (still AS mcp_data_owner) ────────────────────────────────────────────────────────
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

-- Ownership and exposure assertions (as the owner): thirteen functions, all owned by mcp_data_owner, exactly six SECURITY DEFINER, none executable by PUBLIC.
DO $$
DECLARE v_schema oid := to_regnamespace('mcp_data')::oid; v_owner oid := 'mcp_data_owner'::regrole::oid;
BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = v_schema) <> 13 THEN RAISE EXCEPTION 'mcp_data must hold exactly 13 functions'; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = v_schema AND p.proowner <> v_owner) THEN RAISE EXCEPTION 'a function in mcp_data is not owned by mcp_data_owner'; END IF;
  IF (SELECT n.nspowner FROM pg_catalog.pg_namespace n WHERE n.oid = v_schema) <> v_owner THEN RAISE EXCEPTION 'schema mcp_data is not owned by mcp_data_owner'; END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = v_schema AND p.prosecdef) <> 6 THEN RAISE EXCEPTION 'exactly six functions must be SECURITY DEFINER'; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = v_schema AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(p.proconfig) c WHERE c = 'search_path=pg_catalog, pg_temp')) THEN
    RAISE EXCEPTION 'every function in mcp_data must pin search_path = pg_catalog, pg_temp';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a WHERE p.pronamespace = v_schema AND a.grantee = 0) THEN
    RAISE EXCEPTION 'a function in mcp_data is still executable by PUBLIC';
  END IF;
END $$;

RESET ROLE;

-- ── 6. Remove ONLY what this transaction added to the membership, and prove the membership rows are exactly as they were ──────────────────
DO $$
DECLARE v_me oid := (SELECT x.oid FROM pg_catalog.pg_roles x WHERE x.rolname = current_user);
BEGIN
  IF NULLIF(pg_catalog.current_setting('mcp_data.membership_mode', true), '') = 'row' THEN
    REVOKE mcp_data_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;
  ELSIF NULLIF(pg_catalog.current_setting('mcp_data.membership_mode', true), '') = 'set_option' THEN
    REVOKE SET OPTION FOR mcp_data_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;   -- removes only the option this transaction added
  END IF;
  IF current_user <> session_user THEN RAISE EXCEPTION 'the session role was not restored'; END IF;
  IF NULLIF(pg_catalog.current_setting('mcp_data.membership_mode', true), '') IS NOT NULL
     AND COALESCE((SELECT pg_catalog.string_agg(m.grantor::text || ':' || m.admin_option::text || ':' || m.inherit_option::text || ':' || m.set_option::text, ',' ORDER BY m.grantor) FROM pg_catalog.pg_auth_members m WHERE m.roleid = 'mcp_data_owner'::regrole AND m.member = v_me), '') IS DISTINCT FROM COALESCE(pg_catalog.current_setting('mcp_data.membership_snapshot', true), '') THEN
    RAISE EXCEPTION 'the migration role''s membership rows were not restored exactly to their state before this script';
  END IF;
  IF NOT (SELECT x.rolsuper FROM pg_catalog.pg_roles x WHERE x.rolname = current_user)
     AND NULLIF(pg_catalog.current_setting('mcp_data.membership_mode', true), '') IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.roleid = 'mcp_data_owner'::regrole AND m.member = v_me AND m.grantor = v_me AND m.set_option AND NULLIF(pg_catalog.current_setting('mcp_data.membership_mode', true), '') <> 'none') THEN
    RAISE EXCEPTION 'the migration role still holds the SET option this transaction added';
  END IF;
END $$;
