/**
 * Live tests of the OAuth HTTP endpoints (registration, token, revocation) through the real handlers and the real mcp_auth pool,
 * against the explicit test branch (same environment as mcp-oauth-data.test.ts). Rows use unique synthetic ids and are removed in after().
 */
import { SKIP_DB, SKIP_REASON, connectionString, loadTestDb, TestDbConfigError } from './helpers/test-db'; // FIRST: installs the tripwire
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { McpDbUnavailable, createMcpPool, validateMcpAuthUrl, type McpPool } from '../lib/mcp/db';
import { loadOAuthConfig } from '../lib/mcp/oauth/config';
import { handleRegister, handleRevoke, handleToken } from '../lib/mcp/oauth/endpoints';
import { createAuthorizationCode, authenticateAccessToken } from '../lib/mcp/oauth/tokens';
import { s256Challenge } from '../lib/mcp/oauth/crypto';

const cfgDb = SKIP_DB ? undefined : loadTestDb('owner');
function mcpAuthUrl(): string {
  const raw = process.env.TEST_MCP_AUTH_DATABASE_URL?.trim();
  if (!raw) throw new TestDbConfigError('TEST_MCP_AUTH_DATABASE_URL is not set (the mcp_auth login of the SAME test branch).');
  const endpoint = new URL(raw).hostname.split('.')[0].replace(/-pooler$/, '');
  if (endpoint !== cfgDb!.endpoint) throw new TestDbConfigError(`TEST_MCP_AUTH_DATABASE_URL points at "${endpoint}", expected "${cfgDb!.endpoint}". Refusing to connect.`);
  return validateMcpAuthUrl(raw);
}

const cfg = loadOAuthConfig({ MCP_PUBLIC_BASE_URL: 'https://token-tracer-three.vercel.app', NODE_ENV: 'production' })!;
const CB = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'v'.repeat(43);
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const RUN = crypto.randomBytes(5).toString('hex');
let owner: pg.Client; let pool: McpPool; let userId: string;
const clientIds: string[] = [];
const ipOf = () => `198.51.100.${Math.floor(Math.random() * 250) + 1}-${crypto.randomBytes(3).toString('hex')}`;
let deps: { enabled: true; config: typeof cfg; pool: () => McpPool };

const call = async (h: (r: Request, d: typeof deps) => Promise<Response>, path: string, body: string, headers: Record<string, string> = FORM, ip = ipOf()) => {
  const res = await h(new Request(`https://ignored.invalid${path}`, { method: 'POST', headers: { host: cfg.host, 'x-real-ip': ip, ...headers }, body }), deps);
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, body: text ? JSON.parse(text) : null };
};
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const register = (b: unknown, ip?: string) => call(handleRegister, '/oauth/register', JSON.stringify(b), { 'content-type': 'application/json' }, ip);

async function newClient(): Promise<string> {
  const r = await register({ client_name: 'Endpoint test', redirect_uris: [CB] });
  assert.equal(r.status, 201); clientIds.push(r.body.client_id); return r.body.client_id;
}
async function codeFor(clientId: string): Promise<string> {
  return createAuthorizationCode(pool, { clientId, userId, redirectUri: CB, codeChallenge: s256Challenge(VERIFIER), resource: cfg.resource, scope: 'mcp:read' });
}
const exchange = (clientId: string, code: string, extra: Record<string, string> = {}) =>
  call(handleToken, '/oauth/token', form({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: CB, code_verifier: VERIFIER, ...extra }));

