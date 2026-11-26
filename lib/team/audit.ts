import { query, type Queryable } from './db';

export interface AuditEventInput {
  actorUserId: string | null | undefined;
  actorUsername: string | null | undefined;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The application's own connection; tests inject the test branch instead (the module-level pool is deliberately unreachable in tests). */
const appDb: Queryable = { query: (text, params) => query(text, params ?? []) };

const pgCode = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;

/**
 * Persists a row to the audit_log table. Never throws — audit logging must not
 * be able to break the sensitive action it's recording (impersonation, password
 * resets, pricing changes), so failures are swallowed and logged to console
 * ("[audit-log-error]"). Resolves true if the row was written, false if it was not.
 *
 * `audit_log.actor_user_id` is a UUID that references users(id). Two kinds of caller value cannot go there, and both used to make the insert fail
 * (and the event disappear):
 *  - The built-in accounts (`team`, `superadmin`) have no users row; their session userId is the plain string 'admin' / 'superadmin'.
 *    They are recorded with actor_user_id NULL, actor_username as given, and metadata.builtinActor = the original id, so who acted is not lost.
 *  - A UUID whose user no longer exists (a stale session of a deleted account): foreign-key violation. The event is retried once unlinked, with
 *    metadata.actorUserMissing = that id.
 * Database users with a real id are recorded exactly as before.
 */
export async function recordAuditEvent(event: AuditEventInput, db: Queryable = appDb): Promise<boolean> {
  const raw = event.actorUserId ? String(event.actorUserId) : '';
  const isUuid = UUID_RE.test(raw);
  const actorId = isUuid ? raw : null;
  const baseMetadata = event.metadata || null;
  const metadata = raw && !isUuid ? { ...(baseMetadata ?? {}), builtinActor: raw.slice(0, 64) } : baseMetadata;

  const insert = (actor: string | null, meta: Record<string, unknown> | null) => db.query(
    `INSERT INTO audit_log (actor_user_id, actor_username, action, target_type, target_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      actor,
      event.actorUsername || null,
      event.action,
      event.targetType || null,
      event.targetId || null,
      // BUG-19 fix: pass the object directly so pg casts it to JSONB correctly.
      // JSON.stringify would double-serialize if the column is jsonb type.
      meta,
    ],
  );

  try {
    await insert(actorId, metadata);
    return true;
  } catch (err) {
    if (actorId && pgCode(err) === '23503') {
      try {
        await insert(null, { ...(metadata ?? {}), actorUserMissing: actorId });
        return true;
      } catch (retryErr) {
        console.error('[audit-log-error]', event.action, retryErr);
        return false;
      }
    }
    console.error('[audit-log-error]', event.action, err);
    return false;
  }
}
