/**
 * Step 9 — negative and edge-case tests against the explicit test branch (real mcp_auth pool, real SQL). Complements the per-step suites:
 * token lifecycle edges, rate-limit ENFORCEMENT at the real thresholds, cross-tenant concurrency with mid-flight revocation, body/CORS limits,
 * and retention-purge behaviour. Rows are synthetic and removed in after().
 */
import { SKIP_DB, SKIP_REASON, connectionString, loadTestDb, TestDbConfigError } from './helpers/test-db'; // FIRST: installs the tripwire
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { McpServer } from '@modelcontextprotocol/server';
import { createMcpPool, validateMcpAuthUrl, type McpPool } from '../lib/mcp/db';
import { MCP_MAX_BODY_BYTES, type McpConfig } from '../lib/mcp/config';
import { handleMcpRequest, type McpDeps } from '../lib/mcp/handler';
import type { McpToolContext } from '../lib/mcp/context';
import { loadOAuthConfig } from '../lib/mcp/oauth/config';
import { registerClient } from '../lib/mcp/oauth/clients';
import { ACCESS_TOKEN_PREFIX, REFRESH_TOKEN_PREFIX, generateSecret, s256Challenge, sha256 } from '../lib/mcp/oauth/crypto';
import { handleRegister, handleRevoke, handleToken } from '../lib/mcp/oauth/endpoints';
import { handleDecision } from '../lib/mcp/oauth/authorize';
import { signConsent } from '../lib/mcp/oauth/consent';
import { clientIpKey } from '../lib/mcp/oauth/http';
import { authenticateAccessToken, createAuthorizationCode, exchangeAuthorizationCode, refreshTokens, type TokenPair } from '../lib/mcp/oauth/tokens';
import { revokeMcpAccess } from '../lib/team/mcp-revoke';
import type { Queryable } from '../lib/team/db';
import type { SessionPayload } from '../lib/session-token';

const cfgDb = SKIP_DB ? undefined : loadTestDb('owner');
function mcpAuthUrl(): string {
  const raw = process.env.TEST_MCP_AUTH_DATABASE_URL?.trim();
  if (!raw) throw new TestDbConfigError('TEST_MCP_AUTH_DATABASE_URL is not set (the mcp_auth login of the SAME test branch).');
  const endpoint = new URL(raw).hostname.split('.')[0].replace(/-pooler$/, '');
  if (endpoint !== cfgDb!.endpoint) throw new TestDbConfigError(`TEST_MCP_AUTH_DATABASE_URL points at "${endpoint}", expected "${cfgDb!.endpoint}". Refusing to connect.`);
  return validateMcpAuthUrl(raw);
}

const oauth = loadOAuthConfig({ MCP_PUBLIC_BASE_URL: 'https://token-tracer-three.vercel.app', NODE_ENV: 'production' })!;
const CFG: McpConfig = { enabled: true, allowedHosts: [oauth.host], allowedOriginHostnames: ['claude.ai', oauth.host], maxBodyBytes: MCP_MAX_BODY_BYTES };
const CB = 'https://claude.ai/api/mcp/auth_callback';
const LOOP = (port: number) => `http://localhost:${port}/callback`;
const VERIFIER = 'v'.repeat(43);
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const RUN = crypto.randomBytes(5).toString('hex');
const SECRET = 'negative-suite-consent-secret-0123456789';

let owner: pg.Client; let pool: McpPool; let deps: { enabled: true; config: typeof oauth; pool: () => McpPool }; let clientId: string; let loopClientId: string;
const userIds: string[] = []; const teamIds: string[] = []; const clientIds: string[] = [];

