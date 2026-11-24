/**
 * Prompt / session deletion with tenant-safe targeting.
 *
 * session_turns carries no foreign keys: org_id/user_id/tool are text copies of sync_sessions.team_id/member_id/source.
 * Every ownership check and every DELETE here therefore targets a session by its full identity (the owner keys
 * copied from the verified parent row) — never by session_id alone — and the verification and the deletion
 * operate on exactly the same rows. Everything runs in one transaction.
 */
import { withTransaction, type Queryable } from './db';
import { SESSION_TURN_OWNER_JOIN } from './prompt-sql';

export type DeleteScope = { kind: 'platform' } | { kind: 'team'; teamId: string };

/**
 * Which rows may this session delete? Only a superadmin has platform scope. A team admin is confined to their own team.
 * An admin NOT bound to a team (the built-in `team` account) is denied: it may read across teams but must never delete.
 */
export function resolveDeleteScope(
  session: { role: string; teamId?: string | null } | null,
): { scope: DeleteScope } | { error: string; status: 401 | 403 } {
  if (!session) return { error: 'Unauthorized', status: 401 };
  if (session.role === 'superadmin') return { scope: { kind: 'platform' } };
  if (session.role === 'admin') {
    if (session.teamId) return { scope: { kind: 'team', teamId: session.teamId } };
    return { error: 'Forbidden: this account is not bound to a team and cannot delete prompts or sessions', status: 403 };
  }
  return { error: 'Forbidden: Admin permissions required to delete prompts', status: 403 };
}

export interface DeleteRequest {
  /** Numeric ids are session_turns.id; any other value is a sync session_id (legacy fallback rows). */
  ids: string[];
  sessionId: string | null;
  turnIndex: number | null;
}

/** Actual rows removed: turns (user and assistant rows) and whole sessions. `deleted` is their sum. */
export interface DeleteResult { deleted: number; turns: number; sessions: number }

export class PromptDeleteError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 409) {
    super(message);
  }
}

interface SessionRef { id: string; team_id: string; member_id: string; source: string; session_id: string }

const TEAM_SCOPE = (p: string) =>
  `(ss.team_id = ${p}::uuid OR ss.member_id IN (SELECT tm.member_id FROM team_members tm WHERE tm.team_id = ${p}::uuid))`;

/** Delete the turns (both user and assistant rows) of one verified session, optionally one turn index. */
async function deleteOwnedTurns(db: Queryable, ref: SessionRef, turnIndex: number | null): Promise<number> {
  const owner: unknown[] = [ref.team_id, ref.member_id, ref.source, ref.session_id];
  const idxSql = turnIndex === null ? '' : ' AND turn_index = $5';
  if (turnIndex !== null) owner.push(turnIndex);
  const turnIds = `SELECT id FROM session_turns WHERE org_id = $1 AND user_id = $2 AND tool = $3 AND session_id = $4${idxSql}`;
  await db.query(`DELETE FROM prompt_embeddings WHERE turn_id IN (${turnIds})`, owner);
  await db.query(`DELETE FROM session_tool_errors WHERE turn_id IN (${turnIds})`, owner);
  // redundant_reprompt_events carries the owner columns too. Legacy rows that could not be attributed have NULL owners and
  // are never matched here (see scripts/migrations/tenant-isolation.sql).
  const evIdx = turnIndex === null ? '' : ' AND turn_index = $5';
  await db.query(
    `DELETE FROM redundant_reprompt_events WHERE org_id = $1 AND user_id = $2 AND tool = $3 AND session_id = $4${evIdx}`,
    owner,
  );
  const res = await db.query(`DELETE FROM session_turns WHERE org_id = $1 AND user_id = $2 AND tool = $3 AND session_id = $4${idxSql}`, owner);
  return res.rowCount ?? 0;
}

/** Resolve a client-supplied session_id to exactly one session inside the scope; more than one match is refused. */
async function resolveSession(db: Queryable, scope: DeleteScope, sessionId: string): Promise<SessionRef | null> {
  const params: unknown[] = [sessionId];
  const scopeSql = scope.kind === 'team' ? ` AND ${TEAM_SCOPE('$2')}` : '';
  if (scope.kind === 'team') params.push(scope.teamId);
  const { rows } = await db.query<SessionRef>(
    `SELECT ss.id, ss.team_id::text AS team_id, ss.member_id::text AS member_id, ss.source, ss.session_id
     FROM sync_sessions ss WHERE ss.session_id = $1${scopeSql} LIMIT 2`,
    params,
  );
  if (rows.length > 1) {
    throw new PromptDeleteError('Ambiguous session id: it matches more than one session. Delete by prompt id instead.', 409);
  }
  return rows[0] ?? null;
}

export async function deletePrompts(
  scope: DeleteScope,
  req: DeleteRequest,
  opts?: { executor?: Queryable; nested?: boolean },
): Promise<DeleteResult> {
  const ids = Array.from(new Set(req.ids));
  if (ids.length === 0 && !req.sessionId) throw new PromptDeleteError('Missing id, ids, or sessionId parameter', 400);
  const numericIds = ids.filter((id) => /^\d{1,18}$/.test(id));
  const sessionRefs = ids.filter((id) => !/^\d+$/.test(id));

  return withTransaction(async (db) => {
    let turns = 0;
    let sessions = 0;
    const covered = new Set<string>(); // "session_id#turn_index" already removed via an exact turn id

    if (numericIds.length > 0) {
      const params: unknown[] = [numericIds];
      let sql: string;
      if (scope.kind === 'team') {
        params.push(scope.teamId);
        sql = `SELECT DISTINCT st.session_id, st.org_id, st.user_id, st.tool, st.turn_index
               FROM session_turns st JOIN sync_sessions ss ON ${SESSION_TURN_OWNER_JOIN}
               WHERE st.id = ANY($1::bigint[]) AND ${TEAM_SCOPE('$2')}`;
      } else {
        sql = `SELECT DISTINCT st.session_id, st.org_id, st.user_id, st.tool, st.turn_index
               FROM session_turns st WHERE st.id = ANY($1::bigint[])`;
      }
      const { rows } = await db.query<{ session_id: string; org_id: string; user_id: string; tool: string; turn_index: number }>(sql, params);
      if (rows.length === 0 && scope.kind === 'team') {
        throw new PromptDeleteError('Forbidden: No authorized prompts found to delete', 403);
      }
      for (const r of rows) {
        turns += await deleteOwnedTurns(
          db,
          { id: '', team_id: r.org_id, member_id: r.user_id, source: r.tool, session_id: r.session_id },
          Number(r.turn_index),
        );
        covered.add(`${r.session_id}#${r.turn_index}`);
      }
    }

    for (const sid of sessionRefs) {
      const ref = await resolveSession(db, scope, sid);
      if (!ref) continue;
      turns += await deleteOwnedTurns(db, ref, null);
      const res = await db.query('DELETE FROM sync_sessions WHERE id = $1::uuid', [ref.id]);
      sessions += res.rowCount ?? 0;
    }

    if (req.sessionId && !(req.turnIndex !== null && covered.has(`${req.sessionId}#${req.turnIndex}`))) {
      const ref = await resolveSession(db, scope, req.sessionId);
      if (!ref) {
        if (scope.kind === 'team') throw new PromptDeleteError('Forbidden: Session not found in your team', 403);
      } else {
        turns += await deleteOwnedTurns(db, ref, req.turnIndex);
      }
    }
    return { deleted: turns + sessions, turns, sessions };
  }, opts);
}
