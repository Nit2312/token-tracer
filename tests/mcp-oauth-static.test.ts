/**
 * Static (no database) guarantees for the Phase 2 migration, rollback, grants and the two operator scripts.
 * These cannot prove runtime behaviour (triggers, the audit function and grants are exercised live on a Neon test branch in Phase 2 step 4),
 * but they pin the structural properties a security review relies on, so a later edit cannot quietly weaken them.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadModule, parseSync, parsePlPgSQLSync } from 'libpg-query';

const root = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const SQL = read('scripts/migrations/mcp-oauth.sql');
const ROLLBACK = read('scripts/migrations/mcp-oauth.rollback.sql');
const GRANTS = JSON.parse(read('lib/mcp/grants.json')).mcp_auth as Record<string, Record<string, string[]> & string[]>;
const ROLES = read('scripts/setup-mcp-roles.mjs');
const MIGRATE = read('scripts/migrate-mcp-oauth.mjs');

const NEW_TABLES = ['oauth_clients', 'oauth_authorization_codes', 'oauth_tokens', 'mcp_rate_limits', 'mcp_access_log', 'mcp_all_teams_admins'];
const NEW_FUNCTIONS = ['mcp_guard_oauth_tokens', 'mcp_guard_oauth_codes', 'mcp_guard_oauth_clients', 'mcp_audit_event', 'mcp_oauth_purge'];
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parser AST nodes are inspected structurally
type Node = any;
let stmts: Node[] = [];
before(async () => { await loadModule(); stmts = (parseSync(SQL).stmts ?? []).map((s: Node) => s.stmt); });

describe('migration SQL', () => {
  it('parses, and parses its plpgsql bodies', () => {
    assert.ok(stmts.length > 20);
    for (const f of stmts.filter((s) => s.CreateFunctionStmt)) assert.ok((parsePlPgSQLSync(reconstruct(f)) as Node).plpgsql_funcs.length === 1);
    assert.ok((parseSync(ROLLBACK).stmts ?? []).length === 11);
  });
  it('creates exactly the six new tables, all IF NOT EXISTS, and only creates/alters nothing existing', () => {
    const created = stmts.filter((s) => s.CreateStmt);
    assert.deepEqual(created.map((s) => s.CreateStmt.relation.relname).sort(), [...NEW_TABLES].sort());
    assert.ok(created.every((s) => s.CreateStmt.if_not_exists === true));
    assert.equal(stmts.filter((s) => s.AlterTableStmt).length, 0, 'no ALTER of existing tables');
    assert.ok(stmts.filter((s) => s.IndexStmt).every((s) => s.IndexStmt.if_not_exists === true && NEW_TABLES.includes(s.IndexStmt.relation.relname)));
  });
  it('creates exactly the five new functions, and no other', () => {
    assert.deepEqual(stmts.filter((s) => s.CreateFunctionStmt).map((s) => s.CreateFunctionStmt.funcname.at(-1).String.sval).sort(), [...NEW_FUNCTIONS].sort());
  });
  it('foreign keys point only at users/oauth_clients with ON DELETE CASCADE', () => {
    const fks = [...SQL.matchAll(/REFERENCES (\w+)\(\w+\) ON DELETE (\w+(?: \w+)?)/g)].map((m) => `${m[1]}:${m[2]}`);
    assert.ok(fks.length === 5 && fks.every((f) => ['users:CASCADE', 'oauth_clients:CASCADE'].includes(f)), fks.join());
  });
  it('stores only digests and constrains scope, grants, auth method and S256 challenge length in the database', () => {
    assert.match(SQL, /code_hash\s+BYTEA PRIMARY KEY CHECK \(octet_length\(code_hash\) = 32\)/);
    assert.match(SQL, /token_hash\s+BYTEA NOT NULL UNIQUE CHECK \(octet_length\(token_hash\) = 32\)/);
    assert.equal([...SQL.matchAll(/CHECK \(scope = 'mcp:read'\)/g)].length, 3);
    assert.match(SQL, /token_endpoint_auth_method = 'none'/);
    assert.match(SQL, /char_length\(code_challenge\) = 43/);
    assert.match(SQL, /grant_types <@ ARRAY\['authorization_code','refresh_token'\]/);
    assert.ok(!/plaintext|client_secret/i.test(SQL.replace(/--.*$/gm, '')), 'no secret columns');
  });
  it('indexes every foreign-key column used by cascades', () => {
    for (const idx of ['idx_oauth_codes_client', 'idx_oauth_codes_user', 'idx_oauth_tokens_user', 'idx_oauth_tokens_client']) assert.ok(SQL.includes(idx), idx);
    assert.ok(!/ON oauth_tokens \(user_id\) WHERE/.test(SQL), 'the user index must not be partial (cascade deletes cannot use it)');
  });
  it('fails loudly on a pre-existing table with the wrong shape and on missing prerequisites', () => {
    assert.match(SQL, /prerequisite table public\.users is missing/);
    assert.match(SQL, /prerequisite table public\.audit_log is missing/);
    assert.match(SQL, /unexpected shape \(missing columns/);
    for (const t of NEW_TABLES) assert.ok(SQL.includes(`('${t}',`), `shape check covers ${t}`);
  });
  it('makes revocation, consumption and rotation one-way via triggers on all three mutable OAuth tables', () => {
    assert.equal([...SQL.matchAll(/CREATE TRIGGER trg_mcp_guard_\w+ BEFORE UPDATE ON (\w+) FOR EACH ROW/g)].length, 3);
    assert.match(SQL, /revocation is permanent/); assert.match(SQL, /cannot be re-armed/); assert.match(SQL, /identity columns are immutable/);
  });
  it('audit function is SECURITY DEFINER with a pinned search_path, a fixed allowlist, a fixed prefix and a looked-up actor', () => {
    const body = SQL.slice(SQL.indexOf('CREATE OR REPLACE FUNCTION mcp_audit_event'), SQL.indexOf('CREATE OR REPLACE FUNCTION mcp_oauth_purge'));
    assert.match(body, /SECURITY DEFINER SET search_path = pg_catalog, public/);
    assert.match(body, /'mcp\.' \|\| p_event/);
    assert.match(body, /SELECT u\.username INTO v_username FROM public\.users/);
    assert.match(body, /octet_length\(p_meta::text\) > 2048/);
    assert.match(body, /p_target_id !~ '\^\[A-Za-z0-9_\.:-\]\+\$'/);
    const events = [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    for (const e of ['client_registered', 'authorization_granted', 'code_replayed', 'refresh_reuse_detected', 'token_revoked']) assert.ok(events.includes(e), e);
    assert.ok(!body.includes("'login'") && !body.includes("'password"), 'no general-purpose events');
    // it is the ONLY SECURITY DEFINER function in the file
    assert.equal(SQL.replace(/--.*$/gm, '').match(/SECURITY DEFINER/g)?.length, 1);
  });
  it('every plpgsql function pins search_path, and every created function is revoked from PUBLIC', () => {
    const code = SQL.replace(/--.*$/gm, '');
    assert.equal([...code.matchAll(/LANGUAGE plpgsql/g)].length, 5);
    assert.equal([...code.matchAll(/SET search_path = pg_catalog, public/g)].length, 5);
    for (const f of NEW_FUNCTIONS) assert.match(code, new RegExp(`REVOKE ALL ON FUNCTION ${f}\\(`), f);
  });
});

/** Re-emit a CREATE FUNCTION from the source text for the plpgsql syntax check. */
function reconstruct(fn: Node): string {
  const name: string = fn.CreateFunctionStmt.funcname.at(-1).String.sval;
  const start = SQL.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  const end = SQL.indexOf('END $$;', start) + 'END $$;'.length;
  return SQL.slice(start, end);
}

