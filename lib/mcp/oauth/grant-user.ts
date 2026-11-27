/** Who may authorize MCP access: a DATABASE-backed team admin with a team, in a non-impersonated, MFA-complete session. Pure rule + one read. */
import { withMcpTx, type McpPool } from '../db';
import type { SessionPayload } from '../../session-token';

export interface GrantUser { id: string; displayName: string; role: string; teamId: string | null; teamName: string | null; active: boolean }

export async function loadGrantUser(pool: McpPool, userId: string): Promise<GrantUser | null> {
  return withMcpTx(pool, async (tx) => {
    const r = await tx.query(
      `SELECT u.id, u.display_name, u.role, u.team_id, u.active, t.name AS team_name FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.id = $1`, [userId]);
    const x = r.rows[0];
    return x ? { id: x.id, displayName: x.display_name, role: x.role, teamId: x.team_id, teamName: x.team_name, active: x.active } : null;
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The admin must have AUTHENTICATED (password + TOTP) within this window to grant consent. `issuedAt` is only ever set at login: proxy.ts refreshes `lastActive`, never `issuedAt`. */
export const GRANT_MAX_LOGIN_AGE_MS = 15 * 60 * 1000;

export type Ineligible = 'impersonation' | 'builtin_account' | 'not_admin' | 'no_mfa' | 'inactive' | 'no_team' | 'stale_session' | 'login_not_recent';
export const INELIGIBLE_MESSAGE: Record<Ineligible, string> = {
  impersonation: 'MCP access cannot be authorized while impersonating another user.',
  builtin_account: 'This built-in account cannot authorize MCP access. Sign in with a team admin account.',
  not_admin: 'Only team admins can authorize MCP access.',
  no_mfa: 'Complete two-factor sign-in before authorizing MCP access.',
  inactive: 'This account is not active.',
  no_team: 'Your account is not assigned to a team.',
  stale_session: 'Your account changed since you signed in. Sign out and sign in again.',
  login_not_recent: 'For security, sign in again to authorize MCP access.',
};

/** The session says who is asking; the DATABASE decides whether they still qualify (role, team and active are re-read, never trusted from the cookie). */
export function evaluateGrantEligibility(session: SessionPayload, user: GrantUser | null, now = Date.now()): { ok: true; user: GrantUser & { teamId: string } } | { ok: false; reason: Ineligible } {
  if (session.impersonatedBy) return { ok: false, reason: 'impersonation' };
  if (!UUID_RE.test(session.userId)) return { ok: false, reason: 'builtin_account' };
  if (session.role !== 'admin') return { ok: false, reason: 'not_admin' };
  if (session.mfa !== true) return { ok: false, reason: 'no_mfa' };
  if (!user || !user.active) return { ok: false, reason: 'inactive' };
  if (user.role !== 'admin') return { ok: false, reason: 'not_admin' };
  if (!user.teamId) return { ok: false, reason: 'no_team' };
  if (session.teamId !== user.teamId) return { ok: false, reason: 'stale_session' };
  // Checked LAST so that accounts that can never qualify are told so instead of being asked to sign in again. An issuedAt in the future (clock tampering) also fails.
  const age = now - session.issuedAt;
  if (!Number.isFinite(age) || age < -60_000 || age > GRANT_MAX_LOGIN_AGE_MS) return { ok: false, reason: 'login_not_recent' };
  return { ok: true, user: { ...user, teamId: user.teamId } };
}
