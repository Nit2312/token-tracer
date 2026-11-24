/**
 * Guards the test-database safety rules (tests/README.md). Needs NO database: it inspects the test sources, unit-tests the
 * configuration helper, checks the credential tripwire, and runs the database suites as child processes with missing or
 * wrong configuration to prove they FAIL (never connect, never skip silently).
 */
import { BLOCKED_URL, TEST_SESSION_SECRET, blockedEnvReads, loadTestDb, TestDbConfigError } from './helpers/test-db'; // FIRST: installs the tripwire
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { databaseUrl } from '../lib/team/env';
import { sessionSecret } from '../lib/team/env';

const SELF = path.basename(__filename);
const testDir = path.join(process.cwd(), 'tests');
const sources = [
  ...fs.readdirSync(testDir).filter((f) => f.endsWith('.ts') && f !== SELF).map((f) => path.join(testDir, f)),
  ...fs.readdirSync(path.join(testDir, 'helpers')).map((f) => path.join(testDir, 'helpers', f)),
];
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const DB_SUITES = ['analyst-db', 'analyst-login-db', 'session-turns-isolation', 'tenant-isolation-phase2', 'rollup-concurrency', 'mcp-oauth-db', 'mcp-oauth-data', 'mcp-oauth-endpoints', 'mcp-oauth-authorize'].map((n) => `tests/${n}.test.ts`);

