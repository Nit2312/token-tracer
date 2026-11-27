/**
 * Teams the caller may act on. `mcp_data.list_teams(p_token)`: an "All teams" admin gets every team (name and member count), a team admin only their own.
 * Takes no arguments. Needs the token hash (not a DataScope): an All-teams admin has no team until they choose one from this list.
 */
import type pg from 'pg';
import { dataError } from './errors';
import { withReaderTx } from './db';
import { toTeamSummary, type TeamSummary } from './output';

export async function listTeams(
  config: { readonly pool: pg.Pool; readonly tokenHash: Uint8Array },
  input: unknown
): Promise<{ readonly items: readonly TeamSummary[] }> {
  if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input) || Object.keys(input as object).length > 0)) {
    throw dataError('invalid_argument');
  }
  if (!(config.tokenHash instanceof Uint8Array) || config.tokenHash.byteLength !== 32) throw dataError('internal');
  const rows = await withReaderTx(config.pool, async (client) => {
    const res = await client.query('SELECT team_id, name, member_count FROM mcp_data.list_teams($1)', [Buffer.from(config.tokenHash)]);
    return res.rows;
  });
  return { items: rows.map(toTeamSummary) };
}
