/**
 * Bearer authentication for /mcp (Step 7). Every request is authenticated from scratch: the token is hashed and looked up, and the user,
 * team and client are re-read from the database in the same query. There is no cache and no session. Failure responses carry the RFC 6750 /
 * RFC 9728 challenge (`WWW-Authenticate`) with the canonical resource-metadata URL, built from the validated configuration (never the request).
 *
 *   no credentials / not a Bearer scheme → 401  Bearer resource_metadata="…", scope="mcp:read"
 *   Bearer token that does not authenticate → 401  Bearer error="invalid_token", error_description="…", resource_metadata="…", scope="mcp:read"
 *   valid token without the mcp:read scope  → 403  Bearer error="insufficient_scope", …
 *   authentication database unavailable    → 503  (no challenge: the client must not discard a possibly good token)
 * Every token-state failure (unknown, malformed, expired, revoked, refresh token, wrong audience, deactivated/demoted user, team gone, client
 * disabled) is the SAME 401 invalid_token: the response never says which.
 */
import { getMcpPool, type McpPool } from './db';
import type { OAuthConfig } from './oauth/config';
import { resourceMetadataUrl } from './oauth/metadata';
import { asTeamAdmin, type McpPrincipal, type TeamAdminPrincipal } from './oauth/principal';
import { MCP_SCOPE_READ, hasScope } from './oauth/scopes';
import { authenticateAccessToken } from './oauth/tokens';

const NO_STORE = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } as const;
const BEARER_RE = /^Bearer ([^\s,]{1,512})$/i; // exactly one token; a comma list (repeated header) or any extra text does not match

export type AuthenticateFn = (token: string) => Promise<McpPrincipal | null>;
export interface BearerDeps { pool?: () => McpPool; authenticate?: AuthenticateFn }
export type BearerResult = { ok: true; principal: TeamAdminPrincipal } | { ok: false; response: Response };

export function parseAuthorization(header: string | null): { kind: 'missing' } | { kind: 'bearer'; token: string } | { kind: 'malformed' } {
  if (header === null || header.trim() === '') return { kind: 'missing' };
  if (!/^Bearer\b/i.test(header)) return { kind: 'missing' }; // another scheme (Basic …) is "no usable credentials", not an invalid token
  const m = BEARER_RE.exec(header);
  return m ? { kind: 'bearer', token: m[1] } : { kind: 'malformed' };
}

export function challenge(cfg: OAuthConfig, error?: 'invalid_token' | 'insufficient_scope'): string {
  const parts = ['Bearer'];
  const params: string[] = [];
  if (error === 'invalid_token') params.push('error="invalid_token"', 'error_description="The access token is invalid or has expired."');
  if (error === 'insufficient_scope') params.push('error="insufficient_scope"', 'error_description="The access token does not grant the required scope."');
  params.push(`resource_metadata="${resourceMetadataUrl(cfg)}"`, `scope="${MCP_SCOPE_READ}"`);
  return `${parts[0]} ${params.join(', ')}`;
}

const rpcError = (status: number, code: number, message: string, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), { status, headers: { ...NO_STORE, 'Content-Type': 'application/json', ...extra } });

export const unauthorized = (cfg: OAuthConfig, error?: 'invalid_token'): Response =>
  rpcError(401, -32001, error ? 'Invalid or expired access token.' : 'Authentication required.', { 'WWW-Authenticate': challenge(cfg, error) });

export async function authenticateRequest(request: Request, cfg: OAuthConfig, deps: BearerDeps = {}): Promise<BearerResult> {
  const parsed = parseAuthorization(request.headers.get('authorization'));
  if (parsed.kind === 'missing') return { ok: false, response: unauthorized(cfg) };
  if (parsed.kind === 'malformed') return { ok: false, response: unauthorized(cfg, 'invalid_token') };

  let principal: McpPrincipal | null;
  try {
    const authenticate = deps.authenticate ?? ((t: string) => authenticateAccessToken((deps.pool ?? getMcpPool)(), t, cfg.resource));
    principal = await authenticate(parsed.token);
  } catch {
    console.warn('[mcp] authentication unavailable'); // fixed text: no token, no driver message, no host/credential detail
    return { ok: false, response: rpcError(503, -32002, 'Authentication is temporarily unavailable.', { 'Retry-After': '5' }) };
  }
  if (!principal) return { ok: false, response: unauthorized(cfg, 'invalid_token') };

  // Defence in depth: the query already requires an active admin of an existing team; assert it again on the returned data.
  const admin = asTeamAdmin(principal);
  if (!admin) return { ok: false, response: unauthorized(cfg, 'invalid_token') };
  if (!hasScope(admin.scope, MCP_SCOPE_READ)) return { ok: false, response: rpcError(403, -32003, 'Insufficient scope.', { 'WWW-Authenticate': challenge(cfg, 'insufficient_scope') }) };
  return { ok: true, principal: admin };
}
