/**
 * Phase 2 defines a single data scope. Tools added later must not widen it silently: a new scope means a new consent.
 * `offline_access` is accepted because Claude appends it when the authorization server lists it in scopes_supported; it carries no
 * data access and is never stored on a token. Refresh tokens are issued to registered clients regardless (public clients).
 */
export const MCP_SCOPE_READ = 'mcp:read';
export const SCOPE_OFFLINE_ACCESS = 'offline_access';
export const SUPPORTED_SCOPES = [MCP_SCOPE_READ] as const;
/** What the authorization-server metadata advertises (the protected-resource metadata advertises SUPPORTED_SCOPES only). */
export const ADVERTISED_SCOPES = [MCP_SCOPE_READ, SCOPE_OFFLINE_ACCESS] as const;

/**
 * Normalises a requested scope string into the DATA scope that will be granted. Omitted/empty/offline_access-only → mcp:read.
 * Anything outside the known set is refused (null) rather than silently dropped, so a client can never believe it holds a scope it does not.
 */
export function normalizeScope(requested: string | null | undefined): string | null {
  const parts = new Set((requested ?? '').split(/\s+/).filter(Boolean));
  parts.delete(SCOPE_OFFLINE_ACCESS);
  for (const s of parts) if (!(SUPPORTED_SCOPES as readonly string[]).includes(s)) return null;
  return parts.size === 0 ? MCP_SCOPE_READ : [...parts].sort().join(' ');
}

export const hasScope = (granted: string, needed: string): boolean => granted.split(' ').includes(needed);
