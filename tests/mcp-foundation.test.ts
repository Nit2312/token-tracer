/**
 * Phase 1 MCP foundation: initialization, capability discovery, invalid requests, unsupported methods, stateless transport,
 * the feature flag, Host/Origin validation and the "no application data" guarantee. No database, no credentials, no network.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handleMcpRequest, type McpDeps } from '../lib/mcp/handler';
import type { OAuthConfig } from '../lib/mcp/oauth/config';
import type { McpPrincipal } from '../lib/mcp/oauth/principal';
import { loadMcpConfig, MCP_MAX_BODY_BYTES, type McpConfig } from '../lib/mcp/config';
import { MCP_SERVER_INFO, MCP_SERVER_INSTRUCTIONS } from '../lib/mcp/server';
import * as route from '../app/mcp/route';

// The handler logs a short line for rejected requests. Capture it (keeps test output clean) so we can assert what it may contain.
const logs: string[] = [];
console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };

const HOST = 'mcp.test';
const ON: McpConfig = { enabled: true, allowedHosts: [HOST], allowedOriginHostnames: ['claude.ai', HOST], maxBodyBytes: MCP_MAX_BODY_BYTES };
// Since Step 7 every request needs a bearer token. Here authentication is a stub (no database): exactly one token value is accepted.
// Real token validation, WWW-Authenticate behaviour and the per-request database re-checks are covered by mcp-bearer*.test.ts.
const OAUTH: OAuthConfig = { baseUrl: `https://${HOST}`, host: HOST, resource: `https://${HOST}/mcp`, allowLoopback: true };
const TOKEN = `tt_at_${'A'.repeat(43)}`;
const PRINCIPAL: McpPrincipal = { userId: '11111111-1111-4111-8111-111111111111', clientId: 'tt_client', tokenId: '22222222-2222-4222-8222-222222222222', scope: 'mcp:read', role: 'admin', teamId: '33333333-3333-4333-8333-333333333333', displayName: 'Test Admin' };
const DEPS: McpDeps = { oauth: OAUTH, authenticate: async (t) => (t === TOKEN ? PRINCIPAL : null) };
const AUTH = { authorization: `Bearer ${TOKEN}` };
const JSON_HEADERS = { host: HOST, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...AUTH };

const post = (body: unknown, headers: Record<string, string> = {}, config: McpConfig = ON) =>
  handleMcpRequest(new Request(`https://${HOST}/mcp`, { method: 'POST', headers: { ...JSON_HEADERS, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }), config, DEPS);
const rpc = (method: string, params?: unknown, id: number | string = 1, headers: Record<string, string> = {}) =>
  post({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }, headers);
const init = (protocolVersion = '2025-06-18', headers: Record<string, string> = {}) =>
  rpc('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' } }, 1, headers);

/** The SDK answers either as application/json or as a single text/event-stream message; accept both. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed JSON-RPC bodies are inspected loosely in assertions
async function result(res: Response): Promise<{ status: number; body: any }> {
  const text = await res.text();
  if (!text) return { status: res.status, body: null };
  if (res.headers.get('content-type')?.includes('text/event-stream')) {
    const data = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5).trim()));
    return { status: res.status, body: data.length === 1 ? data[0] : data };
  }
  return { status: res.status, body: JSON.parse(text) };
}

describe('initialization', () => {
  for (const version of ['2025-11-25', '2025-06-18', '2025-03-26']) {
    it(`initialize negotiates protocol ${version} and returns server info, instructions and EMPTY capabilities`, async () => {
      const { status, body } = await result(await init(version));
      assert.equal(status, 200);
      assert.equal(body.jsonrpc, '2.0'); assert.equal(body.id, 1);
      assert.equal(body.result.protocolVersion, version);
      assert.deepEqual(body.result.serverInfo, { ...MCP_SERVER_INFO });
      assert.equal(body.result.instructions, MCP_SERVER_INSTRUCTIONS);
      assert.deepEqual(body.result.capabilities, {}); // nothing advertised: no tools, resources, prompts or logging
    });
  }
  it('an unknown future protocol version negotiates down to a supported one instead of failing', async () => {
    const { status, body } = await result(await init('2099-01-01'));
    assert.equal(status, 200);
    assert.equal(body.result.protocolVersion, '2025-11-25');
  });
  it('the initialized notification is acknowledged with 202 and no body', async () => {
    const res = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(res.status, 202); assert.equal(await res.text(), '');
  });
  it('ping works without any prior initialize (no session is required or kept)', async () => {
    const { status, body } = await result(await rpc('ping', undefined, 7));
    assert.equal(status, 200); assert.deepEqual(body.result, {}); assert.equal(body.id, 7);
  });
  it('the response id echoes string ids too', async () => {
    const { body } = await result(await rpc('ping', undefined, 'abc-123'));
    assert.equal(body.id, 'abc-123');
  });
});

describe('capability discovery exposes nothing', () => {
  for (const method of ['tools/list', 'resources/list', 'resources/templates/list', 'prompts/list', 'completion/complete', 'logging/setLevel']) {
    it(`${method} → Method not found (-32601)`, async () => {
      const { status, body } = await result(await rpc(method, {}, 2, { 'mcp-protocol-version': '2025-06-18' }));
      assert.equal(status, 200); assert.equal(body.error.code, -32601); assert.equal(body.result, undefined);
    });
  }
  it('tools/call for any tool name → Method not found; no tool exists to call', async () => {
    for (const name of ['query', 'run_sql', 'list_team_developers', 'x']) {
      const { body } = await result(await rpc('tools/call', { name, arguments: {} }, 3));
      assert.equal(body.error.code, -32601);
    }
  });
  it('an unknown method → Method not found', async () => {
    const { body } = await result(await rpc('does/not/exist', {}, 4));
    assert.equal(body.error.code, -32601);
  });
});

describe('invalid requests are rejected with proper JSON-RPC errors', () => {
  const err = async (res: Response) => (await result(res)).body.error;
  it('malformed JSON → 400 / -32700', async () => {
    const res = await post('{not json'); assert.equal(res.status, 400); assert.equal((await err(res)).code, -32700);
  });
  it('empty body → 400 / -32700', async () => {
    const res = await post(''); assert.equal(res.status, 400); assert.equal((await err(res)).code, -32700);
  });
  it('valid JSON that is not a JSON-RPC message → 400 / -32600', async () => {
    const res = await post({ hello: 'world' }); assert.equal(res.status, 400); assert.equal((await err(res)).code, -32600);
  });
  it('a JSON-RPC message without a method → 400 / -32600', async () => {
    const res = await post({ jsonrpc: '2.0', id: 1 }); assert.equal(res.status, 400); assert.equal((await err(res)).code, -32600);
  });
  it('a wrong jsonrpc version → rejected', async () => {
    const res = await post({ jsonrpc: '1.0', id: 1, method: 'ping' }); assert.equal(res.status, 400);
  });
  it('wrong Content-Type → 415', async () => {
    const res = await post('{}', { 'content-type': 'text/plain' }); assert.equal(res.status, 415);
  });
  it('an Accept header that does not offer both application/json and text/event-stream → 406', async () => {
    const msg = { jsonrpc: '2.0', id: 1, method: 'ping' };
    assert.equal((await post(msg, { accept: 'application/json' })).status, 406);
    assert.equal((await post(msg, { accept: 'text/event-stream' })).status, 406);
    const noAccept = await handleMcpRequest(new Request(`https://${HOST}/mcp`, { method: 'POST', headers: { host: HOST, 'content-type': 'application/json', ...AUTH }, body: JSON.stringify(msg) }), ON, DEPS);
    assert.equal(noAccept.status, 406);
  });
  it('an invalid MCP-Protocol-Version header → 400', async () => {
    const res = await rpc('ping', undefined, 8, { 'mcp-protocol-version': 'not-a-version' });
    assert.equal(res.status, 400); assert.equal((await err(res)).code, -32602);
  });
  it('a body over the 64 KiB limit → 413, before any server instance is created', async () => {
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { x: 'a'.repeat(MCP_MAX_BODY_BYTES + 1) } });
    assert.equal((await post(big)).status, 413);
  });
  it('a body exactly under the limit is still processed', async () => {
    const ok = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { x: 'a'.repeat(MCP_MAX_BODY_BYTES - 200) } });
    assert.equal((await post(ok)).status, 200);
  });
  it('server logs for rejected requests contain only a fixed category tag, never request data', async () => {
    logs.length = 0;
    await post('{"secret":"S3CR3T-VALUE"', { authorization: 'Bearer TOP-SECRET-TOKEN', cookie: 'app_session=abc' });
    await post({ hello: 'S3CR3T-VALUE' }, { authorization: 'Bearer TOP-SECRET-TOKEN' });
    await rpc('ping', undefined, 1, { 'mcp-protocol-version': 'x\u0007S3CR3T-VALUE' }).catch(() => undefined);
    assert.ok(logs.length >= 1);
    for (const line of logs) {
      assert.match(line, /^\[mcp\] (rejected: [a-z0-9-]{1,48}|request error)$/, line);
      assert.doesNotMatch(line, /S3CR3T-VALUE|TOP-SECRET-TOKEN|app_session|Bearer/);
      assert.doesNotMatch(line, /[\u0000-\u001f]/);
    }
  });
  it('error responses never echo request bodies or headers back', async () => {
    const res = await post('{"secret":"S3CR3T-VALUE"', { authorization: 'Bearer TOP-SECRET-TOKEN', cookie: 'app_session=abc' });
    const text = await res.text();
    assert.doesNotMatch(text, /S3CR3T-VALUE|TOP-SECRET-TOKEN|app_session/);
  });
});

describe('unsupported HTTP methods', () => {
  for (const method of ['GET', 'DELETE', 'PUT', 'PATCH', 'OPTIONS', 'HEAD']) {
    it(`${method} → 405 with Allow: POST`, async () => {
      const res = await handleMcpRequest(new Request(`https://${HOST}/mcp`, { method, headers: { host: HOST, accept: 'text/event-stream', ...AUTH } }), ON, DEPS);
      assert.equal(res.status, 405); assert.equal(res.headers.get('allow'), 'POST');
    });
  }
});

describe('stateless Streamable HTTP transport', () => {
  it('never issues or requires a session id', async () => {
    const res = await init();
    assert.equal(res.headers.get('mcp-session-id'), null);
    const again = await rpc('ping', undefined, 2, { 'mcp-session-id': 'made-up-session' }); // an unknown session header is ignored, not trusted
    assert.equal(again.status, 200);
  });
  it('requests are independent: any order, repeated, no state carried over', async () => {
    const a = await result(await rpc('ping', undefined, 1));
    const b = await result(await init());
    const c = await result(await init());
    assert.deepEqual(b.body.result, c.body.result);
    assert.deepEqual(a.body.result, {});
  });
  it('handles concurrent requests without cross-talk', async () => {
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => rpc('ping', undefined, `req-${i}`).then(result)));
    results.forEach((r, i) => { assert.equal(r.status, 200); assert.equal(r.body.id, `req-${i}`); });
  });
  it('responses are not cacheable and are not MIME-sniffable', async () => {
    for (const res of [await init(), await post('{bad'), await handleMcpRequest(new Request(`https://${HOST}/mcp`, { method: 'GET', headers: { host: HOST } }), ON)]) {
      assert.equal(res.headers.get('cache-control'), 'no-store'); assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    }
  });
  it('a JSON-RPC batch is answered per message', async () => {
    const res = await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'ping' }]);
    const { body } = await result(res); assert.equal(res.status, 200);
    assert.deepEqual((Array.isArray(body) ? body : [body]).map((m: { id: number }) => m.id).sort(), [1, 2]);
  });
  it('identity comes from the bearer token only: cookies and spoofed identity headers change nothing', async () => {
    const plain = await result(await init());
    const spoofed = await result(await init('2025-06-18', { cookie: 'app_session=whatever', 'x-team-id': 'other-team', 'x-user-id': 'someone-else', 'x-forwarded-user': 'admin' }));
    assert.deepEqual(spoofed.body, plain.body);
    const cookieOnly = await handleMcpRequest(new Request(`https://${HOST}/mcp`, { method: 'POST', headers: { host: HOST, 'content-type': 'application/json', accept: JSON_HEADERS.accept, cookie: 'app_session=whatever' }, body: '{}' }), ON, DEPS);
    assert.equal(cookieOnly.status, 401); // a session cookie is not a credential for /mcp
  });
});

describe('feature flag and request guards', () => {
  const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  it('disabled (the default): every method → 404 with an empty body, nothing processed', async () => {
    const off: McpConfig = { ...ON, enabled: false };
    for (const method of methods) {
      const res = await handleMcpRequest(new Request(`https://${HOST}/mcp`, { method, headers: JSON_HEADERS, body: method === 'POST' || method === 'PUT' || method === 'PATCH' ? '{"jsonrpc":"2.0","id":1,"method":"ping"}' : undefined }), off, DEPS);
      assert.equal(res.status, 404, method); assert.equal(await res.text(), '');
    }
  });
  it('the flag is OFF unless MCP_ENABLED is exactly "true"', () => {
    for (const v of [undefined, '', '1', 'TRUE', 'yes', 'on', 'false', ' true']) assert.equal(loadMcpConfig({ MCP_ENABLED: v }).enabled, false, String(v));
    assert.equal(loadMcpConfig({ MCP_ENABLED: 'true' }).enabled, true);
    assert.equal(loadMcpConfig({}).enabled, false);
  });
  it('enabled but no allowed host configured (production) → 503, fail closed', async () => {
    const cfg = loadMcpConfig({ MCP_ENABLED: 'true', NODE_ENV: 'production' });
    assert.deepEqual(cfg.allowedHosts, []);
    const res = await handleMcpRequest(new Request('https://x.test/mcp', { method: 'POST', headers: { ...JSON_HEADERS, host: 'x.test' }, body: '{}' }), cfg, DEPS);
    assert.equal(res.status, 503);
  });
  it('allowed hosts come from MCP_ALLOWED_HOSTS or the site URL; localhost only outside production', () => {
    assert.deepEqual(loadMcpConfig({ MCP_ENABLED: 'true', NODE_ENV: 'production', NEXT_PUBLIC_SERVER_URL: 'https://app.example.com/' }).allowedHosts, ['app.example.com']);
    assert.deepEqual(loadMcpConfig({ NODE_ENV: 'production', MCP_ALLOWED_HOSTS: 'A.example.com:443, b.example.com', NEXT_PUBLIC_SERVER_URL: 'https://ignored.example' }).allowedHosts, ['a.example.com', 'b.example.com']);
    assert.ok(loadMcpConfig({ NODE_ENV: 'development', NEXT_PUBLIC_SERVER_URL: 'https://app.example.com' }).allowedHosts.includes('localhost'));
    assert.ok(!loadMcpConfig({ NODE_ENV: 'production', NEXT_PUBLIC_SERVER_URL: 'https://app.example.com' }).allowedHosts.includes('localhost'));
  });
  it('a request for another Host (DNS-rebinding style) → 403', async () => {
    const res = await handleMcpRequest(new Request('https://evil.test/mcp', { method: 'POST', headers: { ...JSON_HEADERS, host: 'evil.test' }, body: '{}' }), ON, DEPS);
    assert.equal(res.status, 403);
  });
  it('a missing Host header → 403', async () => {
    const res = await handleMcpRequest(new Request('https://mcp.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: JSON_HEADERS.accept }, body: '{}' }), ON, DEPS);
    assert.equal(res.status, 403);
  });
  it('Origin: absent is allowed (server-to-server); allowed hostnames pass; look-alikes and "null" are refused', async () => {
    const withOrigin = (origin?: string) => post({ jsonrpc: '2.0', id: 1, method: 'ping' }, origin === undefined ? {} : { origin });
    assert.equal((await withOrigin()).status, 200);
    assert.equal((await withOrigin('https://claude.ai')).status, 200);
    for (const bad of ['https://evil.example', 'https://claude.ai.evil.example', 'https://sub.claude.ai', 'null']) assert.equal((await withOrigin(bad)).status, 403, bad);
  });
  it('the size limit is applied from configuration', async () => {
    const small = { ...ON, maxBodyBytes: 100 };
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping', params: { x: 'a'.repeat(200) } }, {}, small)).status, 413);
  });
});

describe('Next route wiring (app/mcp/route.ts)', () => {
  const saved = { f: process.env.MCP_ENABLED, h: process.env.MCP_ALLOWED_HOSTS, b: process.env.MCP_PUBLIC_BASE_URL };
  const withEnv = async <T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> => {
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { return await fn(); } finally {
      for (const [k, v] of [['MCP_ENABLED', saved.f], ['MCP_ALLOWED_HOSTS', saved.h], ['MCP_PUBLIC_BASE_URL', saved.b]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };
  const req = (method = 'POST') => new Request(`https://${HOST}/mcp`, { method, headers: JSON_HEADERS, body: method === 'POST' ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) : undefined });
  it('runs on the Node.js runtime, dynamically, with a bounded duration', () => {
    assert.equal(route.runtime, 'nodejs'); assert.equal(route.dynamic, 'force-dynamic'); assert.equal(route.maxDuration, 30);
  });
  it('exports every HTTP method', () => {
    for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const) assert.equal(typeof route[m], 'function', m);
  });
  it('is disabled by default: with MCP_ENABLED unset, POST and GET → 404', async () => {
    await withEnv({ MCP_ENABLED: undefined, MCP_ALLOWED_HOSTS: HOST }, async () => {
      assert.equal((await route.POST(req())).status, 404); assert.equal((await route.GET(req('GET'))).status, 404);
    });
  });
  it('with MCP_ENABLED=true but no MCP_PUBLIC_BASE_URL it fails closed (503), even for a request with a token', async () => {
    await withEnv({ MCP_ENABLED: 'true', MCP_ALLOWED_HOSTS: HOST, MCP_PUBLIC_BASE_URL: undefined }, async () => {
      assert.equal((await route.POST(new Request(`https://${HOST}/mcp`, { method: 'POST', headers: JSON_HEADERS, body: '{}' }))).status, 503);
    });
  });
  it('with MCP_ENABLED=true and a valid base URL, a request without a token is 401 with the challenge (no database is touched)', async () => {
    await withEnv({ MCP_ENABLED: 'true', MCP_ALLOWED_HOSTS: HOST, MCP_PUBLIC_BASE_URL: `https://${HOST}` }, async () => {
      const noAuth = { host: HOST, 'content-type': 'application/json', accept: JSON_HEADERS.accept };
      for (const method of ['POST', 'GET'] as const) {
        const res = await route[method](new Request(`https://${HOST}/mcp`, { method, headers: noAuth, body: method === 'POST' ? '{}' : undefined }));
        assert.equal(res.status, 401, method);
        assert.equal(res.headers.get('www-authenticate'), `Bearer resource_metadata="https://${HOST}/.well-known/oauth-protected-resource/mcp", scope="mcp:read"`);
      }
    });
  });
});

describe('database access from the MCP code is confined to the approved authentication path', () => {
  const root = path.join(process.cwd(), 'lib', 'mcp');
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.ts') ? [path.join(d, e.name)] : []));
  const all = [...walk(root), path.join(process.cwd(), 'app', 'mcp', 'route.ts')];
  const rel = (f: string) => path.relative(process.cwd(), f).split(path.sep).join('/');
  const code = (f: string) => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const importsOf = (f: string) => [...code(f).matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);

  // The ONLY modules that may talk to the database (always as mcp_auth, always through db.ts). Adding one requires a conscious edit here.
  const DB_MODULES = ['lib/mcp/db.ts', 'lib/mcp/oauth/audit.ts', 'lib/mcp/oauth/clients.ts', 'lib/mcp/oauth/grant-user.ts', 'lib/mcp/oauth/rate-limit.ts', 'lib/mcp/oauth/tokens.ts'];
  // The request-serving modules: what answers /mcp. They reach the database ONLY through ./bearer.
  const SERVING = ['lib/mcp/handler.ts', 'lib/mcp/server.ts', 'lib/mcp/config.ts', 'lib/mcp/context.ts', 'lib/mcp/bearer.ts', 'app/mcp/route.ts'];
  const APPROVED_TABLES = ['users', 'teams', 'oauth_clients', 'oauth_authorization_codes', 'oauth_tokens', 'mcp_rate_limits', 'mcp_access_log'];

  it('only the approved modules import pg or run queries', () => {
    const touching = all.filter((f) => /from\s+['"]pg['"]|\.query\(|\bnew pg\.|\bPool\b/.test(code(f))).map(rel).sort();
    assert.deepEqual(touching, [...DB_MODULES].sort());
  });
  it('no MCP module imports application data, session or auth code (consent uses only the session decoder and the signing secret)', () => {
    const allowedOutside: Record<string, string[]> = { 'lib/mcp/oauth/authorize.ts': ['../../session-token', '../../security/return-url', '../../team/env'], 'lib/mcp/oauth/grant-user.ts': ['../../session-token'] };
    for (const f of all) for (const i of importsOf(f)) {
      if (!/lib\/|@\/lib/.test(i) && !i.startsWith('../../')) continue;
      if (/^@\/lib\/mcp\//.test(i)) continue; // the route imports its own handler
      assert.ok((allowedOutside[rel(f)] ?? []).includes(i), `${rel(f)} imports ${i}`);
    }
    for (const f of all.filter((x) => rel(x) !== 'lib/mcp/oauth/authorize.ts')) assert.doesNotMatch(code(f), /lib\/team|team\/(db|env|audit)|lib\/auth\b|lib\/security\/(auth|mfa)/, rel(f));
  });
  it('request-serving modules import only the SDK, each other, ./bearer and pure OAuth helpers; never pg, ./db or a repository', () => {
    const ok = (i: string) => i === '@modelcontextprotocol/server' || ['./config', './context', './server', './bearer', './oauth/config', './oauth/metadata', './oauth/principal', './oauth/scopes', './oauth/tokens', './db', '@/lib/mcp/handler', 'node:async_hooks'].includes(i);
    for (const f of SERVING.map((x) => path.join(process.cwd(), x))) for (const i of importsOf(f)) assert.ok(ok(i), `${rel(f)} imports ${i}`);
    for (const f of SERVING.filter((x) => x !== 'lib/mcp/bearer.ts').map((x) => path.join(process.cwd(), x))) assert.doesNotMatch(importsOf(f).join(' '), /\.\/db|oauth\/tokens/, rel(f));
  });
  it('SQL in the MCP code touches only the approved tables and never prompt, session or audit data', () => {
    const forbiddenTables = /\b(session_turns|sync_sessions?|sync_session_\w+|prompt_embeddings|redundant_reprompt_events|session_outcomes\w*|members|team_members|api_keys?|audit_log|auth_totp|auth_throttle|user_sessions)\b/i;
    for (const f of all) assert.doesNotMatch(code(f), forbiddenTables, rel(f));
    for (const f of DB_MODULES.map((x) => path.join(process.cwd(), x))) {
      for (const m of code(f).matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_][a-z0-9_]*)\b(?!\s*\()/gi)) {
        const name = m[1].toLowerCase();
        if (['set', 'select', 'only', 'public'].includes(name)) continue;
        assert.ok(APPROVED_TABLES.includes(name), `${rel(f)} references table "${name}"`);
      }
    }
  });
  it('environment variables read by the MCP code are limited to the MCP_* settings and the consent signing secret', () => {
    for (const f of all) for (const m of code(f).matchAll(/process\.env\.(\w+)|env\.(\w+)/g)) {
      const n = m[1] ?? m[2];
      assert.ok(/^(MCP_[A-Z_]+|NEXT_PUBLIC_SERVER_URL|NODE_ENV|SESSION_SECRET)$/.test(n), `${rel(f)} reads ${n}`);
    }
    for (const f of all.filter((x) => !['lib/mcp/oauth/clients.ts', 'lib/mcp/oauth/authorize.ts'].includes(rel(x)))) assert.doesNotMatch(code(f), /SESSION_SECRET/, rel(f));
    for (const f of all) assert.doesNotMatch(code(f), /\bDATABASE_URL\b(?!.*MCP_AUTH)|NEON_CONNECTION|ANALYST_|CRON_SECRET|GROQ|ADMIN_PASSWORD|SUPERADMIN/, rel(f));
  });
  it('db.ts: imports only pg, reads only MCP_AUTH_DATABASE_URL, and names no other credential', () => {
    const src = code(path.join(root, 'db.ts'));
    assert.deepEqual([...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]), ['pg']);
    assert.deepEqual([...new Set([...src.matchAll(/process\.env\.(\w+)/g)].map((m) => m[1]))], ['MCP_AUTH_DATABASE_URL']);
    assert.doesNotMatch(src.replace(/MCP_AUTH_DATABASE_URL/g, ''), /DATABASE_URL|NEON_CONNECTION|ANALYST_|SESSION_SECRET|CRON_SECRET|GROQ|neondb_owner|lib\/team|lib\/security/);
  });
  it('registers no tools, resources or prompts', () => {
    for (const f of all) assert.doesNotMatch(code(f), /registerTool|registerResource|registerPrompt|\.tool\(|\.resource\(|\.prompt\(/, rel(f));
  });
  it('no logging statement can contain request data, tokens or error objects', () => {
    for (const f of all) for (const m of code(f).matchAll(/console\.(log|warn|error|info|debug)\(([^)]*)\)/g)) {
      const args = m[2].replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '');
      assert.doesNotMatch(args, /\b(req|request|token|error|err|e|headers|body|principal)\b/i, `${rel(f)}: ${m[0].slice(0, 80)}`);
    }
  });
});
