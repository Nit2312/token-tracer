-- MCP data plane privileges (Phase 3, P3-3, revision 3). WRITTEN FOR REVIEW — NOT APPLIED ANYWHERE.
-- The GRANT / ALTER ROLE statements are GENERATED from lib/mcp/grants.json (the source of truth); tests/mcp-data-sql.test.ts fails if this file and
-- grants.json disagree. Run as the schema OWNER's LOGIN role, in ONE explicit transaction (BEGIN; \i mcp-data.grants.sql; COMMIT;), AFTER
-- scripts/migrations/mcp-data.sql and AFTER mcp_reader exists (created by the role script with a password taken from the environment, NOINHERIT, connection
-- limit 5; no credential is ever in this file).
--
-- Requires PostgreSQL 16 or later (pg_auth_members.set_option / inherit_option, SET / INHERIT grant options).
--
-- PRIVILEGE BASELINE (revision 3): THIS FILE REVOKES NOTHING. It proves a clean baseline, adds exactly the allowlisted grants, and proves the result.
--  * BEFORE any change (section 2): for BOTH roles, every object on which they appear in any ACL (pg_shdepend 'a' entries: tables, columns, schemas,
--    functions, databases, types, languages, parameters...) must be EMPTY or exactly the expected set (a re-run); a partial overlap or any unexpected
--    entry (for example a pre-existing SELECT on session_turns.prompt_text_sanitized) ABORTS the transaction. The reader may have no role settings (or exactly
--    ours) and no per-database settings. mcp_data_owner's EFFECTIVE column SELECT (PUBLIC-derived included) must be a subset of the allowlist, with no write,
--    table-level, sequence, CREATE or SECURITY DEFINER reach. So a role that would lose or keep unrelated privileges is never touched, and the rollback
--    (which removes exactly what is added here) restores the true prior state.
--  * AFTER the grants (section 6): the same footprints must be EXACTLY the expected sets, the owner's effective column SELECT must equal the allowlist
--    exactly, and the reader's effective privileges (PUBLIC included) must stay least-privilege.
--
-- WHY IT SWITCHES ROLE: EXECUTE on the functions and USAGE on schema mcp_data belong to mcp_data_owner, so they must be granted BY it. The migration role
-- takes a TEMPORARY membership (SET option, no INHERIT) after the ADMIN OPTION check, uses SET LOCAL ROLE for exactly those statements, and revokes it
-- before the end. Column grants on the existing tables are made by their owner, the migration role itself.
--
-- mcp_data_owner  = COLUMN-level SELECT on the columns the functions read. NOT granted: session_turns.prompt_text_sanitized, sync_sessions.label /
--                   events / agent / payload_hash, daily_member_usage.project, any path column, credentials, audit_log, prompt_embeddings, daily_org_*.
-- mcp_reader      = USAGE on schema mcp_data + EXECUTE on seven functions. No privilege on any table.
-- PUBLIC is NOT revoked globally (see MCP.md 16.10): its grants apply to the roles and are checked, not removed; CONNECT, TEMPORARY, USAGE on public and
-- EXECUTE on ordinary functions remain residual, as do the PUBLIC-by-default built-ins pg_cancel_backend, pg_terminate_backend (self-scoped: they only
-- act on the caller's own sessions) and pg_logical_emit_message (can write a WAL message of arbitrary size, even in a read-only transaction; no data access): reported by the audit (6b), not fatal and are reported by mcp-data.audit.sql.

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


-- ── 1. Validate both roles, the schema and the functions EXACTLY (fail closed; no change) ──
DO $$
DECLARE
  o pg_catalog.pg_roles%ROWTYPE;
  rd pg_catalog.pg_roles%ROWTYPE;
  v_schema oid := to_regnamespace('mcp_data')::oid;
  v_me oid := (SELECT x.oid FROM pg_catalog.pg_roles x WHERE x.rolname = current_user);
BEGIN
  SELECT * INTO o FROM pg_catalog.pg_roles WHERE rolname = 'mcp_data_owner';
  IF NOT FOUND THEN RAISE EXCEPTION 'mcp_data_owner is missing: run scripts/migrations/mcp-data.sql first'; END IF;
  SELECT * INTO rd FROM pg_catalog.pg_roles WHERE rolname = 'mcp_reader';
  IF NOT FOUND THEN RAISE EXCEPTION 'mcp_reader is missing: provision it with the role script first'; END IF;
  IF v_schema IS NULL THEN RAISE EXCEPTION 'schema mcp_data is missing: run scripts/migrations/mcp-data.sql first'; END IF;
  -- owner: exactly what the migration creates
  IF o.rolsuper OR o.rolcanlogin OR o.rolcreatedb OR o.rolcreaterole OR o.rolreplication OR o.rolbypassrls OR o.rolinherit OR o.rolconnlimit <> -1 OR o.rolvaliduntil IS NOT NULL THEN RAISE EXCEPTION 'mcp_data_owner has unexpected attributes'; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s WHERE s.setrole = o.oid) THEN RAISE EXCEPTION 'mcp_data_owner has role settings'; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = o.oid) THEN RAISE EXCEPTION 'mcp_data_owner is a member of another role'; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.roleid = o.oid AND (m.member <> v_me OR m.set_option OR m.inherit_option)) THEN RAISE EXCEPTION 'mcp_data_owner has members besides the migration role''s ADMIN-only link'; END IF;
  IF (SELECT n.nspowner FROM pg_catalog.pg_namespace n WHERE n.oid = v_schema) <> o.oid THEN RAISE EXCEPTION 'schema mcp_data is not owned by mcp_data_owner'; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend d WHERE d.refclassid = 'pg_catalog.pg_authid'::regclass AND d.refobjid = o.oid AND d.deptype = 'o'
       AND d.dbid IN (0, (SELECT db.oid FROM pg_catalog.pg_database db WHERE db.datname = pg_catalog.current_database()))
       AND NOT COALESCE((d.classid = 'pg_catalog.pg_namespace'::regclass AND d.objid = v_schema)
                     OR (d.classid = 'pg_catalog.pg_proc'::regclass AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = d.objid AND p.pronamespace = v_schema)), false)) THEN
    RAISE EXCEPTION 'mcp_data_owner owns objects outside the mcp_data schema';
  END IF;
  -- reader: a plain LOGIN role provisioned by the role script (NOINHERIT, the expected connection limit), no memberships either way, nothing owned
  IF NOT rd.rolcanlogin OR rd.rolsuper OR rd.rolcreatedb OR rd.rolcreaterole OR rd.rolreplication OR rd.rolbypassrls OR rd.rolinherit OR rd.rolvaliduntil IS NOT NULL THEN RAISE EXCEPTION 'mcp_reader has unexpected attributes (expected LOGIN NOINHERIT, nothing else)'; END IF;
  IF rd.rolconnlimit <> 5 THEN RAISE EXCEPTION 'mcp_reader must be provisioned with CONNECTION LIMIT 5 by the role script (this file does not change it)'; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = rd.oid) THEN RAISE EXCEPTION 'mcp_reader is a member of another role'; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.roleid = rd.oid AND (m.member <> v_me OR m.set_option OR m.inherit_option)) THEN RAISE EXCEPTION 'mcp_reader has members besides the migration role''s ADMIN-only link (the implicit link CREATE ROLE gives its creator)'; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend d WHERE d.refclassid = 'pg_catalog.pg_authid'::regclass AND d.refobjid = rd.oid AND d.deptype = 'o'
       AND d.dbid IN (0, (SELECT db.oid FROM pg_catalog.pg_database db WHERE db.datname = pg_catalog.current_database()))) THEN RAISE EXCEPTION 'mcp_reader owns objects'; END IF;
  -- functions: fourteen, owned by the owner, search_path pinned, nothing executable by PUBLIC
  IF (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = v_schema) <> 14 THEN RAISE EXCEPTION 'mcp_data must hold exactly 14 functions'; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = v_schema AND p.proowner <> o.oid) THEN RAISE EXCEPTION 'a function in mcp_data is not owned by mcp_data_owner'; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a WHERE p.pronamespace = v_schema AND a.grantee = 0) THEN RAISE EXCEPTION 'a function in mcp_data is executable by PUBLIC'; END IF;
