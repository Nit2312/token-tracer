/**
 * The consent step (Step 6): everything behind GET /oauth/authorize and POST /oauth/decision, as plain functions so it can be tested
 * without rendering. The page and the route are thin shells around these.
 *
 * Rules, in order, for the page: flag/config/Host → client + redirect_uri verified (else an ERROR PAGE, never a redirect) → other parameter
 * errors go back to the verified redirect_uri → no session → login with a safe returnTo → eligibility re-read from the database → login not older
 * than 15 minutes (else /oauth/reauthenticate → fresh password + TOTP) → consent view.
 * The decision route trusts nothing from the browser except a signed consent token bound to the session user, and re-checks everything.
 */
import { withMcpTx } from '../db';
import { getSessionFromCookie, type SessionPayload } from '../../session-token';
import { safeReturnTo } from '../../security/return-url';
import { audit } from './audit';
import { clientAllowsRedirect, getClient } from './clients';
import { buildRedirect, flattenQuery, parseClientAndRedirect, parseRest, type RawQuery } from './authorize-request';
import { signConsent, verifyConsent } from './consent';
import { classifyRedirectUri } from './redirect-rules';
import { NO_STORE_HEADERS, OAuthError, oauthErrorResponse } from './errors';
import { GRANT_MAX_LOGIN_AGE_MS, INELIGIBLE_MESSAGE, evaluateGrantEligibility, loadGrantUser } from './grant-user';
import { hasContentType, isBrowserCrossSite, readLimitedText } from './http';
import { createAuthorizationCode } from './tokens';
import { fail, limited, preflight, type EndpointDeps } from './endpoints';

export interface ConsentView {
  consentToken: string;
  clientName: string;
  /** Where the result will be sent, as shown to the user: the origin for hosted callbacks, "this computer" for loopback. */
  destination: string;
  loopback: boolean;
  userName: string;
  teamName: string;
  /** True for an All-teams admin: the consent page says "all teams" instead of naming one. */
  allTeams: boolean;
}

export type AuthorizeView =
  | { kind: 'not_found' }
  | { kind: 'unavailable' }
  | { kind: 'fatal'; message: string }
  | { kind: 'redirect'; url: string }
  | { kind: 'login'; returnTo: string }
  | { kind: 'reauth'; url: string }
  | { kind: 'ineligible'; message: string }
  | { kind: 'consent'; view: ConsentView };

const FATAL = (message: string): AuthorizeView => ({ kind: 'fatal', message });
const BAD_LINK = 'This authorization link is invalid. Return to the application you started from and try again.';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PrepareInput { searchParams: RawQuery; session: SessionPayload | null; headers: Headers; secret: string }

export async function prepareAuthorize(i: PrepareInput, deps: EndpointDeps = {}, now = Date.now()): Promise<AuthorizeView> {
  const pre = preflight(new Request('https://invalid.invalid/', { headers: i.headers }), deps);
  if (pre instanceof Response) return pre.status === 503 ? { kind: 'unavailable' } : { kind: 'not_found' };
  const { cfg } = pre;
  const pool = pre.pool();
  const policy = { allowLoopback: cfg.allowLoopback };

  const q = flattenQuery(i.searchParams);
  if (!q) return FATAL(BAD_LINK);
  const base = parseClientAndRedirect(q);
  if (!base) return FATAL(BAD_LINK);
  const client = await getClient(pool, base.clientId);
  if (!client || !clientAllowsRedirect(client, base.redirectUri, policy) || !classifyRedirectUri(base.redirectUri, policy)) return FATAL(BAD_LINK);

  const rest = parseRest(q, base, cfg.resource);
  if (!rest.ok) return { kind: 'redirect', url: buildRedirect(base.redirectUri, { error: rest.error, state: rest.state, iss: cfg.baseUrl }) };
  const p = rest.params;

  const returnTo = safeReturnTo(`/oauth/authorize?${new URLSearchParams([...q]).toString()}`);
  if (!i.session) return returnTo ? { kind: 'login', returnTo } : FATAL(BAD_LINK);

  const elig = evaluateGrantEligibility(i.session, UUID_RE.test(i.session.userId) ? await loadGrantUser(pool, i.session.userId) : null, now);
  if (!elig.ok) {
    // Logged in but not recently: force a fresh password + TOTP login (the session cookie is cleared by /oauth/reauthenticate), then come back here.
    if (elig.reason === 'login_not_recent') return returnTo ? { kind: 'reauth', url: `/oauth/reauthenticate?returnTo=${encodeURIComponent(returnTo)}` } : FATAL(BAD_LINK);
    return { kind: 'ineligible', message: INELIGIBLE_MESSAGE[elig.reason] };
  }

  const kind = classifyRedirectUri(p.redirectUri, policy);
  return {
    kind: 'consent',
    view: {
      consentToken: signConsent({ uid: elig.user.id, sia: i.session.issuedAt, cid: p.clientId, ru: p.redirectUri, cc: p.codeChallenge, sc: p.scope, st: p.state, rs: p.resource }, i.secret, now),
      clientName: client.name,
      destination: kind === 'loopback' ? 'an application running on your own computer' : new URL(p.redirectUri).origin,
      loopback: kind === 'loopback',
      userName: elig.user.displayName,
      teamName: elig.user.teamId ? (elig.user.teamName ?? 'your team') : 'All teams',
      allTeams: !elig.user.teamId,
    },
  };
}

