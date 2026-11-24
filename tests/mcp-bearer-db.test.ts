/**
 * Live tests of /mcp bearer authentication (Step 7) through handleMcpRequest and the real mcp_auth pool against the explicit test branch.
 * Proves: valid tokens authenticate; every other token state is the same 401; the user, team and client are re-read from the database on
 * EVERY request (a state change takes effect on the very next request with the same token); the principal comes from the database only.
 */
import { SKIP_DB, SKIP_REASON, connectionString, loadTestDb, TestDbConfigError } from './helpers/test-db'; // FIRST: installs the tripwire
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { McpServer } from '@modelcontextprotocol/server';
import { createMcpPool, validateMcpAuthUrl, type McpPool } from '../lib/mcp/db';
import { handleMcpRequest, type McpDeps } from '../lib/mcp/handler';
import { MCP_MAX_BODY_BYTES, type McpConfig } from '../lib/mcp/config';
import { loadOAuthConfig } from '../lib/mcp/oauth/config';
import { registerClient } from '../lib/mcp/oauth/clients';
import { ACCESS_TOKEN_PREFIX, REFRESH_TOKEN_PREFIX, generateSecret, s256Challenge, sha256 } from '../lib/mcp/oauth/crypto';
import { createAuthorizationCode, exchangeAuthorizationCode, refreshTokens, revokeAllForUser, revokeToken, type TokenPair } from '../lib/mcp/oauth/tokens';
import { challenge } from '../lib/mcp/bearer';
import type { McpToolContext } from '../lib/mcp/context';

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
const VERIFIER = 'v'.repeat(43);
const RUN = crypto.randomBytes(5).toString('hex');
const INVALID = challenge(oauth, 'invalid_token');

let owner: pg.Client; let pool: McpPool; let teamA: string; let teamB: string; let adminId: string; let clientId: string;
const userIds: string[] = []; const teamIds: string[] = []; const clientIds: string[] = [];
const queries: string[] = [];
const seen: McpToolContext[] = [];
const wrapped = new WeakSet<object>(); // pooled clients are reused: wrap each ONE once, or every checkout would stack another logger
const spyPool = (): McpPool => ({
  connect: async () => {
    const c = await pool.connect();
    if (!wrapped.has(c)) {
      wrapped.add(c); const q = c.query.bind(c) as (...a: unknown[]) => unknown;
      (c as unknown as { query: unknown }).query = (...a: unknown[]) => { queries.push(typeof a[0] === 'string' ? a[0] : String((a[0] as { text?: string })?.text)); return q(...a); };
    }
    return c;
  },
}) as unknown as McpPool;
let deps: McpDeps;

const mcp = async (token: string | null, extra: Record<string, string> = {}) => {
  const res = await handleMcpRequest(new Request(`https://${oauth.host}/mcp`, { method: 'POST', headers: { host: oauth.host, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) }), CFG, deps);
  const text = await res.text(); return { status: res.status, www: res.headers.get('www-authenticate'), text };
};
async function mkTeam(): Promise<string> { const id = (await owner.query(`INSERT INTO teams (name) VALUES ($1) RETURNING id`, [`Bearer Team ${crypto.randomBytes(3).toString('hex')} ${RUN}`])).rows[0].id; teamIds.push(id); return id; }
async function mkAdmin(team: string | null = teamA, role = 'admin'): Promise<string> {
  const id = (await owner.query(`INSERT INTO users (username, password_hash, display_name, role, team_id) VALUES ($1, 'x-not-a-hash', 'Bearer Test', $2, $3) RETURNING id`, [`mcp-br-${crypto.randomBytes(4).toString('hex')}-${RUN}`, role, team])).rows[0].id; userIds.push(id); return id;
}
async function issue(uid = adminId, cid = clientId): Promise<TokenPair> {
  const code = await createAuthorizationCode(pool, { clientId: cid, userId: uid, redirectUri: CB, codeChallenge: s256Challenge(VERIFIER), resource: oauth.resource, scope: 'mcp:read' });
  return exchangeAuthorizationCode(pool, { code, clientId: cid, redirectUri: CB, codeVerifier: VERIFIER, resource: oauth.resource });
}
const unauthorized = (r: { status: number; www: string | null }) => { assert.equal(r.status, 401); assert.equal(r.www, INVALID); };

