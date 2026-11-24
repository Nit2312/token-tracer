/**
 * Superadmin cleanup of one member's synced sessions (delete / reassign) together with everything derived from them.
 * Every derived row (session_turns, session_outcomes, redundant_reprompt_events, prompt_embeddings) is matched by the FULL
 * session identity (org_id = team, user_id = member, tool = source, session_id) of the exact sync_sessions rows being
 * changed — never by session_id alone, so a colliding session_id of another owner is never touched.
 * Callers run these inside a transaction (see withTransaction).
 */
import type { Queryable } from './db';

export interface SessionRow { id: string; session_id: string; team_id: string; member_id: string; source: string }

/** unnest() arrays for the identities: [org_id[], user_id[], tool[], session_id[]]. */
const keyArrays = (rows: SessionRow[]) => [
  rows.map((r) => r.team_id), rows.map((r) => r.member_id), rows.map((r) => r.source), rows.map((r) => r.session_id),
];
const KEYS = 'unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS k(org, usr, tool, sid)';
const MATCH = (t: string) => `${t}.org_id = k.org AND ${t}.user_id = k.usr AND ${t}.tool = k.tool AND ${t}.session_id = k.sid`;

/** Remove the derived rows of the given sessions. Returns how many session_turns rows were removed. */
async function deleteDerived(db: Queryable, rows: SessionRow[]): Promise<number> {
  if (!rows.length) return 0;
  const p = keyArrays(rows);
  // prompt_embeddings has no ON DELETE CASCADE; session_tool_errors cascades from session_turns.
  await db.query(`DELETE FROM prompt_embeddings WHERE turn_id IN (SELECT st.id FROM session_turns st JOIN ${KEYS} ON ${MATCH('st')})`, p);
  await db.query(`DELETE FROM redundant_reprompt_events e USING ${KEYS} WHERE ${MATCH('e')}`, p);
  await db.query(`DELETE FROM session_outcomes o USING ${KEYS} WHERE ${MATCH('o')}`, p);
  const turns = await db.query(`DELETE FROM session_turns st USING ${KEYS} WHERE ${MATCH('st')}`, p);
  return turns.rowCount ?? 0;
}

export async function deleteSessionsWithDerived(db: Queryable, rows: SessionRow[]): Promise<{ turnsDeleted: number; sessionsDeleted: number }> {
  const turnsDeleted = await deleteDerived(db, rows);
  const del = await db.query('DELETE FROM sync_sessions WHERE id = ANY($1::uuid[])', [rows.map((r) => r.id)]);
  return { turnsDeleted, sessionsDeleted: del.rowCount ?? 0 };
}

export async function reassignSessionsWithDerived(
  db: Queryable,
  rows: SessionRow[],
  target: { memberId: string; teamId: string },
): Promise<{ duplicatesRemoved: number; sessionsMoved: number }> {
  // Sessions the target already has (same source + session id) would violate the unique key — the target's copy wins, so
  // the source's duplicate is dropped together with its own derived rows (they must not be re-labelled onto the target's copy).
  const dup = await db.query<SessionRow>(
    `DELETE FROM sync_sessions s
     USING sync_sessions t
     WHERE s.id = ANY($1::uuid[])
       AND t.team_id = $2 AND t.member_id = $3
       AND t.source = s.source AND t.session_id = s.session_id
     RETURNING s.id, s.session_id, s.team_id::text AS team_id, s.member_id::text AS member_id, s.source`,
    [rows.map((r) => r.id), target.teamId, target.memberId],
  );
  await deleteDerived(db, dup.rows);
  const dupIds = new Set(dup.rows.map((r) => r.id));
  const moving = rows.filter((r) => !dupIds.has(r.id));
  if (!moving.length) return { duplicatesRemoved: dup.rowCount ?? 0, sessionsMoved: 0 };

  const p = keyArrays(moving); // OLD identities, captured before the move
  const moved = await db.query(
    'UPDATE sync_sessions SET member_id = $2, team_id = $3 WHERE id = ANY($1::uuid[])',
    [moving.map((r) => r.id), target.memberId, target.teamId],
  );
  const to = [target.teamId, target.memberId];
  await db.query(`UPDATE session_turns st SET org_id = $5, user_id = $6 FROM ${KEYS} WHERE ${MATCH('st')}`, [...p, ...to]);
  await db.query(`UPDATE session_outcomes o SET org_id = $5, user_id = $6 FROM ${KEYS} WHERE ${MATCH('o')}`, [...p, ...to]);
  await db.query(`UPDATE redundant_reprompt_events e SET org_id = $5, user_id = $6 FROM ${KEYS} WHERE ${MATCH('e')}`, [...p, ...to]);
  return { duplicatesRemoved: dup.rowCount ?? 0, sessionsMoved: moved.rowCount ?? 0 };
}
