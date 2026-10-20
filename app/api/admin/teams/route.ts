import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/auth';
import { query } from '@/lib/team/db';
import { publicError } from '@/lib/security/errors';

export const dynamic = 'force-dynamic';

function requireSuperadmin(req: NextRequest): boolean {
  const session = getSessionFromCookie(req.headers.get('cookie'));
  return session?.role === 'superadmin';
}

export async function POST(req: NextRequest) {
  if (!requireSuperadmin(req)) return NextResponse.json({ error: 'superadmin access required' }, { status: 403 });

  try {
    const body = await req.json();
    const name = String(body.name || '').trim();

    if (!name) {
      return NextResponse.json({ error: 'team name is required' }, { status: 400 });
    }

    const { rows } = await query(
      `INSERT INTO teams (name) VALUES ($1) RETURNING id, name`,
      [name]
    );

    return NextResponse.json({ team: rows[0] }, { status: 201 });
  } catch (err: any) {
    console.error('[admin/teams POST error]', err);
    return NextResponse.json({ error: publicError(err) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  if (!requireSuperadmin(req)) return NextResponse.json({ error: 'superadmin access required' }, { status: 403 });

  try {
    const body = await req.json();
    const { id, name } = body;
    const trimmedName = String(name || '').trim();

    if (!id || !trimmedName) {
      return NextResponse.json({ error: 'id and team name are required' }, { status: 400 });
    }

    const { rows } = await query(
      `UPDATE teams SET name = $2 WHERE id = $1 RETURNING id, name`,
      [id, trimmedName]
    );

    if (!rows[0]) {
      return NextResponse.json({ error: 'team not found' }, { status: 404 });
    }

    return NextResponse.json({ team: rows[0] });
  } catch (err: any) {
    console.error('[admin/teams PUT error]', err);
    return NextResponse.json({ error: publicError(err) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!requireSuperadmin(req)) return NextResponse.json({ error: 'superadmin access required' }, { status: 403 });

  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  try {
    const { rowCount } = await query('DELETE FROM teams WHERE id = $1', [id]);
    return NextResponse.json({ ok: true, deleted: (rowCount || 0) > 0 });
  } catch (err: any) {
    console.error('[admin/teams DELETE error]', err);
    return NextResponse.json({ error: publicError(err) }, { status: 500 });
  }
}
