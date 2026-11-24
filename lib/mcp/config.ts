/**
 * MCP server configuration (Phase 1: foundation only).
 *
 * The endpoint is OFF unless MCP_ENABLED is exactly "true". Nothing here reads credentials or touches a database.
 * Host and Origin validation protect against DNS-rebinding and browser-driven calls: the SDK's handler performs neither itself.
 */

export interface McpConfig {
  /** Master switch. Off by default; when off, /mcp answers 404 to every method. */
  enabled: boolean;
  /** Hostnames (no port) accepted in the Host header. Empty while enabled (production without MCP_ALLOWED_HOSTS or NEXT_PUBLIC_SERVER_URL) = refuse, fail closed. */
  allowedHosts: string[];
  /** Hostnames accepted in the Origin header when one is present. A request with NO Origin (server-to-server, e.g. Claude) is allowed. */
  allowedOriginHostnames: string[];
  /** Upper bound for a POST body. JSON-RPC handshake messages are tiny. */
  maxBodyBytes: number;
}

export const MCP_MAX_BODY_BYTES = 64 * 1024;
/** Claude's hosted apps call the server directly (no Origin); these cover browser-based clients served from Claude. */
export const DEFAULT_ALLOWED_ORIGIN_HOSTNAMES = ['claude.ai', 'claude.com'] as const;

const list = (value: string | undefined): string[] =>
  (value ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const hostnameOf = (value: string | undefined): string | null => {
  if (!value) return null;
  try { return new URL(value).hostname.toLowerCase(); } catch { return null; }
};

export function loadMcpConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  const own = hostnameOf(env.NEXT_PUBLIC_SERVER_URL);
  const explicit = list(env.MCP_ALLOWED_HOSTS).map((h) => h.replace(/:\d+$/, ''));
  const localDev = env.NODE_ENV === 'production' ? [] : ['localhost', '127.0.0.1'];
  const allowedHosts = [...new Set([...(explicit.length ? explicit : own ? [own] : []), ...localDev])];
  const extraOrigins = list(env.MCP_ALLOWED_ORIGINS).map((h) => h.replace(/^https?:\/\//, '').replace(/:\d+$/, ''));
  return {
    enabled: env.MCP_ENABLED === 'true',
    allowedHosts,
    allowedOriginHostnames: [...new Set([...DEFAULT_ALLOWED_ORIGIN_HOSTNAMES, ...allowedHosts, ...extraOrigins])],
    maxBodyBytes: MCP_MAX_BODY_BYTES,
  };
}
