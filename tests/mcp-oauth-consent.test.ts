/** DB-free tests for the consent step: consent token, authorize-request parsing, eligibility rule, redirect building, and static guards. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CONSENT_TTL_MS, signConsent, verifyConsent, type ConsentClaims } from '../lib/mcp/oauth/consent';
import { buildRedirect, flattenQuery, parseClientAndRedirect, parseRest } from '../lib/mcp/oauth/authorize-request';
import { evaluateGrantEligibility, type GrantUser } from '../lib/mcp/oauth/grant-user';
import { decodeSessionToken, encodeSessionToken, signObject, type SessionPayload } from '../lib/session-token';
import { s256Challenge } from '../lib/mcp/oauth/crypto';

const SECRET = 'unit-test-secret-0123456789';
const NOW = 1_800_000_000_000;
const claims: Omit<ConsentClaims, 'ex'> = { uid: '11111111-1111-4111-8111-111111111111', sia: NOW - 1000, cid: 'tt_abcdefghijklmnop', ru: 'https://claude.ai/api/mcp/auth_callback', cc: s256Challenge('v'.repeat(43)), sc: 'mcp:read', st: 'xyz', rs: 'https://token-tracer-three.vercel.app/mcp' };

describe('consent token', () => {
  it('round-trips, expires after 5 minutes, and rejects tampering and a different secret', () => {
    const t = signConsent(claims, SECRET, NOW);
    assert.deepEqual(verifyConsent(t, SECRET, NOW + 1000), { ...claims, ex: NOW + CONSENT_TTL_MS });
    assert.equal(verifyConsent(t, SECRET, NOW + CONSENT_TTL_MS + 1), null);
    assert.equal(verifyConsent(t, 'another-secret-0123456789', NOW), null);
    const [b64, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims, uid: '22222222-2222-4222-8222-222222222222', ex: NOW + CONSENT_TTL_MS })).toString('base64url');
    assert.equal(verifyConsent(`${forged}.${sig}`, SECRET, NOW), null);
    assert.equal(verifyConsent(`${b64}.${sig.slice(0, -2)}AA`, SECRET, NOW), null);
    for (const junk of [undefined, null, 5, '', '.', 'a.b', 'x'.repeat(5000), {}]) assert.equal(verifyConsent(junk, SECRET, NOW), null);
  });
  it('a token cannot be used before it was issued (clock check) and a null state round-trips', () => {
    assert.equal(verifyConsent(signConsent(claims, SECRET, NOW), SECRET, NOW - 10 * CONSENT_TTL_MS), null);
    assert.equal(verifyConsent(signConsent({ ...claims, st: null }, SECRET, NOW), SECRET, NOW)?.st, null);
  });
  it('is NOT interchangeable with a session cookie, in either direction', () => {
    process.env.SESSION_SECRET = SECRET;
    const consent = signConsent(claims, SECRET, Date.now());
    assert.equal(decodeSessionToken(consent), null); // a consent token is not a session
    const session: SessionPayload = { userId: claims.uid, username: 'u', displayName: 'U', role: 'admin', memberId: null, teamId: 't', issuedAt: Date.now(), mfa: true };
    assert.ok(decodeSessionToken(encodeSessionToken(session)));
    assert.equal(verifyConsent(encodeSessionToken(session), SECRET, Date.now()), null); // a session is not a consent
    assert.equal(verifyConsent(signObject({ ...claims, ex: Date.now() + 1000 }), SECRET, Date.now()), null); // even signed with the raw session key
  });
});

describe('authorize request parsing', () => {
  const valid = { client_id: 'tt_abcdefghijklmnop', redirect_uri: 'https://claude.ai/api/mcp/auth_callback', response_type: 'code', code_challenge: s256Challenge('v'.repeat(43)), code_challenge_method: 'S256', state: 'st-1', scope: 'mcp:read offline_access' };
  const RES = 'https://token-tracer-three.vercel.app/mcp';
  const rest = (over: Record<string, string | undefined>) => {
    const q = flattenQuery({ ...valid, ...over })!; const base = parseClientAndRedirect(q)!;
    return parseRest(q, base, RES);
  };
  it('accepts a valid request, defaults scope, strips offline_access, and pins the canonical resource', () => {
    const r = rest({}); assert.ok(r.ok); if (r.ok) assert.deepEqual([r.params.scope, r.params.state, r.params.resource], ['mcp:read', 'st-1', RES]);
    assert.ok(rest({ scope: undefined }).ok); assert.ok(rest({ state: undefined }).ok); assert.ok(rest({ resource: RES }).ok);
  });
  it('phase 1: unusable client_id / redirect_uri / repeated parameters are fatal (null), never redirectable', () => {
    assert.equal(flattenQuery({ client_id: ['a', 'b'] }), null);
    for (const q of [{}, { client_id: 'x' }, { client_id: 'tt_ok_client', redirect_uri: undefined }, { client_id: 'bad id!', redirect_uri: 'https://claude.ai/x' }, { client_id: 'tt_ok_client', redirect_uri: 'x'.repeat(3000) }]) {
      assert.equal(parseClientAndRedirect(flattenQuery(q)!), null, JSON.stringify(q).slice(0, 60));
    }
  });
  it('phase 2: every other defect becomes an OAuth error; state is echoed only when it is itself valid', () => {
    const e = (over: Record<string, string | undefined>) => { const r = rest(over); return r.ok ? 'ok' : `${r.error}|${r.state}`; };
    assert.equal(e({ response_type: 'token' }), 'invalid_request|st-1');
    assert.equal(e({ code_challenge: undefined }), 'invalid_request|st-1');
    assert.equal(e({ code_challenge: 'short' }), 'invalid_request|st-1');
    assert.equal(e({ code_challenge_method: 'plain' }), 'invalid_request|st-1');
    assert.equal(e({ code_challenge_method: undefined }), 'invalid_request|st-1');
    assert.equal(e({ scope: 'mcp:write' }), 'invalid_scope|st-1');
    assert.equal(e({ resource: 'https://evil.example/mcp' }), 'invalid_target|st-1');
    assert.equal(e({ state: 'bad\nstate' }), 'invalid_request|null');
    assert.equal(e({ state: 'x'.repeat(513) }), 'invalid_request|null');
  });
  it('buildRedirect appends parameters to the verified URI and drops empty ones', () => {
    assert.equal(buildRedirect('https://claude.ai/api/mcp/auth_callback', { code: 'c', state: 's', iss: 'https://i' }), 'https://claude.ai/api/mcp/auth_callback?code=c&state=s&iss=https%3A%2F%2Fi');
    assert.equal(buildRedirect('http://localhost:5555/callback', { error: 'access_denied', state: null }), 'http://localhost:5555/callback?error=access_denied');
    assert.ok(buildRedirect('https://claude.ai/api/mcp/auth_callback', { state: 'a&b=c#d' }).includes('state=a%26b%3Dc%23d')); // state cannot inject parameters
  });
});

describe('eligibility', () => {
  const uid = '11111111-1111-4111-8111-111111111111'; const team = '22222222-2222-4222-8222-222222222222';
  const session = (o: Partial<SessionPayload> = {}): SessionPayload => ({ userId: uid, username: 'a', displayName: 'A', role: 'admin', memberId: null, teamId: team, issuedAt: 1, mfa: true, ...o });
  const user = (o: Partial<GrantUser> = {}): GrantUser => ({ id: uid, displayName: 'A', role: 'admin', teamId: team, teamName: 'T', active: true, ...o });
  const why = (s: SessionPayload, u: GrantUser | null) => { const r = evaluateGrantEligibility(s, u); return r.ok ? 'ok' : r.reason; };
  it('only a DB admin with a team, MFA-complete, not impersonating, still active, and consistent with the database qualifies', () => {
    assert.equal(why(session(), user()), 'ok');
    assert.equal(why(session({ userId: 'admin' }), user()), 'builtin_account');
    assert.equal(why(session({ userId: 'superadmin', role: 'superadmin' }), null), 'builtin_account');
    assert.equal(why(session({ impersonatedBy: 'sa' }), user()), 'impersonation');
    assert.equal(why(session({ role: 'user' }), user()), 'not_admin');
    assert.equal(why(session({ role: 'superadmin' }), user()), 'not_admin');
    assert.equal(why(session({ mfa: false }), user()), 'no_mfa');
    assert.equal(why(session(), null), 'inactive');
    assert.equal(why(session(), user({ active: false })), 'inactive');
    assert.equal(why(session(), user({ role: 'user' })), 'not_admin'); // demoted since login: the DATABASE decides
    assert.equal(why(session(), user({ teamId: null })), 'no_team');
    assert.equal(why(session(), user({ teamId: '33333333-3333-4333-8333-333333333333' })), 'stale_session');
  });
});

describe('static guards on the consent UI and the login hook', () => {
  const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), 'utf8');
  it('the consent page and form render attacker-controlled text only as escaped React text', () => {
    for (const f of ['app/oauth/authorize/page.tsx', 'app/oauth/authorize/consent-form.tsx']) assert.doesNotMatch(read(f), /dangerouslySetInnerHTML|innerHTML|eval\(|new Function/, f);
    assert.match(read('app/oauth/authorize/consent-form.tsx'), /fetch\('\/oauth\/decision'/); // fetch, because CSP form-action is 'self'
    assert.doesNotMatch(read('app/oauth/authorize/consent-form.tsx'), /<form/);
  });
  it('the page never redirects before the client and redirect_uri are verified (all logic lives in prepareAuthorize)', () => {
    const page = read('app/oauth/authorize/page.tsx');
    assert.match(page, /prepareAuthorize/); assert.doesNotMatch(page, /searchParams\)?\.(redirect_uri|client_id)|sp\.redirect_uri/);
    const lib = read('lib/mcp/oauth/authorize.ts');
    assert.ok(lib.indexOf('clientAllowsRedirect') < lib.indexOf("kind: 'redirect'"));
  });
  it('the login route honours returnTo only for database users, and only through safeReturnTo', () => {
    const src = read('app/api/auth/login/route.ts');
    const uses = [...src.matchAll(/returnTo/g)].length;
    assert.equal([...src.matchAll(/safeReturnTo\(body\.returnTo\)/g)].length, 1);
    assert.ok(uses >= 2);
    assert.ok(src.indexOf('safeReturnTo(body.returnTo)') > src.indexOf('// ── Database users'));
    assert.ok(src.indexOf('safeReturnTo(body.returnTo)') > src.indexOf("username === 'superadmin'")); // after both built-in branches
  });
  it('the decision route delegates to handleDecision and the authorize page is dynamic', () => {
    assert.match(read('app/oauth/decision/route.ts'), /handleDecision/); assert.match(read('app/oauth/authorize/page.tsx'), /dynamic = 'force-dynamic'/);
  });
});
