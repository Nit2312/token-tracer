/** DB-free tests of /mcp bearer authentication (Step 7): header parsing, the exact challenge, check order, per-request principal, no caching, no leaks. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/server';
import { handleMcpRequest, type McpDeps } from '../lib/mcp/handler';
import { authenticateRequest, challenge, parseAuthorization } from '../lib/mcp/bearer';
import { MCP_MAX_BODY_BYTES, type McpConfig } from '../lib/mcp/config';
import type { OAuthConfig } from '../lib/mcp/oauth/config';
import type { McpPrincipal } from '../lib/mcp/oauth/principal';
import type { McpToolContext } from '../lib/mcp/context';

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

/** Test-only: a server whose `whoami` tool closes over THIS request's context and waits on a shared barrier, so overlapping requests are forced
 *  to be in flight at the same time inside the one shared SDK handler. (Phase 4 tools will use the same closure pattern.) */
function barrierWhoami(parties: number, timeoutMs = 5000) {
  let arrived = 0; let release!: () => void; let fail!: (e: Error) => void;
  const gate = new Promise<void>((res, rej) => { release = res; fail = rej; });
  const timer = setTimeout(() => fail(new Error(`barrier timeout: only ${arrived}/${parties} requests were in flight together`)), timeoutMs);
  const createServer = (ctx: McpToolContext) => {
    const server = new McpServer({ name: 'iso-test', version: '0' });
    server.registerTool('whoami', { description: 'test only' }, async () => {
      await new Promise((r) => setTimeout(r, Math.random() * 20)); // jitter: arrival order varies
      if (++arrived >= parties) release();
      await gate; // nobody proceeds until ALL requests are inside their tool handler
      await new Promise((r) => setTimeout(r, Math.random() * 20));
      return { content: [{ type: 'text' as const, text: JSON.stringify({ u: ctx.principal.userId, t: ctx.principal.teamId, c: ctx.principal.clientId }) }] };
    });
    return server;
  };
  return { createServer, done: () => clearTimeout(timer) };
}
const toolBody = (text: string): { u: string; t: string; c: string } => {
  const data = text.split('\n').find((l) => l.startsWith('data:'));
  const msg = JSON.parse(data ? data.slice(5).trim() : text);
  assert.equal(msg.error, undefined, text.slice(0, 200));
  return JSON.parse(msg.result.content[0].text);
};
const CALL = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'whoami', arguments: {} } });


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

