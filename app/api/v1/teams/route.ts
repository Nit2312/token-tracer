import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/auth';
import { verifyAdminToken, adminTokenFromCookie } from '@/lib/team/auth';
import { queryCol, getCachedCollection, setDocById, newUuid } from '@/lib/team/db';

import { statsCache } from '@/lib/team/cache';

export const dynamic = 'force-dynamic';

function requireAdmin(req: NextRequest): boolean {
  const session = getSessionFromCookie(req.headers.get('cookie'));
  if (session?.role === 'admin' || session?.role === 'superadmin' || session?.role === 'user') return true;

  const authHeader = req.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (verifyAdminToken(token)) return true;
  }
  const cookieHeader = req.headers.get('cookie');
  const token = adminTokenFromCookie(cookieHeader);
  return verifyAdminToken(token);
}

export async function GET(req: NextRequest) {
  try {
    if (!requireAdmin(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    const session = getSessionFromCookie(req.headers.get('cookie'));
    const isUuid = (val: string | null | undefined): boolean =>
      Boolean(val && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val));

    const cacheKey = `teams_list_${session?.userId || 'anon'}_${session?.role || 'none'}`;
    const result = await statsCache.getOrSet(cacheKey, 120, async () => {
      const teamDocs = await getCachedCollection<any>('teams', [], 300);
      if (session && (session.role === 'admin' || session.role === 'user')) {
        let filteredTeams: any[] = teamDocs;

        if (isUuid(session.teamId)) {
          filteredTeams = teamDocs.filter((t: any) => t.id === session.teamId);
        } else if (isUuid(session.userId)) {
          // Find member's team_members
          const userDocs = await queryCol<any>('users', [{ type: 'where', field: 'id', op: '==', value: session.userId }, { type: 'limit', n: 1 }]);
          const memberId = userDocs[0]?.member_id;
          if (memberId) {
            const tmDocs = await getCachedCollection<any>('team_members', [{ type: 'where', field: 'member_id', op: '==', value: memberId }], 180);
            const teamIds = new Set(tmDocs.map((tm: any) => tm.team_id));
            filteredTeams = teamDocs.filter((t: any) => teamIds.has(t.id));
          }
        }

        filteredTeams.sort((a: any, b: any) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
        return { teams: filteredTeams };
      }

      return { teams: teamDocs.sort((a: any, b: any) => String(b.created_at || '').localeCompare(String(a.created_at || ''))) };
    });

    return NextResponse.json(result);
  } catch (err) {
    console.error('[teams GET error]', err);
    return NextResponse.json({ error: String((err as Error).message || err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    if (!requireAdmin(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
    }
    if (!body.name) return NextResponse.json({ error: 'name required' }, { status: 400 });
    const id = newUuid();
    const teamDoc = { id, name: String(body.name), created_at: new Date().toISOString() };
    await setDocById('teams', id, teamDoc);
    return NextResponse.json({ team: teamDoc }, { status: 201 });
  } catch (err) {
    console.error('[teams POST error]', err);
    return NextResponse.json({ error: String((err as Error).message || err) }, { status: 500 });
  }
}
