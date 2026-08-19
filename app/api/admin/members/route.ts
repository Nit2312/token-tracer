import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/auth';
import { queryCol, setDocById, deleteDocById, newUuid } from '@/lib/team/db';
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

    if (!displayName) return NextResponse.json({ error: 'Display name is required' }, { status: 400 });

    let selectedTeamId = teamIds[0] || null;
    if (!selectedTeamId) {
      const indep = await queryCol<{ id: string }>('teams', [{ type: 'where', field: 'name', op: '==', value: 'Independent' }, { type: 'limit', n: 1 }]);
      selectedTeamId = indep[0]?.id;
      if (!selectedTeamId) {
        selectedTeamId = newUuid();
        await setDocById('teams', selectedTeamId, { name: 'Independent', created_at: new Date().toISOString() });
      }
    }

    const memberId = newUuid();
    const memberDoc = { id: memberId, display_name: displayName, team_id: selectedTeamId, role: 'member', created_at: new Date().toISOString() };
    await setDocById('members', memberId, memberDoc);

    const effectiveTeamIds = teamIds.length > 0 ? teamIds : [selectedTeamId];
    for (const tId of effectiveTeamIds) {
      if (tId) {
        await setDocById('team_members', `${tId}_${memberId}`, { team_id: tId, member_id: memberId, role: 'member', created_at: new Date().toISOString() }, true);
      }
    }

    const rawApiKey = generateApiKey();
    const keyId = newUuid();
    await setDocById('member_keys', keyId, { id: keyId, member_id: memberId, key_hash: hashApiKey(rawApiKey), label: 'default', created_at: new Date().toISOString(), revoked_at: null }, true);

    return NextResponse.json({ member: memberDoc, apiKey: rawApiKey }, { status: 201 });
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

    if (!id || !displayName) return NextResponse.json({ error: 'id and displayName are required' }, { status: 400 });

    const primaryTeamId = (teamIds && teamIds.length > 0) ? teamIds[0] : (teamId || null);
    await setDocById('members', id, { display_name: displayName, team_id: primaryTeamId, updated_at: new Date().toISOString() }, true);

    if (teamIds) {
      let effectiveTeamIds = teamIds.filter(Boolean);
      if (effectiveTeamIds.length === 0) {
        const indep = await queryCol<{ id: string }>('teams', [{ type: 'where', field: 'name', op: '==', value: 'Independent' }, { type: 'limit', n: 1 }]);
        let independentTeamId = indep[0]?.id;
        if (!independentTeamId) {
          independentTeamId = newUuid();
          await setDocById('teams', independentTeamId, { name: 'Independent', created_at: new Date().toISOString() });
        }
        effectiveTeamIds = [independentTeamId];
      }

      for (const tId of effectiveTeamIds) {
        await setDocById('team_members', `${tId}_${id}`, { team_id: tId, member_id: id, role: 'member', created_at: new Date().toISOString() }, true);
      }

      // Remove unselected team memberships
      const allTms = await queryCol<any>('team_members', [{ type: 'where', field: 'member_id', op: '==', value: id }]);
      for (const tm of allTms) {
        if (!effectiveTeamIds.includes(tm.team_id)) {
          await deleteDocById('team_members', tm.id);
        }
      }

      await setDocById('members', id, { team_id: effectiveTeamIds[0] }, true);
    }

    return NextResponse.json({ member: { id, display_name: displayName, team_id: primaryTeamId } });
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
    await deleteDocById('members', id);
    return NextResponse.json({ ok: true, deleted: true });
  } catch (err: any) {
    console.error('[admin/members DELETE error]', err);
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
