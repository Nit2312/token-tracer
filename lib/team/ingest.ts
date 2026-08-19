/**
 * Session ingest logic — upserts sanitized session summaries for one member.
 * Calculates session costs inline using database pricing rules for instant and
 * concurrency-safe pricing without timeouts.
 */
import { query, insertMany } from './db';
import { recalculateTeamCosts, matchesModelPattern } from './stats';
import { saveSessionTurns } from './research';
import { statsCache } from './cache';

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
  const { rows: customRules } = await query(
    `SELECT model_pattern, cost_in_per_m, cost_out_per_m, cost_cache_read_per_m
     FROM model_pricing
     WHERE team_id = $1 OR team_id IN (SELECT team_id FROM team_members WHERE member_id = $2) OR team_id IS NULL
     ORDER BY (team_id IS NOT NULL) DESC`,
    [member.team_id || null, member.member_id],
  );

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

    const { rows } = await query(
      `INSERT INTO sync_sessions (
        team_id, member_id, source, session_id, agent, label, model,
        started_at, ended_at, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write,
        api_cost, priced, edits, additions, deletions, changed_lines, files_touched,
        tool_calls, tool_errors, rework_loops, corrections, abandoned, payload_hash, events, synced_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27, now()
      )
      ON CONFLICT (team_id, member_id, source, session_id) DO UPDATE SET
        agent = EXCLUDED.agent,
        model = EXCLUDED.model,
        started_at = EXCLUDED.started_at,
        ended_at = EXCLUDED.ended_at,
        tokens_in = EXCLUDED.tokens_in,
        tokens_out = EXCLUDED.tokens_out,
        tokens_cache_read = EXCLUDED.tokens_cache_read,
        tokens_cache_write = EXCLUDED.tokens_cache_write,
        api_cost = EXCLUDED.api_cost,
        priced = EXCLUDED.priced,
        edits = EXCLUDED.edits,
        additions = EXCLUDED.additions,
        deletions = EXCLUDED.deletions,
        changed_lines = EXCLUDED.changed_lines,
        files_touched = EXCLUDED.files_touched,
        tool_calls = EXCLUDED.tool_calls,
        tool_errors = EXCLUDED.tool_errors,
        rework_loops = EXCLUDED.rework_loops,
        corrections = EXCLUDED.corrections,
        abandoned = EXCLUDED.abandoned,
        payload_hash = EXCLUDED.payload_hash,
        events = EXCLUDED.events,
        synced_at = now()
      RETURNING id`,
      [
        member.team_id,
        member.member_id,
        source,
        sessionId,
        s.agent ?? null,
        null,
        model,
        s.startedAt ?? s.started_at ?? null,
        s.endedAt ?? s.ended_at ?? null,
        tokensIn,
        tokensOut,
        tokensCacheRead,
        tokensCacheWrite,
        cost, // Inline Server-Calculated Cost
        true, // Inline Marked as Priced
        edits,
        Number(s.additions || 0),
        Number(s.deletions || 0),
        changedLines,
        Number(s.filesTouched || s.files_touched || 0),
        toolCalls,
        Number(s.toolErrors || s.tool_errors || 0),
        Number(s.reworkLoops || s.rework_loops || 0),
        Number(s.corrections || 0),
        Boolean(s.abandoned),
        s.payloadHash || s.payload_hash || `hash_${Date.now()}_${Math.random()}`,
        s.events ? JSON.stringify(s.events) : null,
      ],
    );

    const syncSessionId = rows[0]?.id;
    if (!syncSessionId) continue;
    accepted++;

    // Hook into session turns research calculations
    if (s.events) {
      try {
        await saveSessionTurns(
          member.team_id,
          member.member_id,
          source,
          model,
          sessionId,
          s.events
        );
      } catch (err) {
        console.error('[ingest-turns-research-notice]', err);
      }
    }

    const tools: NonNullable<SessionPayload['tools']> = s.tools ?? [];
    const files: NonNullable<SessionPayload['files']> = s.files ?? [];

    await Promise.all([
      tools.length
        ? query('DELETE FROM sync_session_tools WHERE sync_session_id = $1', [syncSessionId]).then(() =>
            insertMany(
              'sync_session_tools',
              ['sync_session_id', 'tool_name', 'call_count'],
              ['uuid', 'text', 'int'],
              tools.map((t) => [syncSessionId, t.name, t.count]),
            )
          )
        : query('DELETE FROM sync_session_tools WHERE sync_session_id = $1', [syncSessionId]),

      files.length
        ? query('DELETE FROM sync_session_files WHERE sync_session_id = $1', [syncSessionId]).then(() =>
            insertMany(
              'sync_session_files',
              ['sync_session_id', 'path', 'edits', 'additions', 'deletions'],
              ['uuid', 'text', 'int', 'int', 'int'],
              files.map((f) => [syncSessionId, f.path, f.edits ?? 0, f.additions ?? 0, f.deletions ?? 0]),
            )
          )
        : query('DELETE FROM sync_session_files WHERE sync_session_id = $1', [syncSessionId]),
    ]);
  }

  await query(
    'INSERT INTO ingest_events (team_id, member_id, session_count, accepted, status) VALUES ($1, $2, $3, $4, $5)',
    [member.team_id, member.member_id, sessions.length, accepted, 'ok'],
  );

  if (accepted > 0) {
    statsCache.clear();
  }

  return { accepted, total: sessions.length };
}
