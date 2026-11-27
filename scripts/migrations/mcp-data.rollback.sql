-- Rollback for mcp-data.sql and mcp-data.grants.sql (revision 2). WRITTEN FOR REVIEW — NOT APPLIED ANYWHERE.
-- Run as the SAME login role that ran the migration (or a superuser), in ONE explicit transaction: BEGIN; \i mcp-data.rollback.sql; COMMIT;
--
-- WHAT IT REMOVES, AND NOTHING ELSE
--  * the 14 functions and the schema mcp_data (each named explicitly, no CASCADE), and what mcp_reader / mcp_data_owner were granted on them;
--  * the ten column grants and the schema USAGE given to mcp_data_owner (each REVOKE names the exact table and columns from grants.json);
--  * the five role settings given to mcp_reader (each RESET names the setting);
--  * the role mcp_data_owner, ONLY if it carries the marker comment written by mcp-data.sql (i.e. this migration created it).
--  REVERSIBILITY: grants.sql revokes nothing and proves a clean baseline first (each role in no ACL, or exactly ours; no pre-existing role settings), so
--  removing exactly what grants.sql added restores the true prior state; no unrelated privilege is ever lost or restored incorrectly.
--  It does NOT use DROP OWNED, does not drop mcp_reader (the role script that created it owns its lifecycle; mcp_reader is left without privileges or
--  settings from this migration), does not touch any table, row, other role or other privilege, and does not modify an adopted (unmarked) owner role.
--
-- AUTHORITY NEEDED (fail closed, with a clear message, if missing): the migration role must own the ten tables (column revokes), hold ADMIN OPTION on
--  mcp_data_owner (it does if it created the role; a superuser needs nothing) and CREATEROLE (DROP ROLE, ALTER ROLE ... RESET). It takes a TEMPORARY
--  membership (SET option, no INHERIT) to act as the owner for the drops, and revokes it before the end. No DROP OWNED, no CASCADE: if the owner role still
--  has dependencies the DROP ROLE fails and the whole transaction rolls back, leaving everything as it was.
--
-- DOCUMENTED PARTIAL STATES (each handled; every step checks what exists):
--   S0 nothing applied                   -> no-op (notices only)
--   S1 role only (migration aborted)     -> marked role dropped
--   S2 role + empty schema               -> schema and marked role dropped
--   S3 some functions present            -> those functions, schema, marked role dropped
--   S4 migration complete                -> as S3 with all 14 functions
--   S5 migration + grants                -> S4 plus the column grants, schema/function grants and reader settings revoked first
--   R  mcp_reader missing                -> reader steps skipped
--   A  owner role adopted (unmarked)     -> everything above except DROP ROLE; the role is left in place and a NOTICE says so
--   X  schema mcp_data owned by someone else, or holds an unexpected table/function -> ABORT, nothing changed
-- Re-running after a successful rollback is a no-op. Roll back the application code first (or leave MCP_ENABLED unset); the identity plane is unaffected.

