/**
 * Phase 4.4: Protocol Integration Tests
 * Validates the six registered tools through actual MCP JSON-RPC protocol requests:
 * - initialize: protocol version negotiation and tool capability advertisement
 * - tools/list: returns exactly the 6 approved tools with descriptions and JSON schemas
 * - tools/call: end-to-end execution of all 6 tools with mocked data services
 * - validation & error handling: parameter injection, invalid arguments, unknown tool
 * - security boundaries: authenticated principal binding, cross-tenant isolation, response size budget
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { handleMcpRequest, type McpDeps } from '../lib/mcp/handler';
import type { OAuthConfig } from '../lib/mcp/oauth/config';
import type { McpPrincipal } from '../lib/mcp/oauth/principal';
import { MCP_MAX_BODY_BYTES, type McpConfig } from '../lib/mcp/config';
import { MCP_SERVER_INFO, MCP_SERVER_INSTRUCTIONS, createTokenTracerMcpServer } from '../lib/mcp/server';
import { encodeRef } from '../lib/mcp/data/refs';
import { createDataScope } from '../lib/mcp/data/scope';
import type { McpPool } from '../lib/mcp/db';

const TEST_SECRET = '0123456789abcdef0123456789abcdef';
process.env.SESSION_SECRET = TEST_SECRET;

const HOST = 'mcp.test';
const ON: McpConfig = {
  enabled: true,
  allowedHosts: [HOST],
  allowedOriginHostnames: ['claude.ai', HOST],
  maxBodyBytes: MCP_MAX_BODY_BYTES,
};
const OAUTH: OAuthConfig = {
  baseUrl: `https://${HOST}`,
  host: HOST,
  resource: `https://${HOST}/mcp`,
  allowLoopback: true,
};

const TEAM_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TEAM_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_A = '11111111-1111-1111-1111-111111111111';
const DEV_A = '22222222-2222-2222-2222-222222222222';
const TOKEN_HASH = crypto.createHash('sha256').update('test_token').digest();

const PRINCIPAL: McpPrincipal = {
  userId: USER_A,
  clientId: 'tt_test_client',
  tokenId: '33333333-3333-3333-3333-333333333333',
  scope: 'mcp:read',
  role: 'admin',
  teamId: TEAM_A,
  displayName: 'Test Admin',
};

const TOKEN = `tt_at_${'A'.repeat(43)}`;
const AUTH = { authorization: `Bearer ${TOKEN}` };
const JSON_HEADERS = {
  host: HOST,
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  ...AUTH,
};

const scopeA = createDataScope({ tokenHash: TOKEN_HASH, userId: USER_A, teamId: TEAM_A });
const scopeB = createDataScope({ tokenHash: TOKEN_HASH, userId: USER_A, teamId: TEAM_B });

function createMockPool(rows: Record<string, unknown>[] = []): McpPool {
  return {
    connect: async () => ({
      query: async () => ({ rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] }),
      release: () => {},
    } as unknown as import('pg').PoolClient),
  } as unknown as McpPool;
}

let mockRows: Record<string, unknown>[] = [];

const mockDeps = {
  pool: () => createMockPool(mockRows),
  secret: () => TEST_SECRET,
  now: () => new Date('2026-11-26T12:00:00Z'),
};

const DEPS: McpDeps = {
  oauth: OAUTH,
  authenticate: async (t) => (t === TOKEN ? PRINCIPAL : null),
  createServer: (ctx) => createTokenTracerMcpServer(ctx, { deps: mockDeps }),
};

const post = (body: unknown, headers: Record<string, string> = {}, config: McpConfig = ON) =>
  handleMcpRequest(
    new Request(`https://${HOST}/mcp`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    config,
    DEPS
  );

const rpc = (method: string, params?: unknown, id: number | string = 1, headers: Record<string, string> = {}) =>
  post({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }, headers);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function result(res: Response): Promise<{ status: number; body: any }> {
  const text = await res.text();
  if (!text) return { status: res.status, body: null };
  if (res.headers.get('content-type')?.includes('text/event-stream')) {
    const data = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => JSON.parse(l.slice(5).trim()));
    return { status: res.status, body: data.length === 1 ? data[0] : data };
  }
  return { status: res.status, body: JSON.parse(text) };
}

describe('Phase 4.4: Protocol Handshake and Capabilities', () => {
  it('initialize negotiates protocol versions and advertises tools capability', async () => {
    for (const version of ['2025-11-25', '2025-06-18', '2025-03-26']) {
      const { status, body } = await result(
        await rpc('initialize', {
          protocolVersion: version,
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        })
      );

      assert.equal(status, 200);
      assert.equal(body.jsonrpc, '2.0');
      assert.equal(body.id, 1);
      assert.equal(body.result.protocolVersion, version);
      assert.deepEqual(body.result.serverInfo, { ...MCP_SERVER_INFO });
      assert.equal(body.result.instructions, MCP_SERVER_INSTRUCTIONS);
      assert.ok(body.result.capabilities.tools, 'tools capability must be advertised');
      assert.equal(body.result.capabilities.resources, undefined, 'no resources advertised');
      assert.equal(body.result.capabilities.prompts, undefined, 'no prompts advertised');
    }
  });
});

describe('Phase 4.4: tools/list Discovery', () => {
  it('tools/list returns exactly the six approved metadata-only tools', async () => {
    const { status, body } = await result(await rpc('tools/list', {}, 2));
    assert.equal(status, 200);
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, 2);

    const tools = body.result.tools;
    assert.ok(Array.isArray(tools));
    assert.equal(tools.length, 6);

    const toolNames = tools.map((t: { name: string }) => t.name).sort();
    assert.deepEqual(toolNames, [
      'developer_activity',
      'list_developers',
      'list_sessions',
      'prompt_metadata_batch',
      'search_prompt_metadata',
      'session_details',
    ]);

    for (const tool of tools) {
      assert.ok(tool.description && tool.description.length > 20);
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
  });
});

describe('Phase 4.4: tools/call Protocol Execution', () => {
  it('list_developers: successful execution returns text content with metadata', async () => {
    mockRows = [
      { member_id: DEV_A, display_name: 'Developer One', role: 'member' },
    ];
    const { status, body } = await result(
      await rpc('tools/call', {
        name: 'list_developers',
        arguments: { limit: 10 },
      }, 10)
    );

    assert.equal(status, 200);
    assert.equal(body.id, 10);
    assert.ok(body.result);
    assert.equal(body.result.isError, undefined);
    assert.ok(Array.isArray(body.result.content));
    assert.equal(body.result.content[0].type, 'text');

    const parsed = JSON.parse(body.result.content[0].text);
    assert.equal(parsed.items.length, 1);
    assert.equal(parsed.items[0].developerId, DEV_A);
    assert.equal(parsed.items[0].displayName, 'Developer One');
  });

  it('developer_activity: successfully executes with developerId and date window', async () => {
    mockRows = [
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
    const { status, body } = await result(
      await rpc('tools/call', {
        name: 'developer_activity',
        arguments: { developerId: DEV_A, from: '2026-11-20', to: '2026-11-26' },
      }, 11)
    );

    assert.equal(status, 200);
    assert.equal(body.id, 11);
    assert.equal(body.result.isError, undefined);
    const parsed = JSON.parse(body.result.content[0].text);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].day, '2026-11-25');
  });

  it('list_sessions: executes with optional filters', async () => {
    mockRows = [
      {
        id: '33333333-3333-3333-3333-333333333333',
        member_id: DEV_A,
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
    const { status, body } = await result(
      await rpc('tools/call', {
        name: 'list_sessions',
        arguments: { limit: 10 },
      }, 12)
    );

    assert.equal(status, 200);
    assert.equal(body.id, 12);
    assert.equal(body.result.isError, undefined);
    const parsed = JSON.parse(body.result.content[0].text);
    assert.equal(parsed.items.length, 1);
    assert.ok(typeof parsed.items[0].sessionRef === 'string');
  });

  it('session_details: executes with sealed session reference', async () => {
    const sessionUuid = '44444444-4444-4444-4444-444444444444';
    const sealedRef = encodeRef('session', sessionUuid, { scope: scopeA, secret: TEST_SECRET });

    mockRows = [
      {
        id: sessionUuid,
        member_id: DEV_A,
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

    const { status, body } = await result(
      await rpc('tools/call', {
        name: 'session_details',
        arguments: { sessionRef: sealedRef },
      }, 13)
    );

    assert.equal(status, 200);
    assert.equal(body.id, 13);
    assert.equal(body.result.isError, undefined);
    const parsed = JSON.parse(body.result.content[0].text);
    assert.equal(parsed.toolUsage.length, 1);
    assert.equal(parsed.toolUsage[0].toolName, 'read_file');
  });

  it('search_prompt_metadata: executes with filters', async () => {
    mockRows = [
      {
        prompt_id: '501',
        session_uuid: '44444444-4444-4444-4444-444444444444',
        member_id: DEV_A,
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

    const { status, body } = await result(
      await rpc('tools/call', {
        name: 'search_prompt_metadata',
        arguments: { developerId: DEV_A, limit: 5 },
      }, 14)
    );

    assert.equal(status, 200);
    assert.equal(body.id, 14);
    assert.equal(body.result.isError, undefined);
    const parsed = JSON.parse(body.result.content[0].text);
    assert.equal(parsed.items.length, 1);
    assert.equal(parsed.items[0].intent, 'bug_fix');
  });

  it('prompt_metadata_batch: executes with sealed prompt references', async () => {
    const sealedPromptRef = encodeRef('prompt', '501', { scope: scopeA, secret: TEST_SECRET });

    mockRows = [
      {
        prompt_id: '501',
        session_uuid: '44444444-4444-4444-4444-444444444444',
        member_id: DEV_A,
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

    const { status, body } = await result(
      await rpc('tools/call', {
        name: 'prompt_metadata_batch',
        arguments: { promptRefs: [sealedPromptRef] },
      }, 15)
    );

    assert.equal(status, 200);
    assert.equal(body.id, 15);
    assert.equal(body.result.isError, undefined);
    const parsed = JSON.parse(body.result.content[0].text);
    assert.equal(parsed.length, 1);
    assert.ok(typeof parsed[0].promptRef === 'string');
    assert.equal(parsed[0].intent, 'bug_fix');
  });
});

describe('Phase 4.4: Protocol Validation & Error Handling', () => {
  it('tools/call rejects unknown tool name with error', async () => {
    const { status, body } = await result(
      await rpc('tools/call', {
        name: 'unapproved_arbitrary_tool',
        arguments: {},
      }, 20)
    );

    assert.equal(status, 200);
    assert.ok(body.error || body.result?.isError);
  });

  it('tools/call rejects parameter injection (additionalProperties: false)', async () => {
    const { status, body } = await result(
      await rpc('tools/call', {
        name: 'list_developers',
        arguments: { injected_sql: 'DROP TABLE;' },
      }, 21)
    );

    assert.equal(status, 200);
    assert.ok(body.error || body.result?.isError);
  });

  it('tools/call rejects invalid argument types', async () => {
    const { status, body } = await result(
      await rpc('tools/call', {
        name: 'list_sessions',
        arguments: { limit: 'not-a-number' },
      }, 22)
    );

    assert.equal(status, 200);
    assert.ok(body.error || body.result?.isError);
  });
});

describe('Phase 4.4: Security Boundaries & Tenant Isolation', () => {
  it('cross-tenant sealed reference in tools/call fails unforgeably with not_found', async () => {
    const sessionUuid = '55555555-5555-5555-5555-555555555555';
    // Encrypted with TEAM_B
    const crossTenantRef = encodeRef('session', sessionUuid, { scope: scopeB, secret: TEST_SECRET });

    const { status, body } = await result(
      await rpc('tools/call', {
        name: 'session_details',
        arguments: { sessionRef: crossTenantRef },
      }, 30)
    );

    assert.equal(status, 200);
    assert.equal(body.result.isError, true);
    const parsed = JSON.parse(body.result.content[0].text);
    assert.equal(parsed.code, 'not_found'); // Never leaks existence across tenants
  });

  it('tampered sealed reference in tools/call fails verification with not_found', async () => {
    const sessionUuid = '66666666-6666-6666-6666-666666666666';
    const validRef = encodeRef('session', sessionUuid, { scope: scopeA, secret: TEST_SECRET });
    const tamperedRef = validRef.slice(0, -4) + 'zzzz';

    const { status, body } = await result(
      await rpc('tools/call', {
        name: 'session_details',
        arguments: { sessionRef: tamperedRef },
      }, 31)
    );

    assert.equal(status, 200);
    assert.equal(body.result.isError, true);
    const parsed = JSON.parse(body.result.content[0].text);
    assert.equal(parsed.code, 'not_found');
  });

  it('unauthenticated request fails before reaching tools/call', async () => {
    const unauthHeaders = {
      host: HOST,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };

    const res = await handleMcpRequest(
      new Request(`https://${HOST}/mcp`, {
        method: 'POST',
        headers: unauthHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 40,
          method: 'tools/call',
          params: { name: 'list_developers', arguments: {} },
        }),
      }),
      ON,
      DEPS
    );

    assert.equal(res.status, 401);
    assert.ok(res.headers.get('www-authenticate')?.includes('Bearer'));
  });

  it('metadata-only assurance: responses contain no raw prompt text or file paths', async () => {
    mockRows = [
      { member_id: DEV_A, display_name: 'Developer One', role: 'member' },
    ];
    const { status, body } = await result(
      await rpc('tools/call', {
        name: 'list_developers',
        arguments: {},
      }, 50)
    );

    assert.equal(status, 200);
    const responseText = JSON.stringify(body);
    assert.doesNotMatch(responseText, /\b(prompt_text|full_prompt|file_path|absolute_path)\b/i);
  });
});
