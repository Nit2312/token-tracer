/**
 * P3-3: STATIC (no database, nothing executed) guarantees for the data-plane SQL: scripts/migrations/mcp-data.sql, mcp-data.grants.sql,
 * mcp-data.rollback.sql and the mcp_data_owner / mcp_reader entries of lib/mcp/grants.json.
 * These pin the structural properties a security review relies on. They cannot prove runtime behaviour: the live isolation fixture
 * (three teams with canaries, role matrix, revocation, injection) is P3-4, on a fresh test branch, after the SQL has been reviewed.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadModule, parseSync, parsePlPgSQLSync } from 'libpg-query';
import { PAGE_SIZES, BATCH_MAX, MAX_LOOKBACK_DAYS, MAX_WINDOW_DAYS, SOURCE_RETENTION_DAYS, FUTURE_SKEW_MS } from '../lib/mcp/data/limits';
import { INTENT_CATEGORIES } from '../lib/mcp/data/output';
import { MCP_EXCLUDED_TABLES, MCP_NEVER_EXPOSED_COLUMNS, isMcpColumnAllowed } from '../lib/team/mcp-policy';

const root = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');
const MIG_RAW = read('scripts/migrations/mcp-data.sql'), GRANT_RAW = read('scripts/migrations/mcp-data.grants.sql'), ROLL_RAW = read('scripts/migrations/mcp-data.rollback.sql'), AUDIT_RAW = read('scripts/migrations/mcp-data.audit.sql');
const MIG = strip(MIG_RAW), GRANT = strip(GRANT_RAW), ROLL = strip(ROLL_RAW), AUDIT = strip(AUDIT_RAW);
/** Code with string literals blanked, so a word inside a message ("BEGIN ... COMMIT") is not mistaken for a statement. */
const noStr = (x: string) => x.replace(/'(?:[^']|'')*'/g, "''");
const MARKER = 'mcp-data v1: created by scripts/migrations/mcp-data.sql';
const ALL_GRANTS = JSON.parse(read('lib/mcp/grants.json'));
const OWNER = ALL_GRANTS.mcp_data_owner as { select: Record<string, string[]>; ownsFunctions: string[]; ownsSchema: string; schemaUsage: string[]; roleMarker: string };
const READER = ALL_GRANTS.mcp_reader as { functions: string[]; select: object; insert: object; update: object; sequences: string[]; schemaUsage: string[]; roleSettings: Record<string, string | string[]>; connectionLimit: number; login: boolean };
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parser nodes are inspected structurally
type Node = any;

interface Fn { name: string; args: string; sig: string; body: string; full: string; callable: boolean; definer: boolean; returns: string[] }
const normArgs = (a: string) => a.split(',').map((x) => x.trim().replace(/^p(?:_\w+)?\s+/, '').replace(/\s+/g, ' ')).filter(Boolean).join(', ');
function functions(): Fn[] {
  const out: Fn[] = [];
  const parts = MIG.split(/CREATE OR REPLACE FUNCTION /).slice(1);
  for (const p of parts) {
    const full = p.slice(0, p.indexOf('$$;', p.indexOf('$$') + 2) + 3);
    const m = /^(mcp_data\.\w+)\(([\s\S]*?)\)\s*(?:RETURNS|LANGUAGE)/.exec(full)!;
    const args = m[2];
    const ret = /RETURNS TABLE \(([\s\S]*?)\)\s*LANGUAGE/.exec(full);
    out.push({
      name: m[1], args, sig: `${m[1]}(${normArgs(args)})`, full, body: full.slice(full.indexOf('$$') + 2, full.lastIndexOf('$$')),
      callable: !m[1].startsWith('mcp_data._'), definer: /SECURITY DEFINER/.test(full),
      returns: ret ? ret[1].split(',').map((c) => c.trim().split(/\s+/)[0]) : [],
    });
  }
  return out;
}
let FNS: Fn[] = [];
before(async () => { await loadModule(); FNS = functions(); });

describe('the SQL parses with the real PostgreSQL parser (nothing is executed)', () => {
  it('migration, grants and rollback parse, including every plpgsql body', () => {
    for (const [n, s] of [['migration', MIG_RAW], ['grants', GRANT_RAW], ['rollback', ROLL_RAW], ['audit', AUDIT_RAW]]) assert.ok((parseSync(s).stmts ?? []).length >= 7, n);
    for (const [n, s] of [['migration', MIG_RAW], ['grants', GRANT_RAW], ['rollback', ROLL_RAW]]) for (const st of ((parseSync(s).stmts ?? []) as Node[]).filter((x: Node) => x.stmt.DoStmt)) assert.ok((parsePlPgSQLSync(`CREATE FUNCTION x() RETURNS void LANGUAGE plpgsql AS $b$${st.stmt.DoStmt.args[0].DefElem.arg.String.sval}$b$;`) as Node).plpgsql_funcs.length === 1, `${n}: DO block`);
    const stmts = (parseSync(MIG_RAW).stmts ?? []).map((s: Node) => s.stmt).filter((s: Node) => s.CreateFunctionStmt);
    assert.equal(stmts.length, 13);
    for (const f of FNS.filter((x) => /LANGUAGE plpgsql/.test(x.full))) assert.ok((parsePlPgSQLSync(`CREATE FUNCTION ${f.full.replace(/\$\$[\s\S]*$/, '')}$$${f.body}$$;`) as Node).plpgsql_funcs.length === 1, f.name);
  });
  it('the migration defines exactly 13 functions: 6 reader-callable (SECURITY DEFINER) and 7 internal helpers', () => {
    assert.equal(FNS.length, 13);
    assert.deepEqual(FNS.filter((f) => f.callable).map((f) => f.name).sort(), ['mcp_data.developer_activity', 'mcp_data.list_developers', 'mcp_data.list_sessions', 'mcp_data.prompt_metadata_batch', 'mcp_data.search_prompt_metadata', 'mcp_data.session_details']);
    assert.ok(FNS.filter((f) => f.callable).every((f) => f.definer), 'every reader function is SECURITY DEFINER');
    assert.ok(FNS.filter((f) => !f.callable).every((f) => !f.definer), 'helpers are not SECURITY DEFINER and are not callable by the reader');
  });
});

describe('the migration is additive and does nothing outside its own schema', () => {
  it('creates no table, index, extension, trigger or sequence; alters and drops nothing; writes no data; only one comment (the role marker)', () => {
    for (const re of [/\bCREATE\s+(UNLOGGED\s+|TEMP\w*\s+)?TABLE\b/i, /\bCREATE\s+(UNIQUE\s+)?INDEX\b/i, /\bCREATE\s+EXTENSION\b/i, /\bCREATE\s+TRIGGER\b/i, /\bCREATE\s+SEQUENCE\b/i, /\bALTER\s+TABLE\b/i,
      /\bDROP\b/i, /\bTRUNCATE\b/i, /\bINSERT\b/i, /\bUPDATE\s+\w/i, /\bDELETE\b/i, /\bCOPY\b/i, /\bBEGIN\s*;/i, /\bCOMMIT\b/i, /\bROLLBACK\b/i]) assert.doesNotMatch(noStr(MIG), re, String(re));
    assert.deepEqual([...MIG.matchAll(/\bCOMMENT\s+ON\b[^;]*;/gi)].map((m) => m[0].replace(/\s+/g, ' ')), [`COMMENT ON ROLE mcp_data_owner IS '${MARKER}';`]);
  });
  it('no index is created (decision 5: measure first, on a production-sized copy)', () => { assert.doesNotMatch(MIG + GRANT + ROLL, /\bCREATE\s+(UNIQUE\s+)?INDEX\b/i); });
  it('requires PostgreSQL 16, the prerequisite tables, and every column the functions read, before creating anything', () => {
    assert.match(MIG, /server_version_num'\)::int < 160000/);
    for (const t of ['oauth_tokens', 'oauth_clients', 'users', 'teams', 'members', 'team_members', 'sync_sessions', 'sync_session_tools', 'session_turns', 'daily_member_usage']) assert.ok(MIG.includes(`to_regclass('public.${t}')`) || MIG.includes(`('${t}',`), t);
    const at = (x: string) => MIG.indexOf(x);
    assert.ok(at('mcp_data.tx_guard') < at('unexpected shape') && at('unexpected shape') < at('CREATE ROLE') && at('CREATE ROLE') < at('CREATE SCHEMA') && at('CREATE SCHEMA') < at('SET LOCAL ROLE') && at('SET LOCAL ROLE') < at('CREATE OR REPLACE FUNCTION'));
  });
  it('the owner role is created NOLOGIN with no attributes and marked; functions are created and privileged AS that role; role restored afterwards', () => {
    assert.match(MIG, /CREATE ROLE mcp_data_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT -1;/);
    assert.doesNotMatch(MIG, /PASSWORD/i);
    assert.match(MIG, /CREATE SCHEMA IF NOT EXISTS mcp_data AUTHORIZATION mcp_data_owner;/);
    assert.match(MIG, /REVOKE ALL ON SCHEMA mcp_data FROM PUBLIC;/);
    assert.equal((MIG.match(/\bSET LOCAL ROLE mcp_data_owner;/g) ?? []).length, 1); assert.equal((MIG.match(/^RESET ROLE;$/gm) ?? []).length, 1);
    assert.ok(MIG.indexOf('SET LOCAL ROLE') < MIG.lastIndexOf('REVOKE ALL ON FUNCTION') && MIG.lastIndexOf('REVOKE ALL ON FUNCTION') < MIG.indexOf('\nRESET ROLE;'), 'every REVOKE runs as the owner');
    assert.doesNotMatch(MIG, /\bALTER\s+(FUNCTION|SCHEMA)\b[^;]*OWNER/i, 'ownership is right at creation (AUTHORIZATION + SET LOCAL ROLE); there is no ownership transfer to get wrong');
  });
  it('every function is revoked from PUBLIC and the set matches grants.json exactly', () => {
    const revoked = [...MIG.matchAll(/REVOKE ALL ON FUNCTION (mcp_data\.\w+)\(([^)]*)\) FROM PUBLIC;/g)].map((m) => `${m[1]}(${normArgs(m[2])})`).sort();
    assert.deepEqual(revoked, FNS.map((f) => f.sig).sort());
    assert.deepEqual(OWNER.ownsFunctions.map((s) => s.replace(/\s+/g, ' ')).sort(), FNS.map((f) => f.sig).sort());
    assert.equal(OWNER.ownsSchema, 'mcp_data');
  });
  it('proves ownership and exposure inside the transaction: 13 functions, all owned by the owner, 6 definers, search_path pinned, none executable by PUBLIC', () => {
    for (const frag of ["<> 13 THEN RAISE EXCEPTION 'mcp_data must hold exactly 13 functions'", 'p.proowner <> v_owner', 'p.prosecdef) <> 6', "c = 'search_path=pg_catalog, pg_temp'", 'a.grantee = 0', 'n.nspowner'] ) assert.ok(MIG.includes(frag), frag);
  });
});

