/**
 * Dedicated connection pool for the MCP data plane.
 * Connects ONLY via MCP_READER_DATABASE_URL as the `mcp_reader` role.
 * Never reuses DATABASE_URL, ANALYST_DATABASE_URL or MCP_AUTH_DATABASE_URL.
 * Fails closed: missing/invalid configuration throws DataError('unavailable').
 *
 * Connection pool respects the mcp_reader CONNECTION LIMIT of 5 (pool max: 3).
 * Every transaction runs with read-only transaction mode and hard timeouts
 * applied locally via set_config:
 *   - statement_timeout = 5000ms
 *   - lock_timeout = 2000ms
 *   - idle_in_transaction_session_timeout = 10000ms
 *   - search_path = 'pg_catalog, pg_temp'
 *   - default_transaction_read_only = on
 */
import pg from 'pg';
import { dataError, isDataError, type DataError } from './errors';

export const MCP_READER_ROLE = 'mcp_reader';

const LIMITS = {
  statement_timeout: '5000',
  lock_timeout: '2000',
  idle_in_transaction_session_timeout: '10000',
  search_path: 'pg_catalog, pg_temp',
  default_transaction_read_only: 'on',
} as const;

export function validateMcpReaderUrl(raw: string | undefined): string {
  if (!raw?.trim()) throw dataError('unavailable');
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw dataError('unavailable');
  }
  if (u.protocol !== 'postgresql:' && u.protocol !== 'postgres:') throw dataError('unavailable');
  if (decodeURIComponent(u.username) !== MCP_READER_ROLE) throw dataError('unavailable');
  u.searchParams.delete('sslmode');
  return u.toString();
}

const g = globalThis as unknown as { __mcpReaderPool?: pg.Pool };

/**
 * Creates an isolated pool for the reader role.
 * Max 3 connections keeps well within the role's CONNECTION LIMIT of 5.
 */
export function createReaderPool(sanitizedUrl: string, opts?: { max?: number }): pg.Pool {
  const u = new URL(sanitizedUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  const pool = new pg.Pool({
    connectionString: sanitizedUrl,
    ssl: local ? false : { rejectUnauthorized: true },
    max: opts?.max ?? 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  });
  pool.on('error', () => {
    // Idle client errors must not crash the process; pool will reconnect on demand.
  });
  return pool;
}

export function getReaderPool(): pg.Pool {
  if (!g.__mcpReaderPool) {
    const url = validateMcpReaderUrl(process.env.MCP_READER_DATABASE_URL);
    g.__mcpReaderPool = createReaderPool(url);
  }
  return g.__mcpReaderPool;
}

export async function closeReaderPool(): Promise<void> {
  if (g.__mcpReaderPool) {
    const p = g.__mcpReaderPool;
    g.__mcpReaderPool = undefined;
    await p.end().catch(() => {});
  }
}

/**
 * Translates PostgreSQL errors from mcp_data functions into fixed DataError instances.
 * Never leaks database column names, raw messages, or stack traces.
 */
export function translatePgError(e: unknown): DataError {
  if (isDataError(e)) return e;
  const pgErr = e as { code?: string; message?: string };
  const code = pgErr?.code;
  const msg = pgErr?.message ?? '';

  if (code === '54000') return dataError('limit_exceeded');
  if (code === 'P0002') return dataError('not_found');
  if (code === '28000') return dataError('not_found'); // unauthenticated / invalid token mapped to not_found
  if (code === '22023') {
    if (msg.includes('window_too_large')) return dataError('window_too_large');
    if (msg.includes('window_out_of_range')) return dataError('window_out_of_range');
    if (msg.includes('not_found')) return dataError('not_found');
    if (msg.includes('team_required')) return dataError('team_required');
    return dataError('invalid_argument');
  }
  if (code === '57014' || code === '42501' || code === '08006' || code === '08001') {
    return dataError('unavailable');
  }
  return dataError('internal');
}

/**
 * Executes a callback inside a read-only transaction on the reader connection pool.
 * Applies strict session-local timeouts, search path and read-only mode.
 */
export async function withReaderTx<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch {
    throw dataError('unavailable');
  }
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(
      'SELECT set_config($1, $2, true), set_config($3, $4, true), set_config($5, $6, true), set_config($7, $8, true), set_config($9, $10, true)',
      [
        'statement_timeout', LIMITS.statement_timeout,
        'lock_timeout', LIMITS.lock_timeout,
        'idle_in_transaction_session_timeout', LIMITS.idle_in_transaction_session_timeout,
        'search_path', LIMITS.search_path,
        'default_transaction_read_only', LIMITS.default_transaction_read_only,
      ],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw translatePgError(err);
  } finally {
    client.release();
  }
}