END $$;

-- ── 2. PRIVILEGE BASELINE (still no change): empty, or exactly ours; anything else aborts ──

DO $$
DECLARE
  o oid := 'mcp_data_owner'::regrole::oid; rd oid := 'mcp_reader'::regrole::oid; v_schema oid := to_regnamespace('mcp_data')::oid;
  v_db oid := (SELECT db.oid FROM pg_catalog.pg_database db WHERE db.datname = pg_catalog.current_database());
  n_bad int; n_total int; n_expected int; n_extra int; n_eff int; n_allow int; v_cfg text[]; v_ours boolean;
BEGIN
  -- (a) ACL FOOTPRINT: every object on which a role appears in ANY ACL (pg_shdepend, deptype 'a': tables, columns, schemas, functions, databases, types,
  -- languages, parameters, large objects, default ACLs...). Baseline rule: EMPTY, or exactly the expected set (a re-run). Anything else, including a PARTIAL overlap, aborts BEFORE a single change, so the rollback restores the true prior state.
  WITH allow(t, c) AS (VALUES
      ('oauth_tokens','token_hash'),
      ('oauth_tokens','kind'),
      ('oauth_tokens','scope'),
      ('oauth_tokens','user_id'),
      ('oauth_tokens','client_id'),
      ('oauth_tokens','revoked_at'),
      ('oauth_tokens','expires_at'),
      ('oauth_tokens','absolute_expires_at'),
      ('oauth_clients','client_id'),
      ('oauth_clients','disabled_at'),
      ('users','id'),
      ('users','team_id'),
      ('users','role'),
      ('users','active'),
      ('teams','id'),
      ('teams','name'),
      ('mcp_all_teams_admins','user_id'),
      ('members','id'),
      ('members','display_name'),
      ('team_members','team_id'),
      ('team_members','member_id'),
      ('team_members','role'),
      ('sync_sessions','id'),
      ('sync_sessions','team_id'),
      ('sync_sessions','member_id'),
      ('sync_sessions','source'),
      ('sync_sessions','session_id'),
      ('sync_sessions','model'),
      ('sync_sessions','started_at'),
      ('sync_sessions','ended_at'),
      ('sync_sessions','synced_at'),
      ('sync_sessions','tokens_in'),
      ('sync_sessions','tokens_out'),
      ('sync_sessions','tokens_cache_read'),
      ('sync_sessions','tokens_cache_write'),
      ('sync_sessions','api_cost'),
      ('sync_sessions','priced'),
      ('sync_sessions','edits'),
      ('sync_sessions','additions'),
      ('sync_sessions','deletions'),
      ('sync_sessions','changed_lines'),
      ('sync_sessions','files_touched'),
      ('sync_sessions','tool_calls'),
      ('sync_sessions','tool_errors'),
      ('sync_sessions','rework_loops'),
      ('sync_sessions','corrections'),
      ('sync_sessions','abandoned'),
      ('sync_session_tools','sync_session_id'),
      ('sync_session_tools','tool_name'),
      ('sync_session_tools','call_count'),
      ('session_turns','id'),
      ('session_turns','session_id'),
      ('session_turns','org_id'),
      ('session_turns','user_id'),
      ('session_turns','tool'),
      ('session_turns','model'),
      ('session_turns','turn_index'),
      ('session_turns','turn_role'),
      ('session_turns','input_tokens'),
      ('session_turns','output_tokens'),
      ('session_turns','cache_read_tokens'),
      ('session_turns','cache_write_tokens'),
      ('session_turns','prompt_char_len'),
      ('session_turns','has_code_block'),
      ('session_turns','has_file_path'),
      ('session_turns','has_traceback'),
      ('session_turns','intent_category'),
      ('session_turns','created_at'),
      ('daily_member_usage','day'),
      ('daily_member_usage','team_id'),
      ('daily_member_usage','member_id'),
      ('daily_member_usage','tokens_in'),
      ('daily_member_usage','tokens_out'),
      ('daily_member_usage','cache_read_tokens'),
      ('daily_member_usage','cache_write_tokens'),
      ('daily_member_usage','api_cost'),
      ('daily_member_usage','edits'),
      ('daily_member_usage','additions'),
      ('daily_member_usage','deletions'),
      ('daily_member_usage','changed_lines'),
      ('daily_member_usage','files_touched'),
      ('daily_member_usage','tool_calls'),
      ('daily_member_usage','tool_errors'),
      ('daily_member_usage','rework_loops'),
      ('daily_member_usage','corrections'),
      ('daily_member_usage','abandoned_count'),
      ('daily_member_usage','session_count')),
  fp AS (SELECT d.classid, d.objid, d.objsubid FROM pg_catalog.pg_shdepend d
          WHERE d.refclassid = 'pg_catalog.pg_authid'::regclass AND d.refobjid = o AND d.deptype = 'a' AND d.dbid IN (0, v_db)),
  judged AS (SELECT fp.classid, fp.objid, COALESCE(
      (fp.classid = 'pg_catalog.pg_class'::regclass AND fp.objsubid > 0 AND EXISTS (
         SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
           JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = fp.objsubid JOIN allow ON allow.t = c.relname AND allow.c = a.attname
          WHERE c.oid = fp.objid AND ns.nspname = 'public'))
      OR (fp.classid = 'pg_catalog.pg_namespace'::regclass AND fp.objid = 'public'::regnamespace::oid), false) AS ok FROM fp)
  SELECT count(*) FILTER (WHERE NOT ok), count(*), (SELECT count(*) FROM allow) + 1 INTO n_bad, n_total, n_expected FROM judged;
  IF n_bad > 0 THEN RAISE EXCEPTION 'mcp_data_owner appears in ACL entries outside the expected set (a pre-existing grant); refusing, nothing was changed'; END IF;
  IF n_total NOT IN (0, n_expected) THEN RAISE EXCEPTION 'mcp_data_owner already holds PART of the expected grants (partial baseline); refusing, nothing was changed'; END IF;
  WITH fp AS (SELECT d.classid, d.objid FROM pg_catalog.pg_shdepend d WHERE d.refclassid = 'pg_catalog.pg_authid'::regclass AND d.refobjid = rd AND d.deptype = 'a' AND d.dbid IN (0, v_db)),
  judged AS (SELECT fp.classid, COALESCE(
      (fp.classid = 'pg_catalog.pg_namespace'::regclass AND fp.objid = v_schema)
      OR (fp.classid = 'pg_catalog.pg_proc'::regclass AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = fp.objid AND p.pronamespace = v_schema AND p.proname IN ('list_developers', 'developer_activity', 'list_sessions', 'session_details', 'search_prompt_metadata', 'prompt_metadata_batch', 'list_teams')))
      OR (fp.classid = 'pg_catalog.pg_database'::regclass AND fp.objid = v_db), false) AS ok FROM fp)   -- an explicit CONNECT on this database is harmless and allowed
  SELECT count(*) FILTER (WHERE NOT ok), count(*) FILTER (WHERE classid <> 'pg_catalog.pg_database'::regclass) INTO n_bad, n_total FROM judged;
  IF n_bad > 0 THEN RAISE EXCEPTION 'mcp_reader appears in ACL entries outside the expected set (a pre-existing grant); refusing, nothing was changed'; END IF;
  IF n_total NOT IN (0, 8) THEN RAISE EXCEPTION 'mcp_reader already holds PART of the expected grants (partial baseline); refusing, nothing was changed'; END IF;
  -- (b) ROLE SETTINGS of the reader: none at all (or exactly ours), and never per-database; the owner has none (checked in section 1).
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s WHERE s.setrole IN (o, rd) AND s.setdatabase <> 0) THEN RAISE EXCEPTION 'a role has per-database settings; refusing'; END IF;
  SELECT COALESCE((SELECT pg_catalog.array_agg(u.c ORDER BY u.c) FROM pg_catalog.pg_db_role_setting s, pg_catalog.unnest(s.setconfig) AS u(c) WHERE s.setrole = rd), ARRAY[]::text[]) INTO v_cfg;
  v_ours := pg_catalog.cardinality(v_cfg) = 5
    AND v_cfg @> ARRAY['statement_timeout=5000', 'lock_timeout=2000', 'idle_in_transaction_session_timeout=10000', 'default_transaction_read_only=on']
    AND EXISTS (SELECT 1 FROM pg_catalog.unnest(v_cfg) u(c) WHERE u.c = 'search_path=pg_catalog, pg_temp');
  IF pg_catalog.cardinality(v_cfg) > 0 AND NOT v_ours THEN RAISE EXCEPTION 'mcp_reader already has role settings that are not ours; refusing (the rollback could not restore them)'; END IF;
  -- (c) mcp_data_owner EFFECTIVE privileges, PUBLIC-derived ones included. SELECT columns: a subset of the allowlist; nothing else of any kind.
  WITH allow(t, c) AS (VALUES
      ('oauth_tokens','token_hash'),
      ('oauth_tokens','kind'),
      ('oauth_tokens','scope'),
      ('oauth_tokens','user_id'),
      ('oauth_tokens','client_id'),
      ('oauth_tokens','revoked_at'),
      ('oauth_tokens','expires_at'),
      ('oauth_tokens','absolute_expires_at'),
      ('oauth_clients','client_id'),
      ('oauth_clients','disabled_at'),
      ('users','id'),
      ('users','team_id'),
      ('users','role'),
      ('users','active'),
      ('teams','id'),
      ('teams','name'),
      ('mcp_all_teams_admins','user_id'),
      ('members','id'),
      ('members','display_name'),
      ('team_members','team_id'),
      ('team_members','member_id'),
      ('team_members','role'),
      ('sync_sessions','id'),
      ('sync_sessions','team_id'),
      ('sync_sessions','member_id'),
      ('sync_sessions','source'),
      ('sync_sessions','session_id'),
      ('sync_sessions','model'),
      ('sync_sessions','started_at'),
      ('sync_sessions','ended_at'),
      ('sync_sessions','synced_at'),
      ('sync_sessions','tokens_in'),
      ('sync_sessions','tokens_out'),
      ('sync_sessions','tokens_cache_read'),
      ('sync_sessions','tokens_cache_write'),
      ('sync_sessions','api_cost'),
      ('sync_sessions','priced'),
      ('sync_sessions','edits'),
      ('sync_sessions','additions'),
      ('sync_sessions','deletions'),
      ('sync_sessions','changed_lines'),
      ('sync_sessions','files_touched'),
      ('sync_sessions','tool_calls'),
      ('sync_sessions','tool_errors'),
      ('sync_sessions','rework_loops'),
      ('sync_sessions','corrections'),
      ('sync_sessions','abandoned'),
      ('sync_session_tools','sync_session_id'),
      ('sync_session_tools','tool_name'),
      ('sync_session_tools','call_count'),
      ('session_turns','id'),
      ('session_turns','session_id'),
      ('session_turns','org_id'),
      ('session_turns','user_id'),
      ('session_turns','tool'),
      ('session_turns','model'),
      ('session_turns','turn_index'),
      ('session_turns','turn_role'),
      ('session_turns','input_tokens'),
      ('session_turns','output_tokens'),
      ('session_turns','cache_read_tokens'),
      ('session_turns','cache_write_tokens'),
      ('session_turns','prompt_char_len'),
      ('session_turns','has_code_block'),
      ('session_turns','has_file_path'),
      ('session_turns','has_traceback'),
      ('session_turns','intent_category'),
      ('session_turns','created_at'),
      ('daily_member_usage','day'),
      ('daily_member_usage','team_id'),
      ('daily_member_usage','member_id'),
      ('daily_member_usage','tokens_in'),
      ('daily_member_usage','tokens_out'),
      ('daily_member_usage','cache_read_tokens'),
      ('daily_member_usage','cache_write_tokens'),
      ('daily_member_usage','api_cost'),
      ('daily_member_usage','edits'),
      ('daily_member_usage','additions'),
      ('daily_member_usage','deletions'),
      ('daily_member_usage','changed_lines'),
      ('daily_member_usage','files_touched'),
      ('daily_member_usage','tool_calls'),
      ('daily_member_usage','tool_errors'),
      ('daily_member_usage','rework_loops'),
      ('daily_member_usage','corrections'),
      ('daily_member_usage','abandoned_count'),
      ('daily_member_usage','session_count')),
  eff AS (SELECT ns.nspname AS s, c.relname AS t, a.attname AS col FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
            JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
           WHERE c.relkind IN ('r','p','v','m','f') AND ns.nspname NOT IN ('pg_catalog','information_schema') AND ns.nspname NOT LIKE 'pg\_%' AND CASE WHEN c.relkind IN ('r','p','v','m','f') THEN pg_catalog.has_column_privilege('mcp_data_owner', c.oid, a.attnum, 'SELECT') ELSE false END)
  SELECT count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM allow WHERE allow.t = eff.t AND allow.c = eff.col AND eff.s = 'public')), count(*), (SELECT count(*) FROM allow) INTO n_extra, n_eff, n_allow FROM eff;
  IF n_extra > 0 THEN RAISE EXCEPTION 'mcp_data_owner can read columns beyond the allowlist (a grant, or PUBLIC, e.g. prompt_text_sanitized); refusing'; END IF;
  -- (before the grants the effective set may be smaller)
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
              WHERE c.relkind IN ('r','p','v','m','f') AND ns.nspname NOT IN ('pg_catalog','information_schema') AND ns.nspname NOT LIKE 'pg\_%'
                AND (CASE WHEN c.relkind IN ('r','p','v','m','f') THEN pg_catalog.has_table_privilege('mcp_data_owner', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') ELSE false END OR CASE WHEN c.relkind IN ('r','p','v','m','f') THEN pg_catalog.has_any_column_privilege('mcp_data_owner', c.oid, 'INSERT,UPDATE,REFERENCES') ELSE false END)) THEN
    RAISE EXCEPTION 'mcp_data_owner has a write or table-level privilege (possibly through PUBLIC); refusing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace WHERE c.relkind = 'S' AND ns.nspname NOT IN ('pg_catalog','information_schema') AND ns.nspname NOT LIKE 'pg\_%' AND CASE WHEN c.relkind = 'S' THEN pg_catalog.has_sequence_privilege('mcp_data_owner', c.oid, 'USAGE,SELECT,UPDATE') ELSE false END) THEN
    RAISE EXCEPTION 'mcp_data_owner has a sequence privilege; refusing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace ns WHERE ns.nspname NOT IN ('pg_catalog','information_schema') AND ns.nspname NOT LIKE 'pg\_%' AND ns.nspname <> 'mcp_data' AND pg_catalog.has_schema_privilege('mcp_data_owner', ns.oid, 'CREATE'))
     OR pg_catalog.has_database_privilege('mcp_data_owner', pg_catalog.current_database(), 'CREATE') THEN
    RAISE EXCEPTION 'mcp_data_owner can CREATE in a schema other than mcp_data, or in the database; refusing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace
              WHERE ns.nspname NOT IN ('pg_catalog','information_schema') AND ns.nspname NOT LIKE 'pg\_%' AND ns.nspname <> 'mcp_data' AND p.prosecdef AND pg_catalog.has_function_privilege('mcp_data_owner', p.oid, 'EXECUTE')
                AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')) THEN
    RAISE EXCEPTION 'mcp_data_owner can execute a SECURITY DEFINER function outside mcp_data (possibly through PUBLIC); refusing';
  END IF;
  -- (d) mcp_reader EFFECTIVE privileges, PUBLIC included (fail closed; no names in the message, run mcp-data.audit.sql for the list)
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
              WHERE c.relkind IN ('r','p','v','m','f') AND ns.nspname NOT IN ('pg_catalog','information_schema') AND ns.nspname NOT LIKE 'pg\_%'
                AND (CASE WHEN c.relkind IN ('r','p','v','m','f') THEN pg_catalog.has_table_privilege('mcp_reader', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') ELSE false END
                     OR CASE WHEN c.relkind IN ('r','p','v','m','f') THEN pg_catalog.has_any_column_privilege('mcp_reader', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES') ELSE false END)) THEN
    RAISE EXCEPTION 'mcp_reader has an effective table or column privilege (possibly through PUBLIC); see mcp-data.audit.sql';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
              WHERE c.relkind = 'S' AND ns.nspname NOT IN ('pg_catalog','information_schema') AND ns.nspname NOT LIKE 'pg\_%'
                AND CASE WHEN c.relkind = 'S' THEN pg_catalog.has_sequence_privilege('mcp_reader', c.oid, 'USAGE,SELECT,UPDATE') ELSE false END) THEN
    RAISE EXCEPTION 'mcp_reader has an effective sequence privilege; see mcp-data.audit.sql';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace ns WHERE ns.nspname NOT IN ('pg_catalog','information_schema') AND ns.nspname NOT LIKE 'pg\_%' AND pg_catalog.has_schema_privilege('mcp_reader', ns.oid, 'CREATE'))
     OR pg_catalog.has_database_privilege('mcp_reader', pg_catalog.current_database(), 'CREATE') THEN
    RAISE EXCEPTION 'mcp_reader can CREATE in a schema or the database; see mcp-data.audit.sql';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = v_schema AND pg_catalog.has_function_privilege('mcp_reader', p.oid, 'EXECUTE')) NOT IN (0, 7) THEN RAISE EXCEPTION 'mcp_reader can already execute some, but not exactly the seven, functions in mcp_data (possibly through PUBLIC); refusing'; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace
              WHERE ns.nspname NOT IN ('pg_catalog','information_schema') AND ns.nspname NOT LIKE 'pg\_%'
                AND pg_catalog.has_function_privilege('mcp_reader', p.oid, 'EXECUTE')
                AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
                AND ((ns.nspname = 'mcp_data' AND p.proname NOT IN ('list_developers', 'developer_activity', 'list_sessions', 'session_details', 'search_prompt_metadata', 'prompt_metadata_batch', 'list_teams')) OR (ns.nspname <> 'mcp_data' AND p.prosecdef))) THEN
    RAISE EXCEPTION 'mcp_reader can execute a function beyond the seven approved ones, or a SECURITY DEFINER function elsewhere (possibly through PUBLIC); see mcp-data.audit.sql';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'pg_catalog'::regnamespace AND pg_catalog.has_function_privilege('mcp_reader', p.oid, 'EXECUTE')
              AND p.proname IN ('pg_read_file','pg_read_binary_file','pg_ls_dir','pg_stat_file','lo_import','lo_export','pg_reload_conf','pg_rotate_logfile','pg_switch_wal','pg_create_restore_point')) THEN
    RAISE EXCEPTION 'mcp_reader can execute a dangerous built-in function; see mcp-data.audit.sql';
  END IF;
