/**
 * Live tests of the OAuth data-access layer (lib/mcp/db.ts, lib/mcp/oauth/{clients,tokens,rate-limit,audit,principal}.ts) through the real
 * `mcp_auth` pool against the explicit test branch. Same environment as mcp-oauth-db.test.ts (TEST_MCP_AUTH_DATABASE_URL + owner URL).
 * Real committed rows with unique synthetic ids, removed again in after(). Secrets are never printed.
 */
import { SKIP_DB, SKIP_REASON, connectionString, loadTestDb, TestDbConfigError } from './helpers/test-db'; // FIRST: installs the tripwire
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { MCP_AUTH_ROLE, McpDbUnavailable, createMcpPool, getMcpPool, validateMcpAuthUrl, withMcpTx, type McpPool } from '../lib/mcp/db';
import { getClient, registerClient, clientAllowsRedirect, hashIp } from '../lib/mcp/oauth/clients';
import { ACCESS_TOKEN_PREFIX, REFRESH_TOKEN_PREFIX, s256Challenge, sha256, generateSecret, AUTH_CODE_PREFIX } from '../lib/mcp/oauth/crypto';
import { authenticateAccessToken, createAuthorizationCode, exchangeAuthorizationCode, refreshTokens, revokeAllForUser, revokeToken } from '../lib/mcp/oauth/tokens';
import { consumeRateLimit } from '../lib/mcp/oauth/rate-limit';
import { isTeamAdmin } from '../lib/mcp/oauth/principal';
import { OAuthError } from '../lib/mcp/oauth/errors';

const cfg = SKIP_DB ? undefined : loadTestDb('owner');
function mcpAuthUrl(): string {
  const raw = process.env.TEST_MCP_AUTH_DATABASE_URL?.trim();
  if (!raw) throw new TestDbConfigError('TEST_MCP_AUTH_DATABASE_URL is not set (the mcp_auth login of the SAME test branch).');
  const endpoint = new URL(raw).hostname.split('.')[0].replace(/-pooler$/, '');
  if (endpoint !== cfg!.endpoint) throw new TestDbConfigError(`TEST_MCP_AUTH_DATABASE_URL points at "${endpoint}", expected "${cfg!.endpoint}". Refusing to connect.`);
  return validateMcpAuthUrl(raw);
}

const RUN = crypto.randomBytes(5).toString('hex');
const RESOURCE = 'https://example.invalid/mcp';
const CB = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'v'.repeat(43);
const CHALLENGE = s256Challenge(VERIFIER);
const clientIds: string[] = [];
let owner: pg.Client; let pool: McpPool; let userId: string; let clientId: string; let teamId: string;

const fails = async (p: Promise<unknown>, code = 'invalid_grant') => {
  await assert.rejects(p, (e: unknown) => e instanceof OAuthError && e.code === code);
};
// MCP access requires an ACTIVE database user with role 'admin' in a team that exists (tokens.ts ELIGIBLE_USER_SQL).
async function mkUser(role = 'admin', active = true): Promise<string> {
  return (await owner.query(`INSERT INTO users (username, password_hash, display_name, role, active, team_id) VALUES ($1, 'x-not-a-hash', 'Data Test', $2, $3, $4) RETURNING id`, [`mcp-data-${crypto.randomBytes(4).toString('hex')}-${RUN}`, role, active, teamId])).rows[0].id;
}
async function login(uid = userId, cid = clientId) {
  const code = await createAuthorizationCode(pool, { clientId: cid, userId: uid, redirectUri: CB, codeChallenge: CHALLENGE, resource: RESOURCE, scope: 'mcp:read' });
  const pair = await exchangeAuthorizationCode(pool, { code, clientId: cid, redirectUri: CB, codeVerifier: VERIFIER, resource: RESOURCE });
  return { code, pair };
}
const auditCount = async (action: string, since: Date) => Number((await owner.query(`SELECT count(*) FROM audit_log WHERE action = $1 AND created_at >= $2`, [action, since])).rows[0].count);

