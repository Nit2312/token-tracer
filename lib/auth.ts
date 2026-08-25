/**
 * Unified auth library for the personal/admin/superadmin login system.
 * Uses bcryptjs for password hashing and stateless HMAC tokens stored as
 * HTTP-only cookies for session management.
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { sessionSecret } from '@/lib/team/env';
import { queryCol, setDocById, getDocById, newUuid } from '@/lib/team/db';
import { adminTokenFromCookie, verifyAdminToken } from './team/auth';

export const COOKIE_NAME = 'app_session';
export const IMPERSONATION_COOKIE = 'sa_original_session';
export const COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

export type Role = 'user' | 'admin' | 'superadmin';

export interface SessionPayload {
  userId: string;   // For users: UUID from users collection. For admin/superadmin: 'admin' | 'superadmin'
  username: string;
  displayName: string;
  role: Role;
  memberId: string | null;
  teamId: string | null;
  issuedAt: number;
  impersonatedBy?: string;      // original superadmin userId (set during impersonation)
  impersonatedByName?: string;  // original superadmin display name
}

// ── Password helpers ──────────────────────────────────────────────────────────

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// ── Token helpers (HMAC-based stateless session) ──────────────────────────────

function tokenSecret(): string {
  return sessionSecret();
}

/** Encode a session payload into a signed token string. */
export function encodeSessionToken(payload: SessionPayload): string {
  const data = JSON.stringify(payload);
  const b64 = Buffer.from(data).toString('base64url');
  const sig = crypto
    .createHmac('sha256', tokenSecret())
    .update(b64)
    .digest('base64url');
  return `${b64}.${sig}`;
}

/** Decode and verify a session token. Returns null if invalid or expired. */
export function decodeSessionToken(token: string | null | undefined): SessionPayload | null {
  if (!token) return null;
  try {
    const dot = token.lastIndexOf('.');
    if (dot < 0) return null;
    const b64 = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expectedSig = crypto
      .createHmac('sha256', tokenSecret())
      .update(b64)
      .digest('base64url');
    // Timing-safe compare
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString()) as SessionPayload;
    // Expire after 7 days
    if (Date.now() - payload.issuedAt > COOKIE_MAX_AGE * 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Read and verify the session token from a cookie header string. */
export function getSessionFromCookie(cookieHeader: string | null | undefined): SessionPayload | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k.trim() === COOKIE_NAME) {
      return decodeSessionToken(decodeURIComponent(rest.join('=')));
    }
  }
  return null;
}

/** Build the Set-Cookie header value for the session token. */
export function buildSessionCookie(payload: SessionPayload, secure: boolean): string {
  const token = encodeSessionToken(payload);
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}${secure ? '; Secure' : ''}`;
}

/** Build a cookie that clears the session. */
export function clearSessionCookie(secure?: boolean): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? '; Secure' : ''}`;
}

// ── Impersonation cookie helpers ──────────────────────────────────────────────

/** Store the original superadmin session token in a backup cookie during impersonation. */
export function buildImpersonationCookie(originalToken: string, secure: boolean): string {
  return `${IMPERSONATION_COOKIE}=${encodeURIComponent(originalToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}${secure ? '; Secure' : ''}`;
}

/** Clear the impersonation backup cookie. */
export function clearImpersonationCookie(secure?: boolean): string {
  return `${IMPERSONATION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? '; Secure' : ''}`;
}

/** Read the original superadmin session from the backup impersonation cookie. */
export function getOriginalSessionFromCookie(cookieHeader: string | null | undefined): SessionPayload | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k.trim() === IMPERSONATION_COOKIE) {
      return decodeSessionToken(decodeURIComponent(rest.join('=')));
    }
  }
  return null;
}

/** Extract the raw impersonation cookie token string (not decoded). */
export function getRawImpersonationToken(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k.trim() === IMPERSONATION_COOKIE) {
      return decodeURIComponent(rest.join('=')) || null;
    }
  }
  return null;
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
  locked_until?: string | null;
}

export async function findUserByUsername(username: string): Promise<DbUser | null> {
  const norm = String(username || '').trim().toLowerCase();
  if (!norm) return null;
  const docs = await queryCol<DbUser>('users', [
    { type: 'where', field: 'username', op: '==', value: norm },
    { type: 'limit', n: 1 },
  ]);
  return docs[0] || null;
}

export async function touchLastLogin(userId: string): Promise<void> {
  await setDocById('users', userId, { last_login_at: new Date().toISOString() }, true);
}

export async function recordFailedLogin(userId: string, currentAttempts: number): Promise<void> {
  const newAttempts = (currentAttempts || 0) + 1;
  let lockedUntil: string | null = null;
  if (newAttempts >= 5) {
    lockedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 mins lock
  }
  await setDocById('users', userId, {
    failed_login_attempts: newAttempts,
    locked_until: lockedUntil,
  }, true);
}

export async function resetFailedLogin(userId: string): Promise<void> {
  await setDocById('users', userId, {
    failed_login_attempts: 0,
    locked_until: null,
    last_login_at: new Date().toISOString(),
  }, true);
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
      return session.teamId || paramTeamId || null;
    }
    if (session.role === 'user') {
      // BUG-04 fix: users must NEVER access another team's data via a param override
      return session.teamId || null;
    }
  }

  // Fallback check for legacy static admin password token
  const authHeader = req.headers.get('authorization');
  let legacyToken = '';
  if (authHeader?.startsWith('Bearer ')) {
    legacyToken = authHeader.slice(7);
  } else {
    legacyToken = adminTokenFromCookie(req.headers.get('cookie')) || '';
  }
  if (verifyAdminToken(legacyToken)) {
    return paramTeamId || null;
  }

  return null;
}