END $$;

-- ── 3. Temporary membership of the owner role (needs ADMIN OPTION; a superuser needs none) ──
DO $$
DECLARE
  o oid := 'mcp_data_owner'::regrole::oid;
  v_me oid := (SELECT x.oid FROM pg_catalog.pg_roles x WHERE x.rolname = current_user);
  v_super boolean := (SELECT x.rolsuper FROM pg_catalog.pg_roles x WHERE x.rolname = current_user);
BEGIN
  IF NOT v_super THEN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.roleid = o AND m.member = v_me AND m.admin_option) THEN RAISE EXCEPTION 'the migration role lacks ADMIN OPTION on mcp_data_owner'; END IF;
    -- MEMBERSHIP PRESERVATION: snapshot every existing membership row of the migration role in mcp_data_owner first, add ONLY what is missing, and remember exactly what was
    -- added, so the end of the transaction removes only that and then proves the rows are identical to the snapshot (an existing ADMIN-only link survives).
    PERFORM pg_catalog.set_config('mcp_data.membership_snapshot', COALESCE((SELECT pg_catalog.string_agg(m.grantor::text || ':' || m.admin_option::text || ':' || m.inherit_option::text || ':' || m.set_option::text, ',' ORDER BY m.grantor) FROM pg_catalog.pg_auth_members m WHERE m.roleid = o AND m.member = v_me), ''), true);
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.roleid = o AND m.member = v_me AND m.set_option) THEN
      PERFORM pg_catalog.set_config('mcp_data.membership_mode', 'none', true);          -- already able to SET ROLE: nothing is added, nothing will be removed
    ELSIF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.roleid = o AND m.member = v_me AND m.grantor = v_me) THEN
      GRANT mcp_data_owner TO CURRENT_USER WITH SET TRUE GRANTED BY CURRENT_USER;                                -- my own existing row: add the SET option only (admin / inherit untouched)
      PERFORM pg_catalog.set_config('mcp_data.membership_mode', 'set_option', true);
    ELSE
      GRANT mcp_data_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE GRANTED BY CURRENT_USER;                  -- no row of mine: a new one, which is removed again in full
      PERFORM pg_catalog.set_config('mcp_data.membership_mode', 'row', true);
    END IF;
  END IF;
