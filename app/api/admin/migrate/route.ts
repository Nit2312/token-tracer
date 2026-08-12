import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/auth';
import { ensureSchema } from '@/lib/team/db';

export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/migrate — wired to the "Run database migration" button in
 * the admin UI, which appears when GET /api/admin/users reports needsMigration.
 * Just (re)runs the idempotent schema setup on the shared pool.
 */
export async function POST(req: NextRequest) {
  const session = getSessionFromCookie(req.headers.get('cookie'));
  if (!session || session.role !== 'superadmin') {
    return NextResponse.json({ error: 'superadmin access required' }, { status: 403 });
  }

  try {
    await ensureSchema();
    return NextResponse.json({ ok: true, message: 'Schema initialized.' });
  } catch (err) {
    return NextResponse.json({ error: String((err as Error).message || err) }, { status: 500 });
  }
}
