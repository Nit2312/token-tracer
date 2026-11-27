/**
 * The explicit MCP grant for "All teams" admins: a row in mcp_all_teams_admins. Kept apart from mcp-revoke.ts, which must stay a pure revoker.
 */
import { query, type Queryable } from './db';

const appDb: Queryable = { query: (text, params) => query(text, params ?? []) };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Marks (or unmarks) an admin as an "All teams" admin for MCP: a row in mcp_all_teams_admins, the explicit grant that lets an admin with no team
 * use MCP across teams. Called when an admin is saved with "All teams" (enabled = true) and whenever an admin is saved any other way or
 * changes role (enabled = false). Before the MCP migration exists the table is absent and this does nothing, quietly, like the revoke helper.
 */
export async function setMcpAllTeamsAdmin(userId: string, enabled: boolean, db: Queryable = appDb): Promise<void> {
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) return;
  const { rows } = await db.query<{ t: string | null }>("SELECT to_regclass('public.mcp_all_teams_admins') AS t", []);
  if (!rows[0]?.t) return;
  if (enabled) await db.query('INSERT INTO mcp_all_teams_admins (user_id) VALUES ($1::uuid) ON CONFLICT (user_id) DO NOTHING', [userId]);
  else await db.query('DELETE FROM mcp_all_teams_admins WHERE user_id = $1::uuid', [userId]);
}
