/**
 * The ONLY way a test may obtain a database connection. Safety rules, enforced here:
 *  - A test database must be given explicitly through TEST_DATABASE_URL (owner-level, DIRECT/non-pooled) or
 *    TEST_ANALYST_DATABASE_URL (the analyst_login URL of the same test branch; pooled allowed) — nothing else is ever used.
 *  - TEST_DATABASE_EXPECTED_ENDPOINT (e.g. ep-xxxx-xxxx-xxxxxxxx) is required and must equal the URL's endpoint id.
 *  - The test URL must not point at the same endpoint as a DATABASE_URL / NEON_CONNECTION_STRING / ANALYST_DATABASE_URL that happens
 *    to be present in the process environment (i.e. someone loaded production settings into the shell).
 *  - No file is ever read: there is no .env / .env.local fallback anywhere in the tests.
 *  - Missing or invalid configuration THROWS with a clear message (the test file fails immediately). The only way to skip the database
 *    tests is the explicit opt-out SKIP_DB_TESTS=1.
 *  - Env files are unreadable in any test process that imports this module: fs.readFileSync / fs.readFile / fs.promises.readFile throw
 *    ENOENT for any path whose file name starts with ".env". lib/team/env.ts (which would otherwise load .env.local) therefore loads
 *    nothing. This is a guard against accidental reads, not a sandbox.
 *  - Tripwire: importing this module replaces DATABASE_URL, NEON_CONNECTION_STRING and ANALYST_DATABASE_URL in this test process with an
 *    unreachable placeholder, so application code (lib/team/env.ts would otherwise load .env.local) can never reach a real database by
 *    accident, and SESSION_SECRET with a test-only value so no production secret is used to sign test cookies.
 * Setup instructions: tests/README.md.
 */

import fs from 'node:fs';
import path from 'node:path';

const PRODUCTION_ENV_NAMES = ['DATABASE_URL', 'NEON_CONNECTION_STRING', 'ANALYST_DATABASE_URL'] as const;
export const BLOCKED_URL = 'postgresql://blocked:blocked@invalid.invalid:5432/blocked';
export const TEST_SESSION_SECRET = 'test-only-session-secret-not-used-anywhere-else';

/** What the surrounding environment held BEFORE the tripwire replaced it (used only to refuse a colliding test URL). */
const ORIGINAL_ENV: Record<string, string | undefined> = Object.fromEntries(PRODUCTION_ENV_NAMES.map((k) => [k, process.env[k]]));
for (const k of PRODUCTION_ENV_NAMES) process.env[k] = BLOCKED_URL;
process.env.SESSION_SECRET = TEST_SESSION_SECRET;

// ---- env-file read blocker -------------------------------------------------------------------------------------------------
const ENV_PREFIX = '.' + 'env'; // built from parts so test sources never contain an env-file literal
/** Every blocked attempt (basename only), so tests can prove the guard was exercised. */
export const blockedEnvReads: string[] = [];
function isEnvFile(target: unknown): boolean {
  if (typeof target !== 'string' && !(target instanceof URL) && !Buffer.isBuffer(target)) return false;
  const name = path.basename(target instanceof URL ? target.pathname : String(target));
  return name === ENV_PREFIX || name.startsWith(ENV_PREFIX + '.');
}
function blocked(target: unknown): NodeJS.ErrnoException {
  blockedEnvReads.push(path.basename(String(target)));
  const err = new Error(`ENOENT: env files are blocked in tests (${path.basename(String(target))})`) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}
const realReadFileSync = fs.readFileSync;
const realReadFile = fs.readFile;
const realPromisesReadFile = fs.promises.readFile;
fs.readFileSync = ((target: unknown, ...rest: unknown[]) => {
  if (isEnvFile(target)) throw blocked(target);
  return (realReadFileSync as (...a: unknown[]) => unknown).call(fs, target, ...rest);
}) as typeof fs.readFileSync;
fs.readFile = ((target: unknown, ...rest: unknown[]) => {
  if (isEnvFile(target)) { const cb = rest[rest.length - 1] as (e: Error) => void; return void process.nextTick(cb, blocked(target)); }
  return (realReadFile as (...a: unknown[]) => unknown).call(fs, target, ...rest);
}) as typeof fs.readFile;
fs.promises.readFile = (async (target: unknown, ...rest: unknown[]) => {
  if (isEnvFile(target)) throw blocked(target);
  return (realPromisesReadFile as (...a: unknown[]) => unknown).call(fs.promises, target, ...rest);
}) as typeof fs.promises.readFile;

export const SKIP_DB = process.env.SKIP_DB_TESTS === '1';
export const SKIP_REASON = 'SKIP_DB_TESTS=1 (database tests deliberately skipped)';

export class TestDbConfigError extends Error {
  constructor(message: string) { super(`[test database configuration] ${message}\nSee tests/README.md. Set SKIP_DB_TESTS=1 only to skip the database tests on purpose.`); }
}

export interface TestDb { url: string; endpoint: string; pooled: boolean }

function endpointOf(url: string): string | null {
  try { return new URL(url).hostname.split('.')[0].replace(/-pooler$/, ''); } catch { return null; }
}

export function loadTestDb(
  kind: 'owner' | 'analyst',
  env: Record<string, string | undefined> = process.env,
  originals: Record<string, string | undefined> = ORIGINAL_ENV,
): TestDb {
  const varName = kind === 'owner' ? 'TEST_DATABASE_URL' : 'TEST_ANALYST_DATABASE_URL';
  const raw = env[varName]?.trim();
  if (!raw) throw new TestDbConfigError(`${varName} is not set. Database tests only run against an explicitly provided test branch.`);
  const expected = env.TEST_DATABASE_EXPECTED_ENDPOINT?.trim();
  if (!expected) throw new TestDbConfigError('TEST_DATABASE_EXPECTED_ENDPOINT is not set (the endpoint id of the test branch, e.g. ep-xxxx-xxxx-xxxxxxxx).');
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new TestDbConfigError(`${varName} is not a valid connection string.`); }
  if (/[<>]/.test(raw) || /%3C|%3E/i.test(raw)) throw new TestDbConfigError(`${varName} still contains template placeholders.`);
  const endpoint = endpointOf(raw)!;
  if (endpoint !== expected) throw new TestDbConfigError(`${varName} points at endpoint "${endpoint}", expected "${expected}". Refusing to connect.`);
  for (const name of PRODUCTION_ENV_NAMES) {
    const other = originals[name];
    if (other && endpointOf(other) === endpoint) {
      throw new TestDbConfigError(`${varName} points at the same endpoint as ${name} in the process environment — that is not a test database. Refusing to connect.`);
    }
  }
  const pooled = /-pooler\./.test(parsed.hostname);
  const user = decodeURIComponent(parsed.username);
  if (kind === 'owner' && pooled) throw new TestDbConfigError(`${varName} must be a DIRECT (non-pooled) connection string.`);
  if (kind === 'owner' && user === 'analyst_login') throw new TestDbConfigError(`${varName} must be the owner-level test login, not analyst_login.`);
  if (kind === 'analyst' && user !== 'analyst_login') throw new TestDbConfigError(`${varName} must connect as the analyst_login role.`);
  return { url: raw, endpoint, pooled };
}

/** Connection string for node-postgres: `sslmode` is handled through the explicit `ssl` option instead. */
export function connectionString(db: TestDb): string {
  const u = new URL(db.url);
  u.searchParams.delete('sslmode');
  return u.toString();
}
