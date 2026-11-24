import { query, insertMany, withTransaction, type Queryable, type TransactionOptions } from './db';

const EDIT_TOOLS = new Set([
  'edit', 'write', 'notebookedit', 'str_replace_editor', 'apply_patch', 'multiedit'
]);

function lineCount(str: string): number {
  if (!str) return 0;
  return str.split('\n').length;
}

function stringEdit(path: string, oldText: string, newText: string) {
  const p = String(path || '');
  return [{ path: p, additions: lineCount(newText), deletions: lineCount(oldText) }];
}

function parsePatch(patch: string) {
  const edits: Array<{ path: string; additions: number; deletions: number }> = [];
  const lines = patch.split('\n');
  let currentFile = '';
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.startsWith('--- a/')) {
      // ignore
    } else if (line.startsWith('+++ b/')) {
      if (currentFile && (additions > 0 || deletions > 0)) {
        edits.push({ path: currentFile, additions, deletions });
      }
      currentFile = line.substring(6).trim();
      additions = 0;
      deletions = 0;
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      additions++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      deletions++;
    }
  }
  if (currentFile && (additions > 0 || deletions > 0)) {
    edits.push({ path: currentFile, additions, deletions });
  }
  return edits;
}

export function extractEditOperations(ev: any) {
  if (ev?.kind !== 'tool') return [];
  const name = String(ev.tool?.name ?? '').toLowerCase();
  const args = ev.tool?.args ?? {};
  
  const patch = args.patch ?? args.patch_text ?? args.diff ?? '';
  if (patch && (name === 'apply_patch' || patch.includes('+++ b/'))) {
    return parsePatch(patch);
  }
  if (!EDIT_TOOLS.has(name)) return [];

  const p = args.file_path ?? args.path ?? args.notebook_path ?? args.file;
  if (name === 'multiedit' || Array.isArray(args.edits)) {
    return (args.edits ?? []).flatMap((edit: any) => 
      stringEdit(p, edit.old_string ?? edit.old_str ?? '', edit.new_string ?? edit.new_str ?? '')
    );
  }
  if (name === 'write') return stringEdit(p, '', args.content ?? args.file_text ?? args.text ?? '');
  if (name === 'notebookedit') return stringEdit(p, args.old_source ?? '', args.new_source ?? args.source ?? '');
  if (name === 'str_replace_editor') {
    const command = String(args.command ?? '').toLowerCase();
    if (command === 'create') return stringEdit(p, '', args.file_text ?? args.new_str ?? '');
    if (command === 'insert') return stringEdit(p, '', args.new_str ?? args.text ?? '');
    return stringEdit(p, args.old_str ?? args.old_string ?? '', args.new_str ?? args.new_string ?? '');
  }
  return stringEdit(p, args.old_string ?? args.old_str ?? '', args.new_string ?? args.new_str ?? args.content ?? '');
}

/**
 * Classifies prompt intent category using regex rules
 */
export function classifyIntent(text: string): string {
  const t = text.toLowerCase();
  if (/\b(fix|bug|error|issue|crash|fail|broken|prevent|resolve|bugfix|exception)\b/i.test(t)) return 'bug_fix';
  if (/\b(add|implement|create|new|feature|build|support|newfeature)\b/i.test(t)) return 'feature';
  if (/\b(refactor|clean|cleanup|rename|move|simplify|optimize|structure|restructure)\b/i.test(t)) return 'refactor';
  if (/\b(explain|why|what|how|understand|read|question|describe|help)\b/i.test(t)) return 'explain';
  if (/\b(test|tests|coverage|pytest|jest|unittest|spec|specs|testing)\b/i.test(t)) return 'test';
  return 'other';
}

/**
 * Parses events from a trajectory and populates turn-level stats into session_turns
 */
/** Owner marker for legacy session_outcomes rows whose member can no longer be determined (their sessions were pruned). Never a real member. */
export const UNATTRIBUTED_USER_ID = '00000000-0000-0000-0000-000000000000';
/** Advisory-lock key serializing every research rollup (cron, manual endpoint, backfill). */
export const ROLLUP_ADVISORY_LOCK_KEY = 7351204001;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SaveSessionTurnsOptions = TransactionOptions;

