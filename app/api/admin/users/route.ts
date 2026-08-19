/**
 * CRUD for users table — superadmin only.
 *
 * GET    /api/admin/users          → list all users with linked member info
 * POST   /api/admin/users          → create a user (hashes password, generates API key if memberId given)
 * PUT    /api/admin/users          → update display name, role, active, memberId
 * DELETE /api/admin/users?id=uuid  → hard delete a user
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie, hashPassword } from '@/lib/auth';
import { generateApiKey, hashApiKey } from '@/lib/team/auth';
import { query } from '@/lib/team/db';
import { recordAuditEvent } from '@/lib/team/audit';

export const dynamic = 'force-dynamic';

function requireSuperadmin(req: NextRequest): boolean {
  const session = getSessionFromCookie(req.headers.get('cookie'));
  return session?.role === 'superadmin';
}

export async function GET(req: NextRequest) {
  if (!requireSuperadmin(req)) return NextResponse.json({ error: 'superadmin access required' }, { status: 403 });

  try {
    const { rows } = await query(`
      SELECT u.id, u.username, u.display_name, u.role, u.active,
             u.member_id, u.team_id, u.last_login_at, u.created_at, u.updated_at,
             m.display_name AS member_name,
             m.daemon_version, m.daemon_last_seen_at,
             COALESCE(
               (SELECT string_agg(t.name, ', ')
                FROM team_members tm
                JOIN teams t ON t.id = tm.team_id
                WHERE tm.member_id = u.member_id),
               t.name,
               '—'
             ) AS team_name,
             COALESCE(
               (SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'role', tm.role))
                FROM team_members tm
                JOIN teams t ON t.id = tm.team_id
                WHERE tm.member_id = u.member_id),
               '[]'::json
             ) AS teams,
             (u.api_key IS NOT NULL) AS has_api_key,
             (SELECT count(*)::int FROM sync_sessions s WHERE s.member_id = u.member_id) AS session_count,
             (SELECT max(COALESCE(s.ended_at, s.started_at)) FROM sync_sessions s WHERE s.member_id = u.member_id) AS last_session_at
      FROM users u
      LEFT JOIN members m ON m.id = u.member_id
      LEFT JOIN teams t ON t.id = u.team_id
      ORDER BY u.created_at ASC
    `);

    // Also fetch members that have no user account (to help with linking)
    const { rows: unlinkedMembers } = await query(`
      SELECT m.id, m.display_name, m.team_id,
             COALESCE(
               (SELECT string_agg(t.name, ', ')
                FROM team_members tm
                JOIN teams t ON t.id = tm.team_id
                WHERE tm.member_id = m.id),
               t.name,
               'Independent'
             ) AS team_name,
             COALESCE(
               (SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'role', tm.role))
                FROM team_members tm
                JOIN teams t ON t.id = tm.team_id
                WHERE tm.member_id = m.id),
               '[]'::json
             ) AS teams
      FROM members m
      LEFT JOIN teams t ON t.id = m.team_id
      WHERE m.id NOT IN (SELECT member_id FROM users WHERE member_id IS NOT NULL)
      ORDER BY m.display_name
    `);

    // Also fetch all teams with accurate member counts
    const { rows: teams } = await query(`
      SELECT t.id, t.name,
             (SELECT count(DISTINCT tm.member_id)::int FROM team_members tm WHERE tm.team_id = t.id) AS member_count
      FROM teams t
      ORDER BY t.name
    `);

    return NextResponse.json({ users: rows, unlinkedMembers, teams });
  } catch (err: any) {
    const errMsg = String(err?.message || err);
    if (errMsg.includes('relation "users" does not exist')) {
      return NextResponse.json({ users: [], unlinkedMembers: [], teams: [], needsMigration: true });
    }
    return NextResponse.json({ error: errMsg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!requireSuperadmin(req)) return NextResponse.json({ error: 'superadmin access required' }, { status: 403 });
  const actorSession = getSessionFromCookie(req.headers.get('cookie'));

  try {
    const body = await req.json();
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const displayName = String(body.displayName || body.display_name || '').trim();
    const memberId = body.memberId || body.member_id || null;
    const teamId = body.teamId || body.team_id || null;
    const teamIds: string[] = Array.isArray(body.teamIds) ? body.teamIds : (teamId ? [teamId] : []);
    const role = String(body.role || 'user');
    const newTeamName = String(body.newTeamName || '').trim();

    if (!username || !password || !displayName) {
      return NextResponse.json({ error: 'username, password, and displayName are required' }, { status: 400 });
    }

    if (password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters long' }, { status: 400 });
    }
    if (!['user', 'admin', 'superadmin'].includes(role)) {
      return NextResponse.json({ error: 'invalid role' }, { status: 400 });
    }

    // Validate username format
    if (username.length < 2) {
      return NextResponse.json({ error: 'Username must be at least 2 characters long' }, { status: 400 });
    }
    if (!/^[a-z0-9_.-]+$/.test(username)) {
      return NextResponse.json({ error: 'Username can only contain letters, numbers, dots, hyphens, and underscores' }, { status: 400 });
    }

    // Reserved usernames check
    const reservedUsernames = ['team', 'superadmin', 'admin', 'root', 'api', 'system', 'dashboard'];
    if (reservedUsernames.includes(username)) {
      return NextResponse.json({ error: 'This username is reserved. Please choose another username.' }, { status: 409 });
    }

    // Check if username exists (case-insensitive)
    const { rows: existing } = await query('SELECT id FROM users WHERE LOWER(username) = $1', [username]);
    if (existing.length > 0) {
      return NextResponse.json({ error: `Username '${username}' is already taken. Please choose another one.` }, { status: 409 });
    }

    const passwordHash = await hashPassword(password);

    let finalMemberId = memberId;
    let rawApiKey: string | null = null;
    let apiKeyHash: string | null = null;

    let finalTeamId = teamId;
    if (role === 'admin' && newTeamName) {
      const { rows: teamRows } = await query(
        'INSERT INTO teams (name) VALUES ($1) RETURNING id',
        [newTeamName]
      );
      finalTeamId = teamRows[0].id;
    } else if (role !== 'admin') {
      finalTeamId = null;
    }

    if (memberId === 'new') {
      let memberTeamId = finalTeamId;
      if (!memberTeamId) {
        let teamRes = await query("SELECT id FROM teams WHERE name = 'Independent' LIMIT 1");
        memberTeamId = teamRes.rows[0]?.id;
        if (!memberTeamId) {
          const newTeamRes = await query("INSERT INTO teams (name) VALUES ('Independent') RETURNING id");
          memberTeamId = newTeamRes.rows[0].id;
        }
      }

      const memberRes = await query(
        "INSERT INTO members (team_id, display_name, role) VALUES ($1, $2, 'member') RETURNING id",
        [memberTeamId, displayName]
      );
      finalMemberId = memberRes.rows[0].id;

      await query(
        `INSERT INTO team_members (team_id, member_id, role)
         VALUES ($1, $2, 'member')
         ON CONFLICT (team_id, member_id) DO NOTHING`,
        [memberTeamId, finalMemberId],
      );
    }

    if (finalMemberId && finalMemberId !== 'new') {
      rawApiKey = generateApiKey();
      apiKeyHash = hashApiKey(rawApiKey);
      // Upsert a member_key row for this member
      await query(
        `INSERT INTO member_keys (member_id, key_hash, label)
         VALUES ($1, $2, 'default')
         ON CONFLICT (key_hash) DO NOTHING`,
        [finalMemberId, apiKeyHash],
      );

      // Link any selected teamIds into team_members
      for (const tId of teamIds) {
        if (tId && tId !== 'new') {
          await query(
            `INSERT INTO team_members (team_id, member_id, role)
             VALUES ($1, $2, 'member')
             ON CONFLICT (team_id, member_id) DO NOTHING`,
            [tId, finalMemberId],
          );
        }
      }

      // Ensure Independent team is always linked by default
      const { rows: indepRows } = await query("SELECT id FROM teams WHERE name = 'Independent' LIMIT 1");
      if (indepRows[0]?.id) {
        await query(
          `INSERT INTO team_members (team_id, member_id, role)
           VALUES ($1, $2, 'member')
           ON CONFLICT (team_id, member_id) DO NOTHING`,
          [indepRows[0].id, finalMemberId],
        );
      }
    }

    const { rows } = await query(`
      INSERT INTO users (username, password_hash, display_name, member_id, team_id, role, api_key)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, username, display_name, role, member_id, team_id, active, created_at
    `, [username, passwordHash, displayName, finalMemberId, finalTeamId, role, rawApiKey]);

    const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || 'https://token-tracer-three.vercel.app';
    let installCommandMac = null;
    let installCommandWin = null;
    if (rawApiKey) {
      installCommandMac = `curl -fsSL ${serverUrl}/install.sh | bash -s -- --key ${rawApiKey}`;
      installCommandWin = `$ApiKey="${rawApiKey}"; iex (irm ${serverUrl}/install.ps1)`;
    }

    await recordAuditEvent({
      actorUserId: actorSession?.userId,
      actorUsername: actorSession?.username,
      action: 'user.create',
      targetType: 'user',
      targetId: rows[0].id,
      metadata: { username, role, memberId: finalMemberId },
    });

    return NextResponse.json({
      user: rows[0],
      apiKey: rawApiKey,
      installCommandMac,
      installCommandWin
    }, { status: 201 });
  } catch (err: any) {
    if (err?.code === '23505') {
      return NextResponse.json({ error: 'Username is already taken. Please choose another one.' }, { status: 409 });
    }
    console.error('[admin/users POST error]', err);
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  if (!requireSuperadmin(req)) return NextResponse.json({ error: 'superadmin access required' }, { status: 403 });

  try {
    const body = await req.json();
    const { id, displayName, role, active, memberId, teamId } = body;
    const teamIds: string[] | undefined = Array.isArray(body.teamIds) ? body.teamIds : undefined;
    const newTeamName = String(body.newTeamName || '').trim();
    const username = body.username ? String(body.username).trim().toLowerCase() : undefined;
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

    if (username) {
      if (username.length < 2) {
        return NextResponse.json({ error: 'Username must be at least 2 characters long' }, { status: 400 });
      }
      if (!/^[a-z0-9_.-]+$/.test(username)) {
        return NextResponse.json({ error: 'Username can only contain letters, numbers, dots, hyphens, and underscores' }, { status: 400 });
      }
      const reservedUsernames = ['team', 'superadmin', 'admin', 'root', 'api', 'system', 'dashboard'];
      if (reservedUsernames.includes(username)) {
        return NextResponse.json({ error: 'This username is reserved' }, { status: 409 });
      }
      const { rows: existing } = await query('SELECT id FROM users WHERE LOWER(username) = $1 AND id != $2', [username, id]);
      if (existing.length > 0) {
        return NextResponse.json({ error: `Username '${username}' is already taken. Please choose another one.` }, { status: 409 });
      }
    }

    let finalTeamId = teamId;
    if (role === 'admin' && newTeamName) {
      const { rows: teamRows } = await query(
        'INSERT INTO teams (name) VALUES ($1) RETURNING id',
        [newTeamName]
      );
      finalTeamId = teamRows[0].id;
    } else if (role !== 'admin' && role !== undefined) {
      // If changing role away from admin, remove team association
      finalTeamId = null;
    }

    let finalMemberId = memberId;
    if (memberId === 'new') {
      let memberTeamId = finalTeamId;
      if (!memberTeamId) {
        let teamRes = await query("SELECT id FROM teams WHERE name = 'Independent' LIMIT 1");
        memberTeamId = teamRes.rows[0]?.id;
        if (!memberTeamId) {
          const newTeamRes = await query("INSERT INTO teams (name) VALUES ('Independent') RETURNING id");
          memberTeamId = newTeamRes.rows[0].id;
        }
      }

      const memberRes = await query(
        "INSERT INTO members (team_id, display_name, role) VALUES ($1, $2, 'member') RETURNING id",
        [memberTeamId, displayName || 'Unnamed Member']
      );
      finalMemberId = memberRes.rows[0].id;

      await query(
        `INSERT INTO team_members (team_id, member_id, role)
         VALUES ($1, $2, 'member')
         ON CONFLICT (team_id, member_id) DO NOTHING`,
        [memberTeamId, finalMemberId],
      );
    }

    // Sync team_members if teamIds are provided
    if (finalMemberId && teamIds) {
      // Re-link teams
      for (const tId of teamIds) {
        if (tId && tId !== 'new') {
          await query(
            `INSERT INTO team_members (team_id, member_id, role)
             VALUES ($1, $2, 'member')
             ON CONFLICT (team_id, member_id) DO NOTHING`,
            [tId, finalMemberId],
          );
        }
      }

      // Remove unselected teams
      if (teamIds.length > 0) {
        await query(
          `DELETE FROM team_members WHERE member_id = $1 AND NOT (team_id = ANY($2::uuid[]))`,
          [finalMemberId, teamIds],
        );
      } else {
        await query(
          `DELETE FROM team_members WHERE member_id = $1`,
          [finalMemberId],
        );
      }

      // Update primary team_id on the members table
      const primaryMemberTeamId = teamIds[0] || finalTeamId || null;
      await query(
        `UPDATE members SET team_id = $2 WHERE id = $1`,
        [finalMemberId, primaryMemberTeamId],
      );
    }

    // Self-healing: generate API key if missing and member is linked
    let rawApiKey: string | null = null;
    let apiKeyHash: string | null = null;
    const { rows: keyCheck } = await query(`SELECT api_key FROM users WHERE id = $1`, [id]);
    const existingApiKey = keyCheck[0]?.api_key || null;

    if (finalMemberId && finalMemberId !== 'new') {
      if (!existingApiKey) {
        rawApiKey = generateApiKey();
        apiKeyHash = hashApiKey(rawApiKey);
        await query(
          `INSERT INTO member_keys (member_id, key_hash, label)
           VALUES ($1, $2, 'default')
           ON CONFLICT (key_hash) DO NOTHING`,
          [finalMemberId, apiKeyHash],
        );
      }
    }

    const { rows } = await query(`
      UPDATE users SET
        username     = COALESCE($2, username),
        display_name = COALESCE($3, display_name),
        role         = COALESCE($4, role),
        active       = COALESCE($5, active),
        member_id    = COALESCE($6, member_id),
        team_id      = COALESCE($7, team_id),
        api_key      = COALESCE($8, api_key),
        updated_at   = now()
      WHERE id = $1
      RETURNING id, username, display_name, role, active, member_id, team_id, updated_at
    `, [id, username ?? null, displayName ?? null, role ?? null, active ?? null, finalMemberId ?? null, finalTeamId ?? null, rawApiKey]);

    if (!rows[0]) return NextResponse.json({ error: 'user not found' }, { status: 404 });

    const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || 'https://token-tracer-three.vercel.app';
    const effectiveApiKey = rawApiKey || existingApiKey || null;
    let installCommandMac = null;
    let installCommandWin = null;
    if (effectiveApiKey) {
      installCommandMac = `curl -fsSL ${serverUrl}/install.sh | bash -s -- --key ${effectiveApiKey}`;
      installCommandWin = `$ApiKey="${effectiveApiKey}"; iex (irm ${serverUrl}/install.ps1)`;
    }

    return NextResponse.json({
      user: rows[0],
      apiKey: effectiveApiKey,
      installCommandMac,
      installCommandWin
    });
  } catch (err) {
    return NextResponse.json({ error: String((err as Error).message || err) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!requireSuperadmin(req)) return NextResponse.json({ error: 'superadmin access required' }, { status: 403 });

  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  // BUG-15: Prevent superadmin from deleting their own account
  const actingSession = getSessionFromCookie(req.headers.get('cookie'));
  if (actingSession?.userId === id) {
    return NextResponse.json({ error: 'You cannot delete your own account' }, { status: 400 });
  }

  try {
    const { rows: userRows } = await query('SELECT member_id FROM users WHERE id = $1', [id]);
    const memberId = userRows[0]?.member_id || null;

    const { rowCount } = await query('DELETE FROM users WHERE id = $1', [id]);

    // If this user was the ONLY user linked to that member, delete the member too.
    // member_keys and team_members will cascade-delete automatically.
    if (memberId) {
      const { rows: otherUsers } = await query(
        'SELECT id FROM users WHERE member_id = $1 LIMIT 1',
        [memberId],
      );
      if (otherUsers.length === 0) {
        await query('DELETE FROM members WHERE id = $1', [memberId]);
      }
    }

    return NextResponse.json({ ok: true, deleted: (rowCount || 0) > 0 });
  } catch (err) {
    return NextResponse.json({ error: String((err as Error).message || err) }, { status: 500 });
  }
}
