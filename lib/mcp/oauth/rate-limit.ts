/** Fixed-window counters in mcp_rate_limits (one atomic upsert). `key` must already be a non-sensitive string, e.g. "register:<ip hash>". */
import { withMcpTx, type McpPool } from '../db';

export interface RateLimitResult { allowed: boolean; count: number; retryAfterSeconds: number }

export async function consumeRateLimit(pool: McpPool, key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  if (!key || key.length > 200 || !Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowSeconds) || windowSeconds < 1) throw new Error('invalid rate limit arguments');
  return withMcpTx(pool, async (tx) => {
    const r = await tx.query(
      `INSERT INTO mcp_rate_limits (key, window_start, count)
       VALUES ($1, to_timestamp(floor(extract(epoch FROM now()) / $2::numeric) * $2::numeric), 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = mcp_rate_limits.count + 1
       RETURNING count, GREATEST(1, ceil(extract(epoch FROM (window_start + make_interval(secs => $2::double precision) - now()))))::int AS retry`,
      [key, windowSeconds]);
    const count = r.rows[0].count as number;
    return { allowed: count <= limit, count, retryAfterSeconds: r.rows[0].retry as number };
  });
}
