-- READ-ONLY integrity diagnostics for session_turns / sync_sessions tenant isolation.
-- Every statement is a plain SELECT. Run each one separately, inside `BEGIN READ ONLY; ... ROLLBACK;`, preferably on a
-- Neon branch or read replica first. Results contain identifiers (team/member/session ids) but never prompt text.
-- They are bounded with LIMIT; raise it deliberately. tests/session-turns-isolation.test.ts runs every query below
-- against seeded TEMP tables to prove they parse and detect what they claim to (it never touches real data).
-- Identity of a session = (team_id, member_id, source, session_id); in session_turns it is (org_id, user_id, tool, session_id).
-- NOTE: turns older than 7 days (created_at) are pruned by the daily rollup, so "no turns" is expected for old sessions.

-- name: duplicate_session_ids
-- Detects: the same session_id used by more than one (team, member, source). These are the sessions that were exposed to
-- the old session_id-only delete/lookup bug; everything below is mostly relevant for these ids.
SELECT session_id,
       count(*)                       AS identities,
       count(DISTINCT team_id)        AS teams,
       count(DISTINCT member_id)      AS members,
       count(DISTINCT source)         AS sources,
       min(synced_at)                 AS first_synced,
       max(synced_at)                 AS last_synced
FROM sync_sessions
GROUP BY session_id
HAVING count(*) > 1
ORDER BY identities DESC, session_id
LIMIT 500;

-- name: orphaned_turns
-- Detects: session_turns rows with no parent sync_sessions row under the full identity (turns left behind by a deleted
-- session, written for an identity that never existed, or attributed to the wrong owner). session_id_exists_elsewhere = true
-- means a session with that id exists under a DIFFERENT identity, i.e. a likely mis-attribution rather than plain leftover.
SELECT st.org_id, st.user_id, st.tool, st.session_id,
       count(*)           AS turn_rows,
       min(st.created_at) AS first_turn,
       max(st.created_at) AS last_turn,
       EXISTS (SELECT 1 FROM sync_sessions x WHERE x.session_id = st.session_id) AS session_id_exists_elsewhere
FROM session_turns st
LEFT JOIN sync_sessions ss
       ON ss.session_id = st.session_id
      AND st.org_id  = ss.team_id::text
      AND st.user_id = ss.member_id::text
      AND st.tool    = ss.source
WHERE ss.id IS NULL
GROUP BY st.org_id, st.user_id, st.tool, st.session_id
ORDER BY turn_rows DESC
LIMIT 500;

-- name: sessions_with_events_but_no_turns
-- Detects: sessions that stored an events array but have no turns under their identity: a turn replacement that failed or
-- was wiped (for example by the old session_id-only delete). likely_pruned = synced more than 7 days ago, where missing turns are
-- expected; rows with likely_pruned = false are the real suspects.
SELECT ss.id, ss.team_id, ss.member_id, ss.source, ss.session_id,
       jsonb_array_length(ss.events) AS event_count,
       ss.synced_at,
       ss.synced_at < now() - interval '7 days' AS likely_pruned
FROM sync_sessions ss
WHERE ss.events IS NOT NULL
  AND jsonb_typeof(ss.events) = 'array'
  AND jsonb_array_length(ss.events) > 0
  AND NOT EXISTS (
        SELECT 1 FROM session_turns st
        WHERE st.session_id = ss.session_id
          AND st.org_id  = ss.team_id::text
          AND st.user_id = ss.member_id::text
          AND st.tool    = ss.source)
ORDER BY likely_pruned, ss.synced_at DESC
LIMIT 500;

-- name: turn_role_imbalance
-- Detects (reliably): sessions whose user-turn and assistant-turn counts differ. saveSessionTurns always inserts one of each
-- per turn, so an imbalance means turns were partially deleted or partially written.
SELECT st.org_id, st.user_id, st.tool, st.session_id,
       count(*) FILTER (WHERE st.turn_role = 'user')      AS user_turns,
       count(*) FILTER (WHERE st.turn_role = 'assistant') AS assistant_turns
FROM session_turns st
GROUP BY st.org_id, st.user_id, st.tool, st.session_id
HAVING count(*) FILTER (WHERE st.turn_role = 'user') <> count(*) FILTER (WHERE st.turn_role = 'assistant')
ORDER BY st.session_id
LIMIT 500;

-- name: token_allocation_mismatch_on_duplicated_ids
-- Detects (INDICATIVE ONLY): turns whose summed assistant input tokens differ from the parent's tokens_in by more than rounding.
-- Real per-turn usage legitimately differs from session totals, so this is NOT proof of corruption on its own. It is limited to
-- duplicated session_ids, the only sessions the old bug could have allocated from the wrong parent.
WITH dup AS (SELECT session_id FROM sync_sessions GROUP BY session_id HAVING count(*) > 1)
SELECT ss.team_id, ss.member_id, ss.source, ss.session_id,
       ss.tokens_in                         AS session_tokens_in,
       sum(st.input_tokens)::bigint         AS turns_input_tokens,
       count(*)                             AS assistant_turns
FROM sync_sessions ss
JOIN dup ON dup.session_id = ss.session_id
JOIN session_turns st
  ON st.session_id = ss.session_id AND st.org_id = ss.team_id::text AND st.user_id = ss.member_id::text
 AND st.tool = ss.source AND st.turn_role = 'assistant'
GROUP BY ss.team_id, ss.member_id, ss.source, ss.session_id, ss.tokens_in
HAVING abs(sum(st.input_tokens) - ss.tokens_in) > greatest(count(*), 5)
ORDER BY abs(sum(st.input_tokens) - ss.tokens_in) DESC
LIMIT 500;

-- name: session_outcomes_without_parent
-- Detects: session_outcomes rows (key org_id, user_id, tool, session_id) whose identity has no sync_sessions row — orphans left by
-- deleted sessions. Rows that could not be attributed during the tenant-isolation migration are in session_outcomes_unattributed.
SELECT o.org_id, o.user_id, o.tool, o.session_id
FROM session_outcomes o
LEFT JOIN sync_sessions ss
       ON ss.session_id = o.session_id AND ss.team_id::text = o.org_id AND ss.member_id::text = o.user_id AND ss.source = o.tool
WHERE ss.id IS NULL
ORDER BY o.session_id
LIMIT 500;

-- name: redundant_reprompt_events_quality
-- Detects: redundant_reprompt_events rows with NULL owner columns (legacy rows the migration could not attribute: orphan or shared
-- session_id), rows whose owner has no matching session, and duplicate copies of the same event.
SELECT e.org_id, e.user_id, e.tool, e.session_id, e.turn_index,
       count(*) AS copies,
       (SELECT count(*) FROM sync_sessions s WHERE s.session_id = e.session_id) AS sessions_with_this_id
FROM redundant_reprompt_events e
GROUP BY e.org_id, e.user_id, e.tool, e.session_id, e.turn_index
HAVING e.org_id IS NULL
    OR count(*) > 1
    OR NOT EXISTS (SELECT 1 FROM sync_sessions s
                   WHERE s.session_id = e.session_id AND s.team_id::text = e.org_id AND s.member_id::text = e.user_id AND s.source = e.tool)
ORDER BY copies DESC
LIMIT 500;
