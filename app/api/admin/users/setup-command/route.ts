/**
 * POST /api/admin/users/setup-command  { id }
 * Superadmin fetches the daemon install commands (with the user's ingest API key) so a
 * device can be onboarded or re-onboarded at any time. Generates a key if the user is
 * linked to a member but has none yet. Every reveal is audit-logged.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/auth';
import { generateApiKey, hashApiKey } from '@/lib/team/auth';
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
  const id = String(body?.id || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json({ error: 'valid user id required' }, { status: 400 });
  }

  try {
    const { rows } = await query(`SELECT id, username, member_id, api_key FROM users WHERE id = $1`, [id]);
    const user = rows[0];
    if (!user) return NextResponse.json({ error: 'user not found' }, { status: 404 });

    let apiKey: string | null = user.api_key || null;
    let generated = false;
    if (!apiKey && user.member_id) {
      apiKey = generateApiKey();
      await query(
        `INSERT INTO member_keys (member_id, key_hash, label)
         VALUES ($1, $2, 'default')
         ON CONFLICT (key_hash) DO NOTHING`,
        [user.member_id, hashApiKey(apiKey)],
      );
      await query(`UPDATE users SET api_key = $2, updated_at = now() WHERE id = $1`, [id, apiKey]);
      generated = true;
    }

    await recordAuditEvent({
      actorUserId: session.userId,
      actorUsername: session.username,
      action: 'user.reveal-setup-command',
      targetType: 'user',
      targetId: id,
      metadata: { generatedKey: generated },
    });

    const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || 'https://token-tracer-three.vercel.app';
    return NextResponse.json({
      apiKey,
      installCommandMac: apiKey
        ? `curl -fsSL ${serverUrl}/install.sh | bash -s -- --key ${apiKey}`
        : null,
      installCommandWin: apiKey
        ? `$ApiKey="${apiKey}"; iex (irm ${serverUrl}/install.ps1)`
        : null,
    });
  } catch (err) {
    return NextResponse.json({ error: publicError(err) }, { status: 500 });
  }
}