/**
 * Replace the stored turns of ONE session. The session's identity is the full unique key of sync_sessions,
 * (team_id, member_id, source, session_id): the parent lookup, the delete of the old turns and the inserts all use
 * every one of those fields — never session_id alone. It all runs in a single transaction, and the parent row is
 * locked, so a failure leaves the previous turns untouched and concurrent re-ingests of one session serialize.
 * If the parent session cannot be identified (unknown, or malformed identity) it throws; there is no fallback.
 */
export async function saveSessionTurns(
  teamId: string,
  memberId: string,
  source: string,
  model: string,
  sessionId: string,
  events: any[],
  opts: SaveSessionTurnsOptions = {},
): Promise<void> {
  if ((globalThis as any).abortBackfill) {
    throw new Error('Backfill aborted');
  }
  if (!UUID_RE.test(String(teamId)) || !UUID_RE.test(String(memberId)) || !source || !sessionId) {
    throw new Error('saveSessionTurns: invalid session identity (team, member, source and session id are all required)');
  }
  // The nil UUID is reserved as the "owner unknown" marker in session_outcomes; a real owner can never be it.
  if (teamId === UNATTRIBUTED_USER_ID || memberId === UNATTRIBUTED_USER_ID) {
    throw new Error('saveSessionTurns: the nil UUID is reserved and cannot identify a team or member');
  }
  await withTransaction((db) => replaceSessionTurns(db, teamId, memberId, source, model, sessionId, events), opts);
}

