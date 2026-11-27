/**
 * Tests for P3-6: Adversarial & Fuzz Testing for MCP Data Services.
 *
 * Verifies:
 * 1. Fuzzing filters, identifiers, cursors, sealed references, date ranges, limits, and malformed inputs.
 * 2. Unknown fields, prototype pollution attempts, negative limits, extreme numbers, invalid UTF-8 / null bytes.
 * 3. Cross-tenant forged sealed references (cross-team, altered bytes, truncated auth tags).
 * 4. Verification that raw prompt text, snippets, file paths, agent identifiers, and internal fields never leak.
 * 5. Prompt search oracle resistance: SQL injection keywords or wildcard attacks reject cleanly with invalid_argument.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type pg from 'pg';
import {
  createDataScope,
  listDevelopers,
  getDeveloperActivity,
  listSessions,
  getSessionDetails,
  searchPromptMetadata,
  getPromptMetadataBatch,
  encodeRef,
  isDataError,
} from '../lib/mcp/data';

const TEST_SECRET = 'c'.repeat(64);
const OTHER_SECRET = 'd'.repeat(64);

const TEAM_A = '11111111-1111-4111-8111-111111111111';
const USER_A = '22222222-2222-4222-8222-222222222222';
const TOKEN_HASH_A = crypto.randomBytes(32);

const TEAM_B = '33333333-3333-4333-8333-333333333333';
const USER_B = '44444444-4444-4444-8444-444444444444';
const TOKEN_HASH_B = crypto.randomBytes(32);

function makeMockPool(
  queryHandler: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
) {
  const mockClient = {
    query: async (sqlOrConfig: string | { text: string; values?: unknown[] }, params?: unknown[]) => {
      const sqlText = typeof sqlOrConfig === 'string' ? sqlOrConfig : sqlOrConfig.text;
      const sqlParams = typeof sqlOrConfig === 'string' ? params : sqlOrConfig.values;
      return queryHandler(sqlText, sqlParams ?? []);
    },
    release: () => {},
  };

  const pool = {
    connect: async () => mockClient,
    end: async () => {},
    on: () => {},
  } as unknown as pg.Pool;

  return pool;
}

describe('P3-6: Adversarial & Fuzz Testing', () => {
  const scopeA = createDataScope({
    teamId: TEAM_A,
    userId: USER_A,
    tokenHash: TOKEN_HASH_A,
  });

  const configA = {
    pool: makeMockPool(async () => ({ rows: [] })),
    scope: scopeA,
    secret: TEST_SECRET,
  };

  describe('1. Input Fuzzing & Boundary Conditions', () => {
    it('rejects prototype pollution attempts in request parameters', async () => {
      const pollutedInput = JSON.parse('{"__proto__": {"polluted": true}, "unknown_extra": "hack"}');
      await assert.rejects(
        async () => listDevelopers(configA, pollutedInput),
        (err: unknown) => isDataError(err) && err.code === 'invalid_argument'
      );
      assert.equal((Object.prototype as unknown as { polluted?: boolean }).polluted, undefined);
    });

    it('rejects negative, NaN, Infinity, and non-integer limits', async () => {
      const badLimits = [-1, -999, NaN, Infinity, -Infinity, 1.5, 0];
      for (const badLimit of badLimits) {
        await assert.rejects(
          async () => listDevelopers(configA, { limit: badLimit as number }),
          (err: unknown) => isDataError(err) && (err.code === 'invalid_argument' || err.code === 'limit_exceeded'),
          `Expected invalid_argument or limit_exceeded for limit: ${badLimit}`
        );
      }
    });

    it('rejects oversized limits beyond maximum pagination ceiling', async () => {
      await assert.rejects(
        async () => listDevelopers(configA, { limit: 999999 }),
        (err: unknown) => isDataError(err) && (err.code === 'invalid_argument' || err.code === 'limit_exceeded')
      );
    });

    it('rejects malformed and boundary date range inputs in developer_activity', async () => {
      const malformedDates = [
        'not-a-date',
        '2026-02-30',
        '2026-13-01',
        '2026/01/01',
        '',
        '2026-01-01T25:00:00Z',
        '\x002026-01-01',
      ];

      for (const badDate of malformedDates) {
        await assert.rejects(
          async () =>
            getDeveloperActivity(configA, {
              developerId: USER_A,
              from: badDate,
              to: '2026-01-05',
            }),
          (err: unknown) => isDataError(err) && err.code === 'invalid_argument',
          `Expected invalid_argument for date: ${badDate}`
        );
      }
    });

    it('rejects inverted time window (from > to)', async () => {
      const now = new Date();
      const pastFrom = new Date(now.getTime() - 2 * 86400000).toISOString();
      const pastTo = new Date(now.getTime() - 4 * 86400000).toISOString();

      await assert.rejects(
        async () =>
          getDeveloperActivity(configA, {
            developerId: USER_A,
            from: pastFrom,
            to: pastTo,
          }),
        (err: unknown) => isDataError(err) && err.code === 'invalid_argument'
      );
    });

    it('rejects time window exceeding maximum allowed span (e.g. > 7 days window)', async () => {
      const now = new Date();
      const pastFrom = new Date(now.getTime() - 10 * 86400000).toISOString();
      const pastTo = new Date(now.getTime() - 1 * 86400000).toISOString();

      await assert.rejects(
        async () =>
          getDeveloperActivity(configA, {
            developerId: USER_A,
            from: pastFrom,
            to: pastTo,
          }),
        (err: unknown) => isDataError(err) && (err.code === 'window_too_large' || err.code === 'invalid_argument')
      );
    });
  });

  describe('2. Cursor & Sealed Ref Tampering', () => {
    it('rejects cursors with corrupted base64url or payload', async () => {
      const badCursors = [
        'invalid!@#$',
        'YWJj',
        'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3ODkwMTI',
      ];

      for (const badCursor of badCursors) {
        await assert.rejects(
          async () => listDevelopers(configA, { cursor: badCursor }),
          (err: unknown) => isDataError(err) && (err.code === 'cursor_invalid' || err.code === 'invalid_argument'),
          `Expected cursor_invalid for bad cursor: ${badCursor}`
        );
      }
    });

    it('rejects sealed references with invalid or tampered kind', async () => {
      const promptRef = encodeRef('prompt', '101', { scope: scopeA, secret: TEST_SECRET });

      await assert.rejects(
        async () => getSessionDetails(configA, { sessionRef: promptRef }),
        (err: unknown) => isDataError(err) && (err.code === 'not_found' || err.code === 'invalid_argument')
      );
    });

    it('rejects cross-tenant sealed references forged with a different teamId', async () => {
      const scopeB = createDataScope({
        teamId: TEAM_B,
        userId: USER_B,
        tokenHash: TOKEN_HASH_B,
      });

      const sessionUuid = '22222222-3333-4444-8888-999999999999';
      const sessionRefTeamB = encodeRef('session', sessionUuid, { scope: scopeB, secret: TEST_SECRET });

      await assert.rejects(
        async () => getSessionDetails(configA, { sessionRef: sessionRefTeamB }),
        (err: unknown) => isDataError(err) && err.code === 'not_found'
      );
    });

    it('rejects sealed references encrypted with a different secret', async () => {
      const sessionUuid = '22222222-3333-4444-8888-999999999999';
      const forgedRef = encodeRef('session', sessionUuid, { scope: scopeA, secret: OTHER_SECRET });

      await assert.rejects(
        async () => getSessionDetails(configA, { sessionRef: forgedRef }),
        (err: unknown) => isDataError(err) && err.code === 'not_found'
      );
    });

    it('rejects truncated, modified, or bit-flipped sealed references', async () => {
      const validRef = encodeRef('prompt', '404', { scope: scopeA, secret: TEST_SECRET });

      const chars = validRef.split('');
      chars[10] = chars[10] === 'a' ? 'b' : 'a';
      const tamperedRef = chars.join('');

      await assert.rejects(
        async () => getPromptMetadataBatch(configA, { promptRefs: [tamperedRef] }),
        (err: unknown) => isDataError(err) && err.code === 'not_found'
      );

      const truncatedRef = validRef.slice(0, 15);
      await assert.rejects(
        async () => getPromptMetadataBatch(configA, { promptRefs: [truncatedRef] }),
        (err: unknown) => isDataError(err) && (err.code === 'not_found' || err.code === 'invalid_argument')
      );
    });

    it('rejects batch queries with more than allowed maximum references', async () => {
      const oversizedBatch = Array.from({ length: 150 }, (_, i) =>
        encodeRef('prompt', String(i + 1), { scope: scopeA, secret: TEST_SECRET })
      );

      await assert.rejects(
        async () => getPromptMetadataBatch(configA, { promptRefs: oversizedBatch }),
        (err: unknown) => isDataError(err) && (err.code === 'limit_exceeded' || err.code === 'invalid_argument')
      );
    });

    it('rejects batch queries containing cross-tenant references mixed with valid ones', async () => {
      const scopeB = createDataScope({
        teamId: TEAM_B,
        userId: USER_B,
        tokenHash: TOKEN_HASH_B,
      });

      const validRef = encodeRef('prompt', '1', { scope: scopeA, secret: TEST_SECRET });
      const foreignRef = encodeRef('prompt', '2', { scope: scopeB, secret: TEST_SECRET });

      await assert.rejects(
        async () => getPromptMetadataBatch(configA, { promptRefs: [validRef, foreignRef] }),
        (err: unknown) => isDataError(err) && err.code === 'not_found'
      );
    });
  });

  describe('3. Metadata-Only Boundary & Information Leakage Prevention', () => {
    it('ensures no raw prompt text, snippets, or file paths can ever leak in searchPromptMetadata', async () => {
      const configWithMock = {
        pool: makeMockPool(async () => ({
          rows: [
            {
              prompt_id: '101',
              session_uuid: '99999999-9999-4999-8999-999999999999',
              member_id: USER_A,
              turn_index: 1,
              created_at: '2026-11-25T10:15:00Z',
              tool: 'cursor',
              model: 'claude-3-5-sonnet',
              prompt_char_len: 250,
              has_code_block: true,
              has_file_path: false,
              has_traceback: false,
              intent_category: 'feature',
              answer_input_tokens: '1500',
              answer_output_tokens: '400',
              answer_cache_read_tokens: '1000',
              answer_cache_write_tokens: '0',
              prompt_text: 'SECRET API KEY: sk-live-12345',
              prompt_text_sanitized: 'SECRET API KEY: sk-live-12345',
              file_path: '/Users/secret/confidential.ts',
              agent: 'claude-3-opus',
            },
          ],
        })),
        scope: scopeA,
        secret: TEST_SECRET,
      };

      const result = await searchPromptMetadata(configWithMock, { limit: 10 });
      assert.equal(result.items.length, 1);
      const item = result.items[0] as unknown as Record<string, unknown>;

      assert.equal(item.prompt_text, undefined);
      assert.equal(item.prompt_text_sanitized, undefined);
      assert.equal(item.file_path, undefined);
      assert.equal(item.agent, undefined);
      assert.equal(typeof item.promptRef, 'string');
      assert.equal(item.charLength, 250);
    });

    it('ensures no session file paths or raw metadata leak in listSessions and getSessionDetails', async () => {
      const sessionUuid = '99999999-9999-4999-8999-999999999999';
      const configWithMock = {
        pool: makeMockPool(async () => ({
          rows: [
            {
              id: sessionUuid,
              member_id: USER_A,
              source: 'vscode',
              started_at: '2026-11-25T10:00:00Z',
              ended_at: '2026-11-25T11:00:00Z',
              tokens_in: '1000',
              tokens_out: '200',
              tokens_cache_read: '0',
              tokens_cache_write: '0',
              api_cost: '0.05',
              priced: true,
              tool_calls: 5,
              tool_errors: 0,
              edits: 2,
              additions: 10,
              deletions: 5,
              changed_lines: 15,
              files_touched: 2,
              rework_loops: 0,
              corrections: 0,
              abandoned: false,
              events: [{ type: 'file_edit', file: '/etc/passwd' }],
              project_path: '/Users/dev/my-project',
              tools: [],
            },
          ],
        })),
        scope: scopeA,
        secret: TEST_SECRET,
      };

      const listResult = await listSessions(configWithMock, { limit: 10 });
      assert.equal(listResult.items.length, 1);
      const session = listResult.items[0] as unknown as Record<string, unknown>;

      assert.equal(session.events, undefined);
      assert.equal(session.project_path, undefined);
      assert.equal(typeof session.sessionRef, 'string');

      const detailResult = await getSessionDetails(configWithMock, {
        sessionRef: session.sessionRef as string,
      });
      const detail = detailResult as unknown as Record<string, unknown>;
      assert.equal(detail.events, undefined);
      assert.equal(detail.project_path, undefined);
    });
  });

  describe('4. Prompt Search Oracle Resistance', () => {
    it('rejects text search terms or keywords when caller attempts query or wildcards', async () => {
      const invalidQueryAttempts = [
        { query: 'SELECT * FROM users' },
        { keyword: 'password' },
        { text: 'secret' },
        { search: '%' },
      ];

      for (const attempt of invalidQueryAttempts) {
        await assert.rejects(
          async () => searchPromptMetadata(configA, attempt),
          (err: unknown) => isDataError(err) && err.code === 'invalid_argument'
        );
      }
    });
  });
});
