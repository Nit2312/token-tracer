import { NextRequest, NextResponse } from 'next/server';
import { getAuthorizedTeamId, getSessionFromCookie } from '@/lib/auth';
import { verifyAdminToken, adminTokenFromCookie, memberFromAuthHeader } from '@/lib/team/auth';
import { queryCol, getDocById, setDocById } from '@/lib/team/db';

export const dynamic = 'force-dynamic';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

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

/** Admin triggers a sync signal for one or all team members. */
export async function POST(req: NextRequest) {
  try {
    if (!requireAdmin(req)) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: corsHeaders });
    }

    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid JSON' }, { status: 400, headers: corsHeaders });
    }

    const rawTeamId = body.teamId ? String(body.teamId) : null;
    const teamId = getAuthorizedTeamId(req, rawTeamId);
    let memberId = String(body.memberId || 'all');

    if (!teamId) {
      return NextResponse.json({ error: 'unauthorized or teamId required' }, { status: 401, headers: corsHeaders });
    }

    const session = getSessionFromCookie(req.headers.get('cookie'));
    if (session?.role === 'user') {
      if (!session.memberId) {
        return NextResponse.json({ error: 'unauthorized: no linked member profile' }, { status: 403, headers: corsHeaders });
      }
      memberId = session.memberId;
    }

    const nowIso = new Date().toISOString();

    if (memberId === 'all') {
      const tmDocs = await queryCol<any>('team_members', [
        { type: 'where', field: 'team_id', op: '==', value: teamId },
      ]);
      await Promise.all(
        tmDocs.map((tm) => setDocById('members', tm.member_id, { sync_requested_at: nowIso }, true))
      );
    } else {
      await setDocById('members', memberId, { sync_requested_at: nowIso }, true);
    }

    return NextResponse.json(
      { success: true, message: `Sync signal broadcasted for ${memberId === 'all' ? 'all members' : memberId}` },
      { headers: corsHeaders },
    );
  } catch (err) {
    console.error('[trigger-sync POST error]', err);
    return NextResponse.json(
      { error: String((err as Error).message || err) },
      { status: 500, headers: corsHeaders },
    );
  }
}

/** Client daemon checks if a sync request is pending for its API key. */
export async function GET(req: NextRequest) {
  try {
    const member = await memberFromAuthHeader(req.headers.get('authorization'));
    if (!member) {
      return NextResponse.json({ error: 'invalid API key' }, { status: 401, headers: corsHeaders });
    }

    const memberDoc = await getDocById('members', member.member_id);
    const syncRequestedAt = memberDoc?.sync_requested_at || null;

    return NextResponse.json(
      { syncRequested: Boolean(syncRequestedAt), syncRequestedAt },
      { headers: corsHeaders },
    );
  } catch (err) {
    console.error('[trigger-sync GET error]', err);
    return NextResponse.json(
      { error: String((err as Error).message || err) },
      { status: 500, headers: corsHeaders },
    );
  }
}
