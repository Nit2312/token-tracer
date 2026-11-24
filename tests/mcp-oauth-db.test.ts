/**
 * Live database tests for the MCP OAuth schema (scripts/migrations/mcp-oauth.sql) and the `mcp_auth` role (lib/mcp/grants.json).
 * Closes risk R1: tamper-guard triggers fire for a caller without EXECUTE on the guard functions, the SECURITY DEFINER audit function
 * is callable by mcp_auth, cannot be steered by search_path, and enforces its allowlists; retention purge; table constraints.
 *
 * Needs the explicit test branch (tests/README.md) with the migration applied and `mcp_auth` provisioned:
 *   TEST_DATABASE_URL (owner, direct), TEST_DATABASE_EXPECTED_ENDPOINT, and TEST_MCP_AUTH_DATABASE_URL (user mcp_auth, SAME endpoint).
 * Unlike the TEMP-table suites these use REAL committed rows (mcp_auth cannot see another session's temp tables) with unique synthetic
 * ids, removed again in after(). Nothing here ever reads a prompt, and no secret is printed.
 */
import { SKIP_DB, SKIP_REASON, connectionString, loadTestDb, TestDbConfigError } from './helpers/test-db'; // FIRST: installs the tripwire
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

const cfg = SKIP_DB ? undefined : loadTestDb('owner');

function mcpAuthUrl(): string {
  const raw = process.env.TEST_MCP_AUTH_DATABASE_URL?.trim();
  if (!raw) throw new TestDbConfigError('TEST_MCP_AUTH_DATABASE_URL is not set (the mcp_auth login of the SAME test branch).');
  const u = new URL(raw);
  const endpoint = u.hostname.split('.')[0].replace(/-pooler$/, '');
  if (endpoint !== cfg!.endpoint) throw new TestDbConfigError(`TEST_MCP_AUTH_DATABASE_URL points at "${endpoint}", expected "${cfg!.endpoint}". Refusing to connect.`);
  if (decodeURIComponent(u.username) !== 'mcp_auth') throw new TestDbConfigError('TEST_MCP_AUTH_DATABASE_URL must connect as the mcp_auth role.');
  u.searchParams.delete('sslmode');
  return u.toString();
}

const RUN = crypto.randomBytes(6).toString('hex');
const CLIENT = `tt_test_${RUN}`;
const STATIC_CLIENT = `tt_teststatic_${RUN}`;
const OLD_DCR_CLIENT = `tt_testold_${RUN}`;
const hash = () => crypto.randomBytes(32);
const uuid = () => crypto.randomUUID();
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'; // 43 chars
const RESOURCE = 'https://example.invalid/mcp';

let owner: pg.Client;
let app: pg.Client; // mcp_auth
let userId: string;

async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return 'OK'; } catch (e) { return (e as { code?: string }).code ?? 'ERR'; }
}

async function newToken(kind: 'access' | 'refresh' = 'access', family = uuid()): Promise<{ id: string; family: string }> {
  const r = await app.query(
    `INSERT INTO oauth_tokens (token_hash, kind, family_id, client_id, user_id, resource, scope, expires_at, absolute_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'mcp:read', now() + interval '30 minutes', now() + interval '60 days') RETURNING id`,
    [hash(), kind, family, CLIENT, userId, RESOURCE]);
  return { id: r.rows[0].id, family };
}
async function newCode(): Promise<Buffer> {
  const h = hash();
  await app.query(
    `INSERT INTO oauth_authorization_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, resource, scope, family_id, expires_at)
     VALUES ($1, $2, $3, 'https://claude.ai/api/mcp/auth_callback', $4, $5, 'mcp:read', $6, now() + interval '60 seconds')`,
    [h, CLIENT, userId, CHALLENGE, RESOURCE, uuid()]);
  return h;
}

