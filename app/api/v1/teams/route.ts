import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie, isAdminRole } from '@/lib/auth';
import { query } from '@/lib/team/db';
import { publicError } from '@/lib/security/errors';

export const dynamic = 'force-dynamic';

function requireAdmin(req: NextRequest): boolean {
  const session = getSessionFromCookie(req.headers.get('cookie'));
  return session?.role === 'admin' || session?.role === 'superadmin' || session?.role === 'user';
}

export async function GET(req: NextRequest) {
  try {
    if (!requireAdmin(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    const session = getSessionFromCookie(req.headers.get('cookie'));
    const isUuid = (val: string | null | undefined): boolean =>
      Boolean(val && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val));

    if (session && (session.role === 'admin' || session.role === 'user')) {
      const hasTeam = isUuid(session.teamId);
      const hasUser = isUuid(session.userId);
      if (hasTeam || hasUser) {
        const { rows } = await query(
          `SELECT DISTINCT t.id, t.name, t.created_at
           FROM teams t
           WHERE ($1::uuid IS NOT NULL AND t.id = $1::uuid)
              OR ($2::uuid IS NOT NULL AND t.id IN (SELECT tm.team_id FROM team_members tm JOIN users u ON u.member_id = tm.member_id WHERE u.id = $2::uuid))
           ORDER BY t.created_at DESC`,
          [hasTeam ? session.teamId : null, hasUser ? session.userId : null],
        );
        return NextResponse.json({ teams: rows });
      }
    }

    const { rows } = await query('SELECT id, name, created_at FROM teams ORDER BY created_at DESC');
    return NextResponse.json({ teams: rows });
  } catch (err) {
    console.error('[teams GET error]', err);
    return NextResponse.json({ error: publicError(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    // Creating teams is an admin action — plain members must not be able to.
    if (!isAdminRole(getSessionFromCookie(req.headers.get('cookie')))) {
      return NextResponse.json({ error: 'admin access required' }, { status: 403 });
    }
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
    }
    if (!body.name) return NextResponse.json({ error: 'name required' }, { status: 400 });
    const { rows } = await query(
      'INSERT INTO teams (name) VALUES ($1) RETURNING id, name, created_at',
      [body.name],
    );
    return NextResponse.json({ team: rows[0] }, { status: 201 });
  } catch (err) {
    console.error('[teams POST error]', err);
    return NextResponse.json({ error: publicError(err) }, { status: 500 });
  }
}