async function replaceSessionTurns(
  db: Queryable,
  teamId: string,
  memberId: string,
  source: string,
  model: string,
  sessionId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw daemon events, same loose shape as the public entry point
  events: any[],
): Promise<void> {
  const isFallback = !events || !events.length;
  let turnsList = events;
  if (!Array.isArray(turnsList) || !turnsList.length) {
    const mockPromptText = `[Trajectory Sync] Workspace interaction via ${source || 'Daemon'} (No event logging payload)`;
    turnsList = [
      { ts: Date.now() - 1000, kind: 'user', text: mockPromptText },
      { ts: Date.now(), kind: 'assistant', text: '[Trajectory Sync] Completion generated.' }
    ];
  }

  // Identify the parent session by its full unique key and lock it (serializes concurrent re-ingests).
  const { rows: parents } = await db.query<{ id: string; tokens_in: string; tokens_out: string; tool_calls: number; tool_errors: number; rework_loops: number; corrections: number; additions: number; deletions: number; files_touched: number }>(
    `SELECT id, tokens_in, tokens_out, tool_calls, tool_errors, rework_loops, corrections, additions, deletions, files_touched
     FROM sync_sessions
     WHERE team_id = $1::uuid AND member_id = $2::uuid AND source = $3 AND session_id = $4
     FOR UPDATE`,
    [teamId, memberId, source, sessionId],
  );
  if (parents.length !== 1) {
    throw new Error(`saveSessionTurns: parent session not found or ambiguous (${parents.length} matches); refusing to replace turns`);
  }
  const parent = parents[0];

  // Clean old turns for idempotency — only this exact session's turns (org_id/user_id/tool carry team/member/source).
  const owner = [teamId, memberId, source, sessionId];
  await db.query(
    `DELETE FROM prompt_embeddings WHERE turn_id IN (
       SELECT id FROM session_turns WHERE org_id = $1 AND user_id = $2 AND tool = $3 AND session_id = $4)`,
    owner,
  );
  await db.query(
    'DELETE FROM session_turns WHERE org_id = $1 AND user_id = $2 AND tool = $3 AND session_id = $4',
    owner,
  );
  // Reprompt events are derived from the turns just removed; drop this session's (by owner) so re-ingests don't stack copies.
  await db.query(
    'DELETE FROM redundant_reprompt_events WHERE org_id = $1 AND user_id = $2 AND tool = $3 AND session_id = $4',
    owner,
  );

  // Group events into turns starting with each user message
  const turns: any[] = [];
  let currentTurn: any = null;

  for (const ev of turnsList) {
    if (!ev) continue;
    if (ev.kind === 'user') {
      currentTurn = {
        userEvent: ev,
        assistantEvent: null,
        tools: [],
        thinkings: []
      };
      turns.push(currentTurn);
    } else if (currentTurn) {
      if (ev.kind === 'assistant') {
        currentTurn.assistantEvent = ev;
      } else if (ev.kind === 'tool') {
        currentTurn.tools.push(ev);
      } else if (ev.kind === 'thinking') {
        currentTurn.thinkings.push(ev);
      }
    }
  }

  // Session totals for allocation come from the correctly identified parent row.
  const sessionInfo = [parent];
  const sessionTokensIn = Number(sessionInfo[0]?.tokens_in || 0);
  const sessionTokensOut = Number(sessionInfo[0]?.tokens_out || 0);
  const sessionToolCalls = sessionInfo[0]?.tool_calls || 0;
  const sessionToolErrors = sessionInfo[0]?.tool_errors || 0;
  const sessionReworkLoops = sessionInfo[0]?.rework_loops || 0;
  const sessionAdditions = sessionInfo[0]?.additions || 0;
  const sessionDeletions = sessionInfo[0]?.deletions || 0;
  const sessionFilesTouched = sessionInfo[0]?.files_touched || 0;

  let totalPromptWeight = 0;
  let totalResponseWeight = 0;
  const promptWeights = turns.map(t => {
    const w = (t.userEvent?.text || '').length;
    totalPromptWeight += w;
    return w;
  });
  const responseWeights = turns.map(t => {
    const txtLen = (t.assistantEvent?.text || '').length;
    const toolCallCount = t.tools?.length || 0;
    const w = txtLen + toolCallCount * 250;
    totalResponseWeight += w;
    return w;
  });

  const previouslyEditedFiles = new Set<string>();
  let cumulativeInputTokens = 0;

  const userRows: unknown[][] = [];
  const assistantRows: unknown[][] = [];
  // Tool-error rows keyed by turn index — resolved to real turn ids once the
  // assistant rows are bulk-inserted and their generated ids come back.
  const pendingToolErrors: Array<{ turnIndex: number; rows: Array<[string, string | null]> }> = [];
  const repromptRows: unknown[][] = [];
  let fallbackToolsUsedCache: Array<{ tool_name: string; call_count: number }> | null = null;

  for (let idx = 0; idx < turns.length; idx++) {
    const t = turns[idx];
    const userText = t.userEvent.text || '';

    // Feature extraction from user prompt
    const hasCodeBlock = /```[\s\S]*?```/.test(userText);
    const hasFilePath = /(?:[a-zA-Z0-9_\-]+\/)+[a-zA-Z0-9_\.\-]+|[a-zA-Z0-9_\-]+\.(?:ts|tsx|js|jsx|py|json|yml|yaml|css|html|md|rs|go|sh|sql)/i.test(userText);
    const hasTraceback = /\b(traceback|stack trace|at [a-zA-Z0-9_\-\.\/]+\:\d+|exception|uncaught|nullpointer|indexoutofbound)\b/i.test(userText);
    const intentCategory = classifyIntent(userText);
    const userRevert = /\b(revert|undo|go back|reset)\b/i.test(userText);

    userRows.push([
      sessionId, teamId, memberId, source, model, idx, 'user',
      userText, userText.length, hasCodeBlock, hasFilePath, hasTraceback,
      intentCategory, userRevert,
    ]);

    // Extract stats from assistant response & tool calls
    const usage = t.assistantEvent?.usage;
    let inputTokens = Number(usage?.tokensIn ?? usage?.input ?? 0);
    let outputTokens = Number(usage?.tokensOut ?? usage?.output ?? 0);
    const cacheRead = Number(usage?.cacheRead ?? usage?.cacheReadTokens ?? 0);
    const cacheWrite = Number(usage?.cacheWrite ?? 0);

    // Fallback: Allocate session tokens proportionally if turn-level usage is null/0
    if (inputTokens === 0 && outputTokens === 0) {
      inputTokens = totalPromptWeight > 0 
        ? Math.round((promptWeights[idx] / totalPromptWeight) * sessionTokensIn)
        : Math.round(sessionTokensIn / Math.max(1, turns.length));
      
      outputTokens = totalResponseWeight > 0
        ? Math.round((responseWeights[idx] / totalResponseWeight) * sessionTokensOut)
        : Math.round(sessionTokensOut / Math.max(1, turns.length));
    }

    cumulativeInputTokens += inputTokens;

    // Process tool edits
    let filesTouchedInTurn = new Set<string>();
    let linesAdded = 0;
    let linesRemoved = 0;
    let toolErrors = 0;
    let turnRevert = userRevert;
    let reworkFlag = false;
    let toolCallCount = 0;
    let toolCallValidCount = 0;

    if (isFallback) {
      for (let fIdx = 0; fIdx < sessionFilesTouched; fIdx++) {
        filesTouchedInTurn.add(`mock_file_${fIdx}.txt`);
      }
      linesAdded = sessionAdditions;
      linesRemoved = sessionDeletions;
      toolErrors = sessionToolErrors;
      reworkFlag = sessionReworkLoops > 0;
      turnRevert = sessionReworkLoops > 0 || (sessionInfo[0]?.corrections || 0) > 0;
      toolCallCount = sessionToolCalls;
      toolCallValidCount = sessionFilesTouched;
    } else {
      for (const toolEv of t.tools) {
        if (toolEv.tool?.isError) {
          toolErrors++;
        }
        
        // Git command revert checks
        if (toolEv.tool?.name === 'run_command' || toolEv.tool?.name === 'command') {
          const cmd = String(toolEv.tool?.args?.command || '').toLowerCase();
          if (/\b(checkout|reset|revert)\b/.test(cmd)) {
            turnRevert = true;
          }
        }

        const edits = extractEditOperations(toolEv);
        for (const op of edits) {
          filesTouchedInTurn.add(op.path);
          linesAdded += op.additions;
          linesRemoved += op.deletions;
        }
      }

      // Check Rework: editing a file already touched in a previous turn
      for (const file of filesTouchedInTurn) {
        if (previouslyEditedFiles.has(file)) {
          reworkFlag = true;
        }
        previouslyEditedFiles.add(file);
      }

      toolCallCount = t.tools.length;
      toolCallValidCount = Array.from(filesTouchedInTurn).length; // tools that referenced real files/lines
    }

    assistantRows.push([
      sessionId, teamId, memberId, source, model, idx, 'assistant',
      inputTokens, outputTokens, cacheRead, cacheWrite, cumulativeInputTokens,
      filesTouchedInTurn.size, linesAdded, linesRemoved, toolCallCount, toolCallValidCount,
      toolErrors > 0, reworkFlag, turnRevert,
    ]);

    if (isFallback) {
      if (toolErrors > 0) {
        if (!fallbackToolsUsedCache) {
          const { rows: toolsUsed } = await db.query<{ tool_name: string; call_count: number }>(
            `SELECT tool_name, call_count
             FROM sync_session_tools
             WHERE sync_session_id = $1`,
            [parent.id]
          );
          fallbackToolsUsedCache = toolsUsed;
        }
        const toolList: string[] = [];
        for (const tRow of fallbackToolsUsedCache!) {
          const name = tRow.tool_name || 'unknown';
          const count = Number(tRow.call_count || 1);
          for (let c = 0; c < count; c++) {
            toolList.push(name);
          }
        }
        if (!toolList.length) {
          for (let c = 0; c < toolCallCount; c++) {
            toolList.push('unknown');
          }
        }
        const errorRows: Array<[string, string | null]> = [];
        let errorInserted = 0;
        for (const toolName of toolList) {
          if (errorInserted >= toolErrors) break;
          errorRows.push([toolName, 'Mocked tool call from trajectory totals']);
          errorInserted++;
        }
        if (errorRows.length) pendingToolErrors.push({ turnIndex: idx, rows: errorRows });
      }
    } else if (t.tools.length) {
      const errorRows: Array<[string, string | null]> = [];
      for (const toolEv of t.tools) {
        if (!toolEv.tool?.isError) continue;
        const toolName = String(toolEv.tool?.name ?? 'unknown');
        errorRows.push([toolName, summarizeToolArgs(toolEv.tool?.args)]);
      }
      if (errorRows.length) pendingToolErrors.push({ turnIndex: idx, rows: errorRows });
    }

    // ── Pilot reprompt similarity checks (Study 5) ──
    const pilotOrgId = process.env.ENABLE_REPROMPT_ANALYSIS_ORG_ID;
    if (pilotOrgId && teamId === pilotOrgId && idx > 0) {
      const prevUserText = turns[idx - 1].userEvent?.text || '';
      const similarity = calculateCosineSimilarity(prevUserText, userText);

      if (similarity >= 0.85) {
        repromptRows.push([sessionId, teamId, memberId, source, idx, similarity, inputTokens + outputTokens]);
      }
    }
  }

  await insertMany(
    'session_turns',
    ['session_id', 'org_id', 'user_id', 'tool', 'model', 'turn_index', 'turn_role',
      'prompt_text_sanitized', 'prompt_char_len', 'has_code_block', 'has_file_path', 'has_traceback',
      'intent_category', 'revert_flag'],
    ['text', 'text', 'text', 'text', 'text', 'int', 'text',
      'text', 'int', 'boolean', 'boolean', 'boolean',
      'text', 'boolean'],
    userRows,
    { db },
  );

  const { rows: insertedAssistantRows } = await insertMany<{ id: string; turn_index: number }>(
    'session_turns',
    ['session_id', 'org_id', 'user_id', 'tool', 'model', 'turn_index', 'turn_role',
      'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cumulative_input_tokens',
      'files_touched', 'lines_added', 'lines_removed', 'tool_call_count', 'tool_call_valid_count',
      'tool_error_flag', 'rework_flag', 'revert_flag'],
    ['text', 'text', 'text', 'text', 'text', 'int', 'text',
      'int', 'int', 'int', 'int', 'int',
      'int', 'int', 'int', 'int', 'int',
      'boolean', 'boolean', 'boolean'],
    assistantRows,
    { returning: 'id, turn_index', db },
  );

  const turnIdByIndex = new Map<number, string>();
  for (const row of insertedAssistantRows) turnIdByIndex.set(Number(row.turn_index), String(row.id));

  const toolErrorRows: unknown[][] = [];
  for (const pending of pendingToolErrors) {
    const turnId = turnIdByIndex.get(pending.turnIndex);
    if (!turnId) continue;
    for (const [toolName, argsSummary] of pending.rows) {
      toolErrorRows.push([turnId, sessionId, teamId, source, model, toolName, argsSummary, true]);
    }
  }
  await insertMany(
    'session_tool_errors',
    ['turn_id', 'session_id', 'org_id', 'tool', 'model', 'tool_name', 'tool_args_summary', 'is_error'],
    ['bigint', 'text', 'text', 'text', 'text', 'text', 'text', 'boolean'],
    toolErrorRows,
    { db },
  );

  await insertMany(
    'redundant_reprompt_events',
    ['session_id', 'org_id', 'user_id', 'tool', 'turn_index', 'similarity_score', 'tokens_cost_of_following_turn'],
    ['text', 'text', 'text', 'text', 'int', 'numeric', 'int'],
    repromptRows,
    { db },
  );
}

