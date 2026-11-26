-- MCP data plane: READ-ONLY effective-privilege audit of mcp_reader (and mcp_data_owner). WRITTEN FOR REVIEW — NOT RUN ANYWHERE.
-- Only SELECT statements (no DDL, no DML, no SET, no function with side effects); run it as any role that may read the catalogs, ideally inside
-- BEGIN READ ONLY ... ROLLBACK. It reports what the roles can ACTUALLY do, including everything inherited through PUBLIC, which grants.json cannot show.
-- Both roles must exist (has_*_privilege raises for an unknown role). EXPECTED RESULT after mcp-data.sql and mcp-data.grants.sql:
--   1  attributes / memberships : mcp_reader LOGIN, NOINHERIT, no attribute, no membership; mcp_data_owner NOLOGIN, no attribute
--   1b membership detail        : every pg_auth_members row touching either role, with grantor and the admin / inherit / set options. EXPECTED after the
--                                 migration: at most the migration role's ADMIN-only link to mcp_data_owner (admin = true, inherit = false, set = false)
--   2  database                 : CONNECT = true (required to log in), CREATE = false, TEMPORARY = true or false (residual; see MCP.md 16.10)
--   3  schemas                  : USAGE on mcp_data; USAGE on public (via PUBLIC, residual); CREATE nowhere
--   4  relations                : ZERO rows (no table, view, matview, foreign table or sequence privilege of any kind)
--   5  functions                : exactly the six reader functions in mcp_data; any other row is listed with its owner, SECURITY DEFINER flag and
--                                 whether PUBLIC grants it; a SECURITY DEFINER row outside mcp_data is a FINDING
--   6  dangerous built-ins      : ZERO rows
--   7  default privileges       : rows that would hand FUTURE objects to PUBLIC or to the reader (review each)
--   8  role settings            : the effective search_path list (two elements) and the other grants.json settings
--   9  mcp_data_owner columns   : its column SELECT privileges, to compare with lib/mcp/grants.json (and nothing on prompt_text_sanitized)
--   10 mcp_data_owner EFFECTIVE : everything else it can do: no table-level privilege, no column write privilege, no sequence privilege, CREATE only in
--                                 mcp_data, the database privileges, executable functions, and the objects it owns (only mcp_data and its functions)

-- 1 ── attributes and memberships
SELECT '1 role' AS section, r.rolname, r.rolcanlogin AS login, r.rolinherit AS inherit, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls, r.rolconnlimit,
       (SELECT string_agg(g.rolname, ',') FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid) AS member_of,
       (SELECT string_agg(g.rolname, ',') FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles g ON g.oid = m.member WHERE m.roleid = r.oid) AS has_members
  FROM pg_catalog.pg_roles r WHERE r.rolname IN ('mcp_reader', 'mcp_data_owner') ORDER BY r.rolname;

-- 1b ── membership rows with grantor and options (a standing SET or INHERIT link, or any membership of mcp_reader, is a FINDING)
SELECT '1b membership' AS section, pg_catalog.pg_get_userbyid(m.roleid) AS role_granted, pg_catalog.pg_get_userbyid(m.member) AS member, pg_catalog.pg_get_userbyid(m.grantor) AS grantor,
       m.admin_option, m.inherit_option, m.set_option
  FROM pg_catalog.pg_auth_members m
 WHERE m.roleid IN ('mcp_reader'::regrole, 'mcp_data_owner'::regrole) OR m.member IN ('mcp_reader'::regrole, 'mcp_data_owner'::regrole)
 ORDER BY 2, 3, 4;

-- 2 ── database privileges (CONNECT and TEMPORARY come from PUBLIC by default)
SELECT '2 database' AS section, pg_catalog.current_database() AS db,
       pg_catalog.has_database_privilege('mcp_reader', pg_catalog.current_database(), 'CONNECT') AS connect,
       pg_catalog.has_database_privilege('mcp_reader', pg_catalog.current_database(), 'CREATE') AS can_create,
       pg_catalog.has_database_privilege('mcp_reader', pg_catalog.current_database(), 'TEMPORARY') AS temporary,
       (SELECT d.datacl::text FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()) AS database_acl;

-- 3 ── schemas
SELECT '3 schema' AS section, ns.nspname, pg_catalog.pg_get_userbyid(ns.nspowner) AS owner,
       pg_catalog.has_schema_privilege('mcp_reader', ns.oid, 'USAGE') AS reader_usage, pg_catalog.has_schema_privilege('mcp_reader', ns.oid, 'CREATE') AS reader_create,
       ns.nspacl::text AS acl
  FROM pg_catalog.pg_namespace ns
 WHERE ns.nspname NOT IN ('pg_catalog', 'information_schema') AND ns.nspname NOT LIKE 'pg\_%'
 ORDER BY ns.nspname;

