#!/usr/bin/env node
/**
 * Provisions the dedicated `mcp_auth` database login (MCP identity plane: OAuth clients/codes/tokens). Phase 2.
 * Privileges come ONLY from lib/mcp/grants.json. mcp_reader (the data plane) is NOT created here; it is a Phase 4 deliverable.
 *
 *   node scripts/setup-mcp-roles.mjs                                    PLAN (default): prints the SQL it would run; connects to nothing.
 *   MCP_AUTH_PASSWORD=… CONFIRM_MCP_ROLES=yes EXPECTED_ENDPOINT=<ep> node --env-file=<file> scripts/setup-mcp-roles.mjs --apply
 *   MCP_AUTH_DATABASE_URL=… node scripts/setup-mcp-roles.mjs --verify  exact-match check of the live role against grants.json (catalog-based, all schemas)
 *   CONFIRM_MCP_ROLES=yes EXPECTED_ENDPOINT=<ep> node --env-file=<file> scripts/setup-mcp-roles.mjs --drop
 *
 * Prerequisite: scripts/migrate-mcp-oauth.mjs --apply (the tables AND the mcp_audit_event function must exist). Password: >= 24 printable
 * ASCII chars (e.g. `openssl rand -hex 24`), from the environment only; never printed, never written to a file. Idempotent: --apply
 * REVOKEs everything the role holds in EVERY non-system schema and re-grants exactly what grants.json lists, so drift is corrected.
 * TLS certificates are verified. Neon needs the plaintext password in the statement; if an apply fails, rotate the password.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROLE = 'mcp_auth';
const CONN_LIMIT = 5;
const DEFAULTS = { statement_timeout: 5000, lock_timeout: 2000, idle_in_transaction_session_timeout: 10000, search_path: 'pg_catalog, public' };
const grants = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'mcp', 'grants.json'), 'utf8'))[ROLE];
const IDENT = /^[a-z_][a-z0-9_]*$/;
const SIGNATURE = /^[a-z_][a-z0-9_]*\([a-z0-9_ ,]*\)$/;
const q = (id) => { if (!IDENT.test(id)) throw new Error(`unsafe identifier in grants.json: ${id}`); return `"${id}"`; };
const sig = (s) => { if (!SIGNATURE.test(s)) throw new Error(`unsafe function signature in grants.json: ${s}`); return s; };
const fnName = (s) => s.slice(0, s.indexOf('('));
const qs = (s) => `"${String(s).replace(/"/g, '""')}"`; // schema names come from pg_namespace, not from files
const mode = process.argv.includes('--verify') ? 'verify' : process.argv.includes('--drop') ? 'drop' : process.argv.includes('--apply') ? 'apply' : 'plan';
const SYSTEM_SCHEMAS_SQL = "nspname NOT IN ('pg_catalog','information_schema') AND nspname NOT LIKE 'pg\\_%'";

function grantStatements(schemas = ['public']) {
  const out = [];
  for (const s of schemas) {
    out.push(`REVOKE ALL ON ALL TABLES IN SCHEMA ${qs(s)} FROM ${q(ROLE)}`, `REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${qs(s)} FROM ${q(ROLE)}`,
      `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${qs(s)} FROM ${q(ROLE)}`, `REVOKE ALL ON SCHEMA ${qs(s)} FROM ${q(ROLE)}`);
  }
  out.push(`GRANT USAGE ON SCHEMA public TO ${q(ROLE)}`);
  for (const [priv, tables] of [['SELECT', grants.select], ['INSERT', grants.insert], ['UPDATE', grants.update]])
    for (const [t, cols] of Object.entries(tables)) out.push(`GRANT ${priv} (${cols.map(q).join(', ')}) ON ${q(t)} TO ${q(ROLE)}`);
  for (const s of grants.sequences) out.push(`GRANT USAGE ON SEQUENCE ${q(s)} TO ${q(ROLE)}`);
  for (const f of grants.functions) out.push(`GRANT EXECUTE ON FUNCTION ${sig(f)} TO ${q(ROLE)}`);
  return out;
}
const roleStatements = (exists) => [
  exists ? `ALTER ROLE ${q(ROLE)} LOGIN CONNECTION LIMIT ${CONN_LIMIT} PASSWORD '<from MCP_AUTH_PASSWORD, not shown>'`
         : `CREATE ROLE ${q(ROLE)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT ${CONN_LIMIT} PASSWORD '<from MCP_AUTH_PASSWORD, not shown>'`,
  ...Object.entries(DEFAULTS).map(([k, v]) => `ALTER ROLE ${q(ROLE)} SET ${k} = ${v}`),
];

const connect = (raw) => {
  const u = new URL(raw); u.searchParams.delete('sslmode');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  return new pg.Client({ connectionString: u.toString(), ssl: local ? false : { rejectUnauthorized: true } });
};
function adminTarget() {
  const raw = process.env.DATABASE_URL || process.env.NEON_CONNECTION_STRING;
  if (!raw) { console.error('DATABASE_URL (owner connection) is not set. Pass it explicitly (node --env-file=<file> …); there is no .env.local fallback.'); process.exit(2); }
  const endpointId = new URL(raw).hostname.split('.')[0].replace(/-pooler$/, '');
  if (process.env.CONFIRM_MCP_ROLES !== 'yes') { console.error('Refusing: set CONFIRM_MCP_ROLES=yes (approval + backup/branch in place).'); process.exit(2); }
  if (!process.env.EXPECTED_ENDPOINT || process.env.EXPECTED_ENDPOINT !== endpointId) { console.error('EXPECTED_ENDPOINT is required and must match the target endpoint. Refusing.'); process.exit(2); }
  return { raw, endpointId };
}

async function apply() {
  const { raw, endpointId } = adminTarget();
  const password = process.env.MCP_AUTH_PASSWORD;
  if (password !== undefined && (password.length < 24 || !/^[\x21-\x7e]+$/.test(password))) { console.error('MCP_AUTH_PASSWORD must be >= 24 printable ASCII characters, no spaces (e.g. openssl rand -hex 24).'); process.exit(2); }
  const c = connect(raw); await c.connect();
  try {
    const missing = [];
    for (const t of new Set([...Object.keys(grants.select), ...Object.keys(grants.insert), ...Object.keys(grants.update)]))
      if (!(await c.query("SELECT 1 FROM pg_class WHERE relkind='r' AND relnamespace='public'::regnamespace AND relname=$1", [t])).rowCount) missing.push(t);
    for (const f of grants.functions) if (!(await c.query('SELECT to_regprocedure($1) AS p', [sig(f)])).rows[0].p) missing.push(f);
    if (missing.length) { console.error(`Missing objects (run the migration first): ${missing.join(', ')}`); process.exit(2); }
    const exists = (await c.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [ROLE])).rowCount > 0;
    if (!exists && !password) { console.error('MCP_AUTH_PASSWORD is required to create the role.'); process.exit(2); }
    const schemas = (await c.query(`SELECT nspname FROM pg_namespace WHERE ${SYSTEM_SCHEMAS_SQL} ORDER BY 1`)).rows.map((r) => r.nspname);
    console.log(`Endpoint: ${endpointId}  role: ${ROLE} (${exists ? 'exists' : 'new'})  schemas revoked+checked: ${schemas.join(', ')}`);
    await c.query('BEGIN');
    const pw = password ? ` PASSWORD ${c.escapeLiteral(password)}` : '';
    await c.query(exists ? `ALTER ROLE ${q(ROLE)} LOGIN CONNECTION LIMIT ${CONN_LIMIT}${pw}`
      : `CREATE ROLE ${q(ROLE)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT ${CONN_LIMIT}${pw}`);
    const f = (await c.query('SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname=$1', [ROLE])).rows[0];
    const bad = Object.entries(f).filter(([, on]) => on).map(([k]) => k);
    if (bad.length) throw new Error(`${ROLE} has forbidden attributes (${bad.join(', ')}); refusing.`);
    const memberships = (await c.query('SELECT count(*)::int n FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname=$1)', [ROLE])).rows[0].n;
    if (memberships) throw new Error(`${ROLE} is a member of ${memberships} role(s); it must have none. Refusing.`);
    for (const [k, v] of Object.entries(DEFAULTS)) await c.query(`ALTER ROLE ${q(ROLE)} SET ${k} = ${typeof v === 'number' ? v : c.escapeLiteral(v)}`);
    const stmts = grantStatements(schemas);
    for (const s of stmts) await c.query(s);
    await c.query('COMMIT');
    console.log(`${exists ? 'refreshed' : 'created'} ${ROLE}; ${stmts.length} grant statements applied. Password ${password ? 'set' : 'unchanged'} (not printed).`);
    const a = new URL(raw);
    console.log(`Next: set MCP_AUTH_DATABASE_URL to the SAME host as DATABASE_URL with user ${ROLE} and your password (db ${a.pathname.replace(/^\//, '') || '<dbname>'}), then run --verify.`);
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { await c.end(); }
}

async function drop() {
  const { raw } = adminTarget();
  const c = connect(raw); await c.connect();
  try {
    if (!(await c.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [ROLE])).rowCount) { console.log(`${ROLE} does not exist; nothing to do.`); return; }
    await c.query('BEGIN'); await c.query(`DROP OWNED BY ${q(ROLE)}`); await c.query(`DROP ROLE ${q(ROLE)}`); await c.query('COMMIT');
    console.log(`dropped ${ROLE}. Unset MCP_AUTH_DATABASE_URL (OAuth then fails closed).`);
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { await c.end(); }
}

async function verify() {
  const raw = process.env.MCP_AUTH_DATABASE_URL;
  if (!raw) { console.error('MCP_AUTH_DATABASE_URL is not set'); process.exit(2); }
  if (/[<>]/.test(raw)) { console.error('MCP_AUTH_DATABASE_URL still has template placeholders.'); process.exit(2); }
  const c = connect(raw); await c.connect();
  let failed = 0;
  const check = (ok, label, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`); };
  const warn = (label, detail = '') => console.log(`WARN  ${label}${detail ? ` — ${detail}` : ''}`);
  // A real privilege/guard probe: runs in a normal (not READ ONLY) transaction that is always rolled back, so a missing privilege cannot be
  // masked by a read-only-transaction error. Only the expected SQLSTATE counts as a pass.
  const probe = async (sql, label, expected, readOnly = false) => {
    try { await c.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN'); await c.query(sql); check(false, label, 'was allowed'); }
    catch (e) { check(e.code === expected, label, e.code); }
    finally { await c.query('ROLLBACK').catch(() => {}); }
  };
  try {
    const id = (await c.query("SELECT current_user u, session_user s, current_setting('is_superuser') su")).rows[0];
    check(id.u === ROLE && id.s === ROLE, `connected as ${ROLE}`); check(id.su === 'off', 'not superuser');
    const r = (await c.query('SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolconnlimit FROM pg_roles WHERE rolname=$1', [ROLE])).rows[0];
    check(r && !r.rolsuper && !r.rolcreatedb && !r.rolcreaterole && !r.rolreplication && !r.rolbypassrls && r.rolconnlimit === CONN_LIMIT, 'role attributes', JSON.stringify(r));
    check((await c.query('SELECT count(*)::int n FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=$1)', [ROLE])).rows[0].n === 0, 'no role memberships');

    // Schemas: USAGE only on public (others WARN), CREATE nowhere.
    const sch = (await c.query(`SELECT nspname n, has_schema_privilege($1, oid, 'USAGE') u, has_schema_privilege($1, oid, 'CREATE') c FROM pg_namespace WHERE ${SYSTEM_SCHEMAS_SQL}`, [ROLE])).rows;
    check(sch.filter((s) => s.c).length === 0, 'cannot CREATE in any schema', sch.filter((s) => s.c).map((s) => s.n).join(','));
    for (const s of sch) if (s.u && s.n !== 'public') warn(`USAGE on schema ${s.n}`, 'granted via PUBLIC or the role; table/column privileges there are checked below');

    // EXACT matrix over EVERY ordinary/partitioned table in EVERY non-system schema; only public.<name> in grants.json may carry privileges.
    const cols = (await c.query(`SELECT n.nspname s, c.relname t, a.attname col,
        has_column_privilege($1, c.oid, a.attnum, 'SELECT') sel, has_column_privilege($1, c.oid, a.attnum, 'INSERT') ins, has_column_privilege($1, c.oid, a.attnum, 'UPDATE') upd
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      WHERE c.relkind IN ('r','p','v','m','f') AND ${SYSTEM_SCHEMAS_SQL.replace(/nspname/g, 'n.nspname')}`, [ROLE])).rows;
    const want = (priv, s, t, col) => s === 'public' && (grants[priv][t] ?? []).includes(col);
    const drift = [];
    for (const x of cols) for (const [k, priv] of [['sel', 'select'], ['ins', 'insert'], ['upd', 'update']]) if (x[k] !== want(priv, x.s, x.t, x.col)) drift.push(`${priv}:${x.s}.${x.t}.${x.col}=${x[k] ? 'GRANTED' : 'missing'}`);
    const known = new Set(cols.filter((x) => x.s === 'public').map((x) => x.t));
    for (const priv of ['select', 'insert', 'update']) for (const t of Object.keys(grants[priv])) if (!known.has(t)) drift.push(`${priv}:${t}=table missing`);
    check(drift.length === 0, `column privileges match grants.json exactly (${cols.length} columns checked across all non-system schemas)`, drift.slice(0, 8).join('; '));
    const tbl = (await c.query(`SELECT n.nspname||'.'||c.relname t FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m','f') AND ${SYSTEM_SCHEMAS_SQL.replace(/nspname/g, 'n.nspname')}
      AND (has_table_privilege($1,c.oid,'DELETE') OR has_table_privilege($1,c.oid,'TRUNCATE') OR has_table_privilege($1,c.oid,'REFERENCES') OR has_table_privilege($1,c.oid,'TRIGGER'))`, [ROLE])).rows;
    check(tbl.length === 0, 'no DELETE/TRUNCATE/REFERENCES/TRIGGER on any relation', tbl.map((x) => x.t).join(','));
    const seq = (await c.query(`SELECT n.nspname||'.'||c.relname n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='S' AND ${SYSTEM_SCHEMAS_SQL.replace(/nspname/g, 'n.nspname')}
      AND (has_sequence_privilege($1,c.oid,'USAGE') OR has_sequence_privilege($1,c.oid,'UPDATE') OR has_sequence_privilege($1,c.oid,'SELECT'))`, [ROLE])).rows.map((x) => x.n).sort();
    check(JSON.stringify(seq) === JSON.stringify(grants.sequences.map((s) => `public.${s}`).sort()), 'sequence privileges match', seq.join(','));

    // Functions: the ONLY non-extension function the role may execute is the allowlisting audit function; any other SECURITY DEFINER is a FAIL.
    const fns = (await c.query(`SELECT n.nspname s, p.proname n, p.prosecdef sd FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE ${SYSTEM_SCHEMAS_SQL.replace(/nspname/g, 'n.nspname')} AND has_function_privilege($1,p.oid,'EXECUTE')
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.deptype='e')`, [ROLE])).rows;
    const allowed = new Set(grants.functions.map((f) => `public.${fnName(f)}`));
    const extra = fns.filter((f) => !allowed.has(`${f.s}.${f.n}`));
    check(grants.functions.every((f) => fns.some((x) => `${x.s}.${x.n}` === `public.${fnName(f)}`)), 'can EXECUTE the allowlisted audit function');
    check(!extra.some((f) => f.sd), 'no other SECURITY DEFINER function is executable', extra.filter((f) => f.sd).map((f) => `${f.s}.${f.n}`).join(','));
    if (extra.length) warn(`${extra.length} other non-extension function(s) executable (inherited from PUBLIC)`, extra.slice(0, 6).map((f) => `${f.s}.${f.n}`).join(','));

    // Real denials (normal transactions, always rolled back; exact SQLSTATE required).
    for (const [sql, label] of [['SELECT password_hash FROM users LIMIT 1', 'users.password_hash'], ['SELECT api_key FROM users LIMIT 1', 'users.api_key'],
      ['SELECT username FROM users LIMIT 1', 'users.username'], ['SELECT 1 FROM members LIMIT 1', 'members'], ['SELECT 1 FROM session_turns LIMIT 1', 'session_turns'],
      ['SELECT 1 FROM sync_sessions LIMIT 1', 'sync_sessions'], ['SELECT 1 FROM audit_log LIMIT 1', 'audit_log (read)']]) await probe(sql, `denied: ${label}`, '42501', true);
    for (const [sql, label] of [['DELETE FROM oauth_tokens WHERE false', 'DELETE oauth_tokens'], ['UPDATE audit_log SET action = action WHERE false', 'UPDATE audit_log'],
      ["INSERT INTO audit_log (action) VALUES ('mcp.forged')", 'direct INSERT audit_log'], ['UPDATE oauth_clients SET disabled_at = NULL WHERE false', 'UPDATE oauth_clients.disabled_at'],
      ['UPDATE users SET active = active WHERE false', 'UPDATE users']]) await probe(sql, `denied: ${label}`, '42501');
    await probe("SELECT mcp_audit_event('not_an_allowed_event', NULL, NULL, NULL, NULL)", 'audit function rejects an unlisted event (no row written)', '22023');
    await probe("SELECT mcp_audit_event('token_issued', NULL, 'not_a_type', NULL, NULL)", 'audit function rejects an unlisted target type', '22023');
  } finally { await c.end(); }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed.');
  process.exit(failed ? 1 : 0);
}

if (mode === 'plan') {
  console.log(`-- PLAN (nothing is executed). Role ${ROLE}, connection limit ${CONN_LIMIT}, from lib/mcp/grants.json`);
  console.log('-- The REVOKE block below is emitted once per non-system schema (discovered at apply time); only public is shown.\n');
  for (const s of [...roleStatements(false), ...grantStatements()]) console.log(`${s};`);
} else await (mode === 'apply' ? apply() : mode === 'drop' ? drop() : verify());
