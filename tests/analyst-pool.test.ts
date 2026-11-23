import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AnalystConfigError, ANALYST_POOL_MAX, getAnalystPool, resetAnalystPool } from '../lib/admin/chat/analyst-pool';
import { runReadOnly, SqlGuardError } from '../lib/admin/chat/sql-guard';

const saved = { a: process.env.ANALYST_DATABASE_URL, d: process.env.DATABASE_URL, e: process.env.AUTO_ENSURE_SCHEMA };
beforeEach(async () => { await resetAnalystPool(); delete process.env.AUTO_ENSURE_SCHEMA; });
afterEach(async () => {
  await resetAnalystPool();
  for (const [k, v] of [['ANALYST_DATABASE_URL', saved.a], ['DATABASE_URL', saved.d], ['AUTO_ENSURE_SCHEMA', saved.e]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe('analyst pool configuration (fail closed, no fallback)', () => {
  it('missing ANALYST_DATABASE_URL is a clear config error even when DATABASE_URL is set', () => {
    delete process.env.ANALYST_DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://neondb_owner:x@host/db';
    assert.throws(() => getAnalystPool(), (e) => e instanceof AnalystConfigError && /ANALYST_DATABASE_URL/.test(e.message));
  });
  it('rejects a URL for any other user (e.g. DATABASE_URL pasted by mistake)', () => {
    process.env.ANALYST_DATABASE_URL = 'postgresql://neondb_owner:secret@host/db';
    assert.throws(() => getAnalystPool(), (e) => e instanceof AnalystConfigError && /analyst_login/.test(e.message) && !/secret/.test(e.message));
  });
  it('rejects an unfilled template (placeholders) without echoing the URL', () => {
    process.env.ANALYST_DATABASE_URL = 'postgresql://analyst_login:<ANALYST_LOGIN_PASSWORD>@host/<dbname>?sslmode=require';
    assert.throws(() => getAnalystPool(), (e) => e instanceof AnalystConfigError && /placeholders/.test(e.message) && !/ANALYST_LOGIN_PASSWORD>/.test(e.message));
  });
  it('rejects garbage', () => {
    process.env.ANALYST_DATABASE_URL = 'not a url';
    assert.throws(() => getAnalystPool(), AnalystConfigError);
  });
  it('builds an isolated pool of max 2 and caches it', () => {
    process.env.ANALYST_DATABASE_URL = 'postgresql://analyst_login:pw@localhost:1/db?sslmode=require';
    const p = getAnalystPool();
    assert.equal(p.options.max, ANALYST_POOL_MAX);
    assert.equal(ANALYST_POOL_MAX, 2);
    assert.equal(getAnalystPool(), p);
  });
  it('runReadOnly (model SQL and trusted reports) fails with the config error and never touches the app pool', async () => {
    delete process.env.ANALYST_DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://neondb_owner:x@127.0.0.1:1/db'; // would fail differently (ECONNREFUSED) if used
    await assert.rejects(() => runReadOnly('SELECT id FROM teams'), (e) => e instanceof AnalystConfigError);
    await assert.rejects(() => runReadOnly('SELECT 1', [], true), (e) => e instanceof AnalystConfigError);
  });
  it('AST validation still runs first (bad SQL is rejected before any connection)', async () => {
    delete process.env.ANALYST_DATABASE_URL;
    await assert.rejects(() => runReadOnly('DELETE FROM teams'), (e) => e instanceof SqlGuardError && /Only SELECT/.test(e.message));
  });
});

// ── runReadOnly against a fake pool: statements issued, identity check, cleanup / discard strategy ──
interface Call { sql: string }
function fakePool(opts: { identity?: Record<string, string>; failOn?: RegExp; failWith?: Record<string, unknown>; cleanupFails?: boolean } = {}) {
  const calls: Call[] = [];
  const released: boolean[] = [];
  const identity = opts.identity ?? { u: 'analyst_login', s: 'analyst_login', su: 'off', ro: 'on' };
  const client = {
    async query(sql: string) {
      calls.push({ sql });
      if (opts.failOn?.test(sql)) throw Object.assign(new Error('boom'), opts.failWith ?? { code: '42501' });
      if (sql.startsWith('ROLLBACK TO SAVEPOINT') && opts.cleanupFails) throw new Error('conn dead');
      if (sql.startsWith('BEGIN READ ONLY')) return [{ command: 'BEGIN', rows: [] }, { command: 'SELECT', rows: [identity] }, { command: 'SAVEPOINT', rows: [] }];
      if (sql.startsWith('EXPLAIN')) return { rows: [{ 'QUERY PLAN': [{ Plan: { 'Relation Name': 'teams' } }] }], fields: [] };
      if (sql.startsWith('SELECT * FROM')) return { rows: [{ id: 1, name: 'x'.repeat(500) }], fields: [{ name: 'id' }, { name: 'name' }] };
      return { rows: [], fields: [] };
    },
    release(discard?: boolean) { released.push(!!discard); },
  };
  const pool = { async connect() { return client; }, options: { max: 2 }, on() {}, async end() {} };
  (globalThis as unknown as { analystPool: unknown }).analystPool = pool;
  return { calls, released };
}

describe('runReadOnly on the analyst login', () => {
  it('runs as analyst_login without SET ROLE; read-only txn, all limits via SET LOCAL; reuses connection on success', async () => {
    const f = fakePool();
    const res = await runReadOnly('SELECT id, name FROM teams');
    assert.equal(res.rowCount, 1);
    assert.equal((res.rows[0].name as string).length, 401); // 400 chars + ellipsis: truncation preserved
    const all = f.calls.map((c) => c.sql).join('\n');
    assert.ok(!/SET (LOCAL )?ROLE/i.test(all), 'must not SET ROLE');
    const setup = f.calls[0].sql;
    for (const frag of ['BEGIN READ ONLY', 'statement_timeout = 8000', 'lock_timeout = 2000', 'idle_in_transaction_session_timeout = 10000', 'search_path = pg_catalog, public', 'current_user']) assert.ok(setup.includes(frag), frag);
    assert.match(f.calls.at(-1)!.sql, /^ROLLBACK TO SAVEPOINT analyst_q; SELECT pg_advisory_unlock_all\(\); ROLLBACK$/);
    assert.deepEqual(f.released, [false]);
  });
  it('keeps the 200-row cap wrapper', async () => {
    const f = fakePool();
    await runReadOnly('SELECT id FROM teams');
    assert.ok(f.calls.some((c) => c.sql.includes('LIMIT 201')));
  });
  it('trusted reports use the same pool and checks', async () => {
    const f = fakePool();
    await runReadOnly('SELECT id, name FROM teams', [], true);
    assert.ok(f.calls[0].sql.startsWith('BEGIN READ ONLY'));
  });
  for (const [name, identity] of Object.entries({
    'wrong user (neondb_owner)': { u: 'neondb_owner', s: 'neondb_owner', su: 'off', ro: 'on' },
    'role switched after login': { u: 'analyst_ro', s: 'analyst_login', su: 'off', ro: 'on' },
    'superuser': { u: 'analyst_login', s: 'analyst_login', su: 'on', ro: 'on' },
    'not read-only': { u: 'analyst_login', s: 'analyst_login', su: 'off', ro: 'off' },
  })) {
    it(`refuses to run SQL on a bad identity: ${name}`, async () => {
      const f = fakePool({ identity });
      await assert.rejects(() => runReadOnly('SELECT id FROM teams'), (e) => e instanceof SqlGuardError && /identity/.test(e.message));
      assert.ok(!f.calls.some((c) => c.sql.startsWith('EXPLAIN') || c.sql.startsWith('SELECT * FROM')), 'no user SQL executed');
      assert.deepEqual(f.released, [true]); // wrong-identity connection is destroyed, not reused
    });
  }
  it('rejects tables outside the allowlist found by EXPLAIN, then cleans up and reuses the connection', async () => {
    const f = fakePool();
    const client = await (globalThis as unknown as { analystPool: { connect(): Promise<{ query: (s: string) => Promise<unknown> }> } }).analystPool.connect();
    const orig = client.query.bind(client);
    client.query = async (s: string) => (s.startsWith('EXPLAIN') ? { rows: [{ 'QUERY PLAN': [{ Plan: { 'Relation Name': 'users' } }] }], fields: [] } : orig(s));
    await assert.rejects(() => runReadOnly('SELECT id FROM teams'), /Table not allowed: users/);
    assert.deepEqual(f.released, [false]);
  });
  it('translates permission errors, still cleans up, and reuses the connection (server-side error)', async () => {
    const f = fakePool({ failOn: /^SELECT \* FROM/, failWith: { code: '42501' } });
    await assert.rejects(() => runReadOnly('SELECT id FROM teams'), (e) => e instanceof SqlGuardError && /not available to the analyst/.test(e.message));
    assert.match(f.calls.at(-1)!.sql, /^ROLLBACK TO SAVEPOINT/);
    assert.deepEqual(f.released, [false]);
  });
  it('statement timeout (57014) is a server-side error: cleaned up and reused', async () => {
    const f = fakePool({ failOn: /^SELECT \* FROM/, failWith: { code: '57014' } });
    await assert.rejects(() => runReadOnly('SELECT id FROM teams'), /boom/);
    assert.deepEqual(f.released, [false]);
  });
  it('client-side failure (socket reset / query_timeout) destroys the connection', async () => {
    const f = fakePool({ failOn: /^SELECT \* FROM/, failWith: { code: 'ECONNRESET' } });
    await assert.rejects(() => runReadOnly('SELECT id FROM teams'));
    assert.deepEqual(f.released, [true]);
    const g = fakePool({ failOn: /^SELECT \* FROM/, failWith: {} }); // e.g. pg "Query read timeout" has no SQLSTATE
    await assert.rejects(() => runReadOnly('SELECT id FROM teams'));
    assert.deepEqual(g.released, [true]);
  });
  it('failed cleanup destroys the connection (and attempts a plain ROLLBACK)', async () => {
    const f = fakePool({ cleanupFails: true });
    await runReadOnly('SELECT id FROM teams');
    assert.deepEqual(f.released, [true]);
    assert.equal(f.calls.at(-1)!.sql, 'ROLLBACK');
  });
  it('login failures are translated into an actionable message', async () => {
    (globalThis as unknown as { analystPool: unknown }).analystPool = {
      async connect() { throw Object.assign(new Error('password authentication failed'), { code: '28P01' }); }, options: {}, on() {}, async end() {},
    };
    await assert.rejects(() => runReadOnly('SELECT id FROM teams'), (e) => e instanceof SqlGuardError && /ANALYST_DATABASE_URL/.test(e.message) && !/password authentication/.test(e.message));
  });
});
