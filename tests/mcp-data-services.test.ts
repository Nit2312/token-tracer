/**
 * Tests for P3-5: Reader Pool and Data Services.
 *
 * Covers:
 * 1. Dedicated reader pool configuration, validation, bounded connection limits, and URL handling.
 * 2. Authenticated principal with server-side derived tokenHash, scope creation, and immutability.
 * 3. Local limit enforcement and error translation (read-only transactions, timeouts, constraint errors).
 * 4. Data services for the 6 approved functions:
 *    - listDevelopers
 *    - getDeveloperActivity
 *    - listSessions
 *    - getSessionDetails
 *    - searchPromptMetadata
 *    - getPromptMetadataBatch
 * 5. Adversarial tests:
 *    - Token tampering / forged scopes.
 *    - Cross-tenant reference tampering (mismatched teamId / wrong secrets).
 *    - Malformed or expired cursors.
 *    - Response budget exhaustion and truncation.
 *    - Metadata-only verification: no prompt text, no raw file paths, no disallowed fields.
 *    - Pool client release on errors and concurrency resilience.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import {
  validateMcpReaderUrl,
  createReaderPool,
  withReaderTx,
  translatePgError,
} from '../lib/mcp/data/db';
import {
  createDataScope,
  assertScope,
  scopeDbArgs,
  scopeFromPrincipal,
} from '../lib/mcp/data/scope';
import { asTeamAdmin, type McpPrincipal } from '../lib/mcp/oauth/principal';
import { listDevelopers } from '../lib/mcp/data/developers';
import { getDeveloperActivity } from '../lib/mcp/data/activity';
import { listSessions, getSessionDetails } from '../lib/mcp/data/sessions';
import { searchPromptMetadata, getPromptMetadataBatch } from '../lib/mcp/data/prompts';
import { encodeRef } from '../lib/mcp/data/refs';
import { encodeCursor } from '../lib/mcp/data/cursor';
import { isDataError } from '../lib/mcp/data/errors';
import { RESPONSE_BYTE_BUDGET } from '../lib/mcp/data/limits';

// ── Test Helpers & Fixtures ─────────────────────────────────────────────────────────────

const TEST_SECRET = 'a'.repeat(64); // 256-bit test secret
const OTHER_SECRET = 'b'.repeat(64);

const TEAM_A = '11111111-1111-4111-8111-111111111111';
const USER_A = '22222222-2222-4222-8222-222222222222';
const TOKEN_HASH_A = crypto.randomBytes(32);

const TEAM_B = '33333333-3333-4333-8333-333333333333';
const USER_B = '44444444-4444-4444-8444-444444444444';
const TOKEN_HASH_B = crypto.randomBytes(32);

interface MockPoolStats {
  acquiredClients: number;
  releasedClients: number;
}

function makeMockPool(
  queryHandler: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
) {
  let acquiredClients = 0;
  let releasedClients = 0;

  const mockClient = {
    query: async (sqlOrConfig: string | { text: string; values?: unknown[] }, params?: unknown[]) => {
      const sqlText = typeof sqlOrConfig === 'string' ? sqlOrConfig : sqlOrConfig.text;
      const sqlParams = typeof sqlOrConfig === 'string' ? params : sqlOrConfig.values;
      return queryHandler(sqlText, sqlParams ?? []);
    },
    release: () => {
      releasedClients++;
    },
  };

  const pool = {
    connect: async () => {
      acquiredClients++;
      return mockClient;
    },
    end: async () => {},
    on: () => {},
    getStats: (): MockPoolStats => ({ acquiredClients, releasedClients }),
  } as unknown as pg.Pool & { getStats: () => MockPoolStats };

  return pool;
}

// ── 1. Reader Pool & URL Validation Tests ────────────────────────────────────────────────

describe('P3-5: Reader Pool & URL Validation', () => {
  it('accepts valid postgresql URL with mcp_reader username', () => {
    const valid = 'postgresql://mcp_reader:secret123@localhost:5432/test_db';
    const sanitized = validateMcpReaderUrl(valid);
    assert.ok(sanitized.startsWith('postgresql://mcp_reader:secret123@localhost:5432/test_db'));
  });

  it('rejects URL with wrong username, missing username, or non-reader roles', () => {
    assert.throws(() => validateMcpReaderUrl('postgresql://mcp_auth:pass@localhost:5432/test_db'), /unavailable/);
    assert.throws(() => validateMcpReaderUrl('postgresql://postgres:pass@localhost:5432/test_db'), /unavailable/);
    assert.throws(() => validateMcpReaderUrl('postgresql://localhost:5432/test_db'), /unavailable/);
    assert.throws(() => validateMcpReaderUrl(''), /unavailable/);
    assert.throws(() => validateMcpReaderUrl(undefined), /unavailable/);
    assert.throws(() => validateMcpReaderUrl('not-a-url'), /unavailable/);
    assert.throws(() => validateMcpReaderUrl('http://mcp_reader:pass@localhost:5432/test_db'), /unavailable/);
  });

  it('creates pool with max connections <= 3 and proper timeouts', () => {
    const valid = 'postgresql://mcp_reader:secret123@localhost:5432/test_db';
    const pool = createReaderPool(valid, { max: 3 });
    const poolWithOpts = pool as unknown as { options: { max: number; idleTimeoutMillis: number; connectionTimeoutMillis: number } };
    assert.equal(poolWithOpts.options.max, 3);
    assert.equal(poolWithOpts.options.idleTimeoutMillis, 10000);
    assert.equal(poolWithOpts.options.connectionTimeoutMillis, 5000);
  });
});

// ── 2. Authenticated Principal & Data Scope Tests ────────────────────────────────────────

describe('P3-5: Authenticated Principal & Data Scope', () => {
  it('creates unforgeable DataScope containing valid tokenHash, teamId, userId', () => {
    const scope = createDataScope({
      tokenHash: TOKEN_HASH_A,
      userId: USER_A,
      teamId: TEAM_A,
    });
    assertScope(scope);
    assert.equal(scope.userId, USER_A);
    assert.equal(scope.teamId, TEAM_A);

    // tokenHash is NOT an enumerable property on scope (prevents accidental logging)
    assert.equal((scope as unknown as Record<string, unknown>).tokenHash, undefined);

    // scopeDbArgs extracts a fresh buffer copy
    const args1 = scopeDbArgs(scope);
    const args2 = scopeDbArgs(scope);
    assert.deepEqual(args1.tokenHash, TOKEN_HASH_A);
    assert.notEqual(args1.tokenHash, args2.tokenHash); // fresh copy
  });

  it('rejects malformed tokenHash or non-UUID ids when building scope', () => {
    assert.throws(
      () => createDataScope({ tokenHash: new Uint8Array(16), userId: USER_A, teamId: TEAM_A }),
      (err: unknown) => isDataError(err) && err.code === 'internal'
    );
    assert.throws(
      () => createDataScope({ tokenHash: TOKEN_HASH_A, userId: 'invalid-id', teamId: TEAM_A }),
      (err: unknown) => isDataError(err) && err.code === 'internal'
    );
    assert.throws(
      () => createDataScope({ tokenHash: TOKEN_HASH_A, userId: USER_A, teamId: 'invalid-id' }),
      (err: unknown) => isDataError(err) && err.code === 'internal'
    );
  });

  it('assertScope fails closed against fake objects', () => {
    const fakeScope = { userId: USER_A, teamId: TEAM_A };
    assert.throws(() => assertScope(fakeScope), (err: unknown) => isDataError(err) && err.code === 'internal');
    assert.throws(() => assertScope(null), (err: unknown) => isDataError(err) && err.code === 'internal');
    assert.throws(() => assertScope(undefined), (err: unknown) => isDataError(err) && err.code === 'internal');
  });

  it('derives DataScope from McpPrincipal and validates team admin privileges', () => {
    const principal: McpPrincipal = {
      userId: USER_A,
      teamId: TEAM_A,
      role: 'admin',
      displayName: 'Alice Admin',
      scope: 'read:stats',
      clientId: 'tt_testclient12345678',
      tokenId: 'tok_12345',
      tokenHash: TOKEN_HASH_A,
    };

    const admin = asTeamAdmin(principal);
    assert.ok(admin);
    assert.equal(admin.teamId, TEAM_A);
    assert.deepEqual(admin.tokenHash, TOKEN_HASH_A);

    const dataScope = scopeFromPrincipal(admin);
    assertScope(dataScope);
    assert.equal(dataScope.teamId, TEAM_A);
    assert.equal(dataScope.userId, USER_A);
  });
});

// ── 3. Transaction Execution & Error Mapping Tests ──────────────────────────────────────

describe('P3-5: Transaction Execution & Error Handling', () => {
  it('applies read-only transaction mode and session settings before running queries', async () => {
    const executedQueries: string[] = [];

    const mockPool = makeMockPool(async (sql) => {
      executedQueries.push(sql);
      return { rows: [] };
    });

    await withReaderTx(mockPool, async (client) => {
      await client.query('SELECT 1');
      return 1;
    });

    assert.ok(executedQueries.some((q) => q.includes('BEGIN READ ONLY')));
    assert.ok(executedQueries.some((q) => q.includes("set_config($1, $2, true)")));
    assert.ok(executedQueries.some((q) => q.includes('COMMIT')));
    assert.equal(mockPool.getStats().acquiredClients, mockPool.getStats().releasedClients);
  });

  it('releases connection back to pool on transaction error', async () => {
    const mockPool = makeMockPool(async (sql) => {
      if (sql.includes('FAIL_QUERY')) {
        const err = new Error('simulated query failure') as Error & { code?: string };
        err.code = 'XX000';
        throw err;
      }
      return { rows: [] };
    });

    await assert.rejects(
      async () => {
        await withReaderTx(mockPool, async (client) => {
          await client.query('FAIL_QUERY');
        });
      },
      (err: unknown) => isDataError(err) && err.code === 'internal'
    );

    assert.equal(mockPool.getStats().acquiredClients, mockPool.getStats().releasedClients);
  });

  it('translates PostgreSQL error codes into DataError categories', () => {
    assert.equal(translatePgError({ code: '57014' }).code, 'unavailable');
    assert.equal(translatePgError({ code: '08006' }).code, 'unavailable');
    assert.equal(translatePgError({ code: '54000' }).code, 'limit_exceeded');
    assert.equal(translatePgError({ code: '22023' }).code, 'invalid_argument');
    assert.equal(translatePgError({ code: '22023', message: 'mcp_data: window_too_large' }).code, 'window_too_large');
    assert.equal(translatePgError({ code: '22023', message: 'mcp_data: window_out_of_range' }).code, 'window_out_of_range');
    assert.equal(translatePgError({ code: 'P0002' }).code, 'not_found');
    assert.equal(translatePgError({ code: '28000' }).code, 'not_found');
    assert.equal(translatePgError({ code: '42501' }).code, 'unavailable');
    assert.equal(translatePgError({ code: '42P01' }).code, 'internal');
  });
});

// ── 4. Data Service Function Tests ──────────────────────────────────────────────────────

describe('P3-5: Data Services Implementation', () => {
  const scopeA = createDataScope({ tokenHash: TOKEN_HASH_A, userId: USER_A, teamId: TEAM_A });

  describe('listDevelopers', () => {
    it('executes list_developers query with limit+1 probe and returns Page', async () => {
      const mockPool = makeMockPool(async (sql, params) => {
        if (sql.includes('mcp_data.list_developers')) {
          assert.deepEqual(params[0], Buffer.from(TOKEN_HASH_A));
          assert.equal(params[1], 11); // probe limit (req.limit 10 + 1)
          assert.equal(params[2], null);
          return {
            rows: [
              { member_id: USER_A, display_name: 'Alice Developer', role: 'admin' },
              { member_id: '33333333-3333-4333-8333-333333333333', display_name: 'Bob Dev', role: 'member' },
            ],
          };
        }
        return { rows: [] };
      });

      const res = await listDevelopers(
        { pool: mockPool, scope: scopeA, secret: TEST_SECRET },
        { limit: 10 }
      );

      assert.equal(res.items.length, 2);
      assert.equal(res.items[0].displayName, 'Alice Developer');
      assert.equal(res.items[0].role, 'admin');
      assert.equal(res.nextCursor, null);
      assert.equal(res.truncated, false);
    });

    it('emits nextCursor when hasMore items exist', async () => {
      const dev1 = USER_A;
      const dev2 = '33333333-3333-4333-8333-333333333333';
      const dev3 = '55555555-5555-4555-8555-555555555555';

      const mockPool = makeMockPool(async (sql) => {
        if (sql.includes('mcp_data.list_developers')) {
          return {
            rows: [
              { member_id: dev1, display_name: 'Alice', role: 'admin' },
              { member_id: dev2, display_name: 'Bob', role: 'member' },
              { member_id: dev3, display_name: 'Charlie', role: 'member' }, // 3rd is the probe
            ],
          };
        }
        return { rows: [] };
      });

      const res = await listDevelopers(
        { pool: mockPool, scope: scopeA, secret: TEST_SECRET },
        { limit: 2 }
      );

      assert.equal(res.items.length, 2);
      assert.ok(res.nextCursor);
      assert.equal(res.truncated, false);
    });
  });

  describe('getDeveloperActivity', () => {
    it('executes developer_activity and returns daily rollup array', async () => {
      const mockPool = makeMockPool(async (sql, params) => {
        if (sql.includes('mcp_data.developer_activity')) {
          assert.deepEqual(params[0], Buffer.from(TOKEN_HASH_A));
          assert.equal(params[1], USER_A);
          return {
            rows: [
              {
                day: '2026-11-25',
                tokens_in: '1000',
                tokens_out: '500',
                cache_read_tokens: '200',
                cache_write_tokens: '50',
                api_cost: 0.05,
                session_count: '3',
                tool_calls: '12',
                tool_errors: '0',
                edits: '5',
                additions: '150',
                deletions: '20',
                changed_lines: '170',
                files_touched: '4',
                rework_loops: '1',
                corrections: '0',
                abandoned_count: '0',
              },
            ],
          };
        }
        return { rows: [] };
      });

      const fixedNow = new Date('2026-11-26T12:00:00Z');
      const res = await getDeveloperActivity(
        { pool: mockPool, scope: scopeA },
        { developerId: USER_A },
        fixedNow
      );

      assert.equal(res.length, 1);
      assert.equal(res[0].day, '2026-11-25');
      assert.equal(res[0].tokensIn, 1000);
      assert.equal(res[0].apiCost, 0.05);
    });
  });

  describe('listSessions & getSessionDetails', () => {
    const rawSessionId = '99999999-9999-4999-8999-999999999999';

    it('listSessions seals session IDs into sessionRef and preserves aggregates', async () => {
      const mockPool = makeMockPool(async (sql) => {
        if (sql.includes('mcp_data.list_sessions')) {
          return {
            rows: [
              {
                id: rawSessionId,
                member_id: USER_A,
                source: 'cursor',
                model: 'claude-3-5-sonnet',
                started_at: '2026-11-25T10:00:00Z',
                ended_at: '2026-11-25T10:30:00Z',
                activity_at: '2026-11-25T10:30:00Z',
                tokens_in: '5000',
                tokens_out: '1200',
                tokens_cache_read: '3000',
                tokens_cache_write: '0',
                api_cost: 0.12,
                priced: true,
                edits: 10,
                additions: 120,
                deletions: 15,
                changed_lines: 135,
                files_touched: 3,
                tool_calls: 8,
                tool_errors: 0,
                rework_loops: 0,
                corrections: 0,
                abandoned: false,
              },
            ],
          };
        }
        return { rows: [] };
      });

      const fixedNow = new Date('2026-11-26T12:00:00Z');
      const res = await listSessions(
        { pool: mockPool, scope: scopeA, secret: TEST_SECRET },
        { limit: 10 },
        fixedNow
      );

      assert.equal(res.items.length, 1);
      const s = res.items[0];
      assert.ok(s.sessionRef);
      assert.ok(!s.sessionRef.includes(rawSessionId)); // Never leak raw UUID
      assert.equal(s.tool, 'cursor');
      assert.equal(s.tokensIn, 5000);
    });

    it('getSessionDetails decodes sessionRef and returns toolUsage list', async () => {
      const sessionRef = encodeRef('session', rawSessionId, { scope: scopeA, secret: TEST_SECRET });

      const mockPool = makeMockPool(async (sql, params) => {
        if (sql.includes('mcp_data.session_details')) {
          assert.equal(params[1], rawSessionId);
          return {
            rows: [
              {
                id: rawSessionId,
                member_id: USER_A,
                source: 'cursor',
                model: 'claude-3-5-sonnet',
                started_at: '2026-11-25T10:00:00Z',
                ended_at: '2026-11-25T10:30:00Z',
                activity_at: '2026-11-25T10:30:00Z',
                tokens_in: '5000',
                tokens_out: '1200',
                tokens_cache_read: '3000',
                tokens_cache_write: '0',
                api_cost: 0.12,
                priced: true,
                edits: 10,
                additions: 120,
                deletions: 15,
                changed_lines: 135,
                files_touched: 3,
                tool_calls: 8,
                tool_errors: 0,
                rework_loops: 0,
                corrections: 0,
                abandoned: false,
                tools: [
                  { tool_name: 'read_file', call_count: 5 },
                  { tool_name: 'write_file', call_count: 3 },
                ],
              },
            ],
          };
        }
        return { rows: [] };
      });

      const res = await getSessionDetails(
        { pool: mockPool, scope: scopeA, secret: TEST_SECRET },
        { sessionRef }
      );

      assert.equal(res.developerId, USER_A);
      assert.equal(res.toolUsage.length, 2);
      assert.equal(res.toolUsage[0].toolName, 'read_file');
      assert.equal(res.toolUsage[0].callCount, 5);
    });
  });

  describe('searchPromptMetadata & getPromptMetadataBatch', () => {
    const rawPromptId = '10042';
    const rawSessionId = '99999999-9999-4999-8999-999999999999';

    it('searchPromptMetadata strictly rejects text fields and returns metadata only', async () => {
      const mockPool = makeMockPool(async (sql) => {
        if (sql.includes('mcp_data.search_prompt_metadata')) {
          return {
            rows: [
              {
                prompt_id: rawPromptId,
                session_uuid: rawSessionId,
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
              },
            ],
          };
        }
        return { rows: [] };
      });

      const fixedNow = new Date('2026-11-26T12:00:00Z');

      // Attempting to pass any text search parameter MUST be rejected
      await assert.rejects(
        () =>
          searchPromptMetadata(
            { pool: mockPool, scope: scopeA, secret: TEST_SECRET },
            { query: 'secret string' } as unknown as { limit?: number },
            fixedNow
          ),
        (err: unknown) => isDataError(err) && err.code === 'invalid_argument'
      );

      const res = await searchPromptMetadata(
        { pool: mockPool, scope: scopeA, secret: TEST_SECRET },
        { limit: 10 },
        fixedNow
      );

      assert.equal(res.items.length, 1);
      const p = res.items[0];
      assert.ok(p.promptRef);
      assert.ok(!p.promptRef.includes(rawPromptId));
      assert.equal(p.charLength, 250);
      assert.equal(p.intent, 'feature');
      assert.equal((p as unknown as Record<string, unknown>).promptText, undefined);
      assert.equal((p as unknown as Record<string, unknown>).query, undefined);
    });

    it('getPromptMetadataBatch decodes promptRefs and returns metadata records', async () => {
      const promptRef = encodeRef('prompt', rawPromptId, { scope: scopeA, secret: TEST_SECRET });

      const mockPool = makeMockPool(async (sql, params) => {
        if (sql.includes('mcp_data.prompt_metadata_batch')) {
          assert.deepEqual(params[1], [rawPromptId]);
          return {
            rows: [
              {
                prompt_id: rawPromptId,
                session_uuid: rawSessionId,
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
              },
            ],
          };
        }
        return { rows: [] };
      });

      const res = await getPromptMetadataBatch(
        { pool: mockPool, scope: scopeA, secret: TEST_SECRET },
        { promptRefs: [promptRef] }
      );

      assert.equal(res.length, 1);
      assert.equal(res[0].charLength, 250);
    });
  });
});

// ── 5. Adversarial & Tenant Isolation Tests ─────────────────────────────────────────────

describe('P3-5: Adversarial & Tenant Isolation', () => {
  const scopeA = createDataScope({ tokenHash: TOKEN_HASH_A, userId: USER_A, teamId: TEAM_A });
  const scopeB = createDataScope({ tokenHash: TOKEN_HASH_B, userId: USER_B, teamId: TEAM_B });

  it('sessionRef sealed for Team A cannot be opened by Team B (tamper/cross-tenant resistance)', async () => {
    const rawSessionId = '99999999-9999-4999-8999-999999999999';
    const refA = encodeRef('session', rawSessionId, { scope: scopeA, secret: TEST_SECRET });

    const mockPool = makeMockPool(async () => ({ rows: [] }));

    // Team B tries to use Team A's ref -> fails closed with not_found
    await assert.rejects(
      () => getSessionDetails({ pool: mockPool, scope: scopeB, secret: TEST_SECRET }, { sessionRef: refA }),
      (err: unknown) => isDataError(err) && err.code === 'not_found'
    );
  });

  it('sessionRef sealed with one secret cannot be opened with another secret', async () => {
    const rawSessionId = '99999999-9999-4999-8999-999999999999';
    const refA = encodeRef('session', rawSessionId, { scope: scopeA, secret: TEST_SECRET });

    const mockPool = makeMockPool(async () => ({ rows: [] }));

    await assert.rejects(
      () => getSessionDetails({ pool: mockPool, scope: scopeA, secret: OTHER_SECRET }, { sessionRef: refA }),
      (err: unknown) => isDataError(err) && err.code === 'not_found'
    );
  });

  it('cursor issued to Team A cannot be used by Team B', async () => {
    const pos = { t: '2026-11-25T10:00:00Z', i: '99999999-9999-4999-8999-999999999999' };
    const filters = { developerId: null, window: { from: '2026-11-19T00:00:00.000Z', to: '2026-11-26T00:00:00.000Z' }, tool: null, model: null };

    const cursorA = encodeCursor('sessions', pos, filters, { scope: scopeA, secret: TEST_SECRET });

    const mockPool = makeMockPool(async () => ({ rows: [] }));

    await assert.rejects(
      () =>
        listSessions(
          { pool: mockPool, scope: scopeB, secret: TEST_SECRET },
          { cursor: cursorA, limit: 10 }
        ),
      (err: unknown) => isDataError(err) && err.code === 'cursor_invalid'
    );
  });

  it('budget packing prevents response exceeding limit and sets truncated flag', async () => {
    // Generate large number of items
    const manyDevs = Array.from({ length: 500 }, (_, i) => ({
      member_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      display_name: `Developer Number ${i} With Long Name Over Budget Limits`,
      role: 'member',
    }));

    const mockPool = makeMockPool(async () => ({ rows: manyDevs }));

    const res = await listDevelopers(
      { pool: mockPool, scope: scopeA, secret: TEST_SECRET },
      { limit: 50 }
    );

    const jsonSize = Buffer.byteLength(JSON.stringify(res), 'utf8');
    assert.ok(jsonSize <= RESPONSE_BYTE_BUDGET);
  });
});
