/**
 * Live checks of the provisioned analyst_login role over ANALYST_DATABASE_URL (the real pooled Neon endpoint).
 * Skipped unless ANALYST_DATABASE_URL is set and works. Read-only; every transaction is rolled back.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';

function url(): string | undefined {
  if (process.env.ANALYST_DATABASE_URL) return process.env.ANALYST_DATABASE_URL;
  try { return fs.readFileSync('.env.local', 'utf8').match(/^ANALYST_DATABASE_URL=["']?([^"'\n]+)/m)?.[1]; } catch { return undefined; }
}
const raw = url();
let pool: pg.Pool | undefined;
let ready = false;

async function tx<T>(sql: string): Promise<T[]> {
  const c = await pool!.connect();
  try {
    await c.query('BEGIN READ ONLY');
    return (await c.query(sql)).rows as T[];
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
}
const denied = (sql: string, codes = ['42501']) => assert.rejects(() => tx(sql), (e: { code?: string }) => codes.includes(e.code ?? ''));

describe('analyst_login (live)', { skip: !raw && 'ANALYST_DATABASE_URL not set' }, () => {
  before(async () => {
    const u = new URL(raw!); u.searchParams.delete('sslmode');
    pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false }, max: 1 });
    try { await tx('SELECT 1'); ready = true; } catch { ready = false; }
  });
  after(async () => { await pool?.end(); });
  const t = (name: string, fn: () => Promise<void>) => it(name, async (ctx) => { if (!ready) return ctx.skip('analyst_login not reachable'); await fn(); });

  t('connects as analyst_login, not superuser', async () => {
    const [r] = await tx<Record<string, string>>("SELECT current_user u, session_user s, current_setting('is_superuser') su");
    assert.deepEqual(r, { u: 'analyst_login', s: 'analyst_login', su: 'off' });
  });
  t('role attributes and connection limit', async () => {
    const [r] = await tx<Record<string, unknown>>("SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin, rolconnlimit FROM pg_roles WHERE rolname = 'analyst_login'");
    assert.deepEqual(r, { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, rolcanlogin: true, rolconnlimit: 3 });
  });
  t('inherits analyst_ro with INHERIT TRUE and SET FALSE, and nothing else', async () => {
    const rows = await tx<Record<string, unknown>>("SELECT r.rolname, m.inherit_option, m.set_option FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = 'analyst_login')");
    assert.deepEqual(rows, [{ rolname: 'analyst_ro', inherit_option: true, set_option: false }]);
  });
  t('inherited column grants work: granted readable, ungranted / credential tables denied', async () => {
    await tx('SELECT id, name FROM teams LIMIT 1');
    await denied('SELECT label FROM sync_sessions LIMIT 1');
    await denied('SELECT id FROM users LIMIT 1');
    await denied('SELECT * FROM members LIMIT 1');
  });
  t('cannot switch roles', async () => {
    await denied('SET ROLE analyst_ro');
    await denied('SET ROLE neondb_owner');
  });
  t('writes are refused', async () => { await denied('UPDATE teams SET name = name WHERE false', ['42501', '25006']); });
  t('SET LOCAL limits take effect inside a transaction (what the app relies on)', async () => {
    const c = await pool!.connect();
    try {
      await c.query('BEGIN READ ONLY; SET LOCAL statement_timeout = 8000');
      assert.equal((await c.query("SELECT current_setting('statement_timeout') v")).rows[0].v, '8s');
      await assert.rejects(() => c.query('SET LOCAL statement_timeout = 50; SELECT pg_sleep(1)'), (e: { code?: string }) => e.code === '57014');
    } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
  });
});
