/**
 * POST /api/internal/releases/publish-current  { mandatory?, releaseNotes? }
 * Superadmin publishes the daemon this deployment is currently serving at /sync-daemon.mjs
 * as the active release. The version is read from the file's DAEMON_VERSION and the SHA-256
 * is computed from the exact bytes clients will download, so nothing is typed by hand.
 */
import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/auth';
import { query } from '@/lib/team/db';
import { recordAuditEvent } from '@/lib/team/audit';
import { publicError } from '@/lib/security/errors';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSessionFromCookie(req.headers.get('cookie'));
  if (!session || session.role !== 'superadmin') {
    return NextResponse.json({ error: 'superadmin access required' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const mandatory = Boolean(body?.mandatory ?? false);
  const releaseNotes = body?.releaseNotes ? String(body.releaseNotes).trim().slice(0, 2000) : null;

  try {
    const origin = req.nextUrl.origin;
    const downloadUrl = `${origin}/sync-daemon.mjs`;
    const res = await fetch(downloadUrl, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (!res.ok) {
      return NextResponse.json({ error: `could not read ${downloadUrl} (HTTP ${res.status})` }, { status: 502 });
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    const source = bytes.toString('utf8');

    const version = /DAEMON_VERSION\s*=\s*["'](\d+\.\d+\.\d+)["']/.exec(source)?.[1];
    if (!version) {
      return NextResponse.json({ error: 'DAEMON_VERSION not found in sync-daemon.mjs' }, { status: 422 });
    }
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

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

    await recordAuditEvent({
      actorUserId: session.userId,
      actorUsername: session.username,
      action: 'daemon.publish-release',
      targetType: 'daemon_release',
      targetId: rows[0]?.id ?? null,
      metadata: { version, mandatory },
    });

    return NextResponse.json({ release: rows[0] }, { status: 201 });
  } catch (err) {
    console.error('[releases publish-current error]', err);
    return NextResponse.json({ error: publicError(err) }, { status: 500 });
  }
}
