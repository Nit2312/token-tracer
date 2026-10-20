/**
 * Signed session tokens (pure: crypto + env only, safe to import from proxy.ts).
 *
 * Lifetimes depend on role — privileged sessions are short and expire when idle:
 *   superadmin  8h absolute, 30 min idle
 *   admin      12h absolute, 60 min idle
 *   user        7d absolute, no idle limit
 *   impersonated sessions: 1h absolute
 * Privileged tokens are only valid when the MFA check was completed (`mfa: true`).
 */
import crypto from 'node:crypto';
import { sessionSecret } from '@/lib/team/env';

export const COOKIE_NAME = 'app_session';
export const IMPERSONATION_COOKIE = 'sa_original_session';

export type Role = 'user' | 'admin' | 'superadmin';

export interface SessionPayload {
  userId: string;   // For users: UUID from users table. For admin/superadmin: 'admin' | 'superadmin'
  username: string;
  displayName: string;
  role: Role;
  memberId: string | null;
  teamId: string | null;
  issuedAt: number;
  lastActive?: number;          // refreshed by proxy.ts while the session is in use
  mfa?: boolean;                // true once the second factor has been verified
  impersonatedBy?: string;      // original superadmin userId (set during impersonation)
  impersonatedByName?: string;  // original superadmin display name
}

export function isPrivileged(role: Role): boolean {
  return role === 'admin' || role === 'superadmin';
}

interface Limits {
  absoluteSec: number;
  idleSec: number | null;
}

export function sessionLimits(payload: Pick<SessionPayload, 'role' | 'impersonatedBy'>): Limits {
  if (payload.impersonatedBy) return { absoluteSec: 60 * 60, idleSec: null };
  if (payload.role === 'superadmin') return { absoluteSec: 8 * 60 * 60, idleSec: 30 * 60 };
  if (payload.role === 'admin') return { absoluteSec: 12 * 60 * 60, idleSec: 60 * 60 };
  return { absoluteSec: 7 * 24 * 60 * 60, idleSec: null };
}

// ── Generic signing helpers ──────────────────────────────────────────────────

function sign(b64: string): string {
  return crypto.createHmac('sha256', sessionSecret()).update(b64).digest('base64url');
}

export function signObject(obj: unknown): string {
  const b64 = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64}.${sign(b64)}`;
}

export function verifySigned<T>(token: string | null | undefined): T | null {
  if (!token) return null;
  try {
    const dot = token.lastIndexOf('.');
    if (dot < 0) return null;
    const b64 = token.slice(0, dot);
    const a = Buffer.from(token.slice(dot + 1));
    const b = Buffer.from(sign(b64));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return JSON.parse(Buffer.from(b64, 'base64url').toString()) as T;
  } catch {
    return null;
  }
}

// ── Session tokens ───────────────────────────────────────────────────────────

export function encodeSessionToken(payload: SessionPayload): string {
  return signObject(payload);
}

/** Decode + verify. Returns null if forged, expired, idle-expired, or privileged without MFA. */
export function decodeSessionToken(
  token: string | null | undefined,
  opts: { ignoreIdle?: boolean } = {},
): SessionPayload | null {
  const payload = verifySigned<SessionPayload>(token);
  if (!payload || typeof payload.issuedAt !== 'number') return null;

  const { absoluteSec, idleSec } = sessionLimits(payload);
  const now = Date.now();
  if (now - payload.issuedAt > absoluteSec * 1000) return null;
  if (idleSec && !opts.ignoreIdle) {
    const last = payload.lastActive ?? payload.issuedAt;
    if (now - last > idleSec * 1000) return null;
  }
  if (isPrivileged(payload.role) && !payload.impersonatedBy && payload.mfa !== true) return null;
  return payload;
}

function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k.trim() === name) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function getSessionFromCookie(cookieHeader: string | null | undefined): SessionPayload | null {
  return decodeSessionToken(readCookie(cookieHeader, COOKIE_NAME));
}

export function getOriginalSessionFromCookie(cookieHeader: string | null | undefined): SessionPayload | null {
  // The backup cookie sits unused during impersonation, so idle time does not apply — absolute limit still does.
  return decodeSessionToken(readCookie(cookieHeader, IMPERSONATION_COOKIE), { ignoreIdle: true });
}

export function getRawImpersonationToken(cookieHeader: string | null | undefined): string | null {
  return readCookie(cookieHeader, IMPERSONATION_COOKIE) || null;
}

export function buildSessionCookie(payload: SessionPayload, secure: boolean): string {
  const token = encodeSessionToken(payload);
  const { absoluteSec } = sessionLimits(payload);
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${absoluteSec}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(secure?: boolean): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? '; Secure' : ''}`;
}

export function buildImpersonationCookie(originalToken: string, secure: boolean): string {
  return `${IMPERSONATION_COOKIE}=${encodeURIComponent(originalToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${8 * 60 * 60}${secure ? '; Secure' : ''}`;
}

export function clearImpersonationCookie(secure?: boolean): string {
  return `${IMPERSONATION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? '; Secure' : ''}`;
}
