import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fromJsonSchema } from '@modelcontextprotocol/server';
import {
  TOOL_DEFINITIONS,
  LIST_DEVELOPERS_TOOL,
  SEARCH_PROMPT_METADATA_TOOL,
  PROMPT_METADATA_BATCH_TOOL,
  formatToolResult,
  formatToolError,
  executeListDevelopers,
  executeDeveloperActivity,
  executeListSessions,
  executeSessionDetails,
  executeSearchPromptMetadata,
  executePromptMetadataBatch,
  TOOL_EXECUTORS,
} from '../lib/mcp/tools';
import { makeToolContext } from '../lib/mcp/context';
import { encodeRef } from '../lib/mcp/data/refs';
import { createDataScope } from '../lib/mcp/data/scope';
import { DataError } from '../lib/mcp/data/errors';
import type { McpPool } from '../lib/mcp/db';

const TEST_SECRET = '0123456789abcdef0123456789abcdef';
const TEAM_ALPHA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_ALPHA = '11111111-1111-1111-1111-111111111111';
const DEV_ALPHA = '22222222-2222-2222-2222-222222222222';
const TOKEN_HASH = crypto.createHash('sha256').update('test_token').digest();

const TEST_PRINCIPAL = {
  tokenHash: TOKEN_HASH,
  userId: USER_ALPHA,
  teamId: TEAM_ALPHA,
  tokenId: '44444444-4444-4444-4444-444444444444',
  displayName: 'Admin User',
  role: 'admin' as const,
  clientId: 'tt_testclient',
  scope: 'mcp:read',
};

const CTX = makeToolContext(TEST_PRINCIPAL);

describe('Phase 4.1: Tool Definitions and JSON Schemas', () => {
  it('defines exactly the six approved tools', () => {
    assert.equal(TOOL_DEFINITIONS.length, 6);
    const names = TOOL_DEFINITIONS.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'developer_activity',
      'list_developers',
      'list_sessions',
      'prompt_metadata_batch',
      'search_prompt_metadata',
      'session_details',
    ]);
  });

  it('all tool schemas are valid Standard Schemas via fromJsonSchema', () => {
    for (const tool of TOOL_DEFINITIONS) {
      assert.ok(tool.description.length > 10, `${tool.name} description too short`);
      const standardSchema = fromJsonSchema(tool.inputSchema);
      assert.equal(typeof standardSchema['~standard'].validate, 'function');
    }
  });

  it('rejects unexpected/smuggled fields (additionalProperties: false)', () => {
    for (const tool of TOOL_DEFINITIONS) {
      const s = fromJsonSchema(tool.inputSchema);
      const res = s['~standard'].validate({ unauthorizedField: 'attack' });
      assert.ok('issues' in res, `${tool.name} must reject unexpected properties`);
    }
  });

  it('search_prompt_metadata schema strictly rejects text search keys', () => {
    const s = fromJsonSchema(SEARCH_PROMPT_METADATA_TOOL.inputSchema);
    for (const badKey of ['query', 'q', 'text', 'search', 'keyword', 'contains']) {
      const res = s['~standard'].validate({ [badKey]: 'foo' });
      assert.ok('issues' in res, `Must reject prompt text key: ${badKey}`);
    }
  });

  it('enforces limit ceilings and parameter types', () => {
    const devSchema = fromJsonSchema(LIST_DEVELOPERS_TOOL.inputSchema);
    assert.ok('issues' in devSchema['~standard'].validate({ limit: 51 }));
    assert.ok('issues' in devSchema['~standard'].validate({ limit: 0 }));
    assert.ok('issues' in devSchema['~standard'].validate({ limit: '5' }));
    assert.ok(!('issues' in devSchema['~standard'].validate({ limit: 25 })));

    const batchSchema = fromJsonSchema(PROMPT_METADATA_BATCH_TOOL.inputSchema);
    assert.ok('issues' in batchSchema['~standard'].validate({ promptRefs: [] }));
    assert.ok('issues' in batchSchema['~standard'].validate({
      promptRefs: Array.from({ length: 21 }, (_, i) => `ref_${i}`),
    }));
  });
});

