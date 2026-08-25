import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/auth';
import { queryCol, setDocById, deleteDocById, newUuid } from '@/lib/team/db';

export const dynamic = 'force-dynamic';

function getSession(req: NextRequest) {
  const cookieHeader = req.headers.get('cookie') || '';
  return getSessionFromCookie(cookieHeader);
}

function unauthorized() {
  return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
}

function isAdmin(session: ReturnType<typeof getSessionFromCookie>) {
  return session && (session.role === 'admin' || session.role === 'superadmin');
}

function isSuperadmin(session: ReturnType<typeof getSessionFromCookie>) {
  return session && session.role === 'superadmin';
}

export async function GET(req: NextRequest) {
  const session = getSession(req);
  if (!isAdmin(session)) return unauthorized();

  try {
    const releases = await queryCol<any>('daemon_releases', [
      { type: 'orderBy', field: 'released_at', direction: 'desc' },
    ]);
    return NextResponse.json({ releases });
  } catch (err) {
    console.error('[releases GET error]', err);
    return NextResponse.json({ error: String((err as Error).message || err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession(req);
  if (!isSuperadmin(session)) return unauthorized();

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const version = String(body.version || '').trim();
  const downloadUrl = String(body.downloadUrl || '').trim();
  const sha256 = String(body.sha256 || '').trim();
  const mandatory = Boolean(body.mandatory ?? false);
  const releaseNotes = body.releaseNotes ? String(body.releaseNotes).trim() : null;

  if (!version || !downloadUrl || !sha256) {
    return NextResponse.json(
      { error: 'version, downloadUrl, and sha256 are required' },
      { status: 400 },
    );
  }

  if (!/^[0-9a-f]{64}$/i.test(sha256)) {
    return NextResponse.json(
      { error: 'sha256 must be a 64-character hex string' },
      { status: 400 },
    );
  }

  if (!downloadUrl.startsWith('https://')) {
    return NextResponse.json(
      { error: 'downloadUrl must use HTTPS' },
      { status: 400 },
    );
  }

  try {
    const parsedUrl = new URL(downloadUrl);
    const host = parsedUrl.hostname.toLowerCase();
    const requestHost = req.headers.get('host')?.split(':')[0]?.toLowerCase();
    const envServerUrl = process.env.NEXT_PUBLIC_SERVER_URL ? new URL(process.env.NEXT_PUBLIC_SERVER_URL).hostname.toLowerCase() : null;

    const isHostValid =
      (requestHost && host === requestHost) ||
      (envServerUrl && host === envServerUrl) ||
      host === 'github.com' ||
      host === 'raw.githubusercontent.com' ||
      host.endsWith('.github.com') ||
      host.endsWith('.githubusercontent.com') ||
      host === 'localhost' ||
      host === '127.0.0.1';

    if (!isHostValid) {
      return NextResponse.json(
        { error: 'downloadUrl domain is not whitelisted. Only same-origin URLs or github.com are permitted.' },
        { status: 400 }
      );
    }
  } catch (err) {
    return NextResponse.json(
      { error: 'Invalid downloadUrl' },
      { status: 400 }
    );
  }

  try {
    const existing = await queryCol<any>('daemon_releases', [
      { type: 'where', field: 'version', op: '==', value: version },
      { type: 'limit', n: 1 },
    ]);

    const id = existing[0]?.id || newUuid();
    const doc = {
      id,
      version,
      download_url: downloadUrl,
      sha256,
      mandatory,
      active: true,
      release_notes: releaseNotes,
      released_at: new Date().toISOString(),
    };

    await setDocById('daemon_releases', id, doc, true);
    return NextResponse.json({ release: doc }, { status: 201 });
  } catch (err) {
    console.error('[releases POST error]', err);
    return NextResponse.json({ error: String((err as Error).message || err) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const session = getSession(req);
  if (!isSuperadmin(session)) return unauthorized();

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const id = String(body.id || '').trim();
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  if (typeof body.active !== 'boolean') {
    return NextResponse.json({ error: 'active (boolean) required' }, { status: 400 });
  }

  try {
    const { getDocById } = await import('@/lib/team/db');
    const existing = await getDocById('daemon_releases', id);
    if (!existing) return NextResponse.json({ error: 'release not found' }, { status: 404 });

    const updated = { ...existing, active: body.active, updated_at: new Date().toISOString() };
    await setDocById('daemon_releases', id, updated, true);
    return NextResponse.json({ release: updated });
  } catch (err) {
    console.error('[releases PATCH error]', err);
    return NextResponse.json({ error: String((err as Error).message || err) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession(req);
  if (!isSuperadmin(session)) return unauthorized();

  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  try {
    await deleteDocById('daemon_releases', id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[releases DELETE error]', err);
    return NextResponse.json({ error: String((err as Error).message || err) }, { status: 500 });
  }
}
