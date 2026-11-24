-- Rollback for mcp-oauth.sql. Run in ONE transaction. DESTRUCTIVE for the objects this migration created, and ONLY those
-- (five tables + five functions; nothing existing references them; no CASCADE).
--  * Every issued token/authorization code/registered client is lost: all connectors must re-authorize.
--  * mcp_access_log (the MCP access trail) is dropped: export it first if it holds anything you need.
--  * Rows already written to audit_log with action 'mcp.*' are NOT removed (audit history is never deleted by a rollback).
--  * Roll back the application code first (or leave MCP_ENABLED unset), then run this.
--  * Drop the role with  node scripts/setup-mcp-roles.mjs --drop  before or after this; the order does not matter
--    (DROP OWNED BY revokes the role's grants, including EXECUTE on mcp_audit_event, whichever objects still exist).
DROP TABLE IF EXISTS mcp_access_log;
DROP TABLE IF EXISTS mcp_rate_limits;
DROP TABLE IF EXISTS oauth_tokens;
DROP TABLE IF EXISTS oauth_authorization_codes;
DROP TABLE IF EXISTS oauth_clients;
-- Tables first: dropping them removes the triggers that depend on the guard functions.
DROP FUNCTION IF EXISTS mcp_guard_oauth_tokens();
DROP FUNCTION IF EXISTS mcp_guard_oauth_codes();
DROP FUNCTION IF EXISTS mcp_guard_oauth_clients();
DROP FUNCTION IF EXISTS mcp_audit_event(text, uuid, text, text, jsonb);
DROP FUNCTION IF EXISTS mcp_oauth_purge();
