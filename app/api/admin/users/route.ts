/**
 * CRUD for users collection — superadmin only.
 *
 * GET    /api/admin/users          → list all users with linked member info
 * POST   /api/admin/users          → create a user
 * PUT    /api/admin/users          → update user
 * DELETE /api/admin/users?id=uuid  → hard delete a user
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie, hashPassword } from '@/lib/auth';
import { generateApiKey, hashApiKey } from '@/lib/team/auth';
import { queryCol, getDocById, setDocById, deleteDocById, batchWrite, newUuid } from '@/lib/team/db';
import { recordAuditEvent } from '@/lib/team/audit';
import { statsCache } from '@/lib/team/cache';

export const dynamic = 'force-dynamic';

function requireSuperadmin(req: NextRequest): boolean {
  const session = getSessionFromCookie(req.headers.get('cookie'));
  return session?.role === 'superadmin';
}

export async function GET(req: NextRequest) {
  if (!requireSuperadmin(req)) return NextResponse.json({ error: 'superadmin access required' }, { status: 403 });

  try {
    const responseData = await statsCache.getOrSet('admin_users_list', 30, async () => {
      const userDocs = await queryCol<any>('users');
      const memberDocs = await queryCol<any>('members');
      const teamMemberDocs = await queryCol<any>('team_members');
      const teamDocs = await queryCol<any>('teams');
      const sessionDocs = await queryCol<any>('sync_sessions');

    const memberById = new Map(memberDocs.map((m: any) => [m.id, m]));
    const teamById = new Map(teamDocs.map((t: any) => [t.id, t]));

    // Build session count + last session per member
    const sessionCountByMember = new Map<string, number>();
    const lastSessionByMember = new Map<string, string>();
    for (const s of sessionDocs) {
      const mid = s.member_id;
      if (!mid) continue;
      sessionCountByMember.set(mid, (sessionCountByMember.get(mid) || 0) + 1);
      const ts = s.ended_at || s.started_at;
      const prev = lastSessionByMember.get(mid);
      if (!prev || (ts && ts > prev)) lastSessionByMember.set(mid, ts);
    }

    // Build team membership per member
    const teamsByMember = new Map<string, Array<{ id: string; name: string; role: string }>>();
    for (const tm of teamMemberDocs) {
      if (!teamsByMember.has(tm.member_id)) teamsByMember.set(tm.member_id, []);
      const t = teamById.get(tm.team_id);
      if (t) teamsByMember.get(tm.member_id)!.push({ id: t.id, name: t.name, role: tm.role });
    }

    const users = userDocs.map((u: any) => {
      const member = u.member_id ? memberById.get(u.member_id) : null;
      const memberTeams = u.member_id ? (teamsByMember.get(u.member_id) || []) : [];
      const primaryTeam = u.team_id ? teamById.get(u.team_id) : null;
      const teamName = memberTeams.length > 0
        ? memberTeams.map((t: any) => t.name).join(', ')
        : (primaryTeam?.name || '—');
      return {
        ...u,
        member_name: member?.display_name || null,
        daemon_version: member?.daemon_version || null,
        daemon_last_seen_at: member?.daemon_last_seen_at || null,
        team_name: teamName,
        teams: memberTeams,
        has_api_key: Boolean(u.api_key),
        session_count: sessionCountByMember.get(u.member_id) || 0,
        last_session_at: lastSessionByMember.get(u.member_id) || null,
      };
    }).sort((a: any, b: any) => String(a.created_at || '').localeCompare(String(b.created_at || '')));

    // Members not linked to any user
    const linkedMemberIds = new Set(userDocs.map((u: any) => u.member_id).filter(Boolean));
    const unlinkedMembers = memberDocs
      .filter((m: any) => !linkedMemberIds.has(m.id))
      .map((m: any) => {
        const memberTeams = teamsByMember.get(m.id) || [];
        const primaryTeam = m.team_id ? teamById.get(m.team_id) : null;
        return {
          ...m,
          team_name: memberTeams.length > 0 ? memberTeams.map((t: any) => t.name).join(', ') : (primaryTeam?.name || 'Independent'),
          teams: memberTeams,
        };
      })
      .sort((a: any, b: any) => String(a.display_name).localeCompare(String(b.display_name)));

    // Teams with member counts
    const memberCountByTeam = new Map<string, Set<string>>();
    for (const tm of teamMemberDocs) {
      if (!memberCountByTeam.has(tm.team_id)) memberCountByTeam.set(tm.team_id, new Set());
      memberCountByTeam.get(tm.team_id)!.add(tm.member_id);
    }
    const teams = teamDocs.map((t: any) => ({
      id: t.id, name: t.name,
      member_count: memberCountByTeam.get(t.id)?.size || 0,
    })).sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));

    return { users, unlinkedMembers, teams };
    });

    return NextResponse.json(responseData);
  } catch (err: any) {
    console.error('[admin/users GET error]', err);
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
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
    if (password.length < 8) return NextResponse.json({ error: 'Password must be at least 8 characters long' }, { status: 400 });
    if (!['user', 'admin', 'superadmin'].includes(role)) return NextResponse.json({ error: 'invalid role' }, { status: 400 });
    if (username.length < 2) return NextResponse.json({ error: 'Username must be at least 2 characters long' }, { status: 400 });
    if (!/^[a-z0-9_.-]+$/.test(username)) return NextResponse.json({ error: 'Username can only contain letters, numbers, dots, hyphens, and underscores' }, { status: 400 });
    const reservedUsernames = ['team', 'superadmin', 'admin', 'root', 'api', 'system', 'dashboard'];
    if (reservedUsernames.includes(username)) return NextResponse.json({ error: 'This username is reserved.' }, { status: 409 });

    const existing = await queryCol('users', [{ type: 'where', field: 'username', op: '==', value: username }, { type: 'limit', n: 1 }]);
    if (existing.length > 0) return NextResponse.json({ error: `Username '${username}' is already taken.` }, { status: 409 });

    const passwordHash = await hashPassword(password);
    let finalMemberId = memberId;
    let rawApiKey: string | null = null;

    let finalTeamId = teamId;
    if (role === 'admin' && newTeamName) {
      finalTeamId = newUuid();
      await setDocById('teams', finalTeamId, { name: newTeamName, created_at: new Date().toISOString() });
    } else if (role !== 'admin') {
      finalTeamId = null;
    }

    if (memberId === 'new') {
      let memberTeamId = finalTeamId;
      if (!memberTeamId) {
        const indep = await queryCol<{ id: string }>('teams', [{ type: 'where', field: 'name', op: '==', value: 'Independent' }, { type: 'limit', n: 1 }]);
        memberTeamId = indep[0]?.id;
        if (!memberTeamId) {
          memberTeamId = newUuid();
          await setDocById('teams', memberTeamId, { name: 'Independent', created_at: new Date().toISOString() });
        }
      }
      finalMemberId = newUuid();
      await setDocById('members', finalMemberId, { id: finalMemberId, team_id: memberTeamId, display_name: displayName, role: 'member', created_at: new Date().toISOString() });
      await setDocById('team_members', `${memberTeamId}_${finalMemberId}`, { team_id: memberTeamId, member_id: finalMemberId, role: 'member', created_at: new Date().toISOString() }, true);
    }

    if (finalMemberId && finalMemberId !== 'new') {
      rawApiKey = generateApiKey();
      const keyId = newUuid();
      await setDocById('member_keys', keyId, { id: keyId, member_id: finalMemberId, key_hash: hashApiKey(rawApiKey), label: 'default', created_at: new Date().toISOString(), revoked_at: null }, true);

      for (const tId of teamIds) {
        if (tId && tId !== 'new') {
          await setDocById('team_members', `${tId}_${finalMemberId}`, { team_id: tId, member_id: finalMemberId, role: 'member', created_at: new Date().toISOString() }, true);
        }
      }

      // Ensure Independent team linked
      const indepTeams = await queryCol<{ id: string }>('teams', [{ type: 'where', field: 'name', op: '==', value: 'Independent' }, { type: 'limit', n: 1 }]);
      if (indepTeams[0]?.id) {
        await setDocById('team_members', `${indepTeams[0].id}_${finalMemberId}`, { team_id: indepTeams[0].id, member_id: finalMemberId, role: 'member', created_at: new Date().toISOString() }, true);
      }
    }

    const userId = newUuid();
    const userDoc = {
      id: userId, username, password_hash: passwordHash, display_name: displayName,
      member_id: finalMemberId, team_id: finalTeamId, role, api_key: rawApiKey,
      active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    await setDocById('users', userId, userDoc);

    const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || 'https://token-tracer-three.vercel.app';
    let installCommandMac = null, installCommandWin = null;
    if (rawApiKey) {
      installCommandMac = `curl -fsSL ${serverUrl}/install.sh | bash -s -- --key ${rawApiKey}`;
      installCommandWin = `$ApiKey="${rawApiKey}"; iex (irm ${serverUrl}/install.ps1)`;
    }

    await recordAuditEvent({ actorUserId: actorSession?.userId, actorUsername: actorSession?.username, action: 'user.create', targetType: 'user', targetId: userId, metadata: { username, role, memberId: finalMemberId } });

    return NextResponse.json({ user: userDoc, apiKey: rawApiKey, installCommandMac, installCommandWin }, { status: 201 });
  } catch (err: any) {
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
      if (username.length < 2) return NextResponse.json({ error: 'Username must be at least 2 characters long' }, { status: 400 });
      if (!/^[a-z0-9_.-]+$/.test(username)) return NextResponse.json({ error: 'Username can only contain letters, numbers, dots, hyphens, and underscores' }, { status: 400 });
      const reservedUsernames = ['team', 'superadmin', 'admin', 'root', 'api', 'system', 'dashboard'];
      if (reservedUsernames.includes(username)) return NextResponse.json({ error: 'This username is reserved' }, { status: 409 });
      const existingUsers = await queryCol('users', [{ type: 'where', field: 'username', op: '==', value: username }, { type: 'limit', n: 1 }]);
      if (existingUsers.length > 0 && existingUsers[0].id !== id) return NextResponse.json({ error: `Username '${username}' is already taken.` }, { status: 409 });
    }

    let finalTeamId = teamId;
    if (role === 'admin' && newTeamName) {
      finalTeamId = newUuid();
      await setDocById('teams', finalTeamId, { name: newTeamName, created_at: new Date().toISOString() });
    } else if (role !== 'admin' && role !== undefined) {
      finalTeamId = null;
    }

    let finalMemberId = memberId;
    if (memberId === 'new') {
      let memberTeamId = finalTeamId;
      if (!memberTeamId) {
        const indep = await queryCol<{ id: string }>('teams', [{ type: 'where', field: 'name', op: '==', value: 'Independent' }, { type: 'limit', n: 1 }]);
        memberTeamId = indep[0]?.id;
        if (!memberTeamId) {
          memberTeamId = newUuid();
          await setDocById('teams', memberTeamId, { name: 'Independent', created_at: new Date().toISOString() });
        }
      }
      finalMemberId = newUuid();
      await setDocById('members', finalMemberId, { id: finalMemberId, team_id: memberTeamId, display_name: displayName || 'Unnamed Member', role: 'member', created_at: new Date().toISOString() });
      await setDocById('team_members', `${memberTeamId}_${finalMemberId}`, { team_id: memberTeamId, member_id: finalMemberId, role: 'member', created_at: new Date().toISOString() }, true);
    }

    if (finalMemberId && teamIds) {
      for (const tId of teamIds) {
        if (tId && tId !== 'new') {
          await setDocById('team_members', `${tId}_${finalMemberId}`, { team_id: tId, member_id: finalMemberId, role: 'member', created_at: new Date().toISOString() }, true);
        }
      }
      // Remove unselected teams
      const allTmDocs = await queryCol<{ team_id: string }>('team_members', [{ type: 'where', field: 'member_id', op: '==', value: finalMemberId }]);
      const deleteOps = allTmDocs
        .filter((tm) => teamIds.length > 0 && !teamIds.includes(tm.team_id))
        .map((tm) => ({ type: 'delete' as const, col: 'team_members', id: tm.id }));
      if (deleteOps.length) await batchWrite(deleteOps);

      const primaryMemberTeamId = teamIds[0] || finalTeamId || null;
      if (primaryMemberTeamId) await setDocById('members', finalMemberId, { team_id: primaryMemberTeamId }, true);
    }

    // Self-healing: generate API key if missing
    const currentUser = await getDocById('users', id) as any;
    if (!currentUser) return NextResponse.json({ error: 'user not found' }, { status: 404 });

    let rawApiKey: string | null = null;
    const existingApiKey = currentUser.api_key || null;
    if (finalMemberId && finalMemberId !== 'new' && !existingApiKey) {
      rawApiKey = generateApiKey();
      const keyId = newUuid();
      await setDocById('member_keys', keyId, { id: keyId, member_id: finalMemberId, key_hash: hashApiKey(rawApiKey), label: 'default', created_at: new Date().toISOString(), revoked_at: null }, true);
    }

    const updateData: Record<string, any> = { updated_at: new Date().toISOString() };
    if (username !== undefined) updateData.username = username;
    if (displayName !== undefined) updateData.display_name = displayName;
    if (role !== undefined) updateData.role = role;
    if (active !== undefined) updateData.active = active;
    if (finalMemberId !== undefined) updateData.member_id = finalMemberId;
    if (finalTeamId !== undefined) updateData.team_id = finalTeamId;
    if (rawApiKey) updateData.api_key = rawApiKey;

    await setDocById('users', id, updateData, true);

    const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || 'https://token-tracer-three.vercel.app';
    const effectiveApiKey = rawApiKey || existingApiKey || null;
    let installCommandMac = null, installCommandWin = null;
    if (effectiveApiKey) {
      installCommandMac = `curl -fsSL ${serverUrl}/install.sh | bash -s -- --key ${effectiveApiKey}`;
      installCommandWin = `$ApiKey="${effectiveApiKey}"; iex (irm ${serverUrl}/install.ps1)`;
    }

    return NextResponse.json({ user: { id, ...updateData }, apiKey: effectiveApiKey, installCommandMac, installCommandWin });
  } catch (err) {
    return NextResponse.json({ error: String((err as Error).message || err) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!requireSuperadmin(req)) return NextResponse.json({ error: 'superadmin access required' }, { status: 403 });

  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const actingSession = getSessionFromCookie(req.headers.get('cookie'));
  if (actingSession?.userId === id) {
    return NextResponse.json({ error: 'You cannot delete your own account' }, { status: 400 });
  }

  try {
    const userDoc = await getDocById('users', id) as any;
    const memberId = userDoc?.member_id || null;

    await deleteDocById('users', id);

    if (memberId) {
      const otherUsers = await queryCol('users', [{ type: 'where', field: 'member_id', op: '==', value: memberId }, { type: 'limit', n: 1 }]);
      if (otherUsers.length === 0) {
        await deleteDocById('members', memberId);
      }
    }

    return NextResponse.json({ ok: true, deleted: true });
  } catch (err) {
    return NextResponse.json({ error: String((err as Error).message || err) }, { status: 500 });
  }
}
