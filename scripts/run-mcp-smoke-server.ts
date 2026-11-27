#!/usr/bin/env node
/**
 * scripts/run-mcp-smoke-server.ts
 *
 * Runs an isolated, disposable local Token Tracer server configured specifically
 * for Claude Desktop manual smoke testing without touching production databases or Vercel.
 *
 * Usage:
 *   # Mode 1: Simulated disposable database in-memory (zero PostgreSQL required)
 *   npx tsx scripts/run-mcp-smoke-server.ts [--port 3000] [--hostname 127.0.0.1]
 *
 * Safety Invariants:
 *   - NEVER connects to or loads production DATABASE_URL.
 *   - Replaces all production credentials with isolated test secrets.
 *   - Provisions disposable admin user with MFA for browser consent.
 *   - Runs exclusively on local loopback interface.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { handleMcpRequest, type McpDeps } from '../lib/mcp/handler';
import { createTokenTracerMcpServer } from '../lib/mcp/server';
import { MCP_MAX_BODY_BYTES, type McpConfig } from '../lib/mcp/config';
import { generateSecret, sha256 } from '../lib/mcp/oauth/crypto';
import {
  handleRegister,
  handleToken,
  handleRevoke,
  handleAuthorizationServerMetadata,
  handleProtectedResourceMetadata,
} from '../lib/mcp/oauth/endpoints';
import { prepareAuthorize } from '../lib/mcp/oauth/authorize';
import { verifyConsent } from '../lib/mcp/oauth/consent';
import type { OAuthConfig } from '../lib/mcp/oauth/config';
import type { McpPool } from '../lib/mcp/db';
import type { SessionPayload } from '../lib/session-token';
import type { McpPrincipal } from '../lib/mcp/oauth/principal';
import type { McpToolContext } from '../lib/mcp/context';

const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const PORT = portIndex !== -1 ? Number(args[portIndex + 1]) : 3000;
const hostIndex = args.indexOf('--hostname');
const HOSTNAME = hostIndex !== -1 ? args[hostIndex + 1] : '127.0.0.1';
const BASE_HOST = `${HOSTNAME}:${PORT}`;
const BASE_URL = `http://${BASE_HOST}`;

// Test secrets and credentials
const SMOKE_SESSION_SECRET = 'smoke-test-session-secret-32-bytes-minimum!';
process.env.SESSION_SECRET = SMOKE_SESSION_SECRET;
process.env.MCP_ENABLED = 'true';
process.env.MCP_PUBLIC_BASE_URL = BASE_URL;

// Disposable Multi-tenant fixtures
const TEAM_ALPHA = '11111111-1111-4111-8111-111111111111';
const USER_ALPHA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEV_ALPHA_1 = '33333333-3333-4333-8333-333333333333';
const DEV_ALPHA_2 = '55555555-5555-4555-8555-555555555555';

interface StoredClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  disabled_at: null;
}

interface StoredCode {
  codeHash: string;
  clientId: string;
  userId: string;
  codeChallenge: string;
  redirectUri: string;
}

interface StoredToken {
  tokenHash: string;
  kind: string;
  clientId: string;
  userId: string;
  teamId: string;
  familyId: string;
  revoked: boolean;
}

// In-memory OAuth store
const oauthStore = {
  clients: new Map<string, StoredClient>(),
  codes: new Map<string, StoredCode>(),
  tokens: new Map<string, StoredToken>(),
};

// In-memory Mock PostgreSQL pool for pure local mode
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
        query: async (sql: string, ...args: unknown[]) => {
          const params = args[0] as unknown[] | undefined;
          if (sql.includes('mcp_rate_limits')) {
            return { rows: [{ count: 1, retry: 60 }], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
          }
          if (sql.includes('INSERT INTO oauth_clients')) {
            const cid = params?.[0] as string;
            const name = params?.[1] as string;
            const uris = params?.[2] as string[];
            oauthStore.clients.set(cid, {
              clientId: cid,
              clientName: name,
              redirectUris: uris,
              disabled_at: null,
            });
            return { rows: [{ client_id: cid }], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
          }
          if (sql.includes('FROM oauth_clients WHERE client_id = $1')) {
            const cid = params?.[0] as string;
            const c = oauthStore.clients.get(cid);
            if (!c) return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
            return {
              rows: [{ client_id: c.clientId, client_name: c.clientName, redirect_uris: c.redirectUris, disabled_at: null }],
              rowCount: 1,
              command: 'SELECT',
              oid: 0,
              fields: [],
            };
          }
          if (sql.includes('UPDATE oauth_authorization_codes SET consumed_at')) {
            const cHashHex = params?.[0] instanceof Buffer ? params[0].toString('hex') : (params?.[0] as string);
            const rec = oauthStore.codes.get(cHashHex);
            if (!rec) return { rows: [], rowCount: 0, command: 'UPDATE', oid: 0, fields: [] };
            return {
              rows: [{
                client_id: rec.clientId,
                user_id: rec.userId,
                redirect_uri: rec.redirectUri,
                code_challenge: rec.codeChallenge,
                resource: `${BASE_URL}/mcp`,
                scope: 'mcp:read',
                family_id: crypto.randomUUID(),
              }],
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
            const tHash = params?.[0];
            // Real query: VALUES ($1 token_hash, 'access'|'refresh' literal, $2 family_id, $3 client_id, $4 user_id, ...)
            const kind = sql.includes("'refresh'") ? 'refresh' : 'access';
            const familyId = params?.[1] as string;
            const cid = params?.[2] as string;
            const uid = params?.[3] as string;
            const thHex = tHash instanceof Buffer ? tHash.toString('hex') : String(tHash);
            oauthStore.tokens.set(thHex, {
              tokenHash: thHex,
              kind,
              clientId: cid,
              userId: uid,
              teamId: TEAM_ALPHA,
              familyId,
              revoked: false,
            });
            return { rows: [{ id: crypto.randomUUID(), token_hash: tHash }], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
          }
          if (sql.includes('FROM users u LEFT JOIN teams t')) {
            return {
              rows: [{ id: USER_ALPHA, display_name: 'Team Alpha Admin', role: 'admin', team_id: TEAM_ALPHA, team_name: 'Acme Alpha Team', active: true }],
              rowCount: 1,
              command: 'SELECT',
              oid: 0,
              fields: [],
            };
          }
          if (sql.includes('UPDATE oauth_tokens SET revoked_at')) {
            const thHex = params?.[0] instanceof Buffer ? params[0].toString('hex') : (params?.[0] as string);
            const rec = oauthStore.tokens.get(thHex);
            if (rec) rec.revoked = true;
            return { rows: [], rowCount: 1, command: 'UPDATE', oid: 0, fields: [] };
          }
          if (sql.includes('mcp_audit_event')) {
            return { rows: [{ mcp_audit_event: 1 }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] };
          }

          // MCP Data Functions
          if (sql.includes('list_developers')) {
            return {
              rows: [
                { member_id: DEV_ALPHA_1, display_name: 'Alice Developer', role: 'admin' },
                { member_id: DEV_ALPHA_2, display_name: 'Bob Developer', role: 'member' },
              ],
              rowCount: 2,
              command: 'SELECT',
              oid: 0,
              fields: [],
            };
          }
          if (sql.includes('developer_activity')) {
            const devId = params?.[1] as string;
            if (devId !== DEV_ALPHA_1 && devId !== DEV_ALPHA_2) {
              return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
            }
            return {
              rows: [
                {
                  day: '2026-11-26',
                  tokens_in: '12500',
                  tokens_out: '4800',
                  cache_read_tokens: '2500',
                  cache_write_tokens: '1200',
                  api_cost: '0.42',
                  session_count: '4',
                  tool_calls: '18',
                  tool_errors: '0',
                  edits: '8',
                  additions: '142',
                  deletions: '28',
                  changed_lines: '170',
                  files_touched: '6',
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
                  member_id: DEV_ALPHA_1,
                  source: 'claude-code',
                  model: 'claude-3-5-sonnet',
                  started_at: '2026-11-26T10:00:00Z',
                  ended_at: '2026-11-26T10:45:00Z',
                  activity_at: '2026-11-26T10:45:00Z',
                  tokens_in: '8500',
                  tokens_out: '3200',
                  tokens_cache_read: '1500',
                  tokens_cache_write: '600',
                  api_cost: '0.28',
                  priced: true,
                  edits: 5,
                  additions: 95,
                  deletions: 12,
                  changed_lines: 107,
                  files_touched: 4,
                  tool_calls: 14,
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
            const sessId = params?.[1] as string;
            if (sessId !== '33333333-3333-4333-8333-333333333333') {
              return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
            }
            return {
              rows: [
                {
                  id: '33333333-3333-4333-8333-333333333333',
                  member_id: DEV_ALPHA_1,
                  source: 'claude-code',
                  model: 'claude-3-5-sonnet',
                  started_at: '2026-11-26T10:00:00Z',
                  ended_at: '2026-11-26T10:45:00Z',
                  activity_at: '2026-11-26T10:45:00Z',
                  tokens_in: '8500',
                  tokens_out: '3200',
                  tokens_cache_read: '1500',
                  tokens_cache_write: '600',
                  api_cost: '0.28',
                  priced: true,
                  edits: 5,
                  additions: 95,
                  deletions: 12,
                  changed_lines: 107,
                  files_touched: 4,
                  tool_calls: 14,
                  tool_errors: 0,
                  rework_loops: 0,
                  corrections: 0,
                  abandoned: false,
                  tools: [
                    { tool_name: 'read_file', call_count: 9 },
                    { tool_name: 'edit_file', call_count: 5 },
                  ],
                },
              ],
              rowCount: 1,
              command: 'SELECT',
              oid: 0,
              fields: [],
            };
          }
          if (sql.includes('search_prompt_metadata') || sql.includes('prompt_metadata_batch')) {
            return {
              rows: [
                {
                  prompt_id: '901',
                  session_uuid: '33333333-3333-4333-8333-333333333333',
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
      };
      return client as unknown as PoolClient;
    },
    end: async () => {},
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0,
  } as unknown as McpPool;
}

const mockPool = createMockPool();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? BASE_HOST}`);

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const rawBody = Buffer.concat(chunks).toString('utf8');

  const webReq = new Request(url.toString(), {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: ['GET', 'HEAD'].includes(req.method ?? '') ? undefined : rawBody,
  });

  const oauthConfig: OAuthConfig = {
    baseUrl: BASE_URL,
    host: BASE_HOST.toLowerCase(),
    resource: `${BASE_URL}/mcp`,
    allowLoopback: true,
  };

  const mcpConfig: McpConfig = {
    enabled: true,
    maxBodyBytes: MCP_MAX_BODY_BYTES,
    allowedHosts: [BASE_HOST.toLowerCase(), '127.0.0.1', 'localhost'],
    allowedOriginHostnames: ['127.0.0.1', 'localhost', 'claude.ai', 'claude.com'],
  };

  let webRes: Response;
  try {
    if (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      webRes = await handleProtectedResourceMetadata(webReq, { enabled: true, config: oauthConfig, pool: () => mockPool });
    } else if (url.pathname === '/.well-known/oauth-authorization-server') {
      webRes = await handleAuthorizationServerMetadata(webReq, { enabled: true, config: oauthConfig, pool: () => mockPool });
    } else if (url.pathname === '/oauth/register') {
      webRes = await handleRegister(webReq, { enabled: true, config: oauthConfig, pool: () => mockPool });
    } else if (url.pathname === '/oauth/authorize') {
      // Interactive browser consent endpoint
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
          searchParams: Object.fromEntries(url.searchParams.entries()),
          session: userSession,
          headers: webReq.headers,
          secret: SMOKE_SESSION_SECRET,
        },
        { enabled: true, config: oauthConfig, pool: () => mockPool }
      );

      if (authView.kind === 'consent') {
        const html = `<!DOCTYPE html>
<html>
<head><title>Authorize Token Tracer MCP</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
.card { background: #1e293b; padding: 2rem; border-radius: 0.75rem; border: 1px solid #334155; max-width: 480px; width: 100%; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
h1 { font-size: 1.5rem; margin-top: 0; color: #38bdf8; }
p { color: #94a3b8; line-height: 1.5; }
.badge { background: #0369a1; color: #e0f2fe; padding: 0.25rem 0.5rem; border-radius: 0.25rem; font-size: 0.875rem; }
.perms { background: #0f172a; padding: 1rem; border-radius: 0.5rem; margin: 1.5rem 0; font-size: 0.875rem; }
.perms li { margin-bottom: 0.5rem; color: #cbd5e1; }
button { width: 100%; background: #2563eb; color: white; border: none; padding: 0.75rem; border-radius: 0.5rem; font-size: 1rem; font-weight: 600; cursor: pointer; transition: background 0.2s; }
button:hover { background: #1d4ed8; }
</style>
</head>
<body>
<div class="card">
  <h1>Authorize Access</h1>
  <p><strong>${authView.view.clientName}</strong> is requesting permission to access Token Tracer metadata on behalf of:</p>
  <p><span class="badge">${authView.view.userName} (${authView.view.teamName})</span></p>
  <div class="perms">
    <strong>Granted Permissions:</strong>
    <ul>
      <li>Read team developer summaries and activity metrics</li>
      <li>Inspect session summaries and tool call statistics</li>
      <li>Search prompt metadata (intent, token counts, code blocks)</li>
      <li><em>Notice: Strict metadata only. Zero prompt text or file paths exposed.</em></li>
    </ul>
  </div>
  <form method="POST" action="/oauth/decision">
    <input type="hidden" name="consentToken" value="${authView.view.consentToken}" />
    <input type="hidden" name="decision" value="approve" />
    <button type="submit">Approve Connection</button>
  </form>
</div>
</body>
</html>`;
        webRes = new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      } else if (authView.kind === 'redirect') {
        webRes = Response.redirect(authView.url, 302);
      } else {
        webRes = new Response(`Authorization Error: ${authView.kind}`, { status: 400 });
      }
    } else if (url.pathname === '/oauth/decision') {
      const formParams = new URLSearchParams(rawBody);
      const consentToken = formParams.get('consentToken');
      const decision = formParams.get('decision');

      // Use the request the user was actually shown (client, redirect URI, PKCE challenge, state) from the signed consent token,
      // so local clients such as mcp-remote (Claude Desktop) get their own loopback callback instead of a hardcoded hosted one.
      const claims = decision === 'approve' ? verifyConsent(consentToken, SMOKE_SESSION_SECRET) : null;
      if (claims) {
        const code = generateSecret('tt_ac_');
        const chHex = sha256(code).toString('hex');

        const codeRec: StoredCode = {
          codeHash: chHex,
          clientId: claims.cid,
          userId: USER_ALPHA,
          codeChallenge: claims.cc,
          redirectUri: claims.ru,
        };
        oauthStore.codes.set(chHex, codeRec);

        const callbackUrl = new URL(claims.ru);
        callbackUrl.searchParams.set('code', code);
        if (claims.st) callbackUrl.searchParams.set('state', claims.st);
        callbackUrl.searchParams.set('iss', BASE_URL); // RFC 9207, advertised in the server metadata
        webRes = Response.redirect(callbackUrl.toString(), 302);
      } else {
        webRes = new Response('Denied', { status: 400 });
      }
    } else if (url.pathname === '/oauth/token') {
      webRes = await handleToken(webReq, { enabled: true, config: oauthConfig, pool: () => mockPool });
    } else if (url.pathname === '/oauth/revoke') {
      webRes = await handleRevoke(webReq, { enabled: true, config: oauthConfig, pool: () => mockPool });
    } else if (url.pathname === '/mcp') {
      const deps: McpDeps = {
        oauth: oauthConfig,
        authenticate: async (token: string): Promise<McpPrincipal | null> => {
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
        createServer: (ctx: McpToolContext) =>
          createTokenTracerMcpServer(ctx, {
            deps: {
              pool: () => mockPool,
              secret: () => SMOKE_SESSION_SECRET,
              now: () => new Date('2026-11-26T12:00:00Z'),
            },
          }),
      };
      webRes = await handleMcpRequest(webReq, mcpConfig, deps);
    } else {
      webRes = new Response('Not Found', { status: 404 });
    }
  } catch (err) {
    console.error('[smoke-server error]', err);
    webRes = new Response(JSON.stringify({ error: 'Internal Error' }), { status: 500, headers: { 'content-type': 'application/json' } });
  }

  res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
  const bodyText = await webRes.text();
  res.end(bodyText);
});

server.listen(PORT, HOSTNAME, () => {
  console.log(`\n======================================================`);
  console.log(` Token Tracer MCP — Smoke Test Server Running`);
  console.log(` Local Endpoint:  ${BASE_URL}/mcp`);
  console.log(` Resource URL:    ${BASE_URL}/mcp`);
  console.log(` Discovery URL:   ${BASE_URL}/.well-known/oauth-protected-resource/mcp`);
  console.log(` Environment:     Isolated In-Memory Test Mode (0 Prod Access)`);
  console.log(`======================================================\n`);
});
