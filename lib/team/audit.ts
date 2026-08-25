import { addDocToCol, newUuid } from './db';

export interface AuditEventInput {
  actorUserId: string | null | undefined;
  actorUsername: string | null | undefined;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Persists a document to the audit_log collection. Never throws — audit logging must not
 * be able to break the sensitive action it's recording (impersonation, password
 * resets, pricing changes), so failures are swallowed and logged to console.
 */
export async function recordAuditEvent(event: AuditEventInput): Promise<void> {
  try {
    await addDocToCol('audit_log', {
      id: newUuid(),
      actor_user_id: event.actorUserId || null,
      actor_username: event.actorUsername || null,
      action: event.action,
      target_type: event.targetType || null,
      target_id: event.targetId || null,
      metadata: event.metadata || null,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[audit-log-error]', event.action, err);
  }
}