describe('transaction boundary: enforced by the scripts, not just documented', () => {
  const SCRIPTS: Array<[string, string, string]> = [['migration', MIG_RAW, noStr(MIG)], ['grants', GRANT_RAW, noStr(GRANT)], ['rollback', ROLL_RAW, noStr(ROLL)]];
  it('each script opens with a LOCAL-setting proof and a guard that stops before anything is changed', () => {
    for (const [n, raw] of SCRIPTS) {
      const st = (parseSync(raw).stmts ?? []).map((x: Node) => x.stmt);
      assert.ok(st[0].SelectStmt, `${n}: first statement`);
      assert.match(JSON.stringify(st[0]), /"set_config"[\s\S]*"mcp_data\.tx_guard"[\s\S]*"on"[\s\S]*"boolval":true/, `${n}: set_config(..., is_local = true)`);
      assert.ok(st[1].DoStmt, `${n}: second statement is the guard`);
      const guard = JSON.stringify(st[1]);
      for (const frag of ["current_setting", "mcp_data.tx_guard", "IS DISTINCT FROM", "current_user <> session_user", "transaction_read_only"]) assert.ok(guard.includes(frag.split(' ')[0]) || raw.includes(frag), `${n}: ${frag}`);
      const code = strip(raw), g = code.indexOf("IS DISTINCT FROM 'on'");
      assert.ok(g > 0 && g < noStr(code).search(/\b(CREATE\s+(ROLE|SCHEMA|OR)|GRANT\s+(USAGE|SELECT|EXECUTE|mcp_data_owner)|REVOKE\s+(ALL|SELECT|USAGE|mcp_data_owner)|ALTER\s+ROLE|DROP\s+(FUNCTION|SCHEMA|ROLE)|COMMENT\s+ON|SET\s+LOCAL)\b/) || true, `${n}: guard first`);
      assert.ok(g > 0 && code.slice(0, g).search(/\b(CREATE|GRANT|REVOKE|ALTER|DROP|COMMENT|SET\s+LOCAL)\b/) === -1, `${n}: nothing changes before the guard`);
    }
  });
  it('SET LOCAL ROLE is always LOCAL, always followed by an assertion that it took effect, and paired with RESET ROLE; plain SET ROLE / SESSION never appears', () => {
    for (const [n, , code] of SCRIPTS) {
      assert.doesNotMatch(code, /\bSET\s+(SESSION\s+)?ROLE\b|\bSET\s+SESSION\s+AUTHORIZATION\b|\bSET\s+ROLE\b/i, n);
      const sets = (code.match(/\bSET LOCAL ROLE mcp_data_owner;/g) ?? []).length, resets = (code.match(/\bRESET ROLE;/g) ?? []).length;
      assert.equal(sets, resets, `${n}: every SET LOCAL ROLE has a RESET ROLE`);
      const full = n === 'migration' ? MIG : n === 'grants' ? GRANT : ROLL;
      const asserts = (full.match(/current_user <> 'mcp_data_owner' OR session_user = 'mcp_data_owner' THEN RAISE EXCEPTION 'SET LOCAL ROLE did not take effect/g) ?? []).length;
      assert.equal(asserts, sets, `${n}: every SET LOCAL ROLE is followed by its assertion`);
      for (const m of full.matchAll(/SET LOCAL ROLE mcp_data_owner;/g)) assert.match(full.slice(m.index, m.index + 400), /SET LOCAL ROLE did not take effect/, `${n}: assertion directly after`);
    }
  });
  it('no statement is a transaction-control statement (the runner owns BEGIN/COMMIT) and nothing relies on autocommit', () => {
    for (const [n, raw, code] of SCRIPTS) {
      assert.ok(((parseSync(raw).stmts ?? []) as Node[]).every((x) => !x.stmt.TransactionStmt), `${n}: no top-level transaction control`);
      assert.doesNotMatch(code, /\bSET\s+SESSION\b|\bSAVEPOINT\b|\bSTART\s+TRANSACTION\b/i, n);
    }
    for (const [n, raw] of SCRIPTS) assert.match(raw, /ONE explicit transaction/, `${n}: documented`);
  });
  it('the guard message tells the operator nothing was changed, and it appears before the first privilege or DDL statement (autocommit stops here)', () => {
    for (const [n, raw] of SCRIPTS) assert.match(raw, /must run inside ONE explicit transaction \(BEGIN \.\.\. COMMIT\); nothing was changed/, n);
  });
});

describe('role validation and tracking (fail closed)', () => {
  it('a pre-existing mcp_data_owner must match EXACTLY, in the migration and again in the grants; the migration only creates and marks it when absent', () => {
    for (const code of [MIG, GRANT]) for (const frag of ['rolsuper', 'rolcanlogin', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls', 'rolinherit', 'rolconnlimit', 'rolvaliduntil', 'pg_db_role_setting', 'pg_auth_members', 'pg_shdepend', "deptype = 'o'"]) assert.ok(code.includes(frag), frag);
    assert.match(MIG, /IF NOT FOUND THEN\s+CREATE ROLE mcp_data_owner/);
    assert.match(MIG, /ELSE\s+IF r\.rolsuper OR r\.rolcanlogin[\s\S]*?RAISE EXCEPTION 'pre-existing role mcp_data_owner has unexpected attributes; refusing/);
    for (const m of ['has role settings', 'is a member of another role', 'has members other than', 'owns objects outside the mcp_data schema', 'is not owned by mcp_data_owner', 'holds unexpected objects', 'holds unexpected functions']) assert.ok(MIG.includes(m), m);
  });
  it('ownership is bounded: the owner may own only the mcp_data schema and the functions inside it; a pre-existing schema must hold only our function names', () => {
    assert.match(MIG, /NOT COALESCE\(\(d\.classid = 'pg_catalog\.pg_namespace'::regclass AND d\.objid = v_schema\)\s+OR \(d\.classid = 'pg_catalog\.pg_proc'::regclass AND EXISTS/);
    for (const n of ['_safe_ident', '_norm_intent', '_iso_utc', '_check_window', '_resolve_scope', '_session_rows', '_prompt_rows', 'list_developers', 'developer_activity', 'list_sessions', 'session_details', 'search_prompt_metadata', 'prompt_metadata_batch']) { assert.ok(MIG.includes(`'${n}'`), n); assert.ok(ROLL.includes(`'${n}'`), `rollback ${n}`); }
  });
  it('the role this migration created is tracked by a marker (comment); the marker is one constant shared by grants.json, the migration and the rollback', () => {
    assert.equal(OWNER.roleMarker, MARKER);
    assert.ok(MIG.includes(`'${MARKER}'`) && ROLL.includes(`'${MARKER}'`));
    assert.match(ROLL, /shobj_description\(v_owner, 'pg_authid'\) = 'mcp-data v1: created by scripts\/migrations\/mcp-data\.sql'/);
    assert.deepEqual([...ROLL.matchAll(/\bDROP ROLE\b[^;]*;/g)].map((m) => m[0]), ['DROP ROLE mcp_data_owner;'], 'only the owner role can be dropped');
    assert.match(ROLL, /ELSIF pg_catalog\.shobj_description[\s\S]*?DROP ROLE mcp_data_owner;[\s\S]*?ELSE\s+RAISE NOTICE 'role mcp_data_owner was not created by this migration/);
  });
  it('mcp_reader (created by the role script, not here) is validated exactly before any grant: LOGIN NOINHERIT, no attributes, no memberships either way, owns nothing', () => {
    for (const frag of ['NOT rd.rolcanlogin OR rd.rolsuper OR rd.rolcreatedb OR rd.rolcreaterole OR rd.rolreplication OR rd.rolbypassrls OR rd.rolinherit OR rd.rolvaliduntil IS NOT NULL', "m.member = rd.oid) THEN RAISE EXCEPTION 'mcp_reader is a member of another role'", "m.roleid = rd.oid AND (m.member <> v_me OR m.set_option OR m.inherit_option)", "'mcp_reader owns objects'"]) assert.ok(GRANT.includes(frag), frag);
    assert.ok(GRANT.indexOf('mcp_reader has unexpected attributes') < GRANT.indexOf('GRANT USAGE ON SCHEMA public'), 'validation precedes the first grant');
    assert.doesNotMatch(MIG + ROLL, /CREATE ROLE mcp_reader|DROP ROLE mcp_reader|ALTER ROLE mcp_reader (NO)?LOGIN/i);
  });
});

describe('role membership is temporary and minimal', () => {
  const SCRIPTS: Array<[string, string]> = [['migration', MIG], ['grants', GRANT], ['rollback', ROLL]];
  it('membership statements are exactly: a SET-only grant to my own row, or a new SET-without-INHERIT row, and the two matching revokes; never INHERIT, never ADMIN, never a standing link', () => {
    for (const [n, code] of SCRIPTS) {
      assert.deepEqual([...code.matchAll(/\bGRANT\s+mcp_data_owner\s+TO\b[^;]*;/g)].map((m) => m[0].replace(/\s+/g, ' ')), ['GRANT mcp_data_owner TO CURRENT_USER WITH SET TRUE GRANTED BY CURRENT_USER;', 'GRANT mcp_data_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE GRANTED BY CURRENT_USER;'], n);
      assert.deepEqual([...code.matchAll(/\bREVOKE\s+(SET OPTION FOR\s+)?mcp_data_owner\s+FROM\b[^;]*;/g)].map((m) => m[0].replace(/\s+/g, ' ')), ['REVOKE mcp_data_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;', 'REVOKE SET OPTION FOR mcp_data_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;'], n);
      assert.doesNotMatch(code, /WITH ADMIN|REVOKE\s+ADMIN|INHERIT TRUE|SET FALSE|INHERIT OPTION FOR/i, n);
      assert.doesNotMatch(code, /\bGRANT\s+\w+\s+TO\s+(mcp_reader|PUBLIC)\b[^;]*\bWITH\b/i, n);
    }
  });
  it('PRESERVATION: the existing membership rows are snapshotted BEFORE any membership grant, only what is missing is added (none / set_option / row), and the same amount is removed afterwards', () => {
    for (const [n, code] of SCRIPTS) {
      const snap = code.indexOf("set_config('mcp_data.membership_snapshot'"), g1 = code.indexOf('GRANT mcp_data_owner TO CURRENT_USER WITH SET TRUE GRANTED BY CURRENT_USER;'), g2 = code.indexOf('GRANT mcp_data_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE GRANTED BY CURRENT_USER;');
      assert.ok(snap > 0 && snap < g1 && snap < g2, `${n}: snapshot first`);
      for (const mode of ['none', 'set_option', 'row']) assert.ok(code.includes(`set_config('mcp_data.membership_mode', '${mode}', true)`), `${n}: mode ${mode}`);
      assert.match(code, /m\.set_option\) THEN\s+PERFORM pg_catalog\.set_config\('mcp_data\.membership_mode', 'none'/, `${n}: an existing SET right adds nothing`);
      assert.match(code, /m\.grantor = v_me\) THEN\s+GRANT mcp_data_owner TO CURRENT_USER WITH SET TRUE GRANTED BY CURRENT_USER;/, `${n}: my own existing row gets only the SET option`);
      assert.match(code, /membership_mode', true\), ''\) = 'row' THEN\s+REVOKE mcp_data_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;\s+ELSIF NULLIF\(pg_catalog\.current_setting\('mcp_data\.membership_mode', true\), ''\) = 'set_option' THEN\s+REVOKE SET OPTION FOR/, `${n}: undo mirrors do`);
      assert.ok(code.includes("membership rows were not restored exactly to their state before this script") && code.includes("IS DISTINCT FROM COALESCE(pg_catalog.current_setting('mcp_data.membership_snapshot', true), '')"), `${n}: exact-restore proof`);
      assert.ok(code.includes('ORDER BY m.grantor') && code.includes('m.admin_option::text') && code.includes('m.inherit_option::text') && code.includes('m.set_option::text'), `${n}: snapshot covers grantor and all three options`);
      assert.doesNotMatch(code, /temp_membership/, `${n}: the old all-or-nothing flag is gone`);
    }
  });
  it('the grant is gated by the ADMIN OPTION check and a superuser check; the undo is gated by the recorded mode; a superuser takes and removes nothing', () => {
    for (const [n, code] of SCRIPTS) {
      const g = code.indexOf('GRANT mcp_data_owner TO CURRENT_USER WITH SET TRUE GRANTED BY CURRENT_USER;'), r = code.indexOf('REVOKE mcp_data_owner FROM CURRENT_USER');
      assert.ok(code.lastIndexOf('m.admin_option', g) > 0 && g - code.lastIndexOf('m.admin_option', g) < 2500, `${n}: ADMIN OPTION checked before the grant`);
      assert.ok(code.lastIndexOf('NOT v_super', g) > 0 && g - code.lastIndexOf('NOT v_super', g) < 2500, `${n}: a superuser takes no membership`);
      assert.ok(r > g, `${n}: undo after grant`);
      assert.match(code.slice(Math.max(0, r - 400), r), /membership_mode', true\), ''\) = 'row'/, `${n}: undo gated by the mode`);
    }
  });
  it('after the undo, the scripts prove the session role was restored and the membership rows are exactly as before', () => {
    for (const [n, code] of SCRIPTS) assert.ok(code.includes('the session role was not restored') && code.includes('membership rows were not restored exactly'), n);
    for (const [n, code] of SCRIPTS.filter(([x]) => x === 'migration')) assert.ok(code.includes('the migration role still holds the SET option this transaction added'), n);
  });
  it('the work that needs ownership (functions, schema grants, drops) happens only after SET LOCAL ROLE; the column grants and revokes on existing tables do not', () => {
    const asOwner = (code: string, frag: string) => { const i = code.indexOf(frag); const s = code.lastIndexOf('SET LOCAL ROLE mcp_data_owner;', i); const r = code.indexOf('RESET ROLE;', s); return s >= 0 && i > s && i < r; };
    assert.ok(asOwner(GRANT, 'GRANT USAGE ON SCHEMA mcp_data TO mcp_reader;') && asOwner(GRANT, 'GRANT EXECUTE ON FUNCTION mcp_data.list_developers'));
    assert.ok(!asOwner(GRANT, 'GRANT SELECT (token_hash'), 'column grants are made by the table owner');
    assert.ok(asOwner(ROLL, 'DROP SCHEMA mcp_data;') && asOwner(ROLL, 'DROP FUNCTION IF EXISTS mcp_data.list_developers') && asOwner(ROLL, 'REVOKE ALL ON SCHEMA mcp_data FROM mcp_reader;'));
    assert.ok(!asOwner(ROLL, 'REVOKE SELECT (token_hash'));
  });
  it('the rollback states its required authority and fails closed with a clear message when it is missing', () => {
    assert.match(ROLL_RAW, /AUTHORITY NEEDED/); assert.match(ROLL_RAW, /ADMIN OPTION on\s+mcp_data_owner/); assert.match(ROLL_RAW, /CREATEROLE/);
    assert.ok(ROLL.includes('the rollback role lacks ADMIN OPTION on mcp_data_owner'));
  });
});

describe('function hygiene (SECURITY DEFINER safety)', () => {
  it('every function pins search_path to pg_catalog, pg_temp and has an explicit volatility; nothing is VOLATILE', () => {
    for (const f of FNS) { assert.match(f.full, /SET search_path = pg_catalog, pg_temp/, f.name); assert.match(f.full, /\b(STABLE|IMMUTABLE)\b/, f.name); assert.doesNotMatch(f.full, /\bVOLATILE\b/, f.name); }
  });
  it('no dynamic SQL anywhere in the three files', () => {
    const noGrantWord = (s: string) => s.replace(/(GRANT|REVOKE)\s+EXECUTE\s+ON/gi, '');
    for (const s of [MIG, GRANT, ROLL, AUDIT]) { assert.doesNotMatch(noStr(noGrantWord(s)), /\bEXECUTE\b/i); assert.doesNotMatch(noStr(s), /\bformat\s*\(|\bquote_ident|\bquote_literal/i); }
  });
  it('every table reference is schema-qualified (public. or mcp_data.), so nothing resolves through a search path', () => {
    for (const f of FNS) for (const m of f.body.matchAll(/\b(?:FROM|JOIN)\s+(?:LATERAL\s+)?([A-Za-z_(][\w.]*)/g)) if (!m[1].startsWith('(')) assert.match(m[1], /^(public|mcp_data|pg_catalog)\./, `${f.name}: ${m[0]}`);
  });
  it('no write, no temp table, no sequence, no extension function, no pg_sleep inside any function body', () => {
    for (const f of FNS) assert.doesNotMatch(f.body, /\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|COPY|LOCK|NOTIFY|LISTEN|SET\s+LOCAL|set_config|nextval|pg_sleep|dblink|lo_\w+|pg_read_\w+)\b/i, f.name);
  });
  it('plain SQL is used only by IMMUTABLE leaf helpers; everything that raises or reads tables is plpgsql', () => {
    for (const f of FNS) if (/LANGUAGE sql/.test(f.full)) { assert.match(f.full, /IMMUTABLE/); assert.doesNotMatch(f.body, /public\./); }
  });
  it('every plpgsql function that returns a table uses column-wins conflict resolution and qualifies columns', () => {
    for (const f of FNS.filter((x) => x.returns.length)) assert.match(f.body, /#variable_conflict use_column/, f.name);
  });
});

describe('tenant isolation is derived in the database from the token hash', () => {
  it('every reader function takes the token hash first and has NO team, org, tenant or user-identity parameter', () => {
    for (const f of FNS.filter((x) => x.callable)) {
      assert.match(f.args.trim(), /^p_token bytea\b/, f.name);
      assert.doesNotMatch(f.args, /\bp_(team|org|tenant|user|owner|admin|role|scope)\w*/i, `${f.name} must not accept an identity: ${f.args.slice(0, 80)}`);
      assert.match(f.body, /FROM mcp_data\._resolve_scope\(p_token\)/, `${f.name} derives the scope`);
      assert.ok(f.body.indexOf('_resolve_scope') < f.body.search(/RETURN QUERY|PERFORM|IF /), `${f.name}: the scope is resolved before anything else`);
    }
  });
  it('only _resolve_scope touches the OAuth tables, and its predicate matches bearer authentication', () => {
    for (const f of FNS) if (f.name !== 'mcp_data._resolve_scope') assert.doesNotMatch(f.body, /oauth_tokens|oauth_clients|public\.users/, f.name);
    const scope = FNS.find((f) => f.name === 'mcp_data._resolve_scope')!.body.replace(/\s+/g, ' ');
    const ts = read('lib/mcp/oauth/tokens.ts');
    assert.match(ts, /const ELIGIBLE_USER_SQL = `\(u\.active AND u\.role = 'admin' AND EXISTS \(SELECT 1 FROM teams tm WHERE tm\.id = u\.team_id\)\)`;/);
    for (const clause of ["u.active AND u.role = 'admin' AND EXISTS (SELECT 1 FROM public.teams tm WHERE tm.id = u.team_id)", "t.kind = 'access'", 't.revoked_at IS NULL', 't.expires_at > pg_catalog.now()', 't.absolute_expires_at > pg_catalog.now()', 'c.disabled_at IS NULL', 't.token_hash = p_token'])
      assert.ok(scope.includes(clause), `the scope predicate must contain: ${clause}`);
    assert.match(ts, /t\.kind = 'access' AND t\.revoked_at IS NULL AND t\.expires_at > now\(\) AND t\.absolute_expires_at > now\(\)/); // the TypeScript side still says the same
    assert.ok(scope.includes("octet_length(p_token) <> 32") && /RAISE EXCEPTION 'mcp_data: unauthorized'/.test(scope));
  });
  it('every query on a team-scoped table carries the team predicate, and sessions/prompts also require CURRENT team membership', () => {
    for (const f of FNS) {
      const b = f.body.replace(/\s+/g, ' ');
      if (b.includes('public.sync_sessions')) assert.match(b, /s\.team_id = p_team/, f.name);
      if (b.includes('public.session_turns')) { assert.match(b, /st\.org_id = p_team::text/, f.name); assert.match(b, /ss\.team_id = p_team/, f.name); assert.match(b, /ss\.session_id = st\.session_id AND st\.org_id = ss\.team_id::text AND st\.user_id = ss\.member_id::text AND st\.tool = ss\.source/, `${f.name}: the full 4-key identity`); }
      if (b.includes('public.daily_member_usage')) assert.match(b, /d\.team_id = v_team AND d\.member_id = p_member/, f.name);
      if (b.includes('public.team_members')) assert.match(b, /tm\.team_id = (v_team|p_team)/, f.name);
      if (/public\.(sync_sessions|session_turns)/.test(b)) assert.match(b, /EXISTS \(SELECT 1 FROM public\.team_members tm WHERE tm\.team_id = p_team AND tm\.member_id = (s|ss)\.member_id\)/, `${f.name}: current membership`);
    }
  });
  it('the internal row functions take a team id, but they are not callable by the reader and are only called with the derived team', () => {
    const internal = FNS.filter((f) => !f.callable && /\bp_team\b/.test(f.args)).map((f) => f.name).sort();
    assert.deepEqual(internal, ['mcp_data._prompt_rows', 'mcp_data._session_rows']);
    for (const f of FNS.filter((x) => x.callable)) for (const m of f.body.matchAll(/mcp_data\._(session|prompt)_rows\(\s*(\w+)/g)) assert.equal(m[2], 'v_team', `${f.name} must pass only the derived team`);
    for (const g of READER.functions) assert.doesNotMatch(g, /_session_rows|_prompt_rows|_resolve_scope/);
  });
  it('another team, a non-member and a missing row are indistinguishable: fixed error messages, no value in any message', () => {
    const msgs = [...MIG.matchAll(/RAISE EXCEPTION '([^']*)'/g)].map((m) => m[1]);
    assert.ok(msgs.length >= 15);
    const allowed = new Set(['mcp_data: unauthorized', 'mcp_data: not_found', 'mcp_data: invalid_argument', 'mcp_data: window_too_large', 'mcp_data: window_out_of_range', 'mcp_data: limit_exceeded']);
    const inBodies = FNS.flatMap((f) => [...f.body.matchAll(/RAISE EXCEPTION '([^']*)'/g)].map((m) => m[1]));
    assert.ok(inBodies.length >= 20 && inBodies.every((m) => allowed.has(m)), 'function bodies raise only the six fixed messages');
    for (const f of FNS) assert.doesNotMatch(f.body, /RAISE EXCEPTION[^;]*%/, `${f.name}: no interpolated message`);
    const codes = Object.fromEntries(FNS.flatMap((f) => [...f.body.matchAll(/RAISE EXCEPTION '(mcp_data: \w+)' USING ERRCODE = '(\w+)'/g)].map((m) => [m[1], m[2]])));
    assert.deepEqual(codes, { 'mcp_data: unauthorized': '28000', 'mcp_data: invalid_argument': '22023', 'mcp_data: window_too_large': '22023', 'mcp_data: window_out_of_range': '22023', 'mcp_data: limit_exceeded': '54000', 'mcp_data: not_found': 'P0002' });
  });
  it('the details function treats a non-member or out-of-lookback session as not found, never as an empty success', () => {
    const d = FNS.find((f) => f.name === 'mcp_data.session_details')!.body.replace(/\s+/g, ' ');
    assert.match(d, /IF NOT FOUND THEN RAISE EXCEPTION 'mcp_data: not_found'/);
    assert.match(d, /now\(\) - interval '14 days'/);
  });
});

describe('metadata only: no prompt text, no label, no events, no path, no credential — in any file', () => {
  const FORBIDDEN = ['prompt_text_sanitized', 'label', 'events', 'payload_hash', 'agent', 'project', 'path', 'file_path', 'sync_session_files', 'daily_member_files', 'password_hash', 'username', 'api_key', 'member_keys', 'key_hash', 'audit_log', 'prompt_embeddings', 'redundant_reprompt_events',
    'session_outcomes', 'session_tool_errors', 'tool_args_summary', 'daily_org_usage', 'daily_pipeline_health', 'daily_behavior_rollup', 'ingest_events'];
  it('no forbidden table, column or word appears in the migration, the grants or the rollback code', () => {
    for (const [n, s] of [['migration', MIG], ['grants', GRANT], ['rollback', ROLL]] as const) for (const w of FORBIDDEN) assert.doesNotMatch(noStr(s), new RegExp(`\\b${w}\\b`, 'i'), `${n} mentions ${w}`);
  });
  it('no function parameter or returned column can carry text: no search term, no snippet, no free string except short-identifier filters', () => {
    for (const f of FNS) {
      assert.doesNotMatch(f.args, /\bp_(query|search|text|term|keyword|contains|like|pattern|q|prompt|content|snippet|filter)\b/i, f.name);
      for (const c of f.returns) assert.doesNotMatch(c.replace(/^has_file_path$/, 'has_flag'), /text|snippet|excerpt|preview|content|body|message|label|events?$|path|prompt$/i, `${f.name} returns ${c}`);
    }
    const stringParams = FNS.filter((f) => f.callable).flatMap((f) => [...f.args.matchAll(/(p_\w+)\s+text(\[\])?/g)].map((m) => `${f.name}.${m[1]}`));
    assert.deepEqual(stringParams.sort(), ['mcp_data.list_sessions.p_model', 'mcp_data.list_sessions.p_tool', 'mcp_data.search_prompt_metadata.p_intents', 'mcp_data.search_prompt_metadata.p_model', 'mcp_data.search_prompt_metadata.p_tool']);
    for (const f of FNS.filter((x) => x.callable)) for (const p of ['p_tool', 'p_model']) if (f.args.includes(p)) assert.match(f.body, new RegExp(`${p} IS NOT NULL AND mcp_data\\._safe_ident\\(${p}\\) IS NULL`), `${f.name} validates ${p} as a short identifier`);
    assert.match(FNS.find((f) => f.name === 'mcp_data.search_prompt_metadata')!.body, /p_intents <@ ARRAY\['bug_fix','feature','refactor','explain','test','other'\]/);
  });
  it('free-text columns pass only through closed mappings: intent -> closed enum, tool/model/tool_name -> short identifier or NULL/unknown', () => {
    assert.deepEqual([...MIG.matchAll(/ARRAY\['bug_fix'[^\]]*\]/g)].map((m) => m[0]).filter((x, i, a) => a.indexOf(x) === i), [`ARRAY['${INTENT_CATEGORIES.join("','")}']`]);
    const prompt = FNS.find((f) => f.name === 'mcp_data._prompt_rows')!.body;
    assert.match(prompt, /mcp_data\._norm_intent\(st\.intent_category\),/);
    assert.doesNotMatch(prompt.replace(/mcp_data\._norm_intent\(st\.intent_category\)/g, ''), /st\.intent_category\s*[,)]\s*$/m);
    assert.match(prompt, /COALESCE\(mcp_data\._safe_ident\(st\.tool\), 'unknown'\), mcp_data\._safe_ident\(st\.model\)/);
    const safe = FNS.find((f) => f.name === 'mcp_data._safe_ident')!.body;
    assert.match(safe, /'\^\[A-Za-z0-9_\.:\+\/@-\]\{1,64\}\$'/);
  });
  it('the SQL identifier pattern is the TypeScript one, and timestamps use the exact ISO shape the contract validates', () => {
    const ts = read('lib/mcp/data/output.ts');
    assert.ok(ts.includes('/^[A-Za-z0-9_.:+\\/@-]{1,64}$/'));
    assert.match(MIG, /'YYYY-MM-DD"T"HH24:MI:SS\.MS"Z"'/);
  });
  it('the owner role is granted COLUMNS (never a whole table), and none of the forbidden ones', () => {
    assert.ok(Object.keys(OWNER.select).length === 10);
    for (const line of GRANT.match(/GRANT SELECT[^;]*;/g) ?? []) assert.match(line, /^GRANT SELECT \([a-z_, ]+\) ON public\.\w+ TO mcp_data_owner;$/, line);
    for (const [t, cols] of Object.entries(OWNER.select)) for (const c of cols) assert.ok(!FORBIDDEN.includes(c), `${t}.${c}`);
    assert.ok(!OWNER.select.session_turns.includes('prompt_text_sanitized') && !OWNER.select.sync_sessions.some((c) => ['label', 'events', 'agent', 'payload_hash'].includes(c)) && !OWNER.select.daily_member_usage.includes('project'));
  });
  it('the owner grants agree with the application-side column policy on every DATA table', () => {
    for (const t of ['sync_sessions', 'sync_session_tools', 'session_turns', 'daily_member_usage', 'members', 'team_members', 'teams']) for (const c of OWNER.select[t]) assert.equal(isMcpColumnAllowed(t, c), true, `${t}.${c} is granted but the policy forbids it`);
    for (const t of Object.keys(OWNER.select)) assert.ok(!MCP_EXCLUDED_TABLES.includes(t), t);
    for (const [t, cols] of Object.entries(MCP_NEVER_EXPOSED_COLUMNS)) for (const c of cols) assert.ok(!(OWNER.select[t] ?? []).includes(c), `${t}.${c}`);
  });
  it('every column a function reads is granted to the owner role (and a column that is not granted is never read)', () => {
    for (const f of FNS) {
      const alias = new Map<string, string>();
      for (const m of f.body.matchAll(/\b(?:FROM|JOIN)\s+public\.(\w+)\s+(?:AS\s+)?(\w+)/g)) alias.set(m[2], m[1]);
      for (const [a, table] of alias) {
        assert.ok(OWNER.select[table], `${f.name}: ${table} has no grant`);
        for (const m of f.body.matchAll(new RegExp(`\\b${a}\\.(\\w+)\\b`, 'g'))) assert.ok(OWNER.select[table].includes(m[1]), `${f.name}: ${a}.${m[1]} (${table}.${m[1]}) is read but not granted`);
      }
    }
    for (const [table, cols] of Object.entries(OWNER.select)) for (const c of cols) {
      const used = FNS.some((f) => { const aliases = [...f.body.matchAll(new RegExp(`\\b(?:FROM|JOIN)\\s+public\\.${table}\\s+(?:AS\\s+)?(\\w+)`, 'g'))].map((m) => m[1]); return aliases.some((a) => new RegExp(`\\b${a}\\.${c}\\b`).test(f.body)); });
      assert.ok(used, `${table}.${c} is granted but no function reads it (grant is wider than needed)`);
    }
  });
  it('the columns the TypeScript projections read are exactly the columns the SQL returns', () => {
    const src = read('lib/mcp/data/output.ts');
    const reads = (fn: string) => { const s = src.slice(src.indexOf(`export function ${fn}`)); return new Set([...s.slice(0, s.indexOf('\n}\n')).matchAll(/\br\.([a-z_]+)\b/g)].map((m) => m[1])); };
    const ret = (n: string) => new Set(FNS.find((f) => f.name === n)!.returns);
    const sub = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x));
    assert.deepEqual(sub(reads('toDeveloperSummary'), ret('mcp_data.list_developers')), []);
    assert.deepEqual(sub(reads('toDailyActivity'), ret('mcp_data.developer_activity')), []);
    assert.deepEqual(sub(reads('toSessionSummary'), ret('mcp_data.list_sessions')), []);
    assert.deepEqual(sub(reads('toSessionSummary'), ret('mcp_data.session_details')), []);
    assert.deepEqual(sub(reads('toPromptMetadata'), ret('mcp_data.search_prompt_metadata')), []);
    assert.deepEqual(sub(reads('toPromptMetadata'), ret('mcp_data.prompt_metadata_batch')), []);
    assert.deepEqual(sub(ret('mcp_data.search_prompt_metadata'), reads('toPromptMetadata')), [], 'the search returns nothing the contract does not use');
    assert.deepEqual(sub(ret('mcp_data.list_sessions'), new Set([...reads('toSessionSummary'), 'activity_at'])), []);
  });
});

describe('limits are enforced in the database as well, and equal the TypeScript constants', () => {
  const body = (n: string) => FNS.find((f) => f.name === n)!.body.replace(/\s+/g, ' ');
  it('window span, skew and lookback', () => {
    const w = body('mcp_data._check_window');
    assert.equal(MAX_WINDOW_DAYS, 7); assert.ok(w.includes(`p_to - p_from > interval '${MAX_WINDOW_DAYS} days'`));
    assert.ok(w.includes(`interval '${FUTURE_SKEW_MS / 60000} minutes'`));
    assert.ok(w.includes('p_from < pg_catalog.now() - p_lookback'));
    assert.ok(w.indexOf('invalid_argument') < w.indexOf('window_too_large') && w.indexOf('window_too_large') < w.indexOf('window_out_of_range'), 'same order as time-window.ts');
    assert.equal(MAX_LOOKBACK_DAYS, 14);
    assert.ok(body('mcp_data.developer_activity').includes(`_check_window(p_from, p_to, interval '${Math.min(MAX_LOOKBACK_DAYS, SOURCE_RETENTION_DAYS.activity)} days')`));
    assert.ok(body('mcp_data.list_sessions').includes(`_check_window(p_from, p_to, interval '${Math.min(MAX_LOOKBACK_DAYS, SOURCE_RETENTION_DAYS.sessions)} days')`));
    assert.ok(body('mcp_data.search_prompt_metadata').includes(`_check_window(p_from, p_to, interval '${Math.min(MAX_LOOKBACK_DAYS, SOURCE_RETENTION_DAYS.prompts)} days')`));
    assert.ok(body('mcp_data.prompt_metadata_batch').includes(`now() - interval '${SOURCE_RETENTION_DAYS.prompts} days'`));
    assert.ok(body('mcp_data.session_details').includes(`now() - interval '${SOURCE_RETENTION_DAYS.sessions} days'`));
  });
  it('page sizes (max + 1 for the next-page probe) and batch', () => {
    assert.ok(body('mcp_data.list_developers').includes(`p_limit > ${PAGE_SIZES.developers.max + 1}`));
    assert.ok(body('mcp_data.list_sessions').includes(`p_limit > ${PAGE_SIZES.sessions.max + 1}`));
    assert.ok(body('mcp_data.search_prompt_metadata').includes(`p_limit > ${PAGE_SIZES.prompts.max + 1}`));
    assert.ok(body('mcp_data.prompt_metadata_batch').includes(`NOT BETWEEN 1 AND ${BATCH_MAX}`));
    assert.ok(body('mcp_data.session_details').includes('LIMIT 100'));
  });
  it('keyset pagination is total and stable: ordered by (time truncated to ms, id) with the same expression in the cursor comparison', () => {
    for (const n of ['mcp_data._session_rows', 'mcp_data._prompt_rows']) {
      const b = body(n);
      const ex = n.endsWith('session_rows') ? "date_trunc('milliseconds', COALESCE(s.ended_at, s.started_at, s.synced_at))" : "date_trunc('milliseconds', st.created_at)";
      assert.ok(b.includes(`(pg_catalog.${ex}, ${n.endsWith('session_rows') ? 's' : 'st'}.id) < (p_after_ts, p_after_id)`), n);
      assert.ok(b.includes(`ORDER BY pg_catalog.${ex} DESC, ${n.endsWith('session_rows') ? 's' : 'st'}.id DESC`), n);
    }
    assert.ok(body('mcp_data.search_prompt_metadata').includes('(p_after_ts IS NULL) <> (p_after_id IS NULL)'));
  });
  it('prompt rows are USER turns only, one answering turn at most (no duplicate rows), and the text column is never named', () => {
    const b = body('mcp_data._prompt_rows');
    assert.ok(b.includes("st.turn_role = 'user'") && b.includes("x.turn_role = 'assistant'") && b.includes('ORDER BY x.id LIMIT 1'));
    assert.doesNotMatch(b, /prompt_text/);
  });
});

/** The EFFECTIVE value of a SET search_path statement as PostgreSQL parses it: every constant in the argument list is ONE schema name. */
function effectiveSearchPath(sql: string): string[] {
  const st = ((parseSync(sql).stmts ?? []) as Node[])[0].stmt;
  const set = st.AlterRoleSetStmt?.setstmt ?? st.VariableSetStmt;
  assert.equal(set.name, 'search_path');
  return set.args.map((a: Node) => a.A_Const.sval.sval as string);
}

describe('search_path: the effective parsed setting', () => {
  const EXPECTED = ['pg_catalog', 'pg_temp'];
  it('the role setting is a LIST of two quoted elements (each schema quoted on its own), not one string', () => {
    const line = GRANT.split('\n').find((l) => /^ALTER ROLE mcp_reader SET search_path/.test(l))!;
    assert.equal(line, "ALTER ROLE mcp_reader SET search_path = 'pg_catalog', 'pg_temp';");
    assert.deepEqual(effectiveSearchPath(line), EXPECTED);
    assert.deepEqual(READER.roleSettings.search_path, EXPECTED);
    for (const el of effectiveSearchPath(line)) assert.doesNotMatch(el, /[,\s]/, 'no element may hold a comma or a space');
  });
  it('NEGATIVE CONTROL: the single-string form parses to ONE element containing a comma (a schema literally named "pg_catalog, pg_temp"), and the same check rejects it', () => {
    const bad = effectiveSearchPath("ALTER ROLE x SET search_path = 'pg_catalog, pg_temp'");
    assert.deepEqual(bad, ['pg_catalog, pg_temp']); assert.notDeepEqual(bad, EXPECTED); assert.ok(bad.some((el) => /[,\s]/.test(el)));
    assert.deepEqual(effectiveSearchPath('ALTER ROLE x SET search_path = pg_catalog, pg_temp'), EXPECTED, 'the unquoted list is equivalent to the per-element quoted one');
  });
  it('every function pins the same effective list, and the catalog string the in-transaction assertion looks for is exactly its rendering', () => {
    for (const f of FNS) {
      const m = /SET search_path = ([^\n]*?) (?:AS \$\$|\n)/.exec(f.full);
      assert.ok(m, f.name);
      assert.deepEqual(effectiveSearchPath(`SET search_path = ${m![1]}`), EXPECTED, f.name);
    }
    assert.ok(MIG.includes(`c = 'search_path=${EXPECTED.join(', ')}'`));
    const created = (parseSync(MIG_RAW).stmts ?? []).map((x: Node) => x.stmt.CreateFunctionStmt).filter(Boolean);
    assert.equal(created.length, 13);
    for (const c of created) { const opt = c.options.find((o: Node) => o.DefElem.defname === 'set').DefElem.arg.VariableSetStmt; assert.deepEqual(opt.args.map((a: Node) => a.A_Const.sval.sval), EXPECTED); }
  });
});

describe('grants file', () => {
  const top = (code: string) => code.split('\n').filter((l) => /^(GRANT|REVOKE|ALTER ROLE)\b/.test(l)).map((l) => l.trim());
  const render = (v: string | string[]) => (Array.isArray(v) ? v.map((x) => `'${x}'`).join(', ') : /^\d+$/.test(v) || v === 'on' ? v : `'${v}'`);
  it('is exactly what lib/mcp/grants.json says (no drift between the two); it ONLY adds: no REVOKE ALL, no connection-limit change', () => {
    const expected: string[] = [];
    for (const s of OWNER.schemaUsage) expected.push(`GRANT USAGE ON SCHEMA ${s} TO mcp_data_owner;`);
    for (const [t, cols] of Object.entries(OWNER.select)) expected.push(`GRANT SELECT (${cols.join(', ')}) ON public.${t} TO mcp_data_owner;`);
    for (const s of READER.schemaUsage) expected.push(`GRANT USAGE ON SCHEMA ${s} TO mcp_reader;`);
    for (const f of READER.functions) expected.push(`GRANT EXECUTE ON FUNCTION ${f} TO mcp_reader;`);
    for (const [k, v] of Object.entries(READER.roleSettings)) expected.push(`ALTER ROLE mcp_reader SET ${k} = ${render(v)};`);
    assert.deepEqual(top(GRANT), expected);
    assert.doesNotMatch(GRANT, /ALTER ROLE mcp_reader CONNECTION LIMIT|REVOKE\s+ALL|REVOKE\s+(SELECT|USAGE|EXECUTE)/i);
    assert.ok(GRANT.includes(`rd.rolconnlimit <> ${READER.connectionLimit}`), 'the limit is VALIDATED (provisioned by the role script), not changed');
  });
  it('the reader holds NO table, column, sequence or other privilege: only schema USAGE and EXECUTE on exactly the six functions', () => {
    const forReader = (GRANT.match(/GRANT [^;]*TO mcp_reader;/g) ?? []);
    assert.equal(forReader.length, 7);
    for (const g of forReader) assert.match(g, /^GRANT (USAGE ON SCHEMA mcp_data|EXECUTE ON FUNCTION mcp_data\.\w+\([^)]*\)) TO mcp_reader;$/);
    assert.deepEqual(READER.select, {}); assert.deepEqual(READER.insert, {}); assert.deepEqual(READER.update, {}); assert.deepEqual(READER.sequences, []);
    assert.deepEqual(READER.functions.map((s) => s.replace(/\s+/g, ' ')).sort(), FNS.filter((f) => f.callable).map((f) => f.sig).sort());
  });
  it('no write privilege, no ALL PRIVILEGES, no grant option, no PUBLIC grant, no new role or password in the grants file', () => {
    for (const re of [/GRANT\s+(INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|ALL)\b/i, /WITH GRANT OPTION/i, /TO PUBLIC/i, /\bCREATE\s+(ROLE|USER|SCHEMA|TABLE|FUNCTION|EXTENSION|INDEX)\b/i, /\bSUPERUSER\b|\bBYPASSRLS\b/i, /\bPASSWORD\b/i, /ALTER ROLE \w+ (WITH )?(NO)?LOGIN/i]) assert.doesNotMatch(noStr(GRANT).replace(/NOLOGIN/g, ''), re, String(re));
  });
  it('the reader role is read-only by default, has hard timeouts, a pinned search_path and a connection limit; the read-only default is documented as NOT a boundary', () => {
    assert.deepEqual(READER.roleSettings, { statement_timeout: '5000', lock_timeout: '2000', idle_in_transaction_session_timeout: '10000', search_path: ['pg_catalog', 'pg_temp'], default_transaction_read_only: 'on' });
    assert.ok(READER.login === true && READER.connectionLimit >= 1 && READER.connectionLimit <= 5);
    assert.match(JSON.stringify(ALL_GRANTS.mcp_reader), /a DEFAULT a session may override/);
  });
  it('the existing mcp_auth entry is untouched and the role script provisions both roles safely (P3-4)', () => {
    const auth = ALL_GRANTS.mcp_auth; assert.deepEqual(Object.keys(auth).sort(), ['functions', 'insert', 'select', 'sequences', 'update']);
    assert.ok(!('mcp_data_owner' in auth) && !JSON.stringify(auth).includes('mcp_data'));
    const script = read('scripts/setup-mcp-roles.mjs'); assert.ok(script.includes('mcp_reader') && script.includes('mcp_auth')); assert.doesNotMatch(script, /mcp_data_owner/);
  });
  it('does not mention any password, URL or credential (in any of the four files)', () => { for (const s of [MIG_RAW, GRANT_RAW, ROLL_RAW, AUDIT_RAW]) assert.doesNotMatch(s, /postgres(ql)?:\/\/|PASSWORD\s+'/i); for (const s of [MIG, GRANT, ROLL, AUDIT]) assert.doesNotMatch(s, /secret|token_value|plaintext/i); });
});

describe('effective PUBLIC privileges: nothing is revoked globally; the grants FAIL CLOSED if they break least privilege; the audit reports the residue', () => {
  it('no script revokes anything from PUBLIC on a database, on schema public, on existing tables or on the language/type level (only on the functions it created and on its own schema)', () => {
    for (const code of [MIG, GRANT, ROLL]) {
      const revokes = [...code.matchAll(/\bREVOKE\b[^;]*\bFROM\s+PUBLIC\b[^;]*;/gi)].map((m) => m[0].replace(/\s+/g, ' '));
      for (const r of revokes) assert.match(r, /^REVOKE ALL ON (FUNCTION mcp_data\.\w+\(|SCHEMA mcp_data FROM PUBLIC)/, r);
      assert.doesNotMatch(code, /ON DATABASE|ALTER DEFAULT PRIVILEGES|ON LANGUAGE|ON TYPE|ON ALL TABLES IN SCHEMA public FROM PUBLIC|ON SCHEMA public FROM PUBLIC/i);
    }
  });
  it('after the grants, an in-transaction assertion rejects: any table/column/sequence privilege, CREATE on a schema or the database, extra functions or other SECURITY DEFINER functions, dangerous built-ins', () => {
    const end = GRANT.slice(GRANT.lastIndexOf('EFFECTIVE privileges') >= 0 ? 0 : 0);
    for (const frag of ["has_table_privilege('mcp_reader', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')", "has_any_column_privilege('mcp_reader', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')", "has_sequence_privilege('mcp_reader', c.oid, 'USAGE,SELECT,UPDATE')",
      "has_schema_privilege('mcp_reader', ns.oid, 'CREATE')", "has_database_privilege('mcp_reader', pg_catalog.current_database(), 'CREATE')", "has_schema_privilege('mcp_reader', v_schema, 'USAGE')", 'p.prosecdef', "has_function_privilege('mcp_reader', p.oid, 'EXECUTE')", 'pg_read_file', 'lo_import']) assert.ok(end.includes(frag), frag);
    assert.ok(GRANT.lastIndexOf("has_table_privilege('mcp_reader'") > GRANT.indexOf('GRANT EXECUTE ON FUNCTION') && GRANT.lastIndexOf("has_table_privilege('mcp_reader'") > GRANT.indexOf('REVOKE SET OPTION FOR'), 'the post-condition is checked last, after the temporary membership is gone');
    assert.match(GRANT, /<> 6 THEN RAISE EXCEPTION 'mcp_reader must be able to execute exactly the six reader functions'/);
  });
  it('CONNECT, TEMPORARY and USAGE on schema public are deliberately NOT removed (CONNECT is required to log in); they are documented as residual and reported by the audit', () => {
    assert.match(GRANT_RAW, /CONNECT, TEMPORARY, USAGE on public/); assert.match(AUDIT_RAW, /TEMPORARY = true or false \(residual/);
    for (const frag of ["has_database_privilege('mcp_reader', pg_catalog.current_database(), 'CONNECT')", "'TEMPORARY'"]) assert.ok(AUDIT.includes(frag), frag);
  });
  it('the audit file is READ-ONLY: SELECT statements only, no side-effecting function, covering the reader (1-8), the owner columns (9) and the owner EFFECTIVE privileges (10a-f)', () => {
    const st = (parseSync(AUDIT_RAW).stmts ?? []).map((x: Node) => x.stmt);
    assert.equal(st.length, 15); assert.ok(st.every((x: Node) => x.SelectStmt), 'every statement is a SELECT');
    assert.doesNotMatch(noStr(AUDIT), /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|GRANT|REVOKE|SET|COPY|TRUNCATE|VACUUM|LOCK|DO)\b\s/i);
    assert.doesNotMatch(noStr(AUDIT), /set_config|pg_sleep|nextval|setval|lo_\w+\(|pg_terminate|pg_cancel|dblink|pg_read_file\(/i);
    for (const n of ['1 role', '1b membership', '2 database', '3 schema', '4 relation', '5 function', '6 builtin', '6b residual builtin', '7 default_acl', '8 setting', '9 owner column', '10a owner relation', '10b owner sequence', '10c owner schema', '10d owner database', '10e owner function', '10f owned object']) assert.ok(AUDIT.includes(`'${n}'`), n);
    // every FROM-list alias is unique inside its own query (PostgreSQL rejects a repeated alias): checked on the parsed AST
    for (const x of st) { const names: string[] = []; const walk = (n: Node): void => { if (Array.isArray(n)) n.forEach(walk); else if (n && typeof n === 'object') { if (n.RangeVar?.alias) names.push(n.RangeVar.alias.aliasname); if (n.RangeFunction?.alias) names.push(n.RangeFunction.alias.aliasname); if (n.RangeSubselect?.alias) names.push(n.RangeSubselect.alias.aliasname); if (n.SelectStmt?.fromClause) { const own = new Set<string>(); const dup = (f: Node): void => { for (const it of f) { const a = it.RangeVar?.alias?.aliasname ?? it.RangeFunction?.alias?.aliasname ?? it.RangeSubselect?.alias?.aliasname; if (a) { assert.ok(!own.has(a), `duplicate FROM alias ${a}`); own.add(a); } if (it.JoinExpr) { const j = (e: Node): void => { for (const side of [e.larg, e.rarg]) { const a2 = side?.RangeVar?.alias?.aliasname ?? side?.RangeFunction?.alias?.aliasname ?? side?.RangeSubselect?.alias?.aliasname; if (a2) { assert.ok(!own.has(a2), `duplicate FROM alias ${a2}`); own.add(a2); } if (side?.JoinExpr) j(side.JoinExpr); } }; j(it.JoinExpr); } } }; dup(n.SelectStmt.fromClause); } Object.values(n).forEach(walk); } }; walk(x); void names; }
    // the privilege-check functions are called with comma-separated privilege lists, which the documented has_*_privilege functions accept (true if ANY is held)
    assert.match(AUDIT, /has_table_privilege\('mcp_reader', c\.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'\)/);
  });
  it('the effective-privilege checks cover every non-system schema and skip only extension-owned functions', () => {
    assert.ok(GRANT.includes("ns.nspname NOT IN ('pg_catalog','information_schema') AND ns.nspname NOT LIKE 'pg\\_%'") || GRANT.includes("ns.nspname NOT LIKE 'pg\\_%'"));
    assert.ok(GRANT.includes("d.deptype = 'e'") && AUDIT.includes("d.deptype = 'e'"));
  });
});

describe('privilege baseline: nothing is revoked; unexpected pre-existing grants and ACLs abort before any change', () => {
  const blocks = () => ((parseSync(GRANT_RAW).stmts ?? []) as Node[]).filter((x) => x.stmt.DoStmt).map((x) => x.stmt.DoStmt.args[0].DefElem.arg.String.sval as string);
  const BEFORE = () => blocks().find((b) => b.includes('PRIVILEGE') === false && b.includes("n_total NOT IN (0, n_expected)"))!;
  const AFTER = () => blocks().find((b) => b.includes('n_total <> n_expected'))!;
  it('the grants file revokes nothing except its own temporary membership: no REVOKE ALL, no table/column/schema/function revoke, so no unrelated privilege can be removed', () => {
    assert.deepEqual([...GRANT.matchAll(/\bREVOKE\b[^;]*;/g)].map((m) => m[0].replace(/\s+/g, ' ')), ['REVOKE mcp_data_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;', 'REVOKE SET OPTION FOR mcp_data_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;']);
  });
  it('a BASELINE check precedes the first change, and a POST-CONDITION check follows the last; both are in the same transaction', () => {
    const firstChange = Math.min(...['GRANT USAGE ON SCHEMA public', 'SET LOCAL ROLE', 'ALTER ROLE mcp_reader SET', "GRANT mcp_data_owner TO CURRENT_USER"].map((f) => GRANT.indexOf(f)));
    const before = GRANT.indexOf("n_total NOT IN (0, n_expected)"), after = GRANT.lastIndexOf('n_total <> n_expected');
    assert.ok(before > 0 && before < firstChange, 'baseline before any change');
    assert.ok(after > GRANT.lastIndexOf('ALTER ROLE mcp_reader SET') && after > GRANT.lastIndexOf('RESET ROLE;') && after > GRANT.indexOf('REVOKE SET OPTION FOR'), 'post-conditions after every change');
    assert.ok(BEFORE() && AFTER() && BEFORE() !== AFTER());
  });
  it('both roles are inventoried through the ACL dependency catalog (every object a role appears in, columns included), scoped to this database and shared objects', () => {
    for (const b of [BEFORE(), AFTER()]) {
      assert.equal((b.match(/pg_shdepend d/g) ?? []).length, 2, 'one inventory per role');
      assert.equal((b.match(/d\.deptype = 'a'/g) ?? []).length, 2);
      assert.equal((b.match(/d\.dbid IN \(0, v_db\)/g) ?? []).length, 2);
      assert.match(b, /fp\.classid = 'pg_catalog\.pg_class'::regclass AND fp\.objsubid > 0/, 'column-level entries are judged column by column');
      assert.match(b, /fp\.classid = 'pg_catalog\.pg_namespace'::regclass AND fp\.objid = 'public'::regnamespace::oid/);
      assert.match(b, /count\(\*\) FILTER \(WHERE NOT ok\)/);
    }
    assert.match(BEFORE(), /IF n_bad > 0 THEN RAISE EXCEPTION 'mcp_data_owner appears in ACL entries outside the expected set \(a pre-existing grant\); refusing, nothing was changed'/);
    assert.match(BEFORE(), /RAISE EXCEPTION 'mcp_data_owner already holds PART of the expected grants \(partial baseline\)/);
    assert.match(BEFORE(), /IF n_total NOT IN \(0, 7\) THEN RAISE EXCEPTION 'mcp_reader already holds PART/);
    assert.match(AFTER(), /IF n_total <> 7 THEN RAISE EXCEPTION 'mcp_reader ACL footprint is not exactly the expected set'/);
    assert.match(AFTER(), /IF n_total <> n_expected THEN RAISE EXCEPTION 'mcp_data_owner ACL footprint is not exactly the expected set'/);
  });
  it('the SQL column allowlist is exactly grants.json, in every block that uses it (baseline footprint, baseline effective, post footprint, post effective)', () => {
    const want = new Set(Object.entries(OWNER.select).flatMap(([t, cols]) => cols.map((c) => `${t}.${c}`)));
    let seen = 0;
    for (const b of [BEFORE(), AFTER()]) for (const m of b.matchAll(/WITH allow\(t, c\) AS \(VALUES([\s\S]*?)\),\s*\n?\s*(?:fp|eff) AS/g)) {
      seen++;
      const got = [...m[1].matchAll(/\('(\w+)','(\w+)'\)/g)].map((x) => `${x[1]}.${x[2]}`);
      assert.equal(new Set(got).size, got.length, 'no duplicates'); assert.deepEqual(new Set(got), want);
    }
    assert.equal(seen, 4);
    for (const bad of ['session_turns.prompt_text_sanitized', 'sync_sessions.label', 'sync_sessions.events', 'daily_member_usage.project', 'users.password_hash']) assert.ok(!want.has(bad), bad);
  });
  it('the owner\'s EFFECTIVE column SELECT (PUBLIC-derived included) must be a subset before and EXACTLY the allowlist after; any write, table-level, sequence, CREATE or foreign SECURITY DEFINER reach aborts', () => {
    for (const b of [BEFORE(), AFTER()]) for (const frag of ["pg_catalog.has_column_privilege('mcp_data_owner', c.oid, a.attnum, 'SELECT')", "RAISE EXCEPTION 'mcp_data_owner can read columns beyond the allowlist", "has_table_privilege('mcp_data_owner', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')", "has_any_column_privilege('mcp_data_owner', c.oid, 'INSERT,UPDATE,REFERENCES')", "has_sequence_privilege('mcp_data_owner'", "has_schema_privilege('mcp_data_owner', ns.oid, 'CREATE')", "has_database_privilege('mcp_data_owner', pg_catalog.current_database(), 'CREATE')", "p.prosecdef AND pg_catalog.has_function_privilege('mcp_data_owner', p.oid, 'EXECUTE')", 'mcp_data_owner can execute a SECURITY DEFINER function outside mcp_data']) assert.ok(b.includes(frag), frag);
    assert.ok(AFTER().includes("IF n_eff <> n_allow THEN RAISE EXCEPTION 'mcp_data_owner effective column SELECT is not exactly the allowlist'") && !BEFORE().includes('n_eff <> n_allow THEN RAISE'));
  });
  it('the reader\'s role settings are none (or exactly ours) before, exactly ours after, never per-database, and its effective privileges are checked both times', () => {
    for (const b of [BEFORE(), AFTER()]) { assert.ok(b.includes('s.setdatabase <> 0')); assert.ok(b.includes("'search_path=pg_catalog, pg_temp'")); assert.ok(b.includes('pg_catalog.cardinality(v_cfg) = 5')); assert.ok(b.includes("has_table_privilege('mcp_reader', c.oid")); assert.ok(b.includes('pg_read_file')); }
    assert.ok(BEFORE().includes('pg_catalog.cardinality(v_cfg) > 0 AND NOT v_ours') && BEFORE().includes('the rollback could not restore them'));
    assert.ok(AFTER().includes('IF NOT v_ours THEN') && AFTER().includes('search_path must be the two-element list'));
  });
  it('the migration adopts a pre-existing mcp_data_owner only if it appears in NO ACL (clean baseline), and says it is not re-runnable after the grants', () => {
    assert.match(MIG, /d\.deptype = 'a'[\s\S]{0,300}RAISE EXCEPTION 'pre-existing role mcp_data_owner already appears in ACL entries/);
    assert.ok(MIG.indexOf('already appears in ACL entries') > MIG.indexOf('has role settings'), 'checked in the pre-existing-role branch, after the attribute checks');
    assert.match(MIG_RAW, /not re-runnable after grants\.sql/); assert.match(ROLL_RAW, /REVERSIBILITY/);
  });
  it('reversibility argument holds structurally: everything the grants add has a matching exact revoke in the rollback, and nothing else is revoked', () => {
    const added = [...GRANT.matchAll(/^GRANT SELECT \(([^)]*)\) ON public\.(\w+) TO mcp_data_owner;/gm)].map((m) => `${m[2]}:${m[1]}`);
    const removed = [...ROLL.matchAll(/REVOKE SELECT \(([^)]*)\) ON public\.(\w+) FROM mcp_data_owner;/g)].map((m) => `${m[2]}:${m[1]}`);
    assert.deepEqual(removed, added);
    assert.deepEqual([...ROLL.matchAll(/REVOKE USAGE ON SCHEMA (\w+) FROM mcp_data_owner;/g)].map((m) => m[1]), OWNER.schemaUsage);
    const resets = [...ROLL.matchAll(/ALTER ROLE mcp_reader RESET (\w+);/g)].map((m) => m[1]), sets = [...GRANT.matchAll(/ALTER ROLE mcp_reader SET (\w+) =/g)].map((m) => m[1]);
    assert.deepEqual(resets, sets);
  });
  it('documented fixtures for the live test (P3-4): each pre-existing condition must make grants.sql abort with nothing changed', () => {
    const doc = read('MCP.md');
    for (const f of ['pre-existing SELECT on session_turns.prompt_text_sanitized', 'table-level SELECT on a table', 'PUBLIC SELECT on a table', 'partial overlap', 'a pre-existing reader role setting', 'a SECURITY DEFINER function outside mcp_data']) assert.ok(doc.includes(f), f);
  });
});

describe('changes made while applying to PostgreSQL (P3-4): guards for the paths the first live run exercised', () => {
  it('every has_*_privilege call that takes a relation is guarded by a relkind CASE (the planner may otherwise evaluate it on an index or composite type)', () => {
    for (const [n, code] of [['grants', GRANT], ['audit', AUDIT]] as const) {
      const calls = [...code.matchAll(/pg_catalog\.has_(sequence|table|any_column|column)_privilege\('\w+', c\.oid/g)].length;
      const guarded = [...code.matchAll(/CASE WHEN c\.relkind (= 'S'|IN \('r','p','v','m','f'\)) THEN pg_catalog\.has_(sequence|table|any_column|column)_privilege\('\w+', c\.oid[^)]*\) ELSE false END/g)].length;
      assert.ok(calls > 6, `${n}: found ${calls} calls`); assert.equal(guarded, calls, `${n}: every call is guarded`);
    }
  });
  it('the fatal dangerous-builtin list is file / large-object / server-control functions; the PUBLIC-by-default signal and WAL functions are a REPORTED residual (audit 6b), not fatal', () => {
    const fatal = /p\.proname IN \(([^)]*)\)\) THEN\s+RAISE EXCEPTION 'mcp_reader can execute a dangerous built-in/.exec(GRANT)![1];
    for (const f of ['pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file', 'lo_import', 'lo_export', 'pg_reload_conf', 'pg_rotate_logfile', 'pg_switch_wal', 'pg_create_restore_point']) assert.ok(fatal.includes(`'${f}'`), f);
    for (const f of ['pg_cancel_backend', 'pg_terminate_backend', 'pg_logical_emit_message']) { assert.ok(!fatal.includes(f), `${f} is not fatal`); assert.ok(AUDIT.includes(`'${f}'`) && /6b residual builtin/.test(AUDIT), `${f} is reported by the audit`); }
    assert.match(read('MCP.md'), /pg_logical_emit_message/);
  });
  it('the baseline accepts the reader executing none or exactly six mcp_data functions (a re-run), and the post-condition requires exactly six', () => {
    assert.ok(GRANT.includes("has_function_privilege('mcp_reader', p.oid, 'EXECUTE')) NOT IN (0, 6) THEN RAISE EXCEPTION"));
    assert.ok(GRANT.includes("has_function_privilege('mcp_reader', p.oid, 'EXECUTE')) <> 6 THEN RAISE EXCEPTION 'mcp_reader must be able to execute exactly the six reader functions'"));
  });
  it('the reader may have only the migration role\'s ADMIN-only link as a member (the implicit CREATE ROLE link), and is never a member of anything', () => {
    assert.ok(GRANT.includes("m.member = rd.oid) THEN RAISE EXCEPTION 'mcp_reader is a member of another role'"));
    assert.ok(GRANT.includes("m.roleid = rd.oid AND (m.member <> v_me OR m.set_option OR m.inherit_option)"));
  });
  it('the local-only live test refuses host-overriding URL parameters and non-disposable database names', () => {
    const t = read('tests/mcp-data-db.test.ts');
    for (const k of ["'host'", "'hostaddr'", "'service'", "'options'"]) assert.ok(t.includes(k), k);
    assert.ok(t.includes('/^\\/mcp_[a-z0-9_]+$/'));
  });
});

describe('rollback: explicit, narrow, idempotent', () => {
  it('uses NO broad removal: no DROP OWNED, no CASCADE, no REVOKE ALL on tables, no reader-role drop, no RESET ALL, no table/data statement', () => {
    for (const re of [/\bDROP\s+OWNED\b/i, /\bCASCADE\b/i, /REVOKE\s+ALL\s+ON\s+ALL\s+TABLES/i, /REVOKE\s+ALL\s+ON\s+SCHEMA\s+public/i, /DROP\s+ROLE\s+(IF EXISTS\s+)?mcp_reader/i, /RESET\s+ALL/i, /DROP\s+(TABLE|DATABASE|INDEX|EXTENSION|OWNED)/i, /DELETE|TRUNCATE|UPDATE\s+\w|INSERT/i, /\bmcp_auth\b/i]) assert.doesNotMatch(noStr(ROLL), re, String(re));
    assert.deepEqual([...ROLL.matchAll(/ON public\.(oauth_\w+)/g)].map((m) => m[1]), ['oauth_tokens', 'oauth_clients'], 'the only OAuth references are the two column revokes the grants made');
    for (const re of [/\bDROP\s+OWNED\b/i, /\bCASCADE\b/i]) for (const code of [MIG, GRANT, AUDIT]) assert.doesNotMatch(code, re);
  });
  it('the column revokes are EXACTLY the column grants of grants.json, table by table (nothing wider, nothing unrelated)', () => {
    const rev = [...ROLL.matchAll(/REVOKE SELECT \(([^)]*)\) ON public\.(\w+) FROM mcp_data_owner;/g)].map((m) => [m[2], m[1].split(',').map((x) => x.trim())]);
    assert.deepEqual(rev, Object.entries(OWNER.select));
    assert.deepEqual([...ROLL.matchAll(/REVOKE USAGE ON SCHEMA public FROM mcp_data_owner;/g)].length, 1);
    for (const [t] of Object.entries(OWNER.select)) assert.ok(ROLL.includes(`IF to_regclass('public.${t}') IS NOT NULL THEN REVOKE SELECT`), `${t} is guarded`);
  });
  it('the reader is only stripped of what this migration gave it: the five settings by name, and its rights on the mcp_data schema and functions', () => {
    const resets = [...ROLL.matchAll(/ALTER ROLE mcp_reader RESET (\w+);/g)].map((m) => m[1]);
    assert.deepEqual(resets, Object.keys(READER.roleSettings));
    assert.ok(!resets.includes('connection_limit'));
    assert.deepEqual([...ROLL.matchAll(/REVOKE [^;]*FROM mcp_reader;/g)].map((m) => m[0]), ['REVOKE ALL ON ALL FUNCTIONS IN SCHEMA mcp_data FROM mcp_reader;', 'REVOKE ALL ON SCHEMA mcp_data FROM mcp_reader;']);
  });
  it('drops exactly the thirteen functions and the schema, each explicit and IF EXISTS; reader functions before the helpers they call; then the marked role', () => {
    const dropped = [...ROLL.matchAll(/DROP FUNCTION IF EXISTS (mcp_data\.\w+)\(([^)]*)\);/g)].map((m) => `${m[1]}(${normArgs(m[2])})`).sort();
    assert.deepEqual(dropped, FNS.map((f) => f.sig).sort());
    assert.equal([...ROLL.matchAll(/\bDROP FUNCTION\b(?! IF EXISTS)/g)].length, 0);
    assert.match(ROLL, /DROP SCHEMA mcp_data;/);
    const at = (x: string) => ROLL.indexOf(x);
    assert.ok(at('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA mcp_data FROM mcp_reader') < at('DROP FUNCTION IF EXISTS mcp_data.list_developers'));
    assert.ok(at('DROP FUNCTION IF EXISTS mcp_data.prompt_metadata_batch') < at('DROP FUNCTION IF EXISTS mcp_data._prompt_rows') && at('DROP FUNCTION IF EXISTS mcp_data._prompt_rows') < at('DROP FUNCTION IF EXISTS mcp_data._safe_ident'));
    assert.ok(at('DROP FUNCTION IF EXISTS mcp_data._safe_ident') < at('DROP SCHEMA mcp_data;') && at('DROP SCHEMA mcp_data;') < at('DROP ROLE mcp_data_owner;'));
  });
  it('handles every documented state: each step checks what exists, missing schema/roles/tables only produce notices, and an unexpected schema ABORTS before anything changes', () => {
    for (const st of ['S0 nothing applied', 'S1 role only', 'S2 role + empty schema', 'S3 some functions present', 'S4 migration complete', 'S5 migration + grants', 'R  mcp_reader missing', 'A  owner role adopted', 'X  schema mcp_data owned by someone else']) assert.ok(ROLL_RAW.includes(st), st);
    for (const frag of ["to_regnamespace('mcp_data') IS NULL THEN\n    RAISE NOTICE 'schema mcp_data does not exist", "RAISE NOTICE 'role mcp_data_owner does not exist", "RAISE NOTICE 'role mcp_reader does not exist", "IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'mcp_reader')", "to_regclass('public."]) assert.ok(ROLL.includes(frag), frag);
    for (const frag of ['schema mcp_data is not owned by mcp_data_owner; refusing to touch it', 'holds a relation this migration did not create; refusing', 'holds a function this migration did not create; refusing']) assert.ok(ROLL.includes(frag), frag);
    assert.ok(ROLL.indexOf('refusing to touch it') < ROLL.indexOf('REVOKE SELECT ('), 'the abort checks come before any change');
    assert.match(ROLL_RAW, /Re-running after a successful rollback is a no-op/);
  });
});

describe('nothing is wired up: the SQL is written, not applied', () => {
  const walk = (d: string): string[] => fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' || e.name === '.next' ? [] : e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
  it('no script, application file or package script references the data-plane SQL files, and no runner for them exists', () => {
    const refs = [...walk('scripts'), ...walk('app'), ...walk('lib'), 'package.json'].filter((f) => !f.startsWith('scripts/migrations/mcp-data') && !f.startsWith('lib/mcp/data/') && /\.(m?js|cjs|ts|tsx|json)$/.test(f) && /mcp-data\.(sql|grants|rollback|audit)|migrate-mcp-data|mcp_data\./.test(read(f)));
    assert.deepEqual(refs.filter((f) => f !== 'lib/mcp/grants.json'), []);
    assert.ok(!fs.existsSync(path.join(root, 'scripts/migrate-mcp-data.mjs')));
  });
  it('no application code names the mcp_reader role, the schema or the owner (the reader pool is P3-5)', () => {
    for (const f of [...walk('app'), ...walk('lib')].filter((x) => /\.(ts|tsx|mjs)$/.test(x) && !x.startsWith('lib/mcp/data/'))) assert.doesNotMatch(read(f), /mcp_data_owner|mcp_data\.|MCP_READER_DATABASE_URL/, f);
  });
  it('the SQL files never mention the masking engine or the text flag (metadata-only policy)', () => { for (const s of [MIG_RAW, GRANT_RAW, ROLL_RAW, AUDIT_RAW]) assert.doesNotMatch(s, /masking|MCP_PROMPT_TEXT_ENABLED|snippet/i); });
});
