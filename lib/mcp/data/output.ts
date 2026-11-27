/**
 * Output contracts of the MCP data layer (P3-1). Pure. METADATA ONLY: nothing here can carry prompt text, directly or indirectly.
 *
 * How that is guaranteed:
 *  - Output types have no text-capable field. Intent is a CLOSED enum; flags are booleans; lengths are numbers; identifiers are charset-restricted
 *    and length-capped; references are sealed handles. Free strings are limited to a person's display name (<= 80 chars, control characters stripped).
 *  - Each `toXxx` projection is an ALLOWLIST: it copies only known fields and validates each, so a row with extra columns (a text column, a label,
 *    a path, an event payload, the working-directory name) loses them silently — they cannot reach a response.
 *  - assertMetadataOnly is the final deep guard: any key outside OUTPUT_KEYS, any over-long or control-character string, or too much nesting fails.
 * Session file paths, labels, event payloads and the agent/project name (derived from working directories) are never part of any contract.
 */
import { dataError } from './errors';
import { STRING_LIMITS } from './limits';
import { encodeRef, type RefContext } from './refs';

export const INTENT_CATEGORIES = ['bug_fix', 'feature', 'refactor', 'explain', 'test', 'other'] as const;
export type IntentCategory = (typeof INTENT_CATEGORIES)[number];

export interface Page<T> { readonly items: readonly T[]; readonly nextCursor: string | null; readonly truncated: boolean }

export interface DeveloperSummary { readonly developerId: string; readonly displayName: string; readonly role: 'admin' | 'member' }

export interface DailyActivity {
  readonly day: string; readonly tokensIn: number; readonly tokensOut: number; readonly cacheReadTokens: number; readonly cacheWriteTokens: number;
  readonly apiCost: number; readonly sessionCount: number; readonly toolCalls: number; readonly toolErrors: number; readonly edits: number;
  readonly additions: number; readonly deletions: number; readonly changedLines: number; readonly filesTouched: number; readonly reworkLoops: number;
  readonly corrections: number; readonly abandonedCount: number;
}

export interface SessionSummary {
  readonly sessionRef: string; readonly developerId: string; readonly tool: string; readonly model: string | null;
  readonly startedAt: string | null; readonly endedAt: string | null;
  readonly tokensIn: number; readonly tokensOut: number; readonly cacheReadTokens: number; readonly cacheWriteTokens: number;
  readonly apiCost: number | null; readonly priced: boolean; readonly edits: number; readonly additions: number; readonly deletions: number;
  readonly changedLines: number; readonly filesTouched: number; readonly toolCalls: number; readonly toolErrors: number;
  readonly reworkLoops: number; readonly corrections: number; readonly abandoned: boolean;
}
export interface ToolUsage { readonly toolName: string; readonly callCount: number }
export interface SessionDetails extends SessionSummary { readonly toolUsage: readonly ToolUsage[] }

/** Prompt METADATA. There is no text, excerpt, preview, label or path field, and none can be added without failing the guard tests. */
export interface PromptMetadata {
  readonly promptRef: string; readonly sessionRef: string; readonly developerId: string; readonly turnIndex: number; readonly createdAt: string | null;
  readonly tool: string; readonly model: string | null;
  readonly charLength: number; readonly hasCodeBlock: boolean; readonly hasFilePath: boolean; readonly hasTraceback: boolean; readonly intent: IntentCategory;
  readonly answerTokensIn: number | null; readonly answerTokensOut: number | null; readonly answerCacheReadTokens: number | null; readonly answerCacheWriteTokens: number | null;
}

/** Every key that may appear anywhere in an output. Anything else is rejected by assertMetadataOnly. */
export const OUTPUT_KEYS: ReadonlySet<string> = new Set([
  'items', 'nextCursor', 'truncated',
  'developerId', 'displayName', 'role',
  'day', 'tokensIn', 'tokensOut', 'cacheReadTokens', 'cacheWriteTokens', 'apiCost', 'sessionCount', 'toolCalls', 'toolErrors', 'edits', 'additions',
  'deletions', 'changedLines', 'filesTouched', 'reworkLoops', 'corrections', 'abandonedCount',
  'sessionRef', 'tool', 'model', 'startedAt', 'endedAt', 'priced', 'abandoned', 'toolUsage', 'toolName', 'callCount',
  'promptRef', 'turnIndex', 'createdAt', 'charLength', 'hasCodeBlock', 'hasFilePath', 'hasTraceback', 'intent',
  'answerTokensIn', 'answerTokensOut', 'answerCacheReadTokens', 'answerCacheWriteTokens',
]);

// ── field validators (a database row that does not satisfy the contract is OUR bug: it fails closed with `internal`) ──
type Raw = Record<string, unknown>;
const bad = () => dataError('internal');
const asRaw = (row: unknown): Raw => { if (row === null || typeof row !== 'object' || Array.isArray(row)) throw bad(); return row as Raw; };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENT_RE = /^[A-Za-z0-9_.:+\/@-]{1,64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

function count(v: unknown): number { // bigint columns arrive as digit strings
  const n = typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw bad();
  return n;
}
const countOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : count(v));
function money(v: unknown): number { const n = typeof v === 'string' ? Number(v) : v; if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw bad(); return n; }
const moneyOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : money(v));
function bool(v: unknown): boolean { if (typeof v !== 'boolean') throw bad(); return v; }
function uuid(v: unknown): string { if (typeof v !== 'string' || !UUID_RE.test(v)) throw bad(); return v.toLowerCase(); }
function ident(v: unknown): string { if (typeof v !== 'string' || !IDENT_RE.test(v)) throw bad(); return v; }
const identOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : ident(v));
function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = v instanceof Date ? v.toISOString() : v;
  if (typeof s !== 'string' || !ISO_RE.test(s)) throw bad();
  return s;
}
/** A person's display name is the one free-text field: control characters stripped, whitespace collapsed, length capped. */
export function cleanDisplayName(v: unknown): string {
  if (typeof v !== 'string') throw bad();
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, STRING_LIMITS.displayName);
  if (!s) throw bad();
  return s;
}

