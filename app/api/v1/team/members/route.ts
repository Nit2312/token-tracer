import { NextRequest, NextResponse } from 'next/server';
import { getAuthorizedTeamId, getSessionFromCookie } from '@/lib/auth';
import { createMemberWithKey, createTeamUserWithMember, updateMember, deleteMember } from '@/lib/team/stats';
import { queryCol, getDocById } from '@/lib/team/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const rawTeamId = req.nextUrl.searchParams.get('teamId');
    const teamId = getAuthorizedTeamId(req, rawTeamId);
    if (!teamId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const isUuid = (val: string | null | undefined): boolean =>
      Boolean(val && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val));

    if (!isUuid(teamId)) {
      return NextResponse.json({ members: [] });
    }

    const session = getSessionFromCookie(req.headers.get('cookie'));

    // Get team_members for this team
    const teamMemberDocs = await queryCol<any>('team_members', [
      { type: 'where', field: 'team_id', op: '==', value: teamId },
    ]);

    let targetMemberIds = teamMemberDocs.map((tm: any) => tm.member_id).filter(Boolean);
    if (session?.role === 'user' && session.memberId) {
      targetMemberIds = targetMemberIds.filter((id: string) => id === session.memberId);
    }

    if (targetMemberIds.length === 0) {
      return NextResponse.json({ members: [] });
    }

    const memberRoleMap = new Map(teamMemberDocs.map((tm: any) => [tm.member_id, tm.role]));

    // Fetch members, sync_sessions, ingest_events, member_keys in parallel filtered by team_id
    const [memberDocs, sessionDocs, keyDocs, eventDocs] = await Promise.all([
      Promise.all(targetMemberIds.map((id: string) => getDocById('members', id))),
      queryCol<any>('sync_sessions', [{ type: 'where', field: 'team_id', op: '==', value: teamId }]),
      queryCol<any>('member_keys', [{ type: 'where', field: 'team_id', op: '==', value: teamId }]),
      queryCol<any>('ingest_events', [{ type: 'where', field: 'team_id', op: '==', value: teamId }]),
    ]);

    const sessionsByMember = new Map<string, any[]>();
    for (const s of sessionDocs) {
      if (!s.member_id) continue;
      if (!sessionsByMember.has(s.member_id)) sessionsByMember.set(s.member_id, []);
      sessionsByMember.get(s.member_id)!.push(s);
    }

    const keysByMember = new Map<string, any[]>();
    for (const k of keyDocs) {
      if (!k.member_id) continue;
      if (!keysByMember.has(k.member_id)) keysByMember.set(k.member_id, []);
      keysByMember.get(k.member_id)!.push(k);
    }

    const eventsByMember = new Map<string, any[]>();
    for (const e of eventDocs) {
      if (!e.member_id) continue;
      if (!eventsByMember.has(e.member_id)) eventsByMember.set(e.member_id, []);
      eventsByMember.get(e.member_id)!.push(e);
    }

    const members = memberDocs
      .filter(Boolean)
      .map((m: any) => {
        const sList = sessionsByMember.get(m.id) || [];
        const kList = keysByMember.get(m.id) || [];
        const eList = eventsByMember.get(m.id) || [];

        let lastSyncAt: string | null = null;
        for (const e of eList) {
          if (e.created_at && (!lastSyncAt || e.created_at > lastSyncAt)) lastSyncAt = e.created_at;
        }
        for (const s of sList) {
          const ts = s.ended_at || s.started_at || s.synced_at;
          if (ts && (!lastSyncAt || ts > lastSyncAt)) lastSyncAt = ts;
        }
        for (const k of kList) {
          if (k.last_used_at && (!lastSyncAt || k.last_used_at > lastSyncAt)) lastSyncAt = k.last_used_at;
        }

        const totalTokens = sList.reduce((acc, s) => acc + Number(s.tokens_in || 0) + Number(s.tokens_out || 0), 0);
        const totalCost = sList.reduce((acc, s) => acc + Number(s.api_cost || 0), 0);

        return {
          id: m.id,
          display_name: m.display_name,
          role: memberRoleMap.get(m.id) || m.role || 'member',
          created_at: m.created_at,
          sync_requested_at: m.sync_requested_at || null,
          daemon_version: m.daemon_version || null,
          daemon_last_seen_at: m.daemon_last_seen_at || null,
          last_sync_at: lastSyncAt,
          session_count: sList.length,
          total_tokens: totalTokens,
          total_cost: totalCost,
        };
      })
      .sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)));

    return NextResponse.json({ members });
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
      String(body.displayName),
      String(body.role ?? 'member'),
    );
    if (!member) return NextResponse.json({ error: 'member not found' }, { status: 404 });
    return NextResponse.json({ member });
  } catch (err) {
    console.error('[team/members PUT error]', err);
    return NextResponse.json({ error: String((err as Error).message || err) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get('id');
    const rawTeamId = req.nextUrl.searchParams.get('teamId');
    const teamId = getAuthorizedTeamId(req, rawTeamId);
    if (!teamId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

    const res = await deleteMember(id, teamId);
    return NextResponse.json(res);
  } catch (err) {
    console.error('[team/members DELETE error]', err);
    return NextResponse.json({ error: String((err as Error).message || err) }, { status: 500 });
  }
}
