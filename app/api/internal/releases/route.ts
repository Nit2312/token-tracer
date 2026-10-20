/**
 * /api/internal/releases — Admin CRUD for daemon releases.
 *
 * Protected by existing admin/superadmin cookie session (same as /team dashboard).
 * All routes require a valid session cookie.
 *
 * GET    ?teamId=   → list all releases (newest first)
 * POST              → create / activate a new release
 *   body: { version, downloadUrl, sha256, mandatory?, releaseNotes? }
 * PATCH             → activate or deactivate a release (rollback)
 *   body: { id, active }
 * DELETE ?id=       → permanently delete a release record
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/auth';
import { query } from '@/lib/team/db';
import { publicError } from '@/lib/security/errors';

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
    const { rows } = await query(
      `SELECT id, version, download_url, sha256, mandatory, active, release_notes, released_at
         FROM daemon_releases
        ORDER BY released_at DESC`,
    );
    return NextResponse.json({ releases: rows });
  } catch (err) {
    console.error('[releases GET error]', err);
    return NextResponse.json({ error: publicError(err) }, { status: 500 });
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

  // Validate sha256 looks like a hex string (64 chars)
  if (!/^[0-9a-f]{64}$/i.test(sha256)) {
    return NextResponse.json(
      { error: 'sha256 must be a 64-character hex string' },
      { status: 400 },
    );
  }

  // Validate URL is HTTPS (security requirement)
  if (!downloadUrl.startsWith('https://')) {
    return NextResponse.json(
      { error: 'downloadUrl must use HTTPS' },
      { status: 400 },
    );
  }

  // Domain whitelist check for security
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
    const { rows } = await query(
      `INSERT INTO daemon_releases (version, download_url, sha256, mandatory, active, release_notes)
       VALUES ($1, $2, $3, $4, true, $5)
       ON CONFLICT (version) DO UPDATE
         SET download_url = EXCLUDED.download_url,
             sha256 = EXCLUDED.sha256,
             mandatory = EXCLUDED.mandatory,
             active = true,
             release_notes = EXCLUDED.release_notes,
             released_at = now()
       RETURNING *`,
      [version, downloadUrl, sha256, mandatory, releaseNotes],
    );
    return NextResponse.json({ release: rows[0] }, { status: 201 });
  } catch (err) {
    console.error('[releases POST error]', err);
    return NextResponse.json({ error: publicError(err) }, { status: 500 });
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
    const { rows } = await query(
      `UPDATE daemon_releases SET active = $1 WHERE id = $2 RETURNING *`,
      [body.active, id],
    );
    if (!rows.length) return NextResponse.json({ error: 'release not found' }, { status: 404 });
    return NextResponse.json({ release: rows[0] });
  } catch (err) {
    console.error('[releases PATCH error]', err);
    return NextResponse.json({ error: publicError(err) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession(req);
  if (!isSuperadmin(session)) return unauthorized();


  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  try {
    const { rowCount } = await query(
      `DELETE FROM daemon_releases WHERE id = $1`,
      [id],
    );
    if (!rowCount) return NextResponse.json({ error: 'release not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[releases DELETE error]', err);
    return NextResponse.json({ error: publicError(err) }, { status: 500 });
  }
}
