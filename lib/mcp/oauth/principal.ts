/** The authenticated identity behind an access token. Always re-derived from the database per request; never from client input. */
export interface McpPrincipal {
  userId: string; clientId: string; tokenId: string; scope: string;
  role: 'user' | 'admin' | 'superadmin'; teamId: string | null; displayName: string;
}

/**
 * Phase-3 eligibility rule (decided): only DATABASE-backed accounts reach this point (the built-in env accounts have no users row, so they can
 * never hold a token), and only role 'admin' with a team qualifies. superadmin is deliberately excluded from team data access.
 */
export const isTeamAdmin = (p: McpPrincipal): boolean => p.role === 'admin' && p.teamId !== null;
