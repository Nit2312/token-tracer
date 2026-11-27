/**
 * Developer daily activity data service (P3-5).
 * Invokes `mcp_data.developer_activity(p_token, p_member, p_from, p_to)` via reader pool.
 */
import type pg from 'pg';
import { withReaderTx } from './db';
import { assertMetadataOnly, toDailyActivity, type DailyActivity } from './output';
import { parseDeveloperActivityRequest, type DeveloperActivityRequest } from './requests';
import { assertScope, scopeDbArgs, type DataScope } from './scope';

export interface ActivityServicesConfig {
  readonly pool: pg.Pool;
  readonly scope: DataScope;
}

export async function getDeveloperActivity(
  config: ActivityServicesConfig,
  input: unknown,
  now?: Date
): Promise<readonly DailyActivity[]> {
  assertScope(config.scope);
  const req: DeveloperActivityRequest = parseDeveloperActivityRequest(input, now);
  const { tokenHash, teamId } = scopeDbArgs(config.scope);

  const rows = await withReaderTx(config.pool, async (client) => {
    const res = await client.query(
      `SELECT day, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, api_cost, session_count,
              tool_calls, tool_errors, edits, additions, deletions, changed_lines, files_touched,
              rework_loops, corrections, abandoned_count,
              sessions_started_earlier, tokens_in_sessions_started_earlier, unpriced_sessions
         FROM mcp_data.developer_activity($1, $2, $3, $4, $5)`,
      [tokenHash, req.developerId, req.window.from.toISOString(), req.window.to.toISOString(), teamId]
    );
    return res.rows;
  });

  const items = rows.map(toDailyActivity);
  assertMetadataOnly(items);
  return items;
}
