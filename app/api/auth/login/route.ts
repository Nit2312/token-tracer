/**
 * POST /api/auth/login
 * Unified login for user / admin / superadmin.
 *
 * username=team + ADMIN_PASSWORD     → admin session → redirect /team
 * username=superadmin + SUPERADMIN_PASSWORD → superadmin → redirect /admin
 * any other username                 → DB lookup, bcrypt verify → redirect /
 */
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { adminPassword, superadminPassword } from '@/lib/team/env';
import { verifyAdminPassword } from '@/lib/team/auth';
import { queryCol } from '@/lib/team/db';
import {
  findUserByUsername, verifyPassword, touchLastLogin,
  buildSessionCookie, type SessionPayload,
  recordFailedLogin, resetFailedLogin
} from '@/lib/auth';

export const dynamic = 'force-dynamic';

function isSecure(req: NextRequest): boolean {
  return process.env.VERCEL === '1' ||
    req.headers.get('x-forwarded-proto') === 'https' ||
    process.env.NODE_ENV === 'production';
}

export async function POST(req: NextRequest) {
  try {
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch {
      return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
    }

    const username = String(body.username ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');

    if (!username || !password) {
      return NextResponse.json({ error: 'username and password are required' }, { status: 400 });
    }

    const secure = isSecure(req);
    let payload: SessionPayload;

    // ── Admin login ───────────────────────────────────────────────────────────
    if (username === 'team') {
      const pwd = adminPassword();
      if (!pwd) return NextResponse.json({ error: 'Admin login is not configured' }, { status: 503 });
      if (!verifyAdminPassword(password)) {
        return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
      }
      payload = {
        userId: 'admin',
        username: 'team',
        displayName: 'Team Admin',
        role: 'admin',
        memberId: null,
        teamId: null,
        issuedAt: Date.now(),
      };
      const res = NextResponse.json({ ok: true, redirect: '/team' });
      res.headers.set('Set-Cookie', buildSessionCookie(payload, secure));
      return res;
    }

    // ── Superadmin login ──────────────────────────────────────────────────────
    if (username === 'superadmin') {
      const pwd = superadminPassword();
      if (!pwd) return NextResponse.json({ error: 'Superadmin login is not configured' }, { status: 503 });
      // BUG-13 fix: use timing-safe SHA-256 comparison for the raw env-var secret.
      // We can't use bcrypt here because the env var stores the *plain* expected password,
      // not a bcrypt hash. We use SHA-256 of both sides with timingSafeEqual to prevent
      // timing attacks while still being functionally correct. A future improvement would
      // be to store a bcrypt hash in SUPERADMIN_PASSWORD_HASH as a separate env var.
      const a = crypto.createHash('sha256').update(password).digest();
      const b = crypto.createHash('sha256').update(pwd).digest();
      const match = crypto.timingSafeEqual(a, b);
      if (!match) {
        return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
      }
      payload = {
        userId: 'superadmin',
        username: 'superadmin',
        displayName: 'Super Admin',
        role: 'superadmin',
        memberId: null,
        teamId: null,
        issuedAt: Date.now(),
      };
      const res = NextResponse.json({ ok: true, redirect: '/admin' });
      res.headers.set('Set-Cookie', buildSessionCookie(payload, secure));
      return res;
    }

    // ── Regular user login ────────────────────────────────────────────────────
    const user = await findUserByUsername(username);
    if (!user) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }
    if (!user.active) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    // Check account lockout status
    if (user.locked_until) {
      const lockTime = new Date(user.locked_until).getTime();
      const now = Date.now();
      if (lockTime > now) {
        const remainingMinutes = Math.ceil((lockTime - now) / 60000);
        return NextResponse.json({
          error: `This account is temporarily locked due to too many failed login attempts. Please try again in ${remainingMinutes} minute(s).`
        }, { status: 423 }); // 423 Locked
      }
    }

    const match = await verifyPassword(password, user.password_hash);
    if (!match) {
      await recordFailedLogin(user.id, user.failed_login_attempts || 0);
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    await resetFailedLogin(user.id);

    let userTeamId = user.team_id;
    if (user.member_id) {
      const tmDocs = await queryCol<{ team_id: string }>('team_members', [
        { type: 'where', field: 'member_id', op: '==', value: user.member_id },
        { type: 'orderBy', field: 'created_at', direction: 'asc' },
        { type: 'limit', n: 1 },
      ]);
      if (tmDocs[0]?.team_id) userTeamId = tmDocs[0].team_id;
    }

    payload = {
      userId: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
      memberId: user.member_id,
      teamId: userTeamId,
      issuedAt: Date.now(),
    };

    let redirectUrl = '/';
    if (user.role === 'admin') {
      redirectUrl = '/team';
    } else if (user.role === 'superadmin') {
      redirectUrl = '/admin';
    }

    const res = NextResponse.json({ ok: true, redirect: redirectUrl });
    res.headers.set('Set-Cookie', buildSessionCookie(payload, secure));
    return res;
  } catch (err) {
    console.error('[auth/login error]', err);
    return NextResponse.json({ error: String((err as Error).message || err) }, { status: 500 });
  }
}