END $$;

-- ── 4. As the migration role (owner of the existing tables): column grants. ADDITIVE ONLY: nothing is revoked. ──
GRANT USAGE ON SCHEMA public TO mcp_data_owner;
GRANT SELECT (token_hash, kind, scope, user_id, client_id, revoked_at, expires_at, absolute_expires_at) ON public.oauth_tokens TO mcp_data_owner;
GRANT SELECT (client_id, disabled_at) ON public.oauth_clients TO mcp_data_owner;
GRANT SELECT (id, team_id, role, active) ON public.users TO mcp_data_owner;
GRANT SELECT (id, name) ON public.teams TO mcp_data_owner;
GRANT SELECT (id, display_name) ON public.members TO mcp_data_owner;
GRANT SELECT (team_id, member_id, role) ON public.team_members TO mcp_data_owner;
GRANT SELECT (id, team_id, member_id, source, session_id, model, started_at, ended_at, synced_at, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, api_cost, priced, edits, additions, deletions, changed_lines, files_touched, tool_calls, tool_errors, rework_loops, corrections, abandoned) ON public.sync_sessions TO mcp_data_owner;
GRANT SELECT (sync_session_id, tool_name, call_count) ON public.sync_session_tools TO mcp_data_owner;
GRANT SELECT (id, session_id, org_id, user_id, tool, model, turn_index, turn_role, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, prompt_char_len, has_code_block, has_file_path, has_traceback, intent_category, created_at) ON public.session_turns TO mcp_data_owner;
GRANT SELECT (day, team_id, member_id, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, api_cost, edits, additions, deletions, changed_lines, files_touched, tool_calls, tool_errors, rework_loops, corrections, abandoned_count, session_count) ON public.daily_member_usage TO mcp_data_owner;
GRANT SELECT (user_id) ON public.mcp_all_teams_admins TO mcp_data_owner;

