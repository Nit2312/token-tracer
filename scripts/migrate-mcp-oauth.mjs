#!/usr/bin/env node
/**
 * MCP OAuth migration runner (scripts/migrations/mcp-oauth.sql). Additive: five NEW tables and five NEW functions only.
 *
 *   EXPECTED_ENDPOINT=<ep-id> node --env-file=<file> scripts/migrate-mcp-oauth.mjs              DRY RUN (default): applies inside a transaction, reports, ROLLS BACK.
 *   CONFIRM_MCP_MIGRATION=yes EXPECTED_ENDPOINT=<ep-id> node --env-file=<file> scripts/migrate-mcp-oauth.mjs --apply
 *   CONFIRM_MCP_MIGRATION=yes EXPECTED_ENDPOINT=<ep-id> [CONFIRM_MCP_ROLLBACK_DATA_LOSS=yes] node --env-file=<file> scripts/migrate-mcp-oauth.mjs --rollback
 *
 * Safety: EXPECTED_ENDPOINT is required in EVERY mode (even a dry run executes DDL and briefly locks `users` for the foreign keys), so the
 * target can never be "whatever DATABASE_URL happens to be". No .env.local fallback. TLS certificates are verified. A rollback prints
 * the row counts it is about to destroy and refuses to proceed if any table holds data unless CONFIRM_MCP_ROLLBACK_DATA_LOSS=yes.
 * Prints names and counts only — never the connection string.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const rollback = args.has('--rollback');
if (apply && rollback) { console.error('Choose one of --apply / --rollback.'); process.exit(2); }
const raw = process.env.DATABASE_URL || process.env.NEON_CONNECTION_STRING;
if (!raw) { console.error('DATABASE_URL is not set. Pass it explicitly (node --env-file=<file> …); there is no .env.local fallback.'); process.exit(2); }
const endpointId = new URL(raw).hostname.split('.')[0].replace(/-pooler$/, '');
if (!process.env.EXPECTED_ENDPOINT) { console.error('EXPECTED_ENDPOINT is required in every mode (the Neon endpoint id of the intended target).'); process.exit(2); }
if (process.env.EXPECTED_ENDPOINT !== endpointId) { console.error(`Endpoint mismatch: the target is not the expected endpoint (${process.env.EXPECTED_ENDPOINT}). Refusing to continue.`); process.exit(2); }
if ((apply || rollback) && process.env.CONFIRM_MCP_MIGRATION !== 'yes') { console.error('Refusing to change the database: set CONFIRM_MCP_MIGRATION=yes (approval + backup/branch in place).'); process.exit(2); }

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const sql = fs.readFileSync(path.join(dir, rollback ? 'mcp-oauth.rollback.sql' : 'mcp-oauth.sql'), 'utf8');
const TABLES = ['oauth_clients', 'oauth_authorization_codes', 'oauth_tokens', 'mcp_rate_limits', 'mcp_access_log'];
const FUNCTIONS = ['mcp_guard_oauth_tokens()', 'mcp_guard_oauth_codes()', 'mcp_guard_oauth_clients()', 'mcp_audit_event(text, uuid, text, text, jsonb)', 'mcp_oauth_purge()'];

const u = new URL(raw); u.searchParams.delete('sslmode');
const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
const c = new pg.Client({ connectionString: u.toString(), ssl: local ? false : { rejectUnauthorized: true } });
await c.connect();
const tablesPresent = async () => (await c.query("SELECT relname FROM pg_class WHERE relkind='r' AND relnamespace='public'::regnamespace AND relname = ANY($1) ORDER BY 1", [TABLES])).rows.map((r) => r.relname);
const functionsPresent = async () => (await c.query('SELECT f FROM unnest($1::text[]) f WHERE to_regprocedure(f) IS NOT NULL', [FUNCTIONS])).rows.map((r) => r.f);
try {
  const { rows: [{ db }] } = await c.query('SELECT current_database() AS db');
  console.log(`Endpoint: ${endpointId}  Database: ${db}  mode: ${rollback ? 'ROLLBACK' : apply ? 'APPLY' : 'DRY RUN (will roll back)'}`);
  const before = await tablesPresent();
  console.log('Tables present BEFORE:', JSON.stringify(before), ' functions:', JSON.stringify(await functionsPresent()));
  await c.query('BEGIN');
  await c.query("SET LOCAL lock_timeout = '5s'");
  await c.query("SET LOCAL statement_timeout = '60s'");
  if (rollback) {
    const counts = {};
    for (const t of before) counts[t] = (await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
    console.log('Rows that the rollback will DESTROY:', JSON.stringify(counts));
    if (Object.values(counts).some((n) => n > 0) && process.env.CONFIRM_MCP_ROLLBACK_DATA_LOSS !== 'yes') {
      throw new Error('tables contain data; set CONFIRM_MCP_ROLLBACK_DATA_LOSS=yes to destroy it (export mcp_access_log first if needed)');
    }
  }
  await c.query(sql);
  console.log('Tables present AFTER (inside transaction):', JSON.stringify(await tablesPresent()), ' functions:', JSON.stringify(await functionsPresent()));
  if (!rollback) {
    await c.query(sql); // idempotency: the same script a second time, same transaction, must be a no-op
    console.log('Second run in the same transaction: OK (idempotent)');
    const fks = (await c.query(`SELECT conrelid::regclass::text AS t, confrelid::regclass::text AS ref FROM pg_constraint WHERE contype='f' AND conrelid::regclass::text = ANY($1) ORDER BY 1,2`, [TABLES])).rows;
    console.log('Foreign keys on the new tables:', JSON.stringify(fks));
    const trg = (await c.query(`SELECT tgrelid::regclass::text AS t, tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text = ANY($1) ORDER BY 1`, [TABLES])).rows;
    console.log('Tamper-guard triggers:', JSON.stringify(trg));
    const pub = (await c.query(`SELECT p.oid::regprocedure::text AS f FROM pg_proc p
        WHERE p.oid = ANY (SELECT to_regprocedure(f)::oid FROM unnest($1::text[]) f WHERE to_regprocedure(f) IS NOT NULL)
          AND EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')`, [FUNCTIONS])).rows.map((r) => r.f);
    console.log('New functions still executable by PUBLIC (must be empty):', JSON.stringify(pub));
    if (trg.length !== 3 || pub.length) throw new Error('post-migration expectations not met (3 triggers, no PUBLIC execute)');
  }
  if (apply || rollback) { await c.query('COMMIT'); console.log('COMMITTED.'); }
  else { await c.query('ROLLBACK'); console.log('DRY RUN: rolled back, nothing changed. Tables present now:', JSON.stringify(await tablesPresent())); }
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error('FAILED, rolled back:', e.message);
  process.exitCode = 1;
} finally {
  await c.end();
}
