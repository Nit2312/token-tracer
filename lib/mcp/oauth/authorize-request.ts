/**
 * Parsing of GET /oauth/authorize query parameters (pure).
 * Two phases, because the rules differ: (1) client_id + redirect_uri decide whether we may redirect AT ALL — if either is unusable the user
 * sees an error page and we NEVER redirect (open-redirect / phishing defence, RFC 6749 §4.1.2.1); (2) every other defect is reported to the
 * (by then verified) redirect_uri as an OAuth error, with state echoed only when it is itself valid.
 */
import { isValidCodeChallenge } from './crypto';
import type { OAuthErrorCode } from './errors';
import { normalizeScope } from './scopes';

export type RawQuery = Record<string, string | string[] | undefined>;

/** Any repeated parameter makes the request untrustworthy → null (fatal). */
export function flattenQuery(q: RawQuery): Map<string, string> | null {
  const m = new Map<string, string>();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) return null;
    m.set(k, v);
  }
  return m;
}

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

export function parseClientAndRedirect(q: Map<string, string>): { clientId: string; redirectUri: string } | null {
  const clientId = q.get('client_id'); const redirectUri = q.get('redirect_uri');
  if (!clientId || !CLIENT_ID_RE.test(clientId)) return null;
  if (!redirectUri || redirectUri.length > 2048) return null;
  return { clientId, redirectUri };
}

export interface AuthorizeParams { clientId: string; redirectUri: string; codeChallenge: string; scope: string; state: string | null; resource: string }
export type RestResult = { ok: true; params: AuthorizeParams } | { ok: false; error: OAuthErrorCode; state: string | null };

const STATE_RE = /^[ -~ -￿]{1,512}$/u; // printable, no control characters

export function parseRest(q: Map<string, string>, base: { clientId: string; redirectUri: string }, canonicalResource: string): RestResult {
  const stateRaw = q.get('state');
  const state = stateRaw !== undefined && STATE_RE.test(stateRaw) ? stateRaw : null;
  const bad = (error: OAuthErrorCode): RestResult => ({ ok: false, error, state });
  if (stateRaw !== undefined && state === null) return bad('invalid_request');
  if (q.get('response_type') !== 'code') return bad('invalid_request');
  const challenge = q.get('code_challenge');
  if (!isValidCodeChallenge(challenge) || q.get('code_challenge_method') !== 'S256') return bad('invalid_request');
  const scopeRaw = q.get('scope');
  const scope = scopeRaw === undefined ? 'mcp:read' : normalizeScope(scopeRaw);
  if (scope === null) return bad('invalid_scope');
  const resource = q.get('resource');
  if (resource !== undefined && resource !== canonicalResource) return bad('invalid_target');
  return { ok: true, params: { ...base, codeChallenge: challenge, scope, state, resource: canonicalResource } };
}

/** Append OAuth response parameters to the VERIFIED redirect URI (the caller has already matched it against the client's registration). */
export function buildRedirect(redirectUri: string, params: Record<string, string | null | undefined>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return u.toString();
}
