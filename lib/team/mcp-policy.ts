/**
 * Tables that must NEVER be exposed through the MCP server (any role), whatever database role it uses.
 * - redundant_reprompt_events: derived analytics; legacy rows have NULL owner columns (could not be attributed) and the table
 *   has no prompt-level authorization model.
 * - session_outcomes_unattributed: quarantine of ambiguous / orphan rows from the tenant-isolation migration.
 * Any MCP table allowlist or database grant must be checked against this list (see tests/tenant-isolation-policy.test.ts).
 */
export const MCP_EXCLUDED_TABLES: readonly string[] = ['redundant_reprompt_events', 'session_outcomes_unattributed'];

export function isMcpTableAllowed(table: string): boolean {
  return !MCP_EXCLUDED_TABLES.includes(table.toLowerCase());
}
