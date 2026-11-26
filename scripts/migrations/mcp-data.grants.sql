-- MCP data plane privileges (Phase 3, P3-3). WRITTEN FOR REVIEW — NOT APPLIED ANYWHERE.
-- GENERATED from lib/mcp/grants.json (the source of truth); tests/mcp-data-sql.test.ts fails if this file and grants.json disagree.
-- Run as the schema OWNER, in ONE transaction, AFTER scripts/migrations/mcp-data.sql and AFTER mcp_reader exists (created by the role script with a
-- password taken from the environment; no credential is ever in this file). Idempotent: it first removes everything the two roles hold in the
-- public and mcp_data schemas, then grants exactly what follows, so drift is corrected.
--
-- mcp_data_owner  = COLUMN-level SELECT on the columns the functions read. NOT granted: session_turns.prompt_text_sanitized, sync_sessions.label /
--                   events / agent / payload_hash, daily_member_usage.project, any path column, credentials, audit_log, prompt_embeddings, daily_org_*.
-- mcp_reader      = USAGE on schema mcp_data + EXECUTE on six functions. No privilege on any table.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_data_owner') THEN RAISE EXCEPTION 'mcp_data_owner is missing: run scripts/migrations/mcp-data.sql first'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_reader') THEN RAISE EXCEPTION 'mcp_reader is missing: provision it with the role script first'; END IF;
  IF to_regnamespace('mcp_data') IS NULL THEN RAISE EXCEPTION 'schema mcp_data is missing: run scripts/migrations/mcp-data.sql first'; END IF;

  IF to_regprocedure('mcp_data.list_developers(bytea, integer, uuid)') IS NULL THEN RAISE EXCEPTION 'function mcp_data.list_developers is missing'; END IF;
  IF to_regprocedure('mcp_data.developer_activity(bytea, uuid, timestamptz, timestamptz)') IS NULL THEN RAISE EXCEPTION 'function mcp_data.developer_activity is missing'; END IF;
  IF to_regprocedure('mcp_data.list_sessions(bytea, uuid, timestamptz, timestamptz, text, text, integer, timestamptz, uuid)') IS NULL THEN RAISE EXCEPTION 'function mcp_data.list_sessions is missing'; END IF;
  IF to_regprocedure('mcp_data.session_details(bytea, uuid)') IS NULL THEN RAISE EXCEPTION 'function mcp_data.session_details is missing'; END IF;
  IF to_regprocedure('mcp_data.search_prompt_metadata(bytea, uuid, timestamptz, timestamptz, text[], boolean, boolean, boolean, integer, integer, text, text, integer, timestamptz, bigint)') IS NULL THEN RAISE EXCEPTION 'function mcp_data.search_prompt_metadata is missing'; END IF;
  IF to_regprocedure('mcp_data.prompt_metadata_batch(bytea, bigint[])') IS NULL THEN RAISE EXCEPTION 'function mcp_data.prompt_metadata_batch is missing'; END IF;
END $$;

-- ── Reset: nothing the two roles hold survives except what is granted below ──
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM mcp_data_owner;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM mcp_data_owner;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM mcp_data_owner;
REVOKE ALL ON SCHEMA public FROM mcp_data_owner;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM mcp_reader;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM mcp_reader;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM mcp_reader;
REVOKE ALL ON SCHEMA public FROM mcp_reader;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA mcp_data FROM mcp_reader;
REVOKE ALL ON SCHEMA mcp_data FROM mcp_reader;

-- ── mcp_data_owner: column-level, read-only ──
GRANT USAGE ON SCHEMA public TO mcp_data_owner;
GRANT SELECT (token_hash, kind, scope, user_id, client_id, revoked_at, expires_at, absolute_expires_at) ON public.oauth_tokens TO mcp_data_owner;
GRANT SELECT (client_id, disabled_at) ON public.oauth_clients TO mcp_data_owner;
GRANT SELECT (id, team_id, role, active) ON public.users TO mcp_data_owner;
GRANT SELECT (id) ON public.teams TO mcp_data_owner;
GRANT SELECT (id, display_name) ON public.members TO mcp_data_owner;
GRANT SELECT (team_id, member_id, role) ON public.team_members TO mcp_data_owner;
GRANT SELECT (id, team_id, member_id, source, session_id, model, started_at, ended_at, synced_at, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, api_cost, priced, edits, additions, deletions, changed_lines, files_touched, tool_calls, tool_errors, rework_loops, corrections, abandoned) ON public.sync_sessions TO mcp_data_owner;
GRANT SELECT (sync_session_id, tool_name, call_count) ON public.sync_session_tools TO mcp_data_owner;
GRANT SELECT (id, session_id, org_id, user_id, tool, model, turn_index, turn_role, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, prompt_char_len, has_code_block, has_file_path, has_traceback, intent_category, created_at) ON public.session_turns TO mcp_data_owner;
GRANT SELECT (day, team_id, member_id, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, api_cost, edits, additions, deletions, changed_lines, files_touched, tool_calls, tool_errors, rework_loops, corrections, abandoned_count, session_count) ON public.daily_member_usage TO mcp_data_owner;

-- ── mcp_reader: schema usage and the six functions, nothing else ──
GRANT USAGE ON SCHEMA mcp_data TO mcp_reader;
GRANT EXECUTE ON FUNCTION mcp_data.list_developers(bytea, integer, uuid) TO mcp_reader;
GRANT EXECUTE ON FUNCTION mcp_data.developer_activity(bytea, uuid, timestamptz, timestamptz) TO mcp_reader;
GRANT EXECUTE ON FUNCTION mcp_data.list_sessions(bytea, uuid, timestamptz, timestamptz, text, text, integer, timestamptz, uuid) TO mcp_reader;
GRANT EXECUTE ON FUNCTION mcp_data.session_details(bytea, uuid) TO mcp_reader;
GRANT EXECUTE ON FUNCTION mcp_data.search_prompt_metadata(bytea, uuid, timestamptz, timestamptz, text[], boolean, boolean, boolean, integer, integer, text, text, integer, timestamptz, bigint) TO mcp_reader;
GRANT EXECUTE ON FUNCTION mcp_data.prompt_metadata_batch(bytea, bigint[]) TO mcp_reader;

-- ── mcp_reader role settings (no secret) ──
ALTER ROLE mcp_reader CONNECTION LIMIT 5;
ALTER ROLE mcp_reader SET statement_timeout = 5000;
ALTER ROLE mcp_reader SET lock_timeout = 2000;
ALTER ROLE mcp_reader SET idle_in_transaction_session_timeout = 10000;
ALTER ROLE mcp_reader SET search_path = 'pg_catalog, pg_temp';
ALTER ROLE mcp_reader SET default_transaction_read_only = on;
