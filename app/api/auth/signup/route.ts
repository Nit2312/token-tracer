import { NextRequest, NextResponse } from 'next/server';
import { hashPassword } from '@/lib/auth';
import { generateApiKey, hashApiKey } from '@/lib/team/auth';
import { queryCol, setDocById, newUuid } from '@/lib/team/db';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
    }

    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const displayName = String(body.displayName || '').trim();
    const role = String(body.role || 'user');
    const teamName = String(body.teamName || '').trim();

    if (!username || !password || !displayName) {
      return NextResponse.json({ error: 'username, password, and displayName are required' }, { status: 400 });
    }

    if (password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters long' }, { status: 400 });
    }

    if (!['user', 'admin'].includes(role)) {
      return NextResponse.json({ error: 'invalid role' }, { status: 400 });
    }

    if (username.length < 2) {
      return NextResponse.json({ error: 'Username must be at least 2 characters long' }, { status: 400 });
    }
    if (!/^[a-z0-9_.-]+$/.test(username)) {
      return NextResponse.json({ error: 'Username can only contain letters, numbers, dots, hyphens, and underscores' }, { status: 400 });
    }

    const reservedUsernames = ['team', 'superadmin', 'admin', 'root', 'api', 'system', 'dashboard'];
    if (reservedUsernames.includes(username)) {
      return NextResponse.json({ error: 'This username is reserved. Please choose another username.' }, { status: 409 });
    }

    // Check if username already exists (case-insensitive via stored lowercase)
    const existingUsers = await queryCol('users', [
      { type: 'where', field: 'username', op: '==', value: username },
      { type: 'limit', n: 1 },
    ]);
    if (existingUsers.length > 0) {
      return NextResponse.json({ error: 'Username already exists. Please choose a different username.' }, { status: 409 });
    }

    const passwordHash = await hashPassword(password);
    let finalTeamId: string | null = null;
    let finalMemberId: string | null = null;
    let rawApiKey: string | null = null;

    if (role === 'admin') {
      if (!teamName) {
        return NextResponse.json({ error: 'teamName is required for admins' }, { status: 400 });
      }
      finalTeamId = newUuid();
      await setDocById('teams', finalTeamId, {
        name: teamName,
        created_at: new Date().toISOString(),
      });
    } else {
      // Find or create default Independent team
      const indepTeams = await queryCol<{ id: string }>('teams', [
        { type: 'where', field: 'name', op: '==', value: 'Independent' },
        { type: 'limit', n: 1 },
      ]);
      let independentTeamId = indepTeams[0]?.id;
      if (!independentTeamId) {
        independentTeamId = newUuid();
        await setDocById('teams', independentTeamId, {
          name: 'Independent',
          created_at: new Date().toISOString(),
        });
      }

      // Create member record
      finalMemberId = newUuid();
      await setDocById('members', finalMemberId, {
        id: finalMemberId,
        team_id: independentTeamId,
        display_name: displayName,
        role: 'member',
        created_at: new Date().toISOString(),
      });

      // Associate in team_members junction
      const tmId = `${independentTeamId}_${finalMemberId}`;
      await setDocById('team_members', tmId, {
        team_id: independentTeamId,
        member_id: finalMemberId,
        role: 'member',
        created_at: new Date().toISOString(),
      }, true);

      // Generate API key for Member
      rawApiKey = generateApiKey();
      const apiKeyHash = hashApiKey(rawApiKey);
      const keyId = newUuid();
      await setDocById('member_keys', keyId, {
        id: keyId,
        member_id: finalMemberId,
        key_hash: apiKeyHash,
        label: 'default',
        created_at: new Date().toISOString(),
        revoked_at: null,
        last_used_at: null,
      });
    }

    const userId = newUuid();
    const userDoc = {
      id: userId,
      username,
      password_hash: passwordHash,
      display_name: displayName,
      member_id: finalMemberId,
      team_id: finalTeamId,
      role,
      api_key: rawApiKey,
      active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      failed_login_attempts: 0,
      locked_until: null,
    };
    await setDocById('users', userId, userDoc);

    const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || 'https://token-tracer-three.vercel.app';
    let installCommandMac = null;
    let installCommandWin = null;
    if (rawApiKey) {
      installCommandMac = `curl -fsSL ${serverUrl}/install.sh | bash -s -- --key ${rawApiKey}`;
      installCommandWin = `$ApiKey="${rawApiKey}"; iex (irm ${serverUrl}/install.ps1)`;
    }

    return NextResponse.json({
      ok: true,
      user: { id: userId, username, display_name: displayName, role, member_id: finalMemberId, team_id: finalTeamId },
      apiKey: rawApiKey,
      installCommandMac,
      installCommandWin,
    }, { status: 201 });
  } catch (err: any) {
    console.error('[auth/signup error]', err);
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