-- ── 5. AS mcp_data_owner: the schema and function privileges are granted BY the owner (additive) ──
SET LOCAL ROLE mcp_data_owner;
DO $$
BEGIN
  IF current_user <> 'mcp_data_owner' OR session_user = 'mcp_data_owner' THEN RAISE EXCEPTION 'SET LOCAL ROLE did not take effect; refusing to grant as the wrong role'; END IF;
END $$;
GRANT USAGE ON SCHEMA mcp_data TO mcp_reader;
GRANT EXECUTE ON FUNCTION mcp_data.list_developers(bytea, integer, uuid, uuid) TO mcp_reader;
GRANT EXECUTE ON FUNCTION mcp_data.developer_activity(bytea, uuid, timestamptz, timestamptz, uuid) TO mcp_reader;
GRANT EXECUTE ON FUNCTION mcp_data.list_sessions(bytea, uuid, timestamptz, timestamptz, text, text, integer, timestamptz, uuid, uuid) TO mcp_reader;
GRANT EXECUTE ON FUNCTION mcp_data.session_details(bytea, uuid, uuid) TO mcp_reader;
GRANT EXECUTE ON FUNCTION mcp_data.search_prompt_metadata(bytea, uuid, timestamptz, timestamptz, text[], boolean, boolean, boolean, integer, integer, text, text, integer, timestamptz, bigint, uuid) TO mcp_reader;
GRANT EXECUTE ON FUNCTION mcp_data.prompt_metadata_batch(bytea, bigint[], uuid) TO mcp_reader;
GRANT EXECUTE ON FUNCTION mcp_data.list_teams(bytea) TO mcp_reader;
RESET ROLE;

