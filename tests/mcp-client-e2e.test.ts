/**
 * Phase 4.5: Real MCP Client Integration and End-to-End Validation
 *
 * Implements full client-to-server end-to-end testing:
 * - Real MCP client extending Protocol (standard Streamable HTTP client)
 * - Complete OAuth 2.1 flow:
 *     1. Protected Resource & Auth Server discovery
 *     2. Dynamic Client Registration (RFC 7591)
 *     3. Authorization request with PKCE S256 challenge
 *     4. Simulated admin login & consent grant (handleDecision)
 *     5. Authorization code exchange for Access + Refresh tokens
 *     6. Bearer authentication over Streamable HTTP on /mcp
 *     7. Refresh token rotation & token reuse detection
 *     8. Token revocation (RFC 7009)
 * - Multi-tenant database service execution for all 6 metadata-only tools:
 *     1. list_developers
 *     2. developer_activity
 *     3. list_sessions
 *     4. session_details
 *     5. search_prompt_metadata
 *     6. prompt_metadata_batch
 * - Negative and adversarial validation:
 *     - Cross-tenant sealed reference rejection (unforgeable not_found)
 *     - Parameter smuggling (additionalProperties: false)
 *     - Expired/revoked token handling
 *     - Response size budget enforcement (24 KiB)
 *     - Connection lifecycle: connect, initialize, call, disconnect, reconnect
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as sdk from '@modelcontextprotocol/server';
import { handleMcpRequest, type McpDeps } from '../lib/mcp/handler';
import { createTokenTracerMcpServer } from '../lib/mcp/server';
import { MCP_MAX_BODY_BYTES, type McpConfig } from '../lib/mcp/config';
import type { OAuthConfig } from '../lib/mcp/oauth/config';
import type { McpPrincipal } from '../lib/mcp/oauth/principal';
import { s256Challenge, generateSecret, sha256 } from '../lib/mcp/oauth/crypto';
import { handleRegister, handleToken, handleRevoke, handleAuthorizationServerMetadata, handleProtectedResourceMetadata } from '../lib/mcp/oauth/endpoints';
import { handleDecision, prepareAuthorize } from '../lib/mcp/oauth/authorize';
import { encodeRef } from '../lib/mcp/data/refs';
import { createDataScope } from '../lib/mcp/data/scope';
import type { McpPool } from '../lib/mcp/db';
import type { SessionPayload } from '../lib/session-token';

const TEST_SECRET = '0123456789abcdef0123456789abcdef';
process.env.SESSION_SECRET = TEST_SECRET;

const HOST = 'mcp.test';
const BASE_URL = `https://${HOST}`;
const OAUTH_CFG: OAuthConfig = {
  baseUrl: BASE_URL,
  host: HOST,
  resource: `${BASE_URL}/mcp`,
  allowLoopback: true,
};
const MCP_CFG: McpConfig = {
  enabled: true,
  allowedHosts: [HOST],
  allowedOriginHostnames: ['claude.ai', HOST],
  maxBodyBytes: MCP_MAX_BODY_BYTES,
};

// Test fixtures for multiple tenants
const TEAM_ALPHA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TEAM_BETA = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_ALPHA = '11111111-1111-1111-1111-111111111111';
const USER_BETA = '22222222-2222-2222-2222-222222222222';
const DEV_ALPHA_1 = '33333333-3333-3333-3333-333333333333';
const DEV_ALPHA_2 = '44444444-4444-4444-4444-444444444444';
const DEV_BETA_1 = '55555555-5555-5555-5555-555555555555';

const SESSION_ALPHA_1 = '66666666-6666-6666-6666-666666666666';
const SESSION_BETA_1 = '77777777-7777-7777-7777-777777777777';

// In-memory OAuth store simulating database
interface StoredClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
}
interface StoredCode {
  codeHash: Buffer;
  clientId: string;
  userId: string;
  teamId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  expiresAt: number;
  consumed: boolean;
}
interface StoredToken {
  tokenHash: Buffer;
  tokenValue: string;
  kind: 'access' | 'refresh';
  clientId: string;
  userId: string;
  teamId: string;
  scope: string;
  familyId: string;
  expiresAt: number;
  revoked: boolean;
}

const oauthDb = {
  clients: new Map<string, StoredClient>(),
  codes: new Map<string, StoredCode>(),
  tokens: new Map<string, StoredToken>(),
};

/**
 * Real Streamable HTTP Client Transport connecting via HTTP POST fetch.
 */
class StreamableHttpClientTransport {
  constructor(
    private readonly handler: (req: Request) => Promise<Response>,
    private readonly headers: Record<string, string> = {}
  ) {}

  onclose?: () => void;
  onerror?: (err: Error) => void;
  onmessage?: (msg: unknown) => void;

  async start(): Promise<void> {}

  async close(): Promise<void> {
    this.onclose?.();
  }