describe('/mcp bearer authentication (live test branch)', { skip: SKIP_DB ? SKIP_REASON : false }, () => {
  before(async () => {
    owner = new pg.Client({ connectionString: connectionString(cfgDb!), ssl: { rejectUnauthorized: true } }); await owner.connect();
    pool = createMcpPool(mcpAuthUrl());
    teamA = await mkTeam(); teamB = await mkTeam(); adminId = await mkAdmin();
    clientId = (await registerClient(pool, { name: 'Bearer test client', redirectUris: [CB] })).clientId; clientIds.push(clientId);
    deps = { oauth, pool: spyPool, createServer: (ctx) => { seen.push(ctx); return new McpServer({ name: 't', version: '0' }); } };
  });
  after(async () => {
    try {
      // audit_log.actor_user_id becomes NULL when a user is deleted (one test deletes a user), so also match the username this run created
      await owner.query(`DELETE FROM audit_log WHERE action LIKE 'mcp.%' AND (actor_user_id = ANY($1) OR target_id = ANY($2) OR actor_username LIKE $3)`, [userIds, clientIds, `mcp-br-%-${RUN}`]);
      await owner.query('DELETE FROM oauth_clients WHERE client_id = ANY($1)', [clientIds]);
      await owner.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
      await owner.query('DELETE FROM teams WHERE id = ANY($1)', [teamIds]);
    } finally { await pool?.end().catch(() => {}); await owner?.end().catch(() => {}); }
  });

  it('a valid token authenticates; the principal is built from the DATABASE row (user, role, team, client)', async () => {
    const t = await issue(); seen.length = 0;
    const r = await mcp(t.accessToken); assert.equal(r.status, 200); assert.equal(r.www, null);
    const p = seen[0].principal;
    assert.deepEqual([p.userId, p.role, p.teamId, p.clientId, p.scope, p.displayName], [adminId, 'admin', teamA, clientId, 'mcp:read', 'Bearer Test']);
    assert.ok(!JSON.stringify(seen[0]).includes(t.accessToken));
  });

  it('every request performs the identity lookup: N requests → N queries joining token, user, team and client; none are skipped', async () => {
    const t = await issue(); queries.length = 0;
    for (let i = 0; i < 3; i++) assert.equal((await mcp(t.accessToken)).status, 200);
    const lookups = queries.filter((q) => /FROM oauth_tokens t JOIN users u ON .+ JOIN oauth_clients c ON /.test(q.replace(/\s+/g, ' ')));
    assert.equal(lookups.length, 3);
    for (const q of lookups) { const n = q.replace(/\s+/g, ' '); assert.match(n, /u\.active/); assert.match(n, /u\.role = 'admin'/); assert.match(n, /FROM teams tm WHERE tm\.id = u\.team_id/); assert.match(n, /c\.disabled_at IS NULL/); assert.match(n, /t\.revoked_at IS NULL/); assert.match(n, /t\.expires_at > now\(\)/); }
    assert.ok(queries.every((q) => !/session_turns|sync_sessions|audit_log|members/i.test(q)));
  });

  describe('token states: every failure is the same 401 invalid_token', () => {
    it('missing → bare challenge; garbage, unknown, expired, revoked, refresh-as-bearer, wrong audience → identical invalid_token', async () => {
      const none = await mcp(null); assert.equal(none.status, 401); assert.equal(none.www, challenge(oauth));
      for (const t of ['junk', 'tt_at_', generateSecret(ACCESS_TOKEN_PREFIX), `${ACCESS_TOKEN_PREFIX}${'A'.repeat(43)}`]) unauthorized(await mcp(t));

      const expired = generateSecret(ACCESS_TOKEN_PREFIX);
      await owner.query(`INSERT INTO oauth_tokens (token_hash, kind, family_id, client_id, user_id, resource, scope, created_at, expires_at, absolute_expires_at) VALUES ($1, 'access', gen_random_uuid(), $2, $3, $4, 'mcp:read', now() - interval '2 hours', now() - interval '1 minute', now() + interval '1 day')`, [sha256(expired), clientId, adminId, oauth.resource]);
      unauthorized(await mcp(expired));

      const wrongAud = generateSecret(ACCESS_TOKEN_PREFIX);
      await owner.query(`INSERT INTO oauth_tokens (token_hash, kind, family_id, client_id, user_id, resource, scope, expires_at, absolute_expires_at) VALUES ($1, 'access', gen_random_uuid(), $2, $3, 'https://other.invalid/mcp', 'mcp:read', now() + interval '1 hour', now() + interval '1 day')`, [sha256(wrongAud), clientId, adminId]);
      unauthorized(await mcp(wrongAud));

      const t = await issue(); assert.equal((await mcp(t.accessToken)).status, 200);
      unauthorized(await mcp(t.refreshToken)); // a refresh token is not a bearer token
      await revokeToken(pool, t.accessToken, clientId); unauthorized(await mcp(t.accessToken)); // revoked
    });

    it('rotated: the old refresh token is dead as a bearer; replaying it kills the whole family including the new access token', async () => {
      const t = await issue(); const next = await refreshTokens(pool, { refreshToken: t.refreshToken, clientId });
      unauthorized(await mcp(t.refreshToken));
      assert.equal((await mcp(next.accessToken)).status, 200); // the rotated-in access token works
      await assert.rejects(refreshTokens(pool, { refreshToken: t.refreshToken, clientId })); // reuse
      unauthorized(await mcp(next.accessToken)); unauthorized(await mcp(t.accessToken));
    });

    it('the 401 body and headers never contain the token or database detail', async () => {
      const t = generateSecret(ACCESS_TOKEN_PREFIX); const r = await mcp(t);
      assert.ok(!r.text.includes(t) && !(r.www ?? '').includes(t)); assert.ok(!/postgres|pg_|neon|ECONN|mcp_auth/i.test(r.text + r.www));
    });
  });

  describe('state changes after issuance take effect on the VERY NEXT request with the same token (and reverse)', () => {
    const flip = async (breakIt: string, fixIt: string, args: unknown[]) => {
      const t = await issue(args[0] as string); const who = args[0] as string;
      assert.equal((await mcp(t.accessToken)).status, 200);
      await owner.query(breakIt, args); unauthorized(await mcp(t.accessToken));
      await owner.query(fixIt, args); assert.equal((await mcp(t.accessToken)).status, 200);
      void who;
    };
    it('user deactivated → 401, reactivated → 200', async () => {
      const u = await mkAdmin(); await flip('UPDATE users SET active = false WHERE id = $1', 'UPDATE users SET active = true WHERE id = $1', [u]);
    });
    it('role changed away from admin (user, superadmin) → 401, restored → 200', async () => {
      const u = await mkAdmin(); await flip(`UPDATE users SET role = 'user' WHERE id = $1`, `UPDATE users SET role = 'admin' WHERE id = $1`, [u]);
      await flip(`UPDATE users SET role = 'superadmin' WHERE id = $1`, `UPDATE users SET role = 'admin' WHERE id = $1`, [u]);
    });
    it('removed from the team (team_id NULL) → 401, re-added → 200; the team deleted outright → 401', async () => {
      const u = await mkAdmin(); await flip('UPDATE users SET team_id = NULL WHERE id = $1', `UPDATE users SET team_id = '${teamA}' WHERE id = $1`, [u]);
      const doomed = await mkTeam(); const v = await mkAdmin(doomed); const t = await issue(v);
      assert.equal((await mcp(t.accessToken)).status, 200);
      await owner.query('DELETE FROM teams WHERE id = $1', [doomed]); // users.team_id becomes NULL
      unauthorized(await mcp(t.accessToken));
    });
    it('moved to another team → the principal follows the database on the next request (no stale team in the token)', async () => {
      const u = await mkAdmin(teamA); const t = await issue(u); seen.length = 0;
      assert.equal((await mcp(t.accessToken)).status, 200); assert.equal(seen[0].principal.teamId, teamA);
      await owner.query('UPDATE users SET team_id = $2 WHERE id = $1', [u, teamB]);
      assert.equal((await mcp(t.accessToken)).status, 200); assert.equal(seen[1].principal.teamId, teamB);
    });
    it('client disabled → 401, re-enabled → 200', async () => {
      const c = (await registerClient(pool, { name: 'to-disable', redirectUris: [CB] })).clientId; clientIds.push(c);
      const t = await issue(adminId, c); assert.equal((await mcp(t.accessToken)).status, 200);
      await owner.query('UPDATE oauth_clients SET disabled_at = now() WHERE client_id = $1', [c]); unauthorized(await mcp(t.accessToken));
      await owner.query('UPDATE oauth_clients SET disabled_at = NULL WHERE client_id = $1', [c]); assert.equal((await mcp(t.accessToken)).status, 200);
    });
    it('user deleted (tokens cascade) and bulk revocation for a user → 401', async () => {
      const u = await mkAdmin(); const t = await issue(u); const t2 = await issue(u);
      assert.equal(await revokeAllForUser(pool, u, 'password_reset'), 4); unauthorized(await mcp(t.accessToken)); unauthorized(await mcp(t2.accessToken));
      const v = await mkAdmin(); const t3 = await issue(v); await owner.query('DELETE FROM users WHERE id = $1', [v]); unauthorized(await mcp(t3.accessToken));
    });
  });

  describe('an ineligible user can no longer obtain or renew tokens either', () => {
    it('refresh and a pending authorization code are refused after demotion or team removal', async () => {
      const u = await mkAdmin(); const t = await issue(u);
      await owner.query(`UPDATE users SET role = 'user' WHERE id = $1`, [u]);
      await assert.rejects(refreshTokens(pool, { refreshToken: t.refreshToken, clientId }), /invalid_grant/);
      const code = await createAuthorizationCode(pool, { clientId, userId: u, redirectUri: CB, codeChallenge: s256Challenge(VERIFIER), resource: oauth.resource, scope: 'mcp:read' });
      await assert.rejects(exchangeAuthorizationCode(pool, { code, clientId, redirectUri: CB, codeVerifier: VERIFIER, resource: oauth.resource }), /invalid_grant/);
      const w = await mkAdmin(); const t2 = await issue(w); await owner.query('UPDATE users SET team_id = NULL WHERE id = $1', [w]);
      await assert.rejects(refreshTokens(pool, { refreshToken: t2.refreshToken, clientId }), /invalid_grant/);
      void REFRESH_TOKEN_PREFIX;
    });
  });

  it('flag, configuration, Host and Origin gates still come first (no database work for refused requests)', async () => {
    const t = await issue(); queries.length = 0;
    assert.equal((await handleMcpRequest(new Request(`https://${oauth.host}/mcp`, { method: 'POST', headers: { host: oauth.host, authorization: `Bearer ${t.accessToken}` }, body: '{}' }), { ...CFG, enabled: false }, deps)).status, 404);
    assert.equal((await mcp(t.accessToken, { host: 'evil.example' })).status, 403);
    assert.equal((await mcp(t.accessToken, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await handleMcpRequest(new Request(`https://${oauth.host}/mcp`, { method: 'POST', headers: { host: oauth.host, authorization: `Bearer ${t.accessToken}` }, body: '{}' }), CFG, { ...deps, oauth: null })).status, 503);
    assert.equal(queries.length, 0);
  });
});
