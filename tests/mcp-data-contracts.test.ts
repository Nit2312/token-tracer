/**
 * P3-1: contracts of the MCP data layer (lib/mcp/data). DB-free: no SQL, no database, no HTTP, no network.
 * Proves: the 7-day window is fixed; every provisional limit is backed by arithmetic that is recomputed here; prompt text can NOT be enabled by
 * the flag alone; metadata-mode contracts cannot carry prompt text, directly or through a search oracle; references and cursors are opaque,
 * bound and uniformly rejected; errors never echo input; the excluded-column policy holds; and the module is free of I/O.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { inspect } from 'node:util';
import path from 'node:path';
import { CLIENT_ERROR_CODES, DATA_ERROR_MESSAGES, DataError, isDataError, toDataError, type DataErrorCode } from '../lib/mcp/data/errors';
import {
  BATCH_MAX, ENVELOPE_RESERVE_BYTES, FUTURE_SKEW_MS, MAX_WINDOW_DAYS, MAX_WINDOW_MS, PAGE_SIZES, PROVISIONAL_LIMITS, RESPONSE_BYTE_BUDGET, SNIPPET_MAX_CHARS,
  STRING_LIMITS, TEXT_BATCH_MAX, jsonBytes, packWithinBudget,
} from '../lib/mcp/data/limits';
import { parseInstant, resolveWindow } from '../lib/mcp/data/time-window';
import { assertScope, createDataScope, scopeDbArgs, type DataScope } from '../lib/mcp/data/scope';
import { openJson, sealJson } from '../lib/mcp/data/sealed';
import { decodeRef, encodeRef, type RefContext } from '../lib/mcp/data/refs';
import { decodeCursor, encodeCursor, fingerprintFilters, type CursorContext } from '../lib/mcp/data/cursor';
import { PROMPT_TEXT_POLICY_VERSION, RECORDED_PROMPT_TEXT_APPROVAL, isValidApproval, resolvePromptAccess, type PromptTextApproval } from '../lib/mcp/data/prompt-access';
import {
  INTENT_CATEGORIES, OUTPUT_KEYS, assertMetadataOnly, cleanDisplayName, toDailyActivity, toDeveloperSummary, toPromptMetadata, toSessionDetails, toSessionSummary,
  type PromptMetadata, type SessionDetails, type SessionSummary,
} from '../lib/mcp/data/output';
import {
  PROMPT_SEARCH_KEYS, parseDeveloperActivityRequest, parseListDevelopersRequest, parseListSessionsRequest, parsePromptBatchRequest, parsePromptMetadataSearchRequest,
  parseSessionDetailsRequest,
} from '../lib/mcp/data/requests';
import { MCP_EXCLUDED_TABLES, MCP_NEVER_EXPOSED_COLUMNS, MCP_TEXT_GATED_COLUMNS, isMcpColumnAllowed } from '../lib/team/mcp-policy';

const NOW = new Date('2026-11-26T12:00:00.000Z');
const SECRET = 'p3-1-contract-test-secret-0123456789';
const USER = '11111111-1111-4111-8111-111111111111';
const TEAM = '22222222-2222-4222-8222-222222222222';
const OTHER_TEAM = '33333333-3333-4333-8333-333333333333';
const OTHER_USER = '44444444-4444-4444-8444-444444444444';
const mkScope = (over: Partial<{ userId: string; teamId: string }> = {}): DataScope => createDataScope({ tokenHash: crypto.randomBytes(32), userId: USER, teamId: TEAM, ...over });
const ctx = (scope = mkScope()): RefContext & CursorContext => ({ scope, secret: SECRET });
const uuid = () => crypto.randomUUID();
const code = (fn: () => unknown): DataErrorCode | 'no-error' | 'other' => { try { fn(); return 'no-error'; } catch (e) { return isDataError(e) ? e.code : 'other'; } };
const message = (fn: () => unknown): string => { try { fn(); return ''; } catch (e) { return (e as Error).message; } };

// ── builders for synthetic rows (realistic and adversarial worst case) ──
const L = (n: number, c = 'a') => c.repeat(n);
const sessionRow = (worst = false) => ({
  id: uuid(), member_id: uuid(), source: worst ? L(64) : 'claude-code', model: worst ? L(64) : 'claude-sonnet-4-5-20250929', started_at: '2026-11-24T09:11:37.717Z', ended_at: '2026-11-24T10:41:02.250Z',
  tokens_in: worst ? '999999999999999' : 1_234_567, tokens_out: worst ? '999999999999999' : 98_765, tokens_cache_read: worst ? '999999999999999' : 4_567_890, tokens_cache_write: worst ? '999999999999999' : 123_456,
  api_cost: worst ? 99999.123456789 : 12.3456, priced: true, edits: worst ? 99999999 : 42, additions: worst ? 99999999 : 640, deletions: worst ? 99999999 : 120, changed_lines: worst ? 99999999 : 760,
  files_touched: worst ? 99999 : 14, tool_calls: worst ? 99999999 : 215, tool_errors: worst ? 99999999 : 3, rework_loops: worst ? 99999 : 2, corrections: worst ? 99999 : 1, abandoned: false,
});
const promptRow = (worst = false) => ({
  prompt_id: worst ? '9007199254740991' : '48213', session_uuid: uuid(), member_id: uuid(), turn_index: worst ? 99999999 : 17, created_at: '2026-11-24T09:12:37.717Z',
  tool: worst ? L(64) : 'claude-code', model: worst ? L(64) : 'claude-sonnet-4-5-20250929', prompt_char_len: worst ? 1_000_000 : 412, has_code_block: true, has_file_path: true, has_traceback: false,
  intent_category: 'bug_fix', answer_input_tokens: worst ? '999999999999999' : 31_204, answer_output_tokens: worst ? '999999999999999' : 2_190,
  answer_cache_read_tokens: worst ? '999999999999999' : 120_345, answer_cache_write_tokens: worst ? '999999999999999' : 8_120,
});
const devRow = (worst = false) => ({ member_id: uuid(), display_name: worst ? '名'.repeat(80) : 'Priya Natarajan', role: 'member' });
const dayRow = (worst = false) => ({
  day: '2026-11-24', tokens_in: worst ? '999999999999999' : 3_400_000, tokens_out: worst ? '999999999999999' : 210_000, cache_read_tokens: worst ? '999999999999999' : 9_100_000,
  cache_write_tokens: worst ? '999999999999999' : 400_000, api_cost: worst ? 99999.123456789 : 41.2, session_count: worst ? 99999 : 9, tool_calls: worst ? 99999999 : 640, tool_errors: worst ? 99999999 : 12,
  edits: worst ? 99999999 : 90, additions: worst ? 99999999 : 1200, deletions: worst ? 99999999 : 300, changed_lines: worst ? 99999999 : 1500, files_touched: worst ? 99999 : 31, rework_loops: worst ? 99999 : 4,
  corrections: worst ? 99999 : 2, abandoned_count: worst ? 99999 : 0,
});
const usable = RESPONSE_BYTE_BUDGET - ENVELOPE_RESERVE_BYTES;
const listBytes = (item: unknown, n: number) => jsonBytes(item) * n + (n - 1) + 2;

describe('the 7-day window is fixed', () => {
  it('is a literal 7 that no environment variable, request or flag can change', () => {
    const seven: 7 = MAX_WINDOW_DAYS; assert.equal(seven, 7); // compile-time: the type is the literal 7
    assert.equal(MAX_WINDOW_MS, 7 * 86_400_000);
    for (const [k, v] of [['MCP_MAX_WINDOW_DAYS', '30'], ['MCP_WINDOW_DAYS', '30'], ['MAX_WINDOW_DAYS', '30']]) process.env[k] = v;
    try { assert.equal(code(() => resolveWindow({ from: '2026-11-01', to: '2026-11-20' }, NOW)), 'window_too_large'); } finally { for (const k of ['MCP_MAX_WINDOW_DAYS', 'MCP_WINDOW_DAYS', 'MAX_WINDOW_DAYS']) delete process.env[k]; }
    for (const f of ['limits.ts', 'time-window.ts']) assert.doesNotMatch(fs.readFileSync(path.join(process.cwd(), 'lib/mcp/data', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1'), /process\.env|\benv\./, f);
  });
  it('accepts exactly 7 days and rejects 7 days + 1 ms, whatever the representation', () => {
    const to = '2026-11-26T12:00:00Z';
    assert.deepEqual(resolveWindow({ from: '2026-11-19T12:00:00Z', to }, NOW).to.toISOString(), '2026-11-26T12:00:00.000Z');
    assert.equal(code(() => resolveWindow({ from: '2026-11-19T11:59:59.999Z', to }, NOW)), 'window_too_large');
    assert.equal(code(() => resolveWindow({ from: '2026-11-19T07:00:00-05:00', to: '2026-11-26T12:00:00Z' }, NOW)), 'no-error'); // same instant as 12:00Z
    assert.equal(code(() => resolveWindow({ from: '2026-11-18', to: '2026-11-26' }, NOW)), 'window_too_large'); // 8 days by date
    assert.equal(code(() => resolveWindow({ from: '2026-11-19', to: '2026-11-26' }, NOW)), 'no-error'); // exactly 7 days by date
    assert.equal(code(() => resolveWindow({ from: '2000-01-01', to: '2026-11-26' }, NOW)), 'window_too_large');
  });
  it('defaults: omitted to = now, omitted from = the provisional default window before it; bounds are validated', () => {
    const w = resolveWindow(undefined, NOW);
    assert.equal(w.to.getTime(), NOW.getTime()); assert.equal(w.to.getTime() - w.from.getTime(), PROVISIONAL_LIMITS.defaultWindowMs.value);
    assert.equal(resolveWindow({ to: '2026-11-25T00:00:00Z' }, NOW).from.toISOString(), '2026-11-24T00:00:00.000Z');
    assert.equal(code(() => resolveWindow({ from: '2026-11-20' }, NOW)), 'no-error'); // to defaults to now (6.5 days)
    assert.equal(code(() => resolveWindow({ from: '2026-11-26T12:00:00Z', to: '2026-11-26T12:00:00Z' }, NOW)), 'invalid_argument'); // empty
    assert.equal(code(() => resolveWindow({ from: '2026-11-26T13:00:00Z', to: '2026-11-26T12:00:00Z' }, NOW)), 'invalid_argument'); // reversed
    assert.equal(code(() => resolveWindow({ to: new Date(NOW.getTime() + FUTURE_SKEW_MS + 1).toISOString() }, NOW)), 'invalid_argument'); // too far in the future
    assert.equal(code(() => resolveWindow({ from: '2026-11-26T11:00:00Z', to: new Date(NOW.getTime() + FUTURE_SKEW_MS).toISOString() }, NOW)), 'no-error'); // within skew
    assert.ok(Object.isFrozen(w));
  });
  it('rejects ambiguous or malformed instants and never echoes them', () => {
    const marker = 'ZZ-ECHO-MARKER-ZZ';
    for (const bad of ['', 'yesterday', '2026-11-26T12:00:00', '2026-11-26 12:00:00Z', '2026-02-31', '2026-13-01', '2026-11-26T24:00:00Z', '2026-11-26T12:60:00Z', '2026-11-26T12:00:00+24:00', '2026-11-26T12:00:00+05:60',
      '26-11-26', '2026-11-26T12:00:00Zjunk', `2026-11-26${marker}`, '1e3', 'null', ' 2026-11-26', '2026-11-26 ', 'x'.repeat(100), '2026-11-26T12:00:00.1234Z']) {
      assert.equal(code(() => parseInstant(bad)), 'invalid_argument', bad.slice(0, 30));
    }
    for (const bad of [undefined, null, 5, true, {}, [], () => 1]) if (bad !== undefined) assert.equal(code(() => parseInstant(bad)), 'invalid_argument');
    assert.ok(!message(() => parseInstant(`2026-11-26${marker}`)).includes(marker));
    assert.equal(parseInstant('2026-11-26'), Date.UTC(2026, 10, 26)); assert.equal(parseInstant('2026-11-26T12:00Z'), Date.UTC(2026, 10, 26, 12));
    assert.equal(parseInstant('2026-11-26T12:00:00.5Z'), Date.UTC(2026, 10, 26, 12, 0, 0, 500));
  });
});

describe('provisional limits are justified by arithmetic recomputed here', () => {
  it('every non-fixed limit is marked provisional with a basis and the step that finalises it, and is frozen', () => {
    for (const [name, l] of Object.entries(PROVISIONAL_LIMITS)) { assert.equal(l.status, 'provisional', name); assert.ok(l.basis.length > 40, name); assert.match(l.finalizeAt, /^P3-|review/i, name); assert.ok(Object.isFrozen(l), name); }
    assert.ok(Object.isFrozen(PROVISIONAL_LIMITS) && Object.isFrozen(PAGE_SIZES));
  });
  it('the response budget is below Claude Code\'s documented 10,000-token warning at a pessimistic 3 bytes per token', () => {
    assert.ok(RESPONSE_BYTE_BUDGET / 3 < 10_000, `${RESPONSE_BYTE_BUDGET / 3} tokens`);
  });
  it('at each list\'s MAXIMUM page the ADVERSARIAL worst case fits the budget with no truncation (and the old single "50" would not)', () => {
    const worst = (make: () => unknown) => listBytes(make(), 1);
    void worst;
    assert.ok(listBytes(toDeveloperSummary(devRow(true)), PAGE_SIZES.developers.max) <= usable);
    assert.ok(listBytes(toSessionSummary(sessionRow(true), ctx()), PAGE_SIZES.sessions.max) <= usable);
    assert.ok(listBytes(toPromptMetadata(promptRow(true), ctx()), PAGE_SIZES.prompts.max) <= usable);
    assert.ok(listBytes(toPromptMetadata(promptRow(true), ctx()), BATCH_MAX) <= usable);
    assert.ok(listBytes(toDailyActivity(dayRow(true)), 8) <= usable); // a 7-day window is at most 8 calendar days
    assert.ok(jsonBytes(toSessionDetails(sessionRow(true), Array.from({ length: 100 }, (_, i) => ({ tool_name: L(64, String.fromCharCode(97 + (i % 26))), call_count: 99999999 })), ctx())) <= usable);
    // the reason the page size is per list: at 50, sessions and prompts exceed the budget even in the REALISTIC case
    assert.ok(listBytes(toSessionSummary(sessionRow(false), ctx()), 50) > usable);
    assert.ok(listBytes(toPromptMetadata(promptRow(false), ctx()), 50) > usable);
  });
  it('defaults never exceed maxima and are smaller than the page that would stress the budget', () => {
    for (const [k, v] of Object.entries(PAGE_SIZES)) { assert.ok(v.default >= 1 && v.default <= v.max, k); }
    assert.ok(PAGE_SIZES.sessions.max < PAGE_SIZES.developers.max && PAGE_SIZES.prompts.max < PAGE_SIZES.developers.max);
  });
  it('text mode (inactive): the original 20 x 2,000 cannot fit; the provisional 10 x 1,000 fits in ASCII; non-ASCII needs packWithinBudget', () => {
    const meta = jsonBytes(toPromptMetadata(promptRow(true), ctx()));
    assert.ok(20 * (meta + 2000) > usable, 'the originally proposed batch 20 x snippet 2,000 does not fit');
    assert.ok(TEXT_BATCH_MAX * (meta + SNIPPET_MAX_CHARS) <= usable, 'the provisional text batch fits (ASCII, worst-case metadata)');
    assert.ok(TEXT_BATCH_MAX * (meta + SNIPPET_MAX_CHARS * 4) > usable, 'but 4-byte characters would not, so packing is mandatory');
    assert.ok(TEXT_BATCH_MAX <= BATCH_MAX);
  });
  it('packWithinBudget keeps a prefix, flags truncation, never exceeds the budget, and handles the edges', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ i, pad: 'x'.repeat(100) }));
    const one = jsonBytes(items[0]);
    const budget = ENVELOPE_RESERVE_BYTES + 2 + one * 3 + 2; // room for exactly 3 items
    const p = packWithinBudget(items, budget);
    assert.deepEqual(p.items.map((x) => x.i), [0, 1, 2]); assert.equal(p.truncated, true);
    assert.ok(jsonBytes(p.items) <= budget - ENVELOPE_RESERVE_BYTES);
    assert.deepEqual(packWithinBudget(items.slice(0, 2), 1_000_000), { items: items.slice(0, 2), truncated: false });
    assert.deepEqual(packWithinBudget([], 5000), { items: [], truncated: false });
    assert.deepEqual(packWithinBudget(items, ENVELOPE_RESERVE_BYTES), { items: [], truncated: true }); // nothing fits
    const huge = Array.from({ length: 50 }, () => ({ t: '😀'.repeat(1000) }));
    const packed = packWithinBudget(huge); assert.ok(jsonBytes(packed.items) <= usable); assert.equal(packed.truncated, true);
  });
});

describe('prompt text cannot be enabled by the flag alone', () => {
  const approval: PromptTextApproval = { reference: 'PRIV-2027-001', approvedBy: 'Data Protection Officer', approvedOn: '2026-12-01', policyVersion: PROMPT_TEXT_POLICY_VERSION, maskingBestEffortAcknowledged: true };
  const later = new Date('2027-01-15T00:00:00Z');
  it('defaults to metadata with no configuration at all', () => {
    assert.deepEqual(resolvePromptAccess({}), { mode: 'metadata' });
    assert.deepEqual(resolvePromptAccess({ MCP_PROMPT_TEXT_ENABLED: undefined }), { mode: 'metadata' });
  });
  it('TRIPWIRE: no approval is recorded in the repository (null). Setting it requires written privacy/legal approval and an MCP.md update (section 16)', () => {
    assert.equal(RECORDED_PROMPT_TEXT_APPROVAL, null, 'RECORDED_PROMPT_TEXT_APPROVAL must stay null until privacy/legal approval exists; see MCP.md section 16, decision 4');
  });
  it('the flag set to "true" is NOT enough: with the recorded approval absent the real mode stays metadata', () => {
    assert.deepEqual(resolvePromptAccess({ MCP_PROMPT_TEXT_ENABLED: 'true' }), { mode: 'metadata' });
    const saved = process.env.MCP_PROMPT_TEXT_ENABLED; process.env.MCP_PROMPT_TEXT_ENABLED = 'true';
    try { assert.deepEqual(resolvePromptAccess(process.env), { mode: 'metadata' }); } finally { if (saved === undefined) delete process.env.MCP_PROMPT_TEXT_ENABLED; else process.env.MCP_PROMPT_TEXT_ENABLED = saved; }
  });
  it('an approval WITHOUT the flag is not enough either; only both together open text', () => {
    assert.deepEqual(resolvePromptAccess({}, approval, later), { mode: 'metadata' });
    assert.deepEqual(resolvePromptAccess({ MCP_PROMPT_TEXT_ENABLED: 'false' }, approval, later), { mode: 'metadata' });
    const both = resolvePromptAccess({ MCP_PROMPT_TEXT_ENABLED: 'true' }, approval, later);
    assert.equal(both.mode, 'text'); assert.ok(Object.isFrozen(both));
  });
  it('only the exact string "true" counts as the flag', () => {
    for (const v of ['TRUE', 'True', '1', 'yes', 'on', ' true', 'true ', 'truee', 'enabled', '', 'false', '0', 'null']) assert.equal(resolvePromptAccess({ MCP_PROMPT_TEXT_ENABLED: v }, approval, later).mode, 'metadata', JSON.stringify(v));
  });
  it('every defect in an approval record keeps the mode at metadata', () => {
    const on = { MCP_PROMPT_TEXT_ENABLED: 'true' };
    const bad: Array<[string, unknown]> = [
      ['missing reference', { ...approval, reference: '' }], ['short reference', { ...approval, reference: 'x' }], ['missing approver', { ...approval, approvedBy: ' ' }],
      ['future date', { ...approval, approvedOn: '2027-12-31' }], ['malformed date', { ...approval, approvedOn: '2026-13-40' }], ['non-ISO date', { ...approval, approvedOn: '01/12/2026' }],
      ['old policy version', { ...approval, policyVersion: 0 }], ['newer policy version', { ...approval, policyVersion: 2 }], ['acknowledgement false', { ...approval, maskingBestEffortAcknowledged: false }],
      ['acknowledgement missing', { reference: approval.reference, approvedBy: approval.approvedBy, approvedOn: approval.approvedOn, policyVersion: approval.policyVersion }],
      ['a string', 'approved'], ['a number', 1], ['an array', [approval]], ['true', true],
    ];
    for (const [name, a] of bad) { assert.equal(isValidApproval(a, later), false, name); assert.equal(resolvePromptAccess(on, a as PromptTextApproval, later).mode, 'metadata', name); }
    assert.equal(isValidApproval(approval, later), true);
  });
  it('the approval cannot come from the environment, and the flag name is read in exactly one place', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'lib/mcp/data/prompt-access.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.deepEqual([...new Set([...src.matchAll(/\benv\.(\w+)/g)].map((m) => m[1]))], ['MCP_PROMPT_TEXT_ENABLED']);
    assert.doesNotMatch(src, /process\.env|JSON\.parse|Buffer\.from|readFile/);
    const readers: string[] = [];
    const walk = (d: string): string[] => fs.readdirSync(path.join(process.cwd(), d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : /\.(ts|tsx)$/.test(e.name) ? [`${d}/${e.name}`] : []));
    for (const f of [...walk('lib'), ...walk('app')]) if (fs.readFileSync(path.join(process.cwd(), f), 'utf8').includes('MCP_PROMPT_TEXT_ENABLED')) readers.push(f);
    assert.deepEqual(readers, ['lib/mcp/data/prompt-access.ts']);
  });
  it('no text-bearing type exists in P3-1: the only prompt contract is metadata', () => {
    for (const f of fs.readdirSync(path.join(process.cwd(), 'lib/mcp/data'))) assert.doesNotMatch(fs.readFileSync(path.join(process.cwd(), 'lib/mcp/data', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1'), /interface \w*(Text|Snippet|Excerpt)\b|promptText\s*[:?]|\bsnippet\s*[:?]|\bexcerpt\s*[:?]/, f);
  });
});

describe('metadata-only: no prompt text, directly or indirectly', () => {
  const CANARY = 'CANARY-PROMPT-SECRET-sk-live-0123456789';
  const poisoned = <T extends object>(row: T): T & Record<string, unknown> => ({
    ...row, prompt_text_sanitized: CANARY, text: CANARY, content: CANARY, prompt: CANARY, promptText: CANARY, snippet: CANARY, excerpt: CANARY, preview: CANARY, body: CANARY, message: CANARY,
    label: CANARY, events: [{ kind: 'user', text: CANARY }], path: `/Users/x/${CANARY}/secret.ts`, file_path: CANARY, files: [{ path: CANARY }], agent: CANARY, project: CANARY, payload_hash: CANARY,
  });
  it('projections are allowlists: text columns, labels, paths, events, agent/project and hashes never reach the output', () => {
    const outputs = [toPromptMetadata(poisoned(promptRow()), ctx()), toSessionSummary(poisoned(sessionRow()), ctx()), toSessionDetails(poisoned(sessionRow()), [{ tool_name: 'Read', call_count: 3, path: CANARY }], ctx()),
      toDeveloperSummary(poisoned(devRow())), toDailyActivity(poisoned(dayRow()))];
    for (const o of outputs) { assert.ok(!JSON.stringify(o).includes('CANARY'), 'a canary reached an output'); assertMetadataOnly(o); for (const k of Object.keys(o)) assert.ok(OUTPUT_KEYS.has(k), k); }
  });
  it('the metadata contract has exactly the approved fields and none that can hold text (compile-time and run-time)', () => {
    const m = toPromptMetadata(promptRow(), ctx());
    assert.deepEqual(Object.keys(m).sort(), ['answerCacheReadTokens', 'answerCacheWriteTokens', 'answerTokensIn', 'answerTokensOut', 'charLength', 'createdAt', 'developerId', 'hasCodeBlock', 'hasFilePath', 'hasTraceback', 'intent', 'model', 'promptRef', 'sessionRef', 'tool', 'turnIndex']);
    const typed: PromptMetadata = m; const s: SessionSummary = toSessionSummary(sessionRow(), ctx()); const d: SessionDetails = toSessionDetails(sessionRow(), [], ctx());
    // @ts-expect-error PromptMetadata has no text field
    void typed.text; // @ts-expect-error nor a snippet
    void typed.snippet; // @ts-expect-error nor an excerpt
    void typed.excerpt; // @ts-expect-error nor a label
    void typed.label; // @ts-expect-error nor a path
    void typed.path; // @ts-expect-error sessions have no label
    void s.label; // @ts-expect-error sessions have no files
    void d.files; // @ts-expect-error nor a path
    void d.path;
    assert.equal(typeof m.hasFilePath, 'boolean'); // the flag is a boolean, never a path
  });
  it('OUTPUT_KEYS holds no text-capable name; the only key mentioning "path" is the boolean flag hasFilePath', () => {
    const banned = new Set(['text', 'snippet', 'excerpt', 'preview', 'content', 'body', 'message', 'label', 'event', 'events', 'path', 'paths', 'query', 'prompt', 'agent', 'project', 'payload', 'hash', 'file', 'files']);
    const words = (k: string) => k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(' ');
    const hits = [...OUTPUT_KEYS].filter((k) => words(k).some((w) => banned.has(w)));
    assert.deepEqual(hits.sort(), ['filesTouched', 'hasFilePath', 'promptRef'].filter((k) => hits.includes(k)).sort(), `unexpected text-capable output keys: ${hits.join(', ')}`);
    assert.ok(hits.includes('hasFilePath') && !hits.includes('events') && !hits.includes('label'));
  });
  it('intent is a CLOSED enum: free text in the category column is refused, so it cannot smuggle content', () => {
    for (const ok of INTENT_CATEGORIES) assert.equal(toPromptMetadata({ ...promptRow(), intent_category: ok }, ctx()).intent, ok);
    for (const bad of ['fix the login bug please', 'Bug_Fix', 'bug_fix ', '', null, 5, CANARY]) assert.equal(code(() => toPromptMetadata({ ...promptRow(), intent_category: bad }, ctx())), 'internal');
    assert.deepEqual([...INTENT_CATEGORIES], ['bug_fix', 'feature', 'refactor', 'explain', 'test', 'other']);
  });
  it('client-controlled strings (tool, model) cannot carry sentences: charset and length restricted', () => {
    for (const bad of ['two words', 'line\nbreak', 'a'.repeat(65), 'quote"', 'sk-live 0123', '', '<script>', 'tab\there']) {
      assert.equal(code(() => toPromptMetadata({ ...promptRow(), tool: bad }, ctx())), 'internal', JSON.stringify(bad));
      assert.equal(code(() => toPromptMetadata({ ...promptRow(), model: bad }, ctx())), 'internal', JSON.stringify(bad));
    }
    assert.equal(toPromptMetadata({ ...promptRow(), model: null }, ctx()).model, null);
  });
  it('a display name (the one free-text field) is cleaned and capped; numbers must be sane; bad rows fail closed', () => {
    assert.equal(cleanDisplayName('  Ana\u0007\n  María   López '), 'Ana María López'); assert.equal(cleanDisplayName('x'.repeat(500)).length, STRING_LIMITS.displayName);
    assert.equal(code(() => cleanDisplayName('\u0007\n ')), 'internal'); assert.equal(code(() => cleanDisplayName(5)), 'internal');
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, '12abc', '-3', null, undefined, {}]) assert.equal(code(() => toDailyActivity({ ...dayRow(), tokens_in: bad })), 'internal', String(bad));
    assert.equal(toDailyActivity({ ...dayRow(), tokens_in: '123456789012' }).tokensIn, 123456789012); // bigint columns arrive as strings
    for (const bad of [null, 'row', 5, [], undefined]) assert.equal(code(() => toSessionSummary(bad, ctx())), 'internal');
    assert.equal(code(() => toSessionDetails(sessionRow(), 'nope', ctx())), 'internal');
    assert.equal(code(() => toDeveloperSummary({ ...devRow(), role: 'superadmin' })), 'internal');
  });
  it('assertMetadataOnly rejects any key that is not an output key — however innocent the name — and oversized or unsafe values', () => {
    assertMetadataOnly(toPromptMetadata(promptRow(), ctx())); assertMetadataOnly({ items: [toSessionSummary(sessionRow(), ctx())], nextCursor: null, truncated: false });
    for (const key of ['text', 'snippet', 'preview', 'label', 'path', 'events', 'content', 'summary', 'note', 'description', 'title', 'x']) {
      assert.equal(code(() => assertMetadataOnly({ items: [{ [key]: 'a' }] })), 'internal', key);
      assert.equal(code(() => assertMetadataOnly({ [key]: 'a' })), 'internal', key);
    }
    assert.equal(code(() => assertMetadataOnly({ tool: 'x'.repeat(201) })), 'internal'); assert.equal(code(() => assertMetadataOnly({ tool: 'a\nb' })), 'internal');
    assert.equal(code(() => assertMetadataOnly({ tokensIn: Number.NaN })), 'internal'); assert.equal(code(() => assertMetadataOnly({ tool: undefined })), 'internal');
    assert.equal(code(() => assertMetadataOnly({ tool: BigInt(1) })), 'internal'); assert.equal(code(() => assertMetadataOnly({ tool: () => 1 })), 'internal');
    let deep: unknown = { items: [] }; for (let i = 0; i < 8; i++) deep = { items: [deep] };
    assert.equal(code(() => assertMetadataOnly(deep)), 'internal');
  });
  it('NO SEARCH ORACLE: the prompt search request has no text field, and every text-like key is refused with the same generic error as any unknown key', () => {
    const textKeys = ['query', 'text', 'q', 'search', 'contains', 'keyword', 'keywords', 'prompt', 'promptText', 'match', 'regex', 'like', 'fulltext', 'term', 'terms', 'pattern', 'filter', 'content', 'snippet', 'ilike', 'where', 'sort', 'orderBy'];
    const baseline = message(() => parsePromptMetadataSearchRequest({ zzzUnknownField: 'x' }, NOW));
    for (const k of textKeys) {
      assert.equal(code(() => parsePromptMetadataSearchRequest({ [k]: 'needle' }, NOW)), 'invalid_argument', k);
      assert.equal(message(() => parsePromptMetadataSearchRequest({ [k]: 'needle' }, NOW)), baseline, `${k}: the error must not reveal that this key is special`);
      assert.ok(!(PROMPT_SEARCH_KEYS as readonly string[]).includes(k), k);
    }
    assert.ok(!baseline.includes('needle') && !baseline.includes('zzzUnknownField'));
    for (const k of PROMPT_SEARCH_KEYS) assert.doesNotMatch(k, /text|query|search|contain|keyword|snippet|prompt$/i, k);
    // the only strings a filter accepts are closed-enum intents and short identifiers (tool, model): neither can hold a search term
    assert.equal(code(() => parsePromptMetadataSearchRequest({ tool: 'needle in haystack' }, NOW)), 'invalid_argument');
    assert.equal(code(() => parsePromptMetadataSearchRequest({ intents: ['needle'] }, NOW)), 'invalid_argument');
    assert.equal(code(() => parsePromptMetadataSearchRequest({ minChars: 'needle' }, NOW)), 'invalid_argument');
  });
});

describe('strict request parsing', () => {
  const MARK = 'ZZ-ECHO-MARKER-ZZ';
  it('unknown keys are rejected on every request type; names and values are never echoed; prototype keys are unknown keys', () => {
    const parsers: Array<[string, (i: unknown) => unknown]> = [['developers', parseListDevelopersRequest], ['activity', (i) => parseDeveloperActivityRequest(i, NOW)], ['sessions', (i) => parseListSessionsRequest(i, NOW)],
      ['details', parseSessionDetailsRequest], ['search', (i) => parsePromptMetadataSearchRequest(i, NOW)], ['batch', parsePromptBatchRequest]];
    for (const [name, parse] of parsers) {
      assert.equal(code(() => parse({ [MARK]: 1 })), 'invalid_argument', name); assert.ok(!message(() => parse({ [MARK]: MARK })).includes(MARK), name);
      assert.equal(code(() => parse(JSON.parse('{"__proto__":{"polluted":true}}'))), 'invalid_argument', name);
      assert.equal(code(() => parse(JSON.parse('{"constructor":{"x":1}}'))), 'invalid_argument', name);
      for (const notObject of ['string', 5, true, [1], () => 1]) assert.equal(code(() => parse(notObject)), 'invalid_argument', `${name} ${String(notObject)}`);
    }
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });
  it('page sizes: defaults per list, the maximum is enforced per list, invalid values are refused', () => {
    assert.equal(parseListDevelopersRequest({}).limit, PAGE_SIZES.developers.default); assert.equal(parseListSessionsRequest({}, NOW).limit, PAGE_SIZES.sessions.default); assert.equal(parsePromptMetadataSearchRequest({}, NOW).limit, PAGE_SIZES.prompts.default);
    assert.equal(parseListDevelopersRequest({ limit: PAGE_SIZES.developers.max }).limit, 50); assert.equal(code(() => parseListDevelopersRequest({ limit: 51 })), 'limit_exceeded');
    assert.equal(parseListSessionsRequest({ limit: 25 }, NOW).limit, 25); assert.equal(code(() => parseListSessionsRequest({ limit: 26 }, NOW)), 'limit_exceeded');
    assert.equal(code(() => parsePromptMetadataSearchRequest({ limit: 26 }, NOW)), 'limit_exceeded');
    for (const bad of [0, -1, 1.5, Number.NaN, '10', null, true, [], {}]) { if (bad === null) continue; assert.equal(code(() => parseListSessionsRequest({ limit: bad }, NOW)), 'invalid_argument', String(bad)); }
  });
  it('windows: the 7-day maximum applies to every request that takes a window', () => {
    for (const parse of [(i: unknown) => parseDeveloperActivityRequest({ developerId: uuid(), ...(i as object) }, NOW), (i: unknown) => parseListSessionsRequest(i, NOW), (i: unknown) => parsePromptMetadataSearchRequest(i, NOW)]) {
      assert.equal(code(() => parse({ from: '2026-11-01', to: '2026-11-20' })), 'window_too_large');
      assert.equal(code(() => parse({ from: '2026-11-20', to: '2026-11-26' })), 'no-error');
    }
  });
  it('identifiers: developerId must be a UUID, tool/model short identifiers, session and prompt references bounded', () => {
    assert.equal(code(() => parseDeveloperActivityRequest({ developerId: 'not-a-uuid' }, NOW)), 'invalid_argument'); assert.equal(code(() => parseDeveloperActivityRequest({}, NOW)), 'invalid_argument');
    assert.equal(parseListSessionsRequest({ developerId: USER.toUpperCase() }, NOW).developerId, USER);
    assert.equal(code(() => parseListSessionsRequest({ tool: 'a b' }, NOW)), 'invalid_argument'); assert.equal(code(() => parseListSessionsRequest({ model: 'x'.repeat(65) }, NOW)), 'invalid_argument');
    assert.equal(code(() => parseSessionDetailsRequest({})), 'invalid_argument'); assert.equal(code(() => parseSessionDetailsRequest({ sessionRef: '' })), 'invalid_argument'); assert.equal(code(() => parseSessionDetailsRequest({ sessionRef: 'x'.repeat(300) })), 'invalid_argument');
    assert.equal(code(() => parseListDevelopersRequest({ cursor: 'has spaces!' })), 'cursor_invalid'); assert.equal(code(() => parseListDevelopersRequest({ cursor: 'a'.repeat(513) })), 'cursor_invalid');
  });
  it('batch: 1..20 references, duplicates collapsed in order, anything else refused', () => {
    assert.deepEqual(parsePromptBatchRequest({ promptRefs: ['a', 'b', 'a'] }).promptRefs, ['a', 'b']);
    assert.equal(parsePromptBatchRequest({ promptRefs: Array.from({ length: BATCH_MAX }, (_, i) => `r${i}`) }).promptRefs.length, BATCH_MAX);
    assert.equal(code(() => parsePromptBatchRequest({ promptRefs: Array.from({ length: BATCH_MAX + 1 }, (_, i) => `r${i}`) })), 'limit_exceeded');
    for (const bad of [[], 'a', [1], [''], ['x'.repeat(300)], null, undefined]) assert.equal(code(() => parsePromptBatchRequest({ promptRefs: bad })), 'invalid_argument');
  });
  it('search filters: enum intents (deduplicated, sorted), booleans, ordered numeric ranges', () => {
    const r = parsePromptMetadataSearchRequest({ intents: ['test', 'bug_fix', 'test'], hasCodeBlock: true, hasTraceback: false, minChars: 10, maxChars: 500, tool: 'claude-code' }, NOW);
    assert.deepEqual(r.filters.intents, ['bug_fix', 'test']); assert.equal(r.filters.hasCodeBlock, true); assert.equal(r.filters.hasFilePath, null);
    assert.equal(code(() => parsePromptMetadataSearchRequest({ minChars: 500, maxChars: 10 }, NOW)), 'invalid_argument'); assert.equal(code(() => parsePromptMetadataSearchRequest({ maxChars: 2_000_000 }, NOW)), 'invalid_argument');
    assert.equal(code(() => parsePromptMetadataSearchRequest({ hasCodeBlock: 'yes' }, NOW)), 'invalid_argument'); assert.equal(code(() => parsePromptMetadataSearchRequest({ intents: 'bug_fix' }, NOW)), 'invalid_argument');
    assert.equal(code(() => parsePromptMetadataSearchRequest({ intents: [...INTENT_CATEGORIES, 'other'] }, NOW)), 'invalid_argument');
  });
});

describe('scope: the identity a data call runs under', () => {
  it('can only be created by createDataScope; a look-alike object is rejected at runtime and refused by the compiler', () => {
    const forged = { userId: USER, teamId: TEAM };
    assert.equal(code(() => assertScope(forged)), 'internal'); assert.equal(code(() => assertScope(null)), 'internal'); assert.equal(code(() => assertScope('scope')), 'internal');
    // @ts-expect-error a scope cannot be built from a plain object literal
    const asScope: DataScope = forged; void asScope;
    assert.doesNotThrow(() => assertScope(mkScope()));
    assert.equal(code(() => scopeDbArgs(forged as unknown as DataScope)), 'internal');
  });
  it('validates its inputs: a 32-byte hash and UUID ids', () => {
    for (const hash of [crypto.randomBytes(31), crypto.randomBytes(33), new Uint8Array(0), 'x' as unknown as Uint8Array]) assert.equal(code(() => createDataScope({ tokenHash: hash, userId: USER, teamId: TEAM })), 'internal');
    for (const bad of ['', 'nope', `${USER}x`]) { assert.equal(code(() => mkScope({ userId: bad })), 'internal'); assert.equal(code(() => mkScope({ teamId: bad })), 'internal'); }
  });
  it('the token hash is the only authority handed to the database, as an independent copy; the scope itself shows ids only', () => {
    const hash = crypto.randomBytes(32); const keep = Buffer.from(hash);
    const scope = createDataScope({ tokenHash: hash, userId: USER, teamId: TEAM });
    hash.fill(0); assert.ok(scopeDbArgs(scope).tokenHash.equals(keep), 'later changes to the source buffer must not alter the scope');
    const a = scopeDbArgs(scope).tokenHash; a.fill(0); assert.ok(scopeDbArgs(scope).tokenHash.equals(keep), 'the returned buffer is a copy');
    assert.deepEqual(Object.keys(scope).sort(), ['teamId', 'userId']); assert.ok(Object.isFrozen(scope));
    const shown = JSON.stringify(scope) + String(Object.values(scope)) + inspect(scope);
    assert.ok(!shown.includes(keep.toString('hex')) && !shown.includes(keep.toString('base64')) && !shown.includes(keep.toString('base64url')));
    assert.deepEqual(Object.keys(scopeDbArgs(scope)), ['tokenHash']); // no team id is ever an argument: the database derives the team
  });
});

describe('opaque references and cursors', () => {
  it('references round-trip, hide the id, and are randomised', () => {
    const c = ctx(); const id = '48213';
    const ref = encodeRef('prompt', id, c); assert.equal(decodeRef('prompt', ref, c), id);
    assert.notEqual(encodeRef('prompt', id, c), ref, 'sealed with a fresh random IV each time');
    assert.ok(!ref.includes(id) && !Buffer.from(ref, 'base64url').toString('latin1').includes(id), 'the id must not be readable in the reference');
    const s = uuid(); assert.equal(decodeRef('session', encodeRef('session', s, c), c), s);
    assert.ok(ref.length <= STRING_LIMITS.ref);
  });
  it('a reference is bound to its team and kind, and every failure is the SAME not_found as a missing row', () => {
    const c = ctx(); const ref = encodeRef('prompt', '48213', c);
    const otherTeam = ctx(mkScope({ teamId: OTHER_TEAM })); const sameTeamOtherUser = ctx(mkScope({ userId: OTHER_USER }));
    assert.equal(decodeRef('prompt', ref, sameTeamOtherUser), '48213'); // within one team a reference is shareable between its admins
    const failures: Array<() => unknown> = [() => decodeRef('prompt', ref, otherTeam), () => decodeRef('session', ref, c), () => decodeRef('prompt', '', c), () => decodeRef('prompt', 'x'.repeat(300), c),
      () => decodeRef('prompt', 'not a ref', c), () => decodeRef('prompt', undefined, c), () => decodeRef('prompt', 5, c), () => decodeRef('prompt', ref.slice(0, -1), c), () => decodeRef('prompt', `${ref}A`, c),
      () => decodeRef('prompt', ref, { scope: c.scope, secret: 'a-different-secret-0123456789' })];
    const messages = new Set<string>();
    for (const f of failures) { assert.equal(code(f), 'not_found'); messages.add(message(f)); }
    assert.equal(messages.size, 1, 'every failure has the identical message');
    assert.equal(message(() => decodeRef('prompt', ref, otherTeam)), DATA_ERROR_MESSAGES.not_found);
  });
  it('tampering with ANY character of a reference or cursor is detected', () => {
    const c = ctx(); const ref = encodeRef('session', uuid(), c);
    const cur = encodeCursor('sessions', { t: '2026-11-24T09:11:37.717Z', i: uuid() }, { tool: null }, c, NOW);
    for (let i = 0; i < ref.length - 1; i++) { const t = ref.slice(0, i) + (ref[i] === 'A' ? 'B' : 'A') + ref.slice(i + 1); assert.equal(code(() => decodeRef('session', t, c)), 'not_found', `ref char ${i}`); }
    for (let i = 0; i < cur.length - 1; i++) { const t = cur.slice(0, i) + (cur[i] === 'A' ? 'B' : 'A') + cur.slice(i + 1); assert.equal(code(() => decodeCursor('sessions', t, { tool: null }, c, NOW)), 'cursor_invalid', `cursor char ${i}`); }
  });
  it('encoding refuses malformed ids (our bug, never the caller\'s) and a missing or short secret', () => {
    const c = ctx();
    for (const bad of ['', 'abc', '12345678901234567890', '-1', '1; DROP']) assert.equal(code(() => encodeRef('prompt', bad, c)), 'internal');
    assert.equal(code(() => encodeRef('session', '48213', c)), 'internal');
    assert.throws(() => sealJson({ a: 1 }, 'p', 'aad', 'short'));
    assert.equal(code(() => encodeRef('prompt', '1', { scope: {} as DataScope, secret: SECRET })), 'internal');
  });
  it('cursors round-trip and are bound to kind, team, user, query filters and a short lifetime', () => {
    const c = ctx(); const filters = { tool: 'claude-code', intents: ['bug_fix'], developerId: null }; const pos = { t: '2026-11-24T09:11:37.717Z', i: '48213' };
    const cur = encodeCursor('prompts', pos, filters, c, NOW);
    assert.deepEqual(decodeCursor('prompts', cur, filters, c, NOW), pos);
    assert.deepEqual(decodeCursor('prompts', cur, { developerId: null, intents: ['bug_fix'], tool: 'claude-code' }, c, NOW), pos, 'key order of the filters does not matter');
    const bad: Array<[string, () => unknown]> = [
      ['different filters', () => decodeCursor('prompts', cur, { ...filters, tool: 'other' }, c, NOW)], ['intents order matters', () => decodeCursor('prompts', cur, { ...filters, intents: ['test'] }, c, NOW)],
      ['other kind', () => decodeCursor('sessions', cur, filters, c, NOW)], ['other team', () => decodeCursor('prompts', cur, filters, ctx(mkScope({ teamId: OTHER_TEAM })), NOW)],
      ['other user', () => decodeCursor('prompts', cur, filters, ctx(mkScope({ userId: OTHER_USER })), NOW)], ['other secret', () => decodeCursor('prompts', cur, filters, { scope: c.scope, secret: 'another-secret-0123456789xx' }, NOW)],
      ['expired', () => decodeCursor('prompts', cur, filters, c, new Date(NOW.getTime() + PROVISIONAL_LIMITS.cursorTtlMs.value + 1))],
      ['not a string', () => decodeCursor('prompts', 5, filters, c, NOW)], ['empty', () => decodeCursor('prompts', '', filters, c, NOW)], ['oversize', () => decodeCursor('prompts', 'a'.repeat(513), filters, c, NOW)],
    ];
    for (const [name, f] of bad) assert.equal(code(f), 'cursor_invalid', name);
    assert.doesNotThrow(() => decodeCursor('prompts', cur, filters, c, new Date(NOW.getTime() + PROVISIONAL_LIMITS.cursorTtlMs.value))); // still valid at the boundary
    assert.equal(code(() => encodeCursor('prompts', { t: 'not-a-time', i: '1' }, filters, c, NOW)), 'internal'); assert.equal(code(() => encodeCursor('prompts', { t: '', i: 'has space' }, filters, c, NOW)), 'internal');
    assert.ok(cur.length <= STRING_LIMITS.cursor);
  });
  it('FUZZ: arbitrary strings never make decodeRef or decodeCursor throw anything but their one uniform error', () => {
    const c = ctx(); const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_=+/. \n"\'{}[]\\';
    const rnd = (n: number) => Array.from({ length: n }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
    for (let i = 0; i < 2000; i++) {
      const s = rnd(crypto.randomInt(0, 300));
      assert.equal(code(() => decodeRef('prompt', s, c)), 'not_found'); assert.equal(code(() => decodeCursor('sessions', s, {}, c, NOW)), 'cursor_invalid');
    }
    for (const weird of [undefined, null, 0, NaN, {}, [], () => 1, Symbol('x') as unknown, Object(1) as unknown]) { assert.equal(code(() => decodeRef('prompt', weird, c)), 'not_found'); assert.equal(code(() => decodeCursor('prompts', weird, {}, c, NOW)), 'cursor_invalid'); }
    assert.equal(openJson('', 'p', 'a', SECRET), null); assert.equal(openJson('****', 'p', 'a', SECRET), null);
  });
  it('fingerprintFilters is stable and sensitive to values', () => {
    assert.equal(fingerprintFilters({ a: 1, b: [1, 2] }), fingerprintFilters({ b: [1, 2], a: 1 })); assert.notEqual(fingerprintFilters({ a: 1 }), fingerprintFilters({ a: 2 })); assert.notEqual(fingerprintFilters({ a: [1, 2] }), fingerprintFilters({ a: [2, 1] }));
    assert.equal(fingerprintFilters({ a: null }).length, 32);
  });
});

describe('error taxonomy', () => {
  it('every code has one fixed message; there is no way to attach detail', () => {
    assert.deepEqual(Object.keys(DATA_ERROR_MESSAGES).sort(), ['cursor_invalid', 'internal', 'invalid_argument', 'limit_exceeded', 'not_found', 'text_not_available', 'unavailable', 'window_too_large']);
    for (const [c, m] of Object.entries(DATA_ERROR_MESSAGES)) { assert.equal(new DataError(c as DataErrorCode).message, m); assert.ok(m.length > 3 && !/[\n\r]/.test(m)); }
    assert.equal(DataError.length, 1, 'the constructor takes the code only');
    assert.ok(Object.isFrozen(DATA_ERROR_MESSAGES));
  });
  it('toDataError turns anything else into a generic `internal` error and carries nothing over (no message, stack or driver text)', () => {
    const leaky = Object.assign(new Error('connection to 10.1.2.3:5432 failed: password=hunter2'), { code: '08006' });
    for (const e of [leaky, 'a string', undefined, null, { message: 'secret' }, 42]) { const d = toDataError(e); assert.equal(d.code, 'internal'); assert.equal(d.message, DATA_ERROR_MESSAGES.internal); assert.ok(!JSON.stringify(d).includes('hunter2')); assert.ok(!String(d.stack).includes('hunter2')); }
    const own = new DataError('cursor_invalid'); assert.equal(toDataError(own), own);
  });
  it('client errors are separated from service errors', () => {
    for (const c of ['invalid_argument', 'window_too_large', 'limit_exceeded', 'cursor_invalid', 'not_found', 'text_not_available'] as const) assert.ok(CLIENT_ERROR_CODES.has(c), c);
    for (const c of ['unavailable', 'internal'] as const) assert.ok(!CLIENT_ERROR_CODES.has(c), c);
  });
});

describe('excluded-column policy', () => {
  it('never-exposed columns are denied in every mode: paths, events, labels, payload hash, agent/project name, secrets', () => {
    for (const [t, cols] of Object.entries(MCP_NEVER_EXPOSED_COLUMNS)) for (const c of cols) { assert.equal(isMcpColumnAllowed(t, c), false, `${t}.${c}`); assert.equal(isMcpColumnAllowed(t, c, { promptText: true }), false, `${t}.${c} even with text enabled`); }
    for (const [t, c] of [['sync_sessions', 'events'], ['sync_sessions', 'label'], ['sync_sessions', 'agent'], ['sync_sessions', 'payload_hash'], ['sync_session_files', 'path'], ['daily_member_files', 'path'], ['daily_member_usage', 'project']] as const) assert.equal(isMcpColumnAllowed(t, c), false, `${t}.${c}`);
    for (const c of ['path', 'paths', 'file_path', 'filepath', 'file_name', 'filename', 'config_path', 'Path', 'FILE_PATH']) assert.equal(isMcpColumnAllowed('any_table', c), false, c);
    for (const c of ['password_hash', 'api_key', 'key_hash', 'token_hash', 'secret_enc', 'totp_secret', 'passwd']) assert.equal(isMcpColumnAllowed('users', c), false, c);
  });
  it('the text column is gated: denied in metadata mode, allowed ONLY when text is explicitly passed as enabled', () => {
    assert.deepEqual(MCP_TEXT_GATED_COLUMNS, { session_turns: ['prompt_text_sanitized'] });
    assert.equal(isMcpColumnAllowed('session_turns', 'prompt_text_sanitized'), false); assert.equal(isMcpColumnAllowed('session_turns', 'prompt_text_sanitized', { promptText: false }), false);
    assert.equal(isMcpColumnAllowed('SESSION_TURNS', 'PROMPT_TEXT_SANITIZED', { promptText: true }), true);
  });
  it('excluded tables stay excluded and ordinary metadata columns are allowed', () => {
    for (const t of MCP_EXCLUDED_TABLES) assert.equal(isMcpColumnAllowed(t, 'id', { promptText: true }), false, t);
    for (const [t, c] of [['session_turns', 'prompt_char_len'], ['session_turns', 'intent_category'], ['session_turns', 'has_file_path'], ['sync_sessions', 'tokens_in'], ['daily_member_usage', 'api_cost'], ['members', 'display_name']] as const) assert.equal(isMcpColumnAllowed(t, c), true, `${t}.${c}`);
  });
  it('no raw column the projections read is on a forbidden list (the contracts and the policy agree)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'lib/mcp/data/output.ts'), 'utf8');
    const read = new Set([...src.matchAll(/\br\.([a-z_]+)\b/g), ...src.matchAll(/\bx\.([a-z_]+)\b/g)].map((m) => m[1]));
    assert.ok(read.size > 25, `found ${read.size} raw columns`);
    for (const c of read) for (const t of ['sync_sessions', 'session_turns', 'daily_member_usage', 'members']) { if (c === 'prompt_text_sanitized') continue; assert.ok(!(MCP_NEVER_EXPOSED_COLUMNS[t] ?? []).includes(c), `${t}.${c}`); }
    for (const forbidden of ['events', 'label', 'agent', 'project', 'payload_hash', 'path', 'prompt_text_sanitized', 'text']) assert.ok(!read.has(forbidden), `the projections must never read ${forbidden}`);
  });
});

describe('the contracts are free of I/O and stay inside the guard rails', () => {
  const dir = path.join(process.cwd(), 'lib/mcp/data');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
  const code_ = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  it('has exactly the P3-1 modules', () => {
    assert.deepEqual(files.sort(), ['cursor.ts', 'errors.ts', 'limits.ts', 'output.ts', 'prompt-access.ts', 'refs.ts', 'requests.ts', 'scope.ts', 'sealed.ts', 'time-window.ts']);
  });
  it('imports only node:crypto and its own modules: no database driver, no application code, no network, no filesystem', () => {
    for (const f of files) for (const m of code_(f).matchAll(/from\s+['"]([^'"]+)['"]/g)) assert.ok(m[1] === 'node:crypto' || m[1].startsWith('./'), `${f} imports ${m[1]}`);
  });
  it('has no environment access (the one flag is passed in by the caller), no logging, no timers, no randomness other than crypto, no dynamic code', () => {
    for (const f of files) {
      const c = code_(f);
      assert.doesNotMatch(c, /process\.env|process\.|console\.|setTimeout|setInterval|Math\.random|\beval\(|new Function|require\(|fetch\(|XMLHttpRequest|readFileSync|writeFileSync|child_process/, f);
    }
  });
  it('names no table that the MCP-folder guard forbids, no SQL, and no environment variable other than the one flag', () => {
    for (const f of files) {
      const c = code_(f);
      assert.doesNotMatch(c, /\b(session_turns|sync_sessions?|sync_session_\w+|prompt_embeddings|redundant_reprompt_events|session_outcomes\w*|team_members|audit_log|auth_totp|auth_throttle|user_sessions)\b/i, f);
      assert.doesNotMatch(c, /\b(SELECT|INSERT|UPDATE|DELETE)\b[^;]{0,60}\b(FROM|INTO|SET)\b/, f);
    }
    assert.deepEqual([...new Set(files.flatMap((f) => [...code_(f).matchAll(/\benv\.([A-Z_]+)/g)].map((m) => m[1])))], ['MCP_PROMPT_TEXT_ENABLED']);
  });
  it('nothing in the application imports the data contracts yet (no tool, route or handler uses them in P3-1)', () => {
    const walk = (d: string): string[] => fs.readdirSync(path.join(process.cwd(), d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : /\.(ts|tsx)$/.test(e.name) ? [`${d}/${e.name}`] : []));
    const users = [...walk('app'), ...walk('lib')].filter((f) => !f.startsWith('lib/mcp/data/') && /from\s+['"][^'"]*mcp\/data\//.test(fs.readFileSync(path.join(process.cwd(), f), 'utf8')));
    assert.deepEqual(users, []);
  });
});
