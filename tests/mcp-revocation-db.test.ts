/**
 * Live tests of MCP revocation (lib/team/mcp-revoke.ts) against the explicit test branch: user / member / team targets, idempotency and
 * one-way reasons, audit rows, ordering around the change, failure semantics, and the "re-promotion cannot revive an old token" scenario.
 * The helper runs with the OWNER connection injected (the application's role); the bearer re-check runs through the real mcp_auth pool.
 */
import { SKIP_DB, SKIP_REASON, connectionString, loadTestDb, TestDbConfigError } from './helpers/test-db'; // FIRST: installs the tripwire
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import type { Queryable } from '../lib/team/db';
import { revokeMcpAccess, withMcpRevocation } from '../lib/team/mcp-revoke';
import { createMcpPool, validateMcpAuthUrl, type McpPool } from '../lib/mcp/db';
import { registerClient } from '../lib/mcp/oauth/clients';
import { s256Challenge } from '../lib/mcp/oauth/crypto';
import { authenticateAccessToken, createAuthorizationCode, exchangeAuthorizationCode, refreshTokens, type TokenPair } from '../lib/mcp/oauth/tokens';

const cfgDb = SKIP_DB ? undefined : loadTestDb('owner');
function mcpAuthUrl(): string {
  const raw = process.env.TEST_MCP_AUTH_DATABASE_URL?.trim();
  if (!raw) throw new TestDbConfigError('TEST_MCP_AUTH_DATABASE_URL is not set (the mcp_auth login of the SAME test branch).');
  const endpoint = new URL(raw).hostname.split('.')[0].replace(/-pooler$/, '');
  if (endpoint !== cfgDb!.endpoint) throw new TestDbConfigError(`TEST_MCP_AUTH_DATABASE_URL points at "${endpoint}", expected "${cfgDb!.endpoint}". Refusing to connect.`);
  return validateMcpAuthUrl(raw);
}

const RESOURCE = 'https://example.invalid/mcp';
const CB = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'v'.repeat(43);
const RUN = crypto.randomBytes(5).toString('hex');
let owner: pg.Client; let db: Queryable; let pool: McpPool; let teamA: string; let teamB: string; let clientId: string;
const userIds: string[] = []; const teamIds: string[] = []; const memberIds: string[] = []; const clientIds: string[] = [];
const since = new Date(Date.now() - 2000);

async function mkUser(team: string | null, member: string | null = null, role = 'admin'): Promise<string> {
  const id = (await owner.query(`INSERT INTO users (username, password_hash, display_name, role, team_id, member_id) VALUES ($1, 'x-not-a-hash', 'Revoke Test', $2, $3, $4) RETURNING id`, [`mcp-rv-${crypto.randomBytes(4).toString('hex')}-${RUN}`, role, team, member])).rows[0].id;
  userIds.push(id); return id;
}
async function mkMember(team: string): Promise<string> { const id = (await owner.query(`INSERT INTO members (team_id, display_name, role) VALUES ($1, $2, 'member') RETURNING id`, [team, `Revoke Member ${RUN}`])).rows[0].id; memberIds.push(id); return id; }
async function issue(uid: string): Promise<TokenPair> {
  const code = await createAuthorizationCode(pool, { clientId, userId: uid, redirectUri: CB, codeChallenge: s256Challenge(VERIFIER), resource: RESOURCE, scope: 'mcp:read' });
  return exchangeAuthorizationCode(pool, { code, clientId, redirectUri: CB, codeVerifier: VERIFIER, resource: RESOURCE });
}
const live = async (uid: string) => Number((await owner.query('SELECT count(*) FROM oauth_tokens WHERE user_id = $1 AND revoked_at IS NULL', [uid])).rows[0].count);
const valid = async (t: TokenPair) => (await authenticateAccessToken(pool, t.accessToken, RESOURCE)) !== null;
const audits = async (uid: string) => (await owner.query(`SELECT metadata FROM audit_log WHERE action = 'mcp.tokens_revoked_for_user' AND actor_user_id = $1 AND created_at >= $2`, [uid, since])).rows;