-- ── 5b. The reader's role settings (no secret; the connection limit belongs to the role script and was validated above). search_path is a LIST: each schema is its own quoted element. ──
ALTER ROLE mcp_reader SET statement_timeout = 5000;
ALTER ROLE mcp_reader SET lock_timeout = 2000;
ALTER ROLE mcp_reader SET idle_in_transaction_session_timeout = 10000;
ALTER ROLE mcp_reader SET search_path = 'pg_catalog', 'pg_temp';
ALTER ROLE mcp_reader SET default_transaction_read_only = on;

-- ── 5c. Remove ONLY what this transaction added to the membership; prove the membership rows are exactly as they were ──
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
END $$;

-- ── 6. POST-CONDITIONS: the footprints, role settings and EFFECTIVE privileges (PUBLIC included) must be EXACTLY what is allowed ──
DO $$
DECLARE
  o oid := 'mcp_data_owner'::regrole::oid; rd oid := 'mcp_reader'::regrole::oid; v_schema oid := to_regnamespace('mcp_data')::oid;
  v_db oid := (SELECT db.oid FROM pg_catalog.pg_database db WHERE db.datname = pg_catalog.current_database());
  n_bad int; n_total int; n_expected int; n_extra int; n_eff int; n_allow int; v_cfg text[]; v_ours boolean;
