-- Rollback for mcp-data.sql and mcp-data.grants.sql. WRITTEN FOR REVIEW — NOT APPLIED ANYWHERE. Run as the schema OWNER in ONE transaction.
-- Removes ONLY what those two files created: 13 functions, the schema mcp_data, every privilege held by mcp_data_owner and mcp_reader, and the two
-- roles. No table, row, column or other privilege is touched; no CASCADE is used (a dependency that was not expected makes the rollback FAIL
-- instead of silently dropping something).
--  * Nothing is lost: the data plane stores no data of its own (it only reads). Reader connections are cut when the role is dropped.
--  * Roll back the application code first (or leave MCP_ENABLED unset), then run this. The OAuth/identity plane (mcp_auth, oauth_* tables) is NOT affected.
--  * mcp_reader holds no objects, so it can be dropped after its grants go. If a LOGIN session of mcp_reader is open, DROP ROLE fails: end it first.
--  * The migration role keeps its membership of mcp_data_owner until that role is dropped below; the drops need that membership.

-- 1. The reader loses everything first (so no function is executable while it is being dropped).
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA mcp_data FROM mcp_reader;
REVOKE ALL ON SCHEMA mcp_data FROM mcp_reader;

-- 2. Functions, helpers last (the reader functions call them). Each name and argument list is explicit.
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

-- 3. The schema (fails if anything unexpected is still inside it).
DROP SCHEMA IF EXISTS mcp_data;

-- 4. Remove every remaining privilege of the owner role (column grants on the nine existing tables), then the roles themselves.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_data_owner') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM mcp_data_owner;
    REVOKE ALL ON SCHEMA public FROM mcp_data_owner;
    DROP OWNED BY mcp_data_owner;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_reader') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM mcp_reader;
    REVOKE ALL ON SCHEMA public FROM mcp_reader;
    DROP OWNED BY mcp_reader;
  END IF;
END $$;
DROP ROLE IF EXISTS mcp_reader;
DROP ROLE IF EXISTS mcp_data_owner;
