import { NextRequest, NextResponse } from 'next/server';
import { getAuthorizedTeamId, getSessionFromCookie } from '@/lib/auth';
import { createMemberWithKey, createTeamUserWithMember, updateMember, deleteMember } from '@/lib/team/stats';
import { query } from '@/lib/team/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const rawTeamId = req.nextUrl.searchParams.get('teamId') || req.nextUrl.searchParams.get('team_id');
    const teamId = getAuthorizedTeamId(req, rawTeamId);
    if (!teamId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const isUuid = (val: string | null | undefined): boolean =>
      Boolean(val && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val));

    if (!isUuid(teamId)) {
      return NextResponse.json({ members: [] });
    }

    const session = getSessionFromCookie(req.headers.get('cookie'));
    let memberFilter = '';
    const queryParams: any[] = [teamId];
    if (session?.role === 'user') {
      memberFilter = ' AND m.id = $2';
      queryParams.push(session.memberId);
    }

    const { rows: members } = await query(
      `SELECT m.id, m.display_name, tm.role, m.created_at, m.sync_requested_at,
              m.daemon_version, m.daemon_last_seen_at,
              u.id AS user_id, u.username, u.active AS user_active, u.role AS user_role, u.api_key,
              (u.id IS NOT NULL) AS has_user_account,
              GREATEST(
                (SELECT max(created_at) FROM ingest_events e WHERE e.member_id = m.id),
                (SELECT max(COALESCE(s.ended_at, s.started_at, s.synced_at)) FROM sync_sessions s WHERE s.member_id = m.id),
                (SELECT max(k.last_used_at) FROM member_keys k WHERE k.member_id = m.id)
              ) AS last_sync_at,
              (SELECT count(*) FROM sync_sessions s WHERE s.member_id = m.id)::int AS session_count,
              (SELECT coalesce(sum(s.tokens_in + s.tokens_out), 0) FROM sync_sessions s WHERE s.member_id = m.id)::bigint AS total_tokens,
              (SELECT coalesce(sum(s.api_cost), 0) FROM sync_sessions s WHERE s.member_id = m.id)::float AS total_cost
       FROM team_members tm
       JOIN members m ON m.id = tm.member_id
       LEFT JOIN users u ON u.member_id = m.id
       WHERE tm.team_id = $1${memberFilter}
       ORDER BY m.display_name`,
      queryParams,
    );

    const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || req.nextUrl.origin || 'https://token-tracer-three.vercel.app';
    const enrichedMembers = members.map((m: any) => {
      const apiKey = m.api_key || null;
      return {
        ...m,
        installCommandMac: apiKey ? `curl -fsSL ${serverUrl}/install.sh | bash -s -- --key ${apiKey}` : null,
        installCommandWin: apiKey ? `$ApiKey="${apiKey}"; iex (irm ${serverUrl}/install.ps1)` : null,
      };
    });

    return NextResponse.json({ members: enrichedMembers });

  } catch (err) {
    console.error('[team/members GET error]', err);
    return NextResponse.json({ error: String((err as Error).message || err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
    }
    const rawTeamId = body.teamId ? String(body.teamId) : null;
    const teamId = getAuthorizedTeamId(req, rawTeamId);
    if (!teamId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    if (!body.displayName) return NextResponse.json({ error: 'displayName required' }, { status: 400 });

    const result = await createTeamUserWithMember({
      teamId,
      displayName: String(body.displayName).trim(),
      username: body.username ? String(body.username).trim() : null,
      password: body.password ? String(body.password).trim() : null,
      role: String(body.role ?? 'member'),
    });

    const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || req.nextUrl.origin || 'https://token-tracer-three.vercel.app';
    const installCommandMac = `curl -fsSL ${serverUrl}/install.sh | bash -s -- --key ${result.apiKey}`;
    const installCommandWin = `$ApiKey="${result.apiKey}"; iex (irm ${serverUrl}/install.ps1)`;

    return NextResponse.json({
      ok: true,
      member: result.member,
      user: result.user,
      tempPassword: result.tempPassword,
      apiKey: result.apiKey,
      teams: result.teams,
      installCommandMac,
      installCommandWin,
    }, { status: 201 });
  } catch (err) {
    console.error('[team/members POST error]', err);
    return NextResponse.json({ error: String((err as Error).message || err) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
    }
    const rawTeamId = body.teamId ? String(body.teamId) : null;
    const teamId = getAuthorizedTeamId(req, rawTeamId);
    if (!teamId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    if (!body.id || !body.displayName) {
      return NextResponse.json({ error: 'id and displayName required' }, { status: 400 });
    }

    const member = await updateMember(
      String(body.id),
      teamId,
      String(body.displayName).trim(),
      String(body.role ?? 'member'),
    );
    if (!member) return NextResponse.json({ error: 'member not found' }, { status: 404 });

    // Also update linked user profile if username / active status passed
    const cleanUsername = body.username ? String(body.username).trim().toLowerCase() : null;
    if (cleanUsername) {
      if (cleanUsername.length < 2) {
        return NextResponse.json({ error: 'Username must be at least 2 characters' }, { status: 400 });
      }
      const reserved = ['team', 'superadmin', 'admin', 'root', 'api', 'system', 'dashboard'];
      if (reserved.includes(cleanUsername)) {
        return NextResponse.json({ error: 'This username is reserved' }, { status: 409 });
      }
      const { rows: existing } = await query(
        'SELECT id FROM users WHERE LOWER(username) = $1 AND member_id != $2',
        [cleanUsername, String(body.id)]
      );
      if (existing.length > 0) {
        return NextResponse.json({ error: `Username '${cleanUsername}' is already taken.` }, { status: 409 });
      }
    }

    await query(
      `UPDATE users SET
         display_name = COALESCE($1, display_name),
         username = COALESCE($2, username),
         active = COALESCE($3, active),
         role = COALESCE($4, role),
         updated_at = now()
       WHERE member_id = $5`,
      [
        String(body.displayName).trim(),
        cleanUsername,
        body.active !== undefined ? Boolean(body.active) : null,
        body.role === 'admin' ? 'admin' : (body.role ? 'user' : null),
        String(body.id),
      ]
    );

    return NextResponse.json({ ok: true, member });
  } catch (err) {
    console.error('[team/members PUT error]', err);
    return NextResponse.json({ error: String((err as Error).message || err) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get('id');
    const rawTeamId = req.nextUrl.searchParams.get('teamId');
    const hard = req.nextUrl.searchParams.get('hard') === 'true';
    const teamId = getAuthorizedTeamId(req, rawTeamId);
    if (!teamId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

    const session = getSessionFromCookie(req.headers.get('cookie'));
    if (session?.memberId === id) {
      return NextResponse.json({ error: 'You cannot remove your own administrator account' }, { status: 400 });
    }

    if (hard) {
      await query('DELETE FROM users WHERE member_id = $1', [id]);
      await query('DELETE FROM team_members WHERE member_id = $1', [id]);
      await query('DELETE FROM member_keys WHERE member_id = $1', [id]);
      await query('DELETE FROM members WHERE id = $1', [id]);
      return NextResponse.json({ ok: true, deleted: true, hard: true });
    }

    const res = await deleteMember(id, teamId);
    return NextResponse.json(res);
  } catch (err) {
    console.error('[team/members DELETE error]', err);
    return NextResponse.json({ error: String((err as Error).message || err) }, { status: 500 });
  }
}
