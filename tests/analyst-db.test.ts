/**
 * Database-level permission tests. They prove the PostgreSQL boundary rejects unauthorized access
 * independently of the application validator (we bypass validateSql and send SQL straight to the DB as analyst_ro).
 * Skipped unless DATABASE_URL is set and the analyst_ro role exists (npm run db:analyst-role). Read-only; always rolled back.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';

function env(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const m = fs.readFileSync('.env.local', 'utf8').match(/^DATABASE_URL=["']?([^"'\n]+)/m);
    return m?.[1];
  } catch { return undefined; }
}

const raw = env();
let pool: pg.Pool | undefined;
let ready = false;

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

describe('analyst_ro database permissions (independent of the app validator)', { skip: !raw && 'DATABASE_URL not set' }, () => {
  before(async () => {
    const url = new URL(raw!);
    url.searchParams.delete('sslmode');
    pool = new pg.Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: false }, max: 1 });
    try { await asAnalyst('SELECT 1'); ready = true; } catch { ready = false; }
  });
  after(async () => { await pool?.end(); });
  const t = (name: string, fn: () => Promise<void>) => it(name, async (ctx) => { if (!ready) return ctx.skip('analyst_ro not set up'); await fn(); });

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