BEGIN
  -- (a) ACL FOOTPRINT: every object on which a role appears in ANY ACL (pg_shdepend, deptype 'a': tables, columns, schemas, functions, databases, types,
  -- languages, parameters, large objects, default ACLs...). Baseline rule: EXACTLY the expected set.
  WITH allow(t, c) AS (VALUES
      ('oauth_tokens','token_hash'),
      ('oauth_tokens','kind'),
      ('oauth_tokens','scope'),
      ('oauth_tokens','user_id'),
      ('oauth_tokens','client_id'),
      ('oauth_tokens','revoked_at'),
      ('oauth_tokens','expires_at'),
      ('oauth_tokens','absolute_expires_at'),
      ('oauth_clients','client_id'),
      ('oauth_clients','disabled_at'),
      ('users','id'),
      ('users','team_id'),
      ('users','role'),
      ('users','active'),
      ('teams','id'),
      ('teams','name'),
      ('mcp_all_teams_admins','user_id'),
      ('members','id'),
      ('members','display_name'),
      ('team_members','team_id'),
      ('team_members','member_id'),
      ('team_members','role'),
      ('sync_sessions','id'),
      ('sync_sessions','team_id'),
      ('sync_sessions','member_id'),
      ('sync_sessions','source'),
      ('sync_sessions','session_id'),
      ('sync_sessions','model'),
      ('sync_sessions','started_at'),
      ('sync_sessions','ended_at'),
      ('sync_sessions','synced_at'),
      ('sync_sessions','tokens_in'),
      ('sync_sessions','tokens_out'),
      ('sync_sessions','tokens_cache_read'),
      ('sync_sessions','tokens_cache_write'),
      ('sync_sessions','api_cost'),
      ('sync_sessions','priced'),
      ('sync_sessions','edits'),
      ('sync_sessions','additions'),
      ('sync_sessions','deletions'),
      ('sync_sessions','changed_lines'),
      ('sync_sessions','files_touched'),
      ('sync_sessions','tool_calls'),
      ('sync_sessions','tool_errors'),
      ('sync_sessions','rework_loops'),
      ('sync_sessions','corrections'),
      ('sync_sessions','abandoned'),
      ('sync_session_tools','sync_session_id'),
      ('sync_session_tools','tool_name'),
      ('sync_session_tools','call_count'),
      ('session_turns','id'),
      ('session_turns','session_id'),
      ('session_turns','org_id'),
      ('session_turns','user_id'),
      ('session_turns','tool'),
      ('session_turns','model'),
      ('session_turns','turn_index'),
      ('session_turns','turn_role'),
      ('session_turns','input_tokens'),
      ('session_turns','output_tokens'),
      ('session_turns','cache_read_tokens'),
      ('session_turns','cache_write_tokens'),
      ('session_turns','prompt_char_len'),
      ('session_turns','has_code_block'),
      ('session_turns','has_file_path'),
      ('session_turns','has_traceback'),
      ('session_turns','intent_category'),
      ('session_turns','created_at'),
      ('daily_member_usage','day'),
      ('daily_member_usage','team_id'),
      ('daily_member_usage','member_id'),
      ('daily_member_usage','tokens_in'),
      ('daily_member_usage','tokens_out'),
      ('daily_member_usage','cache_read_tokens'),
      ('daily_member_usage','cache_write_tokens'),
      ('daily_member_usage','api_cost'),
      ('daily_member_usage','edits'),
      ('daily_member_usage','additions'),
      ('daily_member_usage','deletions'),
      ('daily_member_usage','changed_lines'),
      ('daily_member_usage','files_touched'),
      ('daily_member_usage','tool_calls'),
      ('daily_member_usage','tool_errors'),
      ('daily_member_usage','rework_loops'),
      ('daily_member_usage','corrections'),
      ('daily_member_usage','abandoned_count'),
      ('daily_member_usage','session_count')),
  fp AS (SELECT d.classid, d.objid, d.objsubid FROM pg_catalog.pg_shdepend d
          WHERE d.refclassid = 'pg_catalog.pg_authid'::regclass AND d.refobjid = o AND d.deptype = 'a' AND d.dbid IN (0, v_db)),
  judged AS (SELECT fp.classid, fp.objid, COALESCE(
      (fp.classid = 'pg_catalog.pg_class'::regclass AND fp.objsubid > 0 AND EXISTS (
         SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
           JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = fp.objsubid JOIN allow ON allow.t = c.relname AND allow.c = a.attname
          WHERE c.oid = fp.objid AND ns.nspname = 'public'))
      OR (fp.classid = 'pg_catalog.pg_namespace'::regclass AND fp.objid = 'public'::regnamespace::oid), false) AS ok FROM fp)
  SELECT count(*) FILTER (WHERE NOT ok), count(*), (SELECT count(*) FROM allow) + 1 INTO n_bad, n_total, n_expected FROM judged;
  IF n_bad > 0 THEN RAISE EXCEPTION 'mcp_data_owner appears in ACL entries outside the expected set (a pre-existing grant); refusing, nothing was changed'; END IF;
  IF n_total <> n_expected THEN RAISE EXCEPTION 'mcp_data_owner ACL footprint is not exactly the expected set'; END IF;
  WITH fp AS (SELECT d.classid, d.objid FROM pg_catalog.pg_shdepend d WHERE d.refclassid = 'pg_catalog.pg_authid'::regclass AND d.refobjid = rd AND d.deptype = 'a' AND d.dbid IN (0, v_db)),
  judged AS (SELECT fp.classid, COALESCE(
      (fp.classid = 'pg_catalog.pg_namespace'::regclass AND fp.objid = v_schema)
      OR (fp.classid = 'pg_catalog.pg_proc'::regclass AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = fp.objid AND p.pronamespace = v_schema AND p.proname IN ('list_developers', 'developer_activity', 'list_sessions', 'session_details', 'search_prompt_metadata', 'prompt_metadata_batch', 'list_teams')))
      OR (fp.classid = 'pg_catalog.pg_database'::regclass AND fp.objid = v_db), false) AS ok FROM fp)   -- an explicit CONNECT on this database is harmless and allowed
  SELECT count(*) FILTER (WHERE NOT ok), count(*) FILTER (WHERE classid <> 'pg_catalog.pg_database'::regclass) INTO n_bad, n_total FROM judged;
  IF n_bad > 0 THEN RAISE EXCEPTION 'mcp_reader appears in ACL entries outside the expected set (a pre-existing grant); refusing, nothing was changed'; END IF;
  IF n_total <> 8 THEN RAISE EXCEPTION 'mcp_reader ACL footprint is not exactly the expected set'; END IF;
  -- (b) ROLE SETTINGS of the reader: none at all (or exactly ours), and never per-database; the owner has none (checked in section 1).
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s WHERE s.setrole IN (o, rd) AND s.setdatabase <> 0) THEN RAISE EXCEPTION 'a role has per-database settings; refusing'; END IF;
  SELECT COALESCE((SELECT pg_catalog.array_agg(u.c ORDER BY u.c) FROM pg_catalog.pg_db_role_setting s, pg_catalog.unnest(s.setconfig) AS u(c) WHERE s.setrole = rd), ARRAY[]::text[]) INTO v_cfg;
  v_ours := pg_catalog.cardinality(v_cfg) = 5
    AND v_cfg @> ARRAY['statement_timeout=5000', 'lock_timeout=2000', 'idle_in_transaction_session_timeout=10000', 'default_transaction_read_only=on']
    AND EXISTS (SELECT 1 FROM pg_catalog.unnest(v_cfg) u(c) WHERE u.c = 'search_path=pg_catalog, pg_temp');
  IF NOT v_ours THEN RAISE EXCEPTION 'mcp_reader role settings are not exactly the expected five (search_path must be the two-element list)'; END IF;
  -- (c) mcp_data_owner EFFECTIVE privileges, PUBLIC-derived ones included. SELECT columns: EXACTLY the allowlist; nothing else of any kind.
  WITH allow(t, c) AS (VALUES
      ('oauth_tokens','token_hash'),
      ('oauth_tokens','kind'),
      ('oauth_tokens','scope'),
      ('oauth_tokens','user_id'),
      ('oauth_tokens','client_id'),
      ('oauth_tokens','revoked_at'),
      ('oauth_tokens','expires_at'),
      ('oauth_tokens','absolute_expires_at'),
      ('oauth_clients','client_id'),
      ('oauth_clients','disabled_at'),
      ('users','id'),
      ('users','team_id'),
      ('users','role'),
      ('users','active'),
      ('teams','id'),
      ('teams','name'),
      ('mcp_all_teams_admins','user_id'),
      ('members','id'),
      ('members','display_name'),
      ('team_members','team_id'),
      ('team_members','member_id'),
      ('team_members','role'),
      ('sync_sessions','id'),
      ('sync_sessions','team_id'),
      ('sync_sessions','member_id'),
      ('sync_sessions','source'),
      ('sync_sessions','session_id'),
      ('sync_sessions','model'),
      ('sync_sessions','started_at'),
      ('sync_sessions','ended_at'),
      ('sync_sessions','synced_at'),
      ('sync_sessions','tokens_in'),
      ('sync_sessions','tokens_out'),
      ('sync_sessions','tokens_cache_read'),
      ('sync_sessions','tokens_cache_write'),
      ('sync_sessions','api_cost'),
      ('sync_sessions','priced'),
      ('sync_sessions','edits'),
      ('sync_sessions','additions'),
      ('sync_sessions','deletions'),
      ('sync_sessions','changed_lines'),
      ('sync_sessions','files_touched'),
      ('sync_sessions','tool_calls'),
      ('sync_sessions','tool_errors'),
      ('sync_sessions','rework_loops'),
      ('sync_sessions','corrections'),
      ('sync_sessions','abandoned'),
      ('sync_session_tools','sync_session_id'),
      ('sync_session_tools','tool_name'),
      ('sync_session_tools','call_count'),
      ('session_turns','id'),
      ('session_turns','session_id'),
      ('session_turns','org_id'),
      ('session_turns','user_id'),
      ('session_turns','tool'),
      ('session_turns','model'),
      ('session_turns','turn_index'),
      ('session_turns','turn_role'),
      ('session_turns','input_tokens'),
      ('session_turns','output_tokens'),
      ('session_turns','cache_read_tokens'),
      ('session_turns','cache_write_tokens'),
      ('session_turns','prompt_char_len'),
      ('session_turns','has_code_block'),
      ('session_turns','has_file_path'),
      ('session_turns','has_traceback'),
      ('session_turns','intent_category'),
      ('session_turns','created_at'),
      ('daily_member_usage','day'),
      ('daily_member_usage','team_id'),
      ('daily_member_usage','member_id'),
      ('daily_member_usage','tokens_in'),
      ('daily_member_usage','tokens_out'),
      ('daily_member_usage','cache_read_tokens'),
      ('daily_member_usage','cache_write_tokens'),
      ('daily_member_usage','api_cost'),
      ('daily_member_usage','edits'),
      ('daily_member_usage','additions'),
      ('daily_member_usage','deletions'),
      ('daily_member_usage','changed_lines'),
      ('daily_member_usage','files_touched'),
      ('daily_member_usage','tool_calls'),
      ('daily_member_usage','tool_errors'),
      ('daily_member_usage','rework_loops'),
      ('daily_member_usage','corrections'),
      ('daily_member_usage','abandoned_count'),
      ('daily_member_usage','session_count')),
  eff AS (SELECT ns.nspname AS s, c.relname AS t, a.attname AS col FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
            JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
           WHERE c.relkind IN ('r','p','v','m','f') AND ns.nspname NOT IN ('pg_catalog','information_schema') AND ns.nspname NOT LIKE 'pg\_%' AND CASE WHEN c.relkind IN ('r','p','v','m','f') THEN pg_catalog.has_column_privilege('mcp_data_owner', c.oid, a.attnum, 'SELECT') ELSE false END)
  SELECT count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM allow WHERE allow.t = eff.t AND allow.c = eff.col AND eff.s = 'public')), count(*), (SELECT count(*) FROM allow) INTO n_extra, n_eff, n_allow FROM eff;
  IF n_extra > 0 THEN RAISE EXCEPTION 'mcp_data_owner can read columns beyond the allowlist (a grant, or PUBLIC, e.g. prompt_text_sanitized); refusing'; END IF;
  IF n_eff <> n_allow THEN RAISE EXCEPTION 'mcp_data_owner effective column SELECT is not exactly the allowlist'; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
              WHERE c.relkind IN ('r','p','v','m','f') AND ns.nspname NOT IN ('pg_catalog','information_schema') AND ns.nspname NOT LIKE 'pg\_%'
                AND (CASE WHEN c.relkind IN ('r','p','v','m','f') THEN pg_catalog.has_table_privilege('mcp_data_owner', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') ELSE false END OR CASE WHEN c.relkind IN ('r','p','v','m','f') THEN pg_catalog.has_any_column_privilege('mcp_data_owner', c.oid, 'INSERT,UPDATE,REFERENCES') ELSE false END)) THEN
    RAISE EXCEPTION 'mcp_data_owner has a write or table-level privilege (possibly through PUBLIC); refusing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace WHERE c.relkind = 'S' AND ns.nspname NOT IN ('pg_catalog','information_schema') AND ns.nspname NOT LIKE 'pg\_%' AND CASE WHEN c.relkind = 'S' THEN pg_catalog.has_sequence_privilege('mcp_data_owner', c.oid, 'USAGE,SELECT,UPDATE') ELSE false END) THEN
    RAISE EXCEPTION 'mcp_data_owner has a sequence privilege; refusing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace ns WHERE ns.nspname NOT IN ('pg_catalog','information_schema') AND ns.nspname NOT LIKE 'pg\_%' AND ns.nspname <> 'mcp_data' AND pg_catalog.has_schema_privilege('mcp_data_owner', ns.oid, 'CREATE'))
     OR pg_catalog.has_database_privilege('mcp_data_owner', pg_catalog.current_database(), 'CREATE') THEN
    RAISE EXCEPTION 'mcp_data_owner can CREATE in a schema other than mcp_data, or in the database; refusing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace
              WHERE ns.nspname NOT IN ('pg_catalog','information_schema') AND ns.nspname NOT LIKE 'pg\_%' AND ns.nspname <> 'mcp_data' AND p.prosecdef AND pg_catalog.has_function_privilege('mcp_data_owner', p.oid, 'EXECUTE')
                AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')) THEN
    RAISE EXCEPTION 'mcp_data_owner can execute a SECURITY DEFINER function outside mcp_data (possibly through PUBLIC); refusing';
  END IF;
  -- (d) mcp_reader EFFECTIVE privileges, PUBLIC included (fail closed; no names in the message, run mcp-data.audit.sql for the list)
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
              WHERE c.relkind IN ('r','p','v','m','f') AND ns.nspname NOT IN ('pg_catalog','information_schema') AND ns.nspname NOT LIKE 'pg\_%'
                AND (CASE WHEN c.relkind IN ('r','p','v','m','f') THEN pg_catalog.has_table_privilege('mcp_reader', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') ELSE false END
                     OR CASE WHEN c.relkind IN ('r','p','v','m','f') THEN pg_catalog.has_any_column_privilege('mcp_reader', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES') ELSE false END)) THEN
    RAISE EXCEPTION 'mcp_reader has an effective table or column privilege (possibly through PUBLIC); see mcp-data.audit.sql';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
              WHERE c.relkind = 'S' AND ns.nspname NOT IN ('pg_catalog','information_schema') AND ns.nspname NOT LIKE 'pg\_%'
                AND CASE WHEN c.relkind = 'S' THEN pg_catalog.has_sequence_privilege('mcp_reader', c.oid, 'USAGE,SELECT,UPDATE') ELSE false END) THEN
    RAISE EXCEPTION 'mcp_reader has an effective sequence privilege; see mcp-data.audit.sql';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace ns WHERE ns.nspname NOT IN ('pg_catalog','information_schema') AND ns.nspname NOT LIKE 'pg\_%' AND pg_catalog.has_schema_privilege('mcp_reader', ns.oid, 'CREATE'))
     OR pg_catalog.has_database_privilege('mcp_reader', pg_catalog.current_database(), 'CREATE') THEN
    RAISE EXCEPTION 'mcp_reader can CREATE in a schema or the database; see mcp-data.audit.sql';
  END IF;
  IF NOT pg_catalog.has_schema_privilege('mcp_reader', v_schema, 'USAGE') THEN RAISE EXCEPTION 'mcp_reader lacks USAGE on mcp_data'; END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = v_schema AND pg_catalog.has_function_privilege('mcp_reader', p.oid, 'EXECUTE')) <> 7 THEN RAISE EXCEPTION 'mcp_reader must be able to execute exactly the seven reader functions'; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace
              WHERE ns.nspname NOT IN ('pg_catalog','information_schema') AND ns.nspname NOT LIKE 'pg\_%'
                AND pg_catalog.has_function_privilege('mcp_reader', p.oid, 'EXECUTE')
                AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
                AND ((ns.nspname = 'mcp_data' AND p.proname NOT IN ('list_developers', 'developer_activity', 'list_sessions', 'session_details', 'search_prompt_metadata', 'prompt_metadata_batch', 'list_teams')) OR (ns.nspname <> 'mcp_data' AND p.prosecdef))) THEN
    RAISE EXCEPTION 'mcp_reader can execute a function beyond the seven approved ones, or a SECURITY DEFINER function elsewhere (possibly through PUBLIC); see mcp-data.audit.sql';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'pg_catalog'::regnamespace AND pg_catalog.has_function_privilege('mcp_reader', p.oid, 'EXECUTE')
              AND p.proname IN ('pg_read_file','pg_read_binary_file','pg_ls_dir','pg_stat_file','lo_import','lo_export','pg_reload_conf','pg_rotate_logfile','pg_switch_wal','pg_create_restore_point')) THEN
    RAISE EXCEPTION 'mcp_reader can execute a dangerous built-in function; see mcp-data.audit.sql';
  END IF;
END $$;