-- ── 0. Transaction proof ──
SELECT pg_catalog.set_config('mcp_data.tx_guard', 'on', true);
DO $$
BEGIN
  IF pg_catalog.current_setting('mcp_data.tx_guard', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'this script must run inside ONE explicit transaction (BEGIN ... COMMIT); nothing was changed';
  END IF;
  IF current_user <> session_user THEN RAISE EXCEPTION 'this script must run as the login role, not under SET ROLE; nothing was changed'; END IF;
  IF pg_catalog.current_setting('transaction_read_only') <> 'off' THEN RAISE EXCEPTION 'this script needs a read-write transaction; nothing was changed'; END IF;
END $$;

-- ── 1. State check (abort on an unexpected schema; nothing has been changed yet) and temporary membership ──
DO $$
DECLARE
  v_schema oid := to_regnamespace('mcp_data')::oid;
  v_owner oid := (SELECT x.oid FROM pg_catalog.pg_roles x WHERE x.rolname = 'mcp_data_owner');
  v_me oid := (SELECT x.oid FROM pg_catalog.pg_roles x WHERE x.rolname = current_user);
  v_super boolean := (SELECT x.rolsuper FROM pg_catalog.pg_roles x WHERE x.rolname = current_user);
BEGIN
  IF v_schema IS NOT NULL THEN
    IF v_owner IS NULL OR (SELECT n.nspowner FROM pg_catalog.pg_namespace n WHERE n.oid = v_schema) <> v_owner THEN RAISE EXCEPTION 'schema mcp_data is not owned by mcp_data_owner; refusing to touch it'; END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace = v_schema) THEN RAISE EXCEPTION 'schema mcp_data holds a relation this migration did not create; refusing'; END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = v_schema AND p.proname NOT IN (
         '_safe_ident','_norm_intent','_iso_utc','_check_window','_resolve_scope','_session_rows','_prompt_rows',
         'list_developers','developer_activity','list_sessions','session_details','search_prompt_metadata','prompt_metadata_batch','list_teams')) THEN
      RAISE EXCEPTION 'schema mcp_data holds a function this migration did not create; refusing';
    END IF;
  END IF;
  IF v_owner IS NOT NULL AND NOT v_super THEN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.roleid = v_owner AND m.member = v_me AND m.admin_option) THEN
      RAISE EXCEPTION 'the rollback role lacks ADMIN OPTION on mcp_data_owner: run it as the role that ran the migration, or as a superuser';
    END IF;
    -- MEMBERSHIP PRESERVATION: snapshot every existing membership row of the migration role in mcp_data_owner first, add ONLY what is missing, and remember exactly what was
    -- added, so the end of the transaction removes only that and then proves the rows are identical to the snapshot (an existing ADMIN-only link survives).
    PERFORM pg_catalog.set_config('mcp_data.membership_snapshot', COALESCE((SELECT pg_catalog.string_agg(m.grantor::text || ':' || m.admin_option::text || ':' || m.inherit_option::text || ':' || m.set_option::text, ',' ORDER BY m.grantor) FROM pg_catalog.pg_auth_members m WHERE m.roleid = v_owner AND m.member = v_me), ''), true);
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.roleid = v_owner AND m.member = v_me AND m.set_option) THEN
      PERFORM pg_catalog.set_config('mcp_data.membership_mode', 'none', true);          -- already able to SET ROLE: nothing is added, nothing will be removed
    ELSIF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.roleid = v_owner AND m.member = v_me AND m.grantor = v_me) THEN
      GRANT mcp_data_owner TO CURRENT_USER WITH SET TRUE GRANTED BY CURRENT_USER;                                -- my own existing row: add the SET option only (admin / inherit untouched)
      PERFORM pg_catalog.set_config('mcp_data.membership_mode', 'set_option', true);
    ELSE
      GRANT mcp_data_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE GRANTED BY CURRENT_USER;                  -- no row of mine: a new one, which is removed again in full
      PERFORM pg_catalog.set_config('mcp_data.membership_mode', 'row', true);
    END IF;
  END IF;
END $$;

