import { createMcpHandler, hostHeaderValidationResponse, originValidationResponse, type McpHttpHandler } from '@modelcontextprotocol/server';
import { loadMcpConfig, type McpConfig } from './config';
import { createTokenTracerMcpServer } from './server';

/**
 * Stateless Streamable HTTP entry point for the MCP server (Phase 1: handshake and capability discovery only).
 *
 * Deliberately imports NOTHING from the application: no database, no authentication, no session code. There is no OAuth in this
 * phase; with the flag on, the endpoint answers initialize/ping/discovery and nothing else exists to call.
 * Order of checks: flag (404) → configuration (503) → Host (403) → Origin (403) → SDK (method/content-type/body/protocol checks).
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

const handlers = new Map<number, McpHttpHandler>();
function sdkHandler(maxBodyBytes: number): McpHttpHandler {
  let h = handlers.get(maxBodyBytes);
  if (!h) {
    h = createMcpHandler(() => createTokenTracerMcpServer(), {
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

export async function handleMcpRequest(request: Request, config: McpConfig = loadMcpConfig()): Promise<Response> {
  if (!config.enabled) return withSecurityHeaders(new Response(null, { status: 404 }));
  if (config.allowedHosts.length === 0) return jsonError(503, 'MCP endpoint is not configured.');

  const rejected =
    hostHeaderValidationResponse(request, config.allowedHosts) ??
    originValidationResponse(request, config.allowedOriginHostnames);
  if (rejected) return withSecurityHeaders(rejected);

  return withSecurityHeaders(await sdkHandler(config.maxBodyBytes).fetch(request));
}
