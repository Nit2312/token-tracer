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

/**
 * COLUMN policy (Phase 3, decisions 4 and 6 of MCP.md section 16). Checked by the static SQL guard of the data layer.
 *
 * NEVER exposed, in any mode, to any MCP role:
 *  - session file paths (decision 6) and anything path-like;
 *  - event payloads and session labels (they carry prompt and assistant text; the label is the first prompt, truncated);
 *  - the agent / project name (derived from working-directory names);
 *  - the payload hash (a fingerprint of the whole upload, including events).
 * TEXT-GATED: exposed only when prompt text is enabled AND approved (see lib/mcp/data/prompt-access.ts); never in metadata mode.
 */
export const MCP_NEVER_EXPOSED_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  sync_sessions: Object.freeze(['events', 'label', 'payload_hash', 'agent']),
  sync_session_files: Object.freeze(['path']),
  daily_member_files: Object.freeze(['path']),
  daily_member_usage: Object.freeze(['project']),
});

export const MCP_TEXT_GATED_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  session_turns: Object.freeze(['prompt_text_sanitized']),
});

/** Columns whose NAME marks them as secrets or credentials, in any table. */
const SECRET_COLUMN_RE = /(^|_)(password|passwd|secret|api_key|key_hash|token_hash|totp)(_|$)/i;
/** Path-like column names, in any table (decision 6). */
const PATH_COLUMN_RE = /^(?!has_)((path|paths|file_path|filepath|file_name|filename)$|.*_path$)/i; // `has_*` are boolean flags, never a path

export function isMcpColumnAllowed(table: string, column: string, opts: { promptText?: boolean } = {}): boolean {
  const t = table.toLowerCase();
  const c = column.toLowerCase();
  if (!isMcpTableAllowed(t)) return false;
  if (PATH_COLUMN_RE.test(c) || SECRET_COLUMN_RE.test(c)) return false;
  if (MCP_NEVER_EXPOSED_COLUMNS[t]?.includes(c)) return false;
  if (MCP_TEXT_GATED_COLUMNS[t]?.includes(c)) return opts.promptText === true;
  return true;
}
