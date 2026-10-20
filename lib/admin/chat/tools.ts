import 'server-only';
/**
 * Tools the analyst chatbot can call. `run_sql` answers arbitrary questions; the
 * rest are pre-built, parameterized analyses so common questions are fast and exact.
 */
import { ALLOWED_TABLES, ANALYST_GRANTS, QueryResult, runReadOnly, SqlGuardError } from './sql-guard';

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export const REPORTS = [
  'platform_summary',
  'usage_by_model',
  'top_members',
  'daily_trend',
  'tool_failures',
  'file_hotspots',
  'friction_report',
] as const;
export type ReportName = (typeof REPORTS)[number];

export const REPORT_TITLES: Record<ReportName, string> = {
  platform_summary: 'Platform summary',
  usage_by_model: 'Usage by model',
  top_members: 'Top members',
  daily_trend: 'Daily trend',
  tool_failures: 'Tool failures',
  file_hotspots: 'File hotspots',
  friction_report: 'Rework & abandonment',
};

// Kept deliberately tiny: these definitions are re-sent to the model on every call, so every word costs tokens.
export const TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'report',
      description: 'Prebuilt analysis over the last N days (default 30).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', enum: [...REPORTS] },
          days: { type: 'integer' },
          limit: { type: 'integer' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_sql',
      description: 'One read-only PostgreSQL SELECT. Max 200 rows.',
      parameters: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_schema',
      description: 'Columns of one table (or the table list if omitted).',
      parameters: { type: 'object', properties: { table: { type: 'string' } } },
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

/** Columns of one table (or just the table names) — limited to what the analyst role can read. */
function schemaListing(table?: string): Record<string, string[]> | string[] {
  if (!table) return ALLOWED_TABLES;
  const cols = ANALYST_GRANTS[table.toLowerCase()];
  return cols ? { [table.toLowerCase()]: cols } : ALLOWED_TABLES;
}

export async function executeTool(name: string, rawArgs: unknown): Promise<ToolOutcome> {
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
  try {
    if (name === 'get_schema') {
      return { ok: true, data: schemaListing(typeof args.table === 'string' ? args.table : undefined) };
    }
    if (name === 'run_sql') {
      const sql = String(args.sql ?? '');
      const result = await runReadOnly(sql);
      return { ok: true, sql, result, data: { columns: result.columns, rows: result.rows, rowCount: result.rowCount, truncated: result.truncated } };
    }
    const reportName = name === 'report' ? String(args.name ?? '') : name;
    const sql = (REPORTS as readonly string[]).includes(reportName) ? builtSql(reportName, args) : null;
    if (!sql) return { ok: false, data: { error: `Unknown tool: ${name}` }, error: `Unknown tool: ${name}` };
    const result = await runReadOnly(sql, [], true);
    return { ok: true, sql, result, data: { columns: result.columns, rows: result.rows, rowCount: result.rowCount, truncated: result.truncated } };
  } catch (err) {
    const message = err instanceof SqlGuardError ? err.message : String((err as Error).message || err);
    return { ok: false, data: { error: message }, error: message };
  }
}

// ── Compact formatting ──────────────────────────────────────────────────────

const MODEL_MAX_ROWS = 25;
const MODEL_MAX_CELL = 60;

function compactCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
  if (typeof v === 'string' && /^-?\d+\.\d{4,}$/.test(v)) return String(Math.round(Number(v) * 1000) / 1000);
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > MODEL_MAX_CELL ? `${s.slice(0, MODEL_MAX_CELL)}…` : s;
}

/**
 * What the model sees for a result: header once + one pipe-separated line per row, capped.
 * (JSON repeats every column name on every row, which is several times more tokens.)
 * The UI always gets the full result separately.
 */
export function resultForModel(result: QueryResult): string {
  const rows = result.rows.slice(0, MODEL_MAX_ROWS);
  const lines = [result.columns.join('|'), ...rows.map((r) => result.columns.map((c) => compactCell(r[c])).join('|'))];
  const hidden = result.rowCount - rows.length;
  if (hidden > 0 || result.truncated) lines.push(`(+${Math.max(hidden, 0)}${result.truncated ? '+' : ''} more rows not shown; the user can see all rows. Narrow the query if you need them.)`);
  if (!rows.length) lines.push('(no rows)');
  return lines.join('\n');
}

/** Markdown for a quick report (no AI involved). */
export function quickMarkdown(name: ReportName, days: number, result: QueryResult): string {
  const title = `**${REPORT_TITLES[name]}** — last ${days} days`;
  if (!result.rows.length) return `${title}\n\nNo data in this window.`;
  const rows = result.rows.slice(0, 25);
  const fmt = (v: unknown) => {
    const c = compactCell(v);
    return /^-?\d{4,}$/.test(c) ? Number(c).toLocaleString('en-US') : c.replace(/\|/g, '\\|');
  };
  const head = `| ${result.columns.join(' | ')} |`;
  const sep = `| ${result.columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${result.columns.map((c) => fmt(r[c])).join(' | ')} |`).join('\n');
  const more = result.rowCount > rows.length ? `\n\n_Showing ${rows.length} of ${result.rowCount} rows — open the query below for all of them._` : '';
  return `${title}\n\n${head}\n${sep}\n${body}${more}`;
}

export function clampDays(v: unknown): number {
  return clampInt(v, 30, 1, 365);
}