-- ── 2. As the migration role (owner of the existing tables): revoke exactly what grants.sql granted to mcp_data_owner ──
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'mcp_data_owner') THEN
    IF to_regclass('public.oauth_tokens') IS NOT NULL THEN REVOKE SELECT (token_hash, kind, scope, user_id, client_id, revoked_at, expires_at, absolute_expires_at) ON public.oauth_tokens FROM mcp_data_owner; END IF;
    IF to_regclass('public.oauth_clients') IS NOT NULL THEN REVOKE SELECT (client_id, disabled_at) ON public.oauth_clients FROM mcp_data_owner; END IF;
    IF to_regclass('public.users') IS NOT NULL THEN REVOKE SELECT (id, team_id, role, active) ON public.users FROM mcp_data_owner; END IF;
    IF to_regclass('public.teams') IS NOT NULL THEN REVOKE SELECT (id, name) ON public.teams FROM mcp_data_owner; END IF;
    IF to_regclass('public.members') IS NOT NULL THEN REVOKE SELECT (id, display_name) ON public.members FROM mcp_data_owner; END IF;
    IF to_regclass('public.team_members') IS NOT NULL THEN REVOKE SELECT (team_id, member_id, role) ON public.team_members FROM mcp_data_owner; END IF;
    IF to_regclass('public.sync_sessions') IS NOT NULL THEN REVOKE SELECT (id, team_id, member_id, source, session_id, model, started_at, ended_at, synced_at, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, api_cost, priced, edits, additions, deletions, changed_lines, files_touched, tool_calls, tool_errors, rework_loops, corrections, abandoned) ON public.sync_sessions FROM mcp_data_owner; END IF;
    IF to_regclass('public.sync_session_tools') IS NOT NULL THEN REVOKE SELECT (sync_session_id, tool_name, call_count) ON public.sync_session_tools FROM mcp_data_owner; END IF;
    IF to_regclass('public.session_turns') IS NOT NULL THEN REVOKE SELECT (id, session_id, org_id, user_id, tool, model, turn_index, turn_role, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, prompt_char_len, has_code_block, has_file_path, has_traceback, intent_category, created_at) ON public.session_turns FROM mcp_data_owner; END IF;
    IF to_regclass('public.daily_member_usage') IS NOT NULL THEN REVOKE SELECT (day, team_id, member_id, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, api_cost, edits, additions, deletions, changed_lines, files_touched, tool_calls, tool_errors, rework_loops, corrections, abandoned_count, session_count) ON public.daily_member_usage FROM mcp_data_owner; END IF;
    IF to_regclass('public.mcp_all_teams_admins') IS NOT NULL THEN REVOKE SELECT (user_id) ON public.mcp_all_teams_admins FROM mcp_data_owner; END IF;
    REVOKE USAGE ON SCHEMA public FROM mcp_data_owner;
  ELSE
    RAISE NOTICE 'role mcp_data_owner does not exist: no column grants to revoke';
  END IF;
  -- the reader's settings from grants.sql, one by one (the connection limit belongs to the role script)
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'mcp_reader') THEN
    ALTER ROLE mcp_reader RESET statement_timeout;
    ALTER ROLE mcp_reader RESET lock_timeout;
    ALTER ROLE mcp_reader RESET idle_in_transaction_session_timeout;
    ALTER ROLE mcp_reader RESET search_path;
    ALTER ROLE mcp_reader RESET default_transaction_read_only;
  ELSE
    RAISE NOTICE 'role mcp_reader does not exist: nothing to reset';
  END IF;
END $$;

