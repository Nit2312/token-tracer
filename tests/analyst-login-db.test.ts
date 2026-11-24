/**
 * Live checks of the provisioned analyst_login role on the TEST branch, over TEST_ANALYST_DATABASE_URL (tests/README.md).
 * Fails if that is not configured; never uses the production ANALYST_DATABASE_URL. Read-only; every transaction is rolled back.
 */
import { SKIP_DB, SKIP_REASON, connectionString, loadTestDb } from './helpers/test-db'; // FIRST: installs the production-credential tripwire
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const cfg = SKIP_DB ? undefined : loadTestDb('analyst'); // analyst_login URL of the TEST branch (never the production ANALYST_DATABASE_URL)
let pool: pg.Pool | undefined;

async function tx<T>(sql: string): Promise<T[]> {
  const c = await pool!.connect();
  try {
    await c.query('BEGIN READ ONLY');
    return (await c.query(sql)).rows as T[];
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
}
const denied = (sql: string, codes = ['42501']) => assert.rejects(() => tx(sql), (e: { code?: string }) => codes.includes(e.code ?? ''));

describe('analyst_login (live)', { skip: SKIP_DB && SKIP_REASON }, () => {
  before(async () => {
    pool = new pg.Pool({ connectionString: connectionString(cfg!), ssl: { rejectUnauthorized: false }, max: 1 });
    await tx('SELECT 1'); // throws (suite fails) if the test branch's analyst_login is unreachable
  });
  after(async () => { await pool?.end(); });
  const t = (name: string, fn: () => Promise<void>) => it(name, fn);

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
