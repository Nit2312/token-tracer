import { queryCol, setDocById, addDocToCol, batchWrite, newUuid, getDocById } from './db';

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
export async function saveSessionTurns(
  teamId: string,
  memberId: string,
  source: string,
  model: string,
  sessionId: string,
  events: any[]
): Promise<void> {
  if ((globalThis as any).abortBackfill) {
    throw new Error('Backfill aborted');
  }
  const isFallback = !events || !events.length;
  let turnsList = events;
  if (!Array.isArray(turnsList) || !turnsList.length) {
    const mockPromptText = `[Trajectory Sync] Workspace interaction via ${source || 'Daemon'} (No event logging payload)`;
    turnsList = [
      { ts: Date.now() - 1000, kind: 'user', text: mockPromptText },
      { ts: Date.now(), kind: 'assistant', text: '[Trajectory Sync] Completion generated.' }
    ];
  }

  // Clean old turns for idempotency
  const oldTurns = await queryCol('session_turns', [
    { type: 'where', field: 'session_id', op: '==', value: sessionId },
  ]);
  if (oldTurns.length) {
    await batchWrite(oldTurns.map((d) => ({ type: 'delete' as const, col: 'session_turns', id: d.id })));
  }

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

  // Fetch session totals for allocation if turn-level usage is missing/null
  // Session is identified by session_id field on sync_sessions docs
  const sessionDocs = await queryCol<{
    tokens_in: number; tokens_out: number; tool_calls: number; tool_errors: number;
    rework_loops: number; corrections: number; additions: number; deletions: number;
    files_touched: number; changed_lines: number;
  }>('sync_sessions', [
    { type: 'where', field: 'session_id', op: '==', value: sessionId },
    { type: 'limit', n: 1 },
  ]);
  const sessionInfo = sessionDocs[0];
  const sessionTokensIn = sessionInfo?.tokens_in || 0;
  const sessionTokensOut = sessionInfo?.tokens_out || 0;
  const sessionToolCalls = sessionInfo?.tool_calls || 0;
  const sessionToolErrors = sessionInfo?.tool_errors || 0;
  const sessionReworkLoops = sessionInfo?.rework_loops || 0;
  const sessionAdditions = sessionInfo?.additions || 0;
  const sessionDeletions = sessionInfo?.deletions || 0;
  const sessionFilesTouched = sessionInfo?.files_touched || 0;

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

  // Collect all turn docs to batch-insert
  const turnDocs: Array<{ id: string; data: Record<string, any> }> = [];
  const toolErrorDocs: Array<{ turnId: string; data: Record<string, any> }> = [];
  const repromptDocs: Array<Record<string, any>> = [];

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

    const userTurnId = newUuid();
    turnDocs.push({
      id: userTurnId,
      data: {
        session_id: sessionId, org_id: teamId, user_id: memberId,
        tool: source, model, turn_index: idx, turn_role: 'user',
        prompt_text_sanitized: userText, prompt_char_len: userText.length,
        has_code_block: hasCodeBlock, has_file_path: hasFilePath,
        has_traceback: hasTraceback, intent_category: intentCategory,
        revert_flag: userRevert,
        created_at: new Date().toISOString(),
      },
    });

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
      turnRevert = sessionReworkLoops > 0 || (sessionInfo?.corrections || 0) > 0;
      toolCallCount = sessionToolCalls;
      toolCallValidCount = sessionFilesTouched;

      if (toolErrors > 0) {
        if (!fallbackToolsUsedCache) {
          // Find sync_session_tools for this session
          const sessionDocs2 = await queryCol<{ id: string }>('sync_sessions', [
            { type: 'where', field: 'session_id', op: '==', value: sessionId },
            { type: 'limit', n: 1 },
          ]);
          const syncSessionDocId = sessionDocs2[0]?.id;
          if (syncSessionDocId) {
            const toolsUsed = await queryCol<{ tool_name: string; call_count: number }>('sync_session_tools', [
              { type: 'where', field: 'sync_session_id', op: '==', value: syncSessionDocId },
            ]);
            fallbackToolsUsedCache = toolsUsed;
          } else {
            fallbackToolsUsedCache = [];
          }
        }
        const toolList: string[] = [];
        for (const tRow of fallbackToolsUsedCache!) {
          const name = tRow.tool_name || 'unknown';
          const count = Number(tRow.call_count || 1);
          for (let c = 0; c < count; c++) toolList.push(name);
        }
        if (!toolList.length) {
          for (let c = 0; c < toolCallCount; c++) toolList.push('unknown');
        }
        let errorInserted = 0;
        for (const toolName of toolList) {
          if (errorInserted >= toolErrors) break;
          toolErrorDocs.push({
            turnId: userTurnId, // will be paired with assistant turn below
            data: {
              session_id: sessionId, org_id: teamId, tool: source, model,
              tool_name: toolName,
              tool_args_summary: 'Mocked tool call from trajectory totals',
              is_error: true,
              created_at: new Date().toISOString(),
            },
          });
          errorInserted++;
        }
      }
    } else {
      for (const toolEv of t.tools) {
        if (toolEv.tool?.isError) toolErrors++;
        if (toolEv.tool?.name === 'run_command' || toolEv.tool?.name === 'command') {
          const cmd = String(toolEv.tool?.args?.command || '').toLowerCase();
          if (/\b(checkout|reset|revert)\b/.test(cmd)) turnRevert = true;
        }
        const edits = extractEditOperations(toolEv);
        for (const op of edits) {
          filesTouchedInTurn.add(op.path);
          linesAdded += op.additions;
          linesRemoved += op.deletions;
        }
      }
      for (const file of filesTouchedInTurn) {
        if (previouslyEditedFiles.has(file)) reworkFlag = true;
        previouslyEditedFiles.add(file);
      }
      toolCallCount = t.tools.length;
      toolCallValidCount = Array.from(filesTouchedInTurn).length;

      if (t.tools.length) {
        for (const toolEv of t.tools) {
          if (!toolEv.tool?.isError) continue;
          toolErrorDocs.push({
            turnId: userTurnId,
            data: {
              session_id: sessionId, org_id: teamId, tool: source, model,
              tool_name: String(toolEv.tool?.name ?? 'unknown'),
              tool_args_summary: summarizeToolArgs(toolEv.tool?.args),
              is_error: true,
              created_at: new Date().toISOString(),
            },
          });
        }
      }
    }

    const assistantTurnId = newUuid();
    turnDocs.push({
      id: assistantTurnId,
      data: {
        session_id: sessionId, org_id: teamId, user_id: memberId,
        tool: source, model, turn_index: idx, turn_role: 'assistant',
        input_tokens: inputTokens, output_tokens: outputTokens,
        cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite,
        cumulative_input_tokens: cumulativeInputTokens,
        files_touched: filesTouchedInTurn.size, lines_added: linesAdded,
        lines_removed: linesRemoved, tool_call_count: toolCallCount,
        tool_call_valid_count: toolCallValidCount,
        tool_error_flag: toolErrors > 0, rework_flag: reworkFlag, revert_flag: turnRevert,
        created_at: new Date().toISOString(),
      },
    });

    // ── Pilot reprompt similarity checks (Study 5) ──
    const pilotOrgId = process.env.ENABLE_REPROMPT_ANALYSIS_ORG_ID;
    if (pilotOrgId && teamId === pilotOrgId && idx > 0) {
      const prevUserText = turns[idx - 1].userEvent?.text || '';
      const similarity = calculateCosineSimilarity(prevUserText, userText);
      if (similarity >= 0.85) {
        repromptDocs.push({
          session_id: sessionId, turn_index: idx,
          similarity_score: similarity,
          tokens_cost_of_following_turn: inputTokens + outputTokens,
          created_at: new Date().toISOString(),
        });
      }
    }
  }

  // Batch-insert all turn docs
  const turnBatchOps = turnDocs.map((d) => ({
    type: 'set' as const, col: 'session_turns', id: d.id, data: d.data,
  }));
  if (turnBatchOps.length) await batchWrite(turnBatchOps);

  // Batch-insert tool error docs
  const errorBatchOps = toolErrorDocs.map((e) => ({
    type: 'set' as const, col: 'session_tool_errors', id: newUuid(), data: e.data,
  }));
  if (errorBatchOps.length) await batchWrite(errorBatchOps);

  // Batch-insert reprompt docs
  const repromptBatchOps = repromptDocs.map((r) => ({
    type: 'set' as const, col: 'redundant_reprompt_events', id: newUuid(), data: r,
  }));
  if (repromptBatchOps.length) await batchWrite(repromptBatchOps);
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

  for (const w of tokens1) { freq1[w] = (freq1[w] || 0) + 1; allWords.add(w); }
  for (const w of tokens2) { freq2[w] = (freq2[w] || 0) + 1; allWords.add(w); }

  let dotProduct = 0, mag1 = 0, mag2 = 0;
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
 * Runs nightly calculations to sync session_turns to session_outcomes rollups
 */
