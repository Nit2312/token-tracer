import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminPassword, issueAdminToken } from '@/lib/team/auth';
import { adminPassword } from '@/lib/team/env';

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

export async function POST(req: NextRequest) {
  try {
    const pwd = adminPassword();
    if (!pwd) {
      return NextResponse.json({ error: 'ADMIN_PASSWORD is not configured on the server' }, { status: 503 });
    }
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
    }
    const submittedPassword = String(body.password ?? '');
    if (!verifyAdminPassword(submittedPassword)) {
      return NextResponse.json({ error: 'invalid credentials' }, { status: 401 });
    }
    const token = issueAdminToken();
    const secure = isVercel(req);
    const cookieValue = `team_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure ? '; Secure' : ''}`;
    const res = NextResponse.json({ ok: true, token });
    res.headers.set('Set-Cookie', cookieValue);
    return res;
  } catch (err) {
    console.error('[auth/login error]', err);
    return NextResponse.json({ error: String((err as Error).message || err) }, { status: 500 });
  }
}
