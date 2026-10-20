/**
 * Unified auth library for the personal/admin/superadmin login system.
 * Uses bcryptjs for password hashing and stateless HMAC tokens stored as
 * HTTP-only cookies for session management.
 */
import bcrypt from 'bcryptjs';
import { query } from '@/lib/team/db';

// Session tokens live in a pure module (shared with proxy.ts); re-exported for existing callers.
export {
  COOKIE_NAME,
  IMPERSONATION_COOKIE,
  encodeSessionToken,
  decodeSessionToken,
  getSessionFromCookie,
  buildSessionCookie,
  clearSessionCookie,
  buildImpersonationCookie,
  clearImpersonationCookie,
  getOriginalSessionFromCookie,
  getRawImpersonationToken,
} from '@/lib/session-token';
export type { Role, SessionPayload } from '@/lib/session-token';
import { getSessionFromCookie, type Role, type SessionPayload } from '@/lib/session-token';

/** Superadmin or team-admin (any team). */
export function isAdminRole(session: SessionPayload | null): session is SessionPayload {
  return !!session && (session.role === 'admin' || session.role === 'superadmin');
}

/**
 * Platform owner: superadmin, or the built-in `team` admin (not bound to a single team).
 * Team admins created through signup have a teamId and are NOT system admins.
 */
export function isSystemAdmin(session: SessionPayload | null): session is SessionPayload {
  return !!session && (session.role === 'superadmin' || (session.role === 'admin' && !session.teamId));
}

// ── Password helpers ──────────────────────────────────────────────────────────

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// ── Database user helpers ─────────────────────────────────────────────────────

export interface DbUser {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  member_id: string | null;
  team_id: string | null;
  role: Role;
  active: boolean;
  failed_login_attempts?: number;
  locked_until?: Date | string | null;
}

export async function findUserByUsername(username: string): Promise<DbUser | null> {
  const norm = String(username || '').trim().toLowerCase();
  if (!norm) return null;
  const { rows } = await query<DbUser>(
    `SELECT id, username, password_hash, display_name, member_id, team_id, role, active,
            failed_login_attempts, locked_until
     FROM users WHERE LOWER(username) = $1`,
    [norm],
  );
  return rows[0] || null;
}

export async function touchLastLogin(userId: string): Promise<void> {
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
}

export async function recordFailedLogin(userId: string, currentAttempts: number): Promise<void> {
  const newAttempts = (currentAttempts || 0) + 1;
  let lockedUntil: Date | null = null;
  if (newAttempts >= 5) {
    lockedUntil = new Date(Date.now() + 15 * 60 * 1000); // 15 mins lock
  }
  await query(
    'UPDATE users SET failed_login_attempts = $1, locked_until = $2 WHERE id = $3',
    [newAttempts, lockedUntil, userId]
  );
}

export async function resetFailedLogin(userId: string): Promise<void> {
  await query(
    'UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1',
    [userId]
  );
}

/** @deprecated Raw API keys are not stored — they are only shown once at creation time. */
export async function getMemberApiKey(_memberId: string): Promise<string | null> {
  // Raw keys are never stored — only their SHA-256 hash is kept in member_keys.
  // This function intentionally returns null. Use the creation-time response instead.
  return null;
}

/**
 * Verifies if the request is from an admin or superadmin, and returns the authorized teamId.
 * - If superadmin, returns the requested teamId (from parameters).
 * - If admin, strictly overrides and returns their associated teamId.
 * - Returns null if unauthorized or missing permissions.
 */

export function getAuthorizedTeamId(req: any, paramTeamId: string | null | undefined): string | null {
  const session = getSessionFromCookie(req.headers.get('cookie'));
  if (session) {
    if (session.role === 'superadmin') {
      return paramTeamId || null;
    }
    if (session.role === 'admin') {
      // If admin has a specific teamId bound to their account (team-scoped admin), use that.
      // If they are the system team admin (session.userId === 'admin' or session.teamId is null), allow paramTeamId.
      return session.teamId || paramTeamId || null;
    }
    if (session.role === 'user') {
      // BUG-04 fix: users must NEVER access another team's data via a param override
      return session.teamId || null;
    }
  }

  return null;
}