// ── projections (allowlists) ──
export function toDeveloperSummary(row: unknown): DeveloperSummary {
  const r = asRaw(row);
  if (r.role !== 'admin' && r.role !== 'member') throw bad();
  return { developerId: uuid(r.member_id), displayName: cleanDisplayName(r.display_name), role: r.role };
}

export function toDailyActivity(row: unknown): DailyActivity {
  const r = asRaw(row);
  if (typeof r.day !== 'string' || !DAY_RE.test(r.day)) throw bad();
  return {
    day: r.day, tokensIn: count(r.tokens_in), tokensOut: count(r.tokens_out), cacheReadTokens: count(r.cache_read_tokens), cacheWriteTokens: count(r.cache_write_tokens),
    apiCost: money(r.api_cost), sessionCount: count(r.session_count), toolCalls: count(r.tool_calls), toolErrors: count(r.tool_errors), edits: count(r.edits),
    additions: count(r.additions), deletions: count(r.deletions), changedLines: count(r.changed_lines), filesTouched: count(r.files_touched),
    reworkLoops: count(r.rework_loops), corrections: count(r.corrections), abandonedCount: count(r.abandoned_count),
  };
}

export function toSessionSummary(row: unknown, ctx: RefContext): SessionSummary {
  const r = asRaw(row);
  return {
    sessionRef: encodeRef('session', String(r.id ?? ''), ctx), developerId: uuid(r.member_id), tool: ident(r.source), model: identOrNull(r.model),
    startedAt: iso(r.started_at), endedAt: iso(r.ended_at),
    tokensIn: count(r.tokens_in), tokensOut: count(r.tokens_out), cacheReadTokens: count(r.tokens_cache_read), cacheWriteTokens: count(r.tokens_cache_write),
    apiCost: moneyOrNull(r.api_cost), priced: bool(r.priced), edits: count(r.edits), additions: count(r.additions), deletions: count(r.deletions),
    changedLines: count(r.changed_lines), filesTouched: count(r.files_touched), toolCalls: count(r.tool_calls), toolErrors: count(r.tool_errors),
    reworkLoops: count(r.rework_loops), corrections: count(r.corrections), abandoned: bool(r.abandoned),
  };
}

export function toSessionDetails(row: unknown, tools: unknown, ctx: RefContext): SessionDetails {
  if (!Array.isArray(tools) || tools.length > 100) throw bad();
  const toolUsage = tools.map((t): ToolUsage => { const x = asRaw(t); return { toolName: ident(x.tool_name), callCount: count(x.call_count) }; });
  return { ...toSessionSummary(row, ctx), toolUsage };
}

export function toPromptMetadata(row: unknown, ctx: RefContext): PromptMetadata {
  const r = asRaw(row);
  if (typeof r.intent_category !== 'string' || !(INTENT_CATEGORIES as readonly string[]).includes(r.intent_category)) throw bad(); // closed enum: no free string
  return {
    promptRef: encodeRef('prompt', String(r.prompt_id ?? ''), ctx), sessionRef: encodeRef('session', String(r.session_uuid ?? ''), ctx), developerId: uuid(r.member_id),
    turnIndex: count(r.turn_index), createdAt: iso(r.created_at), tool: ident(r.tool), model: identOrNull(r.model),
    charLength: count(r.prompt_char_len), hasCodeBlock: bool(r.has_code_block), hasFilePath: bool(r.has_file_path), hasTraceback: bool(r.has_traceback),
    intent: r.intent_category as IntentCategory,
    answerTokensIn: countOrNull(r.answer_input_tokens), answerTokensOut: countOrNull(r.answer_output_tokens),
    answerCacheReadTokens: countOrNull(r.answer_cache_read_tokens), answerCacheWriteTokens: countOrNull(r.answer_cache_write_tokens),
  };
}

/**
 * Final deep guard for any value about to leave the data layer. Throws `internal` (our bug, never the caller's) if a key is not an allowed output key,
 * a string is over-long or contains control characters, a number is not finite, or the nesting is deeper than any contract needs.
 */
export function assertMetadataOnly(value: unknown, depth = 0): void {
  if (depth > 6) throw bad();
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw bad(); return; }
  if (typeof value === 'string') { if (value.length > STRING_LIMITS.outputString || /[\u0000-\u001f\u007f]/.test(value)) throw bad(); return; }
  if (Array.isArray(value)) { for (const v of value) assertMetadataOnly(v, depth + 1); return; }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) { if (!OUTPUT_KEYS.has(k)) throw bad(); assertMetadataOnly(v, depth + 1); }
    return;
  }
  throw bad(); // undefined, functions, symbols, bigint
}