async function mkTeam(): Promise<string> { const id = (await owner.query(`INSERT INTO teams (name) VALUES ($1) RETURNING id`, [`Neg Team ${crypto.randomBytes(3).toString('hex')} ${RUN}`])).rows[0].id; teamIds.push(id); return id; }
async function mkAdmin(team: string): Promise<string> { const id = (await owner.query(`INSERT INTO users (username, password_hash, display_name, role, team_id) VALUES ($1, 'x-not-a-hash', 'Neg Test', 'admin', $2) RETURNING id`, [`mcp-ng-${crypto.randomBytes(4).toString('hex')}-${RUN}`, team])).rows[0].id; userIds.push(id); return id; }
async function issue(uid: string, cid = clientId, redirectUri = CB): Promise<TokenPair> {
  const code = await createAuthorizationCode(pool, { clientId: cid, userId: uid, redirectUri, codeChallenge: s256Challenge(VERIFIER), resource: oauth.resource, scope: 'mcp:read' });
  return exchangeAuthorizationCode(pool, { code, clientId: cid, redirectUri, codeVerifier: VERIFIER, resource: oauth.resource });
}
const live = async (uid: string) => Number((await owner.query('SELECT count(*) FROM oauth_tokens WHERE user_id = $1 AND revoked_at IS NULL', [uid])).rows[0].count);
const ipOf = () => `203.0.113.${Math.floor(Math.random() * 250) + 1}-${crypto.randomBytes(3).toString('hex')}`;
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const post = async (h: (r: Request, d: typeof deps) => Promise<Response>, path: string, body: string, headers: Record<string, string> = FORM, ip = ipOf()) => {
  const res = await h(new Request(`https://ignored.invalid${path}`, { method: 'POST', headers: { host: oauth.host, 'x-real-ip': ip, ...headers }, body }), deps);
  const text = await res.text(); return { status: res.status, headers: res.headers, text, body: text ? JSON.parse(text) : null };
};
/** Put a rate-limit counter at `count` in the CURRENT window; waits out a window rollover so the seed and the use share one window. */
async function seed(key: string, count: number, windowSeconds: number) {
  const left = Number((await owner.query(`SELECT ceil($1::numeric - mod(extract(epoch FROM now())::numeric, $1::numeric))::int AS s`, [windowSeconds])).rows[0].s);
  if (left < 5) await new Promise((r) => setTimeout(r, (left + 1) * 1000));
  await owner.query(`INSERT INTO mcp_rate_limits (key, window_start, count) VALUES ($1, to_timestamp(floor(extract(epoch FROM now()) / $2::numeric) * $2::numeric), $3)
                     ON CONFLICT (key, window_start) DO UPDATE SET count = EXCLUDED.count`, [key, windowSeconds, count]);
}