describe('OAuth data-access layer (live test branch, via the mcp_auth pool)', { skip: SKIP_DB ? SKIP_REASON : false }, () => {
  const started = new Date(Date.now() - 2000);
  const users: string[] = [];
  before(async () => {
    owner = new pg.Client({ connectionString: connectionString(cfg!), ssl: { rejectUnauthorized: true } });
    await owner.connect();
    pool = createMcpPool(mcpAuthUrl());
    teamId = (await owner.query(`INSERT INTO teams (name) VALUES ($1) RETURNING id`, [`Data Team ${RUN}`])).rows[0].id;
    userId = await mkUser(); users.push(userId);
    const c = await registerClient(pool, { name: 'Data test client', redirectUris: [CB] });
    clientId = c.clientId; clientIds.push(clientId);
  });
  after(async () => {
    try {
      await owner.query(`DELETE FROM audit_log WHERE action LIKE 'mcp.%' AND (actor_user_id = ANY($1) OR target_id = ANY($2))`, [users, clientIds]);
      await owner.query('DELETE FROM mcp_rate_limits WHERE key LIKE $1', [`test:${RUN}%`]);
      await owner.query('DELETE FROM oauth_clients WHERE client_id = ANY($1)', [clientIds]);
      await owner.query('DELETE FROM users WHERE id = ANY($1)', [users]);
      await owner.query('DELETE FROM teams WHERE id = $1', [teamId]);
    } finally { await pool?.end().catch(() => {}); await owner?.end().catch(() => {}); }
  });

  describe('db.ts fails closed', () => {
    it('validateMcpAuthUrl: missing, malformed, wrong scheme and non-mcp_auth users are refused; sslmode is stripped', () => {
      assert.throws(() => validateMcpAuthUrl(undefined), McpDbUnavailable);
      assert.throws(() => validateMcpAuthUrl('   '), McpDbUnavailable);
      assert.throws(() => validateMcpAuthUrl('not a url'), McpDbUnavailable);
      assert.throws(() => validateMcpAuthUrl('mysql://mcp_auth:x@h/db'), McpDbUnavailable);
      assert.throws(() => validateMcpAuthUrl('postgresql://neondb_owner:x@h/db'), McpDbUnavailable);
      assert.throws(() => validateMcpAuthUrl('postgresql://analyst_login:x@h/db'), McpDbUnavailable);
      assert.equal(new URL(validateMcpAuthUrl(`postgresql://${MCP_AUTH_ROLE}:x@h/db?sslmode=require`)).searchParams.has('sslmode'), false);
    });
    it('getMcpPool() throws when MCP_AUTH_DATABASE_URL is unset (no fallback to any other credential)', () => {
      const saved = process.env.MCP_AUTH_DATABASE_URL; delete process.env.MCP_AUTH_DATABASE_URL;
      try { assert.throws(() => getMcpPool(), McpDbUnavailable); } finally { if (saved !== undefined) process.env.MCP_AUTH_DATABASE_URL = saved; }
    });
    it('withMcpTx applies the role limits locally and rolls back on error', async () => {
      const lim = await withMcpTx(pool, async (tx) => (await tx.query(`SELECT current_setting('statement_timeout') st, current_setting('lock_timeout') lt, current_setting('search_path') sp, current_user cu`)).rows[0]);
      assert.deepEqual(lim, { st: '5s', lt: '2s', sp: 'pg_catalog, public', cu: 'mcp_auth' });
      const key = `test:${RUN}:rb`;
      await assert.rejects(withMcpTx(pool, async (tx) => { await tx.query(`INSERT INTO mcp_rate_limits (key, window_start, count) VALUES ($1, now(), 1)`, [key]); throw new Error('boom'); }));
      assert.equal((await owner.query('SELECT 1 FROM mcp_rate_limits WHERE key = $1', [key])).rowCount, 0);
    });
  });

  describe('clients', () => {
    it('registers a valid client (audited), rejects bad names and redirect URIs, never stores a raw IP', async () => {
      const c = await registerClient(pool, { name: '  Claude  ', redirectUris: [CB, 'http://127.0.0.1:53124/callback'], clientIp: '203.0.113.9' }); clientIds.push(c.clientId);
      assert.equal(c.name, 'Claude'); assert.equal(c.hasLoopback, true);
      const row = (await owner.query('SELECT created_ip_hash, registration FROM oauth_clients WHERE client_id = $1', [c.clientId])).rows[0];
      assert.equal(row.registration, 'dcr'); assert.ok(row.created_ip_hash && !row.created_ip_hash.includes('203.0.113')); assert.equal(row.created_ip_hash, hashIp('203.0.113.9'));
      assert.ok(await auditCount('mcp.client_registered', started) >= 1);
      await fails(registerClient(pool, { name: '', redirectUris: [CB] }), 'invalid_client_metadata');
      await fails(registerClient(pool, { name: 'x'.repeat(101), redirectUris: [CB] }), 'invalid_client_metadata');
      await fails(registerClient(pool, { name: 'bad\nname', redirectUris: [CB] }), 'invalid_client_metadata');
      for (const bad of ['https://evil.invalid/cb', 'http://example.com/callback', 'javascript:alert(1)', 'https://claude.ai/api/mcp/auth_callback#x', 'http://127.0.0.1/other']) {
        await fails(registerClient(pool, { name: 'x', redirectUris: [bad] }), 'invalid_redirect_uri');
      }
      await fails(registerClient(pool, { name: 'x', redirectUris: [] }), 'invalid_redirect_uri');
    });
    it('getClient / clientAllowsRedirect: exact hosted match, loopback ignores port, disabled clients never match, junk ids return null', async () => {
      const c = (await getClient(pool, clientId))!;
      assert.ok(clientAllowsRedirect(c, CB)); assert.ok(!clientAllowsRedirect(c, 'https://claude.ai/api/mcp/auth_callback/'));
      assert.equal(await getClient(pool, 'tt_does_not_exist'), null); assert.equal(await getClient(pool, "x'; DROP"), null); assert.equal(await getClient(pool, undefined), null);
      const lb = await registerClient(pool, { name: 'cli', redirectUris: ['http://localhost:1111/callback'] }); clientIds.push(lb.clientId);
      assert.ok(clientAllowsRedirect((await getClient(pool, lb.clientId))!, 'http://localhost:2222/callback'));
      await owner.query('UPDATE oauth_clients SET disabled_at = now() WHERE client_id = $1', [lb.clientId]);
      assert.ok(!clientAllowsRedirect((await getClient(pool, lb.clientId))!, 'http://localhost:1111/callback'));
    });
  });

  describe('authorization code exchange', () => {
    it('issues a hashed-only token pair; the access token authenticates to the CURRENT user state', async () => {
      const { pair } = await login();
      assert.ok(pair.accessToken.startsWith(ACCESS_TOKEN_PREFIX) && pair.refreshToken.startsWith(REFRESH_TOKEN_PREFIX));
      assert.deepEqual([pair.tokenType, pair.expiresIn, pair.scope], ['Bearer', 1800, 'mcp:read']);
      const rows = (await owner.query('SELECT kind, token_hash, absolute_expires_at - created_at AS span FROM oauth_tokens WHERE user_id = $1 AND token_hash = ANY($2)', [userId, [sha256(pair.accessToken), sha256(pair.refreshToken)]])).rows;
      assert.equal(rows.length, 2);
      const text = JSON.stringify((await owner.query('SELECT * FROM oauth_tokens WHERE user_id = $1', [userId])).rows);
      assert.ok(!text.includes(pair.accessToken) && !text.includes(pair.refreshToken)); // no plaintext anywhere
      const p = await authenticateAccessToken(pool, pair.accessToken, RESOURCE);
      assert.deepEqual([p?.userId, p?.clientId, p?.scope, p?.role, p ? isTeamAdmin(p) : null], [userId, clientId, 'mcp:read', 'admin', true]);
      assert.equal(await authenticateAccessToken(pool, pair.accessToken, 'https://other.invalid/mcp'), null); // audience-bound
      assert.equal(await authenticateAccessToken(pool, pair.refreshToken, RESOURCE), null); // a refresh token is not a bearer token
      for (const junk of [undefined, '', 'tt_at_', 'Bearer x', `${ACCESS_TOKEN_PREFIX}${'A'.repeat(43)}`]) assert.equal(await authenticateAccessToken(pool, junk, RESOURCE), null);
    });
    it('a wrong verifier / redirect_uri / client / resource fails AND burns the code (no second guess)', async () => {
      const mk = () => createAuthorizationCode(pool, { clientId, userId, redirectUri: CB, codeChallenge: CHALLENGE, resource: RESOURCE, scope: 'mcp:read' });
      const base = { clientId, redirectUri: CB, codeVerifier: VERIFIER, resource: RESOURCE };
      for (const over of [{ codeVerifier: 'w'.repeat(43) }, { redirectUri: 'https://claude.com/api/mcp/auth_callback' }, { clientId: 'tt_other' }, { resource: 'https://other.invalid/mcp' }]) {
        const code = await mk();
        await fails(exchangeAuthorizationCode(pool, { ...base, ...over, code }));
        await fails(exchangeAuthorizationCode(pool, { ...base, code })); // correct parameters now still fail: the code is gone
      }
    });
    it('rejects an expired code, an unknown code, junk, and a code of a deactivated user', async () => {
      const code = generateSecret(AUTH_CODE_PREFIX);
      await owner.query(`INSERT INTO oauth_authorization_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, resource, scope, family_id, created_at, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'mcp:read', gen_random_uuid(), now() - interval '2 minutes', now() - interval '1 minute')`, [sha256(code), clientId, userId, CB, CHALLENGE, RESOURCE]);
      await fails(exchangeAuthorizationCode(pool, { code, clientId, redirectUri: CB, codeVerifier: VERIFIER, resource: RESOURCE }));
      await fails(exchangeAuthorizationCode(pool, { code: generateSecret(AUTH_CODE_PREFIX), clientId, redirectUri: CB, codeVerifier: VERIFIER, resource: RESOURCE }));
      await fails(exchangeAuthorizationCode(pool, { code: 'junk', clientId, redirectUri: CB, codeVerifier: VERIFIER, resource: RESOURCE }));
      const off = await mkUser('admin', false); users.push(off);
      const c2 = await createAuthorizationCode(pool, { clientId, userId: off, redirectUri: CB, codeChallenge: CHALLENGE, resource: RESOURCE, scope: 'mcp:read' });
      await fails(exchangeAuthorizationCode(pool, { code: c2, clientId, redirectUri: CB, codeVerifier: VERIFIER, resource: RESOURCE }));
    });
    it('code replay revokes every token minted from that code and is audited', async () => {
      const { code, pair } = await login();
      assert.ok(await authenticateAccessToken(pool, pair.accessToken, RESOURCE));
      await fails(exchangeAuthorizationCode(pool, { code, clientId, redirectUri: CB, codeVerifier: VERIFIER, resource: RESOURCE }));
      assert.equal(await authenticateAccessToken(pool, pair.accessToken, RESOURCE), null);
      await fails(refreshTokens(pool, { refreshToken: pair.refreshToken, clientId }));
      assert.ok(await auditCount('mcp.code_replayed', started) >= 1);
    });
  });

  describe('refresh rotation (strict reuse detection)', () => {
    it('rotates once, keeps the family absolute expiry, and reuse of the old token revokes the whole family', async () => {
      const { pair } = await login();
      const abs0 = (await owner.query('SELECT DISTINCT absolute_expires_at a FROM oauth_tokens WHERE token_hash = ANY($1)', [[sha256(pair.accessToken), sha256(pair.refreshToken)]])).rows;
      assert.equal(abs0.length, 1);
      const next = await refreshTokens(pool, { refreshToken: pair.refreshToken, clientId });
      assert.notEqual(next.refreshToken, pair.refreshToken);
      const abs1 = (await owner.query('SELECT DISTINCT absolute_expires_at a FROM oauth_tokens WHERE token_hash = ANY($1)', [[sha256(next.accessToken), sha256(next.refreshToken)]])).rows;
      assert.deepEqual(abs1[0].a, abs0[0].a); // the 60-day cap is never extended by rotation
      const link = (await owner.query('SELECT rotated_at IS NOT NULL r, replaced_by_id IS NOT NULL l FROM oauth_tokens WHERE token_hash = $1', [sha256(pair.refreshToken)])).rows[0];
      assert.deepEqual(link, { r: true, l: true });
      assert.ok(await authenticateAccessToken(pool, next.accessToken, RESOURCE));
      await fails(refreshTokens(pool, { refreshToken: pair.refreshToken, clientId })); // reuse of the OLD token
      assert.equal(await authenticateAccessToken(pool, next.accessToken, RESOURCE), null); // family revoked
      await fails(refreshTokens(pool, { refreshToken: next.refreshToken, clientId }));
      assert.ok(await auditCount('mcp.refresh_reuse_detected', started) >= 1);
    });
    it('two concurrent refreshes with the same token: at most one succeeds and the family is revoked afterwards', async () => {
      const { pair } = await login();
      const res = await Promise.allSettled([refreshTokens(pool, { refreshToken: pair.refreshToken, clientId }), refreshTokens(pool, { refreshToken: pair.refreshToken, clientId })]);
      const won = res.filter((r) => r.status === 'fulfilled');
      assert.ok(won.length <= 1, `both concurrent refreshes succeeded`);
      const live = Number((await owner.query('SELECT count(*) FROM oauth_tokens WHERE user_id = $1 AND family_id = (SELECT family_id FROM oauth_tokens WHERE token_hash = $2) AND revoked_at IS NULL', [userId, sha256(pair.refreshToken)])).rows[0].count);
      assert.equal(live, 0);
    });
    it('a refresh by another client, an expired token or a deactivated user fails without poisoning the family', async () => {
      const other = await registerClient(pool, { name: 'other', redirectUris: [CB] }); clientIds.push(other.clientId);
      const { pair } = await login();
      await fails(refreshTokens(pool, { refreshToken: pair.refreshToken, clientId: other.clientId }));
      const u = await mkUser(); users.push(u);
      const l2 = await login(u);
      await owner.query('UPDATE users SET active = false WHERE id = $1', [u]);
      await fails(refreshTokens(pool, { refreshToken: l2.pair.refreshToken, clientId }));
      assert.equal(await authenticateAccessToken(pool, l2.pair.accessToken, RESOURCE), null); // bearer re-checks the user every request
      await owner.query('UPDATE users SET active = true WHERE id = $1', [u]);
      assert.ok(await authenticateAccessToken(pool, l2.pair.accessToken, RESOURCE));
      // the first family is untouched by the wrong-client attempt
      assert.ok(await refreshTokens(pool, { refreshToken: pair.refreshToken, clientId }));
    });
    it('an expired access token and a disabled client are refused', async () => {
      const tok = generateSecret(ACCESS_TOKEN_PREFIX);
      await owner.query(`INSERT INTO oauth_tokens (token_hash, kind, family_id, client_id, user_id, resource, scope, created_at, expires_at, absolute_expires_at)
        VALUES ($1, 'access', gen_random_uuid(), $2, $3, $4, 'mcp:read', now() - interval '2 hours', now() - interval '1 hour', now() + interval '1 day')`, [sha256(tok), clientId, userId, RESOURCE]);
      assert.equal(await authenticateAccessToken(pool, tok, RESOURCE), null);
      const c = await registerClient(pool, { name: 'to-disable', redirectUris: [CB] }); clientIds.push(c.clientId);
      const { pair } = await login(userId, c.clientId);
      assert.ok(await authenticateAccessToken(pool, pair.accessToken, RESOURCE));
      await owner.query('UPDATE oauth_clients SET disabled_at = now() WHERE client_id = $1', [c.clientId]);
      assert.equal(await authenticateAccessToken(pool, pair.accessToken, RESOURCE), null);
      await fails(refreshTokens(pool, { refreshToken: pair.refreshToken, clientId: c.clientId }));
    });
  });

  describe('revocation, rate limits, principal', () => {
    it('revokeToken revokes the whole family for the owning client only, and ignores unknown tokens silently', async () => {
      const { pair } = await login();
      await revokeToken(pool, pair.accessToken, 'tt_someone_else'); // wrong client: no effect
      assert.ok(await authenticateAccessToken(pool, pair.accessToken, RESOURCE));
      await revokeToken(pool, generateSecret(ACCESS_TOKEN_PREFIX), clientId); await revokeToken(pool, 'junk', clientId); await revokeToken(pool, pair.accessToken, undefined);
      await revokeToken(pool, pair.refreshToken, clientId); // refresh token revokes the access token too
      assert.equal(await authenticateAccessToken(pool, pair.accessToken, RESOURCE), null);
      await fails(refreshTokens(pool, { refreshToken: pair.refreshToken, clientId }));
      assert.ok(await auditCount('mcp.token_revoked', started) >= 1);
    });
    it('revokeAllForUser revokes every family, is idempotent and audited; bad reasons are refused', async () => {
      const u = await mkUser(); users.push(u);
      const a = await login(u); const b = await login(u);
      assert.equal(await revokeAllForUser(pool, u, 'password_reset'), 4);
      assert.equal(await revokeAllForUser(pool, u, 'password_reset'), 0);
      assert.equal(await authenticateAccessToken(pool, a.pair.accessToken, RESOURCE), null); assert.equal(await authenticateAccessToken(pool, b.pair.accessToken, RESOURCE), null);
      assert.ok(await auditCount('mcp.tokens_revoked_for_user', started) >= 1);
      await assert.rejects(revokeAllForUser(pool, u, 'x; drop'), /invalid revoke reason/);
    });
    it('consumeRateLimit counts per key and window, denies over the limit with a retry hint, and validates arguments', async () => {
      const key = `test:${RUN}:rl`;
      const r = [] as boolean[]; let retry = 0;
      for (let i = 0; i < 4; i++) { const x = await consumeRateLimit(pool, key, 3, 3600); r.push(x.allowed); retry = x.retryAfterSeconds; }
      assert.deepEqual(r, [true, true, true, false]); assert.ok(retry >= 1 && retry <= 3600);
      assert.equal((await consumeRateLimit(pool, `${key}:other`, 3, 3600)).allowed, true);
      await assert.rejects(consumeRateLimit(pool, '', 3, 60)); await assert.rejects(consumeRateLimit(pool, key, 0, 60)); await assert.rejects(consumeRateLimit(pool, 'k'.repeat(201), 1, 60));
    });
    it('isTeamAdmin: only a DB admin WITH a team qualifies; superadmin and team-less admins do not', () => {
      const p = { userId: 'u', clientId: 'c', tokenId: 't', scope: 'mcp:read', displayName: 'n' };
      assert.equal(isTeamAdmin({ ...p, role: 'admin', teamId: 'team-1' }), true);
      assert.equal(isTeamAdmin({ ...p, role: 'admin', teamId: null }), false);
      assert.equal(isTeamAdmin({ ...p, role: 'superadmin', teamId: 'team-1' }), false);
      assert.equal(isTeamAdmin({ ...p, role: 'user', teamId: 'team-1' }), false);
    });
  });
});
