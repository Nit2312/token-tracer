import { query } from './db';

export interface AuditEventInput {
  actorUserId: string | null | undefined;
  actorUsername: string | null | undefined;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Persists a row to the audit_log table. Never throws — audit logging must not
 * be able to break the sensitive action it's recording (impersonation, password
 * resets, pricing changes), so failures are swallowed and logged to console.
 */
export async function recordAuditEvent(event: AuditEventInput): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_log (actor_user_id, actor_username, action, target_type, target_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        event.actorUserId || null,
        event.actorUsername || null,
        event.action,
        event.targetType || null,
        event.targetId || null,
        // BUG-19 fix: pass the object directly so pg casts it to JSONB correctly.
        // JSON.stringify would double-serialize if the column is jsonb type.
        event.metadata || null,
      ],
    );
  } catch (err) {
    console.error('[audit-log-error]', event.action, err);
  }
}
