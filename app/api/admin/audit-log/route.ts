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
import { query } from '@/lib/team/db';
import { publicError } from '@/lib/security/errors';

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
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : 100;

    const params: unknown[] = [];
    let where = '';
    if (action) {
      params.push(action);
      where += ` AND action = $${params.length}`;
    }
    if (from) {
      params.push(from);
      where += ` AND created_at::date >= $${params.length}::date`;
    }
    if (to) {
      params.push(to);
      where += ` AND created_at::date <= $${params.length}::date`;
    }
    params.push(limit);

    const { rows } = await query(
      `SELECT id, actor_user_id, actor_username, action, target_type, target_id, metadata, created_at
       FROM audit_log
       WHERE true ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params,
    );

    return NextResponse.json({ events: rows });
  } catch (err: any) {
    console.error('[admin/audit-log GET error]', err);
    return NextResponse.json({ error: publicError(err) }, { status: 500 });
  }
}
