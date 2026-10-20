#!/usr/bin/env node
/**
 * Creates / refreshes the restricted `analyst_ro` Postgres role used by the chatbot.
 * Idempotent — safe to re-run after schema changes or after editing analyst-grants.json.
 *   npm run db:analyst-role
 * Needs DATABASE_URL (from .env.local or the environment) with an owner/admin user.
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

function loadEnv() {
  for (const f of ['.env.local', '.env']) {
    try {
      for (const line of fs.readFileSync(path.join(process.cwd(), f), 'utf8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const i = t.indexOf('=');
        if (i < 1) continue;
        const k = t.slice(0, i).trim();
        const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
        if (v && !process.env[k]) process.env[k] = v;
      }
    } catch { /* file absent */ }
  }
}
loadEnv();

const raw = process.env.DATABASE_URL || process.env.NEON_CONNECTION_STRING;
if (!raw) { console.error('DATABASE_URL is not set'); process.exit(1); }
const url = new URL(raw);
url.searchParams.delete('sslmode');

const grants = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'lib/admin/chat/analyst-grants.json'), 'utf8')).tables;
const q = (id) => `"${String(id).replace(/"/g, '""')}"`;

const client = new pg.Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'analyst_ro') THEN CREATE ROLE analyst_ro NOLOGIN; END IF;
  END $$`);
  // Let the app's connection user SET ROLE analyst_ro (PG16+ needs an explicit SET option).
  try { await client.query('GRANT analyst_ro TO CURRENT_USER WITH SET TRUE'); }
  catch { await client.query('GRANT analyst_ro TO CURRENT_USER'); }

  await client.query('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM analyst_ro');
  await client.query('GRANT USAGE ON SCHEMA public TO analyst_ro');
  // Hard stop: this role can never write, whatever happens elsewhere.
  await client.query('ALTER ROLE analyst_ro SET default_transaction_read_only = on');
  await client.query('ALTER ROLE analyst_ro SET statement_timeout = 8000');

  const missing = [];
  for (const [table, cols] of Object.entries(grants)) {
    const { rows } = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [table]);
    if (!rows.length) { missing.push(table); continue; }
    const have = new Set(rows.map((r) => r.column_name));
    const usable = cols.filter((c) => have.has(c));
    const skipped = cols.filter((c) => !have.has(c));
    if (!usable.length) { missing.push(table); continue; }
    await client.query(`GRANT SELECT (${usable.map(q).join(', ')}) ON public.${q(table)} TO analyst_ro`);
    console.log(`granted  ${table} (${usable.length} cols${skipped.length ? `, skipped missing: ${skipped.join(', ')}` : ''})`);
  }
  if (missing.length) console.log(`\nnot found (skipped): ${missing.join(', ')}`);
  console.log('\nanalyst_ro is ready.');
} finally {
  await client.end();
}
