import 'server-only';
/**
 * Guardrails for LLM-written SQL. Defense in depth:
 *  1. AST allowlist (sql-ast.ts) — the real PostgreSQL parser (WASM) parses the SQL once; only a single
 *     read-only SELECT built from allowlisted nodes, operators, functions, types, tables and columns passes.
 *     Then the legacy keyword/catalog/secret regexes run as a redundant second filter.
 *  2. Table allowlist — verified from the real query plan (EXPLAIN), not by regex.
 *  3. Execution inside a READ ONLY transaction on a dedicated pool, logged in as `analyst_login` (which inherits
 *     the restricted `analyst_ro` role's grants and cannot SET ROLE), whose column-level
 *     grants make credentials, prompt text, event payloads and session labels unreadable no matter how
 *     the SQL is written (even `SELECT *`, whole-row references or to_jsonb(row) fail). Plus a statement
 *     timeout and a hard row cap.
 */
import { ensureSchema } from '@/lib/team/db';
import { ANALYST_LOGIN_ROLE, getAnalystPool } from './analyst-pool';
import grantsJson from './analyst-grants.json';
import { initSqlParser, SqlGuardError, validateSqlAst } from './sql-ast';

export { SqlGuardError };

/** Column-level grants for the analyst_ro role. The database enforces these — the checks below are a second layer. */
export const ANALYST_GRANTS = grantsJson.tables as Record<string, string[]>;
export const ALLOWED_TABLES = Object.keys(ANALYST_GRANTS);

const ALLOWED_SET = new Set<string>(ALLOWED_TABLES);

const FORBIDDEN_WORDS = [
  'insert', 'update', 'delete', 'drop', 'alter', 'create', 'truncate', 'grant', 'revoke',
  'copy', 'call', 'do', 'execute', 'vacuum', 'analyze', 'set', 'reset', 'lock', 'listen',
  'notify', 'refresh', 'comment', 'into', 'declare', 'fetch', 'prepare', 'begin', 'commit',
  'rollback', 'savepoint', 'security', 'cluster', 'reindex', 'load',
];
const FORBIDDEN_RE = new RegExp(`\\b(${FORBIDDEN_WORDS.join('|')})\\b`, 'i');
// Credential / secret material that must never be reachable even through an allowed table.
const SECRET_RE = /\b(users|member_keys|prompt_embeddings|audit_log|auth_totp|auth_throttle|password_hash|key_hash|api_key|secret_enc|prompt_text_sanitized|tool_args_summary|payload_hash)\b/i;
const SYSTEM_RE = /\b(pg_\w+|information_schema|lo_\w+|dblink\w*|set_config|current_setting)\b/i;

export const MAX_ROWS = 200;
const STATEMENT_TIMEOUT_MS = 8000;

/**
 * Validation for model-written SQL. Returns the normalized single statement (no trailing semicolon).
 * Requires `await initSqlParser()` first (runReadOnly does this); throws SqlGuardError otherwise (fail-closed).
 */
export function validateSql(raw: string): string {
  const { sql } = validateSqlAst(raw, ANALYST_GRANTS);
  // Strip string literals so keywords inside quoted text ('delete') do not trip the check.
  const noStrings = sql.replace(/'(?:[^']|'')*'/g, "''");
  const forbidden = noStrings.match(FORBIDDEN_RE);
  if (forbidden) throw new SqlGuardError(`Keyword not allowed: ${forbidden[0].toUpperCase()}`);
  if (SYSTEM_RE.test(noStrings)) throw new SqlGuardError('System catalogs and functions are not allowed');
  if (SECRET_RE.test(noStrings)) throw new SqlGuardError('That table/column holds credentials and is not queryable');
  return sql;
}

function collectRelations(node: unknown, out: Set<string>) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((n) => collectRelations(n, out));
    return;
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj['Relation Name'] === 'string') out.add(obj['Relation Name'] as string);
  for (const v of Object.values(obj)) collectRelations(v, out);
}

function truncateCell(v: unknown): unknown {
  if (typeof v === 'string' && v.length > 400) return `${v.slice(0, 400)}…`;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const s = JSON.stringify(v);
    return s.length > 400 ? `${s.slice(0, 400)}…` : v;
  }
  return v;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

const SQLSTATE_RE = /^[0-9A-Z]{5}$/;
/** A failure that did not come from PostgreSQL itself (socket reset, client-side query timeout…): connection state is unknown. */
function isClientSideError(err: unknown): boolean {
  if (err instanceof SqlGuardError) return false;
  const code = (err as { code?: unknown } | null)?.code;
  return !(typeof code === 'string' && SQLSTATE_RE.test(code));
}

