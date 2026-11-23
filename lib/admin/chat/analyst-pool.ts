import 'server-only';
/**
 * Dedicated connection pool for analyst (NL2SQL) queries.
 *
 * Connects as the `analyst_login` database role via ANALYST_DATABASE_URL. It is deliberately separate from the
 * application pool (lib/team/db.ts): a slow or abusive analyst query can only ever occupy these (max 2) connections,
 * never the app's. There is NO fallback to DATABASE_URL — a missing or wrong URL fails closed with a config error.
 */
import pg from 'pg';
import { SqlGuardError } from './sql-ast';

export const ANALYST_LOGIN_ROLE = 'analyst_login';
export const ANALYST_POOL_MAX = 2;

/** Configuration problem (missing / wrong analyst connection). Message is safe to show; it never contains credentials. */
export class AnalystConfigError extends SqlGuardError {}

const g = globalThis as unknown as { analystPool?: pg.Pool };

export function getAnalystPool(): pg.Pool {
  if (g.analystPool) return g.analystPool;
  const raw = process.env.ANALYST_DATABASE_URL?.trim();
  if (!raw) {
    throw new AnalystConfigError(
      'The analyst database connection is not configured. An administrator must set ANALYST_DATABASE_URL (see npm run db:analyst-login).',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AnalystConfigError('ANALYST_DATABASE_URL is not a valid connection string.');
  }
  if (/[<>]/.test(raw) || /%3C|%3E/i.test(raw)) {
    throw new AnalystConfigError('ANALYST_DATABASE_URL still contains template placeholders (<...>); fill in the real password and database name.');
  }
  // Refuse to run analyst SQL over any identity other than analyst_login (e.g. someone pasting DATABASE_URL here).
  if (decodeURIComponent(parsed.username) !== ANALYST_LOGIN_ROLE) {
    throw new AnalystConfigError(`ANALYST_DATABASE_URL must connect as the "${ANALYST_LOGIN_ROLE}" role.`);
  }
  parsed.searchParams.delete('sslmode');
  const pool = new pg.Pool({
    connectionString: parsed.toString(),
    ssl: { rejectUnauthorized: false },
    max: ANALYST_POOL_MAX,
    connectionTimeoutMillis: 10000, // fail fast; the role is limited to 3 connections
    idleTimeoutMillis: 10000,
    query_timeout: 15000, // client-side backstop above the 8 s server-side statement_timeout
    keepAlive: true,
  });
  pool.on('error', (err) => {
    console.error('[analyst pool] idle client error (connection will be replaced):', err.message);
  });
  g.analystPool = pool;
  return pool;
}

/** Test helper: drop the cached pool (and end it if real). */
export async function resetAnalystPool(): Promise<void> {
  const p = g.analystPool;
  g.analystPool = undefined;
  if (p && typeof p.end === 'function') await p.end().catch(() => {});
}