describe('check order: flag → configuration → canonical Host (404) → allow-list backstop (403) → Origin (403) → token', () => {
  const never: McpDeps = { oauth: OAUTH, authenticate: async () => assert.fail('must not authenticate') };
  it('flag off → 404 and nothing else happens (the kill switch)', async () => {
    const r = await call(bearer(tok('a')), never, { cfg: { ...CFG, enabled: false } }); assert.equal(r.status, 404); assert.equal(await r.text(), '');
  });
  it('invalid OAuth configuration → 503 (fail closed), even with a token', async () => {
    assert.equal((await call(bearer(tok('a')), { oauth: null, authenticate: async () => P() })).status, 503);
  });
  it('any Host that is not the canonical one — unknown, allowed-but-not-canonical, spoofed X-Forwarded-Host, absent — is an empty 404 and never reaches authentication', async () => {
    const wrongHosts: Array<Record<string, string>> = [{ host: 'evil.example' }, { host: 'other.example' } /* allowed by MCP_ALLOWED_HOSTS, but tokens are bound to the canonical resource */, { 'x-forwarded-host': 'evil.example' }, { host: `${HOST}:8443` }];
    for (const h of wrongHosts) {
      const r = await call({ ...bearer(tok('a')), ...h }, never); assert.equal(r.status, 404, JSON.stringify(h)); assert.equal(await r.text(), '');
    }
    const noHost = await handleMcpRequest(new Request(`https://${HOST}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...bearer(tok('a')) }, body: PING }), CFG, never);
    assert.equal(noHost.status, 404);
  });
  it('the SAME Host answer on the discovery and OAuth routes (one policy for every MCP-related route)', async () => {
    const { handleAuthorizationServerMetadata, handleProtectedResourceMetadata, handleRegister, handleToken, handleRevoke } = await import('../lib/mcp/oauth/endpoints');
    const { handleDecision, handleReauthenticate } = await import('../lib/mcp/oauth/authorize');
    const d = { enabled: true, config: OAUTH, pool: (() => { throw new Error('no db'); }) as never };
    const bad = (path: string, method = 'POST') => new Request(`https://x${path}`, { method, headers: { host: 'token-tracer-puce.vercel.app' } });
    const answers = [
      handleAuthorizationServerMetadata(bad('/.well-known/oauth-authorization-server', 'GET'), d), handleProtectedResourceMetadata(bad('/.well-known/oauth-protected-resource/mcp', 'GET'), d),
      await handleRegister(bad('/oauth/register'), d), await handleToken(bad('/oauth/token'), d), await handleRevoke(bad('/oauth/revoke'), d),
      await handleDecision(bad('/oauth/decision'), d), handleReauthenticate(bad('/oauth/reauthenticate?returnTo=%2Foauth%2Fauthorize', 'GET'), d),
      await call({ ...bearer(tok('a')), host: 'token-tracer-puce.vercel.app' }, never),
    ];
    for (const r of answers) { assert.equal(r.status, 404); assert.equal(await r.text(), ''); }
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

describe('request isolation: overlapping requests never share a principal (AsyncLocalStorage + one shared SDK handler)', () => {
  const people: Record<string, McpPrincipal> = {
    [tok('a')]: P({ userId: 'user-A', teamId: 'team-A', clientId: 'client-A' }),
    [tok('b')]: P({ userId: 'user-B', teamId: 'team-B', clientId: 'client-B' }),
  };
  const deps = (createServer: McpDeps['createServer']): McpDeps => ({ oauth: OAUTH, authenticate: async (t) => { await new Promise((r) => setTimeout(r, Math.random() * 15)); return people[t] ?? null; }, createServer });
  const callWhoami = (token: string, d: McpDeps) => handleMcpRequest(new Request(`https://${HOST}/mcp`, { method: 'POST', headers: { host: HOST, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...bearer(token) }, body: CALL }), CFG, d);

  it('two requests for different users in different teams, forced to overlap inside the tool handler, each see only their own principal', async () => {
    for (let round = 0; round < 15; round++) {
      const b = barrierWhoami(2);
      const d = deps(b.createServer);
      const order = round % 2 ? [tok('a'), tok('b')] : [tok('b'), tok('a')];
      const [r1, r2] = await Promise.all(order.map((t) => callWhoami(t, d)));
      b.done();
      const got = [toolBody(await r1.text()), toolBody(await r2.text())];
      assert.deepEqual(got[0], { u: people[order[0]].userId, t: people[order[0]].teamId, c: people[order[0]].clientId }, `round ${round}`);
      assert.deepEqual(got[1], { u: people[order[1]].userId, t: people[order[1]].teamId, c: people[order[1]].clientId }, `round ${round}`);
    }
  });
  it('many overlapping requests (alternating users) are all answered with their own principal', async () => {
    const n = 16; const b = barrierWhoami(n, 8000); const d = deps(b.createServer);
    const tokens = Array.from({ length: n }, (_, i) => (i % 2 ? tok('a') : tok('b')));
    const results = await Promise.all(tokens.map(async (t) => toolBody(await (await callWhoami(t, d)).text())));
    b.done();
    results.forEach((r, i) => assert.deepEqual(r, { u: people[tokens[i]].userId, t: people[tokens[i]].teamId, c: people[tokens[i]].clientId }, `request ${i}`));
  });
  it('a request that fails authentication while others are in flight neither borrows nor leaks a principal', async () => {
    const b = barrierWhoami(2); const d = deps(b.createServer);
    const [ok1, ok2, bad] = await Promise.all([callWhoami(tok('a'), d), callWhoami(tok('b'), d), callWhoami(tok('z'), d)]);
    b.done();
    assert.equal(bad.status, 401);
    assert.equal(toolBody(await ok1.text()).u, 'user-A'); assert.equal(toolBody(await ok2.text()).u, 'user-B');
  });
});
