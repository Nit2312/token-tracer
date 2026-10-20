/**
 * POST /api/admin/users/reset-password
 * Superadmin resets a user password. Returns new temporary password.
 * Body: { id: string, newPassword?: string }
 * If newPassword is omitted, generates a random 12-char password.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie, hashPassword } from '@/lib/auth';
import { query } from '@/lib/team/db';
import { recordAuditEvent } from '@/lib/team/audit';
import crypto from 'node:crypto';
import { publicError } from '@/lib/security/errors';

export const dynamic = 'force-dynamic';

function randomPassword(): string {
  // 12 chars: letters + digits, easy to type
  return crypto.randomBytes(9).toString('base64url').slice(0, 12);
}

export async function POST(req: NextRequest) {
  const session = getSessionFromCookie(req.headers.get('cookie'));
  if (!session || session.role !== 'superadmin') {
    return NextResponse.json({ error: 'superadmin access required' }, { status: 403 });
  }

  try {
    const body = await req.json();
    const id = String(body.id || '');
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

    const newPassword = String(body.newPassword || randomPassword());
    const passwordHash = await hashPassword(newPassword);

    const { rowCount } = await query(
      'UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2',
      [passwordHash, id],
    );

    if (!rowCount) return NextResponse.json({ error: 'user not found' }, { status: 404 });

    await recordAuditEvent({
      actorUserId: session.userId,
      actorUsername: session.username,
      action: 'user.reset-password',
      targetType: 'user',
      targetId: id,
    });

    // Return the new password once (it will not be stored in plain text anywhere)
    return NextResponse.json({ ok: true, newPassword });
  } catch (err) {
    return NextResponse.json({ error: publicError(err) }, { status: 500 });
  }
}
