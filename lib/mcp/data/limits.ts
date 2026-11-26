/**
 * Limits of the MCP data layer (P3-1 contracts). Pure: no I/O, and NOTHING here is read from the environment.
 *
 *  - MAX_WINDOW_DAYS is FIXED by decision (2026-11-26): a literal that no configuration, request or flag can change.
 *  - Every other number is PROVISIONAL: it carries its basis and the step at which it is finalised, so the document and the code cannot disagree
 *    about what is decided. Tests recompute the arithmetic behind each one (see tests/mcp-data-contracts.test.ts).
 */
export const MAX_WINDOW_DAYS = 7 as const;
export const MAX_WINDOW_MS: number = MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000;
/**
 * LOOKBACK: how far back from now a window may START (decision 2026-11-26): at most 14 days, aligned with session retention, and never
 * further than the shorter retention of the data source being read. Fixed literals, like the window span. Retention facts come from the
 * nightly cron (app/api/internal/rollup/route.ts): turns 7 days, sessions 14 days (daily rollups keep history, but the contract caps it at 14).
 */
export const MAX_LOOKBACK_DAYS = 14 as const;
export const SOURCE_RETENTION_DAYS = Object.freeze({ activity: 14, sessions: 14, prompts: 7 } as const);
export type WindowSource = keyof typeof SOURCE_RETENTION_DAYS;
export const lookbackMs = (source: WindowSource): number => Math.min(MAX_LOOKBACK_DAYS, SOURCE_RETENTION_DAYS[source]) * 24 * 60 * 60 * 1000;
/** A window may end slightly in the future (client clock skew), never more. */
export const FUTURE_SKEW_MS = 5 * 60 * 1000;

export interface ProvisionalLimit<T> { readonly value: T; readonly status: 'provisional'; readonly basis: string; readonly finalizeAt: string }
const provisional = <T>(value: T, basis: string, finalizeAt: string): ProvisionalLimit<T> => Object.freeze({ value, status: 'provisional' as const, basis, finalizeAt });

export const PROVISIONAL_LIMITS = Object.freeze({
  // Measured with the real projections (scratchpad measure script, recorded in MCP.md section 16.8): a realistic session row is 582 bytes and a prompt-metadata
  // row 551 bytes (each sealed reference alone is ~100 characters); adversarial max-length strings reach 760 and 708 bytes. At 25 rows the WORST case is 19.0 KB and
  // 17.7 KB, inside the budget with no truncation; at the originally proposed 50 it was 38 KB and 35 KB (over). Developer rows are small (327 bytes worst), so 50 fits.
  pageSizeDevelopers: provisional({ default: 25, max: 50 }, 'Developer rows are 102 bytes (327 worst): 50 rows is 5 KB (16 KB worst), inside the budget. A team larger than 50 pages with a cursor.', 'P3-1 review'),
  pageSizeSessions: provisional({ default: 10, max: 25 }, 'Session summary rows are 582 bytes (760 worst): 25 rows is 14.6 KB (19.0 KB worst) vs a 23.5 KB usable budget. 50 would be 29-38 KB, over. Default 10 is about 6 KB.', 'P3-1 review'),
  pageSizePrompts: provisional({ default: 10, max: 25 }, 'Prompt-metadata rows are 551 bytes (708 worst): 25 rows is 13.8 KB (17.7 KB worst). 50 would be 28-35 KB, over. Default 10 is about 5.5 KB.', 'P3-1 review'),
  batchMax: provisional(20, 'A batch of 20 prompt-metadata items is 11.0 KB (14.2 KB worst): inside the budget. Metadata mode only; text mode has its own, smaller cap (textBatchMax).', 'P3-1 review'),
  textBatchMax: provisional(10, 'Only used if prompt text is ever enabled (it is not). Worst-case cost per item is 708 bytes of metadata plus the excerpt, so 20 items x (708 + 1,000) is 34 KB, over the 23.5 KB budget even in ASCII; 10 items is 17 KB. Non-ASCII excerpts can be up to 4 bytes per character, so packWithinBudget must still apply.', 'P3-6 measurement'),
  snippetMaxChars: provisional(1000, 'Only used if prompt text is ever enabled (it is not). 1,000 characters is about 250 tokens: enough for the intent of most prompts, and the smaller the excerpt the less a missed secret can leak. The earlier 2,000 cannot fit even 10 items with metadata in the budget in the worst case. The final value needs the real distribution of prompt lengths (counts only, no text), measured in P3-6.', 'P3-6 measurement'),
  responseByteBudget: provisional(24_576, 'Claude Code documents a warning above 10,000 tokens per MCP tool result and a default cap of 25,000 (MAX_MCP_OUTPUT_TOKENS). JSON tokenises at roughly 3 bytes per token, so 24 KiB is about 8,200 tokens: under the warning threshold with headroom.', 'P3-1 review'),
  cursorTtlMs: provisional(15 * 60 * 1000, 'Long enough to page through a result while reading it, short enough that a leaked cursor expires quickly. Cursors are also bound to principal, team and query.', 'P3-1 review'),
  defaultWindowMs: provisional(24 * 60 * 60 * 1000, 'When a caller gives no window the smallest useful default is "the last day", not the 7-day maximum.', 'P3-1 review'),
});

export interface PageSizes { readonly default: number; readonly max: number }
export const PAGE_SIZES = Object.freeze({
  developers: PROVISIONAL_LIMITS.pageSizeDevelopers.value as PageSizes,
  sessions: PROVISIONAL_LIMITS.pageSizeSessions.value as PageSizes,
  prompts: PROVISIONAL_LIMITS.pageSizePrompts.value as PageSizes,
});
export type PagedKind = keyof typeof PAGE_SIZES;

export const BATCH_MAX: number = PROVISIONAL_LIMITS.batchMax.value;
export const TEXT_BATCH_MAX: number = PROVISIONAL_LIMITS.textBatchMax.value;
export const SNIPPET_MAX_CHARS: number = PROVISIONAL_LIMITS.snippetMaxChars.value;
export const RESPONSE_BYTE_BUDGET: number = PROVISIONAL_LIMITS.responseByteBudget.value;
export const CURSOR_TTL_MS: number = PROVISIONAL_LIMITS.cursorTtlMs.value;
export const DEFAULT_WINDOW_MS: number = PROVISIONAL_LIMITS.defaultWindowMs.value;
/** Room kept for the response envelope (next cursor, flags) when packing items into the budget. */
export const ENVELOPE_RESERVE_BYTES = 1_024;

/** Hard caps on caller-supplied and stored strings (not provisional: they bound what can ever be echoed). */
export const STRING_LIMITS = Object.freeze({ displayName: 80, identifier: 64, cursor: 512, ref: 256, outputString: 200 });

export const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * Keeps the longest prefix of `items` whose JSON fits the budget (minus the envelope reserve). `truncated` tells the caller to hand out a
 * continuation cursor for the first dropped item. Guarantees a response can never exceed the budget, whatever the stored strings contain.
 */
export function packWithinBudget<T>(items: readonly T[], budgetBytes: number = RESPONSE_BYTE_BUDGET): { items: T[]; truncated: boolean } {
  const limit = budgetBytes - ENVELOPE_RESERVE_BYTES;
  const kept: T[] = [];
  let used = 2; // the enclosing brackets
  for (const item of items) {
    const size = jsonBytes(item) + (kept.length ? 1 : 0);
    if (used + size > limit) return { items: kept, truncated: true };
    kept.push(item);
    used += size;
  }
  return { items: kept, truncated: false };
}