describe('OAuth HTTP endpoints (live test branch)', { skip: SKIP_DB ? SKIP_REASON : false }, () => {
  before(async () => {
    owner = new pg.Client({ connectionString: connectionString(cfgDb!), ssl: { rejectUnauthorized: true } });
    await owner.connect();
    pool = createMcpPool(mcpAuthUrl());
    deps = { enabled: true, config: cfg, pool: () => pool };
    userId = (await owner.query(`INSERT INTO users (username, password_hash, display_name, role) VALUES ($1, 'x-not-a-hash', 'Endpoint Test', 'user') RETURNING id`, [`mcp-ep-${RUN}`])).rows[0].id;
  });
  after(async () => {
    try {
      await owner.query(`DELETE FROM audit_log WHERE action LIKE 'mcp.%' AND (actor_user_id = $1 OR target_id = ANY($2))`, [userId, clientIds]);
      await owner.query(`DELETE FROM mcp_rate_limits WHERE key LIKE 'register:%' OR key LIKE 'token:%' OR key LIKE 'revoke:%'`);
      await owner.query('DELETE FROM oauth_clients WHERE client_id = ANY($1)', [clientIds]);
      await owner.query('DELETE FROM users WHERE id = $1', [userId]);
    } finally { await pool?.end().catch(() => {}); await owner?.end().catch(() => {}); }
  });

  describe('POST /oauth/register', () => {
    it('registers a public client: 201, no secret, fixed registration metadata, no-store', async () => {
      const r = await register({ client_name: 'Claude', redirect_uris: [CB, 'http://127.0.0.1:53124/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'mcp:read offline_access', client_secret: 'ignored', unknown_field: 1 });
      assert.equal(r.status, 201); clientIds.push(r.body.client_id);
      assert.match(r.body.client_id, /^tt_[A-Za-z0-9_-]{22}$/);
      assert.deepEqual([r.body.token_endpoint_auth_method, r.body.scope, r.body.grant_types, r.body.response_types], ['none', 'mcp:read', ['authorization_code', 'refresh_token'], ['code']]);
      assert.ok(!('client_secret' in r.body)); assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.equal((await owner.query('SELECT registration FROM oauth_clients WHERE client_id = $1', [r.body.client_id])).rows[0].registration, 'dcr');
    });
    it('rejects bad metadata with the RFC 7591 error codes', async () => {
      const bad = async (b: unknown, status: number, error: string) => { const r = await register(b); assert.deepEqual([r.status, r.body.error], [status, error], JSON.stringify(b)); };
      await bad({ redirect_uris: ['https://evil.example/cb'] }, 400, 'invalid_redirect_uri');
      await bad({ redirect_uris: ['http://example.com/callback'] }, 400, 'invalid_redirect_uri');
      await bad({ redirect_uris: [] }, 400, 'invalid_redirect_uri');
      await bad({}, 400, 'invalid_redirect_uri');
      await bad({ redirect_uris: [CB], token_endpoint_auth_method: 'client_secret_basic' }, 400, 'invalid_client_metadata');
      await bad({ redirect_uris: [CB], grant_types: ['password'] }, 400, 'invalid_client_metadata');
      await bad({ redirect_uris: [CB], grant_types: ['refresh_token'] }, 400, 'invalid_client_metadata');
      await bad({ redirect_uris: [CB], response_types: ['token'] }, 400, 'invalid_client_metadata');
      await bad({ redirect_uris: [CB], scope: 'mcp:write' }, 400, 'invalid_client_metadata');
      await bad({ redirect_uris: [CB], client_name: 'x'.repeat(101) }, 400, 'invalid_client_metadata');
      await bad([CB], 400, 'invalid_client_metadata');
      const notJson = await call(handleRegister, '/oauth/register', '{nope', { 'content-type': 'application/json' });
      assert.deepEqual([notJson.status, notJson.body.error], [400, 'invalid_client_metadata']);
      const big = await call(handleRegister, '/oauth/register', JSON.stringify({ redirect_uris: [CB], client_name: 'x'.repeat(9000) }), { 'content-type': 'application/json' });
      assert.equal(big.status, 413);
    });
    it('rate-limits per client address: the 11th registration in an hour is 429 with Retry-After; another address is unaffected', async () => {
      const ip = ipOf(); const codes: number[] = [];
      for (let i = 0; i < 11; i++) { const r = await register({ client_name: `rl ${i}`, redirect_uris: [CB] }, ip); codes.push(r.status); if (r.status === 201) clientIds.push(r.body.client_id); else assert.ok(Number(r.headers.get('retry-after')) >= 1); }
      assert.deepEqual(codes, [...Array(10).fill(201), 429]);
      assert.equal((await register({ client_name: 'other ip', redirect_uris: [CB] }, ipOf())).status, 201 satisfies number);
    });
  });

  describe('POST /oauth/token', () => {
    it('authorization_code → tokens (no-store, Bearer, 1800 s, mcp:read); the access token authenticates; refresh rotates; reuse kills the family', async () => {
      const c = await newClient();
      const t = await exchange(c, await codeFor(c));
      assert.equal(t.status, 200); assert.equal(t.headers.get('cache-control'), 'no-store');
      assert.deepEqual([t.body.token_type, t.body.expires_in, t.body.scope], ['Bearer', 1800, 'mcp:read']);
      assert.ok(t.body.access_token.startsWith('tt_at_') && t.body.refresh_token.startsWith('tt_rt_'));
      assert.ok(await authenticateAccessToken(pool, t.body.access_token, cfg.resource));
      const r1 = await call(handleToken, '/oauth/token', form({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token, client_id: c, scope: 'mcp:read' }));
      assert.equal(r1.status, 200); assert.notEqual(r1.body.refresh_token, t.body.refresh_token);
      const reuse = await call(handleToken, '/oauth/token', form({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token, client_id: c }));
      assert.deepEqual([reuse.status, reuse.body.error], [400, 'invalid_grant']);
      assert.equal(await authenticateAccessToken(pool, r1.body.access_token, cfg.resource), null);
    });
    it('PKCE failure, replayed code, wrong redirect, wrong client and wrong resource are all invalid_grant / invalid_target', async () => {
      const c = await newClient();
      assert.deepEqual((({ status, body }) => [status, body.error])(await exchange(c, await codeFor(c), { code_verifier: 'w'.repeat(43) })), [400, 'invalid_grant']);
      const code = await codeFor(c);
      assert.equal((await exchange(c, code)).status, 200);
      assert.equal((await exchange(c, code)).body.error, 'invalid_grant'); // replay
      assert.equal((await exchange(c, await codeFor(c), { redirect_uri: 'https://claude.com/api/mcp/auth_callback' })).body.error, 'invalid_grant');
      assert.equal((await exchange(await newClient(), await codeFor(c))).body.error, 'invalid_grant');
      assert.equal((await exchange(c, await codeFor(c), { resource: 'https://other.invalid/mcp' })).body.error, 'invalid_target');
      assert.equal((await exchange(c, await codeFor(c), { resource: cfg.resource })).status, 200); // the canonical resource is accepted
    });
    it('malformed requests: missing / repeated parameters, unknown grant, public-client violations, bad scope', async () => {
      const c = await newClient();
      const err = async (body: string, status: number, error: string) => { const r = await call(handleToken, '/oauth/token', body); assert.deepEqual([r.status, r.body.error], [status, error], body); };
      await err(form({ grant_type: 'authorization_code', client_id: c }), 400, 'invalid_request');
      await err(form({ grant_type: 'authorization_code', client_id: c, code: 'tt_ac_x', redirect_uri: CB }), 400, 'invalid_request'); // no verifier
      await err(form({ grant_type: 'password', client_id: c }), 400, 'unsupported_grant_type');
      await err(form({ client_id: c }), 400, 'unsupported_grant_type');
      await err(form({ grant_type: 'refresh_token' }), 400, 'invalid_request'); // no client_id
      await err(`grant_type=refresh_token&grant_type=authorization_code&client_id=${c}`, 400, 'invalid_request');
      await err(form({ grant_type: 'refresh_token', client_id: c, client_secret: 's' }), 401, 'invalid_client');
      await err(form({ grant_type: 'refresh_token', client_id: c, refresh_token: 'tt_rt_x', scope: 'mcp:write' }), 400, 'invalid_scope');
      await err(form({ grant_type: 'refresh_token', client_id: c, refresh_token: 'junk' }), 400, 'invalid_grant');
    });
    it('never echoes request values and hides internal failures', async () => {
      const marker = 'ZZ<script>alert(1)</script>ZZ';
      const r = await call(handleToken, '/oauth/token', form({ grant_type: marker, client_id: marker, code: marker }));
      assert.ok(!r.text.includes('ZZ') && !r.text.includes('<script'));
      const down = await handleToken(new Request('https://x/oauth/token', { method: 'POST', headers: { host: cfg.host, ...FORM }, body: form({ grant_type: 'refresh_token', client_id: 'tt_x', refresh_token: 'tt_rt_x' }) }),
        { ...deps, pool: () => { throw new McpDbUnavailable('connect ECONNREFUSED 10.1.2.3:5432 password=hunter2'); } });
      const text = await down.text();
      assert.equal(down.status, 503); assert.deepEqual(JSON.parse(text).error, 'server_error'); assert.ok(!/hunter2|ECONNREFUSED|10\.1\.2\.3/.test(text));
    });
  });

  describe('POST /oauth/revoke', () => {
    it('revokes the family for the owning client; unknown tokens and other clients still get 200 and change nothing', async () => {
      const c = await newClient(); const other = await newClient();
      const t = (await exchange(c, await codeFor(c))).body;
      assert.equal((await call(handleRevoke, '/oauth/revoke', form({ token: t.access_token, client_id: other }))).status, 200);
      assert.ok(await authenticateAccessToken(pool, t.access_token, cfg.resource));
      assert.equal((await call(handleRevoke, '/oauth/revoke', form({ token: 'tt_at_unknown', client_id: c }))).status, 200);
      const ok = await call(handleRevoke, '/oauth/revoke', form({ token: t.refresh_token, client_id: c, token_type_hint: 'refresh_token' }));
      assert.deepEqual([ok.status, ok.body], [200, {}]);
      assert.equal(await authenticateAccessToken(pool, t.access_token, cfg.resource), null);
      assert.equal((await call(handleRevoke, '/oauth/revoke', form({ token: t.refresh_token }))).body.error, 'invalid_request'); // client_id required
    });
  });
});