describe('MCP revocation helper (live test branch)', { skip: SKIP_DB ? SKIP_REASON : false }, () => {
  before(async () => {
    owner = new pg.Client({ connectionString: connectionString(cfgDb!), ssl: { rejectUnauthorized: true } }); await owner.connect();
    db = { query: ((text: string, params?: unknown[]) => owner.query(text, params)) as Queryable['query'] };
    pool = createMcpPool(mcpAuthUrl());
    teamA = (await owner.query(`INSERT INTO teams (name) VALUES ($1) RETURNING id`, [`Revoke Team A ${RUN}`])).rows[0].id; teamIds.push(teamA);
    teamB = (await owner.query(`INSERT INTO teams (name) VALUES ($1) RETURNING id`, [`Revoke Team B ${RUN}`])).rows[0].id; teamIds.push(teamB);
    clientId = (await registerClient(pool, { name: 'Revoke test client', redirectUris: [CB] })).clientId; clientIds.push(clientId);
  });
  after(async () => {
    try {
      await owner.query(`DELETE FROM audit_log WHERE action LIKE 'mcp.%' AND (actor_user_id = ANY($1) OR target_id = ANY($2) OR actor_username LIKE $3)`, [userIds, clientIds, `mcp-rv-%-${RUN}`]);
      await owner.query('DELETE FROM oauth_clients WHERE client_id = ANY($1)', [clientIds]);
      await owner.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
      await owner.query('DELETE FROM members WHERE id = ANY($1)', [memberIds]);
      await owner.query('DELETE FROM teams WHERE id = ANY($1)', [teamIds]);
    } finally { await pool?.end().catch(() => {}); await owner?.end().catch(() => {}); }
  });

  it('by user: revokes every live token of that user (access AND refresh), leaves others alone, audits once with count and reason', async () => {
    const a = await mkUser(teamA); const b = await mkUser(teamA);
    const ta = await issue(a); await issue(a); const tb = await issue(b);
    assert.equal(await live(a), 4);
    assert.equal(await revokeMcpAccess({ userId: a }, 'password_reset', db), 4);
    assert.equal(await live(a), 0); assert.equal(await valid(ta), false); assert.equal(await valid(tb), true);
    await assert.rejects(refreshTokens(pool, { refreshToken: ta.refreshToken, clientId }), /invalid_grant/);
    const rows = await audits(a); assert.equal(rows.length, 1); assert.deepEqual(rows[0].metadata, { revoked: 4, reason: 'password_reset' });
    assert.equal((await owner.query(`SELECT DISTINCT revoked_reason FROM oauth_tokens WHERE user_id = $1`, [a])).rows[0].revoked_reason, 'password_reset');
  });

  it('is idempotent and one-way: a second call revokes nothing, writes no audit row, and never rewrites the original reason', async () => {
    const u = await mkUser(teamA); await issue(u);
    assert.equal(await revokeMcpAccess({ userId: u }, 'mfa_reset', db), 2);
    assert.equal(await revokeMcpAccess({ userId: u }, 'role_changed', db), 0);
    assert.equal((await audits(u)).length, 1);
    assert.equal((await owner.query(`SELECT DISTINCT revoked_reason FROM oauth_tokens WHERE user_id = $1`, [u])).rows[0].revoked_reason, 'mfa_reset');
  });

  it('by member: only the accounts linked to that member; by team: only that team\'s accounts', async () => {
    const m1 = await mkMember(teamA); const m2 = await mkMember(teamA);
    const u1 = await mkUser(teamA, m1); const u2 = await mkUser(teamA, m2); const u3 = await mkUser(teamB);
    await issue(u1); await issue(u2); await issue(u3);
    assert.equal(await revokeMcpAccess({ memberId: m1 }, 'member_removed', db), 2);
    assert.deepEqual([await live(u1), await live(u2), await live(u3)], [0, 2, 2]);
    const t2 = await issue(u3); void t2;
    assert.equal(await revokeMcpAccess({ teamId: teamB }, 'team_deleted', db), 4);
    assert.deepEqual([await live(u2), await live(u3)], [2, 0]); // team A's other admin is untouched
    assert.equal((await audits(u3)).length, 1);
  });

  it('ids that are not UUIDs revoke nothing and cannot inject SQL; nothing throws', async () => {
    const u = await mkUser(teamA); await issue(u);
    for (const bad of ['', 'not-a-uuid', "x'; UPDATE oauth_tokens SET revoked_at = now(); --", '00000000-0000-0000-0000-00000000000g', 'A'.repeat(500)]) {
      assert.equal(await revokeMcpAccess({ userId: bad }, 'password_reset', db), 0, bad.slice(0, 20));
      assert.equal(await revokeMcpAccess({ memberId: bad }, 'password_reset', db), 0); assert.equal(await revokeMcpAccess({ teamId: bad }, 'password_reset', db), 0);
    }
    assert.equal(await live(u), 2);
    assert.equal(await revokeMcpAccess({ userId: crypto.randomUUID() }, 'password_reset', db), 0); // valid but unknown: nothing to do
  });

  it('withMcpRevocation: tokens are already dead when the change runs, and a token created DURING the change is revoked afterwards', async () => {
    const u = await mkUser(teamA); await issue(u);
    let liveDuringChange = -1; let late: TokenPair | undefined;
    await withMcpRevocation({ userId: u }, 'password_reset', async () => {
      liveDuringChange = await live(u);
      late = await issue(u); // the window: a refresh/exchange that completes between the two revokes
      assert.equal(await valid(late), true);
    }, db);
    assert.equal(liveDuringChange, 0); assert.equal(await valid(late!), false); assert.equal(await live(u), 0);
  });

  it('failure semantics: a real database error BLOCKS the change; a missing relation does not; an audit failure never undoes the revoke', async () => {
    const u = await mkUser(teamA); await issue(u);
    let ran = false;
    const broken: Queryable = { query: (async () => { throw Object.assign(new Error('connection lost'), { code: '08006' }); }) as Queryable['query'] };
    await assert.rejects(withMcpRevocation({ userId: u }, 'password_reset', async () => { ran = true; }, broken), /connection lost/);
    assert.equal(ran, false); assert.equal(await live(u), 2); // nothing changed, nothing revoked: the operation failed as a whole
    const noTables: Queryable = { query: (async () => { throw Object.assign(new Error('relation "oauth_tokens" does not exist'), { code: '42P01' }); }) as Queryable['query'] };
    await withMcpRevocation({ userId: u }, 'password_reset', async () => { ran = true; }, noTables);
    assert.equal(ran, true); // a missing-relation error (belt and braces) still lets the operation proceed
    // The normal "migration not applied" path: the catalog check says the table is absent, so NOTHING else is queried (no UPDATE, no error).
    const asked: string[] = [];
    const absent: Queryable = { query: (async (text: string) => { asked.push(text); return { rows: [{ ok: false }], rowCount: 1 }; }) as unknown as Queryable['query'] };
    ran = false; await withMcpRevocation({ userId: u }, 'password_reset', async () => { ran = true; }, absent);
    assert.equal(ran, true); assert.equal(asked.length, 2); assert.ok(asked.every((t) => /to_regclass\('public\.oauth_tokens'\)/.test(t)), 'only the catalog check ran, twice (before and after)');
    const auditBroken: Queryable = { query: (async (text: string, params?: unknown[]) => { if (/mcp_audit_event/.test(text)) throw new Error('audit down'); return owner.query(text, params); }) as Queryable['query'] };
    assert.equal(await revokeMcpAccess({ userId: u }, 'password_reset', auditBroken), 2);
    assert.equal(await live(u), 0);
  });

  it('REVIVAL: demote → revoke → re-promote (or move to another team) leaves the OLD token dead; without the hook it would have come back', async () => {
    const u = await mkUser(teamA); const t = await issue(u);
    assert.equal(await valid(t), true);
    // control: the bearer re-check alone blocks a demoted admin ...
    await owner.query(`UPDATE users SET role = 'user' WHERE id = $1`, [u]); assert.equal(await valid(t), false);
    // ... but re-promotion would revive the token if nothing revoked it:
    await owner.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [u]); assert.equal(await valid(t), true, 'control: without a revoke the token revives');
    await revokeMcpAccess({ userId: u }, 'role_changed', db); // what the hook does at the moment of demotion
    await owner.query(`UPDATE users SET role = 'user' WHERE id = $1`, [u]); await owner.query(`UPDATE users SET role = 'admin', team_id = $2 WHERE id = $1`, [u, teamB]);
    assert.equal(await valid(t), false); await assert.rejects(refreshTokens(pool, { refreshToken: t.refreshToken, clientId }), /invalid_grant/);
    const fresh = await issue(u); assert.equal(await valid(fresh), true); // a NEW, deliberate consent works normally
  });
});
