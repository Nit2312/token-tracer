/**
 * OAuth/MCP public configuration. The issuer, the resource identifier and every URL in discovery documents come from
 * MCP_PUBLIC_BASE_URL — NEVER from the Host header of the incoming request (host-header injection would otherwise let an attacker mint
 * metadata pointing at their own server). Requests whose Host is not the canonical one are refused (isCanonicalHost).
 * Fail closed: a missing or malformed value yields null and every OAuth endpoint answers 503.
 */
export interface OAuthConfig {
  /** Origin only, no trailing slash, e.g. https://token-tracer-three.vercel.app */
  baseUrl: string;
  /** host[:port] of baseUrl, lowercase; the only Host value the OAuth endpoints accept. */
  host: string;
  /** The MCP resource identifier (RFC 8707 / RFC 9728): `${baseUrl}/mcp`. Tokens are bound to it. */
  resource: string;
  /** Kill-switch for http://localhost|127.0.0.1|[::1] redirect URIs (Claude Code). Default on. */
  allowLoopback: boolean;
}

type Env = Record<string, string | undefined>;

export function loadOAuthConfig(env: Env = process.env): OAuthConfig | null {
  const raw = env.MCP_PUBLIC_BASE_URL?.trim();
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const prod = env.NODE_ENV === 'production';
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local && !prod)) return null;
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null;
  return {
    baseUrl: u.origin,
    host: u.host.toLowerCase(),
    resource: `${u.origin}/mcp`,
    allowLoopback: env.MCP_ALLOW_LOOPBACK_REDIRECTS !== 'false',
  };
}

/** Every Host-carrying header that is present must equal the canonical host; at least one must be present. */
export function isCanonicalHost(headers: Headers, cfg: OAuthConfig): boolean {
  const seen = [headers.get('host'), headers.get('x-forwarded-host')].filter((v): v is string => !!v);
  return seen.length > 0 && seen.every((v) => v.trim().toLowerCase() === cfg.host);
}
