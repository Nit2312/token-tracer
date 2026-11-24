/** DB-free tests of the OAuth HTTP layer: configuration, canonical-host rule, discovery documents, preflight and header checks. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isCanonicalHost, loadOAuthConfig } from '../lib/mcp/oauth/config';
import { authorizationServerMetadata, protectedResourceMetadata, resourceMetadataUrl } from '../lib/mcp/oauth/metadata';
import { handleAuthorizationServerMetadata, handleProtectedResourceMetadata, handleRegister, handleRevoke, handleToken } from '../lib/mcp/oauth/endpoints';
import { parseForm, readLimitedText, clientIpKey } from '../lib/mcp/oauth/http';

const BASE = 'https://token-tracer-three.vercel.app';
const cfg = loadOAuthConfig({ MCP_PUBLIC_BASE_URL: BASE, NODE_ENV: 'production' })!;
const noDb = () => { throw new Error('the database must not be touched'); };
const deps = { enabled: true, config: cfg, pool: noDb as never };
const req = (url: string, init: RequestInit & { host?: string } = {}) => {
  const { host = cfg.host, ...rest } = init;
  return new Request(url, { ...rest, headers: { host, ...(rest.headers as Record<string, string>) } });
};
const json = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null), h: r.headers });

describe('loadOAuthConfig', () => {
  it('accepts only a clean https origin (or http on localhost outside production)', () => {
    assert.equal(cfg.baseUrl, BASE); assert.equal(cfg.resource, `${BASE}/mcp`); assert.equal(cfg.host, 'token-tracer-three.vercel.app'); assert.equal(cfg.allowLoopback, true);
    assert.equal(loadOAuthConfig({ MCP_PUBLIC_BASE_URL: `${BASE}/` })!.baseUrl, BASE);
    for (const bad of [undefined, '', 'not a url', 'http://token-tracer-three.vercel.app', `${BASE}/mcp`, `${BASE}?x=1`, `${BASE}#f`, 'https://u:p@token-tracer-three.vercel.app', 'ftp://x.example', 'javascript:alert(1)']) {
      assert.equal(loadOAuthConfig({ MCP_PUBLIC_BASE_URL: bad }), null, String(bad));
    }
    assert.equal(loadOAuthConfig({ MCP_PUBLIC_BASE_URL: 'http://localhost:3000', NODE_ENV: 'development' })!.host, 'localhost:3000');
    assert.equal(loadOAuthConfig({ MCP_PUBLIC_BASE_URL: 'http://localhost:3000', NODE_ENV: 'production' }), null);
    assert.equal(loadOAuthConfig({ MCP_PUBLIC_BASE_URL: BASE, MCP_ALLOW_LOOPBACK_REDIRECTS: 'false' })!.allowLoopback, false);
  });
  it('does NOT fall back to NEXT_PUBLIC_SERVER_URL or any request-derived value', () => {
    assert.equal(loadOAuthConfig({ NEXT_PUBLIC_SERVER_URL: BASE }), null);
  });
});

describe('isCanonicalHost', () => {
  it('requires every present host header to equal the canonical host', () => {
    assert.equal(isCanonicalHost(new Headers({ host: cfg.host }), cfg), true);
    assert.equal(isCanonicalHost(new Headers({ host: cfg.host.toUpperCase(), 'x-forwarded-host': cfg.host }), cfg), true);
    assert.equal(isCanonicalHost(new Headers({ host: 'token-tracer-puce.vercel.app' }), cfg), false); // the other deployment alias
    assert.equal(isCanonicalHost(new Headers({ host: cfg.host, 'x-forwarded-host': 'evil.example' }), cfg), false);
    assert.equal(isCanonicalHost(new Headers({ host: 'evil.example', 'x-forwarded-host': cfg.host }), cfg), false);
    assert.equal(isCanonicalHost(new Headers({ host: `${cfg.host}:8443` }), cfg), false);
    assert.equal(isCanonicalHost(new Headers({ host: `${cfg.host}, evil.example` }), cfg), false);
    assert.equal(isCanonicalHost(new Headers(), cfg), false);
  });
});

describe('discovery documents', () => {
  it('authorization server metadata: canonical issuer and endpoints, S256 only, public clients only, CIMD off, no secrets', () => {
    const m = authorizationServerMetadata(cfg);
    assert.equal(m.issuer, BASE);
    for (const k of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'revocation_endpoint'] as const) assert.ok(m[k].startsWith(`${BASE}/oauth/`), k);
    assert.deepEqual(m.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(m.token_endpoint_auth_methods_supported, ['none']);
    assert.deepEqual(m.grant_types_supported, ['authorization_code', 'refresh_token']);
    assert.deepEqual(m.response_types_supported, ['code']);
    assert.deepEqual(m.scopes_supported, ['mcp:read', 'offline_access']);
    assert.equal(m.client_id_metadata_document_supported, false);
  });
  it('protected resource metadata: resource is the MCP URL, points at this authorization server, only mcp:read', () => {
    const m = protectedResourceMetadata(cfg);
    assert.deepEqual([m.resource, m.authorization_servers, m.scopes_supported, m.bearer_methods_supported], [`${BASE}/mcp`, [BASE], ['mcp:read'], ['header']]);
    assert.equal(resourceMetadataUrl(cfg), `${BASE}/.well-known/oauth-protected-resource/mcp`);
  });
  it('metadata handlers serve the canonical document even when the request URL says otherwise; the Host check still applies', async () => {
    const ok = await json(handleAuthorizationServerMetadata(req('https://x/.well-known/oauth-authorization-server'), deps));
    assert.equal(ok.status, 200); assert.equal(ok.body.issuer, BASE); assert.equal(ok.h.get('access-control-allow-origin'), '*');
    assert.equal((await json(handleProtectedResourceMetadata(req('https://x/'), deps))).body.resource, `${BASE}/mcp`);
    assert.equal(handleAuthorizationServerMetadata(req('https://x/', { host: 'evil.example' }), deps).status, 404);
    assert.equal(handleProtectedResourceMetadata(req('https://x/', { host: 'token-tracer-puce.vercel.app' }), deps).status, 404);
  });
});

describe('preflight: flag, configuration, host', () => {
  it('flag off → 404 everywhere; invalid config → 503 (fail closed); non-canonical host → 404; none of them touch the database', async () => {
    const post = (host?: string) => req('https://x/oauth/token', { method: 'POST', host });
    for (const h of [handleToken, handleRegister, handleRevoke]) {
      assert.equal((await h(post(), { ...deps, enabled: false })).status, 404);
      const r = await h(post(), { ...deps, config: null });
      assert.deepEqual([r.status, (await r.json()).error], [503, 'temporarily_unavailable']);
      assert.equal((await h(post('evil.example'), deps)).status, 404);
    }
    assert.equal(handleAuthorizationServerMetadata(req('https://x/'), { ...deps, enabled: false }).status, 404);
    assert.equal(handleProtectedResourceMetadata(req('https://x/'), { ...deps, config: null }).status, 503);
  });
});

describe('request-shape checks run before any database work', () => {
  const form = { 'content-type': 'application/x-www-form-urlencoded' };
  it('register: cross-site browser requests and wrong content types are refused', async () => {
    const a = await json(await handleRegister(req('https://x/', { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: '{}' }), deps));
    assert.deepEqual([a.status, a.body.error], [403, 'invalid_request']);
    const b = await json(await handleRegister(req('https://x/', { method: 'POST', headers: form, body: 'a=b' }), deps));
    assert.deepEqual([b.status, b.body.error], [415, 'invalid_client_metadata']);
  });
  it('token / revoke: cross-site, Authorization header (confidential-client attempts) and wrong content types are refused', async () => {
    for (const h of [handleToken, handleRevoke]) {
      const a = await json(await h(req('https://x/', { method: 'POST', headers: { ...form, 'sec-fetch-site': 'cross-site' }, body: 'x=1' }), deps));
      assert.deepEqual([a.status, a.body.error], [403, 'invalid_request']);
      const b = await json(await h(req('https://x/', { method: 'POST', headers: { ...form, authorization: 'Basic eDp5' }, body: 'x=1' }), deps));
      assert.deepEqual([b.status, b.body.error], [401, 'invalid_client']);
      const c = await json(await h(req('https://x/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), deps));
      assert.deepEqual([c.status, c.body.error], [415, 'invalid_request']);
      assert.equal(a.h.get('cache-control'), 'no-store');
    }
  });
});

describe('http helpers', () => {
  it('parseForm rejects repeated parameters; readLimitedText enforces the size cap with and without Content-Length', async () => {
    assert.equal(parseForm('a=1&b=2').get('b'), '2');
    assert.throws(() => parseForm('a=1&a=2'));
    await assert.rejects(readLimitedText(new Request('https://x/', { method: 'POST', body: 'x'.repeat(100) }), 50));
    await assert.rejects(readLimitedText(new Request('https://x/', { method: 'POST', headers: { 'content-length': '999' }, body: 'x' }), 50));
    assert.equal(await readLimitedText(new Request('https://x/', { method: 'POST', body: 'ok' }), 50), 'ok');
    await assert.rejects(readLimitedText(new Request('https://x/', { method: 'POST', body: new Uint8Array([0xff, 0xfe, 0xfd]) }), 50));
  });
  it('clientIpKey is a salted hash (never the raw IP) and stable', () => {
    process.env.SESSION_SECRET ||= 'test-secret';
    const k = clientIpKey(new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }));
    assert.ok(!k.includes('203.0.113') && k.length === 32);
    assert.equal(k, clientIpKey(new Headers({ 'x-real-ip': '203.0.113.7' })));
  });
});

describe('static: URLs are never derived from the request', () => {
  const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  it('only config.ts looks at Host headers; metadata and endpoints never read the request URL or Host', () => {
    for (const f of ['lib/mcp/oauth/metadata.ts', 'lib/mcp/oauth/endpoints.ts', 'lib/mcp/oauth/http.ts']) assert.doesNotMatch(read(f), /headers\.get\(\s*['"](x-forwarded-host|host)['"]|req(uest)?\.url|nextUrl/i, f);
    assert.match(read('lib/mcp/oauth/config.ts'), /x-forwarded-host/);
  });
  it('route files only delegate to the handlers and are dynamic', () => {
    for (const f of ['app/oauth/register/route.ts', 'app/oauth/token/route.ts', 'app/oauth/revoke/route.ts', 'app/.well-known/oauth-authorization-server/route.ts',
      'app/.well-known/oauth-protected-resource/route.ts', 'app/.well-known/oauth-protected-resource/mcp/route.ts']) {
      const c = read(f);
      assert.match(c, /from '@\/lib\/mcp\/oauth\/endpoints'/, f); assert.match(c, /dynamic = 'force-dynamic'/, f); assert.match(c, /runtime = 'nodejs'/, f);
      assert.doesNotMatch(c, /process\.env|getMcpPool|new URL/, f);
    }
  });
});
