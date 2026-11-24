/**
 * Phase 1 MCP foundation: initialization, capability discovery, invalid requests, unsupported methods, stateless transport,
 * the feature flag, Host/Origin validation and the "no application data" guarantee. No database, no credentials, no network.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handleMcpRequest } from '../lib/mcp/handler';
import { loadMcpConfig, MCP_MAX_BODY_BYTES, type McpConfig } from '../lib/mcp/config';
import { MCP_SERVER_INFO, MCP_SERVER_INSTRUCTIONS } from '../lib/mcp/server';
import * as route from '../app/mcp/route';

// The handler logs a short line for rejected requests. Capture it (keeps test output clean) so we can assert what it may contain.
const logs: string[] = [];
console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };

const HOST = 'mcp.test';
const ON: McpConfig = { enabled: true, allowedHosts: [HOST], allowedOriginHostnames: ['claude.ai', HOST], maxBodyBytes: MCP_MAX_BODY_BYTES };
const JSON_HEADERS = { host: HOST, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

const post = (body: unknown, headers: Record<string, string> = {}, config: McpConfig = ON) =>
  handleMcpRequest(new Request(`https://${HOST}/mcp`, { method: 'POST', headers: { ...JSON_HEADERS, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }), config);
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
    const noAccept = await handleMcpRequest(new Request(`https://${HOST}/mcp`, { method: 'POST', headers: { host: HOST, 'content-type': 'application/json' }, body: JSON.stringify(msg) }), ON);
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
      const res = await handleMcpRequest(new Request(`https://${HOST}/mcp`, { method, headers: { host: HOST, accept: 'text/event-stream' } }), ON);
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
  it('credentials are ignored in this phase: cookies and bearer tokens change nothing', async () => {
    const plain = await result(await init());
    const withCreds = await result(await init('2025-06-18', { cookie: 'app_session=whatever', authorization: 'Bearer x' }));
    assert.deepEqual(withCreds.body, plain.body);
  });
});

describe('feature flag and request guards', () => {
  const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  it('disabled (the default): every method → 404 with an empty body, nothing processed', async () => {
    const off: McpConfig = { ...ON, enabled: false };
    for (const method of methods) {
      const res = await handleMcpRequest(new Request(`https://${HOST}/mcp`, { method, headers: JSON_HEADERS, body: method === 'POST' || method === 'PUT' || method === 'PATCH' ? '{"jsonrpc":"2.0","id":1,"method":"ping"}' : undefined }), off);
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
    const res = await handleMcpRequest(new Request('https://x.test/mcp', { method: 'POST', headers: { ...JSON_HEADERS, host: 'x.test' }, body: '{}' }), cfg);
    assert.equal(res.status, 503);
  });
  it('allowed hosts come from MCP_ALLOWED_HOSTS or the site URL; localhost only outside production', () => {
    assert.deepEqual(loadMcpConfig({ MCP_ENABLED: 'true', NODE_ENV: 'production', NEXT_PUBLIC_SERVER_URL: 'https://app.example.com/' }).allowedHosts, ['app.example.com']);
    assert.deepEqual(loadMcpConfig({ NODE_ENV: 'production', MCP_ALLOWED_HOSTS: 'A.example.com:443, b.example.com', NEXT_PUBLIC_SERVER_URL: 'https://ignored.example' }).allowedHosts, ['a.example.com', 'b.example.com']);
    assert.ok(loadMcpConfig({ NODE_ENV: 'development', NEXT_PUBLIC_SERVER_URL: 'https://app.example.com' }).allowedHosts.includes('localhost'));
    assert.ok(!loadMcpConfig({ NODE_ENV: 'production', NEXT_PUBLIC_SERVER_URL: 'https://app.example.com' }).allowedHosts.includes('localhost'));
  });
  it('a request for another Host (DNS-rebinding style) → 403', async () => {
    const res = await handleMcpRequest(new Request('https://evil.test/mcp', { method: 'POST', headers: { ...JSON_HEADERS, host: 'evil.test' }, body: '{}' }), ON);
    assert.equal(res.status, 403);
  });
  it('a missing Host header → 403', async () => {
    const res = await handleMcpRequest(new Request('https://mcp.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: JSON_HEADERS.accept }, body: '{}' }), ON);
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
  const saved = { f: process.env.MCP_ENABLED, h: process.env.MCP_ALLOWED_HOSTS };
  const withEnv = async <T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> => {
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { return await fn(); } finally {
      for (const [k, v] of [['MCP_ENABLED', saved.f], ['MCP_ALLOWED_HOSTS', saved.h]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
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
  it('with MCP_ENABLED=true it serves ping and 405s a GET', async () => {
    await withEnv({ MCP_ENABLED: 'true', MCP_ALLOWED_HOSTS: HOST }, async () => {
      assert.equal((await result(await route.POST(req()))).body.result !== undefined, true);
      assert.equal((await route.GET(req('GET'))).status, 405);
    });
  });
});

describe('no application data or credentials are reachable from the MCP code', () => {
  const dir = path.join(process.cwd(), 'lib', 'mcp');
  const files = [...fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => path.join(dir, f)), path.join(process.cwd(), 'app', 'mcp', 'route.ts')];
  const code = (f: string) => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  it('imports only the MCP SDK and its own modules', () => {
    for (const f of files) {
      const imports = [...code(f).matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      for (const i of imports) assert.ok(i === '@modelcontextprotocol/server' || i.startsWith('./') || i === '@/lib/mcp/handler', `${path.basename(f)} imports ${i}`);
    }
  });
  it('references no database, auth, session or secret-bearing configuration', () => {
    const forbidden = /\bpg\b|lib\/team|lib\/auth|lib\/security|session-token|getPool|query\(|DATABASE_URL|NEON_CONNECTION|ANALYST_|SESSION_SECRET|CRON_SECRET|GROQ|PASSWORD|cookie/i;
    for (const f of files) assert.doesNotMatch(code(f), forbidden, path.basename(f));
  });
  it('registers no tools, resources or prompts', () => {
    for (const f of files) assert.doesNotMatch(code(f), /registerTool|registerResource|registerPrompt|\.tool\(|\.resource\(|\.prompt\(/, path.basename(f));
  });
});
