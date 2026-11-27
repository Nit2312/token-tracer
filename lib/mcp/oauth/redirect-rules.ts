/**
 * Redirect-URI policy for registered OAuth clients. Pure: no I/O.
 *
 * Accepted (and nothing else):
 *   • the two exact hosted-Claude callbacks;
 *   • loopback callbacks (RFC 8252 §7.3) for local clients such as Claude Code: http, host localhost | 127.0.0.1 | [::1],
 *     any port, path exactly /callback or /oauth/callback (mcp-remote, used by Claude Desktop), no query/fragment/userinfo.
 * Matching at authorization time is EXACT string equality, except for loopback URIs where the PORT is ignored (OAuth 2.1 §2.3.1 /
 * RFC 8252 §7.3; Claude Code uses an ephemeral port and declares http://localhost/callback). Scheme, host and path must still match
 * exactly, so `localhost` never matches `127.0.0.1`.
 */
export const CLAUDE_HOSTED_CALLBACKS: readonly string[] = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];
export const MAX_REDIRECT_URIS = 5;
const MAX_URI_LENGTH = 512;
const LOOPBACK_PATHS = new Set(['/callback', '/oauth/callback']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface RedirectPolicy { allowLoopback: boolean }
export const DEFAULT_REDIRECT_POLICY: RedirectPolicy = { allowLoopback: true };

export type RedirectKind = 'hosted' | 'loopback';

/** Returns the kind of an acceptable redirect URI, or null. Never throws. */
export function classifyRedirectUri(uri: unknown, policy: RedirectPolicy = DEFAULT_REDIRECT_POLICY): RedirectKind | null {
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > MAX_URI_LENGTH) return null;
  if (/[\u0000- \u007f\\]/.test(uri)) return null; // control chars, whitespace, backslashes
  if (CLAUDE_HOSTED_CALLBACKS.includes(uri)) return 'hosted'; // exact string match, nothing parsed

  if (!policy.allowLoopback) return null;
  let u: URL;
  try { u = new URL(uri); } catch { return null; }
  if (u.protocol !== 'http:') return null;
  if (u.username || u.password || u.search || u.hash) return null;
  if (!LOOPBACK_HOSTS.has(u.hostname)) return null;
  if (!LOOPBACK_PATHS.has(u.pathname)) return null;
  // Round-trip check: the URI must already be in canonical form (rejects `http://localhost:080/callback`, `HTTP://…`, trailing junk).
  if (u.href !== uri) return null;
  if (u.port !== '') {
    if (!/^[1-9][0-9]{0,4}$/.test(u.port)) return null;
    const portNum = Number(u.port);
    if (portNum < 1 || portNum > 65535) return null;
  }
  return 'loopback';
}

export interface RedirectValidation { ok: boolean; uris: string[]; hasLoopback: boolean }

/** Validates a client's full `redirect_uris` array for registration. */
export function validateRedirectUris(input: unknown, policy: RedirectPolicy = DEFAULT_REDIRECT_POLICY): RedirectValidation {
  const bad: RedirectValidation = { ok: false, uris: [], hasLoopback: false };
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_REDIRECT_URIS) return bad;
  const seen = new Set<string>();
  let hasLoopback = false;
  for (const uri of input) {
    const kind = classifyRedirectUri(uri, policy);
    if (!kind) return bad;
    if (kind === 'loopback') hasLoopback = true;
    seen.add(uri as string);
  }
  return { ok: true, uris: [...seen], hasLoopback };
}

const withoutPort = (uri: string): string => { const u = new URL(uri); return `${u.protocol}//${u.hostname}${u.pathname}`; };

/** Authorization-time check against the registered list, still subject to the CURRENT policy (the loopback kill switch applies to existing clients). */
export function redirectUriMatches(registered: readonly string[], requested: unknown, policy: RedirectPolicy = DEFAULT_REDIRECT_POLICY): boolean {
  if (typeof requested !== 'string') return false;
  const kind = classifyRedirectUri(requested, policy);
  if (kind === null) return false;
  if (kind === 'hosted') return registered.includes(requested);
  const want = withoutPort(requested);
  return registered.some((r) => classifyRedirectUri(r, policy) === 'loopback' && withoutPort(r) === want);
}