function translateDbError(err: unknown): unknown {
  const code = (err as { code?: string }).code;
  if (code === '42501') {
    return new SqlGuardError('That table or column is not available to the analyst (restricted for privacy/security). Call get_schema to see what is queryable.');
  }
  if (code === '28P01' || code === '28000' || code === '53300') {
    return new SqlGuardError('The analyst database login is unavailable (bad credentials, role missing, or its connection limit is reached). An administrator must check ANALYST_DATABASE_URL / npm run db:analyst-login.');
  }
  return err;
}

/**
 * Session setup sent as ONE round trip (simple protocol), run as the analyst_login role itself — no SET ROLE.
 * Every limit is a SET LOCAL, so correctness does not depend on role-level defaults surviving Neon's
 * transaction pooler; those defaults are an additional layer, not the only one.
 * The trailing SELECT reports the real database identity, which is verified before any SQL runs.
 */
const SETUP_SQL = [
  'BEGIN READ ONLY',
  `SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`,
  'SET LOCAL lock_timeout = 2000',
  'SET LOCAL idle_in_transaction_session_timeout = 10000',
  'SET LOCAL search_path = pg_catalog, public',
  "SELECT current_user AS u, session_user AS s, current_setting('is_superuser') AS su, current_setting('transaction_read_only') AS ro",
  'SAVEPOINT analyst_q',
].join('; ');

/**
 * Cleanup in ONE round trip, run inside the same transaction (so it reaches the same backend even behind a
 * transaction pooler): recover from a failed statement, release any session-level advisory locks (the one kind of
 * session state a ROLLBACK does not undo; GUC changes, notifications and locks taken by the transaction are undone),
 * then roll back. If this fails, or the failure was client-side, the connection is destroyed instead of reused.
 */
const CLEANUP_SQL = 'ROLLBACK TO SAVEPOINT analyst_q; SELECT pg_advisory_unlock_all(); ROLLBACK';

/**
 * Validate and run a read-only query on the dedicated analyst pool (role `analyst_login`).
 * `trusted` skips the AST/text checks for server-built SQL; the pool, identity check, read-only transaction,
 * timeouts and column grants still apply. Fails closed if ANALYST_DATABASE_URL is missing — it never falls back
 * to the application pool.
 */
export async function runReadOnly(rawSql: string, params: unknown[] = [], trusted = false): Promise<QueryResult> {
  if (!trusted) await initSqlParser();
  const sql = trusted ? rawSql.trim().replace(/;+\s*$/, '') : validateSql(rawSql);
  const pool = getAnalystPool();
  if (process.env.AUTO_ENSURE_SCHEMA === 'true') await ensureSchema();
  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    throw translateDbError(err);
  }
  let discard = false;
  try {
    const setup = (await client.query(SETUP_SQL)) as unknown as Array<{ command?: string; rows: Record<string, string>[] }>;
    const id = (Array.isArray(setup) ? setup : [setup]).find((r) => r.command === 'SELECT')?.rows[0];
    if (!id || id.u !== ANALYST_LOGIN_ROLE || id.s !== ANALYST_LOGIN_ROLE || id.su !== 'off' || id.ro !== 'on') {
      discard = true;
      throw new SqlGuardError('The analyst database connection has the wrong identity or privileges; refusing to run SQL. Check ANALYST_DATABASE_URL.');
    }

    // Plan-based table allowlist (EXPLAIN does not execute the query).
    const plan = await client.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
    const relations = new Set<string>();
    collectRelations(plan.rows[0]?.['QUERY PLAN'], relations);
    for (const rel of relations) {
      if (!ALLOWED_SET.has(rel)) throw new SqlGuardError(`Table not allowed: ${rel}`);
    }

    const res = await client.query(`SELECT * FROM (${sql}) AS _q LIMIT ${MAX_ROWS + 1}`, params);
    const truncated = res.rows.length > MAX_ROWS;
    const rows = res.rows.slice(0, MAX_ROWS).map((r) =>
      Object.fromEntries(Object.entries(r).map(([k, v]) => [k, truncateCell(v)])),
    );
    return { columns: res.fields.map((f) => f.name), rows, rowCount: rows.length, truncated };
  } catch (err) {
    if (isClientSideError(err)) discard = true;
    throw translateDbError(err);
  } finally {
    if (!discard) {
      try {
        await client.query(CLEANUP_SQL);
      } catch {
        discard = true;
        try { await client.query('ROLLBACK'); } catch { /* connection is being destroyed anyway */ }
      }
    }
    client.release(discard);
  }
}
