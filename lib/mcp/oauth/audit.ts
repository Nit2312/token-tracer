/**
 * The only way OAuth code writes to audit_log: the SECURITY DEFINER function mcp_audit_event (fixed event allowlist, fixed "mcp." prefix,
 * actor username looked up by the database). mcp_auth has no privilege on audit_log itself. Callers pass ids and counts only, never secrets.
 */
import type { McpTx } from '../db';

export type AuditEvent =
  | 'client_registered' | 'authorization_granted' | 'authorization_denied' | 'code_replayed' | 'token_issued'
  | 'token_refreshed' | 'refresh_reuse_detected' | 'token_revoked' | 'tokens_revoked_for_user' | 'access_denied';
export type AuditTarget = 'oauth_client' | 'oauth_token' | 'oauth_code' | 'user';

export async function audit(tx: McpTx, event: AuditEvent, actorUserId: string | null, targetType: AuditTarget | null, targetId: string | null, meta?: Record<string, string | number | boolean | null>): Promise<void> {
  await tx.query('SELECT mcp_audit_event($1, $2, $3, $4, $5::jsonb)', [event, actorUserId, targetType, targetId, meta ? JSON.stringify(meta) : null]);
}
