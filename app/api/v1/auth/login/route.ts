import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

function isVercel(req: NextRequest): boolean {
  const host = req.headers.get('host') || '';
  const isLocalhost = host.includes('localhost') || host.includes('127.0.0.1');
  return !isLocalhost && (process.env.VERCEL === '1' || req.headers.get('x-forwarded-proto') === 'https');
}

export async function DELETE(req: NextRequest) {
  const secure = isVercel(req);
  const res = NextResponse.json({ ok: true });
  res.cookies.set('app_session', '', {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 0,
    expires: new Date(0),
    secure,
  });
  res.cookies.set('sa_original_session', '', {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 0,
    expires: new Date(0),
    secure,
  });
  res.cookies.set('team_admin', '', {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 0,
    expires: new Date(0),
    secure,
  });
  return res;
}

/**
 * Retired. This endpoint used to mint a password-only, never-expiring admin token
 * that bypassed MFA. All sign-ins now go through POST /api/auth/login (+ MFA verify).
 */
export async function POST() {
  return NextResponse.json({ error: 'This endpoint has been retired. Use /api/auth/login.' }, { status: 410 });
}
