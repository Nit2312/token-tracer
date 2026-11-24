/**
 * POST /api/admin/users/sessions   (superadmin only)
 *   { id, action: 'preview' | 'delete' | 'reassign', from?, to?, targetUserId?, confirm? }
 *
 * Cleans up a user's synced session data — e.g. when a PC changed hands and the previous
 * person's history was uploaded under the new person's account.
 *   preview  → counts what the filter matches, changes nothing
 *   delete   → removes the matching sessions and everything derived from them
 *   reassign → moves the matching sessions (and derived rows) to another user's member
 *
 * `from` / `to` (ISO dates) bound the session's activity time (COALESCE(ended_at, started_at,
 * synced_at)); omit both to match every session. delete/reassign require `confirm` to equal
 * the source user's username. Each action runs in one transaction.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/auth';
import { query, withTransaction } from '@/lib/team/db';
import { deleteSessionsWithDerived, reassignSessionsWithDerived, type SessionRow } from '@/lib/team/session-admin';
import { recordAuditEvent } from '@/lib/team/audit';
import { statsCache } from '@/lib/team/cache';
import { publicError } from '@/lib/security/errors';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVITY = 'COALESCE(ended_at, started_at, synced_at)';
const MEMBER_ROLLUP_TABLES = ['daily_member_usage', 'daily_member_tools', 'daily_member_files', 'daily_punch_card'];

function parseDate(v: unknown): Date | null | 'invalid' {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? 'invalid' : d;
}

/** The team new sessions for this member are filed under (same rule as ingest auth). */
async function primaryTeamId(memberId: string): Promise<string | null> {
  const { rows } = await query(
    `SELECT COALESCE(
       (SELECT tm.team_id FROM team_members tm WHERE tm.member_id = m.id ORDER BY tm.created_at ASC LIMIT 1),
       m.team_id
     ) AS team_id FROM members m WHERE m.id = $1`,
    [memberId],
  );
  return rows[0]?.team_id ?? null;
}

export async function POST(req: NextRequest) {
  const session = getSessionFromCookie(req.headers.get('cookie'));
  if (!session || session.role !== 'superadmin') {
    return NextResponse.json({ error: 'superadmin access required' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const id = String(body?.id || '');
  const action = String(body?.action || '');
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'valid user id required' }, { status: 400 });
  if (!['preview', 'delete', 'reassign'].includes(action)) {
    return NextResponse.json({ error: 'action must be preview, delete or reassign' }, { status: 400 });
  }
  const from = parseDate(body?.from);
  const to = parseDate(body?.to);
  if (from === 'invalid' || to === 'invalid') return NextResponse.json({ error: 'invalid date' }, { status: 400 });
  if (from && to && from > to) return NextResponse.json({ error: '"from" must be before "to"' }, { status: 400 });

  try {
    const { rows: userRows } = await query(`SELECT id, username, member_id FROM users WHERE id = $1`, [id]);
    const user = userRows[0];
    if (!user) return NextResponse.json({ error: 'user not found' }, { status: 404 });
    if (!user.member_id) return NextResponse.json({ error: 'this user has no linked member, so no session data' }, { status: 400 });
    const memberId: string = user.member_id;

    // Shared filter on sync_sessions for this member: $1 = member, $2 = from, $3 = to
    const filter = `member_id = $1
      AND ($2::timestamptz IS NULL OR ${ACTIVITY} >= $2)
      AND ($3::timestamptz IS NULL OR ${ACTIVITY} <= $3)`;
    const params = [memberId, from, to];

    const { rows: prev } = await query(
      `SELECT count(*)::int AS sessions,
              COALESCE(sum(tokens_in + tokens_out), 0)::bigint AS tokens,
              COALESCE(sum(api_cost), 0)::float AS cost,
              min(${ACTIVITY}) AS first_at, max(${ACTIVITY}) AS last_at
       FROM sync_sessions WHERE ${filter}`,
      params,
    );
    const preview = prev[0];
    if (action === 'preview') {
      return NextResponse.json({ preview: { ...preview, tokens: Number(preview.tokens) }, username: user.username });
    }

    if (String(body?.confirm || '') !== user.username) {
      return NextResponse.json({ error: `type the username "${user.username}" to confirm` }, { status: 400 });
    }
    if (!preview.sessions) return NextResponse.json({ error: 'no sessions match that filter' }, { status: 404 });

    // ── reassign target ──
    let target: { username: string; memberId: string; teamId: string } | null = null;
    if (action === 'reassign') {
      const targetUserId = String(body?.targetUserId || '');
      if (!UUID_RE.test(targetUserId)) return NextResponse.json({ error: 'targetUserId required' }, { status: 400 });
      const { rows: t } = await query(`SELECT username, member_id FROM users WHERE id = $1`, [targetUserId]);
      if (!t[0]?.member_id) return NextResponse.json({ error: 'target user not found or has no linked member' }, { status: 400 });
      if (t[0].member_id === memberId) return NextResponse.json({ error: 'target is the same member' }, { status: 400 });
      const teamId = await primaryTeamId(t[0].member_id);
      if (!teamId) return NextResponse.json({ error: 'target member has no team' }, { status: 400 });
      target = { username: t[0].username, memberId: t[0].member_id, teamId };
    }

    // Each action is one transaction (withTransaction rolls everything back on any failure).
    const result: Record<string, number> = await withTransaction(async (db) => {
      const out: Record<string, number> = {};
      // The exact sessions being changed, with their full identity (team, member, source, session_id).
      const { rows: sess } = await db.query<SessionRow>(
        `SELECT id, session_id, team_id::text AS team_id, member_id::text AS member_id, source FROM sync_sessions WHERE ${filter}`,
        params,
      );

      if (action === 'delete') {
        Object.assign(out, await deleteSessionsWithDerived(db, sess));

        // Daily rollups can't be split per session, so they're only cleared when EVERYTHING
        // is being deleted (no date filter).
        if (!from && !to) {
          let rollupRows = 0;
          for (const table of MEMBER_ROLLUP_TABLES) {
            const { rows: exists } = await db.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [table]);
            if (!exists[0]?.ok) continue;
            const r = await db.query(`DELETE FROM ${table} WHERE member_id = $1`, [memberId]);
            rollupRows += r.rowCount ?? 0;
          }
          out.rollupRowsDeleted = rollupRows;
        }
      } else if (target) {
        Object.assign(out, await reassignSessionsWithDerived(db, sess, target));
      }
      return out;
    });

    statsCache.clear();
    await recordAuditEvent({
      actorUserId: session.userId,
      actorUsername: session.username,
      action: action === 'delete' ? 'user.delete-sessions' : 'user.reassign-sessions',
      targetType: 'user',
      targetId: id,
      metadata: { ...result, from: from ? from.toISOString() : null, to: to ? to.toISOString() : null, targetUsername: target?.username ?? null },
    });

    return NextResponse.json({ ok: true, result });
  } catch (err) {
    console.error('[admin/users/sessions error]', err);
    return NextResponse.json({ error: publicError(err) }, { status: 500 });
  }
}
