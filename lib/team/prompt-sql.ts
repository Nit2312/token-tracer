/**
 * Shared SQL fragments for joining session_turns to its owner. session_turns has no foreign keys: org_id, user_id and
 * tool are text copies of sync_sessions.team_id, member_id and source, so EVERY join must use all of them.
 */

/** session_turns `st` → its parent sync_sessions `ss` (full identity: session_id + team + member + source). */
export const SESSION_TURN_OWNER_JOIN =
  'ss.session_id = st.session_id AND st.org_id = ss.team_id::text AND st.user_id = ss.member_id::text AND st.tool = ss.source';

/** The assistant turn `ast` that answers the user turn `st` — same session owner, same turn index. */
export const ASSISTANT_TURN_JOIN =
  "ast.session_id = st.session_id AND ast.org_id = st.org_id AND ast.user_id = st.user_id AND ast.tool = st.tool AND ast.turn_index = st.turn_index AND ast.turn_role = 'assistant'";
