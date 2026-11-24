/**
 * Live tests of the consent step (prepareAuthorize + handleDecision) against the explicit test branch with the real mcp_auth pool.
 * Same environment as the other mcp-oauth-* DB suites. Rows use unique synthetic ids and are removed in after().
 */
import { SKIP_DB, SKIP_REASON, connectionString, loadTestDb, TestDbConfigError } from './helpers/test-db'; // FIRST: installs the tripwire
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { createMcpPool, validateMcpAuthUrl, type McpPool } from '../lib/mcp/db';
import { loadOAuthConfig } from '../lib/mcp/oauth/config';
import { registerClient } from '../lib/mcp/oauth/clients';
import { prepareAuthorize, handleDecision, type ConsentView } from '../lib/mcp/oauth/authorize';
import { exchangeAuthorizationCode, authenticateAccessToken } from '../lib/mcp/oauth/tokens';
import { s256Challenge } from '../lib/mcp/oauth/crypto';
import { verifyConsent } from '../lib/mcp/oauth/consent';
import { encodeSessionToken, type SessionPayload } from '../lib/session-token';

const cfgDb = SKIP_DB ? undefined : loadTestDb('owner');
function mcpAuthUrl(): string {
  const raw = process.env.TEST_MCP_AUTH_DATABASE_URL?.trim();
  if (!raw) throw new TestDbConfigError('TEST_MCP_AUTH_DATABASE_URL is not set (the mcp_auth login of the SAME test branch).');
  const endpoint = new URL(raw).hostname.split('.')[0].replace(/-pooler$/, '');
  if (endpoint !== cfgDb!.endpoint) throw new TestDbConfigError(`TEST_MCP_AUTH_DATABASE_URL points at "${endpoint}", expected "${cfgDb!.endpoint}". Refusing to connect.`);
  return validateMcpAuthUrl(raw);
}

const SECRET = 'live-consent-test-secret-0123456789';
const cfg = loadOAuthConfig({ MCP_PUBLIC_BASE_URL: 'https://token-tracer-three.vercel.app', NODE_ENV: 'production' })!;
const CB = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'v'.repeat(43);
const CHALLENGE = s256Challenge(VERIFIER);
const RUN = crypto.randomBytes(5).toString('hex');
const HOST = new Headers({ host: cfg.host });
let owner: pg.Client; let pool: McpPool; let deps: { enabled: true; config: typeof cfg; pool: () => McpPool };
let teamId: string; let adminId: string; let clientId: string; let loopbackClientId: string;
const clientIds: string[] = []; const userIds: string[] = []; const teamIds: string[] = [];

const mkSession = (o: Partial<SessionPayload> = {}): SessionPayload => ({ userId: adminId, username: 'a', displayName: 'Admin', role: 'admin', memberId: null, teamId, issuedAt: Date.now() - 5000, lastActive: Date.now(), mfa: true, ...o });
const query = (o: Record<string, string | undefined> = {}) => ({ client_id: clientId, redirect_uri: CB, response_type: 'code', code_challenge: CHALLENGE, code_challenge_method: 'S256', state: 'st-1', ...o });
const prep = (q: Record<string, string | string[] | undefined>, session: SessionPayload | null, headers = HOST) => prepareAuthorize({ searchParams: q, session, headers, secret: SECRET }, deps);
async function mkUser(role: string, team: string | null, active = true): Promise<string> {
  const id = (await owner.query(`INSERT INTO users (username, password_hash, display_name, role, team_id, active) VALUES ($1, 'x-not-a-hash', 'Consent Test', $2, $3, $4) RETURNING id`, [`mcp-cs-${crypto.randomBytes(4).toString('hex')}-${RUN}`, role, team, active])).rows[0].id;
  userIds.push(id); return id;
}
const consentOf = async (session: SessionPayload, q = query()): Promise<ConsentView> => {
  const v = await prep(q, session); assert.equal(v.kind, 'consent', JSON.stringify(v)); return (v as { kind: 'consent'; view: ConsentView }).view;
};
const decide = async (body: unknown, o: { session?: SessionPayload | null; origin?: string | null; headers?: Record<string, string>; now?: number } = {}) => {
  const session = o.session === undefined ? mkSession() : o.session;
  const headers: Record<string, string> = { host: cfg.host, 'content-type': 'application/json', ...o.headers };
  if (o.origin !== null) headers.origin = o.origin ?? cfg.baseUrl;
  const res = await handleDecision(new Request('https://ignored.invalid/oauth/decision', { method: 'POST', headers, body: JSON.stringify(body) }),
    { ...deps, secret: SECRET, session: () => session, ...(o.now ? { now: () => o.now! } : {}) });
  const text = await res.text(); return { status: res.status, body: text ? JSON.parse(text) : null };
};
const auditCount = async (action: string, since: Date) => Number((await owner.query('SELECT count(*) FROM audit_log WHERE action = $1 AND created_at >= $2', [action, since])).rows[0].count);