describe('no test can fall back to an env file or to production variables', () => {
  it('no test or helper source contains a string literal that names an env file', () => {
    const envFileLiteral = new RegExp('[\'"`][^\'"`\\n]*\\.' + 'env' + '[^\'"`\\n]*[\'"`]');
    for (const f of sources) {
      const code = stripComments(fs.readFileSync(f, 'utf8'));
      assert.doesNotMatch(code, envFileLiteral, `${path.basename(f)} references an env file`);
    }
  });
  it('database test files obtain their connection only through the helper, never from DATABASE_URL / NEON_CONNECTION_STRING / ANALYST_DATABASE_URL', () => {
    const prod = /process\.env\.(DATABASE_URL|NEON_CONNECTION_STRING|ANALYST_DATABASE_URL)\b/;
    const dbFiles = sources.filter((f) => /new pg\.(Client|Pool)\(/.test(fs.readFileSync(f, 'utf8')) && f.endsWith('.test.ts'));
    assert.deepEqual(dbFiles.map((f) => path.basename(f)).sort(), DB_SUITES.map((f) => path.basename(f)).sort()); // every DB suite is covered by this guard
    for (const f of dbFiles) {
      const code = stripComments(fs.readFileSync(f, 'utf8'));
      assert.doesNotMatch(code, prod, `${path.basename(f)} reads a production variable`);
      assert.match(code, /from '\.\/helpers\/test-db'/, `${path.basename(f)} does not use the helper`);
      assert.match(code, /loadTestDb\(/, `${path.basename(f)} does not call loadTestDb`);
    }
  });
  it('env files are unreadable in a test process: reads are refused (ENOENT) and recorded', async () => {
    const target = '.' + 'env' + '.local';
    assert.throws(() => fs.readFileSync(target, 'utf8'), (e: NodeJS.ErrnoException) => e.code === 'ENOENT' && /blocked in tests/.test(e.message));
    await assert.rejects(() => fs.promises.readFile(target), (e: NodeJS.ErrnoException) => e.code === 'ENOENT');
    await new Promise<void>((resolve) => fs.readFile(target, (e) => { assert.equal(e?.code, 'ENOENT'); resolve(); }));
    assert.ok(blockedEnvReads.length >= 3);
    assert.ok(blockedEnvReads.every((n) => n.startsWith('.' + 'env')));
    assert.doesNotThrow(() => fs.readFileSync('package.json', 'utf8')); // ordinary files still work
  });
});

describe('credential tripwire (importing the helper neutralizes production settings)', () => {
  it('replaces the database variables with an unreachable placeholder and the session secret with a test value', () => {
    for (const k of ['DATABASE_URL', 'NEON_CONNECTION_STRING', 'ANALYST_DATABASE_URL']) assert.equal(process.env[k], BLOCKED_URL);
    assert.equal(process.env.SESSION_SECRET, TEST_SESSION_SECRET);
  });
  it('application code that loads .env.local still gets the placeholder, not the real database or secret', () => {
    // lib/team/env.ts would otherwise fill DATABASE_URL / SESSION_SECRET from .env.local; they are already set, so it never does.
    assert.equal(new URL(databaseUrl()!).hostname, 'invalid.invalid');
    assert.equal(sessionSecret(), TEST_SESSION_SECRET);
    // the library DID try to read the env file — and was refused, so nothing from it (secrets, ENABLE_REPROMPT_ANALYSIS_ORG_ID, …) was loaded
    assert.ok(blockedEnvReads.length >= 1);
  });
});

describe('loadTestDb configuration rules (pure, injected environment)', () => {
  const good = { TEST_DATABASE_URL: 'postgresql://neondb_owner:pw-secret-123@ep-test-branch-aaaa1111.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require', TEST_DATABASE_EXPECTED_ENDPOINT: 'ep-test-branch-aaaa1111' };
  const refuse = (env: Record<string, string | undefined>, re: RegExp, kind: 'owner' | 'analyst' = 'owner', originals: Record<string, string | undefined> = {}) =>
    assert.throws(() => loadTestDb(kind, env, originals), (e) => e instanceof TestDbConfigError && re.test(e.message) && !/pw-secret-123|secret/.test(e.message.replace('SKIP_DB_TESTS', '')));

  it('accepts a correct direct URL for the expected endpoint', () => {
    const db = loadTestDb('owner', good, {});
    assert.equal(db.endpoint, 'ep-test-branch-aaaa1111'); assert.equal(db.pooled, false);
  });
  it('fails with a clear message when the URL, the expected endpoint, or either is missing', () => {
    refuse({}, /TEST_DATABASE_URL is not set/);
    refuse({ TEST_DATABASE_URL: good.TEST_DATABASE_URL }, /TEST_DATABASE_EXPECTED_ENDPOINT is not set/);
    refuse({ TEST_DATABASE_EXPECTED_ENDPOINT: 'ep-x' }, /TEST_DATABASE_URL is not set/);
    refuse({ DATABASE_URL: good.TEST_DATABASE_URL, TEST_DATABASE_EXPECTED_ENDPOINT: 'ep-test-branch-aaaa1111' }, /TEST_DATABASE_URL is not set/); // DATABASE_URL is never a substitute
  });
  it('refuses a mismatching endpoint, a pooled owner URL, placeholders and garbage', () => {
    refuse({ ...good, TEST_DATABASE_EXPECTED_ENDPOINT: 'ep-someone-else-bbbb2222' }, /expected "ep-someone-else-bbbb2222"/);
    refuse({ ...good, TEST_DATABASE_URL: good.TEST_DATABASE_URL.replace('ep-test-branch-aaaa1111', 'ep-test-branch-aaaa1111-pooler') }, /DIRECT/);
    refuse({ ...good, TEST_DATABASE_URL: 'postgresql://u:<PASSWORD>@ep-test-branch-aaaa1111.c-3.x.neon.tech/db' }, /placeholders/);
    refuse({ ...good, TEST_DATABASE_URL: 'not a url' }, /not a valid connection string/);
  });
  it('refuses a test URL that is the same endpoint as a production variable present in the environment', () => {
    for (const name of ['DATABASE_URL', 'NEON_CONNECTION_STRING', 'ANALYST_DATABASE_URL']) {
      refuse(good, new RegExp(`same endpoint as ${name}`), 'owner', { [name]: 'postgresql://x:y@ep-test-branch-aaaa1111-pooler.c-3.ap-southeast-1.aws.neon.tech/neondb' });
    }
    assert.ok(loadTestDb('owner', good, { DATABASE_URL: 'postgresql://x:y@ep-prod-cccc3333.c-3.ap-southeast-1.aws.neon.tech/neondb' })); // a different production endpoint is fine
  });
  it('analyst kind: requires the analyst_login role and allows a pooled URL; owner kind refuses analyst_login', () => {
    const analyst = { TEST_ANALYST_DATABASE_URL: 'postgresql://analyst_login:pw-secret-123@ep-test-branch-aaaa1111-pooler.c-3.x.neon.tech/neondb', TEST_DATABASE_EXPECTED_ENDPOINT: 'ep-test-branch-aaaa1111' };
    assert.equal(loadTestDb('analyst', analyst, {}).pooled, true);
    refuse({ ...analyst, TEST_ANALYST_DATABASE_URL: analyst.TEST_ANALYST_DATABASE_URL.replace('analyst_login', 'neondb_owner') }, /analyst_login/, 'analyst');
    refuse({ ...good, TEST_DATABASE_URL: good.TEST_DATABASE_URL.replace('neondb_owner', 'analyst_login') }, /owner-level/);
  });
});

describe('the database suites fail safely (child processes, no database reachable or configured)', () => {
  const run = (file: string, extra: Record<string, string>) => spawnSync('node_modules/.bin/tsx', ['--test', file], {
    env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent', NODE_OPTIONS: '--conditions=react-server', ...extra } as unknown as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 90_000,
  });
  for (const file of DB_SUITES) {
    it(`${path.basename(file)} FAILS immediately with a clear message when no test database is configured`, () => {
      const r = run(file, {});
      const out = `${r.stdout}\n${r.stderr}`;
      assert.notEqual(r.status, 0);
      assert.match(out, /TEST_DATABASE_URL is not set|TEST_ANALYST_DATABASE_URL is not set/);
      assert.doesNotMatch(out, /# pass [1-9]|ℹ pass [1-9]/); // nothing "passed" by silently skipping
    });
  }
  it('SKIP_DB_TESTS=1 is the only way to skip, and it is reported as a skip', () => {
    const r = run('tests/analyst-db.test.ts', { SKIP_DB_TESTS: '1' });
    assert.equal(r.status, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /# SKIP_DB_TESTS=1 \(database tests deliberately skipped\)/); // the suite is reported as skipped, with the reason
  });
  it('a test URL on an unreachable/wrong endpoint is refused before any connection is attempted', () => {
    const r = run('tests/analyst-db.test.ts', { TEST_DATABASE_URL: 'postgresql://u:p@ep-wrong-dddd4444.c-3.ap-southeast-1.aws.neon.tech/neondb', TEST_DATABASE_EXPECTED_ENDPOINT: 'ep-expected-eeee5555' });
    assert.notEqual(r.status, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /expected "ep-expected-eeee5555"/);
  });
  it('a production-looking DATABASE_URL in the environment can never be used as the test database', () => {
    const same = 'postgresql://u:p@ep-collide-ffff6666.c-3.ap-southeast-1.aws.neon.tech/neondb';
    const r = run('tests/analyst-db.test.ts', { DATABASE_URL: same, TEST_DATABASE_URL: same, TEST_DATABASE_EXPECTED_ENDPOINT: 'ep-collide-ffff6666' });
    assert.notEqual(r.status, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /same endpoint as DATABASE_URL/);
  });
});
