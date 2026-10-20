import 'server-only';
/**
 * Tools the analyst chatbot can call. `run_sql` answers arbitrary questions; the
 * rest are pre-built, parameterized analyses so common questions are fast and exact.
 */
import { getPool } from '@/lib/team/db';
import { ALLOWED_TABLES, ANALYST_GRANTS, QueryResult, runReadOnly, SqlGuardError } from './sql-guard';

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

const daysParam = {
  type: 'integer',
  description: 'Look-back window in days (1-365). Default 30.',
  minimum: 1,
  maximum: 365,
};

export const TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'get_schema',
      description: 'List the queryable tables and their columns. Call this before writing SQL if unsure about column names.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_sql',
      description:
        'Run ONE read-only PostgreSQL SELECT (or WITH ... SELECT) query. Max 200 rows returned. No comments, no semicolons, no writes. Use for any question the other tools do not cover.',
      parameters: {
        type: 'object',
        properties: { sql: { type: 'string', description: 'A single PostgreSQL SELECT statement.' } },
        required: ['sql'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'platform_summary',
      description: 'Platform-wide totals for a window: sessions, active members, tokens, cost, edits, lines changed, tool error rate, abandoned sessions.',
      parameters: { type: 'object', properties: { days: daysParam }, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'usage_by_model',
      description: 'Per-model sessions, tokens, cost, cost per 100 changed lines and tool error rate.',
      parameters: { type: 'object', properties: { days: daysParam }, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'top_members',
      description: 'Highest-spending / highest-token members with their team and top model.',
      parameters: {
        type: 'object',
        properties: { days: daysParam, limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 10.' } },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'daily_trend',
      description: 'Per-day sessions, tokens, cost and tool errors, oldest to newest.',
      parameters: { type: 'object', properties: { days: daysParam }, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tool_failures',
      description: 'Per agent tool (bash, edit, read, ...): call count, error count and failure rate.',
      parameters: { type: 'object', properties: { days: daysParam }, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_hotspots',
      description: 'Files agents edit most (edits, lines added/removed, number of sessions).',
      parameters: {
        type: 'object',
        properties: { days: daysParam, limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 10.' } },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'friction_report',
      description: 'Rework and abandonment: abandonment rate, avg rework loops and corrections per session, and how abandonment changes for deep-context sessions.',
      parameters: { type: 'object', properties: { days: daysParam }, additionalProperties: false },
    },
  },
];

export interface ToolOutcome {
  ok: boolean;
  /** JSON-serializable payload handed back to the model. */
  data: unknown;
  /** Present for SQL-backed tools so the UI can show what ran. */
  sql?: string;
  result?: QueryResult;
  error?: string;
}

const ACTIVITY = 'COALESCE(s.ended_at, s.started_at, s.synced_at)';

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

const NOT_SYNTHETIC = "LOWER(COALESCE(s.model, '')) <> '<synthetic>'";

function builtSql(name: string, args: Record<string, unknown>): string | null {
  const days = clampInt(args.days, 30, 1, 365);
  const limit = clampInt(args.limit, 10, 1, 50);
  const since = `${ACTIVITY} >= NOW() - INTERVAL '${days} days'`;
  switch (name) {
    case 'platform_summary':
      return `SELECT COUNT(*)::int AS sessions, COUNT(DISTINCT s.member_id)::int AS active_members,
        COALESCE(SUM(s.tokens_in),0)::bigint AS tokens_in, COALESCE(SUM(s.tokens_out),0)::bigint AS tokens_out,
        COALESCE(SUM(s.tokens_cache_read),0)::bigint AS tokens_cache_read,
        ROUND(COALESCE(SUM(s.api_cost),0)::numeric, 2) AS api_cost_usd,
        COALESCE(SUM(s.edits),0)::bigint AS edits, COALESCE(SUM(s.changed_lines),0)::bigint AS changed_lines,
        COALESCE(SUM(s.tool_calls),0)::bigint AS tool_calls, COALESCE(SUM(s.tool_errors),0)::bigint AS tool_errors,
        ROUND(100.0 * COALESCE(SUM(s.tool_errors),0) / NULLIF(SUM(s.tool_calls),0), 2) AS tool_error_rate_pct,
        COUNT(*) FILTER (WHERE s.abandoned)::int AS abandoned_sessions
        FROM sync_sessions s WHERE ${since}`;
    case 'usage_by_model':
      return `SELECT COALESCE(NULLIF(TRIM(s.model),''),'default') AS model, COUNT(*)::int AS sessions,
        COALESCE(SUM(s.tokens_in + s.tokens_out),0)::bigint AS tokens,
        ROUND(COALESCE(SUM(s.api_cost),0)::numeric, 2) AS cost_usd,
        ROUND((100 * COALESCE(SUM(s.api_cost),0) / NULLIF(SUM(s.changed_lines),0))::numeric, 3) AS cost_per_100_changed_lines,
        ROUND(100.0 * COALESCE(SUM(s.tool_errors),0) / NULLIF(SUM(s.tool_calls),0), 2) AS tool_error_rate_pct
        FROM sync_sessions s WHERE ${since} AND ${NOT_SYNTHETIC}
        GROUP BY 1 ORDER BY cost_usd DESC LIMIT 50`;
    case 'top_members':
      return `SELECT m.display_name AS member, COUNT(*)::int AS sessions,
        COALESCE(SUM(s.tokens_in + s.tokens_out),0)::bigint AS tokens,
        ROUND(COALESCE(SUM(s.api_cost),0)::numeric, 2) AS cost_usd,
        (SELECT t.name FROM teams t WHERE t.id = m.team_id) AS team,
        MODE() WITHIN GROUP (ORDER BY s.model) AS top_model
        FROM sync_sessions s JOIN members m ON m.id = s.member_id
        WHERE ${since} AND ${NOT_SYNTHETIC}
        GROUP BY m.id, m.display_name, m.team_id ORDER BY cost_usd DESC, tokens DESC LIMIT ${limit}`;
    case 'daily_trend':
      return `SELECT (${ACTIVITY})::date AS day, COUNT(*)::int AS sessions,
        COALESCE(SUM(s.tokens_in + s.tokens_out),0)::bigint AS tokens,
        ROUND(COALESCE(SUM(s.api_cost),0)::numeric, 2) AS cost_usd,
        COALESCE(SUM(s.tool_errors),0)::int AS tool_errors
        FROM sync_sessions s WHERE ${since} GROUP BY 1 ORDER BY 1`;
    case 'tool_failures':
      return `SELECT e.tool_name, COUNT(*)::int AS calls, COUNT(*) FILTER (WHERE e.is_error)::int AS errors,
        ROUND(100.0 * COUNT(*) FILTER (WHERE e.is_error) / COUNT(*), 2) AS failure_rate_pct
        FROM session_tool_errors e WHERE e.created_at >= NOW() - INTERVAL '${days} days'
        GROUP BY e.tool_name ORDER BY errors DESC, calls DESC LIMIT 25`;
    case 'file_hotspots':
      return `SELECT f.path, SUM(f.edits)::int AS edits, SUM(f.additions)::int AS additions,
        SUM(f.deletions)::int AS deletions, COUNT(DISTINCT f.sync_session_id)::int AS sessions
        FROM sync_session_files f JOIN sync_sessions s ON s.id = f.sync_session_id
        WHERE ${since} GROUP BY f.path ORDER BY edits DESC, additions + deletions DESC LIMIT ${limit}`;
    case 'friction_report':
      return `WITH peak AS (
          SELECT st.session_id, st.org_id, st.user_id, st.tool, MAX(st.cumulative_input_tokens) AS peak_ctx
          FROM session_turns st WHERE st.created_at >= NOW() - INTERVAL '${days} days' GROUP BY 1,2,3,4)
        SELECT COUNT(*)::int AS sessions, COUNT(*) FILTER (WHERE s.abandoned)::int AS abandoned,
          ROUND(100.0 * COUNT(*) FILTER (WHERE s.abandoned) / NULLIF(COUNT(*),0), 2) AS abandoned_pct,
          ROUND(AVG(s.rework_loops)::numeric, 2) AS avg_rework_loops, ROUND(AVG(s.corrections)::numeric, 2) AS avg_corrections,
          COUNT(*) FILTER (WHERE p.peak_ctx >= 96000)::int AS deep_context_sessions,
          ROUND(100.0 * COUNT(*) FILTER (WHERE p.peak_ctx >= 96000 AND s.abandoned) / NULLIF(COUNT(*) FILTER (WHERE p.peak_ctx >= 96000),0), 2) AS deep_context_abandoned_pct
        FROM sync_sessions s
        LEFT JOIN peak p ON p.session_id = s.session_id AND p.org_id = s.team_id::text AND p.user_id = s.member_id::text AND p.tool = s.source
        WHERE ${since}`;
    default:
      return null;
  }
}

/** Column/table listing for get_schema, restricted to the allowlist. */
async function schemaListing(): Promise<Record<string, string[]>> {
  const { rows } = await getPool().query(
    `SELECT table_name, column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])
     ORDER BY table_name, ordinal_position`,
    [ALLOWED_TABLES as unknown as string[]],
  );
  const out: Record<string, string[]> = {};
  for (const r of rows) {
    // Only expose columns the analyst role can actually read.
    if (ANALYST_GRANTS[r.table_name]?.includes(r.column_name)) (out[r.table_name] ||= []).push(`${r.column_name} (${r.data_type})`);
  }
  return out;
}

export async function executeTool(name: string, rawArgs: unknown): Promise<ToolOutcome> {
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
  try {
    if (name === 'get_schema') {
      return { ok: true, data: await schemaListing() };
    }
    if (name === 'run_sql') {
      const sql = String(args.sql ?? '');
      const result = await runReadOnly(sql);
      return { ok: true, sql, result, data: { columns: result.columns, rows: result.rows, rowCount: result.rowCount, truncated: result.truncated } };
    }
    const sql = builtSql(name, args);
    if (!sql) return { ok: false, data: { error: `Unknown tool: ${name}` }, error: `Unknown tool: ${name}` };
    const result = await runReadOnly(sql, [], true);
    return { ok: true, sql, result, data: { columns: result.columns, rows: result.rows, rowCount: result.rowCount, truncated: result.truncated } };
  } catch (err) {
    const message = err instanceof SqlGuardError ? err.message : String((err as Error).message || err);
    return { ok: false, data: { error: message }, error: message };
  }
}
