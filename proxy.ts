import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  COOKIE_NAME,
  buildSessionCookie,
  decodeSessionToken,
  isPrivileged,
  sessionLimits,
} from '@/lib/session-token';

/**
 * 1. CSRF defence — state-changing requests to /api/* must come from this site.
 *    Browsers always attach Origin / Sec-Fetch-Site to cross-site writes, so a request
 *    from another origin is rejected. Non-browser clients (the sync daemon, curl) send
 *    neither header and authenticate with Bearer keys, so they are unaffected.
 * 2. Idle timeout — privileged sessions carry a `lastActive` stamp that is refreshed here
 *    (at most once a minute) on normal page/API reads. Auth routes are skipped because
 *    they set or clear the session cookie themselves.
 */
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const REFRESH_AFTER_MS = 60_000;

function sameOrigin(req: NextRequest): boolean {
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return false;

  const origin = req.headers.get('origin');
  if (!origin) return true; // non-browser client
  try {
    const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || req.nextUrl.host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith('/api/');

  if (isApi && UNSAFE.has(req.method) && !sameOrigin(req)) {
    return NextResponse.json({ error: 'Cross-site request blocked' }, { status: 403 });
  }

  const res = NextResponse.next();
  if (isApi) res.headers.set('Cache-Control', 'no-store');

  const isReadOnly = req.method === 'GET' || req.method === 'HEAD';
  const skipRefresh = pathname.startsWith('/api/auth/') || pathname.startsWith('/api/v1/auth/') || pathname.startsWith('/api/admin/impersonate');
  const raw = req.cookies.get(COOKIE_NAME)?.value;
  if (raw && isReadOnly && !skipRefresh) {
    const session = decodeSessionToken(raw);
    if (session && isPrivileged(session.role) && sessionLimits(session).idleSec) {
      const now = Date.now();
      if (now - (session.lastActive ?? session.issuedAt) > REFRESH_AFTER_MS) {
        const secure = req.nextUrl.protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';
        res.headers.append('Set-Cookie', buildSessionCookie({ ...session, lastActive: now }, secure));
      }
    }
  }
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