-- 4 ── any table, view, materialized view, foreign table, partitioned table or sequence privilege (EXPECTED: no rows)
SELECT '4 relation' AS section, ns.nspname || '.' || c.relname AS relation, c.relkind,
       pg_catalog.has_table_privilege('mcp_reader', c.oid, 'SELECT') AS sel, pg_catalog.has_table_privilege('mcp_reader', c.oid, 'INSERT') AS ins,
       pg_catalog.has_table_privilege('mcp_reader', c.oid, 'UPDATE') AS upd, pg_catalog.has_table_privilege('mcp_reader', c.oid, 'DELETE') AS del,
       pg_catalog.has_any_column_privilege('mcp_reader', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES') AS any_column
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND ns.nspname NOT IN ('pg_catalog', 'information_schema') AND ns.nspname NOT LIKE 'pg\_%'
   AND (pg_catalog.has_table_privilege('mcp_reader', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR pg_catalog.has_any_column_privilege('mcp_reader', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))
UNION ALL
SELECT '4 sequence', ns.nspname || '.' || c.relname, c.relkind, NULL, NULL, NULL, NULL, NULL
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
 WHERE c.relkind = 'S' AND ns.nspname NOT IN ('pg_catalog', 'information_schema') AND ns.nspname NOT LIKE 'pg\_%'
   AND pg_catalog.has_sequence_privilege('mcp_reader', c.oid, 'USAGE,SELECT,UPDATE')
 ORDER BY 1, 2;

-- 5 ── every non-system function the reader can execute, and WHY (owner, SECURITY DEFINER, granted to PUBLIC?). Extension members are excluded.
SELECT '5 function' AS section, ns.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' AS fn,
       pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS security_definer,
       EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS via_public,
       (ns.nspname = 'mcp_data' AND p.proname IN ('list_developers', 'developer_activity', 'list_sessions', 'session_details', 'search_prompt_metadata', 'prompt_metadata_batch')) AS approved
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace
 WHERE ns.nspname NOT IN ('pg_catalog', 'information_schema') AND ns.nspname NOT LIKE 'pg\_%'
   AND pg_catalog.has_function_privilege('mcp_reader', p.oid, 'EXECUTE')
   AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
 ORDER BY approved DESC, security_definer DESC, fn;

-- 6 ── dangerous built-ins the reader can execute (EXPECTED: no rows)
SELECT '6 builtin' AS section, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_catalog.pg_proc p
 WHERE p.pronamespace = 'pg_catalog'::regnamespace AND pg_catalog.has_function_privilege('mcp_reader', p.oid, 'EXECUTE')
   AND p.proname IN ('pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file', 'lo_import', 'lo_export', 'pg_terminate_backend', 'pg_cancel_backend', 'pg_reload_conf', 'pg_rotate_logfile', 'pg_switch_wal', 'pg_create_restore_point', 'pg_logical_emit_message')
 ORDER BY 2, 3;

-- 7 ── default privileges that would hand FUTURE objects to PUBLIC or to the reader
SELECT '7 default_acl' AS section, pg_catalog.pg_get_userbyid(d.defaclrole) AS for_role, COALESCE(ns.nspname, '(all schemas)') AS in_schema, d.defaclobjtype AS objtype,
       a.privilege_type, CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END AS grantee
  FROM pg_catalog.pg_default_acl d LEFT JOIN pg_catalog.pg_namespace ns ON ns.oid = d.defaclnamespace, pg_catalog.aclexplode(d.defaclacl) a
 WHERE a.grantee = 0 OR a.grantee = 'mcp_reader'::regrole
 ORDER BY 2, 3, 4;

-- 8 ── role-level settings as stored (search_path must show TWO elements, not one string containing a comma)
SELECT '8 setting' AS section, r.rolname, cfg.setting
  FROM pg_catalog.pg_db_role_setting drs JOIN pg_catalog.pg_roles r ON r.oid = drs.setrole, pg_catalog.unnest(drs.setconfig) AS cfg(setting)
 WHERE r.rolname = 'mcp_reader' ORDER BY 3;

-- 9 ── what mcp_data_owner can read, column by column (compare with lib/mcp/grants.json; prompt_text_sanitized, label, events, path... must NOT appear)
SELECT '9 owner column' AS section, ns.nspname || '.' || c.relname AS relation, a.attname AS col
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
 WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND ns.nspname NOT IN ('pg_catalog', 'information_schema') AND ns.nspname NOT LIKE 'pg\_%'
   AND pg_catalog.has_column_privilege('mcp_data_owner', c.oid, a.attnum, 'SELECT')
 ORDER BY 2, 3;

-- 10 ── mcp_data_owner EFFECTIVE privileges beyond column SELECT (section 9). EXPECTED: 10a, 10b zero rows; 10c CREATE only on mcp_data; 10e only mcp_data functions
--       and ordinary PUBLIC-executable ones; 10f only the mcp_data schema and its functions.
-- 10a relations: any table-level privilege, or any column-level INSERT / UPDATE / REFERENCES
SELECT '10a owner relation' AS section, ns.nspname || '.' || c.relname AS relation, c.relkind,
       pg_catalog.has_table_privilege('mcp_data_owner', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS table_level,
       pg_catalog.has_any_column_privilege('mcp_data_owner', c.oid, 'INSERT,UPDATE,REFERENCES') AS column_write
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND ns.nspname NOT IN ('pg_catalog', 'information_schema') AND ns.nspname NOT LIKE 'pg\_%'
   AND (pg_catalog.has_table_privilege('mcp_data_owner', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR pg_catalog.has_any_column_privilege('mcp_data_owner', c.oid, 'INSERT,UPDATE,REFERENCES'))
UNION ALL
SELECT '10b owner sequence', ns.nspname || '.' || c.relname, c.relkind, NULL, NULL
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
 WHERE c.relkind = 'S' AND ns.nspname NOT IN ('pg_catalog', 'information_schema') AND ns.nspname NOT LIKE 'pg\_%'
   AND pg_catalog.has_sequence_privilege('mcp_data_owner', c.oid, 'USAGE,SELECT,UPDATE')
 ORDER BY 1, 2;

-- 10c schemas and the database
SELECT '10c owner schema' AS section, ns.nspname AS object, pg_catalog.has_schema_privilege('mcp_data_owner', ns.oid, 'USAGE') AS usage_priv, pg_catalog.has_schema_privilege('mcp_data_owner', ns.oid, 'CREATE') AS create_priv
  FROM pg_catalog.pg_namespace ns WHERE ns.nspname NOT IN ('pg_catalog', 'information_schema') AND ns.nspname NOT LIKE 'pg\_%'
UNION ALL
SELECT '10d owner database', pg_catalog.current_database(), pg_catalog.has_database_privilege('mcp_data_owner', pg_catalog.current_database(), 'CONNECT'),
       pg_catalog.has_database_privilege('mcp_data_owner', pg_catalog.current_database(), 'CREATE') OR pg_catalog.has_database_privilege('mcp_data_owner', pg_catalog.current_database(), 'TEMPORARY')
 ORDER BY 1, 2;

-- 10e functions the owner can execute (non-system, non-extension) and whether PUBLIC is the source
SELECT '10e owner function' AS section, ns.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' AS fn, pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS security_definer,
       EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS via_public
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace
 WHERE ns.nspname NOT IN ('pg_catalog', 'information_schema') AND ns.nspname NOT LIKE 'pg\_%'
   AND pg_catalog.has_function_privilege('mcp_data_owner', p.oid, 'EXECUTE')
   AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
 ORDER BY 3, 2;

-- 10f objects the owner OWNS (shared-dependency catalog): EXPECTED only the mcp_data schema and the functions inside it
SELECT '10f owned object' AS section, d.classid::regclass::text AS catalog, d.objid,
       CASE WHEN d.classid = 'pg_catalog.pg_proc'::regclass THEN (SELECT np.nspname || '.' || p.proname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace np ON np.oid = p.pronamespace WHERE p.oid = d.objid)
            WHEN d.classid = 'pg_catalog.pg_namespace'::regclass THEN (SELECT n.nspname FROM pg_catalog.pg_namespace n WHERE n.oid = d.objid) END AS name
  FROM pg_catalog.pg_shdepend d
 WHERE d.refclassid = 'pg_catalog.pg_authid'::regclass AND d.refobjid = 'mcp_data_owner'::regrole AND d.deptype = 'o'
   AND d.dbid IN (0, (SELECT db.oid FROM pg_catalog.pg_database db WHERE db.datname = pg_catalog.current_database()))
 ORDER BY 2, 4;
