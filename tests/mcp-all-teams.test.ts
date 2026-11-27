/**
 * "All teams" admins (DB-free): which team a request acts on, who may authorize, and how the tool arguments behave.
 * The database half (the marker table, _resolve_scope, list_teams) is checked statically in mcp-data-sql.test.ts and live in the DB suites.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { scopeFromPrincipal, scopeDbArgs } from '../lib/mcp/data/scope';
import { isDataError } from '../lib/mcp/data/errors';
import { evaluateGrantEligibility, type GrantUser } from '../lib/mcp/oauth/grant-user';
import { makeToolContext } from '../lib/mcp/context';
import { executeListDevelopers, executeListTeams } from '../lib/mcp/tools/handlers';
import { TOOL_DEFINITIONS } from '../lib/mcp/tools/schemas';
import { asTeamAdmin } from '../lib/mcp/oauth/principal';
import type { SessionPayload } from '../lib/session-token';

const USER = '11111111-1111-4111-8111-111111111111';
const TEAM_A = '22222222-2222-4222-8222-222222222222';
const TEAM_B = '33333333-3333-4333-8333-333333333333';
const hash = () => crypto.randomBytes(32);
const code = (fn: () => unknown): string | null => { try { fn(); return null; } catch (e) { return isDataError(e) ? e.code : 'other'; } };

describe('scopeFromPrincipal: which team does this request act on?', () => {
  it('a team admin always acts on their own team', () => {
    const p = { tokenHash: hash(), userId: USER, teamId: TEAM_A };
    assert.equal(scopeDbArgs(scopeFromPrincipal(p)).teamId, TEAM_A);
    assert.equal(scopeDbArgs(scopeFromPrincipal(p, TEAM_A)).teamId, TEAM_A);
    assert.equal(scopeDbArgs(scopeFromPrincipal(p, TEAM_A.toUpperCase())).teamId, TEAM_A, 'case-insensitive');
  });
  it('a team admin naming a different team is refused, not silently answered with their own', () => {
    assert.equal(code(() => scopeFromPrincipal({ tokenHash: hash(), userId: USER, teamId: TEAM_A }, TEAM_B)), 'invalid_argument');
  });
  it('an All-teams admin must name a team, and the scope then carries exactly that team', () => {
    const p = { tokenHash: hash(), userId: USER, teamId: null };
    assert.equal(code(() => scopeFromPrincipal(p)), 'team_required');
    assert.equal(code(() => scopeFromPrincipal(p, null)), 'team_required');
    assert.equal(scopeDbArgs(scopeFromPrincipal(p, TEAM_B)).teamId, TEAM_B);
  });
  it('a malformed team id never becomes a scope', () => {
    assert.equal(code(() => scopeFromPrincipal({ tokenHash: hash(), userId: USER, teamId: null }, 'not-a-uuid')), 'internal');
  });
});

describe('consent eligibility for an All-teams admin', () => {
  const session = (o: Partial<SessionPayload> = {}): SessionPayload => ({ userId: USER, username: 'a', displayName: 'A', role: 'admin', memberId: null, teamId: null, issuedAt: Date.now() - 1000, mfa: true, ...o } as SessionPayload);
  const user = (o: Partial<GrantUser> = {}): GrantUser => ({ id: USER, displayName: 'A', role: 'admin', teamId: null, teamName: null, active: true, allTeams: true, ...o });
  const why = (s: SessionPayload, u: GrantUser | null) => { const r = evaluateGrantEligibility(s, u); return r.ok ? 'ok' : r.reason; };

  it('qualifies only with no team AND the explicit marker', () => {
    assert.equal(why(session(), user()), 'ok');
    assert.equal(why(session(), user({ allTeams: false })), 'no_team'); // a NULL team alone (for example after a team was deleted) is not enough
  });
  it('a team admin still qualifies as before, and a marker never overrides a real team', () => {
    assert.equal(why(session({ teamId: TEAM_A }), user({ teamId: TEAM_A, teamName: 'T', allTeams: false })), 'ok');
    assert.equal(why(session(), user({ teamId: TEAM_A, allTeams: true })), 'stale_session'); // the session no longer matches the account
  });
  it('the session must agree with the database about the scope', () => {
    assert.equal(why(session({ teamId: TEAM_A }), user()), 'stale_session');
  });
  it('everything else still refuses: not admin, inactive, no MFA, built-in account, impersonation', () => {
    assert.equal(why(session({ role: 'user' }), user()), 'not_admin');
    assert.equal(why(session(), user({ active: false })), 'inactive');
    assert.equal(why(session({ mfa: false }), user()), 'no_mfa');
    assert.equal(why(session({ userId: 'admin' }), user()), 'builtin_account');
    assert.equal(why(session({ impersonatedBy: 'sa' }), user()), 'impersonation');
    assert.equal(why(session(), null), 'inactive');
  });
});

describe('the principal that reaches the tools', () => {
  const base = { userId: USER, clientId: 'c', tokenId: 't', scope: 'mcp:read', displayName: 'n', tokenHash: new Uint8Array(32) };
  it('accepts a team admin and an All-teams admin (teamId null); refuses every other role', () => {
    assert.ok(asTeamAdmin({ ...base, role: 'admin', teamId: TEAM_A }));
    assert.equal(asTeamAdmin({ ...base, role: 'admin', teamId: null })?.teamId, null);
    assert.equal(asTeamAdmin({ ...base, role: 'user', teamId: null }), null);
    assert.equal(asTeamAdmin({ ...base, role: 'superadmin', teamId: null }), null);
  });
});

describe('tool arguments', () => {
  const principal = (teamId: string | null) => ({ userId: USER, clientId: 'c', tokenId: 't', scope: 'mcp:read', displayName: 'n', role: 'admin' as const, teamId, tokenHash: new Uint8Array(32).fill(7) });
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = { connect: async () => ({ query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return { rows: [] }; }, release() {} }) } as never;
  const deps = { pool: () => pool, secret: () => 'x'.repeat(40), now: () => new Date('2026-11-26T12:00:00Z') };
  const out = (r: { content: Array<{ text: string }>; isError?: boolean }) => JSON.parse(r.content[0].text) as { code?: string; items?: unknown[] };

  it('an All-teams admin without teamId gets team_required, with a message that tells them what to do', async () => {
    const r = await executeListDevelopers(makeToolContext(principal(null) as never), {}, deps);
    assert.equal(r.isError, true);
    assert.equal(out(r).code, 'team_required');
    assert.match(r.content[0].text, /list_teams/);
  });
  it('an All-teams admin who names a team passes that team to the database as the last parameter', async () => {
    calls.length = 0;
    const r = await executeListDevelopers(makeToolContext(principal(null) as never), { teamId: TEAM_B }, deps);
    assert.equal(r.isError, undefined);
    const q = calls.find((c) => c.sql.includes('mcp_data.list_developers'))!;
    assert.ok(q, 'list_developers was called');
    assert.equal(q.params[q.params.length - 1], TEAM_B);
  });
  it('a team admin naming another team is an invalid_argument and the database is never asked', async () => {
    calls.length = 0;
    const r = await executeListDevelopers(makeToolContext(principal(TEAM_A) as never), { teamId: TEAM_B }, deps);
    assert.equal(out(r).code, 'invalid_argument');
    assert.equal(calls.some((c) => c.sql.includes('mcp_data.')), false);
  });
  it('a team admin naming their own team, or none, is answered with their own team', async () => {
    for (const args of [{}, { teamId: TEAM_A }]) {
      calls.length = 0;
      const r = await executeListDevelopers(makeToolContext(principal(TEAM_A) as never), args, deps);
      assert.equal(r.isError, undefined);
      const q = calls.find((c) => c.sql.includes('mcp_data.list_developers'))!;
      assert.equal(q.params[q.params.length - 1], TEAM_A);
    }
  });
  it('a malformed teamId is rejected before any database work; other unknown keys are still rejected', async () => {
    for (const args of [{ teamId: 'nope' }, { teamId: 5 }, { orgId: TEAM_A }]) {
      calls.length = 0;
      const r = await executeListDevelopers(makeToolContext(principal(TEAM_A) as never), args, deps);
      assert.equal(out(r).code, 'invalid_argument', JSON.stringify(args));
      assert.equal(calls.some((c) => c.sql.includes('mcp_data.')), false);
    }
  });
  it('list_teams takes no arguments and asks the database with the token only', async () => {
    calls.length = 0;
    const ok = await executeListTeams(makeToolContext(principal(null) as never), {}, deps);
    assert.equal(ok.isError, undefined);
    const q = calls.find((c) => c.sql.includes('mcp_data.list_teams'))!;
    assert.equal(q.params.length, 1);
    const bad = await executeListTeams(makeToolContext(principal(null) as never), { teamId: TEAM_A }, deps);
    assert.equal(out(bad).code, 'invalid_argument');
  });
});

describe('tool schemas', () => {
  it('list_teams is registered with no properties; every other tool takes an optional UUID teamId and nothing else changed shape', () => {
    const byName = Object.fromEntries(TOOL_DEFINITIONS.map((t) => [t.name, t.inputSchema as { properties: Record<string, { type?: string; pattern?: string }>; required?: string[]; additionalProperties: boolean }]));
    assert.deepEqual(Object.keys(byName).sort(), ['developer_activity', 'list_developers', 'list_sessions', 'list_teams', 'prompt_metadata_batch', 'search_prompt_metadata', 'session_details']);
    assert.deepEqual(byName.list_teams.properties, {});
    for (const [name, s] of Object.entries(byName)) {
      assert.equal(s.additionalProperties, false, name);
      if (name === 'list_teams') continue;
      assert.equal(s.properties.teamId.type, 'string', name);
      assert.ok(new RegExp(s.properties.teamId.pattern!).test(TEAM_A) && !new RegExp(s.properties.teamId.pattern!).test('x'), name);
      assert.ok(!(s.required ?? []).includes('teamId'), `${name}: teamId is optional`);
    }
  });
});
