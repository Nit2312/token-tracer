import { AsyncLocalStorage } from 'node:async_hooks';
import { createMcpHandler, hostHeaderValidationResponse, originValidationResponse, type McpHttpHandler, type McpServer } from '@modelcontextprotocol/server';
import { authenticateRequest, type BearerDeps } from './bearer';
import { loadMcpConfig, type McpConfig } from './config';
import { makeToolContext, type McpToolContext } from './context';
import { isCanonicalHost, loadOAuthConfig, type OAuthConfig } from './oauth/config';
import { createTokenTracerMcpServer } from './server';

/**
 * Stateless Streamable HTTP entry point for the MCP server: handshake and capability discovery behind bearer authentication (Step 7).
 *
 * Imports no application data code and no session/cookie code. The ONLY database path is ./bearer → ./oauth/tokens → ./db (the dedicated
 * mcp_auth role), used to authenticate every request. Nothing about a user is cached between requests: the SDK handler is shared (it holds
 * no per-user state; building one logs a warning, so it is created once), and the authenticated context reaches it only through an
 * AsyncLocalStorage scope that exists for the duration of ONE request.
 * Order of checks: flag (404) → configuration (503) → canonical Host (404) → Host allow-list backstop (403) → Origin (403) → bearer token (401/403/503) → SDK
 * (method/content-type/body/protocol checks).
 */

const SECURITY_HEADERS: Record<string, string> = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

/**
 * Log only the SDK's rejection CATEGORY (a fixed lowercase tag such as "invalid-json-rpc-body"), never its free-text message:
 * some SDK messages echo client-supplied values (e.g. the MCP-Protocol-Version header), and request data must not reach the logs.
 */
function logMcpError(error: Error): void {
  const tag = /^Rejected inbound request \(([a-z0-9-]{1,48})\)/.exec(String(error?.message ?? ''))?.[1];
  console.warn(tag ? `[mcp] rejected: ${tag}` : '[mcp] request error');
}

interface RequestScope { ctx: McpToolContext; create: (ctx: McpToolContext) => McpServer }
const scope = new AsyncLocalStorage<RequestScope>();

const handlers = new Map<number, McpHttpHandler>();
function sdkHandler(maxBodyBytes: number): McpHttpHandler {
  let h = handlers.get(maxBodyBytes);
  if (!h) {
    h = createMcpHandler(() => {
      const s = scope.getStore();
      if (!s) throw new Error('no authenticated request scope'); // fail closed: a server can never be built without a principal
      return s.create(s.ctx);
    }, {
      legacy: 'stateless', // 2025-era clients (what Claude speaks today) are served statelessly: no session id, GET/DELETE → 405
      responseMode: 'json',
      maxRequestBodySize: maxBodyBytes,
      onerror: logMcpError,
    });
    handlers.set(maxBodyBytes, h);
  }
  return h;
}

function withSecurityHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const jsonError = (status: number, message: string): Response =>
  withSecurityHeaders(Response.json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }, { status }));

export interface McpDeps extends BearerDeps {
  /** Validated OAuth configuration; `undefined` = load from the environment, `null` = invalid (fail closed). */
  oauth?: OAuthConfig | null;
  /** Test seam: builds the per-request server (receives the authenticated context). */
  createServer?: (ctx: McpToolContext) => McpServer;
}

export async function handleMcpRequest(request: Request, config: McpConfig = loadMcpConfig(), deps: McpDeps = {}): Promise<Response> {
  if (!config.enabled) return withSecurityHeaders(new Response(null, { status: 404 }));
  if (config.allowedHosts.length === 0) return jsonError(503, 'MCP endpoint is not configured.');
  const oauth = deps.oauth === undefined ? loadOAuthConfig() : deps.oauth;
  if (!oauth) return jsonError(503, 'MCP endpoint is not configured.');

  // Host policy, identical on every OAuth and MCP route: a request whose Host (or X-Forwarded-Host) is not the canonical host, or that carries
  // none, is answered with an empty 404 — the resource does not exist under that name (tokens are bound to the canonical resource URL, and
  // nothing is revealed about other aliases). The SDK allow-list below only matters if MCP_ALLOWED_HOSTS was configured WITHOUT the canonical
  // host (a misconfiguration): it then refuses with 403 instead of serving. A disallowed Origin is a different class of refusal (403).
  if (!isCanonicalHost(request.headers, oauth)) return withSecurityHeaders(new Response(null, { status: 404 }));
  const rejected =
    hostHeaderValidationResponse(request, config.allowedHosts) ??
    originValidationResponse(request, config.allowedOriginHostnames);
  if (rejected) return withSecurityHeaders(rejected);

  const auth = await authenticateRequest(request, oauth, deps);
  if (!auth.ok) return withSecurityHeaders(auth.response);

  const ctx = makeToolContext(auth.principal);
  const create = deps.createServer ?? createTokenTracerMcpServer;
  return withSecurityHeaders(await scope.run({ ctx, create }, () => sdkHandler(config.maxBodyBytes).fetch(request)));
}
