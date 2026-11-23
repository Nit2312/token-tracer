#!/usr/bin/env node
/**
 * Provisions the dedicated `analyst_login` database login used by the Superadmin Analyst Chat (Phase 1).
 *
 *   npm run db:analyst-login              create / refresh the role            (needs admin DATABASE_URL)
 *   npm run db:analyst-login -- --verify  check the live ANALYST_DATABASE_URL  (needs ANALYST_DATABASE_URL)
 *   npm run db:analyst-login -- --drop    roll back: remove the role           (needs admin DATABASE_URL)
 *
 * Prerequisite: `npm run db:analyst-role` has been run (it owns the column grants on `analyst_ro`; this script
 * never touches them — analyst_login only INHERITS analyst_ro).
 *
 * Password: set ANALYST_LOGIN_PASSWORD (>= 16 printable ASCII chars, e.g. `openssl rand -hex 24`) in the
 * environment when running; never put it in a file in the repo. Neon only accepts PLAINTEXT passwords in
 * CREATE/ALTER ROLE (its control plane rejects pre-hashed SCRAM verifiers), so the statement carries the plaintext
 * over TLS; PostgreSQL stores only a hash. Required on first create; optional afterwards (omit to keep the
 * current password, set to rotate it). Idempotent.
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const ROLE = 'analyst_login';
const PARENT = 'analyst_ro';
const CONN_LIMIT = 3;
const DEFAULTS = {
  statement_timeout: 8000,
  default_transaction_read_only: 'on',
  idle_in_transaction_session_timeout: 10000,
  lock_timeout: 2000,
  search_path: 'pg_catalog, public',
};

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

function connect(rawUrl) {
  const url = new URL(rawUrl);
  url.searchParams.delete('sslmode');
  return new pg.Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });
}
const q = (id) => `"${String(id).replace(/"/g, '""')}"`;
const mode = process.argv.includes('--verify') ? 'verify' : process.argv.includes('--drop') ? 'drop' : 'provision';

async function provision() {
  const raw = process.env.DATABASE_URL || process.env.NEON_CONNECTION_STRING;
  if (!raw) { console.error('DATABASE_URL (admin/owner connection) is not set'); process.exit(1); }
  const password = process.env.ANALYST_LOGIN_PASSWORD;
  if (password !== undefined && (password.length < 16 || !/^[\x21-\x7e]+$/.test(password))) {
    console.error('ANALYST_LOGIN_PASSWORD must be >= 16 printable ASCII characters with no spaces (e.g. openssl rand -hex 24).'); process.exit(1);
  }
  const client = connect(raw);
  await client.connect();
  try {
    const parent = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [PARENT]);
    if (!parent.rowCount) { console.error(`Role ${PARENT} does not exist. Run: npm run db:analyst-role first.`); process.exit(1); }
    const exists = (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [ROLE])).rowCount > 0;
    if (!exists && !password) { console.error('ANALYST_LOGIN_PASSWORD is required to create the role (>= 16 chars, e.g. openssl rand -hex 24).'); process.exit(1); }
    const { rows: [{ v }] } = await client.query("SELECT current_setting('server_version_num')::int AS v");

    await client.query('BEGIN');
    const pw = password ? ` PASSWORD ${client.escapeLiteral(password)}` : '';
    if (exists) {
      // A non-superuser (Neon's owner role) may not name SUPERUSER/REPLICATION/BYPASSRLS in ALTER ROLE at all, even
      // as NO…; so only set what it may change, and VERIFY the privileged attributes instead.
      await client.query(`ALTER ROLE ${q(ROLE)} LOGIN INHERIT CONNECTION LIMIT ${CONN_LIMIT}${pw}`);
    } else {
      await client.query(`CREATE ROLE ${q(ROLE)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT CONNECTION LIMIT ${CONN_LIMIT}${pw}`);
    }
    const flags = (await client.query('SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1', [ROLE])).rows[0];
    const bad = Object.entries(flags).filter(([, on]) => on).map(([k]) => k);
    if (bad.length) throw new Error(`${ROLE} has forbidden attributes (${bad.join(', ')}). Remove them as a superuser (e.g. in the Neon console) and re-run; refusing to continue.`);

    if (v >= 160000) {
      // INHERIT: use analyst_ro's grants directly. SET FALSE: analyst_login can never SET ROLE analyst_ro (or anything else).
      await client.query(`GRANT ${q(PARENT)} TO ${q(ROLE)} WITH INHERIT TRUE, SET FALSE`);
    } else {
      await client.query(`GRANT ${q(PARENT)} TO ${q(ROLE)}`);
      console.warn('WARNING: PostgreSQL < 16 cannot restrict SET ROLE per membership; analyst_login can SET ROLE analyst_ro.');
    }
    for (const [k, val] of Object.entries(DEFAULTS)) {
      await client.query(`ALTER ROLE ${q(ROLE)} SET ${k} = ${typeof val === 'number' ? val : k === 'search_path' ? val : client.escapeLiteral(val)}`);
    }
    const { rows: others } = await client.query(
      `SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
       WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = $1) AND r.rolname <> $2`, [ROLE, PARENT]);
    if (others.length) console.warn(`WARNING: ${ROLE} has unexpected extra memberships: ${others.map((r) => r.rolname).join(', ')}`);
    await client.query('COMMIT'); // Neon syncs role DDL to its control plane here; a failure rolls everything back
    console.log(`${exists ? 'refreshed' : 'created'}  role ${ROLE}${password ? (exists ? ' (password rotated)' : '') : ' (password unchanged)'}`);

    const adminUrl = new URL(raw);
    const host = adminUrl.host;
    const dbName = adminUrl.pathname.replace(/^\//, '') || '<dbname>';
    console.log(`\n${ROLE} is ready (inherits ${PARENT}, connection limit ${CONN_LIMIT}).`);
    console.log('Next: set ANALYST_DATABASE_URL (locally in .env.local and in Vercel env) using the SAME pooled host as DATABASE_URL:');
    console.log(`  ANALYST_DATABASE_URL=postgresql://${ROLE}:<ANALYST_LOGIN_PASSWORD>@${host}/${dbName}?sslmode=require`);
    console.log('Then check it with: npm run db:analyst-login -- --verify');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

async function drop() {
  const raw = process.env.DATABASE_URL || process.env.NEON_CONNECTION_STRING;
  if (!raw) { console.error('DATABASE_URL (admin/owner connection) is not set'); process.exit(1); }
  const client = connect(raw);
  await client.connect();
  try {
    if (!(await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [ROLE])).rowCount) { console.log(`${ROLE} does not exist; nothing to do.`); return; }
    await client.query('BEGIN');
    await client.query(`REVOKE ${q(PARENT)} FROM ${q(ROLE)}`);
    await client.query(`DROP OWNED BY ${q(ROLE)}`);
    await client.query(`DROP ROLE ${q(ROLE)}`);
    await client.query('COMMIT');
    console.log(`dropped role ${ROLE}. Also unset ANALYST_DATABASE_URL (analyst queries will then fail closed until re-provisioned). analyst_ro is untouched.`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

async function verify() {
  const raw = process.env.ANALYST_DATABASE_URL;
  if (!raw) { console.error('ANALYST_DATABASE_URL is not set'); process.exit(1); }
  if (/[<>]/.test(raw) || /%3C|%3E/i.test(raw)) {
    console.error('ANALYST_DATABASE_URL still contains template placeholders (<...>). Replace <ANALYST_LOGIN_PASSWORD> with the real password and <dbname> with the database name.'); process.exit(1);
  }
  const client = connect(raw);
  await client.connect();
  let failed = 0;
  const check = (ok, label, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`); };
  const denied = async (sql, label, codes = ['42501']) => {
    try { await client.query('BEGIN READ ONLY'); await client.query(sql); check(false, label, 'was allowed'); }
    catch (e) { check(codes.includes(e.code), label, e.code); }
    finally { await client.query('ROLLBACK').catch(() => {}); }
  };
  try {
    const id = (await client.query("SELECT current_user u, session_user s, current_setting('is_superuser') su")).rows[0];
    check(id.u === ROLE && id.s === ROLE, `connected as ${ROLE}`, `current_user=${id.u} session_user=${id.s}`);
    check(id.su === 'off', 'not superuser');
    const r = (await client.query(`SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin, rolconnlimit FROM pg_roles WHERE rolname = $1`, [ROLE])).rows[0];
    check(r && !r.rolsuper && !r.rolcreatedb && !r.rolcreaterole && !r.rolreplication && !r.rolbypassrls && r.rolcanlogin && r.rolconnlimit === CONN_LIMIT, 'role attributes', JSON.stringify(r));
    const m = (await client.query(`SELECT m.inherit_option i, m.set_option s FROM pg_auth_members m WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname=$1) AND m.roleid = (SELECT oid FROM pg_roles WHERE rolname=$2)`, [ROLE, PARENT])).rows[0];
    check(m && m.i === true && m.s === false, `membership in ${PARENT}: INHERIT TRUE, SET FALSE`, JSON.stringify(m));
    const all = (await client.query("SELECT count(*)::int n FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname=$1)", [ROLE])).rows[0].n;
    check(all === 1, 'no other role memberships', `${all} membership(s)`);
    // Role-level defaults reaching the session through the (possibly pooled) endpoint. Informational: the app also
    // sets every limit with SET LOCAL, so it does not depend on this.
    const s = (await client.query("SELECT current_setting('statement_timeout') st, current_setting('default_transaction_read_only') ro, current_setting('idle_in_transaction_session_timeout') idl, current_setting('lock_timeout') lk, current_setting('search_path') sp")).rows[0];
    const applied = s.st === '8s' && s.ro === 'on' && s.idl === '10s' && s.lk === '2s' && s.sp === 'pg_catalog, public';
    console.log(`${applied ? 'PASS' : 'WARN'}  role-level defaults applied on this endpoint — ${JSON.stringify(s)}${applied ? '' : ' (app still enforces all via SET LOCAL)'}`);
    const rows = (await client.query('SELECT id, name FROM teams LIMIT 1')).rowCount;
    check(rows >= 0, 'can read granted columns (teams.id, teams.name)');
    await denied('SELECT label FROM sync_sessions LIMIT 1', 'ungranted column is denied (sync_sessions.label)');
    await denied('SELECT id FROM users LIMIT 1', 'credential table is denied (users)');
    await denied('SET ROLE analyst_ro', 'SET ROLE analyst_ro is refused');
    await denied("UPDATE teams SET name = name WHERE false", 'writes are refused', ['42501', '25006']);
  } finally {
    await client.end();
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed.');
  process.exit(failed ? 1 : 0);
}

await (mode === 'verify' ? verify() : mode === 'drop' ? drop() : provision());
