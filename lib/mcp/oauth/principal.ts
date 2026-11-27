/** The authenticated identity behind an access token. Always re-derived from the database per request; never from client input. */
export interface McpPrincipal {
  userId: string; clientId: string; tokenId: string; scope: string;
  role: 'user' | 'admin' | 'superadmin'; teamId: string | null; displayName: string;
  tokenHash?: Uint8Array;
}

/**
 * Phase-3 eligibility rule (decided): only DATABASE-backed accounts reach this point (the built-in env accounts have no users row, so they can
 * never hold a token), and only role 'admin' with a team qualifies. superadmin is deliberately excluded from team data access.
 */
export const isTeamAdmin = (p: McpPrincipal): boolean => p.role === 'admin' && p.teamId !== null;
/** An "All teams" admin: role admin and no team. Only ever reaches this point if the database also lists them in mcp_all_teams_admins (see ELIGIBLE_USER_SQL). */
export const isAllTeamsAdmin = (p: McpPrincipal): boolean => p.role === 'admin' && p.teamId === null;

/** What every tool call receives: an admin with a team, or an All-teams admin (teamId null). Both facts re-read from the database for THIS request. */
export type TeamAdminPrincipal = McpPrincipal & { role: 'admin'; teamId: string | null; tokenHash: Uint8Array };
export const asTeamAdmin = (p: McpPrincipal): TeamAdminPrincipal | null => {
  if (!isTeamAdmin(p) && !isAllTeamsAdmin(p)) return null;
  const hash = p.tokenHash instanceof Uint8Array && p.tokenHash.byteLength === 32 ? p.tokenHash : new Uint8Array(32);
  return {
    ...p,
    role: 'admin',
    teamId: p.teamId,
    tokenHash: hash,
  };
};
