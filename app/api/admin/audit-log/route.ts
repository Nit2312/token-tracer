/**
 * GET /api/admin/audit-log
 * Superadmin-only, read-only view of sensitive platform actions (impersonation,
 * user creation, password resets, pricing changes). Supports optional filters:
 *   ?action=impersonate.start   (exact match)
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   ?limit=100 (default 100, max 500)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/auth';
import { queryCol } from '@/lib/team/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSessionFromCookie(req.headers.get('cookie'));
  if (!session || session.role !== 'superadmin') {
    return NextResponse.json({ error: 'superadmin access required' }, { status: 403 });
  }

  try {
    const action = req.nextUrl.searchParams.get('action');
    const from = req.nextUrl.searchParams.get('from');
    const to = req.nextUrl.searchParams.get('to');
    const limitParam = Number(req.nextUrl.searchParams.get('limit'));
    const limitVal = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : 100;

    let events = await queryCol<any>('audit_log', [
      { type: 'orderBy', field: 'created_at', direction: 'desc' },
    ]);

    // Apply JS filters
    if (action) events = events.filter((e) => e.action === action);
    if (from) events = events.filter((e) => e.created_at && String(e.created_at).slice(0, 10) >= from);
    if (to) events = events.filter((e) => e.created_at && String(e.created_at).slice(0, 10) <= to);
    events = events.slice(0, limitVal);

    return NextResponse.json({ events });
  } catch (err: any) {
    console.error('[admin/audit-log GET error]', err);
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