function summarizeToolArgs(args: any): string | null {
  if (!args) return null;
  const val = args.command ?? args.file_path ?? args.path ?? args.notebook_path ?? args.file ?? args.query ?? args.pattern;
  if (val == null) return null;
  const s = String(val);
  return s.length > 500 ? s.slice(0, 500) : s;
}

function getTokens(text: string): string[] {
  return text.toLowerCase().match(/\b\w+\b/g) || [];
}

export function calculateCosineSimilarity(text1: string, text2: string): number {
  const tokens1 = getTokens(text1);
  const tokens2 = getTokens(text2);

  if (!tokens1.length || !tokens2.length) return 0;

  const freq1: Record<string, number> = {};
  const freq2: Record<string, number> = {};
  const allWords = new Set<string>();

  for (const w of tokens1) {
    freq1[w] = (freq1[w] || 0) + 1;
    allWords.add(w);
  }
  for (const w of tokens2) {
    freq2[w] = (freq2[w] || 0) + 1;
    allWords.add(w);
  }

  let dotProduct = 0;
  let mag1 = 0;
  let mag2 = 0;

  for (const w of allWords) {
    const val1 = freq1[w] || 0;
    const val2 = freq2[w] || 0;
    dotProduct += val1 * val2;
    mag1 += val1 * val1;
    mag2 += val2 * val2;
  }

  if (mag1 === 0 || mag2 === 0) return 0;
  return dotProduct / (Math.sqrt(mag1) * Math.sqrt(mag2));
}

