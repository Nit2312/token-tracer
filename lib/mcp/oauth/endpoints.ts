/**
 * HTTP handlers for the OAuth endpoints (Step 5): discovery metadata, dynamic client registration, token, revocation.
 * Thin route files in app/ call these. Every handler runs the same preflight: flag off → 404, config invalid → 503 (fail closed),
 * non-canonical Host → 404. Back-channel endpoints additionally refuse browser cross-site requests, enforce content types and body sizes,
 * and are rate limited. Error bodies use fixed strings only (see errors.ts); nothing from the request is echoed or logged.
 */
import { getMcpPool, type McpPool } from '../db';
import { loadMcpConfig } from '../config';
import { registerClient } from './clients';
import { isCanonicalHost, loadOAuthConfig, type OAuthConfig } from './config';
import { NO_STORE_HEADERS, OAuthError, oauthErrorResponse, toOAuthError } from './errors';
import { clientIpKey, hasContentType, isBrowserCrossSite, notFound, parseForm, readLimitedText } from './http';
import { authorizationServerMetadata, protectedResourceMetadata } from './metadata';
import { consumeRateLimit } from './rate-limit';
import { MCP_SCOPE_READ, normalizeScope } from './scopes';
import { exchangeAuthorizationCode, refreshTokens, revokeToken } from './tokens';

export interface EndpointDeps {
  enabled?: boolean;
  config?: OAuthConfig | null;
  pool?: () => McpPool;
}

const REGISTER_MAX_BYTES = 8 * 1024;
const FORM_MAX_BYTES = 4 * 1024;
const FORM_TYPE = 'application/x-www-form-urlencoded';

type Pre = { cfg: OAuthConfig; pool: () => McpPool } | Response;

export function preflight(req: Request, deps: EndpointDeps): Pre {
  const enabled = deps.enabled ?? loadMcpConfig().enabled;
  if (!enabled) return notFound();
  const cfg = deps.config === undefined ? loadOAuthConfig() : deps.config;
  if (!cfg) return oauthErrorResponse(new OAuthError('temporarily_unavailable', 'The authorization server is not configured.', 503));
  if (!isCanonicalHost(req.headers, cfg)) return notFound();
  return { cfg, pool: deps.pool ?? getMcpPool };
}

export async function limited(pool: McpPool, key: string, limit: number, windowSeconds: number): Promise<void> {
  const r = await consumeRateLimit(pool, key, limit, windowSeconds);
  if (!r.allowed) throw new RateLimited(r.retryAfterSeconds);
}
class RateLimited extends Error { constructor(readonly retryAfter: number) { super('rate limited'); } }

export function fail(e: unknown): Response {
  if (e instanceof RateLimited) return oauthErrorResponse(new OAuthError('temporarily_unavailable', 'Too many requests.', 429), { 'Retry-After': String(e.retryAfter) });
  return oauthErrorResponse(toOAuthError(e));
}

// ── Discovery ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const PUBLIC_JSON = { 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*' };

export function handleAuthorizationServerMetadata(req: Request, deps: EndpointDeps = {}): Response {
  const pre = preflight(req, deps);
  return pre instanceof Response ? pre : Response.json(authorizationServerMetadata(pre.cfg), { headers: PUBLIC_JSON });
}
export function handleProtectedResourceMetadata(req: Request, deps: EndpointDeps = {}): Response {
  const pre = preflight(req, deps);
  return pre instanceof Response ? pre : Response.json(protectedResourceMetadata(pre.cfg), { headers: PUBLIC_JSON });
}

// ── Dynamic client registration (RFC 7591), public clients only ────────────────────────────────────────────────────────────────

