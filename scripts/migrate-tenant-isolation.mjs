#!/usr/bin/env node
/**
 * Tenant-isolation migration runner (scripts/migrations/tenant-isolation.sql).
 *
 *   node scripts/migrate-tenant-isolation.mjs                 DRY RUN (default): applies the migration inside a transaction,
 *                                                             prints the attribution report, then ROLLS BACK. Changes nothing.
 *   CONFIRM_TENANT_MIGRATION=yes node scripts/migrate-tenant-isolation.mjs --apply       commit the migration
 *   CONFIRM_TENANT_MIGRATION=yes node scripts/migrate-tenant-isolation.mjs --rollback    run tenant-isolation.rollback.sql
 *
 * Even a dry run takes brief table locks, so run it against a Neon branch first. Apply BEFORE deploying the matching code.
 * Prints identifiers and counts only — never prompt text and never the connection string.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const rollback = args.has('--rollback');
if (apply && rollback) { console.error('Choose one of --apply / --rollback.'); process.exit(2); }
if ((apply || rollback) && process.env.CONFIRM_TENANT_MIGRATION !== 'yes') {
  console.error('Refusing to change the database: set CONFIRM_TENANT_MIGRATION=yes to confirm you have approval and a backup/branch.');
  process.exit(2);
}

// Deliberately NO fallback to .env.local: the target must be passed explicitly (e.g. node --env-file=<file> …) so this
// script can never silently run against whatever database the app's own env file points to.
function dbUrl() {
  return process.env.DATABASE_URL || process.env.NEON_CONNECTION_STRING;
}
const raw = dbUrl();
if (!raw) { console.error('DATABASE_URL (or NEON_CONNECTION_STRING) is not set. Pass it explicitly, e.g. node --env-file=<file> scripts/migrate-tenant-isolation.mjs'); process.exit(2); }
const endpointId = new URL(raw).hostname.split('.')[0].replace(/-pooler$/, '');
if (process.env.EXPECTED_ENDPOINT && process.env.EXPECTED_ENDPOINT !== endpointId) {
  console.error(`Endpoint mismatch: connected target is not the expected endpoint (${process.env.EXPECTED_ENDPOINT}). Refusing to continue.`);
  process.exit(2);
}

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const file = rollback ? 'tenant-isolation.rollback.sql' : 'tenant-isolation.sql';
const sql = fs.readFileSync(path.join(dir, file), 'utf8');

const u = new URL(raw); u.searchParams.delete('sslmode');
const c = new pg.Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
await c.connect();
try {
  const { rows: [{ db }] } = await c.query('SELECT current_database() AS db');
  console.log(`Endpoint: ${endpointId}  Database: ${db}  mode: ${rollback ? 'ROLLBACK' : apply ? 'APPLY' : 'DRY RUN (will roll back)'}`);
  await c.query('BEGIN');
  await c.query("SET LOCAL lock_timeout = '5s'");
  await c.query(sql);
  if (!rollback) {
    const one = async (q) => (await c.query(q)).rows;
    const NIL = '00000000-0000-0000-0000-000000000000';
    console.log('session_outcomes attributed to a real member:', (await one(`SELECT count(*)::int AS n FROM session_outcomes WHERE user_id <> '${NIL}'`))[0].n);
    console.log('session_outcomes preserved with the nil-UUID owner (orphans):', (await one(`SELECT count(*)::int AS n FROM session_outcomes WHERE user_id = '${NIL}'`))[0].n);
    console.log('session_outcomes quarantined as AMBIGUOUS, by reason:', JSON.stringify(await one('SELECT reason, count(*)::int AS n FROM session_outcomes_unattributed GROUP BY reason')));
    console.log('redundant_reprompt_events: attributed / ambiguous(NULL owner):',
      JSON.stringify((await one('SELECT count(*) FILTER (WHERE org_id IS NOT NULL)::int AS attributed, count(*) FILTER (WHERE org_id IS NULL)::int AS ambiguous FROM redundant_reprompt_events'))[0]));
    const amb = await one(`SELECT e.session_id, count(*)::int AS rows, (SELECT count(*) FROM sync_sessions s WHERE s.session_id = e.session_id)::int AS matching_sessions
                           FROM redundant_reprompt_events e WHERE e.org_id IS NULL GROUP BY e.session_id ORDER BY rows DESC LIMIT 50`);
    if (amb.length) console.log('Ambiguous reprompt events (first 50 session ids; matching_sessions 0 = orphan, >1 = shared id):', JSON.stringify(amb));
    const amo = await one('SELECT session_id, org_id, tool, reason FROM session_outcomes_unattributed ORDER BY quarantined_at DESC LIMIT 50');
    if (amo.length) console.log('Quarantined (ambiguous) outcomes, first 50:', JSON.stringify(amo));
  }
  if (apply || rollback) { await c.query('COMMIT'); console.log('COMMITTED.'); }
  else { await c.query('ROLLBACK'); console.log('Dry run complete — rolled back, nothing changed.'); }
} catch (err) {
  await c.query('ROLLBACK').catch(() => {});
  console.error('FAILED, rolled back:', err.code, err.message);
  process.exitCode = 1;
} finally { await c.end(); }
