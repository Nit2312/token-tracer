-- Rollback for tenant-isolation.sql. Run in ONE transaction. READ THE CAVEATS FIRST.
--  * Restoring PRIMARY KEY (session_id) is impossible while two owners share a session_id, so one outcome row per colliding id
--    is kept (the most recently computed is arbitrary) and the others are copied to session_outcomes_unattributed (reason 'rollback-dedup').
--  * Quarantined (unattributed) outcomes are restored only when their session_id is free.
--  * redundant_reprompt_events owner columns are dropped: attribution is lost (the ids stay).
--  * Roll back the application code FIRST (old code expects ON CONFLICT (session_id)), then run this.
INSERT INTO session_outcomes_unattributed
  (session_id, org_id, user_id, tool, model, intent_category, total_input_tokens, total_output_tokens, total_cost,
   files_touched, lines_changed, tool_call_count, had_rework, had_revert, had_tool_error, success, complexity_score, reason)
SELECT o.session_id, o.org_id, o.user_id, o.tool, o.model, o.intent_category, o.total_input_tokens, o.total_output_tokens, o.total_cost,
       o.files_touched, o.lines_changed, o.tool_call_count, o.had_rework, o.had_revert, o.had_tool_error, o.success, o.complexity_score, 'rollback-dedup'
FROM (SELECT *, row_number() OVER (PARTITION BY session_id ORDER BY (user_id = '00000000-0000-0000-0000-000000000000'), org_id, user_id, tool) AS rn FROM session_outcomes) o
WHERE o.rn > 1;

DELETE FROM session_outcomes o USING (
  SELECT org_id, user_id, tool, session_id, row_number() OVER (PARTITION BY session_id ORDER BY (user_id = '00000000-0000-0000-0000-000000000000'), org_id, user_id, tool) AS rn FROM session_outcomes) d
WHERE d.rn > 1 AND o.org_id = d.org_id AND o.user_id = d.user_id AND o.tool = d.tool AND o.session_id = d.session_id;

ALTER TABLE session_outcomes DROP CONSTRAINT IF EXISTS session_outcomes_pkey;
ALTER TABLE session_outcomes ADD PRIMARY KEY (session_id);
ALTER TABLE session_outcomes DROP COLUMN IF EXISTS user_id;

DROP INDEX IF EXISTS idx_reprompt_events_owner;
ALTER TABLE redundant_reprompt_events DROP COLUMN IF EXISTS org_id, DROP COLUMN IF EXISTS user_id, DROP COLUMN IF EXISTS tool;
-- session_outcomes_unattributed is intentionally kept (it may hold the only copy of some rows).
