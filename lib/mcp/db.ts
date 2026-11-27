/**
 * Dedicated connection pool for the OAuth/authorization layer. Uses ONLY MCP_AUTH_DATABASE_URL (the `mcp_auth` role, scripts/setup-mcp-roles.mjs).
 * Never DATABASE_URL (owner) and never ANALYST_DATABASE_URL. Fails CLOSED: missing/invalid configuration throws McpDbUnavailable; there is no fallback.
 *
 * Pooled Neon endpoints (PgBouncer) may ignore role-level SET defaults, so every unit of work runs in a transaction that applies its limits
 * with set_config(..., is_local => true) (the SET LOCAL equivalent). Repositories take the Pool and call withMcpTx themselves.
 */
import pg from 'pg';

export type McpPool = pg.Pool;
export type McpTx = pg.PoolClient;

export class McpDbUnavailable extends Error {
  constructor(reason: string) { super(`MCP auth database unavailable: ${reason}`); this.name = 'McpDbUnavailable'; }
}

export const MCP_AUTH_ROLE = 'mcp_auth';
const LIMITS = { statement_timeout: '5000', lock_timeout: '2000', idle_in_transaction_session_timeout: '10000', search_path: 'pg_catalog, public' } as const;

/** Validate the URL (pure; exported for tests). Returns the sanitized connection string. */
export function validateMcpAuthUrl(raw: string | undefined): string {
  if (!raw?.trim()) throw new McpDbUnavailable('MCP_AUTH_DATABASE_URL is not set');
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new McpDbUnavailable('MCP_AUTH_DATABASE_URL is not a valid connection string'); }
  if (u.protocol !== 'postgresql:' && u.protocol !== 'postgres:') throw new McpDbUnavailable('MCP_AUTH_DATABASE_URL must be a postgres URL');
  if (decodeURIComponent(u.username) !== MCP_AUTH_ROLE) throw new McpDbUnavailable(`MCP_AUTH_DATABASE_URL must connect as ${MCP_AUTH_ROLE}`);
  u.searchParams.delete('sslmode');
  return u.toString();
}

const g = globalThis as unknown as { __mcpAuthPool?: pg.Pool };

/** Lazily created singleton. Throws McpDbUnavailable if the credential is missing or is not the mcp_auth role. */
export function getMcpPool(): McpPool {
  if (!g.__mcpAuthPool) {
    const url = validateMcpAuthUrl(process.env.MCP_AUTH_DATABASE_URL);
    g.__mcpAuthPool = createMcpPool(url);
  }
  return g.__mcpAuthPool;
}

/** Explicit constructor (tests pass the test-branch URL). max 3 keeps well under the role's CONNECTION LIMIT 5. */
export function createMcpPool(sanitizedUrl: string): McpPool {
  const pool = new pg.Pool({ connectionString: sanitizedUrl, ssl: { rejectUnauthorized: true }, max: 3, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 5_000 });
  pool.on('error', () => { /* idle client errors must not crash the process; the next query reconnects */ });
  return pool;
}

/** Run `fn` in one transaction with the role limits applied locally. Commits on success, rolls back (and rethrows) on any error. */
export async function withMcpTx<T>(pool: McpPool, fn: (tx: McpTx) => Promise<T>): Promise<T> {
  let client: McpTx;
  try { client = await pool.connect(); } catch { throw new McpDbUnavailable('could not connect'); }
  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT set_config($1, $2, true), set_config($3, $4, true), set_config($5, $6, true), set_config($7, $8, true)',
      ['statement_timeout', LIMITS.statement_timeout, 'lock_timeout', LIMITS.lock_timeout,
        'idle_in_transaction_session_timeout', LIMITS.idle_in_transaction_session_timeout, 'search_path', LIMITS.search_path]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
