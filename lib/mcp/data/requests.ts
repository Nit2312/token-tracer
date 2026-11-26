/**
 * Request contracts of the MCP data layer (P3-1). Pure. Strict: unknown input is rejected, never ignored and never echoed.
 *
 * METADATA MODE HAS NO TEXT INPUT. The prompt search request has no free-text field of any kind, and any key that is not on its short allowlist
 * (for example `query`, `text`, `q`, `search`, `contains`, `keyword`) is rejected with the SAME generic `invalid_argument` as any other malformed field.
 * That matters beyond tidiness: a text filter would let a caller learn what prompts contain from match/no-match results alone, even if only
 * metadata were returned — an indirect way to read prompt text. Filtering is limited to closed enums, booleans, numeric ranges and short identifiers.
 */
import { dataError } from './errors';
import { BATCH_MAX, PAGE_SIZES, STRING_LIMITS, type PagedKind } from './limits';
import { INTENT_CATEGORIES, type IntentCategory } from './output';
import { resolveWindow, type TimeWindow } from './time-window';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENT_RE = /^[A-Za-z0-9_.:+\/@-]{1,64}$/;
const CURSOR_RE = /^[A-Za-z0-9_-]{1,512}$/;
const MAX_CHARS = 1_000_000;

function strictObject(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw dataError('invalid_argument');
  const out = input as Record<string, unknown>;
  for (const key of Object.keys(out)) if (!allowed.includes(key)) throw dataError('invalid_argument'); // unknown key: rejected, name never echoed
  return out;
}
const own = (o: Record<string, unknown>, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

function limit(v: unknown, kind: PagedKind): number {
  const sizes = PAGE_SIZES[kind];
  if (v === undefined) return sizes.default;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw dataError('invalid_argument');
  if (v > sizes.max) throw dataError('limit_exceeded');
  return v;
}
function cursor(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !CURSOR_RE.test(v) || v.length > STRING_LIMITS.cursor) throw dataError('cursor_invalid');
  return v;
}
function uuid(v: unknown): string { if (typeof v !== 'string' || !UUID_RE.test(v)) throw dataError('invalid_argument'); return v.toLowerCase(); }
const uuidOrNull = (v: unknown): string | null => (v === undefined || v === null ? null : uuid(v));
function ident(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !IDENT_RE.test(v)) throw dataError('invalid_argument');
  return v;
}
function optBool(v: unknown): boolean | null { if (v === undefined || v === null) return null; if (typeof v !== 'boolean') throw dataError('invalid_argument'); return v; }
function optChars(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_CHARS) throw dataError('invalid_argument');
  return v;
}

export interface ListDevelopersRequest { readonly limit: number; readonly cursor: string | null }
export function parseListDevelopersRequest(input: unknown): ListDevelopersRequest {
  const o = strictObject(input, ['limit', 'cursor']);
  return { limit: limit(own(o, 'limit'), 'developers'), cursor: cursor(own(o, 'cursor')) };
}

export interface DeveloperActivityRequest { readonly developerId: string; readonly window: TimeWindow }
export function parseDeveloperActivityRequest(input: unknown, now: Date = new Date()): DeveloperActivityRequest {
  const o = strictObject(input, ['developerId', 'from', 'to']);
  return { developerId: uuid(own(o, 'developerId')), window: resolveWindow({ from: own(o, 'from'), to: own(o, 'to') }, 'activity', now) };
}

export interface ListSessionsRequest {
  readonly developerId: string | null; readonly window: TimeWindow; readonly tool: string | null; readonly model: string | null;
  readonly limit: number; readonly cursor: string | null;
}
export function parseListSessionsRequest(input: unknown, now: Date = new Date()): ListSessionsRequest {
  const o = strictObject(input, ['developerId', 'from', 'to', 'tool', 'model', 'limit', 'cursor']);
  return {
    developerId: uuidOrNull(own(o, 'developerId')), window: resolveWindow({ from: own(o, 'from'), to: own(o, 'to') }, 'sessions', now),
    tool: ident(own(o, 'tool')), model: ident(own(o, 'model')), limit: limit(own(o, 'limit'), 'sessions'), cursor: cursor(own(o, 'cursor')),
  };
}

export interface SessionDetailsRequest { readonly sessionRef: string }
export function parseSessionDetailsRequest(input: unknown): SessionDetailsRequest {
  const o = strictObject(input, ['sessionRef']);
  const ref = own(o, 'sessionRef');
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > STRING_LIMITS.ref) throw dataError('invalid_argument');
  return { sessionRef: ref };
}

export interface PromptMetadataFilters {
  readonly developerId: string | null; readonly intents: readonly IntentCategory[]; readonly hasCodeBlock: boolean | null; readonly hasFilePath: boolean | null;
  readonly hasTraceback: boolean | null; readonly minChars: number | null; readonly maxChars: number | null; readonly tool: string | null; readonly model: string | null;
}
export interface PromptMetadataSearchRequest {
  readonly window: TimeWindow; readonly filters: PromptMetadataFilters; readonly limit: number; readonly cursor: string | null;
}
/** Every accepted key. There is deliberately no text-bearing key in this list, now or in metadata mode ever. */
export const PROMPT_SEARCH_KEYS = Object.freeze(['developerId', 'from', 'to', 'intents', 'hasCodeBlock', 'hasFilePath', 'hasTraceback', 'minChars', 'maxChars', 'tool', 'model', 'limit', 'cursor'] as const);
export function parsePromptMetadataSearchRequest(input: unknown, now: Date = new Date()): PromptMetadataSearchRequest {
  const o = strictObject(input, PROMPT_SEARCH_KEYS);
  let intents: IntentCategory[] = [];
  const rawIntents = own(o, 'intents');
  if (rawIntents !== undefined && rawIntents !== null) {
    if (!Array.isArray(rawIntents) || rawIntents.length > INTENT_CATEGORIES.length) throw dataError('invalid_argument');
    for (const i of rawIntents) if (typeof i !== 'string' || !(INTENT_CATEGORIES as readonly string[]).includes(i)) throw dataError('invalid_argument');
    intents = [...new Set(rawIntents as IntentCategory[])].sort();
  }
  const minChars = optChars(own(o, 'minChars')), maxChars = optChars(own(o, 'maxChars'));
  if (minChars !== null && maxChars !== null && minChars > maxChars) throw dataError('invalid_argument');
  return {
    window: resolveWindow({ from: own(o, 'from'), to: own(o, 'to') }, 'prompts', now),
    filters: {
      developerId: uuidOrNull(own(o, 'developerId')), intents, hasCodeBlock: optBool(own(o, 'hasCodeBlock')), hasFilePath: optBool(own(o, 'hasFilePath')),
      hasTraceback: optBool(own(o, 'hasTraceback')), minChars, maxChars, tool: ident(own(o, 'tool')), model: ident(own(o, 'model')),
    },
    limit: limit(own(o, 'limit'), 'prompts'), cursor: cursor(own(o, 'cursor')),
  };
}

export interface PromptBatchRequest { readonly promptRefs: readonly string[] }
export function parsePromptBatchRequest(input: unknown): PromptBatchRequest {
  const o = strictObject(input, ['promptRefs']);
  const refs = own(o, 'promptRefs');
  if (!Array.isArray(refs) || refs.length < 1) throw dataError('invalid_argument');
  if (refs.length > BATCH_MAX) throw dataError('limit_exceeded');
  for (const r of refs) if (typeof r !== 'string' || r.length === 0 || r.length > STRING_LIMITS.ref) throw dataError('invalid_argument');
  return { promptRefs: [...new Set(refs as string[])] };
}
