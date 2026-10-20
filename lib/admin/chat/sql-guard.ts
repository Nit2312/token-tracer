import 'server-only';
/**
 * Guardrails for LLM-written SQL. Defense in depth:
 *  1. Static checks — single SELECT/WITH statement, no comments, no write/admin keywords,
 *     no pg_* / information_schema access, no credential columns.
 *  2. Table allowlist — verified from the real query plan (EXPLAIN), not by regex.
 *  3. Execution inside a READ ONLY transaction as the restricted `analyst_ro` role, whose column-level
 *     grants make credentials, prompt text, event payloads and session labels unreadable no matter how
 *     the SQL is written (even `SELECT *`, whole-row references or to_jsonb(row) fail). Plus a statement
 *     timeout and a hard row cap.
 */
import { ensureSchema, getPool } from '@/lib/team/db';
import grantsJson from './analyst-grants.json';

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
const MAX_SQL_LENGTH = 6000;

export class SqlGuardError extends Error {}

/** Static validation. Returns the normalized single statement (no trailing semicolon). */
export function validateSql(raw: string): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new SqlGuardError('SQL is empty');
  if (raw.length > MAX_SQL_LENGTH) throw new SqlGuardError('SQL is too long');
  const sql = raw.trim().replace(/;+\s*$/, '');
  if (sql.includes(';')) throw new SqlGuardError('Only a single statement is allowed');
  if (/--|\/\*|\*\//.test(sql)) throw new SqlGuardError('SQL comments are not allowed');
  if (!/^(select|with)\b/i.test(sql)) throw new SqlGuardError('Only SELECT queries are allowed');
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

/** Validate and run a read-only query. `trusted` skips the text checks for server-built SQL. */
export async function runReadOnly(rawSql: string, params: unknown[] = [], trusted = false): Promise<QueryResult> {
  const sql = trusted ? rawSql.trim().replace(/;+\s*$/, '') : validateSql(rawSql);
  if (process.env.AUTO_ENSURE_SCHEMA === 'true') await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN READ ONLY');
    // Drop to the restricted role for the rest of this transaction. Fails closed if it was never created.
    await client.query('SET LOCAL ROLE analyst_ro');
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);

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
    const code = (err as { code?: string }).code;
    if (code === '42501') {
      throw new SqlGuardError('That table or column is not available to the analyst (restricted for privacy/security). Call get_schema to see what is queryable.');
    }
    if (code === '22023' || (code === '42704' && String((err as Error).message).includes('analyst_ro'))) {
      throw new SqlGuardError('The analyst database role is not set up. An administrator must run: npm run db:analyst-role');
    }
    throw err;
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch {
      // connection may already be aborted
    }
    client.release();
  }
}
