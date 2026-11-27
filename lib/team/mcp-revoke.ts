/**
 * Revocation of MCP access when an account's security state changes. Called from every route that changes a password, resets MFA,
 * changes role / active / team, removes a member or deletes a team. Runs with the application's own database connection (the MCP
 * OAuth tables are written here only to REVOKE — the one-way trigger on oauth_tokens allows exactly this UPDATE and nothing else).
 *
 * Semantics:
 *  - The revoke runs BEFORE the change and again AFTER it (withMcpRevocation): a stolen refresh token cannot slip a refresh in between.
 *    If the revoke fails the change is not made; if the second one fails the caller sees an error and a retry re-revokes. Idempotent.
 *  - Before the MCP migration is applied (or on a database without the tables) there is nothing to revoke: a catalog check detects that
 *    quietly (no error, no ensureSchema retry), so password resets etc. keep working everywhere. Any OTHER database error propagates.
 *  - Ids that are not UUIDs revoke nothing (the caller's own write decides what an invalid id means).
 *  - Audit rows go through mcp_audit_event (fixed allowlist); their absence (function not installed) or failure never blocks the revoke.
 *  - Never logs ids, tokens or error text.
 */
import { query, type Queryable } from './db';

/** The application's own connection; tests inject the test branch instead (the module-level pool is deliberately unreachable in tests). */
const appDb: Queryable = { query: (text, params) => query(text, params ?? []) };

export type McpRevokeReason =
  | 'password_reset' | 'password_changed' | 'mfa_reset' | 'role_changed' | 'team_changed'
  | 'deactivated' | 'reactivated' | 'member_removed' | 'team_deleted';

export type McpRevokeTarget = { userId: string } | { memberId: string } | { teamId: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USERS_WHERE: Record<'userId' | 'memberId' | 'teamId', string> = {
  userId: 'user_id = $2::uuid',
  memberId: 'user_id IN (SELECT id FROM users WHERE member_id = $2::uuid)',
  teamId: 'user_id IN (SELECT id FROM users WHERE team_id = $2::uuid)',
};

const pgCode = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;

/** Revokes every live MCP token of the targeted users. Returns how many tokens were revoked. */
export async function revokeMcpAccess(target: McpRevokeTarget, reason: McpRevokeReason, db: Queryable = appDb): Promise<number> {
  const kind = (Object.keys(target) as Array<keyof McpRevokeTarget>)[0];
  const id = (target as Record<string, string>)[kind];
  if (typeof id !== 'string' || !UUID_RE.test(id)) return 0;

  let perUser: Array<{ user_id: string; n: number }>;
  try {
    // Catalog lookup FIRST: it never raises, so a database without the MCP tables (migration not applied yet) takes the quiet path. Relying on
    // the missing-relation error instead would make lib/team/db's query() run ensureSchema() (a full DDL pass) and log an error on every call.
    const present = await db.query<{ ok: boolean }>(`SELECT to_regclass('public.oauth_tokens') IS NOT NULL AS ok`);
    if (!present.rows[0]?.ok) return 0;
    const r = await db.query<{ user_id: string; n: number }>(
      `WITH r AS (UPDATE oauth_tokens SET revoked_at = now(), revoked_reason = $1 WHERE ${USERS_WHERE[kind]} AND revoked_at IS NULL RETURNING user_id)
       SELECT user_id, count(*)::int AS n FROM r GROUP BY user_id`,
      [reason, id],
    );
    perUser = r.rows;
  } catch (e) {
    if (pgCode(e) === '42P01') return 0; // MCP tables not installed: nothing can be revoked, nothing to protect
    throw e;
  }
  const total = perUser.reduce((s, r) => s + r.n, 0);
  for (const row of perUser) {
    try {
      await db.query(`SELECT mcp_audit_event('tokens_revoked_for_user', $1::uuid, 'user', $1::text, jsonb_build_object('revoked', $2::int, 'reason', $3::text))`, [row.user_id, row.n, reason]);
    } catch {
      console.warn('[mcp] revocation audit unavailable'); // fixed text only; the tokens ARE revoked
    }
  }
  return total;
}

/** revoke → run the change → revoke again (closes the window in which a refresh token could still be exchanged). */
export async function withMcpRevocation<T>(target: McpRevokeTarget, reason: McpRevokeReason, change: () => Promise<T>, db: Queryable = appDb): Promise<T> {
  await revokeMcpAccess(target, reason, db);
  const out = await change();
  await revokeMcpAccess(target, reason, db);
  return out;
}

/** True when any of role / active / team differs between the stored row and the requested values (null/undefined = "unchanged", as in COALESCE). */
export function securityStateChanged(
  current: { role?: string | null; active?: boolean | null; team_id?: string | null },
  next: { role?: string | null; active?: boolean | null; teamId?: string | null },
): McpRevokeReason | null {
  if (next.role != null && next.role !== current.role) return 'role_changed';
  if (next.active != null && next.active !== current.active) return next.active ? 'reactivated' : 'deactivated';
  if (next.teamId != null && next.teamId !== current.team_id) return 'team_changed';
  return null;
}