// ── POST /oauth/decision ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DecisionDeps extends EndpointDeps { secret?: string; session?: (req: Request) => SessionPayload | null; now?: () => number }

export async function handleDecision(req: Request, deps: DecisionDeps = {}): Promise<Response> {
  const pre = preflight(req, deps);
  if (pre instanceof Response) return pre;
  const { cfg } = pre;
  try {
    // Same-origin only: the browser must have sent OUR origin. A missing Origin is refused (fetch() POSTs always carry one).
    if (req.headers.get('origin') !== cfg.baseUrl || isBrowserCrossSite(req.headers)) throw new OAuthError('invalid_request', 'Cross-site requests are not accepted.', 403);
    if (!hasContentType(req.headers, 'application/json')) throw new OAuthError('invalid_request', 'Content-Type must be application/json.', 415);
    const session = (deps.session ?? ((r: Request) => getSessionFromCookie(r.headers.get('cookie'))))(req);
    if (!session) throw new OAuthError('access_denied', 'Sign in again.', 401);

    let body: { consent?: unknown; decision?: unknown };
    try { body = JSON.parse(await readLimitedText(req, 8 * 1024)); } catch (e) { throw e instanceof OAuthError ? e : new OAuthError('invalid_request', 'Body must be JSON.'); }
    if (!body || typeof body !== 'object' || (body.decision !== 'approve' && body.decision !== 'deny')) throw new OAuthError('invalid_request', 'Invalid decision.');

    const secret = deps.secret ?? (await import('../../team/env')).sessionSecret();
    const now = (deps.now ?? Date.now)();
    const c = verifyConsent(body.consent, secret, now);
    if (!c || c.uid !== session.userId || c.sia !== session.issuedAt) throw new OAuthError('invalid_request', 'This consent request has expired. Reload the page and try again.');

    const pool = pre.pool();
    await limited(pool, `consent:${c.uid}`, 30, 600);

    const client = await getClient(pool, c.cid);
    if (!client || !clientAllowsRedirect(client, c.ru, { allowLoopback: cfg.allowLoopback }) || c.rs !== cfg.resource) throw new OAuthError('invalid_request', 'This authorization request is no longer valid.');

    const elig = evaluateGrantEligibility(session, await loadGrantUser(pool, c.uid), now);
    if (!elig.ok && elig.reason === 'login_not_recent') {
      // The page asked for a fresh login, but time passed before the click. Not an attack: no audit row, just ask again.
      return Response.json({ error: 'login_required', error_description: INELIGIBLE_MESSAGE.login_not_recent }, { status: 401, headers: NO_STORE_HEADERS });
    }
    if (!elig.ok) {
      await withMcpTx(pool, (tx) => audit(tx, 'access_denied', c.uid, 'oauth_client', c.cid, { reason: elig.reason }));
      throw new OAuthError('access_denied', INELIGIBLE_MESSAGE[elig.reason], 403);
    }

    if (body.decision === 'deny') {
      await withMcpTx(pool, (tx) => audit(tx, 'authorization_denied', c.uid, 'oauth_client', c.cid));
      return Response.json({ redirect: buildRedirect(c.ru, { error: 'access_denied', state: c.st, iss: cfg.baseUrl }) }, { headers: NO_STORE_HEADERS });
    }
    const code = await createAuthorizationCode(pool, { clientId: c.cid, userId: c.uid, redirectUri: c.ru, codeChallenge: c.cc, resource: c.rs, scope: c.sc });
    return Response.json({ redirect: buildRedirect(c.ru, { code, state: c.st, iss: cfg.baseUrl }) }, { headers: NO_STORE_HEADERS });
  } catch (e) { return e instanceof OAuthError ? oauthErrorResponse(e) : fail(e); }
}

// ── GET /oauth/reauthenticate ─────────────────────────────────────────────────────────────────────────────────────────────────


/**
 * Step between "logged in too long ago" and the login form. app/page.tsx sends any logged-in admin straight to /team, so the stale session
 * cookie has to be cleared first. Only acts on a session that is VALID but older than the recency window; every other case just forwards.
 * `returnTo` must pass safeReturnTo (exactly /oauth/authorize?…), so this can neither redirect off-site nor clear a cookie for any other purpose
 * than re-login. A cross-site link that triggers it can at worst make an admin sign in again (logout-CSRF with no data impact).
 */
export function handleReauthenticate(req: Request, deps: DecisionDeps = {}): Response {
  const pre = preflight(req, deps);
  if (pre instanceof Response) return pre;
  const returnTo = safeReturnTo(new URL(req.url).searchParams.get('returnTo'));
  if (!returnTo) return new Response(null, { status: 404, headers: NO_STORE_HEADERS });
  const session = (deps.session ?? ((r: Request) => getSessionFromCookie(r.headers.get('cookie'))))(req);
  const now = (deps.now ?? Date.now)();
  const headers = new Headers(NO_STORE_HEADERS);
  if (session && now - session.issuedAt <= GRANT_MAX_LOGIN_AGE_MS) {
    headers.set('Location', returnTo); // already fresh: nothing to do
  } else {
    if (session) {
      const secure = pre.cfg.baseUrl.startsWith('https:') ? '; Secure' : '';
      headers.append('Set-Cookie', `app_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure}`);
    }
    headers.set('Location', `/?returnTo=${encodeURIComponent(returnTo)}`);
  }
  return new Response(null, { status: 303, headers });
}