function barrierWhoami(parties: number, timeoutMs = 8000) {
  let arrived = 0; let release!: () => void; let fail!: (e: Error) => void;
  const gate = new Promise<void>((res, rej) => { release = res; fail = rej; });
  const timer = setTimeout(() => fail(new Error(`barrier timeout: ${arrived}/${parties} in flight together`)), timeoutMs);
  const createServer = (ctx: McpToolContext) => {
    const server = new McpServer({ name: 'neg-test', version: '0' });
    server.registerTool('whoami', { description: 'test only' }, async () => {
      if (++arrived >= parties) release(); await gate;
      return { content: [{ type: 'text' as const, text: JSON.stringify({ u: ctx.principal.userId, t: ctx.principal.teamId }) }] };
    });
    return server;
  };
  return { createServer, done: () => clearTimeout(timer) };
}
const CALL = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'whoami', arguments: {} } });
const who = (text: string): { u: string; t: string } => { const d = text.split('\n').find((l) => l.startsWith('data:')); const m = JSON.parse(d ? d.slice(5).trim() : text); return JSON.parse(m.result.content[0].text); };
const mcpCall = (token: string, d: McpDeps) => handleMcpRequest(new Request(`https://${oauth.host}/mcp`, { method: 'POST', headers: { host: oauth.host, 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: CALL }), CFG, d);

describe('Step 9: negative and edge cases (live test branch)', { skip: SKIP_DB ? SKIP_REASON : false }, () => {
  before(async () => {
    owner = new pg.Client({ connectionString: connectionString(cfgDb!), ssl: { rejectUnauthorized: true } }); await owner.connect();
    pool = createMcpPool(mcpAuthUrl()); deps = { enabled: true, config: oauth, pool: () => pool };
    clientId = (await registerClient(pool, { name: 'Neg client', redirectUris: [CB] })).clientId; clientIds.push(clientId);
    loopClientId = (await registerClient(pool, { name: 'Neg loopback', redirectUris: [LOOP(40000)] })).clientId; clientIds.push(loopClientId);
  });
  after(async () => {
    try {
      await owner.query(`DELETE FROM audit_log WHERE action LIKE 'mcp.%' AND (actor_user_id = ANY($1) OR target_id = ANY($2) OR actor_username LIKE $3)`, [userIds, clientIds, `mcp-ng-%-${RUN}`]);
      await owner.query(`DELETE FROM mcp_rate_limits WHERE key LIKE 'token:%' OR key LIKE 'revoke:%' OR key LIKE 'register:%' OR key LIKE 'consent:%' OR key LIKE 'neg:%'`);
      await owner.query('DELETE FROM oauth_clients WHERE client_id = ANY($1)', [clientIds]);
      await owner.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
      await owner.query('DELETE FROM teams WHERE id = ANY($1)', [teamIds]);
    } finally { await pool?.end().catch(() => {}); await owner?.end().catch(() => {}); }
  });

  describe('token lifecycle edges', () => {
    it('refresh: an idle-expired or absolute-expired refresh token is invalid_grant; an access token past its absolute expiry is not a bearer', async () => {
      const u = await mkAdmin(await mkTeam());
      const mk = async (kind: 'access' | 'refresh', exp: string, abs: string) => {
        const t = generateSecret(kind === 'access' ? ACCESS_TOKEN_PREFIX : REFRESH_TOKEN_PREFIX);
        await owner.query(`INSERT INTO oauth_tokens (token_hash, kind, family_id, client_id, user_id, resource, scope, created_at, expires_at, absolute_expires_at) VALUES ($1, $2, gen_random_uuid(), $3, $4, $5, 'mcp:read', now() - interval '70 days', now() + $6::interval, now() + $7::interval)`, [sha256(t), kind, clientId, u, oauth.resource, exp, abs]); return t;
      };
      await assert.rejects(refreshTokens(pool, { refreshToken: await mk('refresh', '-1 minute', '+30 days'), clientId }), /invalid_grant/); // idle window over
      await assert.rejects(refreshTokens(pool, { refreshToken: await mk('refresh', '+10 days', '-1 minute'), clientId }), /invalid_grant/); // 60-day cap reached
      assert.ok(await refreshTokens(pool, { refreshToken: await mk('refresh', '+10 days', '+30 days'), clientId })); // control: a live one works
      assert.equal(await authenticateAccessToken(pool, await mk('access', '+10 minutes', '-1 minute'), oauth.resource), null);
    });

    it('rotation chain: replaying the MIDDLE (or oldest) refresh token kills the whole family, including the newest tokens', async () => {
      const u = await mkAdmin(await mkTeam()); const t0 = await issue(u);
      const t1 = await refreshTokens(pool, { refreshToken: t0.refreshToken, clientId });
      const t2 = await refreshTokens(pool, { refreshToken: t1.refreshToken, clientId });
      assert.ok(await authenticateAccessToken(pool, t2.accessToken, oauth.resource));
      await assert.rejects(refreshTokens(pool, { refreshToken: t1.refreshToken, clientId }), /invalid_grant/); // middle replayed
      assert.equal(await authenticateAccessToken(pool, t2.accessToken, oauth.resource), null);
      await assert.rejects(refreshTokens(pool, { refreshToken: t2.refreshToken, clientId }), /invalid_grant/);
      assert.equal(await live(u), 0);
      const v = await mkAdmin(await mkTeam()); const a0 = await issue(v); const a1 = await refreshTokens(pool, { refreshToken: a0.refreshToken, clientId });
      await assert.rejects(refreshTokens(pool, { refreshToken: a0.refreshToken, clientId }), /invalid_grant/); // oldest replayed
      assert.equal(await authenticateAccessToken(pool, a1.accessToken, oauth.resource), null);
    });

    it('two concurrent exchanges of ONE code: at most one succeeds, and the loser\'s replay leaves no live token behind (strict)', async () => {
      const u = await mkAdmin(await mkTeam());
      const code = await createAuthorizationCode(pool, { clientId, userId: u, redirectUri: CB, codeChallenge: s256Challenge(VERIFIER), resource: oauth.resource, scope: 'mcp:read' });
      const run = () => exchangeAuthorizationCode(pool, { code, clientId, redirectUri: CB, codeVerifier: VERIFIER, resource: oauth.resource });
      const r = await Promise.allSettled([run(), run()]);
      assert.ok(r.filter((x) => x.status === 'fulfilled').length <= 1);
      assert.equal(await live(u), 0);
    });

    it('loopback redirect: the code is bound to the EXACT URI (port included) it was issued for, even though registration ignores the port', async () => {
      const u = await mkAdmin(await mkTeam());
      const issued = await createAuthorizationCode(pool, { clientId: loopClientId, userId: u, redirectUri: LOOP(51234), codeChallenge: s256Challenge(VERIFIER), resource: oauth.resource, scope: 'mcp:read' });
      await assert.rejects(exchangeAuthorizationCode(pool, { code: issued, clientId: loopClientId, redirectUri: LOOP(51235), codeVerifier: VERIFIER, resource: oauth.resource }), /invalid_grant/);
      assert.ok(await issue(u, loopClientId, LOOP(51234))); // same URI end to end works
    });

    it('PKCE verifier edges: too short, too long, wrong alphabet and a verifier for another challenge are all refused (and each burns its code)', async () => {
      const u = await mkAdmin(await mkTeam());
      for (const bad of ['v'.repeat(42), 'v'.repeat(129), `${'v'.repeat(42)}!`, 'w'.repeat(43), '']) {
        const code = await createAuthorizationCode(pool, { clientId, userId: u, redirectUri: CB, codeChallenge: s256Challenge(VERIFIER), resource: oauth.resource, scope: 'mcp:read' });
        await assert.rejects(exchangeAuthorizationCode(pool, { code, clientId, redirectUri: CB, codeVerifier: bad, resource: oauth.resource }), /invalid_grant/, bad.slice(0, 8));
      }
      assert.equal(await live(u), 0);
    });

    it('a hard-deleted user takes every token and pending code with them (FK cascade); nothing can be refreshed or used afterwards', async () => {
      const u = await mkAdmin(await mkTeam()); const t = await issue(u);
      const pending = await createAuthorizationCode(pool, { clientId, userId: u, redirectUri: CB, codeChallenge: s256Challenge(VERIFIER), resource: oauth.resource, scope: 'mcp:read' });
      await owner.query('DELETE FROM users WHERE id = $1', [u]);
      assert.equal(Number((await owner.query('SELECT count(*) FROM oauth_tokens WHERE user_id = $1', [u])).rows[0].count), 0);
      assert.equal(Number((await owner.query('SELECT count(*) FROM oauth_authorization_codes WHERE user_id = $1', [u])).rows[0].count), 0);
      assert.equal(await authenticateAccessToken(pool, t.accessToken, oauth.resource), null);
      await assert.rejects(refreshTokens(pool, { refreshToken: t.refreshToken, clientId }), /invalid_grant/);
      await assert.rejects(exchangeAuthorizationCode(pool, { code: pending, clientId, redirectUri: CB, codeVerifier: VERIFIER, resource: oauth.resource }), /invalid_grant/);
    });
  });

  describe('rate limits are ENFORCED at their thresholds', () => {
    const expect429 = (r: { status: number; headers: Headers; body: { error: string } }) => { assert.equal(r.status, 429); assert.equal(r.body.error, 'temporarily_unavailable'); assert.ok(Number(r.headers.get('retry-after')) >= 1); assert.equal(r.headers.get('cache-control'), 'no-store'); };
    const nonsense = (cid: string) => form({ grant_type: 'refresh_token', client_id: cid, refresh_token: 'tt_rt_x' });

    it('/oauth/token: the 121st request from one address in a minute is 429 with Retry-After; another address is unaffected', async () => {
      const ip = ipOf(); await seed(`token:${clientIpKey(new Headers({ 'x-real-ip': ip }))}`, 119, 60);
      const a = await post(handleToken, '/oauth/token', nonsense('tt_neg_a'), FORM, ip); assert.notEqual(a.status, 429); // the 120th is still served
      expect429(await post(handleToken, '/oauth/token', nonsense('tt_neg_b'), FORM, ip));
      assert.notEqual((await post(handleToken, '/oauth/token', nonsense('tt_neg_c'), FORM, ipOf())).status, 429);
    });
    it('/oauth/token: the 61st request for one client_id in a minute is 429 even from fresh addresses (per-client limit)', async () => {
      const cid = `tt_neg_${RUN}`; await seed(`token:client:${cid}`, 60, 60);
      expect429(await post(handleToken, '/oauth/token', nonsense(cid), FORM, ipOf()));
    });
    it('/oauth/revoke: the 121st request from one address in a minute is 429', async () => {
      const ip = ipOf(); await seed(`revoke:${clientIpKey(new Headers({ 'x-real-ip': ip }))}`, 120, 60);
      expect429(await post(handleRevoke, '/oauth/revoke', form({ token: 'tt_at_x', client_id: 'tt_neg_r' }), FORM, ip));
    });
    it('/oauth/register: the global cap (300/hour across all addresses) stops registrations from fresh addresses', async () => {
      await seed('register:all', 299, 3600);
      const ok = await post(handleRegister, '/oauth/register', JSON.stringify({ client_name: 'cap test', redirect_uris: [CB] }), { 'content-type': 'application/json' }, ipOf());
      assert.equal(ok.status, 201); clientIds.push(ok.body.client_id);
      expect429(await post(handleRegister, '/oauth/register', JSON.stringify({ client_name: 'cap test 2', redirect_uris: [CB] }), { 'content-type': 'application/json' }, ipOf()));
      await owner.query(`DELETE FROM mcp_rate_limits WHERE key = 'register:all'`);
    });
    it('/oauth/decision: more than 30 consent attempts in 10 minutes for one user are 429 before any other work', async () => {
      const u = await mkAdmin(await mkTeam()); await seed(`consent:${u}`, 30, 600);
      const sess: SessionPayload = { userId: u, username: 'u', displayName: 'U', role: 'admin', memberId: null, teamId: 't', issuedAt: Date.now() - 1000, mfa: true };
      const token = signConsent({ uid: u, sia: sess.issuedAt, cid: clientId, ru: CB, cc: s256Challenge(VERIFIER), sc: 'mcp:read', st: null, rs: oauth.resource }, SECRET);
      const res = await handleDecision(new Request('https://x/oauth/decision', { method: 'POST', headers: { host: oauth.host, origin: oauth.baseUrl, 'content-type': 'application/json' }, body: JSON.stringify({ consent: token, decision: 'approve' }) }), { ...deps, secret: SECRET, session: () => sess });
      assert.equal(res.status, 429); assert.ok(Number(res.headers.get('retry-after')) >= 1);
      assert.equal(Number((await owner.query('SELECT count(*) FROM oauth_authorization_codes WHERE user_id = $1', [u])).rows[0].count), 0); // nothing was issued
    });
    it('a counter from a PREVIOUS window does not carry over, and no raw client address is ever stored in a key', async () => {
      const ip = ipOf(); const key = `token:${clientIpKey(new Headers({ 'x-real-ip': ip }))}`;
      await owner.query(`INSERT INTO mcp_rate_limits (key, window_start, count) VALUES ($1, to_timestamp(floor(extract(epoch FROM now()) / 60) * 60) - interval '1 minute', 5000)`, [key]);
      assert.notEqual((await post(handleToken, '/oauth/token', nonsense('tt_neg_w'), FORM, ip)).status, 429);
      const keys = (await owner.query(`SELECT key FROM mcp_rate_limits`)).rows.map((r) => r.key as string);
      assert.ok(keys.length > 0 && keys.every((k) => !/\d+\.\d+\.\d+\.\d+/.test(k)), 'a key contains an IP address');
    });
  });

  describe('size limits, methods and CORS on the OAuth endpoints', () => {
    it('oversized bodies are refused with 413 (token, revoke, decision), before any parsing or database work on them', async () => {
      const big = 'x'.repeat(5000);
      assert.equal((await post(handleToken, '/oauth/token', form({ grant_type: 'refresh_token', client_id: 'tt_neg_big', refresh_token: big }))).status, 413);
      assert.equal((await post(handleRevoke, '/oauth/revoke', form({ token: big, client_id: 'tt_neg_big' }))).status, 413);
      const u = await mkAdmin(await mkTeam());
      const sess: SessionPayload = { userId: u, username: 'u', displayName: 'U', role: 'admin', memberId: null, teamId: 't', issuedAt: Date.now() - 1000, mfa: true };
      const r = await handleDecision(new Request('https://x/oauth/decision', { method: 'POST', headers: { host: oauth.host, origin: oauth.baseUrl, 'content-type': 'application/json' }, body: JSON.stringify({ consent: 'y'.repeat(9000), decision: 'approve' }) }), { ...deps, secret: SECRET, session: () => sess });
      assert.equal(r.status, 413);
    });
    it('the POST endpoints send NO CORS headers (browsers cannot call them cross-origin); only the public metadata documents allow any origin', async () => {
      for (const r of [await post(handleToken, '/oauth/token', form({ grant_type: 'x', client_id: 'tt_neg_c' })), await post(handleRevoke, '/oauth/revoke', form({ token: 'tt_at_x', client_id: 'tt_neg_c' })),
        await post(handleRegister, '/oauth/register', '{}', { 'content-type': 'application/json' })]) {
        assert.equal([...r.headers.keys()].filter((k) => k.startsWith('access-control-')).length, 0);
      }
    });
  });

  describe('cross-tenant concurrency with mid-flight revocation', () => {
    it('3 teams × 2 admins, concurrent waves: every request sees only its own principal; revoking some users between waves affects exactly those users', async () => {
      const teams = [await mkTeam(), await mkTeam(), await mkTeam()];
      const people: Array<{ uid: string; team: string; token: string }> = [];
      for (const team of teams) for (let i = 0; i < 2; i++) { const uid = await mkAdmin(team); people.push({ uid, team, token: (await issue(uid)).accessToken }); }
      const wave1 = barrierWhoami(people.length * 2); const d1: McpDeps = { oauth, pool: () => pool, createServer: wave1.createServer };
      const order = [...people, ...people].sort(() => Math.random() - 0.5);
      const res1 = await Promise.all(order.map(async (p) => ({ p, r: await mcpCall(p.token, d1) }))); wave1.done();
      for (const { p, r } of res1) { assert.equal(r.status, 200); assert.deepEqual(who(await r.text()), { u: p.uid, t: p.team }); }
      // revoke the first admin of each team (what a password reset hook does), while the others stay valid
      const owned: Queryable = { query: ((t: string, p?: unknown[]) => owner.query(t, p)) as Queryable['query'] };
      const revoked = [people[0], people[2], people[4]]; for (const p of revoked) assert.ok(await revokeMcpAccess({ userId: p.uid }, 'password_reset', owned) >= 2);
      const survivors = people.filter((p) => !revoked.includes(p));
      const wave2 = barrierWhoami(survivors.length * 2); const d2: McpDeps = { oauth, pool: () => pool, createServer: wave2.createServer };
      const res2 = await Promise.all([...people, ...people].sort(() => Math.random() - 0.5).map(async (p) => ({ p, r: await mcpCall(p.token, d2) })));
      wave2.done();
      for (const { p, r } of res2) {
        if (revoked.includes(p)) assert.equal(r.status, 401); else { assert.equal(r.status, 200); assert.deepEqual(who(await r.text()), { u: p.uid, t: p.team }); }
      }
    });
    it('tokens never cross identities: a token only ever authenticates its own user, and moving a user to another team changes only that user', async () => {
      const [tA, tB] = [await mkTeam(), await mkTeam()]; const a = await mkAdmin(tA); const b = await mkAdmin(tB);
      const ta = await issue(a); const tb = await issue(b);
      assert.equal((await authenticateAccessToken(pool, ta.accessToken, oauth.resource))?.userId, a); assert.equal((await authenticateAccessToken(pool, tb.accessToken, oauth.resource))?.userId, b);
      await owner.query('UPDATE users SET team_id = $2 WHERE id = $1', [a, tB]);
      assert.equal((await authenticateAccessToken(pool, ta.accessToken, oauth.resource))?.teamId, tB); assert.equal((await authenticateAccessToken(pool, tb.accessToken, oauth.resource))?.teamId, tB);
      assert.notEqual((await authenticateAccessToken(pool, ta.accessToken, oauth.resource))?.userId, (await authenticateAccessToken(pool, tb.accessToken, oauth.resource))?.userId);
    });
  });

  describe('retention purge (mcp_oauth_purge)', () => {
    it('two purges at the same time both succeed (no deadlock) and together remove exactly the expired rows', async () => {
      const second = new pg.Client({ connectionString: connectionString(cfgDb!), ssl: { rejectUnauthorized: true } }); await second.connect();
      try {
        const u = await mkAdmin(await mkTeam()); const tag = crypto.randomBytes(3).toString('hex');
        for (let i = 0; i < 5; i++) await owner.query(`INSERT INTO mcp_rate_limits (key, window_start, count) VALUES ($1, now() - interval '5 days' - $2::int * interval '1 minute', 1)`, [`neg:${tag}:${i}`, i]);
        await owner.query(`INSERT INTO oauth_tokens (token_hash, kind, family_id, client_id, user_id, resource, scope, created_at, expires_at, absolute_expires_at) VALUES ($1, 'access', gen_random_uuid(), $2, $3, $4, 'mcp:read', now() - interval '3 days', now() - interval '2 days', now() + interval '1 day')`, [sha256(`neg-old-${tag}`), clientId, u, oauth.resource]);
        const [a, b] = await Promise.all([owner.query('SELECT mcp_oauth_purge() AS r'), second.query('SELECT mcp_oauth_purge() AS r')]);
        assert.equal(a.rows[0].r.rate_limits + b.rows[0].r.rate_limits, 5); assert.equal(a.rows[0].r.tokens + b.rows[0].r.tokens, 1);
      } finally { await second.end(); }
    });
    it('the purge never touches users, teams, the audit log or live tokens, and replay detection survives it (a consumed code is kept past its life)', async () => {
      const u = await mkAdmin(await mkTeam()); const code = await createAuthorizationCode(pool, { clientId, userId: u, redirectUri: CB, codeChallenge: s256Challenge(VERIFIER), resource: oauth.resource, scope: 'mcp:read' });
      const pair = await exchangeAuthorizationCode(pool, { code, clientId, redirectUri: CB, codeVerifier: VERIFIER, resource: oauth.resource });
      const count = async (t: string) => Number((await owner.query(`SELECT count(*) FROM ${t}`)).rows[0].count);
      const before = { users: await count('users'), teams: await count('teams'), audit: await count('audit_log'), live: await live(u) };
      await owner.query('SELECT mcp_oauth_purge()');
      assert.deepEqual({ users: await count('users'), teams: await count('teams'), audit: await count('audit_log'), live: await live(u) }, before);
      await assert.rejects(exchangeAuthorizationCode(pool, { code, clientId, redirectUri: CB, codeVerifier: VERIFIER, resource: oauth.resource }), /invalid_grant/); // replay still detected after the purge …
      assert.equal(await authenticateAccessToken(pool, pair.accessToken, oauth.resource), null); // … and it revoked the family
    });
    it('mcp_auth cannot run the purge or delete anything itself (retention is owner-only)', async () => {
      const probe = async (sql: string) => { try { await pool.query(sql); return 'ok'; } catch (e) { return (e as { code?: string }).code; } };
      assert.equal(await probe('SELECT mcp_oauth_purge()'), '42501');
      for (const t of ['oauth_tokens', 'oauth_authorization_codes', 'oauth_clients', 'mcp_rate_limits', 'mcp_access_log']) assert.equal(await probe(`DELETE FROM ${t} WHERE false`), '42501', t);
    });
  });
});
