/**
 * Documentation drift guard: MCP.md is the single reference for the MCP program. Everything about it that can be checked mechanically against the
 * code is checked here (files exist, environment variables, permission matrix, constants, rate limits, audit events, script flags), so the document
 * cannot quietly go stale. DB-free.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
const doc = read('MCP.md');
const walk = (d: string): string[] => fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
const section = (title: RegExp): string => { const m = doc.match(new RegExp(`^## ${title.source}[^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm')); assert.ok(m, `section ${title} missing`); return m[1]; };

describe('MCP.md structure', () => {
  it('has the consolidated sections, with completed work, blockers and risks kept apart', () => {
    for (const h of ['Status at a glance', 'Architecture', 'OAuth 2.1 flow', '`/mcp` request handling', 'Database, roles and permissions', 'Account lifecycle', 'Configuration', 'Operations runbook', 'Testing', 'Implementation history', 'Key decisions', 'Risk register', 'Production-readiness checklist', 'Cleanup after sign-off', 'Later phases']) {
      assert.ok(doc.includes(`## `) && new RegExp(`^## \\d+\\. ${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm').test(doc), `heading "${h}"`);
    }
    const status = section(/1\. Status at a glance/);
    assert.match(status, /### Completed/); assert.match(status, /### Not built yet/); assert.match(status, /### Production-readiness blockers/);
  });
  it('records every unresolved risk the owner listed, and the production state', () => {
    for (const id of ['R2', 'R7', 'R9', 'R10']) assert.match(section(/12\. Risk register/), new RegExp(`\\*\\*${id}\\*\\*`), id);
    assert.match(doc, /connection sizing/i); assert.match(doc, /Legal\/HR|legal\/HR/);
    assert.match(section(/1\. Status at a glance/), /nothing MCP-related has been applied to production/i);
  });
  it('documents rollback and says the runbook has not been executed', () => {
    assert.match(section(/8\. Operations runbook/), /Nothing in this section has been run against production/);
    assert.match(section(/8\. Operations runbook/), /Rollback procedures/);
  });
});

describe('MCP.md matches the code', () => {
  it('every repository path it names in backticks exists', () => {
    const paths = [...new Set([...doc.matchAll(/`((?:lib|app|scripts|tests)\/[A-Za-z0-9_./\[\]-]+)`/g)].map((m) => m[1]))];
    assert.ok(paths.length > 25, `expected many paths, found ${paths.length}`);
    const missing = paths.filter((p) => !fs.existsSync(path.join(root, p)));
    assert.deepEqual(missing, []);
  });
  it('every MCP route in the app is documented, and no documented OAuth route is missing', () => {
    const routes = walk('app').filter((f) => /^app\/(oauth|\.well-known|mcp)\/.*route\.ts$|^app\/oauth\/authorize\/page\.tsx$/.test(f)).map((f) => '/' + f.replace(/^app\//, '').replace(/\/(route\.ts|page\.tsx)$/, ''));
    assert.ok(routes.length >= 9);
    for (const r of routes) assert.ok(doc.includes(r), `route ${r} is not documented`);
  });
  it('the configuration table covers every MCP_* variable the code reads (and the existing ones it depends on)', () => {
    const code = [...walk('lib/mcp'), ...walk('app/oauth'), ...walk('app/mcp'), 'lib/team/mcp-revoke.ts'].filter((f) => /\.(ts|tsx)$/.test(f)).map(read).join('\n');
    const read_ = new Set([...code.matchAll(/(?:process\.env|env)\.(MCP_[A-Z_]+|NEXT_PUBLIC_SERVER_URL|SESSION_SECRET)\b/g)].map((m) => m[1]));
    assert.ok(read_.size >= 6, [...read_].join(','));
    const cfg = section(/7\. Configuration/);
    for (const v of read_) assert.ok(cfg.includes(`\`${v}\``), `${v} is read by the code but missing from the configuration table`);
    for (const v of [...cfg.matchAll(/^\| `(MCP_[A-Z_]+)` \|/gm)].map((m) => m[1])) assert.ok(read_.has(v), `${v} is documented but no code reads it`);
  });
  it('the permission matrix equals lib/mcp/grants.json, column by column', () => {
    const g = JSON.parse(read('lib/mcp/grants.json')).mcp_auth as Record<string, Record<string, string[]> | string[]>;
    const whole = section(/5\. Database, roles and permissions/);
    const matrix = whole.slice(whole.indexOf('### Role `mcp_auth`')); // the privileges table, not the earlier "Tables" table that reuses the same row labels
    assert.ok(matrix.length > 100 && matrix.startsWith('### Role `mcp_auth`'));
    const sql = read('scripts/migrations/mcp-oauth.sql');
    const tableColumns = (t: string): string[] => {
      const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${t} (`); assert.ok(start >= 0, `table ${t} not found in the migration`);
      const block = sql.slice(start, sql.indexOf('\n);', start));
      return [...block.matchAll(/^  ([a-z_]+)\s+[A-Z]/gm)].map((m) => m[1]);
    };
    const rowOf = (t: string) => { const m = matrix.match(new RegExp(`^\\| \`${t}\` \\|([^\\n]*)$`, 'm')); assert.ok(m, `matrix row for ${t}`); return m[1].split('|').map((c) => c.trim()); };
    const tables = new Set([...Object.keys(g.select as object), ...Object.keys(g.insert as object), ...Object.keys(g.update as object)]);
    for (const t of tables) {
      const [sel, ins, upd] = rowOf(t);
      for (const [kind, cell] of [['select', sel], ['insert', ins], ['update', upd]] as const) {
        const cols = (g[kind] as Record<string, string[]>)[t];
        if (!cols) { assert.match(cell, /^—$/, `${t}.${kind} should be "—"`); continue; }
        const documented = /^all$/i.test(cell) ? null : cell.replace(/`/g, '').split(',').map((c) => c.trim()).sort();
        if (documented) assert.deepEqual(documented, [...cols].sort(), `${t}.${kind}`);
        else { // "all" must be literally true: the grant covers exactly the columns the migration creates for that table
          assert.equal(kind, 'select', `${t}: "all" is only used for select`);
          assert.deepEqual([...cols].sort(), tableColumns(t).sort(), `${t}: "all" does not match the table's columns`);
        }
      }
    }
    assert.ok(matrix.includes((g.sequences as string[])[0])); assert.ok(matrix.includes((g.functions as string[])[0]));
    for (const forbidden of ['password_hash', 'api_key', 'session_turns', 'sync_sessions', 'audit_log']) assert.ok(matrix.includes(forbidden), `${forbidden} should be listed as inaccessible`);
  });
  it('lifetimes and limits in the document equal the code constants', () => {
    const tokens = read('lib/mcp/oauth/tokens.ts');
    const n = (name: string) => Number(tokens.match(new RegExp(`${name} = ([0-9 *]+);`))![1].split('*').reduce((a, b) => a * Number(b.trim()), 1));
    assert.equal(n('ACCESS_TOKEN_TTL_SECONDS'), 30 * 60); assert.equal(n('REFRESH_IDLE_TTL_SECONDS'), 14 * 24 * 3600); assert.equal(n('REFRESH_ABSOLUTE_TTL_SECONDS'), 60 * 24 * 3600); assert.equal(n('AUTH_CODE_TTL_SECONDS'), 60);
    assert.match(read('lib/mcp/oauth/consent.ts'), /CONSENT_TTL_MS = 5 \* 60 \* 1000/); assert.match(read('lib/mcp/oauth/grant-user.ts'), /GRANT_MAX_LOGIN_AGE_MS = 15 \* 60 \* 1000/);
    for (const s of ['30 min', '14 days idle / 60 days absolute', '60 s', '5 minutes', '15 minutes']) assert.ok(doc.includes(s), `"${s}" missing from the document`);
    // Each rate limit must appear in the row of the route that ENFORCES it (a limit that merely exists elsewhere in the document is not enough).
    const routeOfKey: Record<string, string> = { register: '/oauth/register', token: '/oauth/token', revoke: '/oauth/revoke', consent: '/oauth/decision' };
    const oauth = section(/3\. OAuth 2\.1 flow/);
    const found = [...(read('lib/mcp/oauth/endpoints.ts') + read('lib/mcp/oauth/authorize.ts')).matchAll(/limited\(pool, [`']([a-z]+)[:`'].*?, (\d+), (\d+)\)/g)];
    assert.ok(found.length >= 6, `expected 6 limited() calls, found ${found.length}`);
    for (const [, prefix, limit, window] of found) {
      const route = routeOfKey[prefix]; assert.ok(route, `no route mapped for rate-limit key "${prefix}"`);
      const row = oauth.match(new RegExp(`^\\| \`${route}\` \\|[^\\n]*$`, 'm'))?.[0]; assert.ok(row, `endpoint row for ${route}`);
      const text = window === '3600' ? `${limit}/h` : window === '60' ? `${limit}/min` : window === '600' ? `${limit} per 10 min` : null;
      assert.ok(text, `unexpected window ${window}`); assert.ok(row!.includes(text!), `the row for ${route} must state "${text}" (the code enforces it)`);
    }
    assert.match(doc, /CONNECTION LIMIT 5/); assert.match(read('scripts/setup-mcp-roles.mjs'), /CONN_LIMIT = 5/); assert.match(read('lib/mcp/db.ts'), /max: 3/); assert.match(doc, /pool `max: 3`/);
  });
  it('the audit-event allowlist in the document equals the one in the migration', () => {
    const sql = read('scripts/migrations/mcp-oauth.sql');
    const block = sql.slice(sql.indexOf('FUNCTION mcp_audit_event'), sql.indexOf('INSERT INTO public.audit_log'));
    const events = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).filter((e) => !['oauth_client', 'oauth_token', 'oauth_code', 'user'].includes(e) && !/^(object|mcp|public|pg_catalog|\.\w*)$/.test(e));
    const allowlist = events.filter((e) => ['client_registered', 'authorization_granted', 'authorization_denied', 'code_replayed', 'token_issued', 'token_refreshed', 'refresh_reuse_detected', 'token_revoked', 'tokens_revoked_for_user', 'access_denied'].includes(e));
    assert.equal(new Set(allowlist).size, 10);
    for (const e of new Set(allowlist)) assert.ok(doc.includes(`\`${e}\``), `event ${e} missing from the document`);
    assert.match(doc, /allowlist of 10 events/);
  });
  it('the commands in the runbook use flags and variables the scripts really define', () => {
    const migrate = read('scripts/migrate-mcp-oauth.mjs'); const roles = read('scripts/setup-mcp-roles.mjs');
    for (const flag of ['--apply', '--rollback']) { assert.ok(migrate.includes(flag), flag); assert.ok(doc.includes(`migrate-mcp-oauth.mjs --${flag.slice(2)}`) || doc.includes(flag), `${flag} not documented`); }
    for (const flag of ['--apply', '--verify', '--drop']) { assert.ok(roles.includes(flag), flag); assert.ok(doc.includes(`setup-mcp-roles.mjs ${flag}`) || doc.includes(`setup-mcp-roles.mjs\n`) || doc.includes(flag), `${flag} not documented`); }
    for (const v of ['EXPECTED_ENDPOINT', 'CONFIRM_MCP_MIGRATION', 'CONFIRM_MCP_ROLLBACK_DATA_LOSS']) { assert.ok(migrate.includes(v), `${v} not in the migration script`); assert.ok(doc.includes(v), `${v} not documented`); }
    for (const v of ['MCP_AUTH_PASSWORD', 'CONFIRM_MCP_ROLES']) { assert.ok(roles.includes(v), `${v} not in the role script`); assert.ok(doc.includes(v), `${v} not documented`); }
    const pkg = JSON.parse(read('package.json')); for (const s of ['test:unit', 'test:db', 'test:e2e:mcp']) { assert.ok(pkg.scripts[s], s); assert.ok(doc.includes(s), `npm script ${s} not documented`); }
  });
  it('the document never contains a credential-shaped string', () => {
    assert.doesNotMatch(doc, /postgres(ql)?:\/\/[^\s<>]*:[^\s<>@]{6,}@/);
    assert.doesNotMatch(doc, /tt_(at|rt|ac)_[A-Za-z0-9_-]{20,}/);
    assert.doesNotMatch(doc, /ep-[a-z]+-[a-z]+-[a-z0-9]{6,}/); // no concrete Neon endpoint ids: placeholders only
  });
});
