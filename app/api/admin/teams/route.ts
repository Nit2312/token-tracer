import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/auth';
import { setDocById, getDocById, deleteDocById, newUuid } from '@/lib/team/db';

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
    if (!name) return NextResponse.json({ error: 'team name is required' }, { status: 400 });

    const id = newUuid();
    await setDocById('teams', id, { id, name, created_at: new Date().toISOString() });

    return NextResponse.json({ team: { id, name } }, { status: 201 });
  } catch (err: any) {
    console.error('[admin/teams POST error]', err);
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  if (!requireSuperadmin(req)) return NextResponse.json({ error: 'superadmin access required' }, { status: 403 });

  try {
    const body = await req.json();
    const { id, name } = body;
    const trimmedName = String(name || '').trim();
    if (!id || !trimmedName) return NextResponse.json({ error: 'id and team name are required' }, { status: 400 });

    const existing = await getDocById('teams', id);
    if (!existing) return NextResponse.json({ error: 'team not found' }, { status: 404 });

    await setDocById('teams', id, { name: trimmedName, updated_at: new Date().toISOString() }, true);

    return NextResponse.json({ team: { id, name: trimmedName } });
  } catch (err: any) {
    console.error('[admin/teams PUT error]', err);
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!requireSuperadmin(req)) return NextResponse.json({ error: 'superadmin access required' }, { status: 403 });

  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  try {
    await deleteDocById('teams', id);
    return NextResponse.json({ ok: true, deleted: true });
  } catch (err: any) {
    console.error('[admin/teams DELETE error]', err);
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
