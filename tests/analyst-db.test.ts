/**
 * Database-level permission tests. They prove the PostgreSQL boundary rejects unauthorized access
 * independently of the application validator (we bypass validateSql and send SQL straight to the DB as analyst_ro).
 * Runs only against the explicit test branch (tests/README.md) and requires the analyst_ro role there. Read-only; always rolled back.
 */
import { SKIP_DB, SKIP_REASON, connectionString, loadTestDb } from './helpers/test-db'; // FIRST: installs the production-credential tripwire
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const cfg = SKIP_DB ? undefined : loadTestDb('owner'); // owner-level test-branch login; the tests then SET ROLE analyst_ro inside read-only transactions
let pool: pg.Pool | undefined;

async function asAnalyst<T>(sql: string): Promise<T[]> {
  const c = await pool!.connect();
  try {
    await c.query('BEGIN READ ONLY; SET LOCAL ROLE analyst_ro; SET LOCAL statement_timeout = 8000');
    return (await c.query(sql)).rows as T[];
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}
const denied = (sql: string) => assert.rejects(() => asAnalyst(sql), (e: { code?: string }) => e.code === '42501');

describe('analyst_ro database permissions (independent of the app validator)', { skip: SKIP_DB && SKIP_REASON }, () => {
  before(async () => {
    pool = new pg.Pool({ connectionString: connectionString(cfg!), ssl: { rejectUnauthorized: false }, max: 1 });
    await asAnalyst('SELECT 1'); // throws (suite fails) if the test branch is unreachable or analyst_ro is missing
  });
  after(async () => { await pool?.end(); });
  const t = (name: string, fn: () => Promise<void>) => it(name, fn);

  t('role is not superuser / bypassrls / createrole / createdb / login', async () => {
    const [r] = await asAnalyst<Record<string, boolean>>("SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin FROM pg_roles WHERE rolname = 'analyst_ro'");
    assert.deepEqual(Object.values(r), [false, false, false, false, false]);
  });
  t('ungranted column on a granted table is denied', () => denied('SELECT label FROM sync_sessions'));
  t('credential tables are denied', async () => {
    await denied('SELECT id FROM users');
    await denied('SELECT id FROM member_keys');
    await denied('SELECT id FROM audit_log');
  });
  t('SELECT * on a table with ungranted columns is denied', () => denied('SELECT * FROM members'));
  t('whole-row reference is denied', () => denied('SELECT to_jsonb(m) FROM members m'));
  t('writes are denied', async () => {
    await assert.rejects(() => asAnalyst("UPDATE teams SET name = 'x'"), (e: { code?: string }) => ['42501', '25006'].includes(e.code ?? ''));
    await assert.rejects(() => asAnalyst('DELETE FROM teams'), (e: { code?: string }) => ['42501', '25006'].includes(e.code ?? ''));
  });
  t('granted columns are readable', async () => { await asAnalyst('SELECT id, name FROM teams LIMIT 1'); });
});