describe('rollback SQL', () => {
  const code = ROLLBACK.replace(/--.*$/gm, '');
  it('drops exactly the new tables and functions with IF EXISTS, never CASCADE', () => {
    const tables = [...code.matchAll(/DROP TABLE IF EXISTS (\w+);/g)].map((m) => m[1]);
    const fns = [...code.matchAll(/DROP FUNCTION IF EXISTS (\w+)\(/g)].map((m) => m[1]);
    assert.deepEqual(tables.sort(), [...NEW_TABLES].sort());
    assert.deepEqual(fns.sort(), [...NEW_FUNCTIONS].sort());
    assert.ok(!/CASCADE/i.test(code));
    assert.equal(code.split(';').filter((s) => s.trim()).length, 11, 'nothing but the eleven drops');
    assert.ok(code.indexOf('DROP TABLE IF EXISTS oauth_clients') < code.indexOf('DROP FUNCTION'), 'tables (and their triggers) go before the functions');
  });
});

describe('grants.json (mcp_auth)', () => {
  const all = (p: string) => Object.entries(GRANTS[p] as unknown as Record<string, string[]>);
  it('grants nothing on audit_log, sessions, prompts, events, keys, MFA, embeddings, members or team_members', () => {
    const forbidden = ['audit_log', 'session_turns', 'sync_sessions', 'sync_session_tools', 'sync_session_files', 'member_keys', 'auth_totp', 'auth_throttle', 'prompt_embeddings', 'events', 'members', 'team_members', 'session_outcomes', 'redundant_reprompt_events'];
    for (const p of ['select', 'insert', 'update']) for (const [t] of all(p)) assert.ok(!forbidden.includes(t), `${p} ${t}`);
  });
  it('users: only id, display_name, role, team_id, active are readable; never writable', () => {
    assert.deepEqual([...(GRANTS.select as Record<string, string[]>).users].sort(), ['active', 'display_name', 'id', 'role', 'team_id']);
    for (const p of ['insert', 'update']) assert.ok(!(p in GRANTS) || !(GRANTS[p] as Record<string, string[]>).users);
    const cols = JSON.stringify(GRANTS.select);
    for (const c of ['password_hash', 'api_key', 'username', 'member_id', 'locked_until', 'failed_login_attempts']) assert.ok(!cols.includes(`"${c}"`), c);
  });
  it('mcp_auth cannot clear revocation state or re-enable a client', () => {
    assert.deepEqual((GRANTS.update as Record<string, string[]>).oauth_clients, ['last_used_at']);
    assert.ok(!(GRANTS.update as Record<string, string[]>).oauth_clients.includes('disabled_at'));
    assert.deepEqual((GRANTS.update as Record<string, string[]>).oauth_authorization_codes, ['consumed_at']);
  });
  it('the only function it may run is the allowlisting audit function; the only sequence is the access-log id', () => {
    assert.deepEqual(GRANTS.functions, ['mcp_audit_event(text, uuid, text, text, jsonb)']);
    assert.deepEqual(GRANTS.sequences, ['mcp_access_log_id_seq']);
  });
  it('every granted column of a new table exists in the migration', () => {
    for (const p of ['select', 'insert', 'update']) for (const [t, cols] of all(p)) if (NEW_TABLES.includes(t)) for (const c of cols) assert.ok(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\([\\s\\S]*?\\b${c}\\b`).test(SQL), `${t}.${c}`);
  });
});

describe('operator scripts', () => {
  for (const [name, src] of [['setup-mcp-roles.mjs', ROLES], ['migrate-mcp-oauth.mjs', MIGRATE]] as const) {
    it(`${name}: verifies TLS, never reads env files, never prints the connection string`, () => {
      assert.ok(!/rejectUnauthorized:\s*false/.test(src));
      assert.match(src, /rejectUnauthorized: true/);
      assert.ok(!/loadEnv|dotenv/.test(src), 'no env-file loader');
      const envFile = new RegExp('\\.' + 'env'); // built in pieces, like tests/test-db-safety.test.ts, so this file contains no env-file literal itself
      for (const line of src.split('\n').filter((l) => l.includes('readFileSync'))) assert.ok(!envFile.test(line), `env file read: ${line.trim()}`);
      // nothing that holds a connection string or the password is ever passed to console.*: look at each call's ARGUMENT EXPRESSIONS only
      // (string literals removed, interpolations kept), so message text such as "DATABASE_URL is not set" is not a false positive.
      for (const m of src.matchAll(/console\.(?:log|error|warn)\(((?:[^;]|\n)*?)\);/g)) {
        const exprs = [...m[1].matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1]).join(' ') + ' ' + m[1].replace(/'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"/g, ' ');
        assert.ok(!/\b(raw|password|connectionString)\b|process\.env\.(DATABASE_URL|MCP_AUTH_DATABASE_URL|MCP_AUTH_PASSWORD|NEON_CONNECTION_STRING)/.test(exprs), `leaky log: ${m[0].slice(0, 90)}`);
      }
      assert.match(src, /EXPECTED_ENDPOINT/);
    });
  }
  it('migration runner requires EXPECTED_ENDPOINT in every mode and a second confirmation before destroying data', () => {
    assert.match(MIGRATE, /EXPECTED_ENDPOINT is required in every mode/);
    assert.match(MIGRATE, /CONFIRM_MCP_ROLLBACK_DATA_LOSS/);
    assert.match(MIGRATE, /Rows that the rollback will DESTROY/);
    assert.match(MIGRATE, /statement_timeout/);
  });
  it('role script: plan mode is the default and connects to nothing; apply/drop need confirmation + endpoint; verify covers all schemas', () => {
    assert.match(ROLES, /: 'plan'/);
    assert.match(ROLES, /CONFIRM_MCP_ROLES/);
    assert.match(ROLES, /SYSTEM_SCHEMAS_SQL/);
    assert.match(ROLES, /BEGIN READ ONLY/); // SELECT probes only
    assert.match(ROLES, /direct INSERT audit_log/);
    assert.match(ROLES, /'42501'/);
    assert.ok(!/25006/.test(ROLES), 'read-only-transaction errors may not count as a privilege denial');
  });
});
