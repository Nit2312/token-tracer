/**
 * Session ingest logic — upserts sanitized session summaries for one member.
 * Calculates session costs inline using Firestore pricing rules for instant and
 * concurrency-safe pricing without timeouts.
 */
import { queryCol, setDocById, addDocToCol, batchWrite, newUuid } from './db';
import { recalculateTeamCosts, matchesModelPattern } from './stats';
import { saveSessionTurns } from './research';

interface SessionPayload {
  source: string;
  sessionId: string;
  agent?: string | null;
  model?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  tokensCacheRead?: number;
  tokensCacheWrite?: number;
  apiCost?: number | null;
  priced?: boolean;
  edits?: number;
  additions?: number;
  deletions?: number;
  changedLines?: number;
  filesTouched?: number;
  toolCalls?: number;
  toolErrors?: number;
  reworkLoops?: number;
  corrections?: number;
  abandoned?: boolean;
  payloadHash: string;
  tools?: Array<{ name: string; count: number }>;
  files?: Array<{ path: string; edits?: number; additions?: number; deletions?: number }>;
  events?: any[];
}

interface Member {
  member_id: string;
  team_id: string;
}

/**
 * Upsert sanitized session payloads for one member.
 * @returns {{ accepted: number, total: number }}
 */
export async function ingestSessions(
  member: Member,
  sessions: SessionPayload[],
): Promise<{ accepted: number; total: number }> {
  if (!Array.isArray(sessions) || !sessions.length) {
    return { accepted: 0, total: 0 };
  }

  // 1. Fetch custom pricing rules (team-specific overrides first, then global overrides)
  const teamPricingDocs = await queryCol<{
    model_pattern: string;
    cost_in_per_m: number;
    cost_out_per_m: number;
    cost_cache_read_per_m: number;
    team_id: string | null;
  }>('model_pricing', [
    { type: 'where', field: 'team_id', op: '==', value: member.team_id || null },
  ]);
  const globalPricingDocs = await queryCol<{
    model_pattern: string;
    cost_in_per_m: number;
    cost_out_per_m: number;
    cost_cache_read_per_m: number;
    team_id: string | null;
  }>('model_pricing', [
    { type: 'where', field: 'team_id', op: '==', value: null },
  ]);
  const customRules = [...teamPricingDocs, ...globalPricingDocs];

  const defaultRules = [
    { model_pattern: 'claude-3-7-sonnet', cost_in_per_m: 3.0, cost_out_per_m: 15.0, cost_cache_read_per_m: 0.3 },
    { model_pattern: 'claude-3-5-sonnet', cost_in_per_m: 3.0, cost_out_per_m: 15.0, cost_cache_read_per_m: 0.3 },
    { model_pattern: 'claude-3-5-haiku', cost_in_per_m: 0.8, cost_out_per_m: 4.0, cost_cache_read_per_m: 0.08 },
    { model_pattern: 'gpt-4o', cost_in_per_m: 2.5, cost_out_per_m: 10.0, cost_cache_read_per_m: 1.25 },
    { model_pattern: 'o1', cost_in_per_m: 15.0, cost_out_per_m: 60.0, cost_cache_read_per_m: 7.5 },
    { model_pattern: 'o3-mini', cost_in_per_m: 1.1, cost_out_per_m: 4.4, cost_cache_read_per_m: 0.55 },
    { model_pattern: 'deepseek-r1', cost_in_per_m: 0.55, cost_out_per_m: 2.19, cost_cache_read_per_m: 0.14 },
    { model_pattern: 'deepseek-v3', cost_in_per_m: 0.14, cost_out_per_m: 0.28, cost_cache_read_per_m: 0.014 },
    { model_pattern: '', cost_in_per_m: 3.0, cost_out_per_m: 15.0, cost_cache_read_per_m: 0.3 },
  ];

  const allRules = [...customRules, ...defaultRules];

  let accepted = 0;
  for (const item of sessions) {
    const s = item as Record<string, any>;
    const source = String(s.source || 'cursor');
    const sessionId = String(s.sessionId || s.id || s.session_id || `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const model = String(s.model || 'default');

    let tokensIn = Number(s.tokensIn ?? s.tokens_in ?? 0);
    let tokensOut = Number(s.tokensOut ?? s.tokens_out ?? 0);
    const edits = Number(s.edits || 0);
    const toolCalls = Number(s.toolCalls || s.tool_calls || 0);
    const changedLines = Number(s.changedLines || s.changed_lines || 0);

    // Apply token approximations if missing
    if (tokensIn === 0 && tokensOut === 0 && (edits > 0 || toolCalls > 0 || changedLines > 0)) {
      tokensIn = Math.max(500, (toolCalls + edits) * 350 + changedLines * 10);
      tokensOut = Math.max(200, (toolCalls + edits) * 150 + changedLines * 5);
    }

    // 2. Inline server-side cost calculation for this session using matched rules
    const modelName = model.toLowerCase();
    const rule = allRules.find((r) => r.model_pattern && matchesModelPattern(modelName, r.model_pattern)) || defaultRules[defaultRules.length - 1];

    const tokensCacheRead = Number(s.tokensCacheRead ?? s.tokens_cache_read ?? 0);
    const tokensCacheWrite = Number(s.tokensCacheWrite ?? s.tokens_cache_write ?? 0);
    const freshInput = Math.max(0, tokensIn - tokensCacheRead - tokensCacheWrite);

    const cost =
      (freshInput / 1_000_000) * Number(rule.cost_in_per_m || 0) +
      (tokensOut / 1_000_000) * Number(rule.cost_out_per_m || 0) +
      (tokensCacheRead / 1_000_000) * Number(rule.cost_cache_read_per_m || 0) +
      (tokensCacheWrite / 1_000_000) * Number(((rule as any).cost_cache_write_per_m ?? rule.cost_in_per_m) || 0);

    // 3. Upsert the sync_session document
    // Use a composite doc ID for uniqueness: team_member_source_sessionId (hashed)
    const crypto = await import('node:crypto');
    const docId = crypto.createHash('sha256')
      .update(`${member.team_id}:${member.member_id}:${source}:${sessionId}`)
      .digest('hex')
      .slice(0, 40);

    const syncSessionData = {
      doc_id: docId,
      team_id: member.team_id,
      member_id: member.member_id,
      source,
      session_id: sessionId,
      agent: s.agent ?? null,
      label: null,
      model,
      started_at: s.startedAt ?? s.started_at ?? null,
      ended_at: s.endedAt ?? s.ended_at ?? null,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      tokens_cache_read: tokensCacheRead,
      tokens_cache_write: tokensCacheWrite,
      api_cost: cost,
      priced: true,
      edits,
      additions: Number(s.additions || 0),
      deletions: Number(s.deletions || 0),
      changed_lines: changedLines,
      files_touched: Number(s.filesTouched || s.files_touched || 0),
      tool_calls: toolCalls,
      tool_errors: Number(s.toolErrors || s.tool_errors || 0),
      rework_loops: Number(s.reworkLoops || s.rework_loops || 0),
      corrections: Number(s.corrections || 0),
      abandoned: Boolean(s.abandoned),
      payload_hash: s.payloadHash || s.payload_hash || `hash_${Date.now()}_${Math.random()}`,
      events: s.events ? s.events : null,
      synced_at: new Date().toISOString(),
    };

    await setDocById('sync_sessions', docId, syncSessionData, true);
    accepted++;

    // 4. Hook into session turns research calculations
    if (s.events) {
      try {
        await saveSessionTurns(
          member.team_id,
          member.member_id,
          source,
          model,
          sessionId,
          s.events,
        );
      } catch (err) {
        console.error('[ingest-turns-research-notice]', err);
      }
    }

    // 5. Replace session tools and files (delete-then-batch-insert pattern)
    const tools: NonNullable<SessionPayload['tools']> = s.tools ?? [];
    const files: NonNullable<SessionPayload['files']> = s.files ?? [];

    // Delete existing tool/file sub-docs for this session
    const existingTools = await queryCol('sync_session_tools', [
      { type: 'where', field: 'sync_session_id', op: '==', value: docId },
    ]);
    const existingFiles = await queryCol('sync_session_files', [
      { type: 'where', field: 'sync_session_id', op: '==', value: docId },
    ]);

    const deleteOps = [
      ...existingTools.map((d) => ({ type: 'delete' as const, col: 'sync_session_tools', id: d.id })),
      ...existingFiles.map((d) => ({ type: 'delete' as const, col: 'sync_session_files', id: d.id })),
    ];
    if (deleteOps.length) await batchWrite(deleteOps);

    // Insert fresh tool/file docs
    const insertOps = [
      ...tools.map((t) => ({
        type: 'set' as const,
        col: 'sync_session_tools',
        id: newUuid(),
        data: { sync_session_id: docId, tool_name: t.name, call_count: t.count },
      })),
      ...files.map((f) => ({
        type: 'set' as const,
        col: 'sync_session_files',
        id: newUuid(),
        data: {
          sync_session_id: docId,
          path: f.path,
          edits: f.edits ?? 0,
          additions: f.additions ?? 0,
          deletions: f.deletions ?? 0,
        },
      })),
    ];
    if (insertOps.length) await batchWrite(insertOps);
  }

  // 6. Record ingest event
  await addDocToCol('ingest_events', {
    id: newUuid(),
    team_id: member.team_id,
    member_id: member.member_id,
    session_count: sessions.length,
    accepted,
    status: 'ok',
    created_at: new Date().toISOString(),
  });

  return { accepted, total: sessions.length };
}