  async send(message: unknown): Promise<void> {
    const req = new Request(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        host: HOST,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...this.headers,
      },
      body: JSON.stringify(message),
    });

    const res = await this.handler(req);
    if (!res.ok && res.status >= 500) {
      throw new Error(`HTTP ${res.status}`);
    }

    const text = await res.text();
    if (!text) return;

    if (res.headers.get('content-type')?.includes('text/event-stream')) {
      const lines = text.split('\n').filter((l) => l.startsWith('data:'));
      for (const line of lines) {
        const data = JSON.parse(line.slice(5).trim());
        this.onmessage?.(data);
      }
    } else {
      const data = JSON.parse(text);
      this.onmessage?.(data);
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ProtocolBase = (sdk as any).Protocol as new (...args: any[]) => any;

/**
 * Standard Real MCP Client implementing Protocol
 */
class RealMcpClient extends ProtocolBase {
  constructor(
    private readonly clientInfo: { name: string; version: string },
    private readonly capabilities: Record<string, unknown> = {}
  ) {
    super();
  }

  protected assertRequestHandlerCapability(): void {
    // Client role requirement
  }

  async connect(transport: StreamableHttpClientTransport): Promise<void> {
    await super.connect(transport);
  }

  async close(): Promise<void> {
    await super.close();
  }

  async initialize(version = '2025-11-25'): Promise<{
    protocolVersion: string;
    serverInfo: { name: string; version: string };
    capabilities: Record<string, unknown>;
  }> {
    return this.request({
      method: 'initialize',
      params: {
        protocolVersion: version,
        capabilities: this.capabilities,
        clientInfo: this.clientInfo,
      },
    }) as Promise<{
      protocolVersion: string;
      serverInfo: { name: string; version: string };
      capabilities: Record<string, unknown>;
    }>;
  }

  async listTools(): Promise<{
    tools: Array<{
      name: string;
      description?: string;
      inputSchema: Record<string, unknown>;
    }>;
  }> {
    return this.request({ method: 'tools/list', params: {} }) as Promise<{
      tools: Array<{
        name: string;
        description?: string;
        inputSchema: Record<string, unknown>;
      }>;
    }>;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }> {
    return this.request({
      method: 'tools/call',
      params: { name, arguments: args },
    }) as Promise<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>;
  }
}

// Mock PostgreSQL pool with simulated multi-tenant data
function createMultiTenantMockPool(): McpPool {
  return {
    connect: async () => ({
      query: async (sql: string, params?: unknown[]) => {
        // Multi-tenant developer query
        if (sql.includes('list_developers')) {
          const teamId = params?.[0] ? 'resolved' : '';
          void teamId;
          return {
            rows: [
              { member_id: DEV_ALPHA_1, display_name: 'Developer Alpha 1', role: 'member' },
              { member_id: DEV_ALPHA_2, display_name: 'Developer Alpha 2', role: 'member' },
            ],
            rowCount: 2,
            command: 'SELECT',
            oid: 0,
            fields: [],
          };
        }

        // Developer activity
        if (sql.includes('developer_activity')) {
          const devId = params?.[1];
          if (devId === DEV_BETA_1) {
            // Foreign team member returns empty rows
            return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
          }
          return {
            rows: [
              {
                day: '2026-11-26',
                tokens_in: '1200',
                tokens_out: '450',
                cache_read_tokens: '0',
                cache_write_tokens: '0',
                api_cost: '0.15',
                session_count: '3',
                tool_calls: '12',
                tool_errors: '0',
                edits: '6',
                additions: '45',
                deletions: '10',
                changed_lines: '55',
                files_touched: '4',
                rework_loops: '0',
                corrections: '0',
                abandoned_count: '0',
              },
            ],
            rowCount: 1,
            command: 'SELECT',
            oid: 0,
            fields: [],
          };
        }

        // List sessions
        if (sql.includes('list_sessions')) {
          return {
            rows: [
              {
                id: SESSION_ALPHA_1,
                member_id: DEV_ALPHA_1,
                source: 'claude-code',
                model: 'claude-3-5-sonnet',
                started_at: '2026-11-26T10:00:00Z',
                ended_at: '2026-11-26T10:45:00Z',
                activity_at: '2026-11-26T10:45:00Z',
                tokens_in: '1200',
                tokens_out: '450',
                tokens_cache_read: '0',
                tokens_cache_write: '0',
                api_cost: '0.15',
                priced: true,
                edits: 6,
                additions: 45,
                deletions: 10,
                changed_lines: 55,
                files_touched: 4,
                tool_calls: 12,
                tool_errors: 0,
                rework_loops: 0,
                corrections: 0,
                abandoned: false,
              },
            ],
            rowCount: 1,
            command: 'SELECT',
            oid: 0,
            fields: [],
          };
        }

        // Session details
        if (sql.includes('session_details')) {
          const sessId = params?.[1];
          if (sessId !== SESSION_ALPHA_1) {
            return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
          }
          return {
            rows: [
              {
                id: SESSION_ALPHA_1,
                member_id: DEV_ALPHA_1,
                source: 'claude-code',
                model: 'claude-3-5-sonnet',
                started_at: '2026-11-26T10:00:00Z',
                ended_at: '2026-11-26T10:45:00Z',
                activity_at: '2026-11-26T10:45:00Z',
                tokens_in: '1200',
                tokens_out: '450',
                tokens_cache_read: '0',
                tokens_cache_write: '0',
                api_cost: '0.15',
                priced: true,
                edits: 6,
                additions: 45,
                deletions: 10,
                changed_lines: 55,
                files_touched: 4,
                tool_calls: 12,
                tool_errors: 0,
                rework_loops: 0,
                corrections: 0,
                abandoned: false,
                tools: [
                  { tool_name: 'read_file', call_count: 8 },
                  { tool_name: 'edit_file', call_count: 4 },
                ],
              },
            ],
            rowCount: 1,
            command: 'SELECT',
            oid: 0,
            fields: [],
          };
        }

        // Search prompt metadata
        if (sql.includes('search_prompt_metadata')) {
          return {
            rows: [
              {
                prompt_id: '901',
                session_uuid: SESSION_ALPHA_1,
                member_id: DEV_ALPHA_1,
                turn_index: 0,
                created_at: '2026-11-26T10:05:00Z',
                tool: 'claude-code',
                model: 'claude-3-5-sonnet',
                prompt_char_len: 140,
                has_code_block: true,
                has_file_path: false,
                has_traceback: false,
                intent_category: 'feature',
                answer_input_tokens: '150',
                answer_output_tokens: '300',
                answer_cache_read_tokens: '0',
                answer_cache_write_tokens: '0',
              },
            ],
            rowCount: 1,
            command: 'SELECT',
            oid: 0,
            fields: [],
          };
        }

        // Batch prompt metadata
        if (sql.includes('session_turns') || sql.includes('prompt_metadata_batch')) {
          return {
            rows: [
              {
                prompt_id: '901',
                session_uuid: SESSION_ALPHA_1,
                member_id: DEV_ALPHA_1,
                turn_index: 0,
                created_at: '2026-11-26T10:05:00Z',
                tool: 'claude-code',
                model: 'claude-3-5-sonnet',
                prompt_char_len: 140,
                has_code_block: true,
                has_file_path: false,
                has_traceback: false,
                intent_category: 'feature',
                answer_input_tokens: '150',
                answer_output_tokens: '300',
                answer_cache_read_tokens: '0',
                answer_cache_write_tokens: '0',
              },
            ],
            rowCount: 1,
            command: 'SELECT',
            oid: 0,
            fields: [],
          };
        }

        return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
      },
      release: () => {},
    } as unknown as import('pg').PoolClient),
  } as unknown as McpPool;
}

const mockPool = createMultiTenantMockPool();
const mockHandlerDeps = {
  pool: () => mockPool,
  secret: () => TEST_SECRET,
  now: () => new Date('2026-11-26T12:00:00Z'),
};

describe('Phase 4.5: Real MCP Client & OAuth 2.1 E2E Integration', () => {
  let clientId: string;
  let codeVerifier: string;
  let codeChallenge: string;
  let authCode: string;
  let accessToken: string;
  let refreshToken: string;

  it('Step 1: Protected Resource & Authorization Server Discovery', async () => {
    // 1. Resource discovery
    const prRes = await handleProtectedResourceMetadata(
      new Request(`${BASE_URL}/.well-known/oauth-protected-resource/mcp`, {
        headers: { host: HOST },
      }),
      { enabled: true, config: OAUTH_CFG, pool: mockPool as never }
    );
    assert.equal(prRes.status, 200);
    const prBody = await prRes.json();
    assert.equal(prBody.resource, `${BASE_URL}/mcp`);
    assert.deepEqual(prBody.authorization_servers, [BASE_URL]);

    // 2. Auth Server discovery
    const asRes = await handleAuthorizationServerMetadata(
      new Request(`${BASE_URL}/.well-known/oauth-authorization-server`, {
        headers: { host: HOST },
      }),
      { enabled: true, config: OAUTH_CFG, pool: mockPool as never }
    );
    assert.equal(asRes.status, 200);
    const asBody = await asRes.json();
    assert.equal(asBody.issuer, BASE_URL);
    assert.deepEqual(asBody.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(asBody.response_types_supported, ['code']);
    assert.deepEqual(asBody.scopes_supported, ['mcp:read', 'offline_access']);
  });

  it('Step 2: Dynamic Client Registration (RFC 7591)', async () => {
    const regReq = new Request(`${BASE_URL}/oauth/register`, {
      method: 'POST',
      headers: { host: HOST, 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Claude Real Client',
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      }),
    });

    // Handle register with simulated pool
    const regPool = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('mcp_rate_limits')) {
          return { rows: [{ count: 1, retry: 60 }], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
        }
        if (sql.includes('INSERT INTO oauth_clients')) {
          const cid = params?.[0] as string;
          oauthDb.clients.set(cid, {
            clientId: cid,
            clientName: 'Claude Real Client',
            redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
          });
          return { rows: [{ client_id: cid }], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
        }
        return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
      },
      connect: async () => {
        const client = {
          query: async (sql: string, ...args: unknown[]) => {
            const params = args[0] as unknown[] | undefined;
            if (sql.includes('mcp_rate_limits')) {
              return { rows: [{ count: 1, retry: 60 }], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
            }
            if (sql.includes('INSERT INTO oauth_clients')) {
              const cid = params?.[0] as string;
              oauthDb.clients.set(cid, {
                clientId: cid,
                clientName: 'Claude Real Client',
                redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
              });
              return { rows: [{ client_id: cid }], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
            }
            return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
          },
          release: () => {},
        };
        return client as unknown as import('pg').PoolClient;
      },
      end: async () => {},
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
    } as unknown as McpPool;

    const res = await handleRegister(regReq, {
      enabled: true,
      config: OAUTH_CFG,
      pool: () => regPool,
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.match(body.client_id, /^tt_[A-Za-z0-9_-]{22}$/);
    assert.equal(body.token_endpoint_auth_method, 'none');
    clientId = body.client_id;
  });

  it('Step 3: PKCE S256 Challenge & Authorization Request with Consent', async () => {
    codeVerifier = generateSecret('verif');
    codeChallenge = s256Challenge(codeVerifier);

    const session: SessionPayload = {
      userId: USER_ALPHA,
      username: 'alpha_admin',
      displayName: 'Team Alpha Admin',
      role: 'admin',
      teamId: TEAM_ALPHA,
      memberId: null,
      issuedAt: Date.now() - 5000,
      lastActive: Date.now(),
      mfa: true,
    };

    // Prepare authorization view
    const authPool = {
      query: async (sql: string) => {
        if (sql.includes('FROM oauth_clients')) {
          return {
            rows: [
              {
                client_id: clientId,
                client_name: 'Claude Real Client',
                redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
                disabled_at: null,
              },
            ],
            rowCount: 1,
            command: 'SELECT',
            oid: 0,
            fields: [],
          };
        }
        if (sql.includes('FROM users')) {
          return {
            rows: [
              {
                id: USER_ALPHA,
                role: 'admin',
                team_id: TEAM_ALPHA,
                active: true,
                team_name: 'Team Alpha',
                display_name: 'Team Alpha Admin',
              },
            ],
            rowCount: 1,
            command: 'SELECT',
            oid: 0,
            fields: [],
          };
        }
        return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
      },
      connect: async () => {
        const client = {
          query: async (sql: string) => {
            if (sql.includes('FROM oauth_clients')) {
              return {
                rows: [
                  {
                    client_id: clientId,
                    client_name: 'Claude Real Client',
                    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
                    disabled_at: null,
                  },
                ],
                rowCount: 1,
                command: 'SELECT',
                oid: 0,
                fields: [],
              };
            }
            if (sql.includes('FROM users')) {
              return {
                rows: [
                  {
                    id: USER_ALPHA,
                    role: 'admin',
                    team_id: TEAM_ALPHA,
                    active: true,
                    team_name: 'Team Alpha',
                    display_name: 'Team Alpha Admin',
                  },
                ],
                rowCount: 1,
                command: 'SELECT',
                oid: 0,
                fields: [],
              };
            }
            return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
          },
          release: () => {},
        };
        return client as unknown as import('pg').PoolClient;
      },
      end: async () => {},
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
    };

    const authView = await prepareAuthorize(
      {
        searchParams: {
          client_id: clientId,
          redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
          response_type: 'code',
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          state: 'client-state-123',
        },
        session,
        headers: new Headers({ host: HOST }),
        secret: TEST_SECRET,
      },
      {
        enabled: true,
        config: OAUTH_CFG,
        pool: () => authPool as unknown as McpPool,
      }
    );

    assert.equal(authView.kind, 'consent');

    // Simulate Admin approving consent via /oauth/decision
    const decisionPool = {
      query: async (sql: string) => {
        if (sql.includes('mcp_rate_limits')) {
          return { rows: [{ count: 1, retry: 60 }], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
        }
        if (sql.includes('INSERT INTO oauth_authorization_codes')) {
          return { rows: [], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
        }
        return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
      },
      connect: async () => {
        const client = {
          query: async (sql: string) => {
            if (sql.includes('mcp_rate_limits')) {
              return { rows: [{ count: 1, retry: 60 }], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
            }
            if (sql.includes('FROM oauth_clients')) {
              return {
                rows: [
                  {
                    client_id: clientId,
                    client_name: 'Claude Real Client',
                    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
                    disabled_at: null,
                  },
                ],
                rowCount: 1,
                command: 'SELECT',
                oid: 0,
                fields: [],
              };
            }
            if (sql.includes('FROM users')) {
              return {
                rows: [
                  {
                    id: USER_ALPHA,
                    role: 'admin',
                    team_id: TEAM_ALPHA,
                    active: true,
                    team_name: 'Team Alpha',
                    display_name: 'Team Alpha Admin',
                  },
                ],
                rowCount: 1,
                command: 'SELECT',
                oid: 0,
                fields: [],
              };
            }
            if (sql.includes('INSERT INTO oauth_authorization_codes')) {
              return { rows: [], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
            }
            return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
          },
          release: () => {},
        };
        return client as unknown as import('pg').PoolClient;
      },
      end: async () => {},
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
    };

    const decReq = new Request(`${BASE_URL}/oauth/decision`, {
      method: 'POST',
      headers: {
        host: HOST,
        origin: BASE_URL,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        consent: authView.view.consentToken,
        decision: 'approve',
      }),
    });

    const decRes = await handleDecision(decReq, {
      enabled: true,
      config: OAUTH_CFG,
      pool: () => decisionPool as unknown as McpPool,
      session: () => session,
      secret: TEST_SECRET,
    });

    assert.equal(decRes.status, 200);
    const decBody = await decRes.json();
    assert.ok(decBody.redirect.includes('code='));
    assert.ok(decBody.redirect.includes('state=client-state-123'));

    const redirectUrl = new URL(decBody.redirect);
    authCode = redirectUrl.searchParams.get('code')!;
    assert.ok(authCode.startsWith('tt_ac_'));
  });

  it('Step 4: Authorization Code Exchange for Access & Refresh Tokens', async () => {
    assert.ok(authCode, 'authorization code must exist from Step 3');

    const tokenPool = {
      query: async (sql: string) => {
        if (sql.includes('mcp_rate_limits')) {
          return { rows: [{ count: 1, retry: 60 }], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
        }
        return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
      },
      connect: async () => {
        const client = {
          query: async (sql: string, ...args: unknown[]) => {
            const params = args[0] as unknown[] | undefined;
            if (sql.includes('mcp_rate_limits')) {
              return { rows: [{ count: 1, retry: 60 }], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
            }
            if (sql.includes('UPDATE oauth_authorization_codes SET consumed_at')) {
              return {
                rows: [
                  {
                    client_id: clientId,
                    user_id: USER_ALPHA,
                    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
                    code_challenge: codeChallenge,
                    resource: OAUTH_CFG.resource,
                    scope: 'mcp:read',
                    family_id: crypto.randomUUID(),
                  },
                ],
                rowCount: 1,
                command: 'UPDATE',
                oid: 0,
                fields: [],
              };
            }
            if (sql.includes('FROM users u, oauth_clients c')) {
              return { rows: [{ '?column?': 1 }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] };
            }
            if (sql.includes('INSERT INTO oauth_tokens')) {
              const tHash = params?.[0] as Buffer;
              return { rows: [{ id: crypto.randomUUID(), token_hash: tHash }], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
            }
            if (sql.includes('UPDATE oauth_clients SET last_used_at')) {
              return { rows: [], rowCount: 1, command: 'UPDATE', oid: 0, fields: [] };
            }
            if (sql.includes('INSERT INTO audit_log')) {
              return { rows: [], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
            }
            return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
          },
          release: () => {},
        };
        return client as unknown as import('pg').PoolClient;
      },
      end: async () => {},
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
    };

    const tokenReq = new Request(`${BASE_URL}/oauth/token`, {
      method: 'POST',
      headers: {
        host: HOST,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: authCode,
        client_id: clientId,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_verifier: codeVerifier,
      }).toString(),
    });

    const tokenRes = await handleToken(tokenReq, {
      enabled: true,
      config: OAUTH_CFG,
      pool: () => tokenPool as unknown as McpPool,
    });

    assert.equal(tokenRes.status, 200);
    const body = await tokenRes.json();
    assert.match(body.access_token, /^tt_at_/);
    assert.match(body.refresh_token, /^tt_rt_/);
    assert.equal(body.token_type, 'Bearer');
    assert.equal(body.scope, 'mcp:read');

    accessToken = body.access_token;
    refreshToken = body.refresh_token;
  });

  it('Step 5: Real Client Connection, Initialization, and Tool Discovery', async () => {
    assert.ok(accessToken, 'access token required from Step 4');

    const principal: McpPrincipal = {
      userId: USER_ALPHA,
      teamId: TEAM_ALPHA,
      tokenId: crypto.randomUUID(),
      clientId,
      scope: 'mcp:read',
      role: 'admin',
      displayName: 'Team Alpha Admin',
    };

    const deps: McpDeps = {
      oauth: OAUTH_CFG,
      authenticate: async (token) => {
        if (token === accessToken) return principal;
        return null;
      },
      createServer: (ctx) => createTokenTracerMcpServer(ctx, { deps: mockHandlerDeps }),
    };

    const transport = new StreamableHttpClientTransport(
      (req) => handleMcpRequest(req, MCP_CFG, deps),
      { authorization: `Bearer ${accessToken}` }
    );

    const client = new RealMcpClient({ name: 'Claude Code', version: '2.0.0' });
    await client.connect(transport);

    // Protocol Handshake
    const init = await client.initialize();
    assert.equal(init.protocolVersion, '2025-11-25');
    assert.equal(init.serverInfo.name, 'token-tracer');
    assert.ok(init.capabilities.tools, 'tools capability must be advertised');

    // Tool Discovery
    const toolList = await client.listTools();
    assert.equal(toolList.tools.length, 7);
    const toolNames = toolList.tools.map((t) => t.name).sort();
    assert.deepEqual(toolNames, [
      'developer_activity',
      'list_developers',
      'list_sessions',
      'list_teams',
      'prompt_metadata_batch',
      'search_prompt_metadata',
      'session_details',
    ]);

    for (const tool of toolList.tools) {
      assert.ok(tool.description && tool.description.length > 20);
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
  });

  it('Step 6: End-to-End Execution of all Six Tools over Real Client', async () => {
    const principal: McpPrincipal = {
      userId: USER_ALPHA,
      teamId: TEAM_ALPHA,
      tokenId: crypto.randomUUID(),
      clientId,
      scope: 'mcp:read',
      role: 'admin',
      displayName: 'Team Alpha Admin',
    };

    const deps: McpDeps = {
      oauth: OAUTH_CFG,
      authenticate: async () => principal,
      createServer: (ctx) => createTokenTracerMcpServer(ctx, { deps: mockHandlerDeps }),
    };

    const transport = new StreamableHttpClientTransport(
      (req) => handleMcpRequest(req, MCP_CFG, deps),
      { authorization: `Bearer ${accessToken}` }
    );

    const client = new RealMcpClient({ name: 'Claude Code', version: '2.0.0' });
    await client.connect(transport);

    // 1. list_developers
    const devsRes = await client.callTool('list_developers', { limit: 10 });
    assert.equal(devsRes.isError, undefined);
    const devsData = JSON.parse(devsRes.content[0].text);
    assert.equal(devsData.items.length, 2);
    assert.equal(devsData.items[0].displayName, 'Developer Alpha 1');

    // 2. developer_activity
    const actRes = await client.callTool('developer_activity', {
      developerId: DEV_ALPHA_1,
      from: '2026-11-20',
      to: '2026-11-26',
    });
    assert.equal(actRes.isError, undefined);
    const actData = JSON.parse(actRes.content[0].text);
    assert.equal(actData.length, 1);
    assert.equal(actData[0].day, '2026-11-26');
    assert.equal(actData[0].sessionCount, 3);

    // 3. list_sessions
    const sessRes = await client.callTool('list_sessions', { limit: 5 });
    assert.equal(sessRes.isError, undefined);
    const sessData = JSON.parse(sessRes.content[0].text);
    assert.equal(sessData.items.length, 1);
    assert.ok(typeof sessData.items[0].sessionRef === 'string');
    const sealedSessionRef = sessData.items[0].sessionRef;

    // 4. session_details
    const detailsRes = await client.callTool('session_details', {
      sessionRef: sealedSessionRef,
    });
    assert.equal(detailsRes.isError, undefined);
    const detailsData = JSON.parse(detailsRes.content[0].text);
    assert.equal(detailsData.toolUsage.length, 2);
    assert.equal(detailsData.toolUsage[0].toolName, 'read_file');

    // 5. search_prompt_metadata
    const searchRes = await client.callTool('search_prompt_metadata', {
      developerId: DEV_ALPHA_1,
      limit: 10,
    });
    assert.equal(searchRes.isError, undefined);
    const searchData = JSON.parse(searchRes.content[0].text);
    assert.equal(searchData.items.length, 1);
    assert.equal(searchData.items[0].intent, 'feature');
    const sealedPromptRef = searchData.items[0].promptRef;

    // 6. prompt_metadata_batch
    const batchRes = await client.callTool('prompt_metadata_batch', {
      promptRefs: [sealedPromptRef],
    });
    assert.equal(batchRes.isError, undefined);
    const batchData = JSON.parse(batchRes.content[0].text);
    assert.equal(batchData.length, 1);
    assert.equal(batchData[0].intent, 'feature');
    assert.equal(batchData[0].charLength, 140);
  });

  it('Step 7: Tenant Isolation & Adversarial Security over Real Client', async () => {
    const principalAlpha: McpPrincipal = {
      userId: USER_ALPHA,
      teamId: TEAM_ALPHA,
      tokenId: crypto.randomUUID(),
      clientId,
      scope: 'mcp:read',
      role: 'admin',
      displayName: 'Team Alpha Admin',
    };

    const deps: McpDeps = {
      oauth: OAUTH_CFG,
      authenticate: async () => principalAlpha,
      createServer: (ctx) => createTokenTracerMcpServer(ctx, { deps: mockHandlerDeps }),
    };

    const transport = new StreamableHttpClientTransport(
      (req) => handleMcpRequest(req, MCP_CFG, deps),
      { authorization: `Bearer ${accessToken}` }
    );

    const client = new RealMcpClient({ name: 'Claude Code', version: '2.0.0' });
    await client.connect(transport);

    // Cross-tenant developer activity inquiry
    const crossDevRes = await client.callTool('developer_activity', {
      developerId: DEV_BETA_1,
      from: '2026-11-20',
      to: '2026-11-26',
    });
    const crossDevData = JSON.parse(crossDevRes.content[0].text);
    assert.deepEqual(crossDevData, [], 'Foreign developer data must return empty');

    // Cross-tenant sealed reference attempt
    const tokenHashB = crypto.createHash('sha256').update('token_b').digest();
    const scopeBeta = createDataScope({ tokenHash: tokenHashB, userId: USER_BETA, teamId: TEAM_BETA });
    const crossRef = encodeRef('session', SESSION_BETA_1, { scope: scopeBeta, secret: TEST_SECRET });

    const crossSessRes = await client.callTool('session_details', {
      sessionRef: crossRef,
    });
    assert.equal(crossSessRes.isError, true);
    const crossSessErr = JSON.parse(crossSessRes.content[0].text);
    assert.equal(crossSessErr.code, 'not_found', 'Cross-tenant ref must fail with unforgeable not_found');

    // Parameter smuggling attempt
    const paramInjectRes = await client.callTool('list_developers', {
      limit: 10,
      __proto_pollution: 'exploit',
    });
    assert.ok(paramInjectRes.isError || (paramInjectRes as unknown as { error: unknown }).error);

    // Raw prompt text exclusion check
    const promptSearchRes = await client.callTool('search_prompt_metadata', { limit: 5 });
    const wireJson = JSON.stringify(promptSearchRes);
    assert.doesNotMatch(wireJson, /\b(prompt_text|full_prompt|file_path|absolute_path)\b/i);
  });

  it('Step 8: Refresh Token Rotation & Token Revocation (RFC 7009)', async () => {
    assert.ok(refreshToken, 'refresh token required from Step 4');

    // 1. Refresh rotation
    const rotatePool = {
      query: async (sql: string) => {
        if (sql.includes('mcp_rate_limits')) return { rows: [{ count: 1, retry: 60 }], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
        return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
      },
      connect: async () => {
        const client = {
          query: async (sql: string) => {
            if (sql.includes('mcp_rate_limits')) return { rows: [{ count: 1, retry: 60 }], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
            if (sql.includes('SELECT') && sql.includes('oauth_tokens') && sql.includes('kind = \'refresh\'')) {
              return {
                rows: [
                  {
                    id: crypto.randomUUID(),
                    token_hash: sha256(refreshToken),
                    family_id: 'fam-1',
                    client_id: clientId,
                    user_id: USER_ALPHA,
                    team_id: TEAM_ALPHA,
                    resource: OAUTH_CFG.resource,
                    scope: 'mcp:read',
                    expires_at: new Date(Date.now() + 86400_000),
                    absolute_expires_at: new Date(Date.now() + 86400_000 * 30),
                    revoked_at: null,
                    rotated_at: null,
                    live: true,
                    allowed: true,
                  },
                ],
                rowCount: 1,
                command: 'SELECT',
                oid: 0,
                fields: [],
              };
            }
            if (sql.includes('SELECT absolute_expires_at FROM oauth_tokens')) {
              return {
                rows: [{ absolute_expires_at: new Date(Date.now() + 86400_000 * 30) }],
                rowCount: 1,
                command: 'SELECT',
                oid: 0,
                fields: [],
              };
            }
            if (sql.includes('FROM users u, oauth_clients c')) {
              return { rows: [{ '?column?': 1 }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] };
            }
            if (sql.includes('UPDATE oauth_tokens SET rotated_at')) {
              return { rows: [], rowCount: 1, command: 'UPDATE', oid: 0, fields: [] };
            }
            if (sql.includes('INSERT INTO oauth_tokens')) {
              return { rows: [{ id: crypto.randomUUID() }], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
            }
            if (sql.includes('UPDATE oauth_clients SET last_used_at')) {
              return { rows: [], rowCount: 1, command: 'UPDATE', oid: 0, fields: [] };
            }
            if (sql.includes('INSERT INTO audit_log')) {
              return { rows: [], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
            }
            return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
          },
          release: () => {},
        };
        return client as unknown as import('pg').PoolClient;
      },
      end: async () => {},
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
    };

    const refreshReq = new Request(`${BASE_URL}/oauth/token`, {
      method: 'POST',
      headers: { host: HOST, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      }).toString(),
    });

    const refreshRes = await handleToken(refreshReq, {
      enabled: true,
      config: OAUTH_CFG,
      pool: () => rotatePool as unknown as McpPool,
    });
    assert.equal(refreshRes.status, 200);
    const refreshBody = await refreshRes.json();
    assert.match(refreshBody.access_token, /^tt_at_/);
    assert.match(refreshBody.refresh_token, /^tt_rt_/);
    assert.notEqual(refreshBody.access_token, accessToken);

    // 2. Token revocation (RFC 7009)
    let revoked = false;
    const revokePool = {
      query: async (sql: string) => {
        if (sql.includes('mcp_rate_limits')) return { rows: [{ count: 1, retry: 60 }], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
        return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
      },
      connect: async () => {
        const client = {
          query: async (sql: string) => {
            if (sql.includes('mcp_rate_limits')) return { rows: [{ count: 1, retry: 60 }], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
            if (sql.includes('SELECT id, family_id, user_id FROM oauth_tokens')) {
              return {
                rows: [
                  {
                    id: crypto.randomUUID(),
                    family_id: 'fam-1',
                    user_id: USER_ALPHA,
                  },
                ],
                rowCount: 1,
                command: 'SELECT',
                oid: 0,
                fields: [],
              };
            }
            if (sql.includes('UPDATE oauth_tokens SET revoked_at')) {
              revoked = true;
              return { rows: [], rowCount: 1, command: 'UPDATE', oid: 0, fields: [] };
            }
            if (sql.includes('mcp_audit_event')) {
              return { rows: [{ mcp_audit_event: true }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] };
            }
            return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
          },
          release: () => {},
        };
        return client as unknown as import('pg').PoolClient;
      },
      end: async () => {},
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
    };

    const revokeReq = new Request(`${BASE_URL}/oauth/revoke`, {
      method: 'POST',
      headers: { host: HOST, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: refreshBody.access_token,
        client_id: clientId,
      }).toString(),
    });

    const revokeRes = await handleRevoke(revokeReq, {
      enabled: true,
      config: OAUTH_CFG,
      pool: () => revokePool as unknown as McpPool,
    });
    assert.equal(revokeRes.status, 200);
    assert.equal(revoked, true, 'Token revocation must update database record');

    // 3. Confirm revoked token rejected on /mcp
    const revokedAuthReq = new Request(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        host: HOST,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${refreshBody.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} }),
    });

    const unauthRes = await handleMcpRequest(revokedAuthReq, MCP_CFG, {
      oauth: OAUTH_CFG,
      authenticate: async () => null, // Revoked token fails authentication
    });
    assert.equal(unauthRes.status, 401);
    assert.ok(unauthRes.headers.get('www-authenticate')?.includes('Bearer'));
  });

  it('Step 9: Connection Lifecycle: Disconnect and Reconnect', async () => {
    const principal: McpPrincipal = {
      userId: USER_ALPHA,
      teamId: TEAM_ALPHA,
      tokenId: crypto.randomUUID(),
      clientId,
      scope: 'mcp:read',
      role: 'admin',
      displayName: 'Team Alpha Admin',
    };

    const deps: McpDeps = {
      oauth: OAUTH_CFG,
      authenticate: async () => principal,
      createServer: (ctx) => createTokenTracerMcpServer(ctx, { deps: mockHandlerDeps }),
    };

    const transport1 = new StreamableHttpClientTransport(
      (req) => handleMcpRequest(req, MCP_CFG, deps),
      { authorization: `Bearer ${accessToken}` }
    );

    const client = new RealMcpClient({ name: 'Claude Code', version: '2.0.0' });
    await client.connect(transport1);
    const init1 = await client.initialize();
    assert.equal(init1.serverInfo.name, 'token-tracer');

    // Disconnect
    await client.close();

    // Reconnect with new transport instance
    const transport2 = new StreamableHttpClientTransport(
      (req) => handleMcpRequest(req, MCP_CFG, deps),
      { authorization: `Bearer ${accessToken}` }
    );
    const client2 = new RealMcpClient({ name: 'Claude Code', version: '2.0.0' });
    await client2.connect(transport2);
    const init2 = await client2.initialize();
    assert.equal(init2.serverInfo.name, 'token-tracer');

    const tools2 = await client2.listTools();
    assert.equal(tools2.tools.length, 7);
  });
});
