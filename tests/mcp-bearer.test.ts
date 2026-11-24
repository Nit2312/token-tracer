/** DB-free tests of /mcp bearer authentication (Step 7): header parsing, the exact challenge, check order, per-request principal, no caching, no leaks. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/server';
import { handleMcpRequest, type McpDeps } from '../lib/mcp/handler';
import { authenticateRequest, challenge, parseAuthorization } from '../lib/mcp/bearer';
import { MCP_MAX_BODY_BYTES, type McpConfig } from '../lib/mcp/config';
import type { OAuthConfig } from '../lib/mcp/oauth/config';
import type { McpPrincipal } from '../lib/mcp/oauth/principal';

const logs: string[] = [];
console.warn = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };

const HOST = 'token-tracer-three.vercel.app';
const OAUTH: OAuthConfig = { baseUrl: `https://${HOST}`, host: HOST, resource: `https://${HOST}/mcp`, allowLoopback: true };
const CFG: McpConfig = { enabled: true, allowedHosts: [HOST, 'other.example'], allowedOriginHostnames: ['claude.ai', HOST], maxBodyBytes: MCP_MAX_BODY_BYTES };
const META = `https://${HOST}/.well-known/oauth-protected-resource/mcp`;
const tok = (c: string) => `tt_at_${c.repeat(43)}`;
const P = (over: Partial<McpPrincipal> = {}): McpPrincipal => ({ userId: 'u-1', clientId: 'tt_c', tokenId: 't-1', scope: 'mcp:read', role: 'admin', teamId: 'team-1', displayName: 'A', ...over });
const PING = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
const call = (headers: Record<string, string>, deps: McpDeps, o: { url?: string; method?: string; cfg?: McpConfig } = {}) =>
  handleMcpRequest(new Request(o.url ?? `https://${HOST}/mcp`, { method: o.method ?? 'POST', headers: { host: HOST, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: (o.method ?? 'POST') === 'POST' ? PING : undefined }), o.cfg ?? CFG, deps);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe('Authorization header parsing', () => {
  it('only "Bearer <one token>" yields a token; other schemes count as no credentials; malformed Bearer headers are invalid', () => {
    assert.deepEqual(parseAuthorization(`Bearer ${tok('a')}`), { kind: 'bearer', token: tok('a') });
    assert.deepEqual(parseAuthorization(`bearer ${tok('a')}`), { kind: 'bearer', token: tok('a') });
    assert.deepEqual(parseAuthorization(`BEARER ${tok('a')}`), { kind: 'bearer', token: tok('a') });
    for (const none of [null, '', '   ', 'Basic dXNlcjpwYXNz', 'Digest abc', 'Token abc', 'Bearerx y', tok('a')]) assert.deepEqual(parseAuthorization(none), { kind: 'missing' }, String(none));
    for (const bad of ['Bearer', 'Bearer ', 'Bearer  x', 'Bearer a b', `Bearer ${tok('a')}, Bearer ${tok('b')}`, `Bearer ${tok('a')},`, 'Bearer ' + 'x'.repeat(513), 'Bearer\tx']) {
      assert.deepEqual(parseAuthorization(bad), { kind: 'malformed' }, bad.slice(0, 30));
    }
  });
});

describe('the exact WWW-Authenticate challenge', () => {
  it('is built from the canonical configuration', () => {
    assert.equal(challenge(OAUTH), `Bearer resource_metadata="${META}", scope="mcp:read"`);
    assert.equal(challenge(OAUTH, 'invalid_token'), `Bearer error="invalid_token", error_description="The access token is invalid or has expired.", resource_metadata="${META}", scope="mcp:read"`);
    assert.equal(challenge(OAUTH, 'insufficient_scope'), `Bearer error="insufficient_scope", error_description="The access token does not grant the required scope.", resource_metadata="${META}", scope="mcp:read"`);
  });
  it('no credentials or another scheme → 401 with the bare challenge (no error code, per RFC 6750 §3.1)', async () => {
    const noCreds: Array<Record<string, string>> = [{}, { authorization: 'Basic dXNlcjpwYXNz' }, { authorization: '' }];
    for (const h of noCreds) {
      const r = await call(h, { oauth: OAUTH, authenticate: async () => assert.fail('must not authenticate') });
      assert.equal(r.status, 401); assert.equal(r.headers.get('www-authenticate'), `Bearer resource_metadata="${META}", scope="mcp:read"`);
      assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(await r.json(), { jsonrpc: '2.0', error: { code: -32001, message: 'Authentication required.' }, id: null });
    }
  });
  it('a token that does not authenticate, for ANY reason, gets the identical 401 invalid_token (no oracle)', async () => {
    const reasons: Array<[string, McpDeps['authenticate']]> = [
      ['unknown/expired/revoked (null)', async () => null],
      ['not an admin', async () => P({ role: 'user' })], ['superadmin', async () => P({ role: 'superadmin' })], ['no team', async () => P({ teamId: null })],
    ];
    const seen = new Set<string>();
    for (const [name, authenticate] of reasons) {
      const r = await call(bearer(tok('x')), { oauth: OAUTH, authenticate });
      assert.equal(r.status, 401, name); seen.add(`${r.headers.get('www-authenticate')}|${JSON.stringify(await r.json())}`);
    }
    for (const bad of ['Bearer', 'Bearer  x', `Bearer ${tok('a')}, Bearer ${tok('b')}`]) {
      const r = await call({ authorization: bad }, { oauth: OAUTH, authenticate: async () => assert.fail('must not authenticate') });
      assert.equal(r.status, 401); seen.add(`${r.headers.get('www-authenticate')}|${JSON.stringify(await r.json())}`);
    }
    assert.equal(seen.size, 1);
    assert.equal([...seen][0].startsWith(`Bearer error="invalid_token", error_description="The access token is invalid or has expired.", resource_metadata="${META}", scope="mcp:read"|`), true);
  });
  it('a valid token without the mcp:read scope → 403 insufficient_scope (the only 403 for token state)', async () => {
    const r = await call(bearer(tok('x')), { oauth: OAUTH, authenticate: async () => P({ scope: 'something:else' }) });
    assert.equal(r.status, 403); assert.equal(r.headers.get('www-authenticate'), challenge(OAUTH, 'insufficient_scope'));
  });
  it('authentication backend failure → 503 with Retry-After, NO challenge (a client must not discard a good token), nothing leaked', async () => {
    logs.length = 0;
    const secretish = tok('Z');
    const r = await call(bearer(secretish), { oauth: OAUTH, authenticate: async () => { throw new Error(`connect ECONNREFUSED 10.1.2.3:5432 password=hunter2 token=${secretish}`); } });
    const text = await r.text();
    assert.equal(r.status, 503); assert.equal(r.headers.get('www-authenticate'), null); assert.equal(r.headers.get('retry-after'), '5');
    assert.ok(!/hunter2|ECONNREFUSED|10\.1\.2\.3|ZZZZ/.test(text));
    assert.deepEqual(logs, ['[mcp] authentication unavailable']);
  });
});

describe('check order: flag → configuration → Host → canonical Host → Origin → token', () => {
  const never: McpDeps = { oauth: OAUTH, authenticate: async () => assert.fail('must not authenticate') };
  it('flag off → 404 and nothing else happens (the kill switch)', async () => {
    const r = await call(bearer(tok('a')), never, { cfg: { ...CFG, enabled: false } }); assert.equal(r.status, 404); assert.equal(await r.text(), '');
  });
  it('invalid OAuth configuration → 503 (fail closed), even with a token', async () => {
    assert.equal((await call(bearer(tok('a')), { oauth: null, authenticate: async () => P() })).status, 503);
  });
  it('a Host outside the allow-list → 403; an allowed Host that is NOT the canonical one → 403; neither reaches authentication', async () => {
    assert.equal((await call({ ...bearer(tok('a')), host: 'evil.example' }, never)).status, 403);
    assert.equal((await call({ ...bearer(tok('a')), host: 'other.example' }, never)).status, 403); // allowed by MCP_ALLOWED_HOSTS, but tokens are bound to the canonical resource
    assert.equal((await call({ ...bearer(tok('a')), 'x-forwarded-host': 'evil.example' }, never)).status, 403);
  });
  it('a foreign Origin → 403 before any token check (browsers learn nothing about tokens)', async () => {
    assert.equal((await call({ ...bearer(tok('a')), origin: 'https://evil.example' }, never)).status, 403);
    assert.equal((await call({ origin: 'null' }, never)).status, 403);
  });
  it('an access_token in the query string is never read', async () => {
    const r = await call({}, { oauth: OAUTH, authenticate: async () => assert.fail('must not authenticate') }, { url: `https://${HOST}/mcp?access_token=${tok('q')}` });
    assert.equal(r.status, 401);
  });
});

describe('the principal reaches the server layer, only from the validated token, per request', () => {
  const capture = () => { const seen: unknown[] = []; return { seen, createServer: (ctx: unknown) => { seen.push(ctx); return new McpServer({ name: 't', version: '0' }); } }; };
  it('the server is built with the authenticated, frozen principal; spoofed identity headers and cookies are ignored; the token is not in the context', async () => {
    const c = capture();
    const r = await call({ ...bearer(tok('a')), cookie: 'app_session=zzz', 'x-team-id': 'evil-team', 'x-user-id': 'evil-user', 'x-forwarded-user': 'root' },
      { oauth: OAUTH, authenticate: async () => P({ userId: 'real-user', teamId: 'real-team' }), createServer: c.createServer as never });
    assert.equal(r.status, 200);
    assert.equal(c.seen.length, 1);
    const ctx = c.seen[0] as { principal: McpPrincipal };
    assert.deepEqual([ctx.principal.userId, ctx.principal.teamId, ctx.principal.role], ['real-user', 'real-team', 'admin']);
    assert.ok(Object.isFrozen(ctx) && Object.isFrozen(ctx.principal));
    assert.ok(!JSON.stringify(ctx).includes(tok('a')) && !/token"/i.test(Object.keys(ctx.principal).join(',').replace('tokenId', '')));
  });
  it('authentication runs on EVERY request (no cache): N requests → N authenticate calls with the exact token, and a changed answer is honoured immediately', async () => {
    const calls: string[] = []; let answer: McpPrincipal | null = P({ teamId: 'team-A' });
    const deps: McpDeps = { oauth: OAUTH, authenticate: async (t) => { calls.push(t); return answer; } };
    assert.equal((await call(bearer(tok('a')), deps)).status, 200);
    answer = P({ teamId: 'team-B' }); assert.equal((await call(bearer(tok('a')), deps)).status, 200);
    answer = null; assert.equal((await call(bearer(tok('a')), deps)).status, 401);
    answer = P(); assert.equal((await call(bearer(tok('a')), deps)).status, 200);
    assert.deepEqual(calls, [tok('a'), tok('a'), tok('a'), tok('a')]);
  });
  it('concurrent requests never see each other\'s principal (request-scoped context, stateless handler)', async () => {
    const c = capture(); const byToken: Record<string, McpPrincipal> = { [tok('a')]: P({ userId: 'ua', teamId: 'ta' }), [tok('b')]: P({ userId: 'ub', teamId: 'tb' }) };
    const deps: McpDeps = { oauth: OAUTH, authenticate: async (t) => { await new Promise((r) => setTimeout(r, Math.random() * 15)); return byToken[t] ?? null; }, createServer: c.createServer as never };
    const order: string[] = [];
    await Promise.all(Array.from({ length: 24 }, async (_, i) => {
      const t = i % 2 ? tok('a') : tok('b'); const r = await call(bearer(t), deps); assert.equal(r.status, 200); order.push(t);
    }));
    const users = (c.seen as Array<{ principal: McpPrincipal }>).map((x) => x.principal.userId).sort();
    assert.deepEqual(users, [...Array(12).fill('ua'), ...Array(12).fill('ub')].sort());
  });
  it('authenticateRequest re-asserts admin + team on whatever the backend returned', async () => {
    const run = (p: McpPrincipal | null) => authenticateRequest(new Request('https://x/', { headers: bearer(tok('a')) }), OAUTH, { authenticate: async () => p });
    assert.equal((await run(P())).ok, true);
    for (const p of [null, P({ role: 'user' }), P({ role: 'superadmin' }), P({ teamId: null })]) assert.equal((await run(p)).ok, false);
  });
  it('after authentication the SDK still answers methods and protocol errors as before (GET → 405, bad JSON → -32700)', async () => {
    const deps: McpDeps = { oauth: OAUTH, authenticate: async () => P() };
    assert.equal((await call(bearer(tok('a')), deps, { method: 'GET' })).status, 405);
    const bad = await handleMcpRequest(new Request(`https://${HOST}/mcp`, { method: 'POST', headers: { host: HOST, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...bearer(tok('a')) }, body: '{bad' }), CFG, deps);
    assert.equal(bad.status, 400);
  });
});