export async function handleRegister(req: Request, deps: EndpointDeps = {}): Promise<Response> {
  const pre = preflight(req, deps);
  if (pre instanceof Response) return pre;
  try {
    if (isBrowserCrossSite(req.headers)) throw new OAuthError('invalid_request', 'Cross-site requests are not accepted.', 403);
    if (!hasContentType(req.headers, 'application/json')) throw new OAuthError('invalid_client_metadata', 'Content-Type must be application/json.', 415);
    const pool = pre.pool();
    const ip = clientIpKey(req.headers);
    await limited(pool, `register:${ip}`, 10, 3600);
    await limited(pool, 'register:all', 300, 3600);

    let body: unknown;
    try { body = JSON.parse(await readLimitedText(req, REGISTER_MAX_BYTES)); } catch (e) { if (e instanceof OAuthError) throw e; throw new OAuthError('invalid_client_metadata', 'Body must be a JSON object.'); }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new OAuthError('invalid_client_metadata', 'Body must be a JSON object.');
    const m = body as Record<string, unknown>;

    if (m.token_endpoint_auth_method !== undefined && m.token_endpoint_auth_method !== 'none') throw new OAuthError('invalid_client_metadata', 'Only public clients (token_endpoint_auth_method "none") are supported.');
    if (m.grant_types !== undefined) {
      const g = m.grant_types;
      if (!Array.isArray(g) || !g.every((x) => x === 'authorization_code' || x === 'refresh_token') || !g.includes('authorization_code')) throw new OAuthError('invalid_client_metadata', 'Unsupported grant_types.');
    }
    if (m.response_types !== undefined && !(Array.isArray(m.response_types) && m.response_types.length === 1 && m.response_types[0] === 'code')) throw new OAuthError('invalid_client_metadata', 'Unsupported response_types.');
    if (m.scope !== undefined && (typeof m.scope !== 'string' || normalizeScope(m.scope) === null)) throw new OAuthError('invalid_client_metadata', 'Unsupported scope.');

    const client = await registerClient(pool, {
      name: m.client_name === undefined ? 'MCP client' : m.client_name,
      redirectUris: m.redirect_uris,
      registration: 'dcr',
      clientIp: req.headers.get('x-real-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      policy: { allowLoopback: pre.cfg.allowLoopback },
    });
    return Response.json({
      client_id: client.clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: MCP_SCOPE_READ,
    }, { status: 201, headers: NO_STORE_HEADERS });
  } catch (e) { return fail(e); }
}

// ── Token endpoint (RFC 6749 §3.2 / §4.1.3 / §6, RFC 8707) ─────────────────────────────────────────────────────────────────────

/** Cheap header-only checks, run BEFORE any database work. */
function checkFormHeaders(req: Request): void {
  if (isBrowserCrossSite(req.headers)) throw new OAuthError('invalid_request', 'Cross-site requests are not accepted.', 403);
  if (req.headers.has('authorization')) throw new OAuthError('invalid_client', 'Client authentication is not supported (public clients only).', 401);
  if (!hasContentType(req.headers, FORM_TYPE)) throw new OAuthError('invalid_request', `Content-Type must be ${FORM_TYPE}.`, 415);
}
async function readForm(req: Request): Promise<Map<string, string>> {
  const form = parseForm(await readLimitedText(req, FORM_MAX_BYTES));
  if (form.has('client_secret') || form.has('client_assertion')) throw new OAuthError('invalid_client', 'Client authentication is not supported (public clients only).', 401);
  return form;
}
const need = (f: Map<string, string>, k: string): string => {
  const v = f.get(k);
  if (!v) throw new OAuthError('invalid_request', 'A required parameter is missing.');
  return v;
};

export async function handleToken(req: Request, deps: EndpointDeps = {}): Promise<Response> {
  const pre = preflight(req, deps);
  if (pre instanceof Response) return pre;
  try {
    checkFormHeaders(req);
    const pool = pre.pool();
    await limited(pool, `token:${clientIpKey(req.headers)}`, 120, 60);
    const f = await readForm(req);
    const clientId = need(f, 'client_id');
    await limited(pool, `token:client:${clientId.slice(0, 64)}`, 60, 60);
    const resource = f.get('resource');
    if (resource !== undefined && resource !== pre.cfg.resource) throw new OAuthError('invalid_target', 'Unknown resource.');

    const grant = f.get('grant_type');
    let pair;
    if (grant === 'authorization_code') {
      pair = await exchangeAuthorizationCode(pool, {
        code: need(f, 'code'), clientId, redirectUri: need(f, 'redirect_uri'), codeVerifier: need(f, 'code_verifier'), resource: pre.cfg.resource,
      });
    } else if (grant === 'refresh_token') {
      const scope = f.get('scope');
      if (scope !== undefined && normalizeScope(scope) === null) throw new OAuthError('invalid_scope', 'Unsupported scope.');
      pair = await refreshTokens(pool, { refreshToken: need(f, 'refresh_token'), clientId });
    } else {
      throw new OAuthError('unsupported_grant_type', 'Unsupported grant_type.');
    }
    return Response.json({ access_token: pair.accessToken, token_type: pair.tokenType, expires_in: pair.expiresIn, refresh_token: pair.refreshToken, scope: pair.scope }, { headers: NO_STORE_HEADERS });
  } catch (e) { return fail(e); }
}

// ── Revocation (RFC 7009) ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function handleRevoke(req: Request, deps: EndpointDeps = {}): Promise<Response> {
  const pre = preflight(req, deps);
  if (pre instanceof Response) return pre;
  try {
    checkFormHeaders(req);
    const pool = pre.pool();
    await limited(pool, `revoke:${clientIpKey(req.headers)}`, 120, 60);
    const f = await readForm(req);
    await revokeToken(pool, need(f, 'token'), need(f, 'client_id'));
    return Response.json({}, { headers: NO_STORE_HEADERS }); // 200 whether or not the token existed
  } catch (e) { return fail(e); }
}