export async function runResearchRollup(): Promise<void> {
  // Fetch all session_turns and aggregate into session_outcomes
  const turns = await queryCol<{
    session_id: string; org_id: string; tool: string; model: string;
    turn_role: string; input_tokens: number; output_tokens: number;
    files_touched: number; lines_added: number; lines_removed: number;
    tool_call_count: number; rework_flag: boolean; revert_flag: boolean;
    tool_error_flag: boolean; intent_category?: string;
  }>('session_turns');

  // Group turns by session_id
  const bySession = new Map<string, typeof turns>();
  for (const t of turns) {
    if (!bySession.has(t.session_id)) bySession.set(t.session_id, []);
    bySession.get(t.session_id)!.push(t);
  }

  const outcomeOps: Array<{ type: 'set'; col: string; id: string; data: object; merge?: boolean }> = [];

  for (const [sessionId, sessionTurns] of bySession) {
    const first = sessionTurns[0];
    if (!first) continue;

    const totalInput = sessionTurns.reduce((s, t) => s + (t.input_tokens || 0), 0);
    const totalOutput = sessionTurns.reduce((s, t) => s + (t.output_tokens || 0), 0);
    const totalFiles = sessionTurns.reduce((s, t) => s + (t.files_touched || 0), 0);
    const totalLines = sessionTurns.reduce((s, t) => s + (t.lines_added || 0) + (t.lines_removed || 0), 0);
    const totalTools = sessionTurns.reduce((s, t) => s + (t.tool_call_count || 0), 0);
    const hadRework = sessionTurns.some((t) => t.rework_flag);
    const hadRevert = sessionTurns.some((t) => t.revert_flag);
    const hadToolError = sessionTurns.some((t) => t.tool_error_flag);
    const intentCategory = sessionTurns.find((t) => t.intent_category)?.intent_category || null;

    // Get cost from sync_sessions
    const syncDocs = await queryCol<{ api_cost: number }>('sync_sessions', [
      { type: 'where', field: 'session_id', op: '==', value: sessionId },
      { type: 'limit', n: 1 },
    ]);
    const totalCost = syncDocs[0]?.api_cost || 0;

    outcomeOps.push({
      type: 'set',
      col: 'session_outcomes',
      id: sessionId,
      data: {
        session_id: sessionId,
        org_id: first.org_id,
        tool: first.tool,
        model: first.model,
        intent_category: intentCategory,
        total_input_tokens: totalInput,
        total_output_tokens: totalOutput,
        total_cost: totalCost,
        files_touched: totalFiles,
        lines_changed: totalLines,
        tool_call_count: totalTools,
        had_rework: hadRework,
        had_revert: hadRevert,
        had_tool_error: hadToolError,
        success: !hadRework && !hadRevert && !hadToolError,
      },
      merge: true,
    });
  }

  if (outcomeOps.length) await batchWrite(outcomeOps);

  // Calculate complexity scores (z-score normalization)
  const outcomes = await queryCol<{
    session_id: string;
    files_touched: number;
    lines_changed: number;
    tool_call_count: number;
  }>('session_outcomes');

  if (!outcomes.length) return;

  const avgFiles = outcomes.reduce((s, o) => s + (o.files_touched || 0), 0) / outcomes.length;
  const avgLines = outcomes.reduce((s, o) => s + (o.lines_changed || 0), 0) / outcomes.length;
  const avgTools = outcomes.reduce((s, o) => s + (o.tool_call_count || 0), 0) / outcomes.length;

  const stddev = (arr: number[], avg: number) => {
    const variance = arr.reduce((s, v) => s + (v - avg) ** 2, 0) / arr.length;
    return Math.sqrt(variance) || 1;
  };

  const stdFiles = stddev(outcomes.map((o) => o.files_touched || 0), avgFiles);
  const stdLines = stddev(outcomes.map((o) => o.lines_changed || 0), avgLines);
  const stdTools = stddev(outcomes.map((o) => o.tool_call_count || 0), avgTools);

  const complexityOps = outcomes.map((o) => ({
    type: 'set' as const,
    col: 'session_outcomes',
    id: o.session_id,
    data: {
      complexity_score:
        ((o.files_touched || 0) - avgFiles) / stdFiles +
        ((o.lines_changed || 0) - avgLines) / stdLines +
        ((o.tool_call_count || 0) - avgTools) / stdTools,
    },
    merge: true,
  }));

  if (complexityOps.length) await batchWrite(complexityOps);
}

export async function backfillResearchAnalytics(limit?: number, offset?: number): Promise<{ processed: number }> {
  const constraints: Parameters<typeof queryCol>[1] = [
    { type: 'orderBy', field: 'synced_at', direction: 'asc' },
  ];
  if (limit) constraints.push({ type: 'limit', n: limit });

  const rows = await queryCol<{
    team_id: string; member_id: string; source: string;
    model: string; session_id: string; events: any;
  }>('sync_sessions', constraints);

  let processed = 0;
  for (const row of rows) {
    if ((globalThis as any).abortBackfill) throw new Error('Backfill aborted');
    let parsedEvents: any[] = [];
    try {
      if (typeof row.events === 'string') parsedEvents = JSON.parse(row.events);
      else if (Array.isArray(row.events)) parsedEvents = row.events;
    } catch { continue; }

    await saveSessionTurns(
      row.team_id || 'unknown_org',
      row.member_id || 'unknown_member',
      row.source || 'cursor',
      row.model || 'default',
      row.session_id,
      parsedEvents,
    );
    processed++;
  }

  await runResearchRollup();
  return { processed };
}
