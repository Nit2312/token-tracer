/**
 * POST /api/auth/mfa/verify  { code }
 * Second step of admin/superadmin login. Requires the signed `mfa_pending` cookie set by
 * /api/auth/login after the password was accepted. On success issues the real session.
 */
import { NextRequest, NextResponse } from 'next/server';
import { buildSessionCookie } from '@/lib/auth';
import {
  claimStep, clearFailures, confirmEnrollment, getMfaState,
  lockedForSeconds, loginRules, recordFailure,
} from '@/lib/security/auth-store';
import { clearPendingCookie, readPending } from '@/lib/security/mfa-flow';
import { verifyTotp } from '@/lib/security/totp';
import { clientIp } from '@/lib/security/request';
import { recordAuditEvent } from '@/lib/team/audit';

export const dynamic = 'force-dynamic';

function isSecure(req: NextRequest): boolean {
  const host = req.headers.get('host') || '';
  const isLocalhost = host.includes('localhost') || host.includes('127.0.0.1');
  return !isLocalhost && (process.env.VERCEL === '1' || req.headers.get('x-forwarded-proto') === 'https');
}

export async function POST(req: NextRequest) {
  try {
    const secure = isSecure(req);
    const pending = readPending(req.headers.get('cookie'));
    if (!pending) {
      return NextResponse.json({ error: 'Your sign-in expired. Enter your password again.', restart: true }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const code = String(body?.code ?? '').replace(/\s/g, '');

    const ip = clientIp(req);
    const username = pending.payload.username;
    const rules = loginRules(username, ip);

    const lockedSecs = await lockedForSeconds(rules.map((r) => r.key));
    if (lockedSecs > 0) {
      return NextResponse.json(
        { error: `Too many failed attempts. Try again in ${Math.ceil(lockedSecs / 60)} minute(s).`, restart: true },
        { status: 429, headers: { 'Retry-After': String(lockedSecs) } },
      );
    }

    const actorId = pending.payload.userId.length === 36 ? pending.payload.userId : null;
    const reject = async (error: string) => {
      await recordFailure(rules);
      await recordAuditEvent({ actorUserId: actorId, actorUsername: username, action: 'mfa_failed', metadata: { ip } });
      return NextResponse.json({ error }, { status: 401 });
    };

    const state = await getMfaState(pending.subject);
    if (!state.secret) return reject('Two-factor login is not set up for this account.');

    const step = verifyTotp(state.secret, code);
    if (step === null) return reject('Invalid code. Check your authenticator app and try again.');

    // Each code works once: reject a replay of an already-used time step.
    if (!(await claimStep(pending.subject, step))) {
      return reject('That code was already used. Wait for the next one.');
    }

    if (pending.enroll) await confirmEnrollment(pending.subject);
    await clearFailures(rules.map((r) => r.key));
    await recordAuditEvent({ actorUserId: actorId, actorUsername: username, action: 'login_success', metadata: { ip, mfa: true, enrolled: pending.enroll } });

    const now = Date.now();
    const res = NextResponse.json({ ok: true, redirect: pending.redirect });
    res.headers.append('Set-Cookie', buildSessionCookie({ ...pending.payload, issuedAt: now, lastActive: now, mfa: true }, secure));
    res.headers.append('Set-Cookie', clearPendingCookie(secure));
    return res;
  } catch (err) {
    console.error('[auth/mfa/verify error]', err);
    return NextResponse.json({ error: 'Verification failed. Please try again.' }, { status: 500 });
  }
}