-- ── 3. AS mcp_data_owner: revoke what it granted on the schema and functions, then drop the functions and the schema (explicit, no CASCADE) ──
DO $$
BEGIN
  IF to_regnamespace('mcp_data') IS NULL THEN
    RAISE NOTICE 'schema mcp_data does not exist: nothing to drop';
  ELSE
    SET LOCAL ROLE mcp_data_owner;
    IF current_user <> 'mcp_data_owner' OR session_user = 'mcp_data_owner' THEN RAISE EXCEPTION 'SET LOCAL ROLE did not take effect; refusing to drop as the wrong role'; END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'mcp_reader') THEN
      REVOKE ALL ON ALL FUNCTIONS IN SCHEMA mcp_data FROM mcp_reader;
      REVOKE ALL ON SCHEMA mcp_data FROM mcp_reader;
    END IF;
    -- Current signatures (each public function takes an optional trailing team uuid), then the earlier ones, so a database that still has the
    -- first version of this migration rolls back too.
    DROP FUNCTION IF EXISTS mcp_data.list_teams(bytea);
    DROP FUNCTION IF EXISTS mcp_data.list_developers(bytea, integer, uuid, uuid);
    DROP FUNCTION IF EXISTS mcp_data.developer_activity(bytea, uuid, timestamptz, timestamptz, uuid);
    DROP FUNCTION IF EXISTS mcp_data.list_sessions(bytea, uuid, timestamptz, timestamptz, text, text, integer, timestamptz, uuid, uuid);
    DROP FUNCTION IF EXISTS mcp_data.session_details(bytea, uuid, uuid);
    DROP FUNCTION IF EXISTS mcp_data.search_prompt_metadata(bytea, uuid, timestamptz, timestamptz, text[], boolean, boolean, boolean, integer, integer, text, text, integer, timestamptz, bigint, uuid);
    DROP FUNCTION IF EXISTS mcp_data.prompt_metadata_batch(bytea, bigint[], uuid);
    DROP FUNCTION IF EXISTS mcp_data._resolve_scope(bytea, uuid, boolean);
    DROP FUNCTION IF EXISTS mcp_data.list_developers(bytea, integer, uuid);
    DROP FUNCTION IF EXISTS mcp_data.developer_activity(bytea, uuid, timestamptz, timestamptz);
    DROP FUNCTION IF EXISTS mcp_data.list_sessions(bytea, uuid, timestamptz, timestamptz, text, text, integer, timestamptz, uuid);
    DROP FUNCTION IF EXISTS mcp_data.session_details(bytea, uuid);
    DROP FUNCTION IF EXISTS mcp_data.search_prompt_metadata(bytea, uuid, timestamptz, timestamptz, text[], boolean, boolean, boolean, integer, integer, text, text, integer, timestamptz, bigint);
    DROP FUNCTION IF EXISTS mcp_data.prompt_metadata_batch(bytea, bigint[]);
    DROP FUNCTION IF EXISTS mcp_data._prompt_rows(uuid, bigint[], uuid, timestamptz, timestamptz, text[], boolean, boolean, boolean, integer, integer, text, text, integer, timestamptz, bigint);
    DROP FUNCTION IF EXISTS mcp_data._session_rows(uuid, uuid, uuid, timestamptz, timestamptz, text, text, integer, timestamptz, uuid);
    DROP FUNCTION IF EXISTS mcp_data._resolve_scope(bytea);
    DROP FUNCTION IF EXISTS mcp_data._check_window(timestamptz, timestamptz, interval);
    DROP FUNCTION IF EXISTS mcp_data._iso_utc(timestamptz);
    DROP FUNCTION IF EXISTS mcp_data._norm_intent(text);
    DROP FUNCTION IF EXISTS mcp_data._safe_ident(text);
    DROP SCHEMA mcp_data;
    RESET ROLE;
  END IF;
END $$;

-- ── 4. Remove ONLY what this transaction added to the membership; prove the membership rows are exactly as they were ──
--    (If the owner role does not exist, no membership was taken and this is a no-op. DROP ROLE in section 5 then removes the role's own rows.)
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
     AND COALESCE((SELECT pg_catalog.string_agg(m.grantor::text || ':' || m.admin_option::text || ':' || m.inherit_option::text || ':' || m.set_option::text, ',' ORDER BY m.grantor) FROM pg_catalog.pg_auth_members m WHERE m.roleid = (SELECT x.oid FROM pg_catalog.pg_roles x WHERE x.rolname = 'mcp_data_owner') AND m.member = v_me), '') IS DISTINCT FROM COALESCE(pg_catalog.current_setting('mcp_data.membership_snapshot', true), '') THEN
    RAISE EXCEPTION 'the migration role''s membership rows were not restored exactly to their state before this script';
  END IF;
END $$;

-- ── 5. Drop the owner role ONLY if this migration created it (marker). A role that still has dependencies makes this fail and the transaction roll back. ──
DO $$
DECLARE v_owner oid := (SELECT x.oid FROM pg_catalog.pg_roles x WHERE x.rolname = 'mcp_data_owner');
BEGIN
  IF v_owner IS NULL THEN
    RAISE NOTICE 'role mcp_data_owner does not exist: nothing to drop';
  ELSIF pg_catalog.shobj_description(v_owner, 'pg_authid') = 'mcp-data v1: created by scripts/migrations/mcp-data.sql' THEN
    DROP ROLE mcp_data_owner;
  ELSE
    RAISE NOTICE 'role mcp_data_owner was not created by this migration (no marker): left in place';
  END IF;
END $$;
