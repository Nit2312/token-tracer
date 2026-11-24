/**
 * DB-free guards for Step 8: every place that changes an account's security state must revoke that account's MCP access, so a later
 * re-promotion, team assignment or password change cannot leave an old token alive. A NEW write path that forgets the hook fails here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { securityStateChanged } from '../lib/team/mcp-revoke';

const root = process.cwd();
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
const walk = (d: string): string[] => fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap((e) => {
  const rel = `${d}/${e.name}`;
  return e.isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(e.name) ? [rel] : [];
});
const sources = [...walk('app'), ...walk('lib')].filter((f) => !f.startsWith('lib/mcp/')); // lib/mcp talks to the DB as mcp_auth, never writes users
const imports = (src: string) => /from '(@\/lib\/team\/mcp-revoke|\.\/mcp-revoke)'/.test(src);

describe('every security-state write is covered by a revoke hook', () => {
  it('any UPDATE users that sets password_hash, role, active or team_id lives in a file that imports the revoke helper', () => {
    const offenders: string[] = [];
    let sites = 0;
    for (const f of sources) {
      const src = read(f);
      for (const m of src.matchAll(/UPDATE\s+users\s+SET([\s\S]*?)(?:WHERE|RETURNING|`|'(?=\s*,|\s*\)))/gi)) {
        if (!/\b(password_hash|role|active|team_id)\b/i.test(m[1])) continue;
        sites++;
        if (!imports(src)) offenders.push(f);
      }
    }
    assert.deepEqual(offenders, []);
    assert.ok(sites >= 5, `expected to find the known write sites, found ${sites}`); // guards against the scanner silently matching nothing
  });
  it('DELETE FROM teams, resetMfa() and deleteMember() are only used where the helper is imported', () => {
    const offenders: string[] = [];
    for (const f of sources) {
      const src = read(f);
      const touches = /DELETE\s+FROM\s+teams\b/i.test(src) || /\bresetMfa\(/.test(src.replace(/export async function resetMfa/, '')) || /export async function deleteMember\b/.test(src);
      if (touches && !imports(src)) offenders.push(f);
    }
    assert.deepEqual(offenders, []);
  });
  it('the known routes use the intended hook and reason', () => {
    const expect: Array<[string, RegExp]> = [
      ['app/api/admin/users/reset-password/route.ts', /withMcpRevocation\(\{ userId: id \}, 'password_reset'/],
      ['app/api/v1/team/members/reset-password/route.ts', /revokeMcpAccess\(mcpTarget, 'password_reset'\)[\s\S]*revokeMcpAccess\(\{ userId: updatedUserId \}, 'password_reset'\)/],
      ['app/api/auth/profile/route.ts', /withMcpRevocation\(\{ userId: session\.userId \}, 'password_changed'/],
      ['app/api/admin/users/reset-mfa/route.ts', /withMcpRevocation\(\{ userId: id \}, 'mfa_reset'/],
      ['app/api/admin/users/route.ts', /securityStateChanged\([\s\S]*revokeMcpAccess\(\{ userId: String\(id\) \}, mcpReason\)[\s\S]*UPDATE users SET[\s\S]*revokeMcpAccess\(\{ userId: String\(id\) \}, mcpReason\)/],
      ['app/api/v1/team/members/route.ts', /securityStateChanged\([\s\S]*revokeMcpAccess\(\{ memberId: String\(body\.id\) \}, mcpReason\)[\s\S]*UPDATE users SET[\s\S]*revokeMcpAccess\(\{ memberId: String\(body\.id\) \}, mcpReason\)/],
      ['lib/team/stats.ts', /withMcpRevocation\(\{ memberId \}, 'member_removed'/],
      ['app/api/admin/teams/route.ts', /withMcpRevocation\(\{ teamId: id \}, 'team_deleted'/],
    ];
    for (const [f, re] of expect) assert.match(read(f), re, f);
  });
  it('hard deletes of users need no hook: oauth_tokens/codes cascade from users (and the migration says so)', () => {
    const sql = read('scripts/migrations/mcp-oauth.sql');
    assert.match(sql, /user_id\s+UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  });
});

describe('the revoke helper (lib/team/mcp-revoke.ts)', () => {
  const src = read('lib/team/mcp-revoke.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  it('only ever performs the one-way revoke UPDATE (the trigger on oauth_tokens allows nothing else) and never deletes', () => {
    assert.match(src, /UPDATE oauth_tokens SET revoked_at = now\(\), revoked_reason = \$1 WHERE \$\{USERS_WHERE\[kind\]\} AND revoked_at IS NULL/);
    assert.doesNotMatch(src, /DELETE\s|TRUNCATE|revoked_at\s*=\s*NULL|SET\s+(?!revoked_at)/i);
    assert.equal([...src.matchAll(/UPDATE\s/gi)].length, 1);
  });
  it('validates ids as UUIDs before building any query, tolerates only a missing relation, and never logs data', () => {
    assert.match(src, /UUID_RE\.test\(id\)/); assert.match(src, /42P01/);
    for (const m of src.matchAll(/console\.\w+\(([^)]*)\)/g)) assert.doesNotMatch(m[1].replace(/(['"`])(?:\\.|(?!\1).)*\1/g, ''), /\w/, `console call has non-literal arguments: ${m[0]}`);
  });
  it('runs revoke → change → revoke (the second one closes the refresh-token window)', () => {
    const body = src.slice(src.indexOf('export async function withMcpRevocation'));
    assert.match(body, /await revokeMcpAccess\(target, reason, db\);\s*const out = await change\(\);\s*await revokeMcpAccess\(target, reason, db\);/);
  });
  it('is application-side only: it does not import the MCP database module or use the mcp_auth role', () => {
    assert.doesNotMatch(read('lib/team/mcp-revoke.ts'), /lib\/mcp|@\/lib\/mcp|mcp_auth|MCP_AUTH_DATABASE_URL/);
  });
  it('securityStateChanged: role, active or team differences trigger a revoke; "unchanged" (null/undefined) and identical values do not', () => {
    const cur = { role: 'admin', active: true, team_id: 't1' };
    assert.equal(securityStateChanged(cur, {}), null);
    assert.equal(securityStateChanged(cur, { role: 'admin', active: true, teamId: 't1' }), null);
    assert.equal(securityStateChanged(cur, { role: null, active: null, teamId: null }), null);
    assert.equal(securityStateChanged(cur, { role: 'user' }), 'role_changed');
    assert.equal(securityStateChanged(cur, { active: false }), 'deactivated');
    assert.equal(securityStateChanged({ ...cur, active: false }, { active: true }), 'reactivated');
    assert.equal(securityStateChanged(cur, { teamId: 't2' }), 'team_changed');
  });
});

describe('the nightly purge in the existing cron route', () => {
  const src = read('app/api/internal/rollup/route.ts');
  it('is isolated (never fails the rollup), skips silently when the migration is absent, and reports counts only', () => {
    assert.match(src, /SELECT mcp_oauth_purge\(\) AS r/);
    assert.match(src, /code !== '42883' && code !== '42P01'/);
    assert.doesNotMatch(src.slice(src.indexOf('E. MCP OAuth retention'), src.indexOf('const elapsed')), /errors\.push/);
    assert.match(src, /mcpPurge,/);
  });
});