describe('MCP OAuth schema + mcp_auth role (live test branch)', { skip: SKIP_DB ? SKIP_REASON : false }, () => {
  before(async () => {
    owner = new pg.Client({ connectionString: connectionString(cfg!), ssl: { rejectUnauthorized: true } });
    app = new pg.Client({ connectionString: mcpAuthUrl(), ssl: { rejectUnauthorized: true } });
    await owner.connect();
    await app.connect();
    assert.equal((await app.query('SELECT current_user u')).rows[0].u, 'mcp_auth');
    const u = await owner.query(
      `INSERT INTO users (username, password_hash, display_name, role) VALUES ($1, 'x-not-a-real-hash', 'MCP Test User', 'user') RETURNING id`,
      [`mcp-test-${RUN}`]);
    userId = u.rows[0].id;
    // The OAuth client is registered through mcp_auth itself, which also proves its INSERT grant.
    await app.query(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, registration) VALUES ($1, 'Test client', ARRAY['https://claude.ai/api/mcp/auth_callback'], 'dcr')`, [CLIENT]);
  });

  after(async () => {
    try {
      await owner.query('DELETE FROM mcp_access_log WHERE client_id = ANY($1)', [[CLIENT, STATIC_CLIENT, OLD_DCR_CLIENT]]);
      await owner.query(`DELETE FROM audit_log WHERE action LIKE 'mcp.%' AND (target_id LIKE $1 OR actor_user_id = $2)`, [`%${RUN}%`, userId]);
      await owner.query('DELETE FROM mcp_rate_limits WHERE key LIKE $1', [`test:${RUN}%`]);
      await owner.query('DELETE FROM oauth_clients WHERE client_id = ANY($1)', [[CLIENT, STATIC_CLIENT, OLD_DCR_CLIENT]]); // cascades codes + tokens
      if (userId) await owner.query('DELETE FROM users WHERE id = $1', [userId]);
    } finally {
      await app?.end().catch(() => {});
      await owner?.end().catch(() => {});
    }
  });

  describe('role facts that closed R1', () => {
    it('mcp_auth has NO execute on the trigger functions or the purge function, yet may execute the audit function', async () => {
      const r = await owner.query(
        `SELECT has_function_privilege('mcp_auth', 'mcp_guard_oauth_tokens()', 'EXECUTE') t,
                has_function_privilege('mcp_auth', 'mcp_guard_oauth_codes()', 'EXECUTE') c,
                has_function_privilege('mcp_auth', 'mcp_guard_oauth_clients()', 'EXECUTE') l,
                has_function_privilege('mcp_auth', 'mcp_oauth_purge()', 'EXECUTE') p,
                has_function_privilege('mcp_auth', 'mcp_audit_event(text, uuid, text, text, jsonb)', 'EXECUTE') a`);
      assert.deepEqual(r.rows[0], { t: false, c: false, l: false, p: false, a: true });
    });
    it('mcp_audit_event is SECURITY DEFINER with a pinned search_path; the guards are invoker-rights with a pinned search_path', async () => {
      const r = await owner.query(
        `SELECT proname, prosecdef, proconfig FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN
           ('mcp_audit_event','mcp_guard_oauth_tokens','mcp_guard_oauth_codes','mcp_guard_oauth_clients','mcp_oauth_purge') ORDER BY proname`);
      assert.equal(r.rows.length, 5);
      for (const f of r.rows) {
        assert.equal(f.prosecdef, f.proname === 'mcp_audit_event', `${f.proname} prosecdef`);
        assert.ok((f.proconfig ?? []).some((c: string) => /^search_path=pg_catalog, ?public$/.test(c)), `${f.proname} search_path pinned`);
      }
    });
    it('the guard triggers exist, are enabled, BEFORE UPDATE, FOR EACH ROW', async () => {
      const r = await owner.query(
        `SELECT tgname, tgenabled, (tgtype & 2) <> 0 AS before_row, (tgtype & 16) <> 0 AS on_update FROM pg_trigger
          WHERE NOT tgisinternal AND tgname LIKE 'trg_mcp_guard_%' ORDER BY tgname`);
      assert.equal(r.rows.length, 3);
      for (const t of r.rows) assert.deepEqual([t.tgenabled, t.before_row, t.on_update], ['O', true, true], t.tgname);
    });
  });

  describe('oauth_tokens guard (as mcp_auth, which cannot execute the trigger function)', () => {
    it('allows last_used_at and a one-way revocation; the trigger then blocks un-revoking and rewriting the reason', async () => {
      const { id } = await newToken();
      assert.equal(await code(app.query('UPDATE oauth_tokens SET last_used_at = now() WHERE id = $1', [id])), 'OK');
      assert.equal(await code(app.query(`UPDATE oauth_tokens SET revoked_at = now(), revoked_reason = 'logout' WHERE id = $1 AND revoked_at IS NULL`, [id])), 'OK');
      assert.equal(await code(app.query('UPDATE oauth_tokens SET revoked_at = NULL, revoked_reason = NULL WHERE id = $1', [id])), '42501'); // un-revoke
      assert.equal(await code(app.query(`UPDATE oauth_tokens SET revoked_reason = 'other' WHERE id = $1`, [id])), '42501');
      const row = (await owner.query('SELECT revoked_at IS NOT NULL r, revoked_reason FROM oauth_tokens WHERE id = $1', [id])).rows[0];
      assert.deepEqual(row, { r: true, revoked_reason: 'logout' });
    });
    it('rotation is one-way: rotated_at / replaced_by_id cannot be cleared or changed', async () => {
      const { id } = await newToken('refresh');
      const next = await newToken('refresh');
      assert.equal(await code(app.query('UPDATE oauth_tokens SET rotated_at = now(), replaced_by_id = $2 WHERE id = $1', [id, next.id])), 'OK');
      assert.equal(await code(app.query('UPDATE oauth_tokens SET rotated_at = NULL WHERE id = $1', [id])), '42501');
      assert.equal(await code(app.query('UPDATE oauth_tokens SET replaced_by_id = NULL WHERE id = $1', [id])), '42501');
    });
    it('identity columns cannot change for ANYONE, including the owner (trigger), and mcp_auth lacks the column grant (privilege)', async () => {
      const { id } = await newToken();
      assert.equal(await code(app.query(`UPDATE oauth_tokens SET expires_at = now() + interval '99 days' WHERE id = $1`, [id])), '42501'); // no UPDATE grant
      assert.equal(await code(owner.query(`UPDATE oauth_tokens SET expires_at = now() + interval '99 days' WHERE id = $1`, [id])), '42501'); // trigger
      assert.equal(await code(owner.query('UPDATE oauth_tokens SET user_id = $2 WHERE id = $1', [id, uuid()])), '42501'); // trigger fires before the FK check
      assert.equal(await code(owner.query(`UPDATE oauth_tokens SET kind = 'refresh' WHERE id = $1`, [id])), '42501');
    });
    it('the owner cannot un-revoke either (the guard binds the table owner)', async () => {
      const { id } = await newToken();
      await app.query(`UPDATE oauth_tokens SET revoked_at = now(), revoked_reason = 'x' WHERE id = $1`, [id]);
      assert.equal(await code(owner.query('UPDATE oauth_tokens SET revoked_at = NULL WHERE id = $1', [id])), '42501');
    });
    it('mcp_auth cannot DELETE a token or insert a token with a wrong shape', async () => {
      const { id } = await newToken();
      assert.equal(await code(app.query('DELETE FROM oauth_tokens WHERE id = $1', [id])), '42501');
      assert.equal(await code(app.query(
        `INSERT INTO oauth_tokens (token_hash, kind, family_id, client_id, user_id, resource, scope, expires_at, absolute_expires_at)
         VALUES ($1, 'access', $2, $3, $4, $5, 'mcp:admin', now(), now())`, [hash(), uuid(), CLIENT, userId, RESOURCE])), '23514'); // scope CHECK
    });
  });

  describe('oauth_authorization_codes guard', () => {
    it('allows consuming once; a consumed code cannot be re-armed', async () => {
      const h = await newCode();
      assert.equal(await code(app.query('UPDATE oauth_authorization_codes SET consumed_at = now() WHERE code_hash = $1 AND consumed_at IS NULL', [h])), 'OK');
      assert.equal(await code(app.query('UPDATE oauth_authorization_codes SET consumed_at = NULL WHERE code_hash = $1', [h])), '42501');
      assert.equal(await code(owner.query('UPDATE oauth_authorization_codes SET consumed_at = NULL WHERE code_hash = $1', [h])), '42501'); // binds the owner
    });
    it('exactly one of two concurrent consumers wins (single-use)', async () => {
      const h = await newCode();
      const second = new pg.Client({ connectionString: mcpAuthUrl(), ssl: { rejectUnauthorized: true } });
      await second.connect();
      try {
        const sql = 'UPDATE oauth_authorization_codes SET consumed_at = now() WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > now()';
        const [a, b] = await Promise.all([app.query(sql, [h]), second.query(sql, [h])]);
        assert.equal((a.rowCount ?? 0) + (b.rowCount ?? 0), 1);
      } finally { await second.end(); }
    });
    it('the redirect_uri / challenge / expiry of a code cannot be rewritten, even by the owner', async () => {
      const h = await newCode();
      assert.equal(await code(app.query(`UPDATE oauth_authorization_codes SET redirect_uri = 'https://evil.invalid/' WHERE code_hash = $1`, [h])), '42501'); // grant
      assert.equal(await code(owner.query(`UPDATE oauth_authorization_codes SET redirect_uri = 'https://evil.invalid/' WHERE code_hash = $1`, [h])), '42501'); // trigger
      assert.equal(await code(owner.query(`UPDATE oauth_authorization_codes SET expires_at = now() + interval '1 day' WHERE code_hash = $1`, [h])), '42501');
    });
  });

  describe('oauth_clients guard', () => {
    it('mcp_auth may touch last_used_at only; registration data is immutable for everyone; the owner may disable and re-enable', async () => {
      assert.equal(await code(app.query('UPDATE oauth_clients SET last_used_at = now() WHERE client_id = $1', [CLIENT])), 'OK');
      assert.equal(await code(app.query(`UPDATE oauth_clients SET redirect_uris = ARRAY['https://evil.invalid/'] WHERE client_id = $1`, [CLIENT])), '42501'); // grant
      assert.equal(await code(app.query('UPDATE oauth_clients SET disabled_at = NULL WHERE client_id = $1', [CLIENT])), '42501'); // grant
      assert.equal(await code(owner.query(`UPDATE oauth_clients SET redirect_uris = ARRAY['https://evil.invalid/'] WHERE client_id = $1`, [CLIENT])), '42501'); // trigger
      assert.equal(await code(owner.query(`UPDATE oauth_clients SET client_name = 'renamed' WHERE client_id = $1`, [CLIENT])), '42501');
      assert.equal(await code(owner.query('UPDATE oauth_clients SET disabled_at = now() WHERE client_id = $1', [CLIENT])), 'OK');
      assert.equal(await code(owner.query('UPDATE oauth_clients SET disabled_at = NULL WHERE client_id = $1', [CLIENT])), 'OK');
    });
  });

  describe('table constraints', () => {
    const insClient = (id: string, over: Record<string, unknown> = {}) => {
      const v = { name: 'c', uris: ['https://claude.ai/api/mcp/auth_callback'], auth: 'none', scope: 'mcp:read', reg: 'dcr', grants: ['authorization_code', 'refresh_token'], ...over };
      return app.query(
        `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, grant_types, token_endpoint_auth_method, scope, registration)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id, v.name, v.uris, v.grants, v.auth, v.scope, v.reg]);
    };
    it('rejects confidential-client auth, a foreign scope, an unknown registration kind, bad grant types, 0 or 6 redirect URIs, empty/oversized names', async () => {
      const id = () => `tt_c_${crypto.randomBytes(5).toString('hex')}_${RUN}`;
      assert.equal(await code(insClient(id(), { auth: 'client_secret_basic' })), '23514');
      assert.equal(await code(insClient(id(), { scope: 'mcp:write' })), '23514');
      assert.equal(await code(insClient(id(), { reg: 'cimd' })), '23514');
      assert.equal(await code(insClient(id(), { grants: ['password'] })), '23514');
      assert.equal(await code(insClient(id(), { uris: [] })), '23514');
      assert.equal(await code(insClient(id(), { uris: Array.from({ length: 6 }, (_, i) => `https://claude.ai/cb${i}`) })), '23514');
      assert.equal(await code(insClient(id(), { name: '' })), '23514');
      assert.equal(await code(insClient(id(), { name: 'x'.repeat(101) })), '23514');
    });
    it('rejects a code hash / challenge of the wrong length and a token hash of the wrong length or kind', async () => {
      assert.equal(await code(app.query(
        `INSERT INTO oauth_authorization_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, resource, scope, family_id, expires_at)
         VALUES ($1, $2, $3, 'https://claude.ai/api/mcp/auth_callback', $4, $5, 'mcp:read', $6, now())`, [crypto.randomBytes(16), CLIENT, userId, CHALLENGE, RESOURCE, uuid()])), '23514');
      assert.equal(await code(app.query(
        `INSERT INTO oauth_authorization_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, resource, scope, family_id, expires_at)
         VALUES ($1, $2, $3, 'https://claude.ai/api/mcp/auth_callback', 'short', $4, 'mcp:read', $5, now())`, [hash(), CLIENT, userId, RESOURCE, uuid()])), '23514');
      assert.equal(await code(app.query(
        `INSERT INTO oauth_tokens (token_hash, kind, family_id, client_id, user_id, resource, scope, expires_at, absolute_expires_at)
         VALUES ($1, 'access', $2, $3, $4, $5, 'mcp:read', now(), now())`, [crypto.randomBytes(8), uuid(), CLIENT, userId, RESOURCE])), '23514');
      assert.equal(await code(app.query(
        `INSERT INTO oauth_tokens (token_hash, kind, family_id, client_id, user_id, resource, scope, expires_at, absolute_expires_at)
         VALUES ($1, 'bearer', $2, $3, $4, $5, 'mcp:read', now(), now())`, [hash(), uuid(), CLIENT, userId, RESOURCE])), '23514');
    });
    it('rejects a duplicate token hash and a token for an unknown client or user (foreign keys)', async () => {
      const h = hash();
      const ins = (hh: Buffer, client: string, user: string) => app.query(
        `INSERT INTO oauth_tokens (token_hash, kind, family_id, client_id, user_id, resource, scope, expires_at, absolute_expires_at)
         VALUES ($1, 'access', $2, $3, $4, $5, 'mcp:read', now() + interval '1 minute', now() + interval '1 day')`, [hh, uuid(), client, user, RESOURCE]);
      assert.equal(await code(ins(h, CLIENT, userId)), 'OK');
      assert.equal(await code(ins(h, CLIENT, userId)), '23505');
      assert.equal(await code(ins(hash(), 'tt_does_not_exist', userId)), '23503');
      assert.equal(await code(ins(hash(), CLIENT, uuid())), '23503');
    });
  });

  describe('mcp_audit_event (SECURITY DEFINER) as mcp_auth', () => {
    const call = (ev: string, actor: string | null, type: string | null, target: string | null, meta: unknown = null) =>
      app.query('SELECT mcp_audit_event($1, $2, $3, $4, $5::jsonb)', [ev, actor, type, target, meta === null ? null : JSON.stringify(meta)]);
    const rows = async (target: string) => (await owner.query('SELECT actor_user_id, actor_username, action, target_type, target_id, metadata FROM audit_log WHERE target_id = $1', [target])).rows;

    it('writes exactly one audit_log row with the fixed "mcp." prefix; the username is looked up by the function, never supplied', async () => {
      const target = `tok-${RUN}-1`;
      assert.equal(await code(call('token_issued', userId, 'oauth_token', target, { n: 1 })), 'OK');
      const r = await rows(target);
      assert.equal(r.length, 1);
      assert.deepEqual([r[0].action, r[0].actor_user_id, r[0].actor_username, r[0].target_type, r[0].metadata], ['mcp.token_issued', userId, `mcp-test-${RUN}`, 'oauth_token', { n: 1 }]);
    });
    it('accepts every allowlisted event and a NULL actor / target / meta', async () => {
      for (const ev of ['client_registered', 'authorization_granted', 'authorization_denied', 'code_replayed', 'token_issued', 'token_refreshed',
        'refresh_reuse_detected', 'token_revoked', 'tokens_revoked_for_user', 'access_denied']) {
        assert.equal(await code(call(ev, null, null, null)), 'OK', ev);
      }
      await owner.query(`DELETE FROM audit_log WHERE action LIKE 'mcp.%' AND actor_user_id IS NULL AND target_id IS NULL AND created_at > now() - interval '1 minute' AND target_type IS NULL`);
    });
    it('rejects unlisted events, forged prefixes and NULL (22023), writing nothing', async () => {
      const target = `forge-${RUN}`;
      for (const ev of ['not_an_event', 'mcp.token_issued', 'login', 'token_issued ', "x'); DROP TABLE users;--", '']) {
        assert.equal(await code(call(ev, userId, 'oauth_token', target)), '22023', JSON.stringify(ev));
      }
      assert.equal(await code(app.query('SELECT mcp_audit_event(NULL, NULL, NULL, NULL, NULL)')), '22023');
      assert.equal((await rows(target)).length, 0);
    });
    it('rejects unknown target types, malformed / oversized target ids, non-object or oversized metadata, and an unknown actor (22023)', async () => {
      assert.equal(await code(call('token_issued', userId, 'users', `t-${RUN}`)), '22023');
      assert.equal(await code(call('token_issued', userId, 'oauth_token', 'has space')), '22023');
      assert.equal(await code(call('token_issued', userId, 'oauth_token', 'semi;colon')), '22023');
      assert.equal(await code(call('token_issued', userId, 'oauth_token', 'a'.repeat(129))), '22023');
      assert.equal(await code(call('token_issued', userId, 'oauth_token', `t-${RUN}`, ['array'])), '22023');
      assert.equal(await code(call('token_issued', userId, 'oauth_token', `t-${RUN}`, 'a string')), '22023');
      assert.equal(await code(call('token_issued', userId, 'oauth_token', `t-${RUN}`, { big: 'x'.repeat(2100) })), '22023');
      assert.equal(await code(call('token_issued', uuid(), 'oauth_token', `t-${RUN}`)), '22023');
    });
    it('cannot be steered by the caller\'s search_path: a temp "users" table in pg_temp is ignored (unknown actor still 22023)', async () => {
      const fake = uuid();
      try {
        await app.query('BEGIN');
        const created = await code(app.query('CREATE TEMP TABLE users (id uuid, username text)'));
        if (created === 'OK') await app.query(`INSERT INTO pg_temp.users VALUES ('${fake}', 'spoofed-admin')`);
        await app.query('SET LOCAL search_path = pg_temp, public');
        assert.equal(await code(app.query('SELECT mcp_audit_event($1, $2, $3, $4, NULL)', ['token_issued', fake, 'oauth_token', `t-${RUN}`])), '22023');
      } finally { await app.query('ROLLBACK'); }
      assert.equal((await rows(`t-${RUN}`)).length, 0);
    });
    it('mcp_auth still cannot touch audit_log directly, or call the purge function', async () => {
      assert.equal(await code(app.query(`INSERT INTO audit_log (action) VALUES ('mcp.forged')`)), '42501');
      assert.equal(await code(app.query('SELECT 1 FROM audit_log LIMIT 1')), '42501');
      assert.equal(await code(app.query('SELECT mcp_oauth_purge()')), '42501');
    });
  });

  describe('mcp_access_log / mcp_rate_limits', () => {
    it('mcp_auth can append to the access log and bump a rate-limit counter, but cannot read prompts or edit/delete log rows', async () => {
      assert.equal(await code(app.query(
        `INSERT INTO mcp_access_log (user_id, client_id, event, tool, outcome, status, row_count, duration_ms) VALUES ($1, $2, 'tool_call', 'list_team_developers', 'ok', 200, 3, 12)`,
        [userId, CLIENT])), 'OK');
      assert.equal(await code(app.query('UPDATE mcp_access_log SET outcome = $1 WHERE client_id = $2', ['x', CLIENT])), '42501');
      assert.equal(await code(app.query('DELETE FROM mcp_access_log WHERE client_id = $1', [CLIENT])), '42501');
      const key = `test:${RUN}:rl`;
      assert.equal(await code(app.query(
        `INSERT INTO mcp_rate_limits (key, window_start, count) VALUES ($1, date_trunc('minute', now()), 1) ON CONFLICT (key, window_start) DO UPDATE SET count = mcp_rate_limits.count + 1`, [key])), 'OK');
      assert.equal(await code(app.query('SELECT session_id FROM session_turns LIMIT 1')), '42501');
    });
  });

  describe('mcp_oauth_purge (owner only)', () => {
    it('deletes expired codes, dead tokens, old windows/log rows and unused old DCR clients; keeps everything live', async () => {
      // Old unused DCR client (owner sets created_at; mcp_auth could not), an old STATIC client, and live rows that must survive.
      await owner.query(
        `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, registration, created_at) VALUES
           ($1, 'old dcr', ARRAY['https://claude.ai/api/mcp/auth_callback'], 'dcr', now() - interval '40 days'),
           ($2, 'old static', ARRAY['https://claude.ai/api/mcp/auth_callback'], 'static', now() - interval '400 days')`, [OLD_DCR_CLIENT, STATIC_CLIENT]);
      const expiredCode = hash(); const liveCode = await newCode();
      await owner.query(
        `INSERT INTO oauth_authorization_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, resource, scope, family_id, created_at, expires_at)
         VALUES ($1, $2, $3, 'https://claude.ai/api/mcp/auth_callback', $4, $5, 'mcp:read', $6, now() - interval '3 hours', now() - interval '2 hours')`,
        [expiredCode, CLIENT, userId, CHALLENGE, RESOURCE, uuid()]);
      const mk = (kind: string, exp: string, abs: string) => owner.query(
        `INSERT INTO oauth_tokens (token_hash, kind, family_id, client_id, user_id, resource, scope, created_at, expires_at, absolute_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'mcp:read', now() - interval '70 days', now() + $7::interval, now() + $8::interval) RETURNING id`,
        [hash(), kind, uuid(), CLIENT, userId, RESOURCE, exp, abs]).then((r) => r.rows[0].id as string);
      const deadAccess = await mk('access', '-2 days', '-2 days');
      const liveRefreshPastIdle = await mk('refresh', '-2 days', '+10 days'); // idle expiry passed, family still alive: KEEP (reuse detection)
      const deadFamily = await mk('refresh', '-3 days', '-2 days');
      const liveAccess = await mk('access', '+10 minutes', '+10 days');
      const oldWindow = `test:${RUN}:old`;
      await owner.query(`INSERT INTO mcp_rate_limits (key, window_start, count) VALUES ($1, now() - interval '3 days', 5)`, [oldWindow]);
      await owner.query(`INSERT INTO mcp_access_log (at, client_id, event) VALUES (now() - interval '200 days', $1, 'old'), (now(), $1, 'new')`, [CLIENT]);

      const res = (await owner.query('SELECT mcp_oauth_purge() r')).rows[0].r;
      for (const k of ['codes', 'tokens', 'rate_limits', 'access_log', 'clients']) assert.ok(res[k] >= 1, `${k} count ${JSON.stringify(res)}`);

      const exists = async (sql: string, p: unknown[]) => (await owner.query(sql, p)).rowCount === 1;
      assert.equal(await exists('SELECT 1 FROM oauth_authorization_codes WHERE code_hash = $1', [expiredCode]), false);
      assert.equal(await exists('SELECT 1 FROM oauth_authorization_codes WHERE code_hash = $1', [liveCode]), true);
      assert.equal(await exists('SELECT 1 FROM oauth_tokens WHERE id = $1', [deadAccess]), false);
      assert.equal(await exists('SELECT 1 FROM oauth_tokens WHERE id = $1', [deadFamily]), false);
      assert.equal(await exists('SELECT 1 FROM oauth_tokens WHERE id = $1', [liveRefreshPastIdle]), true);
      assert.equal(await exists('SELECT 1 FROM oauth_tokens WHERE id = $1', [liveAccess]), true);
      assert.equal(await exists('SELECT 1 FROM mcp_rate_limits WHERE key = $1', [oldWindow]), false);
      assert.equal(await exists(`SELECT 1 FROM mcp_access_log WHERE client_id = $1 AND event = 'old'`, [CLIENT]), false);
      assert.equal(await exists(`SELECT 1 FROM mcp_access_log WHERE client_id = $1 AND event = 'new'`, [CLIENT]), true);
      assert.equal(await exists('SELECT 1 FROM oauth_clients WHERE client_id = $1', [OLD_DCR_CLIENT]), false); // unused DCR client purged
      assert.equal(await exists('SELECT 1 FROM oauth_clients WHERE client_id = $1', [STATIC_CLIENT]), true); // static client never purged
      assert.equal(await exists('SELECT 1 FROM oauth_clients WHERE client_id = $1', [CLIENT]), true); // client with tokens/codes kept
    });
  });
});
