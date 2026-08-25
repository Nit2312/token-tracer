import { NextRequest, NextResponse } from 'next/server';
import { memberFromAuthHeader } from '@/lib/team/auth';
import { ingestSessions } from '@/lib/team/ingest';
import { setDocById } from '@/lib/team/db';


export const dynamic = 'force-dynamic';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function POST(req: NextRequest) {
  try {
    const member = await memberFromAuthHeader(req.headers.get('authorization'));
    if (!member) {
      return NextResponse.json({ error: 'invalid API key' }, { status: 401, headers: corsHeaders });
    }

    // Record daemon version whenever the daemon syncs (belt-and-suspenders alongside /update-check)
    const daemonVersion = (req.headers.get('x-daemon-version') || '').trim() || null;
    if (daemonVersion) {
      // Fire-and-forget — don't block ingest on this
      setDocById('members', member.member_id, { daemon_version: daemonVersion, daemon_last_seen_at: new Date().toISOString() }, true)
        .catch((e: unknown) => console.warn('[ingest version-track warn]', e));
    }
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid JSON' }, { status: 400, headers: corsHeaders });
    }
    const sessions = (body.sessions as unknown[]) ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await ingestSessions(member, sessions as any);
    return NextResponse.json(result, { headers: corsHeaders });
  } catch (err) {
    console.error('[ingest POST error]', err);
    return NextResponse.json(
      { error: String((err as Error).message || err) },
      { status: 500, headers: corsHeaders },
    );
  }
}
