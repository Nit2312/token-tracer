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
import { query } from '@/lib/team/db';
import {
  findUserByUsername, verifyPassword,
  buildSessionCookie, type SessionPayload,
  recordFailedLogin, resetFailedLogin
} from '@/lib/auth';
import { isPrivileged } from '@/lib/session-token';
import { beginEnrollment, getMfaState, lockedForSeconds, loginRules, recordFailure } from '@/lib/security/auth-store';
import { buildPendingCookie } from '@/lib/security/mfa-flow';
import { otpauthUri } from '@/lib/security/totp';
import { clientIp } from '@/lib/security/request';
import { recordAuditEvent } from '@/lib/team/audit';

export const dynamic = 'force-dynamic';

function isSecure(req: NextRequest): boolean {
  const host = req.headers.get('host') || '';
  const isLocalhost = host.includes('localhost') || host.includes('127.0.0.1');
  return !isLocalhost && (
    process.env.VERCEL === '1' ||
    req.headers.get('x-forwarded-proto') === 'https'
  );
}

export async function DELETE(req: NextRequest) {
  const secure = isSecure(req);
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

type Identity = Omit<SessionPayload, 'issuedAt' | 'lastActive' | 'mfa'>;

/**
 * Password was correct. Unprivileged users get a session immediately; admins and
 * superadmins must pass the authenticator-code step first (POST /api/auth/mfa/verify).
 */
async function completePasswordStage(
  identity: Identity,
  subject: string,
  redirect: string,
  secure: boolean,
  ip: string,
): Promise<NextResponse> {
  if (!isPrivileged(identity.role)) {
    const res = NextResponse.json({ ok: true, redirect });
    res.headers.set('Set-Cookie', buildSessionCookie({ ...identity, issuedAt: Date.now(), lastActive: Date.now(), mfa: false }, secure));
    await recordAuditEvent({ actorUserId: identity.userId.length === 36 ? identity.userId : null, actorUsername: identity.username, action: 'login_success', metadata: { ip } });
    return res;
  }

  const state = await getMfaState(subject);
  const isEnv = subject.startsWith('env:');

  if (isEnv && !state.secret) {
    if (process.env.NODE_ENV === 'production') {
      const envName = subject === 'env:superadmin' ? 'SUPERADMIN_TOTP_SECRET' : 'ADMIN_TOTP_SECRET';
      return NextResponse.json(
        { error: `Two-factor login is not configured for this account. Run "npm run mfa:setup" and set ${envName} on the server.` },
        { status: 503 },
      );
    }
    // Local development only: no secret configured yet, so skip the second factor.
    console.warn(`[security] ${subject} signed in WITHOUT MFA because no TOTP secret is set (development only).`);
    const res = NextResponse.json({ ok: true, redirect });
    res.headers.set('Set-Cookie', buildSessionCookie({ ...identity, issuedAt: Date.now(), lastActive: Date.now(), mfa: true }, secure));
    return res;
  }

  let enroll: { secret: string; otpauthUri: string } | undefined;
  if (!state.enrolled) {
    // Only reachable for database admin accounts: show a fresh secret to enroll an authenticator app.
    const secret = await beginEnrollment(subject);
    enroll = { secret, otpauthUri: otpauthUri(secret, identity.username) };
  }

  const res = NextResponse.json({ ok: true, mfaRequired: true, ...(enroll ? { enroll } : {}) });
  res.headers.set('Set-Cookie', buildPendingCookie({ payload: identity, subject, redirect, enroll: Boolean(enroll) }, secure));
  return res;
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
    if (username.length > 120 || password.length > 512) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    const secure = isSecure(req);
    const ip = clientIp(req);
    const rules = loginRules(username, ip);

    // Throttle first: applies equally to the built-in accounts and database users.
    const lockedSecs = await lockedForSeconds(rules.map((r) => r.key));
    if (lockedSecs > 0) {
      return NextResponse.json(
        { error: `Too many failed attempts. Try again in ${Math.ceil(lockedSecs / 60)} minute(s).` },
        { status: 429, headers: { 'Retry-After': String(lockedSecs) } },
      );
    }

    const fail = async (status = 401, error = 'Invalid credentials') => {
      await recordFailure(rules);
      await recordAuditEvent({ actorUserId: null, actorUsername: username, action: 'login_failed', metadata: { ip } });
      return NextResponse.json({ error }, { status });
    };

    // ── Team admin (built-in) ────────────────────────────────────────────────
    if (username === 'team') {
      const pwd = adminPassword();
      if (!pwd) return NextResponse.json({ error: 'Admin login is not configured' }, { status: 503 });
      if (!verifyAdminPassword(password)) return fail();
      return completePasswordStage(
        { userId: 'admin', username: 'team', displayName: 'Team Admin', role: 'admin', memberId: null, teamId: null },
        'env:team', '/team', secure, ip,
      );
    }

    // ── Superadmin (built-in) ────────────────────────────────────────────────
    if (username === 'superadmin') {
      const pwd = superadminPassword();
      if (!pwd) return NextResponse.json({ error: 'Superadmin login is not configured' }, { status: 503 });
      // Timing-safe SHA-256 comparison against the plain env-var secret.
      const a = crypto.createHash('sha256').update(password).digest();
      const b = crypto.createHash('sha256').update(pwd).digest();
      if (!crypto.timingSafeEqual(a, b)) return fail();
      return completePasswordStage(
        { userId: 'superadmin', username: 'superadmin', displayName: 'Super Admin', role: 'superadmin', memberId: null, teamId: null },
        'env:superadmin', '/admin', secure, ip,
      );
    }

    // ── Database users ───────────────────────────────────────────────────────
    const user = await findUserByUsername(username);
    if (!user || !user.active) return fail();

    if (user.locked_until) {
      const lockTime = new Date(user.locked_until).getTime();
      const now = Date.now();
      if (lockTime > now) {
        const remainingMinutes = Math.ceil((lockTime - now) / 60000);
        return NextResponse.json({
          error: `This account is temporarily locked due to too many failed login attempts. Please try again in ${remainingMinutes} minute(s).`
        }, { status: 423 });
      }
    }

    const match = await verifyPassword(password, user.password_hash);
    if (!match) {
      await recordFailedLogin(user.id, user.failed_login_attempts || 0);
      return fail();
    }

    await resetFailedLogin(user.id);

    let userTeamId = user.team_id;
    if (user.role === 'user' && user.member_id) {
      const { rows: tmRows } = await query(
        'SELECT team_id FROM team_members WHERE member_id = $1 ORDER BY created_at ASC LIMIT 1',
        [user.member_id]
      );
      if (tmRows[0]?.team_id) userTeamId = tmRows[0].team_id;
    } else if (!userTeamId && user.member_id) {
      const { rows: tmRows } = await query(
        'SELECT team_id FROM team_members WHERE member_id = $1 LIMIT 1',
        [user.member_id]
      );
      if (tmRows[0]?.team_id) userTeamId = tmRows[0].team_id;
    }

    const redirectUrl = user.role === 'admin' ? '/team' : user.role === 'superadmin' ? '/admin' : '/';
    return completePasswordStage(
      {
        userId: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
        memberId: user.member_id,
        teamId: userTeamId,
      },
      `user:${user.id}`, redirectUrl, secure, ip,
    );
  } catch (err) {
    console.error('[auth/login error]', err);
    return NextResponse.json({ error: 'Sign in failed. Please try again.' }, { status: 500 });
  }
}
