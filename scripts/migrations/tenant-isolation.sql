-- Tenant-isolation migration (Phase 1.2). Idempotent. Run inside ONE transaction (scripts/migrate-tenant-isolation.mjs does that).
-- Apply BEFORE deploying the matching application code; see "Rollback" in the script header and in the PR notes.
--
-- 1. session_outcomes: primary key (session_id) -> (org_id, user_id, tool, session_id), new user_id column.
-- 2. redundant_reprompt_events: new owner columns org_id / user_id / tool (nullable) + lookup index.
-- Backfill policy (nothing is ever guessed, nothing is deleted without being preserved):
--   * session_outcomes: attributed to a real member only when the owner is PROVABLY unique (via sync_sessions or via session_turns).
--     Orphans (their sessions were pruned by retention: sync_sessions after 14 days, turns after 7) are KEPT with the reserved
--     nil UUID 00000000-0000-0000-0000-000000000000 as user_id, so org-level research data and complexity statistics are unchanged.
--     Only genuinely AMBIGUOUS rows (several candidate owners) are MOVED to session_outcomes_unattributed.
--   * redundant_reprompt_events: owner columns set only when exactly one sync_sessions row has the session_id; every other row,
--     including all legacy duplicates, is preserved untouched with NULL owner columns (no historical cleanup here).

-- ── redundant_reprompt_events ────────────────────────────────────────────────
ALTER TABLE redundant_reprompt_events
  ADD COLUMN IF NOT EXISTS org_id  TEXT,
  ADD COLUMN IF NOT EXISTS user_id TEXT,
  ADD COLUMN IF NOT EXISTS tool    TEXT;

-- Unique attribution: exactly one sync_sessions row carries this session_id.
UPDATE redundant_reprompt_events e
SET org_id = s.team_id::text, user_id = s.member_id::text, tool = s.source
FROM sync_sessions s
WHERE e.org_id IS NULL
  AND s.session_id = e.session_id
  AND (SELECT count(*) FROM sync_sessions x WHERE x.session_id = e.session_id) = 1;

CREATE INDEX IF NOT EXISTS idx_reprompt_events_owner ON redundant_reprompt_events (org_id, user_id, tool, session_id);

-- ── session_outcomes ─────────────────────────────────────────────────────────
ALTER TABLE session_outcomes ADD COLUMN IF NOT EXISTS user_id TEXT;

-- Holding table for AMBIGUOUS rows only (kept for manual review; never read by the app).
CREATE TABLE IF NOT EXISTS session_outcomes_unattributed (
  LIKE session_outcomes INCLUDING DEFAULTS,
  reason TEXT NOT NULL DEFAULT 'ambiguous',
  quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- (a) Unique via sync_sessions: exactly one member has (team = org_id, source = tool, session_id).
UPDATE session_outcomes o
SET user_id = s.member_id::text
FROM sync_sessions s
WHERE o.user_id IS NULL
  AND s.session_id = o.session_id AND s.team_id::text = o.org_id AND s.source = o.tool
  AND (SELECT count(*) FROM sync_sessions x
        WHERE x.session_id = o.session_id AND x.team_id::text = o.org_id AND x.source = o.tool) = 1;

-- (b) Unique via session_turns: the turns of (org_id, tool, session_id) all belong to a single user_id.
UPDATE session_outcomes o
SET user_id = t.uid
FROM (SELECT org_id, tool, session_id, min(user_id) AS uid
        FROM session_turns GROUP BY org_id, tool, session_id HAVING count(DISTINCT user_id) = 1) t
WHERE o.user_id IS NULL
  AND t.session_id = o.session_id AND t.org_id = o.org_id AND t.tool = o.tool;

-- (c) Genuinely ambiguous rows (several candidate owners, and the turns could not settle it) are MOVED to the holding table.
WITH moved AS (
  DELETE FROM session_outcomes o
  WHERE o.user_id IS NULL
    AND ((SELECT count(*) FROM sync_sessions x
           WHERE x.session_id = o.session_id AND x.team_id::text = o.org_id AND x.source = o.tool) > 1
      OR (SELECT count(DISTINCT t.user_id) FROM session_turns t
           WHERE t.session_id = o.session_id AND t.org_id = o.org_id AND t.tool = o.tool) > 1)
  RETURNING o.*
)
INSERT INTO session_outcomes_unattributed
  (session_id, org_id, user_id, tool, model, intent_category, total_input_tokens, total_output_tokens, total_cost,
   files_touched, lines_changed, tool_call_count, had_rework, had_revert, had_tool_error, success, complexity_score, reason)
SELECT m.session_id, m.org_id, NULL, m.tool, m.model, m.intent_category, m.total_input_tokens, m.total_output_tokens, m.total_cost,
       m.files_touched, m.lines_changed, m.tool_call_count, m.had_rework, m.had_revert, m.had_tool_error, m.success, m.complexity_score,
       CASE WHEN (SELECT count(*) FROM sync_sessions x WHERE x.session_id = m.session_id AND x.team_id::text = m.org_id AND x.source = m.tool) > 1
            THEN 'ambiguous: several members share this (team, source, session_id)'
            ELSE 'ambiguous: the turns of this session belong to several users' END
FROM moved m;

-- (d) Everything else is an orphan (no owner can be determined because the source rows were pruned). KEEP it, owner = nil UUID.
UPDATE session_outcomes SET user_id = '00000000-0000-0000-0000-000000000000' WHERE user_id IS NULL;

ALTER TABLE session_outcomes ALTER COLUMN user_id SET NOT NULL;

-- Swap the primary key unless it is already the composite one.
DO $$
DECLARE pk_name text; pk_cols int;
BEGIN
  SELECT c.conname, cardinality(c.conkey) INTO pk_name, pk_cols
  FROM pg_constraint c WHERE c.conrelid = 'session_outcomes'::regclass AND c.contype = 'p';
  IF pk_name IS NOT NULL AND pk_cols <> 4 THEN
    EXECUTE format('ALTER TABLE session_outcomes DROP CONSTRAINT %I', pk_name);
    pk_name := NULL;
  END IF;
  IF pk_name IS NULL THEN
    ALTER TABLE session_outcomes ADD PRIMARY KEY (org_id, user_id, tool, session_id);
  END IF;
END $$;
