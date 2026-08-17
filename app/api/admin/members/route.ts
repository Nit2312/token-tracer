import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/auth';
import { query } from '@/lib/team/db';
import { generateApiKey, hashApiKey } from '@/lib/team/auth';

export const dynamic = 'force-dynamic';

function requireSuperadmin(req: NextRequest): boolean {
  const session = getSessionFromCookie(req.headers.get('cookie'));
  return session?.role === 'superadmin';
}

export async function POST(req: NextRequest) {
  if (!requireSuperadmin(req)) return NextResponse.json({ error: 'superadmin access required' }, { status: 403 });

  try {
    const body = await req.json();
    const displayName = String(body.displayName || body.display_name || '').trim();
    const teamId = body.teamId || body.team_id || null;
    const teamIds: string[] = Array.isArray(body.teamIds) ? body.teamIds : (teamId ? [teamId] : []);

    if (!displayName) {
      return NextResponse.json({ error: 'Display name is required' }, { status: 400 });
    }

    // Default to 'Independent' team if no teamIds are selected
    let selectedTeamId = teamIds[0] || null;
    if (!selectedTeamId) {
      let teamRes = await query("SELECT id FROM teams WHERE name = 'Independent' LIMIT 1");
      selectedTeamId = teamRes.rows[0]?.id;
      if (!selectedTeamId) {
        const newTeamRes = await query("INSERT INTO teams (name) VALUES ('Independent') RETURNING id");
        selectedTeamId = newTeamRes.rows[0].id;
      }
    }

    // Insert into members table
    const { rows } = await query(
      `INSERT INTO members (display_name, team_id, role)
       VALUES ($1, $2, 'member')
       RETURNING id, display_name, team_id, role, created_at`,
      [displayName, selectedTeamId]
    );

    const newMember = rows[0];

    // Link all selected teamIds into team_members table
    const effectiveTeamIds = teamIds.length > 0 ? teamIds : [selectedTeamId];
    for (const tId of effectiveTeamIds) {
      if (tId) {
        await query(
          `INSERT INTO team_members (team_id, member_id, role)
           VALUES ($1, $2, 'member')
           ON CONFLICT (team_id, member_id) DO NOTHING`,
          [tId, newMember.id],
        );
      }
    }

    // Generate API key for the new member
    const rawApiKey = generateApiKey();
    const apiKeyHash = hashApiKey(rawApiKey);
    await query(
      `INSERT INTO member_keys (member_id, key_hash, label)
       VALUES ($1, $2, 'default')
       ON CONFLICT (key_hash) DO NOTHING`,
      [newMember.id, apiKeyHash],
    );

    return NextResponse.json({
      member: newMember,
      apiKey: rawApiKey
    }, { status: 201 });
  } catch (err: any) {
    console.error('[admin/members POST error]', err);
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  if (!requireSuperadmin(req)) return NextResponse.json({ error: 'superadmin access required' }, { status: 403 });

  try {
    const body = await req.json();
    const { id, displayName, teamId } = body;
    const teamIds: string[] | undefined = Array.isArray(body.teamIds) ? body.teamIds : (teamId ? [teamId] : undefined);

    if (!id || !displayName) {
      return NextResponse.json({ error: 'id and displayName are required' }, { status: 400 });
    }

    const primaryTeamId = (teamIds && teamIds.length > 0) ? teamIds[0] : (teamId || null);

    const { rows } = await query(
      `UPDATE members SET display_name = $2, team_id = $3 WHERE id = $1 RETURNING id, display_name, team_id`,
      [id, displayName, primaryTeamId]
    );

    if (!rows[0]) {
      return NextResponse.json({ error: 'member not found' }, { status: 404 });
    }

    // Sync team_members if teamIds provided
    if (teamIds) {
      // Add newly selected teams
      for (const tId of teamIds) {
        if (tId) {
          await query(
            `INSERT INTO team_members (team_id, member_id, role)
             VALUES ($1, $2, 'member')
             ON CONFLICT (team_id, member_id) DO NOTHING`,
            [tId, id],
          );
        }
      }

      // Remove unselected teams
      if (teamIds.length > 0) {
        await query(
          `DELETE FROM team_members WHERE member_id = $1 AND NOT (team_id = ANY($2::uuid[]))`,
          [id, teamIds],
        );
      } else {
        await query(
          `DELETE FROM team_members WHERE member_id = $1`,
          [id],
        );
      }
    }

    return NextResponse.json({ member: rows[0] });
  } catch (err: any) {
    console.error('[admin/members PUT error]', err);
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!requireSuperadmin(req)) return NextResponse.json({ error: 'superadmin access required' }, { status: 403 });

  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  try {
    const { rowCount } = await query('DELETE FROM members WHERE id = $1', [id]);
    return NextResponse.json({ ok: true, deleted: (rowCount || 0) > 0 });
  } catch (err: any) {
    console.error('[admin/members DELETE error]', err);
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
