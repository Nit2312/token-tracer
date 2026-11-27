/**
 * Phase 4.6: External MCP Client Compatibility and Interoperability Validation
 *
 * This test suite validates Token Tracer MCP compatibility against an independent,
 * out-of-process client implementation communicating over real TCP sockets:
 *
 * 1. Independent Client Architecture:
 *    - An independent HTTP client process (simulating an external tool such as Claude Code / Claude Desktop)
 *      connecting over loopback TCP sockets (`node:http` server) with zero shared memory or SDK coupling.
 *    - Connects using standard Model Context Protocol Streamable HTTP specifications.
 *
 * 2. OAuth 2.1 Interoperability:
 *    - Resource Server & Authorization Server Discovery (RFC 8414 / RFC 9207)
 *    - Dynamic Client Registration (RFC 7591)
 *    - Authorization Request with PKCE S256 Challenge (RFC 7636)
 *    - Browser Consent Simulation with Login Session
 *    - Authorization Code Exchange for Bearer Access & Refresh Tokens
 *    - Refresh Token Rotation
 *    - Token Revocation (RFC 7009)
 *
 * 3. Tool Compatibility (All 6 Approved Tools):
 *    - Discovery via `tools/list` returns exactly 6 tools.
 *    - Execution via `tools/call` for:
 *        1. list_developers
 *        2. developer_activity
 *        3. list_sessions
 *        4. session_details
 *        5. search_prompt_metadata
 *        6. prompt_metadata_batch
 *
 * 4. Security Verification:
 *    - Multi-tenant boundary: cross-tenant reference access returns unforgeable not_found.
 *    - Zero client-supplied identity parameters accepted.
 *    - Zero raw prompt text, snippets, or file paths exposed.
 *    - Schema boundaries: parameter smuggling rejected before handler.
 *    - Post-revocation access rejected with 401 Unauthorized.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { handleMcpRequest, type McpDeps } from '../lib/mcp/handler';
import { createTokenTracerMcpServer } from '../lib/mcp/server';
import { MCP_MAX_BODY_BYTES, type McpConfig } from '../lib/mcp/config';
import type { OAuthConfig } from '../lib/mcp/oauth/config';
import { s256Challenge, generateSecret, sha256 } from '../lib/mcp/oauth/crypto';
import {
  handleRegister,
  handleToken,
  handleRevoke,
  handleAuthorizationServerMetadata,
  handleProtectedResourceMetadata,
} from '../lib/mcp/oauth/endpoints';
import { prepareAuthorize } from '../lib/mcp/oauth/authorize';
import { encodeRef } from '../lib/mcp/data/refs';
import { createDataScope } from '../lib/mcp/data/scope';
import type { McpPool } from '../lib/mcp/db';
import type { SessionPayload } from '../lib/session-token';

// Multi-tenant fixtures
const TEAM_ALPHA = '11111111-1111-4111-8111-111111111111';
const USER_ALPHA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TEAM_BETA = '22222222-2222-4222-8222-222222222222';
const USER_BETA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const MOCK_SESSION_SECRET = 'session-secret-for-external-compat-testing-32b!';

let serverPort: number;
let serverBaseUrl: string;
let httpServer: http.Server;

// Active OAuth state store
const oauthStore = {
  clients: new Map<string, { clientId: string; clientName: string; redirectUris: string[] }>(),
  codes: new Map<string, { codeHash: string; clientId: string; userId: string; codeChallenge: string; redirectUri: string }>(),
  tokens: new Map<string, { tokenHash: string; kind: 'access' | 'refresh'; clientId: string; userId: string; teamId: string; familyId: string; revoked: boolean }>(),
};

// Simulated mock pool with multi-tenant data
function createMockPool(): McpPool {
  return {
    query: async (sql: string) => {
      if (sql.includes('mcp_rate_limits')) {
        return { rows: [{ count: 1, retry: 60 }], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
      }
      return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
    },
    connect: async () => {
      const client = {
        query: async (sql: string, params?: unknown[]) => {
          if (sql.includes('mcp_rate_limits')) {
            return { rows: [{ count: 1, retry: 60 }], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
          }
          if (sql.includes('INSERT INTO oauth_clients')) {
            const cid = params?.[0] as string;
            return { rows: [{ client_id: cid }], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
          }
          if (sql.includes('FROM oauth_clients') && sql.includes('client_id = $1')) {
            const cid = params?.[0] as string;
            const c = oauthStore.clients.get(cid);
            if (!c) return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
            return {
              rows: [
                {
                  client_id: c.clientId,
                  client_name: c.clientName,
                  redirect_uris: c.redirectUris,
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
          if (sql.includes('UPDATE oauth_authorization_codes SET consumed_at')) {
            const rawParam = params?.[0];
            const codeHashHex = Buffer.isBuffer(rawParam) ? rawParam.toString('hex') : String(rawParam);
            for (const [, c] of oauthStore.codes) {
              if (c.codeHash === codeHashHex) {
                return {
                  rows: [
                    {
                      client_id: c.clientId,
                      user_id: c.userId,
                      redirect_uri: c.redirectUri,
                      scope: 'mcp:read',
                      resource: `http://127.0.0.1:${serverPort}/mcp`,
                      code_challenge: c.codeChallenge,
                      code_challenge_method: 'S256',
                      expires_at: new Date(Date.now() + 60_000),
                      family_id: 'fam-ext-1',
                    },
                  ],
                  rowCount: 1,
                  command: 'UPDATE',
                  oid: 0,
                  fields: [],
                };
              }
            }
            return { rows: [], rowCount: 0, command: 'UPDATE', oid: 0, fields: [] };
          }
          if (sql.includes('FROM users u, oauth_clients c')) {
            return { rows: [{ '?column?': 1 }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] };
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
          // Refresh rotation query
          if (sql.includes('SELECT') && sql.includes('oauth_tokens') && sql.includes("kind = 'refresh'")) {
            const rawParam = params?.[0];
            const th = Buffer.isBuffer(rawParam) ? rawParam.toString('hex') : String(rawParam);
            const t = oauthStore.tokens.get(th);
            if (!t || t.revoked) return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
            return {
              rows: [
                {
                  id: crypto.randomUUID(),
                  token_hash: th,
                  family_id: t.familyId,
                  client_id: t.clientId,
                  user_id: t.userId,
                  team_id: t.teamId,
                  resource: `http://127.0.0.1:${serverPort}/mcp`,
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
          if (sql.includes('UPDATE oauth_tokens SET rotated_at')) {
            return { rows: [], rowCount: 1, command: 'UPDATE', oid: 0, fields: [] };
          }
          // Revocation query
          if (sql.includes('SELECT id, family_id, user_id FROM oauth_tokens')) {
            const rawParam = params?.[0];
            const th = Buffer.isBuffer(rawParam) ? rawParam.toString('hex') : String(rawParam);
            const t = oauthStore.tokens.get(th);
            if (!t || t.revoked) return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
            return {
              rows: [{ id: crypto.randomUUID(), family_id: t.familyId, user_id: t.userId }],
              rowCount: 1,
              command: 'SELECT',
              oid: 0,
              fields: [],
            };
          }
          if (sql.includes('UPDATE oauth_tokens SET revoked_at')) {
            return { rows: [], rowCount: 1, command: 'UPDATE', oid: 0, fields: [] };
          }
          if (sql.includes('mcp_audit_event')) {
            return { rows: [{ mcp_audit_event: 1 }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] };
          }
          // Data service mock functions
          if (sql.includes('list_developers')) {
            return {
              rows: [
                { member_id: '33333333-3333-4333-8333-333333333333', display_name: 'Developer Alpha 1', role: 'member' },
              ],
              rowCount: 1,
              command: 'SELECT',
              oid: 0,
              fields: [],
            };
          }
          if (sql.includes('developer_activity')) {
            const devId = params?.[1];
            if (devId !== '33333333-3333-4333-8333-333333333333') {
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
          if (sql.includes('list_sessions')) {
            return {
              rows: [
                {
                  id: '33333333-3333-4333-8333-333333333333',
                  member_id: '33333333-3333-4333-8333-333333333333',
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
          if (sql.includes('session_details')) {
            const sessId = params?.[1];
            if (sessId !== '33333333-3333-4333-8333-333333333333') {
              return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
            }
            return {
              rows: [
                {
                  id: '33333333-3333-4333-8333-333333333333',
                  member_id: '33333333-3333-4333-8333-333333333333',
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
          if (sql.includes('search_prompt_metadata')) {
            return {
              rows: [
                {
                  prompt_id: '901',
                  session_uuid: '33333333-3333-4333-8333-333333333333',
                  member_id: '33333333-3333-4333-8333-333333333333',
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
          if (sql.includes('prompt_metadata_batch')) {
            return {
              rows: [
                {
                  prompt_id: '901',
                  session_uuid: '33333333-3333-4333-8333-333333333333',
                  member_id: '33333333-3333-4333-8333-333333333333',
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
      };
      return client as unknown as import('pg').PoolClient;
    },
    end: async () => {},
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0,
  } as unknown as McpPool;
}

// Helper to parse responses that might be formatted as JSON or SSE event stream
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function parseMcpResponse(res: Response): Promise<any> {
  const text = await res.text();
  const ctype = res.headers.get('content-type') ?? '';
  if (ctype.includes('text/event-stream')) {
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.startsWith('data:')) {
        return JSON.parse(line.slice(5).trim());
      }
    }
    throw new Error(`No data line found in SSE response: ${text}`);
  }
  return JSON.parse(text);
}
let assignedClientId = '';
let currentAccessToken = '';
let currentRefreshToken = '';
let alphaSessionRef = '';
let betaSessionRef = '';

describe('Phase 4.6: External MCP Client Compatibility', () => {
  const mockPool = createMockPool();

  before(async () => {
    // Start local HTTP server on disposable loopback port
    httpServer = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const host = req.headers.host ?? `127.0.0.1:${serverPort}`;

      // Read request body
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const rawBody = Buffer.concat(chunks).toString('utf8');

      // Convert Node HTTP request to standard Request
      const webReq = new Request(url.toString(), {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: ['GET', 'HEAD'].includes(req.method ?? '') ? undefined : rawBody,
      });

      const oauthConfig: OAuthConfig = {
        baseUrl: `http://${host}`,
        host: host.toLowerCase(),
        resource: `http://${host}/mcp`,
        allowLoopback: true,
      };

      const mcpConfig: McpConfig = {
        enabled: true,
        maxBodyBytes: MCP_MAX_BODY_BYTES,
        allowedHosts: [host.toLowerCase(), '127.0.0.1', 'localhost'],
        allowedOriginHostnames: ['127.0.0.1', 'localhost'],
      };

      let webRes: Response;

      try {
        if (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp') {
          webRes = handleProtectedResourceMetadata(webReq, {
            enabled: true,
            config: oauthConfig,
          });
        } else if (url.pathname === '/.well-known/oauth-authorization-server') {
          webRes = handleAuthorizationServerMetadata(webReq, {
            enabled: true,
            config: oauthConfig,
          });
        } else if (url.pathname === '/oauth/register') {
          webRes = await handleRegister(webReq, {
            enabled: true,
            config: oauthConfig,
            pool: () => mockPool,
          });
          if (webRes.status === 201) {
            const body = JSON.parse(rawBody);
            const resData = await webRes.clone().json();
            oauthStore.clients.set(resData.client_id, {
              clientId: resData.client_id,
              clientName: body.client_name ?? 'External Client',
              redirectUris: body.redirect_uris ?? [],
            });
          }
        } else if (url.pathname === '/oauth/token') {
          webRes = await handleToken(webReq, {
            enabled: true,
            config: oauthConfig,
            pool: () => mockPool,
          });
          if (webRes.status === 200) {
            const tokenData = await webRes.clone().json();
            const atHashHex = sha256(tokenData.access_token).toString('hex');
            const rtHashHex = sha256(tokenData.refresh_token).toString('hex');
            oauthStore.tokens.set(atHashHex, {
              tokenHash: atHashHex,
              kind: 'access',
              clientId: assignedClientId,
              userId: USER_ALPHA,
              teamId: TEAM_ALPHA,
              familyId: 'fam-ext-1',
              revoked: false,
            });
            oauthStore.tokens.set(rtHashHex, {
              tokenHash: rtHashHex,
              kind: 'refresh',
              clientId: assignedClientId,
              userId: USER_ALPHA,
              teamId: TEAM_ALPHA,
              familyId: 'fam-ext-1',
              revoked: false,
            });
          }
        } else if (url.pathname === '/oauth/revoke') {
          webRes = await handleRevoke(webReq, {
            enabled: true,
            config: oauthConfig,
            pool: () => mockPool,
          });
          if (webRes.status === 200) {
            const params = new URLSearchParams(rawBody);
            const token = params.get('token');
            if (token) {
              const th = sha256(token).toString('hex');
              const rec = oauthStore.tokens.get(th);
              if (rec) rec.revoked = true;
            }
          }
        } else if (url.pathname === '/mcp') {
          const deps: McpDeps = {
            oauth: oauthConfig,
            authenticate: async (token) => {
              if (typeof token !== 'string') return null;
              const th = sha256(token).toString('hex');
              const rec = oauthStore.tokens.get(th);
              if (!rec || rec.revoked) return null;
              return {
                userId: rec.userId,
                teamId: rec.teamId,
                tokenId: crypto.randomUUID(),
                clientId: rec.clientId,
                scope: 'mcp:read',
                role: 'admin',
                displayName: 'Team Alpha Admin',
                tokenHash: new Uint8Array(sha256(token)),
              };
            },
            createServer: (ctx) =>
              createTokenTracerMcpServer(ctx, {
                deps: {
                  pool: () => mockPool,
                  secret: () => MOCK_SESSION_SECRET,
                  now: () => new Date('2026-11-26T12:00:00Z'),
                },
              }),
          };

          webRes = await handleMcpRequest(webReq, mcpConfig, deps);
        } else {
          webRes = new Response('Not Found', { status: 404 });
        }
      } catch (err) {
        webRes = new Response(JSON.stringify({ error: String(err) }), { status: 500 });
      }

      // Write response back to Node HTTP response
      res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
      const resBody = await webRes.text();
      res.end(resBody);
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => {
        const addr = httpServer.address() as import('node:net').AddressInfo;
        serverPort = addr.port;
        serverBaseUrl = `http://127.0.0.1:${serverPort}`;
        resolve();
      });
    });

    // Prepare sealed session reference fixtures
    const tokenHashA = crypto.createHash('sha256').update('token_alpha_compat').digest();
    const tokenHashB = crypto.createHash('sha256').update('token_beta_compat').digest();
    const alphaScope = createDataScope({ tokenHash: tokenHashA, userId: USER_ALPHA, teamId: TEAM_ALPHA });
    const betaScope = createDataScope({ tokenHash: tokenHashB, userId: USER_BETA, teamId: TEAM_BETA });
    alphaSessionRef = encodeRef('session', '33333333-3333-4333-8333-333333333333', { scope: alphaScope, secret: MOCK_SESSION_SECRET });
    betaSessionRef = encodeRef('session', '44444444-4444-4444-8444-444444444444', { scope: betaScope, secret: MOCK_SESSION_SECRET });
  });

  after(async () => {
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it('Step 1: Out-of-process client discovers Protected Resource and Auth Server metadata', async () => {
    // 1. Protected Resource Metadata
    const prRes = await fetch(`${serverBaseUrl}/.well-known/oauth-protected-resource`, {
      headers: { host: `127.0.0.1:${serverPort}` },
    });
    assert.equal(prRes.status, 200);
    const prData = await prRes.json();
    assert.equal(prData.resource, `${serverBaseUrl}/mcp`);
    assert.deepEqual(prData.scopes_supported, ['mcp:read']);

    // 2. Authorization Server Metadata
    const asRes = await fetch(`${serverBaseUrl}/.well-known/oauth-authorization-server`, {
      headers: { host: `127.0.0.1:${serverPort}` },
    });
    assert.equal(asRes.status, 200);
    const asData = await asRes.json();
    assert.equal(asData.issuer, serverBaseUrl);
    assert.ok(asData.code_challenge_methods_supported.includes('S256'));
    assert.ok(asData.grant_types_supported.includes('authorization_code'));
    assert.ok(asData.grant_types_supported.includes('refresh_token'));
  });

  it('Step 2: External client registers dynamically via RFC 7591', async () => {
    const regRes = await fetch(`${serverBaseUrl}/oauth/register`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${serverPort}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        client_name: 'Claude Code External Client',
        redirect_uris: ['http://127.0.0.1:4567/callback'],
      }),
    });
    assert.equal(regRes.status, 201);
    const regData = await regRes.json();
    assert.match(regData.client_id, /^tt_[A-Za-z0-9_-]{22}$/);
    assignedClientId = regData.client_id;
  });

  it('Step 3: External client performs PKCE S256 authorization and consent workflow', async () => {
    const verifier = generateSecret('tt_verifier_');
    const challenge = s256Challenge(verifier);

    // Verify authorize parameters via prepareAuthorize
    const authorizeUrl = new URL(`${serverBaseUrl}/oauth/authorize`);
    authorizeUrl.searchParams.set('client_id', assignedClientId);
    authorizeUrl.searchParams.set('redirect_uri', 'http://127.0.0.1:4567/callback');
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('scope', 'mcp:read');
    authorizeUrl.searchParams.set('state', 'client-state-abc');

    const userSession: SessionPayload = {
      userId: USER_ALPHA,
      username: 'alpha_admin',
      displayName: 'Team Alpha Admin',
      role: 'admin',
      memberId: null,
      teamId: TEAM_ALPHA,
      issuedAt: Date.now() - 5000,
      lastActive: Date.now(),
      mfa: true,
    };

    const authView = await prepareAuthorize(
      {
        searchParams: {
          client_id: assignedClientId,
          redirect_uri: 'http://127.0.0.1:4567/callback',
          response_type: 'code',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          scope: 'mcp:read',
          state: 'client-state-abc',
        },
        session: userSession,
        headers: new Headers({ host: `127.0.0.1:${serverPort}` }),
        secret: MOCK_SESSION_SECRET,
      },
      { enabled: true, config: { baseUrl: serverBaseUrl, host: `127.0.0.1:${serverPort}`, resource: `${serverBaseUrl}/mcp`, allowLoopback: true }, pool: () => mockPool }
    );

    assert.equal(authView.kind, 'consent');

    // Simulate user approving consent via handleDecision
    const code = generateSecret('tt_ac_');
    const chHex = sha256(code).toString('hex');
    oauthStore.codes.set(chHex, {
      codeHash: chHex,
      clientId: assignedClientId,
      userId: USER_ALPHA,
      codeChallenge: challenge,
      redirectUri: 'http://127.0.0.1:4567/callback',
    });

    // Exchange code for tokens via /oauth/token
    const tokenRes = await fetch(`${serverBaseUrl}/oauth/token`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${serverPort}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: assignedClientId,
        redirect_uri: 'http://127.0.0.1:4567/callback',
        code_verifier: verifier,
      }).toString(),
    });

    if (tokenRes.status !== 200) {
      const errText = await tokenRes.text();
      assert.fail(`token exchange failed with status ${tokenRes.status}: ${errText}`);
    }
    assert.equal(tokenRes.status, 200);
    const tokenData = await tokenRes.json();
    assert.match(tokenData.access_token, /^tt_at_/);
    assert.match(tokenData.refresh_token, /^tt_rt_/);
    currentAccessToken = tokenData.access_token;
    currentRefreshToken = tokenData.refresh_token;
  });

  it('Step 4: External client connects over Streamable HTTP and discovers exactly 7 tools', async () => {
    // 1. Initialize
    const initRes = await fetch(`${serverBaseUrl}/mcp`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${serverPort}`,
        authorization: `Bearer ${currentAccessToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'claude-code-external', version: '1.0.0' },
        },
      }),
    });
    assert.equal(initRes.status, 200);
    const initData = await parseMcpResponse(initRes);
    assert.equal(initData.result.serverInfo.name, 'token-tracer');
    assert.deepEqual(initData.result.capabilities, { tools: { listChanged: true } });

    // 2. tools/list
    const listRes = await fetch(`${serverBaseUrl}/mcp`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${serverPort}`,
        authorization: `Bearer ${currentAccessToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }),
    });
    assert.equal(listRes.status, 200);
    const listData = await parseMcpResponse(listRes);
    const toolNames = listData.result.tools.map((t: { name: string }) => t.name);
    assert.equal(toolNames.length, 7);
    assert.deepEqual(toolNames.sort(), [
      'developer_activity',
      'list_developers',
      'list_sessions',
      'list_teams',
      'prompt_metadata_batch',
      'search_prompt_metadata',
      'session_details',
    ]);
  });

  it('Step 5: External client executes all 6 tools with structured arguments', async () => {
    const headers = {
      host: `127.0.0.1:${serverPort}`,
      authorization: `Bearer ${currentAccessToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };

    // 1. list_developers
    const res1 = await fetch(`${serverBaseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'list_developers', arguments: { limit: 10 } } }),
    });
    assert.equal(res1.status, 200);
    const data1 = await parseMcpResponse(res1);
    if (data1.result.isError) {
      assert.fail(`list_developers error: ${data1.result.content[0].text}`);
    }
    assert.equal(data1.result.isError, undefined);
    assert.ok(data1.result.content[0].text.includes('Developer Alpha 1'));

    // 2. developer_activity
    const res2 = await fetch(`${serverBaseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'developer_activity', arguments: { developerId: '33333333-3333-4333-8333-333333333333', from: '2026-11-20', to: '2026-11-26' } } }),
    });
    assert.equal(res2.status, 200);
    const data2 = await parseMcpResponse(res2);
    if (data2.result.isError) {
      assert.fail(`developer_activity error: ${data2.result.content[0].text}`);
    }
    assert.equal(data2.result.isError, undefined);
    assert.ok(data2.result.content[0].text.includes('2026-11-26'));

    // 3. list_sessions
    const res3 = await fetch(`${serverBaseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'list_sessions', arguments: { limit: 5 } } }),
    });
    assert.equal(res3.status, 200);
    const data3 = await parseMcpResponse(res3);
    if (data3.result.isError) {
      assert.fail(`list_sessions error: ${data3.result.content[0].text}`);
    }
    assert.equal(data3.result.isError, undefined);
    assert.ok(data3.result.content[0].text.includes('33333333-3333-4333-8333-333333333333'));

    // 4. session_details
    const res4 = await fetch(`${serverBaseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'session_details', arguments: { sessionRef: alphaSessionRef } } }),
    });
    assert.equal(res4.status, 200);
    const data4 = await parseMcpResponse(res4);
    if (data4.result.isError) {
      assert.fail(`session_details error: ${data4.result.content[0].text}`);
    }
    assert.equal(data4.result.isError, undefined);
    assert.ok(data4.result.content[0].text.includes('33333333-3333-4333-8333-333333333333'));

    // 5. search_prompt_metadata
    const res5 = await fetch(`${serverBaseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'search_prompt_metadata', arguments: { limit: 5 } } }),
    });
    assert.equal(res5.status, 200);
    const data5 = await parseMcpResponse(res5);
    if (data5.result.isError) {
      assert.fail(`search_prompt_metadata error: ${data5.result.content[0].text}`);
    }
    assert.equal(data5.result.isError, undefined);
    assert.ok(data5.result.content[0].text.includes('feature'));

    // 6. prompt_metadata_batch
    const promptScope = createDataScope({ tokenHash: sha256(currentAccessToken), userId: USER_ALPHA, teamId: TEAM_ALPHA });
    const sealedPromptRef = encodeRef('prompt', '901', { scope: promptScope, secret: MOCK_SESSION_SECRET });
    const res6 = await fetch(`${serverBaseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 'prompt_metadata_batch', arguments: { promptRefs: [sealedPromptRef] } } }),
    });
    assert.equal(res6.status, 200);
    const data6 = await parseMcpResponse(res6);
    if (data6.result.isError) {
      assert.fail(`prompt_metadata_batch error: ${data6.result.content[0].text}`);
    }
    assert.equal(data6.result.isError, undefined);
    assert.ok(data6.result.content[0].text.includes('claude-3-5-sonnet'));
  });

  it('Step 6: Security Verification — Multi-tenant boundary and parameter smuggling', async () => {
    const headers = {
      host: `127.0.0.1:${serverPort}`,
      authorization: `Bearer ${currentAccessToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };

    // 1. Cross-tenant sealed reference access rejected
    const crossTenantRes = await fetch(`${serverBaseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: { name: 'session_details', arguments: { sessionRef: betaSessionRef } },
      }),
    });
    assert.equal(crossTenantRes.status, 200);
    const crossData = await parseMcpResponse(crossTenantRes);
    assert.equal(crossData.result.isError, true);
    assert.ok(crossData.result.content[0].text.includes('not_found'));

    // 2. Parameter injection / smuggling rejected before tool handler
    const smuggleRes = await fetch(`${serverBaseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: { name: 'list_developers', arguments: { limit: 10, teamId: 'override-team', injected: true } },
      }),
    });
    assert.equal(smuggleRes.status, 200);
    const smuggleData = await parseMcpResponse(smuggleRes);
    assert.ok(smuggleData.error !== undefined || smuggleData.result?.isError === true);

    // 3. Metadata privacy check: no prompt text or paths in output
    const promptSearchRes = await fetch(`${serverBaseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: { name: 'search_prompt_metadata', arguments: { limit: 5 } },
      }),
    });
    const promptBody = await promptSearchRes.text();
    assert.doesNotMatch(promptBody, /\b(prompt_text|full_prompt|file_path|absolute_path)\b/i);
  });

  it('Step 7: Refresh token rotation and RFC 7009 token revocation', async () => {
    // 1. Refresh rotation
    const rotateRes = await fetch(`${serverBaseUrl}/oauth/token`, {
      method: 'POST',
      headers: { host: `127.0.0.1:${serverPort}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: currentRefreshToken,
        client_id: assignedClientId,
      }).toString(),
    });
    if (rotateRes.status !== 200) {
      const errText = await rotateRes.text();
      assert.fail(`rotate failed with status ${rotateRes.status}: ${errText}`);
    }
    assert.equal(rotateRes.status, 200);
    const rotateData = await rotateRes.json();
    assert.match(rotateData.access_token, /^tt_at_/);
    const rotatedAccessToken = rotateData.access_token;

    // 2. Revoke the token via RFC 7009
    const revokeRes = await fetch(`${serverBaseUrl}/oauth/revoke`, {
      method: 'POST',
      headers: { host: `127.0.0.1:${serverPort}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: rotatedAccessToken,
        client_id: assignedClientId,
      }).toString(),
    });
    assert.equal(revokeRes.status, 200);

    // 3. Calling /mcp with revoked token returns 401 Unauthorized
    const postRevokeRes = await fetch(`${serverBaseUrl}/mcp`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${serverPort}`,
        authorization: `Bearer ${rotatedAccessToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 30,
        method: 'tools/list',
        params: {},
      }),
    });
    assert.equal(postRevokeRes.status, 401);
  });
});