describe('Phase 4.3: Output Formatting and Response Budget', () => {
  it('formats valid metadata objects into MCP text content', () => {
    const data = { developerId: DEV_ALPHA, displayName: 'Alice Dev', role: 'member' };
    const res = formatToolResult(data);
    assert.equal(res.content.length, 1);
    assert.equal(res.content[0].type, 'text');
    assert.deepEqual(JSON.parse(res.content[0].text), data);
    assert.equal(res.isError, undefined);
  });

  it('throws on output containing unauthorized/unapproved fields', () => {
    const dataWithPrompt = {
      developerId: DEV_ALPHA,
      prompt_text_sanitized: 'SECRET PROMPT TEXT',
    };
    assert.throws(() => formatToolResult(dataWithPrompt));

    const dataWithPath = {
      developerId: DEV_ALPHA,
      file_path: '/etc/passwd',
    };
    assert.throws(() => formatToolResult(dataWithPath));
  });

  it('fails closed if serialized output exceeds response budget', () => {
    const huge = {
      items: Array.from({ length: 1000 }, () => ({
        developerId: DEV_ALPHA,
        displayName: 'A'.repeat(50),
        role: 'member',
      })),
      nextCursor: null,
      truncated: false,
    };
    // If somehow a huge object bypassing packing arrives, formatToolResult throws
    assert.throws(() => formatToolResult(huge), (err: unknown) => {
      return err instanceof DataError && err.code === 'limit_exceeded';
    });
  });

  it('formats errors safely with sanitized messages and no leaked details', () => {
    const err = new DataError('not_found');
    const formatted = formatToolError(err);
    assert.equal(formatted.isError, true);
    const parsed = JSON.parse(formatted.content[0].text);
    assert.equal(parsed.code, 'not_found');
    assert.equal(parsed.error, 'The requested resource was not found.');
    assert.equal(/Secret DB/.test(formatted.content[0].text), false);
  });

  it('maps generic and unexpected exceptions to safe internal error', () => {
    const formatted = formatToolError(new Error('Fatal Postgres connection reset at 10.0.0.1'));
    assert.equal(formatted.isError, true);
    const parsed = JSON.parse(formatted.content[0].text);
    assert.equal(parsed.code, 'internal_error');
    assert.equal(parsed.error, 'An internal error occurred.');
    assert.equal(/Postgres/.test(formatted.content[0].text), false);
  });
});