/**
 * Nightly research rollup: session_turns -> session_outcomes. EVERY caller (daily cron, manual endpoint, backfill) goes through
 * this one function, so all of them share the same single transaction and advisory lock:
 *   1. take a transaction-level advisory lock (concurrent rollups queue up instead of racing; released at COMMIT/ROLLBACK),
 *   2. upsert attributed outcomes — identity is (org_id, user_id, tool, session_id), the primary key and the conflict target,
 *   3. delete legacy "owner unknown" rows (user_id = nil UUID) ONLY where an attributed row for the same
 *      (org_id, tool, session_id) now exists — never before the upsert succeeded, never without a replacement,
 *   4. recompute complexity scores over the final set of rows,
 *   5. commit. Any failure rolls all of it back, leaving the previous outcomes untouched.
 */
export async function runResearchRollup(opts: TransactionOptions = {}): Promise<void> {
  await withTransaction(async (db) => {
    // Bounded wait: a stuck rollup must not block the next one forever (lock waits honour lock_timeout).
    await db.query("SET LOCAL lock_timeout = '30s'");
    await db.query('SELECT pg_advisory_xact_lock($1::bigint)', [ROLLUP_ADVISORY_LOCK_KEY]);

    await db.query(`
      INSERT INTO session_outcomes (
        session_id, org_id, user_id, tool, model, intent_category,
        total_input_tokens, total_output_tokens, total_cost,
        files_touched, lines_changed, tool_call_count,
        had_rework, had_revert, had_tool_error, success
      )
      SELECT 
        st.session_id,
        st.org_id,
        st.user_id,
        st.tool,
        st.model,
        (SELECT it.intent_category FROM session_turns it
          WHERE it.session_id = st.session_id AND it.org_id = st.org_id AND it.user_id = st.user_id AND it.tool = st.tool
            AND it.intent_category IS NOT NULL
          ORDER BY it.turn_index LIMIT 1) AS intent_category,
        SUM(st.input_tokens)::int AS total_input_tokens,
        SUM(st.output_tokens)::int AS total_output_tokens,
        COALESCE(ss.api_cost, 0)::numeric(12,4) AS total_cost,
        COALESCE((SELECT COUNT(DISTINCT path)::int FROM sync_session_files WHERE sync_session_id = ss.id), 0) AS files_touched,
        SUM(st.lines_added + st.lines_removed)::int AS lines_changed,
        SUM(st.tool_call_count)::int AS tool_call_count,
        BOOL_OR(st.rework_flag) AS had_rework,
        BOOL_OR(st.revert_flag) AS had_revert,
        BOOL_OR(st.tool_error_flag) AS had_tool_error,
        NOT (BOOL_OR(st.rework_flag) OR BOOL_OR(st.revert_flag) OR BOOL_OR(st.tool_error_flag)) AS success
      FROM session_turns st
      LEFT JOIN sync_sessions ss ON ss.session_id = st.session_id
                                AND ss.team_id::text = st.org_id
                                AND ss.member_id::text = st.user_id
                                AND ss.source = st.tool
      GROUP BY st.session_id, st.org_id, st.user_id, st.tool, st.model, ss.id, ss.api_cost
      ON CONFLICT (org_id, user_id, tool, session_id) DO UPDATE SET
        model = EXCLUDED.model,
        intent_category = EXCLUDED.intent_category,
        total_input_tokens = EXCLUDED.total_input_tokens,
        total_output_tokens = EXCLUDED.total_output_tokens,
        total_cost = EXCLUDED.total_cost,
        files_touched = EXCLUDED.files_touched,
        lines_changed = EXCLUDED.lines_changed,
        tool_call_count = EXCLUDED.tool_call_count,
        had_rework = EXCLUDED.had_rework,
        had_revert = EXCLUDED.had_revert,
        had_tool_error = EXCLUDED.had_tool_error,
        success = EXCLUDED.success
    `);

    // Replace legacy sentinel rows once the real owner is known (matched on org_id + tool + session_id).
    await db.query(
      `DELETE FROM session_outcomes s
       WHERE s.user_id = $1
         AND EXISTS (SELECT 1 FROM session_outcomes a
                     WHERE a.org_id = s.org_id AND a.tool = s.tool AND a.session_id = s.session_id AND a.user_id <> $1)`,
      [UNATTRIBUTED_USER_ID],
    );

    // Calculate task complexity scores (after the delete: the statistics describe the final rows)
    await db.query(`
      WITH stats AS (
        SELECT
          AVG(files_touched)::float AS avg_files,
          COALESCE(NULLIF(STDDEV(files_touched)::float, 0), 1) AS stddev_files,
          AVG(lines_changed)::float AS avg_lines,
          COALESCE(NULLIF(STDDEV(lines_changed)::float, 0), 1) AS stddev_lines,
          AVG(tool_call_count)::float AS avg_tools,
          COALESCE(NULLIF(STDDEV(tool_call_count)::float, 0), 1) AS stddev_tools
        FROM session_outcomes
      )
      UPDATE session_outcomes
      SET complexity_score = (
        (files_touched - (SELECT avg_files FROM stats)) / (SELECT stddev_files FROM stats) +
        (lines_changed - (SELECT avg_lines FROM stats)) / (SELECT stddev_lines FROM stats) +
        (tool_call_count - (SELECT avg_tools FROM stats)) / (SELECT stddev_tools FROM stats)
      );
    `);
  }, opts);
}

export async function backfillResearchAnalytics(limit?: number, offset?: number): Promise<{ processed: number }> {
  // Fetch all sync_sessions to backfill turn analytics
  const limitClause = limit ? `LIMIT ${limit} OFFSET ${offset || 0}` : '';
  const { rows } = await query(`
    SELECT team_id::text AS org_id, member_id::text AS user_id, source AS tool, model, session_id, events
    FROM sync_sessions
    ORDER BY id
    ${limitClause}
  `);

  let processed = 0;
  for (const row of rows) {
    if ((globalThis as any).abortBackfill) {
      throw new Error('Backfill aborted');
    }
    let parsedEvents: any[] = [];
    try {
      if (typeof row.events === 'string') {
        parsedEvents = JSON.parse(row.events);
      } else if (Array.isArray(row.events)) {
        parsedEvents = row.events;
      }
    } catch {
      continue;
    }

    await saveSessionTurns(
      row.org_id || 'unknown_org',
      row.user_id || 'unknown_member',
      row.tool || 'cursor',
      row.model || 'default',
      row.session_id,
      parsedEvents
    );
    processed++;
  }

  // Run outcome rollups
  await runResearchRollup();

  return { processed };
}
