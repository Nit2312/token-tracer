/** Short-lived, signed "password OK, second factor pending" cookie shared by the login and MFA-verify routes. */
import { signObject, verifySigned, type SessionPayload } from '@/lib/session-token';

export const MFA_COOKIE = 'mfa_pending';
const MFA_TTL_SEC = 5 * 60;

export interface PendingMfa {
  payload: Omit<SessionPayload, 'issuedAt' | 'lastActive' | 'mfa'>;
  /** Auth-store subject: 'env:superadmin' | 'env:team' | 'user:<uuid>' */
  subject: string;
  redirect: string;
  enroll: boolean;
  exp: number;
}

export function buildPendingCookie(p: Omit<PendingMfa, 'exp'>, secure: boolean): string {
  const token = signObject({ ...p, exp: Date.now() + MFA_TTL_SEC * 1000 } satisfies PendingMfa);
  // SameSite=Strict + path-scoped: only sent to our own /api/auth endpoints, never readable by page JS.
  return `${MFA_COOKIE}=${encodeURIComponent(token)}; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=${MFA_TTL_SEC}${secure ? '; Secure' : ''}`;
}

export function clearPendingCookie(secure: boolean): string {
  return `${MFA_COOKIE}=; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function readPending(cookieHeader: string | null | undefined): PendingMfa | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k.trim() === MFA_COOKIE) {
      let raw: string;
      try {
        raw = decodeURIComponent(rest.join('='));
      } catch {
        return null;
      }
      const p = verifySigned<PendingMfa>(raw);
      if (!p || typeof p.exp !== 'number' || p.exp < Date.now()) return null;
      return p;
    }
  }
  return null;
}