describe('OAuth consent step (live test branch)', { skip: SKIP_DB ? SKIP_REASON : false }, () => {
  const started = new Date(Date.now() - 2000);
  before(async () => {
    owner = new pg.Client({ connectionString: connectionString(cfgDb!), ssl: { rejectUnauthorized: true } });
    await owner.connect();
    pool = createMcpPool(mcpAuthUrl());
    deps = { enabled: true, config: cfg, pool: () => pool };
    teamId = (await owner.query(`INSERT INTO teams (name) VALUES ($1) RETURNING id`, [`Consent Team ${RUN}`])).rows[0].id; teamIds.push(teamId);
    adminId = await mkUser('admin', teamId);
    clientId = (await registerClient(pool, { name: '<img src=x onerror=alert(1)> Claude', redirectUris: [CB] })).clientId; clientIds.push(clientId);
    loopbackClientId = (await registerClient(pool, { name: 'Claude Code', redirectUris: ['http://localhost:4000/callback'] })).clientId; clientIds.push(loopbackClientId);
  });
  after(async () => {
    try {
      await owner.query(`DELETE FROM audit_log WHERE action LIKE 'mcp.%' AND (actor_user_id = ANY($1) OR target_id = ANY($2))`, [userIds, clientIds]);
      await owner.query(`DELETE FROM mcp_rate_limits WHERE key LIKE 'consent:%'`);
      await owner.query('DELETE FROM oauth_clients WHERE client_id = ANY($1)', [clientIds]);
      await owner.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
      await owner.query('DELETE FROM teams WHERE id = ANY($1)', [teamIds]);
    } finally { await pool?.end().catch(() => {}); await owner?.end().catch(() => {}); }
  });

  describe('GET /oauth/authorize (prepareAuthorize)', () => {
    it('flag off or non-canonical Host → not_found; invalid configuration → unavailable', async () => {
      assert.equal((await prepareAuthorize({ searchParams: query(), session: mkSession(), headers: HOST, secret: SECRET }, { ...deps, enabled: false })).kind, 'not_found');
      assert.equal((await prep(query(), mkSession(), new Headers({ host: 'token-tracer-puce.vercel.app' }))).kind, 'not_found');
      assert.equal((await prep(query(), mkSession(), new Headers({ host: cfg.host, 'x-forwarded-host': 'evil.example' }))).kind, 'not_found');
      assert.equal((await prepareAuthorize({ searchParams: query(), session: mkSession(), headers: HOST, secret: SECRET }, { ...deps, config: null })).kind, 'unavailable');
    });
    it('an unknown client, a redirect_uri that is not registered, or repeated parameters is a FATAL error page — never a redirect', async () => {
      const fatal = async (q: Record<string, string | string[] | undefined>) => assert.equal((await prep(q, mkSession())).kind, 'fatal', JSON.stringify(q).slice(0, 80));
      await fatal(query({ client_id: 'tt_does_not_exist_x' }));
      await fatal(query({ redirect_uri: 'https://evil.example/cb' }));
      await fatal(query({ redirect_uri: 'https://claude.com/api/mcp/auth_callback' })); // a valid Claude URI, but not THIS client's
      await fatal(query({ redirect_uri: `${CB}?x=1` }));
      await fatal({ ...query(), redirect_uri: [CB, 'https://evil.example/cb'] });
      await fatal(query({ client_id: undefined })); await fatal(query({ redirect_uri: undefined }));
      await owner.query('UPDATE oauth_clients SET disabled_at = now() WHERE client_id = $1', [loopbackClientId]);
      assert.equal((await prep(query({ client_id: loopbackClientId, redirect_uri: 'http://localhost:4000/callback' }), mkSession())).kind, 'fatal'); // disabled client
      await owner.query('UPDATE oauth_clients SET disabled_at = NULL WHERE client_id = $1', [loopbackClientId]);
    });
    it('other defects go back to the VERIFIED redirect_uri as OAuth errors, with state and iss', async () => {
      const toErr = async (over: Record<string, string | undefined>, error: string, state: string | null = 'st-1') => {
        const v = await prep(query(over), mkSession()); assert.equal(v.kind, 'redirect');
        const u = new URL((v as { url: string }).url);
        assert.equal(`${u.origin}${u.pathname}`, CB); assert.equal(u.searchParams.get('error'), error); assert.equal(u.searchParams.get('state'), state); assert.equal(u.searchParams.get('iss'), cfg.baseUrl);
      };
      await toErr({ scope: 'mcp:write' }, 'invalid_scope'); await toErr({ code_challenge: undefined }, 'invalid_request'); await toErr({ code_challenge_method: 'plain' }, 'invalid_request');
      await toErr({ resource: 'https://evil.example/mcp' }, 'invalid_target'); await toErr({ response_type: 'token' }, 'invalid_request'); await toErr({ state: 'bad\nstate' }, 'invalid_request', null);
    });
    it('no session → login with a safe returnTo that carries the whole request', async () => {
      const v = await prep(query(), null); assert.equal(v.kind, 'login');
      const rt = (v as { returnTo: string }).returnTo;
      assert.ok(rt.startsWith('/oauth/authorize?')); assert.ok(!rt.startsWith('//'));
      const p = new URL(rt, 'https://x').searchParams; assert.equal(p.get('client_id'), clientId); assert.equal(p.get('redirect_uri'), CB); assert.equal(p.get('state'), 'st-1');
    });
    it('ineligible sessions get a fixed message, never a consent token', async () => {
      const inactive = await mkUser('admin', teamId, false); const noTeam = await mkUser('admin', null); const plain = await mkUser('user', teamId);
      const other = (await owner.query(`INSERT INTO teams (name) VALUES ($1) RETURNING id`, [`Other ${RUN}`])).rows[0].id; teamIds.push(other);
      const cases: Array<[string, SessionPayload]> = [
        ['builtin', mkSession({ userId: 'admin', teamId: null })], ['superadmin', mkSession({ userId: 'superadmin', role: 'superadmin', teamId: null })],
        ['impersonated', mkSession({ impersonatedBy: 'superadmin' })], ['plain user', mkSession({ userId: plain, role: 'user' })],
        ['inactive', mkSession({ userId: inactive })], ['no team', mkSession({ userId: noTeam, teamId: null })], ['stale team', mkSession({ teamId: other })],
        ['no mfa', mkSession({ mfa: false })], ['unknown user', mkSession({ userId: crypto.randomUUID() })],
      ];
      for (const [name, s] of cases) { const v = await prep(query(), s); assert.equal(v.kind, 'ineligible', name); assert.ok(!JSON.stringify(v).includes('consentToken'), name); }
    });
    it('an eligible admin gets a consent view bound to them; loopback is flagged; the hostile client name is data, not markup', async () => {
      const s = mkSession(); const v = await consentOf(s);
      assert.deepEqual([v.destination, v.loopback, v.teamName, v.userName], ['https://claude.ai', false, `Consent Team ${RUN}`, 'Consent Test']);
      assert.equal(v.clientName, '<img src=x onerror=alert(1)> Claude'); // returned verbatim as a STRING; the page renders it as escaped text
      const c = verifyConsent(v.consentToken, SECRET)!;
      assert.deepEqual([c.uid, c.sia, c.cid, c.ru, c.cc, c.sc, c.st, c.rs], [adminId, s.issuedAt, clientId, CB, CHALLENGE, 'mcp:read', 'st-1', cfg.resource]);
      const lb = await consentOf(s, query({ client_id: loopbackClientId, redirect_uri: 'http://localhost:51234/callback' })); // loopback: any port
      assert.deepEqual([lb.loopback, lb.destination], [true, 'an application running on your own computer']);
    });
  });

  describe('POST /oauth/decision (handleDecision)', () => {
    it('approve: issues a code for exactly the shown request; redirect carries code, state, iss; the code redeems into a team-admin principal', async () => {
      const s = mkSession(); const v = await consentOf(s);
      const r = await decide({ consent: v.consentToken, decision: 'approve' }, { session: s });
      assert.equal(r.status, 200);
      const u = new URL(r.body.redirect); assert.equal(`${u.origin}${u.pathname}`, CB);
      assert.deepEqual([u.searchParams.get('state'), u.searchParams.get('iss')], ['st-1', cfg.baseUrl]);
      const code = u.searchParams.get('code')!; assert.ok(code.startsWith('tt_ac_'));
      const pair = await exchangeAuthorizationCode(pool, { code, clientId, redirectUri: CB, codeVerifier: VERIFIER, resource: cfg.resource });
      const p = await authenticateAccessToken(pool, pair.accessToken, cfg.resource);
      assert.deepEqual([p?.userId, p?.role, p?.teamId], [adminId, 'admin', teamId]);
      assert.ok(await auditCount('mcp.authorization_granted', started) >= 1);
    });
    it('deny: no code is created; the client gets access_denied with its state; audited', async () => {
      const s = mkSession(); const v = await consentOf(s);
      const before = Number((await owner.query('SELECT count(*) FROM oauth_authorization_codes WHERE user_id = $1', [adminId])).rows[0].count);
      const r = await decide({ consent: v.consentToken, decision: 'deny' }, { session: s });
      const u = new URL(r.body.redirect); assert.deepEqual([u.searchParams.get('error'), u.searchParams.get('state'), u.searchParams.has('code')], ['access_denied', 'st-1', false]);
      assert.equal(Number((await owner.query('SELECT count(*) FROM oauth_authorization_codes WHERE user_id = $1', [adminId])).rows[0].count), before);
      assert.ok(await auditCount('mcp.authorization_denied', started) >= 1);
    });
    it('same-origin is enforced: missing, foreign or look-alike Origin, a cross-site fetch and a wrong content type are refused', async () => {
      const s = mkSession(); const v = await consentOf(s); const body = { consent: v.consentToken, decision: 'approve' };
      for (const origin of [null, 'https://evil.example', 'https://token-tracer-three.vercel.app.evil.example', 'http://token-tracer-three.vercel.app', 'null']) {
        assert.equal((await decide(body, { session: s, origin })).status, 403, String(origin));
      }
      assert.equal((await decide(body, { session: s, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
      assert.equal((await decide(body, { session: s, headers: { 'content-type': 'text/plain' } })).status, 415);
    });
    it('no session, a consent token for another user or session, tampering, expiry and bad decisions are refused', async () => {
      const s = mkSession(); const v = await consentOf(s); const ok = { consent: v.consentToken, decision: 'approve' };
      assert.equal((await decide(ok, { session: null })).status, 401);
      const other = await mkUser('admin', teamId);
      assert.equal((await decide(ok, { session: mkSession({ userId: other }) })).body.error, 'invalid_request'); // token minted for someone else
      assert.equal((await decide(ok, { session: mkSession({ issuedAt: s.issuedAt + 1 }) })).body.error, 'invalid_request'); // a different login session
      assert.equal((await decide({ consent: `${v.consentToken.slice(0, -3)}AAA`, decision: 'approve' }, { session: s })).body.error, 'invalid_request');
      assert.equal((await decide(ok, { session: s, now: Date.now() + 6 * 60 * 1000 })).body.error, 'invalid_request'); // expired
      for (const bad of [{ consent: v.consentToken }, { consent: v.consentToken, decision: 'maybe' }, { decision: 'approve' }, [], 'x']) assert.equal((await decide(bad, { session: s })).status, 400, JSON.stringify(bad));
    });
    it('a decision after the user lost eligibility, or after the client was disabled, is refused (and the loss is audited)', async () => {
      const u = await mkUser('admin', teamId); const s = mkSession({ userId: u });
      const v = await consentOf(s);
      await owner.query(`UPDATE users SET role = 'user' WHERE id = $1`, [u]); // demoted between page view and click
      const r = await decide({ consent: v.consentToken, decision: 'approve' }, { session: s });
      assert.deepEqual([r.status, r.body.error], [403, 'access_denied']);
      assert.ok(await auditCount('mcp.access_denied', started) >= 1);
      const s2 = mkSession(); const v2 = await consentOf(s2, query({ client_id: loopbackClientId, redirect_uri: 'http://localhost:4000/callback' }));
      await owner.query('UPDATE oauth_clients SET disabled_at = now() WHERE client_id = $1', [loopbackClientId]);
      assert.equal((await decide({ consent: v2.consentToken, decision: 'approve' }, { session: s2 })).body.error, 'invalid_request');
      await owner.query('UPDATE oauth_clients SET disabled_at = NULL WHERE client_id = $1', [loopbackClientId]);
    });
    it('reads the real session cookie when no session is injected, and the flag / host gates apply', async () => {
      const s = mkSession(); process.env.SESSION_SECRET ||= 'x'; const v = await consentOf(s);
      const cookie = `app_session=${encodeURIComponent(encodeSessionToken(s))}`;
      const mk = (headers: Record<string, string>) => new Request('https://x/oauth/decision', { method: 'POST', headers: { host: cfg.host, origin: cfg.baseUrl, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ consent: v.consentToken, decision: 'deny' }) });
      // the real cookie decodes, but the consent token above was signed with the test SECRET, so the (correct) outcome is a refused consent, NOT a 401
      const r = await handleDecision(mk({ cookie }), { ...deps, secret: SECRET });
      assert.equal(r.status, 200);
      assert.equal((await handleDecision(mk({}), { ...deps, secret: SECRET })).status, 401);
      assert.equal((await handleDecision(mk({ cookie }), { ...deps, secret: SECRET, enabled: false as never })).status, 404);
      assert.equal((await handleDecision(mk({ cookie, host: 'evil.example' }), { ...deps, secret: SECRET })).status, 404);
    });
  });
});
