/**
 * POST /api/v1/team/members/reset-password
 * Team Admin or Superadmin resets a team member's user password.
 * Returns new temporary password.
 * Body: { memberId?: string, userId?: string, newPassword?: string, teamId?: string }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getAuthorizedTeamId, getSessionFromCookie, hashPassword } from '@/lib/auth';
import { query } from '@/lib/team/db';
import { recordAuditEvent } from '@/lib/team/audit';
import crypto from 'node:crypto';

export const dynamic = 'force-dynamic';

function randomPassword(): string {
  return `Tracer-${crypto.randomBytes(4).toString('hex')}`;
}

export async function POST(req: NextRequest) {
  try {
    const session = getSessionFromCookie(req.headers.get('cookie'));
    if (!session || (session.role !== 'admin' && session.role !== 'superadmin')) {
      return NextResponse.json({ error: 'admin access required' }, { status: 403 });
    }

    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
    }

    const memberId = body.memberId ? String(body.memberId) : null;
    const userId = body.userId ? String(body.userId) : null;
    const rawTeamId = body.teamId ? String(body.teamId) : null;
    const teamId = getAuthorizedTeamId(req, rawTeamId);

    if (!teamId && session.role !== 'superadmin') {
      return NextResponse.json({ error: 'unauthorized team access' }, { status: 401 });
    }

    if (!memberId && !userId) {
      return NextResponse.json({ error: 'memberId or userId required' }, { status: 400 });
    }

    // Verify member belongs to team if team admin
    if (session.role !== 'superadmin' && teamId) {
      if (memberId) {
        const { rows: tmCheck } = await query(
          'SELECT 1 FROM team_members WHERE team_id = $1 AND member_id = $2',
          [teamId, memberId]
        );
        if (tmCheck.length === 0) {
          return NextResponse.json({ error: 'member does not belong to your team' }, { status: 403 });
        }
      } else if (userId) {
        const { rows: uCheck } = await query(
          `SELECT 1 FROM users u
           JOIN team_members tm ON tm.member_id = u.member_id
           WHERE tm.team_id = $1 AND u.id = $2`,
          [teamId, userId]
        );
        if (uCheck.length === 0) {
          return NextResponse.json({ error: 'user does not belong to your team' }, { status: 403 });
        }
      }
    }

    const newPassword = String(body.newPassword || randomPassword()).trim();
    if (newPassword.length < 6) {
      return NextResponse.json({ error: 'Password must be at least 6 characters' }, { status: 400 });
    }

    const passwordHash = await hashPassword(newPassword);

    let updatedUserId: string | null = null;
    let targetUsername: string | null = null;

    if (userId) {
      const { rows } = await query(
        'UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2 RETURNING id, username',
        [passwordHash, userId]
      );
      if (rows[0]) {
        updatedUserId = rows[0].id;
        targetUsername = rows[0].username;
      }
    } else if (memberId) {
      const { rows } = await query(
        'UPDATE users SET password_hash = $1, updated_at = now() WHERE member_id = $2 RETURNING id, username',
        [passwordHash, memberId]
      );
      if (rows[0]) {
        updatedUserId = rows[0].id;
        targetUsername = rows[0].username;
      } else {
        // If user account doesn't exist yet for this member, create one
        const { rows: memRows } = await query<{ display_name: string }>(
          'SELECT display_name FROM members WHERE id = $1',
          [memberId]
        );
        if (!memRows[0]) return NextResponse.json({ error: 'member not found' }, { status: 404 });

        const displayName = memRows[0].display_name;
        const username = displayName.toLowerCase().replace(/[^a-z0-9]/g, '.') || `dev.${memberId.slice(0, 4)}`;
        const { rows: newUser } = await query(
          `INSERT INTO users (username, password_hash, display_name, member_id, team_id, role, active)
           VALUES ($1, $2, $3, $4, $5, 'user', true)
           RETURNING id, username`,
          [username, passwordHash, displayName, memberId, teamId]
        );
        updatedUserId = newUser[0].id;
        targetUsername = newUser[0].username;
      }
    }

    if (!updatedUserId) {
      return NextResponse.json({ error: 'user account not found' }, { status: 404 });
    }

    await recordAuditEvent({
      actorUserId: session.userId,
      actorUsername: session.username,
      action: 'team.user.reset-password',
      targetType: 'user',
      targetId: updatedUserId,
      metadata: { targetUsername, teamId },
    });

    return NextResponse.json({
      ok: true,
      username: targetUsername,
      newPassword,
      message: 'Password reset successfully',
    });
  } catch (err) {
    console.error('[team/members/reset-password error]', err);
    return NextResponse.json({ error: String((err as Error).message || err) }, { status: 500 });
  }
}