describe('Phase 4.2: Tool Handler Execution and Context Binding', () => {
  function createMockPool(rows: Record<string, unknown>[] = []): McpPool {
    return {
      connect: async () => ({
        query: async () => ({ rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] }),
        release: () => {},
      } as unknown as import('pg').PoolClient),
    } as unknown as McpPool;
  }

  const mockDeps = (rows: Record<string, unknown>[] = []) => ({
    pool: () => createMockPool(rows),
    secret: () => TEST_SECRET,
    now: () => new Date('2026-11-26T12:00:00Z'),
  });

  it('executeListDevelopers delegates with principal scope and returns formatted result', async () => {
    const rows = [
      { member_id: DEV_ALPHA, display_name: 'Developer One', role: 'member' },
    ];
    const res = await executeListDevelopers(CTX, { limit: 10 }, mockDeps(rows));
    assert.equal(res.isError, undefined);
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.items.length, 1);
    assert.equal(parsed.items[0].developerId, DEV_ALPHA);
    assert.equal(parsed.items[0].displayName, 'Developer One');
  });

  it('executeDeveloperActivity validates developerId UUID and date window', async () => {
    const rows = [
      {
        day: '2026-11-25',
        tokens_in: '100',
        tokens_out: '50',
        cache_read_tokens: '0',
        cache_write_tokens: '0',
        api_cost: '0.05',
        session_count: '2',
        tool_calls: '10',
        tool_errors: '0',
        edits: '5',
        additions: '20',
        deletions: '5',
        changed_lines: '25',
        files_touched: '3',
        rework_loops: '0',
        corrections: '0',
        abandoned_count: '0',
      },
    ];
    const res = await executeDeveloperActivity(
      CTX,
      { developerId: DEV_ALPHA, from: '2026-11-20', to: '2026-11-26' },
      mockDeps(rows)
    );
    assert.equal(res.isError, undefined);
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].day, '2026-11-25');
  });

  it('executeListSessions produces valid session summaries with sealed refs', async () => {
    const rows = [
      {
        id: '33333333-3333-3333-3333-333333333333',
        member_id: DEV_ALPHA,
        source: 'claude-code',
        model: 'claude-3-5-sonnet',
        started_at: '2026-11-25T10:00:00Z',
        ended_at: '2026-11-25T10:30:00Z',
        activity_at: '2026-11-25T10:30:00Z',
        tokens_in: '500',
        tokens_out: '200',
        tokens_cache_read: '0',
        tokens_cache_write: '0',
        api_cost: '0.10',
        priced: true,
        edits: 2,
        additions: 10,
        deletions: 2,
        changed_lines: 12,
        files_touched: 1,
        tool_calls: 4,
        tool_errors: 0,
        rework_loops: 0,
        corrections: 0,
        abandoned: false,
      },
    ];
    const res = await executeListSessions(CTX, { limit: 5 }, mockDeps(rows));
    assert.equal(res.isError, undefined);
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.items.length, 1);
    assert.ok(typeof parsed.items[0].sessionRef === 'string');
    assert.equal(parsed.items[0].developerId, DEV_ALPHA);
  });

  it('executeSessionDetails decodes sealed sessionRef and handles not_found', async () => {
    const sessionUuid = '33333333-3333-3333-3333-333333333333';
    const scope = createDataScope({ tokenHash: TOKEN_HASH, userId: USER_ALPHA, teamId: TEAM_ALPHA });
    const sessionRef = encodeRef('session', sessionUuid, { scope, secret: TEST_SECRET });

    const rows = [
      {
        id: sessionUuid,
        member_id: DEV_ALPHA,
        source: 'claude-code',
        model: 'claude-3-5-sonnet',
        started_at: '2026-11-25T10:00:00Z',
        ended_at: '2026-11-25T10:30:00Z',
        activity_at: '2026-11-25T10:30:00Z',
        tokens_in: '500',
        tokens_out: '200',
        tokens_cache_read: '0',
        tokens_cache_write: '0',
        api_cost: '0.10',
        priced: true,
        edits: 2,
        additions: 10,
        deletions: 2,
        changed_lines: 12,
        files_touched: 1,
        tool_calls: 4,
        tool_errors: 0,
        rework_loops: 0,
        corrections: 0,
        abandoned: false,
        tools: [{ tool_name: 'read_file', call_count: 4 }],
      },
    ];

    const res = await executeSessionDetails(CTX, { sessionRef }, mockDeps(rows));
    assert.equal(res.isError, undefined);
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.toolUsage.length, 1);
    assert.equal(parsed.toolUsage[0].toolName, 'read_file');

    // Cross-team or tampered ref
    const badRef = encodeRef('session', sessionUuid, {
      scope: createDataScope({
        tokenHash: TOKEN_HASH,
        userId: USER_ALPHA,
        teamId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      }),
      secret: TEST_SECRET,
    });
    const errRes = await executeSessionDetails(CTX, { sessionRef: badRef }, mockDeps([]));
    assert.equal(errRes.isError, true);
    assert.equal(JSON.parse(errRes.content[0].text).code, 'not_found');
  });

  it('executeSearchPromptMetadata rejects text queries and processes structured metadata filters', async () => {
    // Attempting query parameter
    const badRes = await executeSearchPromptMetadata(CTX, { query: 'test' }, mockDeps([]));
    assert.equal(badRes.isError, true);
    assert.equal(JSON.parse(badRes.content[0].text).code, 'invalid_argument');

    const rows = [
      {
        prompt_id: '501',
        session_uuid: '33333333-3333-3333-3333-333333333333',
        member_id: DEV_ALPHA,
        turn_index: 0,
        created_at: '2026-11-25T11:00:00Z',
        tool: 'claude-code',
        model: 'claude-3-5-sonnet',
        prompt_char_len: 120,
        has_code_block: true,
        has_file_path: false,
        has_traceback: false,
        intent_category: 'bug_fix',
        answer_input_tokens: '50',
        answer_output_tokens: '100',
        answer_cache_read_tokens: '0',
        answer_cache_write_tokens: '0',
      },
    ];

    const okRes = await executeSearchPromptMetadata(
      CTX,
      { intents: ['bug_fix'], hasCodeBlock: true, limit: 10 },
      mockDeps(rows)
    );
    assert.equal(okRes.isError, undefined);
    const parsed = JSON.parse(okRes.content[0].text);
    assert.equal(parsed.items.length, 1);
    assert.equal(parsed.items[0].intent, 'bug_fix');
    assert.equal(parsed.items[0].charLength, 120);
    assert.ok(typeof parsed.items[0].promptRef === 'string');
    assert.equal(parsed.items[0].prompt_text_sanitized, undefined);
  });

  it('executePromptMetadataBatch decodes promptRefs and rejects foreign refs', async () => {
    const scope = createDataScope({ tokenHash: TOKEN_HASH, userId: USER_ALPHA, teamId: TEAM_ALPHA });
    const promptRef1 = encodeRef('prompt', '501', { scope, secret: TEST_SECRET });

    const rows = [
      {
        prompt_id: '501',
        session_uuid: '33333333-3333-3333-3333-333333333333',
        member_id: DEV_ALPHA,
        turn_index: 0,
        created_at: '2026-11-25T11:00:00Z',
        tool: 'claude-code',
        model: 'claude-3-5-sonnet',
        prompt_char_len: 120,
        has_code_block: true,
        has_file_path: false,
        has_traceback: false,
        intent_category: 'bug_fix',
        answer_input_tokens: '50',
        answer_output_tokens: '100',
        answer_cache_read_tokens: '0',
        answer_cache_write_tokens: '0',
      },
    ];

    const res = await executePromptMetadataBatch(CTX, { promptRefs: [promptRef1] }, mockDeps(rows));
    assert.equal(res.isError, undefined);
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].charLength, 120);

    // Foreign ref
    const foreignRef = encodeRef('prompt', '501', {
      scope: createDataScope({
        tokenHash: TOKEN_HASH,
        userId: USER_ALPHA,
        teamId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      }),
      secret: TEST_SECRET,
    });
    const errRes = await executePromptMetadataBatch(CTX, { promptRefs: [foreignRef] }, mockDeps([]));
    assert.equal(errRes.isError, true);
    assert.equal(JSON.parse(errRes.content[0].text).code, 'not_found');
  });

  it('TOOL_EXECUTORS registry exposes all 6 executors by tool name', () => {
    assert.equal(Object.keys(TOOL_EXECUTORS).length, 6);
    assert.equal(typeof TOOL_EXECUTORS.list_developers, 'function');
    assert.equal(typeof TOOL_EXECUTORS.developer_activity, 'function');
    assert.equal(typeof TOOL_EXECUTORS.list_sessions, 'function');
    assert.equal(typeof TOOL_EXECUTORS.session_details, 'function');
    assert.equal(typeof TOOL_EXECUTORS.search_prompt_metadata, 'function');
    assert.equal(typeof TOOL_EXECUTORS.prompt_metadata_batch, 'function');
  });
});
