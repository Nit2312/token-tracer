/** Phase 2 step 2: pure OAuth building blocks (PKCE, secrets, redirect rules, scopes, return-URL). No DB, no network. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateSecret, generateClientId, sha256, looksLikeSecret, verifyPkce, s256Challenge, isValidCodeChallenge, isValidCodeVerifier,
  ACCESS_TOKEN_PREFIX, REFRESH_TOKEN_PREFIX, AUTH_CODE_PREFIX,
} from '../lib/mcp/oauth/crypto';
import { classifyRedirectUri, validateRedirectUris, redirectUriMatches, MAX_REDIRECT_URIS } from '../lib/mcp/oauth/redirect-rules';
import { normalizeScope, hasScope } from '../lib/mcp/oauth/scopes';
import { OAuthError, oauthErrorResponse, toOAuthError } from '../lib/mcp/oauth/errors';
import { safeReturnTo } from '../lib/security/return-url';

describe('secrets', () => {
  it('generates 256-bit prefixed values, unique, and recognises only that shape', () => {
    const a = generateSecret(ACCESS_TOKEN_PREFIX), b = generateSecret(ACCESS_TOKEN_PREFIX);
    assert.notEqual(a, b);
    assert.ok(looksLikeSecret(a, ACCESS_TOKEN_PREFIX));
    assert.equal(looksLikeSecret(a, REFRESH_TOKEN_PREFIX), false, 'wrong kind');
    assert.equal(looksLikeSecret(a + 'x', ACCESS_TOKEN_PREFIX), false);
    assert.equal(looksLikeSecret(a.slice(0, -1), ACCESS_TOKEN_PREFIX), false);
    assert.equal(looksLikeSecret(`${AUTH_CODE_PREFIX}${'!'.repeat(43)}`, AUTH_CODE_PREFIX), false);
    assert.equal(looksLikeSecret(undefined, ACCESS_TOKEN_PREFIX), false);
  });
  it('hashes deterministically to 32 bytes and never returns the input', () => {
    const s = generateSecret(ACCESS_TOKEN_PREFIX);
    assert.equal(sha256(s).length, 32);
    assert.deepEqual(sha256(s), sha256(s));
    assert.ok(!sha256(s).toString('hex').includes(s));
  });
  it('client ids are public identifiers with the tt_ prefix', () => assert.match(generateClientId(), /^tt_[A-Za-z0-9_-]{22}$/));
});

describe('PKCE S256', () => {
  // RFC 7636 Appendix B test vector
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  it('matches the RFC 7636 vector', () => { assert.equal(s256Challenge(verifier), challenge); assert.ok(verifyPkce(verifier, challenge)); });
  it('rejects wrong, short, long, non-string and charset-violating verifiers', () => {
    assert.equal(verifyPkce(verifier + 'x', challenge), false);
    assert.equal(verifyPkce('short', challenge), false);
    assert.equal(verifyPkce('a'.repeat(129), s256Challenge('a'.repeat(129))), false);
    assert.equal(verifyPkce(undefined, challenge), false);
    assert.equal(verifyPkce(verifier.replace('-', '+'), challenge), false);
    assert.equal(isValidCodeVerifier('a'.repeat(43)), true);
    assert.equal(isValidCodeVerifier('a'.repeat(42)), false);
  });
  it('rejects a plain-style or malformed stored challenge', () => {
    assert.equal(verifyPkce(verifier, verifier), false);
    assert.equal(isValidCodeChallenge(challenge), true);
    assert.equal(isValidCodeChallenge(challenge + '='), false);
    assert.equal(isValidCodeChallenge(''), false);
  });
});

describe('redirect URI rules', () => {
  const ok = [
    'https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback',
    'http://localhost:54321/callback', 'http://127.0.0.1:8080/callback', 'http://[::1]:3000/callback', 'http://localhost/callback',
  ];
  const bad = [
    'https://claude.ai/api/mcp/auth_callback/', 'https://claude.ai/api/mcp/auth_callback?x=1', 'https://claude.ai/api/mcp/auth_callback#f',
    'https://CLAUDE.ai/api/mcp/auth_callback', 'http://claude.ai/api/mcp/auth_callback', 'https://claude.ai.evil.com/api/mcp/auth_callback',
    'https://evil.com/api/mcp/auth_callback', 'https://user@claude.ai/api/mcp/auth_callback', 'https://claude.ai:444/api/mcp/auth_callback',
    'https://*.claude.ai/api/mcp/auth_callback', 'https://claude.ai/api/mcp/auth_callback ', ' https://claude.ai/api/mcp/auth_callback',
    'https://claude.ai\\api/mcp/auth_callback', 'https://claude.ai/api/mcp/auth_callback\n',
    'https://localhost:8080/callback', 'http://localhost.evil.com/callback', 'http://evil.localhost/callback', 'http://127.0.0.2/callback',
    'http://0.0.0.0/callback', 'http://localhost:8080/other', 'http://localhost:8080/callback/', 'http://localhost:8080/callback?a=b',
    'http://localhost:8080/callback#a', 'http://u:p@localhost:8080/callback', 'http://localhost:0/callback', 'http://localhost:080/callback',
    'http://localhost:99999/callback', 'HTTP://localhost:8080/callback', 'http://[::ffff:127.0.0.1]:80/callback', 'http://2130706433/callback',
    'myapp://callback', 'javascript:alert(1)', 'data:text/html,x', 'file:///callback', '', '/callback', '//claude.ai/callback',
    'http://localhost:65536/callback', 'http://localhost:99999/callback', 'http://localhost:0/callback',
  ];
  for (const u of ok) it(`accepts ${u}`, () => assert.ok(classifyRedirectUri(u)));
  for (const u of bad) it(`rejects ${JSON.stringify(u)}`, () => assert.equal(classifyRedirectUri(u), null));
  it('non-strings are rejected', () => { for (const v of [null, undefined, 1, {}, []]) assert.equal(classifyRedirectUri(v), null); });
  it('loopback can be switched off while hosted stays valid', () => {
    assert.equal(classifyRedirectUri('http://localhost:1/callback', { allowLoopback: false }), null);
    assert.equal(classifyRedirectUri('https://claude.ai/api/mcp/auth_callback', { allowLoopback: false }), 'hosted');
  });
  it('validates the whole array: size, duplicates, one bad entry poisons all', () => {
    assert.equal(validateRedirectUris([]).ok, false);
    assert.equal(validateRedirectUris('https://claude.ai/api/mcp/auth_callback').ok, false);
    assert.equal(validateRedirectUris(Array.from({ length: MAX_REDIRECT_URIS + 1 }, (_, i) => `http://localhost:${3000 + i}/callback`)).ok, false);
    assert.equal(validateRedirectUris([ok[0], 'https://evil.com/x']).ok, false);
    const v = validateRedirectUris([ok[0], ok[0], ok[2]]);
    assert.ok(v.ok && v.uris.length === 2 && v.hasLoopback);
    assert.equal(validateRedirectUris([ok[0]]).hasLoopback, false);
  });
  it('authorization-time match is exact', () => {
    const reg = ['http://localhost:5000/callback', 'https://claude.ai/api/mcp/auth_callback'];
    assert.ok(redirectUriMatches(reg, 'http://localhost:5000/callback'));
    assert.ok(redirectUriMatches(reg, 'http://localhost:5001/callback'), 'loopback: port ignored (OAuth 2.1 / RFC 8252)');
    assert.ok(redirectUriMatches(['http://localhost/callback'], 'http://localhost:61234/callback'), 'registered without port (Claude Code metadata)');
    assert.equal(redirectUriMatches(reg, 'http://127.0.0.1:5000/callback'), false, 'localhost != 127.0.0.1');
    assert.equal(redirectUriMatches(reg, 'http://localhost:5000/other'), false);
    assert.equal(redirectUriMatches(['http://localhost:5000/callback'], 'https://claude.ai/api/mcp/auth_callback'), false, 'hosted needs an exact registered entry');
    assert.equal(redirectUriMatches(reg, 'https://claude.ai/api/mcp/auth_callback/'), false);
    assert.equal(redirectUriMatches(reg, undefined), false);
    assert.equal(redirectUriMatches(reg, 'http://localhost:5000/callback', { allowLoopback: false }), false, 'kill switch applies to existing clients');
  });
});

describe('scopes', () => {
  it('defaults, dedupes and refuses unknown scopes', () => {
    assert.equal(normalizeScope(undefined), 'mcp:read');
    assert.equal(normalizeScope(''), 'mcp:read');
    assert.equal(normalizeScope('mcp:read mcp:read'), 'mcp:read');
    assert.equal(normalizeScope('mcp:read mcp:write'), null);
    assert.equal(normalizeScope('openid'), null);
    assert.equal(normalizeScope('mcp:read offline_access'), 'mcp:read', 'offline_access accepted, never stored');
    assert.equal(normalizeScope('offline_access'), 'mcp:read');
    assert.ok(hasScope('mcp:read', 'mcp:read'));
    assert.equal(hasScope('mcp:readx', 'mcp:read'), false);
  });
});

describe('errors', () => {
  it('serialises RFC 6749 JSON with no-store and hides unexpected errors', async () => {
    const r = oauthErrorResponse(new OAuthError('invalid_grant', 'The grant is invalid.'));
    assert.equal(r.status, 400);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await r.json(), { error: 'invalid_grant', error_description: 'The grant is invalid.' });
    const e = toOAuthError(new Error('connection to postgres://secret failed'));
    assert.equal(e.code, 'server_error'); assert.equal(e.status, 503);
    assert.ok(!JSON.stringify([e.message, e.description]).includes('postgres'));
  });
});

describe('safeReturnTo (open-redirect defence)', () => {
  const good = '/oauth/authorize?response_type=code&client_id=tt_abc&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&state=x';
  it('accepts only the authorize path with a query', () => {
    assert.equal(safeReturnTo(good), good);
    assert.equal(safeReturnTo('/oauth/authorize'), '/oauth/authorize');
  });
  const bad = [
    '//evil.com', '//evil.com/oauth/authorize', '/\\evil.com', '/\\/evil.com', 'https://evil.com/oauth/authorize', 'http://localhost/oauth/authorize',
    'javascript:alert(1)', 'data:text/html,x', 'oauth/authorize', '', '/', '/team', '/admin', '/oauth/authorize/', '/oauth/authorizex',
    '/OAuth/authorize', '/oauth/./authorize', '/oauth/../oauth/authorize', '/oauth/%2e/authorize', '/oauth/%2E%2E/oauth/authorize',
    '/oauth%2fauthorize', '/oauth/authorize%2f..%2f..', '/oauth/authorize%5c', '/oauth/authorize#frag', '/oauth/authorize?x=1#frag',
    '/oauth/authorize\n', '/oauth/authorize\r\nLocation: https://evil.com', '/oauth/authorize\u0000', ' /oauth/authorize', '/oauth/authorize ',
    '/oauth//authorize', '/oauth/authorize;x', `/oauth/authorize?${'a'.repeat(3000)}`, '/api/auth/login',
  ];
  for (const v of bad) it(`rejects ${JSON.stringify(v.length > 60 ? v.slice(0, 60) + '…' : v)}`, () => assert.equal(safeReturnTo(v), null));
  it('non-strings are rejected', () => { for (const v of [null, undefined, 5, {}, ['/oauth/authorize']]) assert.equal(safeReturnTo(v), null); });
});
