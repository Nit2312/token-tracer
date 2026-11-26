#!/usr/bin/env node
/**
 * End-to-end test of the MCP OAuth + /mcp stack against a REAL `next build` / `next start`, with a dedicated TEST BRANCH as the database.
 *
 *   TEST_DATABASE_URL=… TEST_DATABASE_EXPECTED_ENDPOINT=ep-… TEST_MCP_AUTH_DATABASE_URL=… [TEST_ANALYST_DATABASE_URL=…] \
 *     node scripts/e2e-mcp.mjs [--skip-build] [--port 3999]
 *
 * Safety (same rules as tests/helpers/test-db.ts):
 *  - Reads ONLY those environment variables; never an env file. The Next process it starts gets DATABASE_URL / NEON_CONNECTION_STRING set
 *    to the TEST branch and ANALYST_DATABASE_URL to the test analyst login (or an unreachable placeholder); production values are never passed.
 *  - Refuses unless TEST_DATABASE_URL's endpoint equals TEST_DATABASE_EXPECTED_ENDPOINT and differs from any DATABASE_URL /
 *    NEON_CONNECTION_STRING / ANALYST_DATABASE_URL present in the environment.
 *  - The server gets test-only session / cron secrets and test-only built-in account passwords + TOTP secrets.
 *  - Every row it creates is removed at the end (and the purge function is restored if a scenario replaced it).
 * The script prints PASS / FAIL lines and exits non-zero on any failure. It never prints tokens, passwords or connection strings.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import cp from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import bcrypt from 'bcryptjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const SKIP_BUILD = args.includes('--skip-build');
const PORT = Number(args[args.indexOf('--port') + 1]) || 3999;
const HOST = 'token-tracer-three.vercel.app', ALIAS = 'token-tracer-puce.vercel.app', BASE = `https://${HOST}`, CB = 'https://claude.ai/api/mcp/auth_callback';
const SESSION_SECRET = 'e2e-mcp-session-secret-' + crypto.randomBytes(8).toString('hex');
const CRON_SECRET = 'e2e-cron-' + crypto.randomBytes(8).toString('hex');
const BUILTIN = { team: { pw: 'E2e-team-' + crypto.randomBytes(6).toString('hex'), totp: totpSecret() }, superadmin: { pw: 'E2e-super-' + crypto.randomBytes(6).toString('hex'), totp: totpSecret() } };

// ── preflight ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const need = (k) => { const v = process.env[k]?.trim(); if (!v) { console.error(`${k} is not set`); process.exit(2); } return v; };
const endpointOf = (u) => { try { return new URL(u).hostname.split('.')[0].replace(/-pooler$/, ''); } catch { return null; } };
const TEST_URL = need('TEST_DATABASE_URL'), EXPECTED = need('TEST_DATABASE_EXPECTED_ENDPOINT'), MCP_URL = need('TEST_MCP_AUTH_DATABASE_URL');
const ANALYST_URL = process.env.TEST_ANALYST_DATABASE_URL?.trim();
if (endpointOf(TEST_URL) !== EXPECTED) { console.error('TEST_DATABASE_URL does not point at TEST_DATABASE_EXPECTED_ENDPOINT; refusing.'); process.exit(2); }
for (const u of [MCP_URL, ANALYST_URL].filter(Boolean)) if (endpointOf(u) !== EXPECTED) { console.error('a TEST_* URL points at a different endpoint; refusing.'); process.exit(2); }
for (const k of ['DATABASE_URL', 'NEON_CONNECTION_STRING', 'ANALYST_DATABASE_URL']) if (process.env[k] && endpointOf(process.env[k]) === EXPECTED) { console.error(`${k} in the environment is the test endpoint; that is not a safe setup. Refusing.`); process.exit(2); }
const BLOCKED = 'postgresql://blocked:blocked@invalid.invalid:5432/blocked';

function totpSecret() { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; return Array.from(crypto.randomBytes(20), (b) => A[b % 32]).join(''); }
const b32 = (s) => { let bits = 0, v = 0; const o = []; for (const c of s) { v = (v << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c); bits += 5; if (bits >= 8) { o.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(o); };
const hotp = (sec, step) => { const m = Buffer.alloc(8); m.writeBigUInt64BE(BigInt(step)); const h = crypto.createHmac('sha1', b32(sec)).update(m).digest(); const o = h[h.length - 1] & 15; return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0'); };
const step = () => Math.floor(Date.now() / 30000);

// ── tiny harness ────────────────────────────────────────────────────────────────────────────────────────────────────────────
let fails = 0, total = 0;
const ok = (c, label, detail = '') => { total++; if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`); };
const j = JSON.stringify;
const rpcBody = (t) => { const d = t.split('\n').find((l) => l.startsWith('data:')); return JSON.parse(d ? d.slice(5).trim() : t); };
function req(method, p, { headers = {}, body, host = HOST } = {}) {
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: { host, 'x-forwarded-proto': 'https', ...headers } }, (x) => {
      let t = ''; x.on('data', (d) => (t += d)); x.on('end', () => res({ status: x.statusCode, headers: x.headers, text: t, cookies: (x.headers['set-cookie'] || []).map((c) => c.split(';')[0]) }));
    });
    r.on('error', rej); if (body) r.write(body); r.end();
  });
}
const SAME = { origin: BASE, 'content-type': 'application/json' };
const FORMH = { 'content-type': 'application/x-www-form-urlencoded' };
const sign = (p) => { const b = Buffer.from(j(p)).toString('base64url'); return 'app_session=' + b + '.' + crypto.createHmac('sha256', SESSION_SECRET).update(b).digest('base64url'); };
const superCookie = () => sign({ userId: 'superadmin', username: 'superadmin', displayName: 'Super', role: 'superadmin', memberId: null, teamId: null, issuedAt: Date.now(), lastActive: Date.now(), mfa: true });
const ipHash = (ip) => crypto.createHmac('sha256', SESSION_SECRET).update(`mcp-ip:${ip}`).digest('hex').slice(0, 32);

// ── server lifecycle ────────────────────────────────────────────────────────────────────────────────────────────────────────
const serverEnv = () => ({
  PATH: process.env.PATH, HOME: process.env.HOME, NEXT_TELEMETRY_DISABLED: '1', PORT: String(PORT),
  DATABASE_URL: TEST_URL, NEON_CONNECTION_STRING: TEST_URL, ANALYST_DATABASE_URL: ANALYST_URL || BLOCKED,
  SESSION_SECRET, CRON_SECRET, ADMIN_PASSWORD: BUILTIN.team.pw, SUPERADMIN_PASSWORD: BUILTIN.superadmin.pw, ADMIN_TOTP_SECRET: BUILTIN.team.totp, SUPERADMIN_TOTP_SECRET: BUILTIN.superadmin.totp,
  MCP_ENABLED: 'true', MCP_PUBLIC_BASE_URL: BASE, MCP_AUTH_DATABASE_URL: MCP_URL, NEXT_PUBLIC_SERVER_URL: BASE,
});
let server; let serverLog = '';
async function build() {
  const buildEnv = { ...serverEnv(), DATABASE_URL: BLOCKED, NEON_CONNECTION_STRING: BLOCKED, ANALYST_DATABASE_URL: BLOCKED }; // the build never needs a database
  const r = cp.spawnSync('npx', ['next', 'build'], { cwd: ROOT, env: buildEnv, encoding: 'utf8' });
  ok(r.status === 0, 'next build succeeds', r.status === 0 ? '' : (r.stdout + r.stderr).slice(-400));
  if (r.status !== 0) process.exit(1);
}
async function start() {
  server = cp.spawn('npx', ['next', 'start'], { cwd: ROOT, env: serverEnv() });
  server.stdout.on('data', (d) => (serverLog += d)); server.stderr.on('data', (d) => (serverLog += d));
  for (let i = 0; i < 60; i++) { try { if ((await req('GET', '/.well-known/oauth-authorization-server')).status === 200) return; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 1000)); }
  throw new Error('server did not become ready');
}
const stop = () => { if (server) { server.kill('SIGTERM'); try { cp.spawnSync('pkill', ['-f', 'next-server']); } catch { /* best effort */ } } };

// ── scenarios ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const dbUrl = new URL(TEST_URL); dbUrl.searchParams.delete('sslmode');
  const db = new pg.Client({ connectionString: dbUrl.toString(), ssl: { rejectUnauthorized: true } }); await db.connect();
  const q = (s, p) => db.query(s, p);
  const RUN = crypto.randomBytes(4).toString('hex'), PW = 'E2e-' + crypto.randomBytes(9).toString('hex');
  const ids = { teams: [], users: [], members: [], clients: [] };
  let purgeRenamed = false, tokensRenamed = false;
  try {
    const team = (await q('insert into teams(name) values($1) returning id', ['E2EMCP Team A ' + RUN])).rows[0].id;
    const team2 = (await q('insert into teams(name) values($1) returning id', ['E2EMCP Team B ' + RUN])).rows[0].id; ids.teams.push(team, team2);
    const member = (await q("insert into members(team_id, display_name, role) values($1,$2,'member') returning id", [team, 'E2EMCP Member ' + RUN])).rows[0].id; ids.members.push(member);
    await q("insert into team_members(team_id, member_id, role) values($1,$2,'member') on conflict do nothing", [team, member]);
    const hash = await bcrypt.hash(PW, 4);
    const admin = (await q("insert into users(username,password_hash,display_name,role,team_id,member_id) values($1,$2,'E2EMCP Admin','admin',$3,$4) returning id", ['e2emcp-' + RUN, hash, team, member])).rows[0].id; ids.users.push(admin);
    const plain = (await q("insert into users(username,password_hash,display_name,role,team_id) values($1,$2,'E2EMCP Plain','user',$3) returning id", ['e2emcp-plain-' + RUN, hash, team])).rows[0].id; ids.users.push(plain);
    const member2 = (await q("insert into members(team_id, display_name, role) values($1,$2,'member') returning id", [team, 'E2EMCP Member2 ' + RUN])).rows[0].id; ids.members.push(member2);
    await q("insert into team_members(team_id, member_id, role) values($1,$2,'member') on conflict do nothing", [team, member2]);
    const plain2 = (await q("insert into users(username,password_hash,display_name,role,team_id,member_id) values($1,$2,'E2EMCP Plain2','user',$3,$4) returning id", ['e2emcp-plain2-' + RUN, hash, team, member2])).rows[0].id; ids.users.push(plain2);

    // ═══ S1 — full OAuth lifecycle through the real login, MFA and consent ═══
    console.log('\n## S1 OAuth lifecycle (DCR → login → MFA → consent → token → /mcp → refresh → revoke)');
    const reg = await req('POST', '/oauth/register', { headers: { 'content-type': 'application/json', 'x-real-ip': '198.51.100.' + (1 + Math.floor(Math.random() * 200)) }, body: j({ client_name: '<b>E2E</b> Claude', redirect_uris: [CB] }) });
    ok(reg.status === 201, 'DCR register', String(reg.status)); const clientId = JSON.parse(reg.text).client_id; ids.clients.push(clientId);
    const verifier = crypto.randomBytes(32).toString('base64url'), challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const AUTH = '/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: CB, code_challenge: challenge, code_challenge_method: 'S256', state: 'e2e-state', scope: 'mcp:read offline_access', resource: BASE + '/mcp' });
    const a0 = await req('GET', AUTH); ok([307, 308].includes(a0.status) && String(a0.headers.location).startsWith('/?returnTo='), 'unauthenticated authorize → login with returnTo');
    const returnTo = decodeURIComponent(String(a0.headers.location).slice('/?returnTo='.length));
    const l1 = await req('POST', '/api/auth/login', { headers: SAME, body: j({ username: 'e2emcp-' + RUN, password: PW, returnTo }) });
    const l1b = JSON.parse(l1.text); ok(l1.status === 200 && l1b.mfaRequired && l1b.enroll?.secret, 'login → MFA enrolment', String(l1.status));
    const totp = l1b.enroll.secret, pending = l1.cookies.find((c) => c.startsWith('mfa_pending='));
    const m1 = await req('POST', '/api/auth/mfa/verify', { headers: { ...SAME, cookie: pending }, body: j({ code: hotp(totp, step() - 1) }) });
    ok(m1.status === 200 && JSON.parse(m1.text).redirect === AUTH, 'MFA verify returns to the authorize request'); const session = m1.cookies.find((c) => c.startsWith('app_session='));
    const a1 = await req('GET', AUTH, { headers: { cookie: session } });
    ok(a1.status === 200 && a1.text.includes('Authorize access') && !a1.text.includes('<b>E2E</b>'), 'consent page renders; hostile client name is escaped');
    const consent = (a1.text.match(/consentToken\\?":\\?"([A-Za-z0-9_\-.]+)/) || [])[1]; ok(!!consent, 'consent token present');
    const d1 = await req('POST', '/oauth/decision', { headers: { ...SAME, cookie: session }, body: j({ consent, decision: 'approve' }) });
    const red = new URL(JSON.parse(d1.text).redirect || 'x:'); ok(d1.status === 200 && red.searchParams.get('state') === 'e2e-state' && red.searchParams.get('iss') === BASE, 'approve → callback with code, state, iss');
    const tokenReq = (b) => req('POST', '/oauth/token', { headers: { ...FORMH, 'x-real-ip': '198.51.100.9' }, body: new URLSearchParams(b).toString() });
    const tk = await tokenReq({ grant_type: 'authorization_code', code: red.searchParams.get('code'), client_id: clientId, redirect_uri: CB, code_verifier: verifier, resource: BASE + '/mcp' });
    const t0 = JSON.parse(tk.text); ok(tk.status === 200 && t0.scope === 'mcp:read' && t0.token_type === 'Bearer', 'token exchange (offline_access stripped, scope mcp:read)');
    const ping = (tok, extra = {}) => req('POST', '/mcp', { headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(tok ? { authorization: 'Bearer ' + tok } : {}), ...extra }, body: j({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
    ok((await ping(t0.access_token)).status === 200, '/mcp accepts the access token');
    const init = await req('POST', '/mcp', { headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + t0.access_token }, body: j({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } }) });
    ok(init.status === 200 && Object.keys(rpcBody(init.text).result.capabilities).length === 0, 'initialize works and exposes NO tools, resources or prompts');
    const r1 = await tokenReq({ grant_type: 'refresh_token', refresh_token: t0.refresh_token, client_id: clientId }); const t1 = JSON.parse(r1.text);
    ok(r1.status === 200 && t1.refresh_token !== t0.refresh_token, 'refresh rotates the refresh token');
    const reuse = await tokenReq({ grant_type: 'refresh_token', refresh_token: t0.refresh_token, client_id: clientId });
    ok(reuse.status === 400 && JSON.parse(reuse.text).error === 'invalid_grant', 'reusing the old refresh token is invalid_grant');
    ok((await ping(t1.access_token)).status === 401 && (await ping(t0.access_token)).status === 401, 'reuse killed the whole family (/mcp rejects both access tokens)');
    // fresh pair for the revoke endpoint
    const code2 = await (async () => { const d = await req('POST', '/oauth/decision', { headers: { ...SAME, cookie: session }, body: j({ consent, decision: 'approve' }) }); return new URL(JSON.parse(d.text).redirect).searchParams.get('code'); })();
    const t2 = JSON.parse((await tokenReq({ grant_type: 'authorization_code', code: code2, client_id: clientId, redirect_uri: CB, code_verifier: verifier })).text);
    const rv = await req('POST', '/oauth/revoke', { headers: { ...FORMH, 'x-real-ip': '198.51.100.9' }, body: new URLSearchParams({ token: t2.refresh_token, client_id: clientId }).toString() });
    ok(rv.status === 200 && (await ping(t2.access_token)).status === 401, '/oauth/revoke with the refresh token kills the access token too');
    const replay = await tokenReq({ grant_type: 'authorization_code', code: code2, client_id: clientId, redirect_uri: CB, code_verifier: verifier });
    ok(replay.status === 400 && JSON.parse(replay.text).error === 'invalid_grant', 'code replay is invalid_grant');

    // ═══ S2 — loopback client (Claude Code style) and request edge cases ═══
    console.log('\n## S2 loopback client and edge cases');
    const lreg = await req('POST', '/oauth/register', { headers: { 'content-type': 'application/json', 'x-real-ip': '198.51.100.' + (1 + Math.floor(Math.random() * 200)) }, body: j({ client_name: 'Claude Code', redirect_uris: ['http://localhost:40000/callback'] }) });
    const lc = JSON.parse(lreg.text).client_id; ids.clients.push(lc);
    const lAuth = (port, extra = {}) => '/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: lc, redirect_uri: `http://localhost:${port}/callback`, code_challenge: challenge, code_challenge_method: 'S256', state: 's', ...extra });
    const lp = await req('GET', lAuth(51111), { headers: { cookie: session } });
    ok(lp.status === 200 && lp.text.includes('your own computer'), 'loopback authorize on any port shows the loopback warning', String(lp.status));
    const bad = [['unregistered host', { redirect_uri: 'http://evil.example:40000/callback' }], ['wrong path', { redirect_uri: 'http://localhost:51111/other' }], ['https loopback', { redirect_uri: 'https://localhost:51111/callback' }]];
    for (const [n, o] of bad) { const r = await req('GET', lAuth(51111, o), { headers: { cookie: session } }); ok(!r.headers.location && r.text.includes('Cannot authorize'), `${n} → error page, no redirect`); }
    const bad2 = await req('GET', AUTH.replace('code_challenge_method=S256', 'code_challenge_method=plain'), { headers: { cookie: session } });
    ok(String(bad2.headers.location || '').startsWith(CB + '?error=invalid_request') && String(bad2.headers.location).includes('state=e2e-state'), 'bad PKCE method → error to the verified callback with state');
    const dup = await req('GET', AUTH + '&client_id=other', { headers: { cookie: session } }); ok(!dup.headers.location && dup.text.includes('Cannot authorize'), 'repeated parameter → error page');
    for (const [n, body] of [['missing grant', {}], ['unknown grant', { grant_type: 'password', client_id: clientId }], ['client_secret sent', { grant_type: 'refresh_token', client_id: clientId, client_secret: 's' }]]) {
      const r = await req('POST', '/oauth/token', { headers: { ...FORMH, 'x-real-ip': '198.51.100.9' }, body: new URLSearchParams(body).toString() }); ok(r.status >= 400 && r.status < 500 && !!JSON.parse(r.text).error, `token endpoint: ${n} → 4xx OAuth error`, String(r.status));
    }
    ok((await req('GET', '/oauth/token')).status === 405, 'GET /oauth/token → 405');
    const big = await req('POST', '/oauth/token', { headers: { ...FORMH, 'x-real-ip': '198.51.100.9' }, body: 'x=' + 'a'.repeat(6000) }); ok(big.status === 413, 'oversized token request → 413', String(big.status));
    // stale login → reauthenticate
    const stale = sign({ userId: admin, username: 'e2emcp-' + RUN, displayName: 'E2EMCP Admin', role: 'admin', memberId: member, teamId: team, issuedAt: Date.now() - 20 * 60000, lastActive: Date.now(), mfa: true });
    const s1 = await req('GET', AUTH, { headers: { cookie: stale } }); ok([307, 308].includes(s1.status) && String(s1.headers.location).startsWith('/oauth/reauthenticate?returnTo='), '20-minute-old login → re-authenticate');
    const s2 = await req('GET', s1.headers.location, { headers: { cookie: stale } }); ok(s2.status === 303 && /app_session=;/.test((s2.headers['set-cookie'] || []).join(';')), 'reauthenticate clears the stale cookie');
    const pl = await req('POST', '/api/auth/login', { headers: SAME, body: j({ username: 'e2emcp-plain-' + RUN, password: PW, returnTo }) });
    const ap = await req('GET', AUTH, { headers: { cookie: pl.cookies.find((c) => c.startsWith('app_session=')) } }); ok(ap.text.includes('Not allowed') && !/consentToken/.test(ap.text), 'a plain user is refused, never shown consent');

    // ═══ S3 — Host, Origin, CSRF, CORS and security headers on the real routes ═══
    console.log('\n## S3 Host / Origin / CSRF / CORS / headers');
    const routes = [['GET', '/.well-known/oauth-authorization-server'], ['GET', '/.well-known/oauth-protected-resource'], ['GET', '/.well-known/oauth-protected-resource/mcp'], ['POST', '/mcp'], ['POST', '/oauth/register'], ['POST', '/oauth/token'], ['POST', '/oauth/revoke'], ['POST', '/oauth/decision'], ['GET', '/oauth/reauthenticate?returnTo=%2Foauth%2Fauthorize'], ['GET', AUTH]];
    for (const [m, p] of routes) {
      const r = await req(m, p, { host: ALIAS, headers: { authorization: 'Bearer ' + t1.access_token, cookie: session }, body: m === 'POST' ? '{}' : undefined });
      const x = await req(m, p, { headers: { 'x-forwarded-host': 'evil.example', cookie: session }, body: m === 'POST' ? '{}' : undefined });
      ok(r.status === 404 && x.status === 404, `${m} ${p.split('?')[0]}: other alias and spoofed X-Forwarded-Host → 404`, `${r.status}/${x.status}`);
    }
    const t3 = JSON.parse((await tokenReq({ grant_type: 'authorization_code', code: (new URL(JSON.parse((await req('POST', '/oauth/decision', { headers: { ...SAME, cookie: session }, body: j({ consent, decision: 'approve' }) })).text).redirect)).searchParams.get('code'), client_id: clientId, redirect_uri: CB, code_verifier: verifier })).text);
    for (const [n, h, want] of [['foreign Origin', { origin: 'https://evil.example' }, 403], ['null Origin', { origin: 'null' }, 403], ['look-alike Origin', { origin: 'https://claude.ai.evil.example' }, 403], ['claude.ai Origin', { origin: 'https://claude.ai' }, 200]]) {
      const r = await ping(t3.access_token, h); ok(r.status === want, `/mcp ${n} → ${want}`, String(r.status));
    }
    for (const [n, h, want] of [['foreign Origin', { origin: 'https://evil.example' }, 403], ['missing Origin', {}, 403], ['look-alike Origin', { origin: BASE + '.evil.example' }, 403], ['cross-site fetch', { origin: BASE, 'sec-fetch-site': 'cross-site' }, 403]]) {
      const r = await req('POST', '/oauth/decision', { headers: { 'content-type': 'application/json', cookie: session, ...h }, body: j({ consent, decision: 'approve' }) }); ok(r.status === want, `/oauth/decision ${n} → ${want}`, String(r.status));
    }
    ok((await req('POST', '/oauth/decision', { headers: { ...SAME, cookie: 'app_session=forged' }, body: j({ consent, decision: 'approve' }) })).status === 401, '/oauth/decision with a forged session → 401');
    for (const [n, p, h, body] of [['token', '/oauth/token', FORMH, 'a=b'], ['revoke', '/oauth/revoke', FORMH, 'a=b'], ['register', '/oauth/register', { 'content-type': 'application/json' }, '{}']]) {
      const r = await req('POST', p, { headers: { ...h, 'sec-fetch-site': 'cross-site' }, body }); ok(r.status === 403, `/oauth/${n}: cross-site browser request → 403`);
      const c = await req('POST', p, { headers: { ...h, 'x-real-ip': '198.51.100.9' }, body }); ok(![...Object.keys(c.headers)].some((k) => k.startsWith('access-control-')), `/oauth/${n}: no CORS headers`);
    }
    ok((await req('GET', '/.well-known/oauth-authorization-server')).headers['access-control-allow-origin'] === '*', 'public metadata allows any origin (read-only document)');
    for (const [n, r] of [['/mcp 401', await ping(null)], ['/oauth/token 400', await req('POST', '/oauth/token', { headers: { ...FORMH, 'x-real-ip': '198.51.100.9' }, body: 'a=b' })], ['metadata 200', await req('GET', '/.well-known/oauth-protected-resource/mcp')], ['consent page', a1]]) {
      const h = r.headers; ok(/max-age=\d{7,}/.test(h['strict-transport-security'] || '') && h['x-content-type-options'] === 'nosniff', `${n}: HSTS and nosniff present`);
    }
    ok(/frame-ancestors 'none'/.test(a1.headers['content-security-policy'] || '') && a1.headers['x-frame-options'] === 'DENY' && /no-store/.test(a1.headers['cache-control'] || ''), 'consent page: not frameable, not cacheable');

    // ═══ S4 — revocation after every account change (real routes) ═══
    console.log('\n## S4 revocation hooks');
    const mintPair = async (uid = admin) => {
      const at = 'tt_at_' + crypto.randomBytes(32).toString('base64url'), rt = 'tt_rt_' + crypto.randomBytes(32).toString('base64url'), fam = crypto.randomUUID();
      for (const [kind, tok, ttl] of [['access', at, '30 minutes'], ['refresh', rt, '14 days']]) {
        await q("insert into oauth_tokens(token_hash,kind,family_id,client_id,user_id,resource,scope,expires_at,absolute_expires_at) values($1,$2,$3,$4,$5,$6,'mcp:read',now()+$7::interval,now()+interval '60 days')", [crypto.createHash('sha256').update(tok).digest(), kind, fam, clientId, uid, BASE + '/mcp', ttl]);
      }
      return { at, rt };
    };
    const reasonOf = async (tok) => (await q('select revoked_reason from oauth_tokens where token_hash = $1', [crypto.createHash('sha256').update(tok).digest()])).rows[0]?.revoked_reason;
    const refresh = (rt) => tokenReq({ grant_type: 'refresh_token', refresh_token: rt, client_id: clientId });
    const expectRevoked = async (label, reason, action) => {
      const t = await mintPair(); ok((await ping(t.at)).status === 200, `${label}: token valid before`);
      const r = await action(); ok(r.status >= 200 && r.status < 300, `${label}: route succeeded`, String(r.status));
      ok((await ping(t.at)).status === 401, `${label}: access token rejected after`);
      const rf = await refresh(t.rt); ok(rf.status === 400 && JSON.parse(rf.text).error === 'invalid_grant', `${label}: refresh token also dead`);
      ok((await reasonOf(t.at)) === reason, `${label}: reason ${reason}`); return t;
    };
    const S = superCookie();
    const adminCookie = () => sign({ userId: admin, username: 'e2emcp-' + RUN, displayName: 'E2EMCP Admin', role: 'admin', memberId: member, teamId: team, issuedAt: Date.now(), lastActive: Date.now(), mfa: true });
    await expectRevoked('superadmin password reset', 'password_reset', () => req('POST', '/api/admin/users/reset-password', { headers: { ...SAME, cookie: S }, body: j({ id: admin, newPassword: 'ResetPass-123' }) })); await q('update users set password_hash=$2 where id=$1', [admin, hash]);
    await expectRevoked('platform-admin reset (by userId)', 'password_reset', () => req('POST', '/api/v1/team/members/reset-password', { headers: { ...SAME, cookie: S }, body: j({ userId: admin, teamId: team, newPassword: 'ResetPass-456' }) })); await q('update users set password_hash=$2 where id=$1', [admin, hash]);
    await expectRevoked('own password change', 'password_changed', () => req('PUT', '/api/auth/profile', { headers: { ...SAME, cookie: adminCookie() }, body: j({ currentPassword: PW, newPassword: 'Changed-pass-789' }) })); await q('update users set password_hash=$2 where id=$1', [admin, hash]);
    await expectRevoked('MFA reset', 'mfa_reset', () => req('POST', '/api/admin/users/reset-mfa', { headers: { ...SAME, cookie: S }, body: j({ id: admin }) }));
    const keep = await mintPair();
    ok((await req('PUT', '/api/auth/profile', { headers: { ...SAME, cookie: adminCookie() }, body: j({ displayName: 'Renamed ' + RUN }) })).status === 200 && (await ping(keep.at)).status === 200, 'changing only the display name (profile) does NOT revoke');
    ok((await req('PUT', '/api/admin/users', { headers: { ...SAME, cookie: S }, body: j({ id: admin, displayName: 'Renamed2 ' + RUN }) })).status === 200 && (await ping(keep.at)).status === 200, 'admin edit of the display name only does NOT revoke');
    ok((await req('PUT', '/api/admin/users', { headers: { ...SAME, cookie: S }, body: j({ id: admin, role: 'admin', active: true, teamId: team }) })).status === 200 && (await ping(keep.at)).status === 200, 'sending the same role/active/team does NOT revoke');
    const demoted = await expectRevoked('demotion', 'role_changed', () => req('PUT', '/api/admin/users', { headers: { ...SAME, cookie: S }, body: j({ id: admin, role: 'user' }) }));
    await req('PUT', '/api/admin/users', { headers: { ...SAME, cookie: S }, body: j({ id: admin, role: 'admin', teamId: team }) });
    ok((await ping(demoted.at)).status === 401 && (await refresh(demoted.rt)).status === 400, 'REVIVAL: after re-promotion the pre-demotion tokens stay dead');
    await expectRevoked('deactivation', 'deactivated', () => req('PUT', '/api/admin/users', { headers: { ...SAME, cookie: S }, body: j({ id: admin, active: false }) })); await req('PUT', '/api/admin/users', { headers: { ...SAME, cookie: S }, body: j({ id: admin, active: true }) });
    await expectRevoked('team change', 'team_changed', () => req('PUT', '/api/admin/users', { headers: { ...SAME, cookie: S }, body: j({ id: admin, role: 'admin', teamId: team2 }) })); await q('update users set team_id=$2 where id=$1', [admin, team]);
    await expectRevoked('team-member deactivation', 'deactivated', () => req('PUT', '/api/v1/team/members', { headers: { ...SAME, cookie: S }, body: j({ id: member, displayName: 'E2EMCP Member', teamId: team, active: false }) })); await q('update users set active=true where id=$1', [admin]);
    await expectRevoked('member removed from team', 'member_removed', () => req('DELETE', `/api/v1/team/members?id=${member}&teamId=${team}`, { headers: { cookie: S } }));
    await q('update users set team_id=$2 where id=$1', [admin, team2]);
    await expectRevoked('team deleted', 'team_deleted', () => req('DELETE', `/api/admin/teams?id=${team2}`, { headers: { cookie: S } })); await q('update users set team_id=$2 where id=$1', [admin, team]);
    // hard deletes: tokens disappear through the foreign key
    const victim = (await q("insert into users(username,password_hash,display_name,role,team_id) values($1,$2,'E2EMCP Victim','admin',$3) returning id", ['e2emcp-victim-' + RUN, hash, team])).rows[0].id; ids.users.push(victim);
    const vt = await mintPair(victim); ok((await ping(vt.at)).status === 200, 'hard delete: token valid before');
    ok((await req('DELETE', `/api/admin/users?id=${victim}`, { headers: { cookie: S } })).status === 200 && (await ping(vt.at)).status === 401 && (await refresh(vt.rt)).status === 400, 'admin user DELETE: tokens gone, refresh dead');
    ok(Number((await q('select count(*) from oauth_tokens where user_id=$1', [victim])).rows[0].count) === 0, 'admin user DELETE: no token rows remain');

    // ═══ S5 — cron purge, including failure handling ═══
    console.log('\n## S5 cron purge');
    const cron = () => req('GET', '/api/internal/rollup', { headers: { authorization: 'Bearer ' + CRON_SECRET } });
    ok((await req('GET', '/api/internal/rollup')).status === 403 && (await req('GET', '/api/internal/rollup', { headers: { authorization: 'Bearer wrong' } })).status === 403, 'cron refuses a missing or wrong secret');
    const oldTok = crypto.createHash('sha256').update('purge-old-' + RUN).digest();
    await q("insert into oauth_tokens(token_hash,kind,family_id,client_id,user_id,resource,scope,created_at,expires_at,absolute_expires_at) values($1,'access',gen_random_uuid(),$2,$3,$4,'mcp:read',now()-interval '3 days',now()-interval '2 days',now()+interval '1 day')", [oldTok, clientId, admin, BASE + '/mcp']);
    await q("insert into mcp_rate_limits(key,window_start,count) values($1, now()-interval '3 days', 1)", ['e2emcp:' + RUN]);
    const live = await mintPair();
    let c1 = await cron(), b1 = {}; try { b1 = JSON.parse(c1.text); } catch { /* */ }
    ok(c1.status === 200 && b1.ok === true && b1.mcpPurge?.tokens >= 1 && b1.mcpPurge?.rate_limits >= 1, 'cron purges expired rows and reports counts only', JSON.stringify(b1.mcpPurge));
    ok((await q('select 1 from oauth_tokens where token_hash=$1', [oldTok])).rowCount === 0 && (await ping(live.at)).status === 200, 'expired row gone; live token untouched');
    const logAtRename = serverLog.length;
    await q('ALTER FUNCTION mcp_oauth_purge() RENAME TO mcp_oauth_purge_e2e_bak'); purgeRenamed = true;
    let c2 = await cron(), b2 = {}; try { b2 = JSON.parse(c2.text); } catch { /* */ }
    ok(c2.status === 200 && b2.ok === true && b2.mcpPurge?.skipped === true, 'function missing (migration not applied): rollup still succeeds, purge skipped');
    await new Promise((r) => setTimeout(r, 1000));
    ok(!serverLog.slice(logAtRename).includes('[DATABASE-QUERY-ERROR]'), 'function missing: nothing is raised or logged by the shared DB layer (quiet skip)');
    await q("CREATE FUNCTION mcp_oauth_purge() RETURNS jsonb LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'e2e-boom-secret-detail'; END $f$");
    const logStart = serverLog.length; let c3 = await cron(), b3 = {}; try { b3 = JSON.parse(c3.text); } catch { /* */ }
    ok(c3.status === 200 && b3.ok === true && b3.mcpPurge?.error === true, 'purge raising an error: rollup STILL succeeds and reports error:true');
    await new Promise((r) => setTimeout(r, 1500)); // let the server flush its log
    const newLog = serverLog.slice(logStart);
    ok(!c3.text.includes('e2e-boom'), 'purge failure: the database error text is not in the HTTP response');
    ok(newLog.includes('[mcp] purge failed'), 'purge failure: logged as the fixed line "[mcp] purge failed"');
    // Documented, pre-existing behaviour: lib/team/db query() logs "[DATABASE-QUERY-ERROR] <code> <message ≤200 chars> | query: <SQL ≤160 chars>" for any failed
    // query and NEVER bound parameters. So the server-side message may appear in the log; tokens, hashes and parameters must not.
    const dbLine = newLog.split('\n').find((l) => l.includes('[DATABASE-QUERY-ERROR]')) || '';
    ok(dbLine.includes('mcp_oauth_purge') && !/tt_(at|rt|ac)_|postgres(ql)?:\/\/|\$\d/.test(dbLine), 'purge failure: the shared DB layer logs its standard line (code, message, SQL text) with no parameters, tokens or connection strings');
    await q('DROP FUNCTION mcp_oauth_purge()'); await q('ALTER FUNCTION mcp_oauth_purge_e2e_bak() RENAME TO mcp_oauth_purge'); purgeRenamed = false;
    ok((await q("select count(*)::int n from pg_proc where proname = 'mcp_oauth_purge'")).rows[0].n === 1 && JSON.parse((await cron()).text).mcpPurge?.codes !== undefined, 'purge function restored and working');

    // migration absent: hooked routes must keep working, quietly (no error line, no schema DDL pass triggered by the revoke helper)
    await q('ALTER TABLE oauth_tokens RENAME TO oauth_tokens_e2e_bak'); tokensRenamed = true;
    const logAt = serverLog.length;
    const pre = await req('POST', '/api/admin/users/reset-password', { headers: { ...SAME, cookie: S }, body: j({ id: admin, newPassword: 'NoMigration-123' }) });
    await new Promise((r) => setTimeout(r, 1000));
    ok(pre.status === 200, 'MCP tables absent: a hooked route (password reset) still succeeds', String(pre.status));
    const absentLog = serverLog.slice(logAt).trim();
    // Scoped to what this proves: the revoke helper must not raise or log anything about the MCP tables (no 42P01, no schema pass). Unrelated lines are tolerated and shown.
    ok(!/oauth_tokens|oauth_authorization|mcp_|42P01|does not exist|ensureSchema/i.test(absentLog), 'MCP tables absent: the revoke helper raises and logs nothing about the MCP tables (catalog check first)', absentLog ? 'other log lines present: ' + absentLog.replace(/\s+/g, ' ').slice(0, 160) : '');
    await q('ALTER TABLE oauth_tokens_e2e_bak RENAME TO oauth_tokens'); tokensRenamed = false; await q('update users set password_hash=$2 where id=$1', [admin, hash]);

    // ═══ S6 — rate limits through the real server ═══
    console.log('\n## S6 rate limits');
    const rlIp = '203.0.113.' + (1 + Math.floor(Math.random() * 200));
    const left = Number((await q("select ceil(60 - mod(extract(epoch from now())::numeric, 60))::int s")).rows[0].s); if (left < 5) await new Promise((r) => setTimeout(r, (left + 1) * 1000));
    await q("insert into mcp_rate_limits(key,window_start,count) values($1, to_timestamp(floor(extract(epoch from now())/60)*60), 120) on conflict (key,window_start) do update set count = 120", ['token:' + ipHash(rlIp)]);
    const lim = await req('POST', '/oauth/token', { headers: { ...FORMH, 'x-real-ip': rlIp }, body: 'grant_type=refresh_token&client_id=tt_e2e_rl&refresh_token=tt_rt_x' });
    ok(lim.status === 429 && JSON.parse(lim.text).error === 'temporarily_unavailable' && Number(lim.headers['retry-after']) >= 1 && /no-store/.test(lim.headers['cache-control'] || ''), 'token endpoint over its limit → 429 + Retry-After', String(lim.status));
    ok((await req('POST', '/oauth/token', { headers: { ...FORMH, 'x-real-ip': '203.0.113.' + (201 + Math.floor(Math.random() * 40)) }, body: 'grant_type=refresh_token&client_id=tt_e2e_rl2&refresh_token=tt_rt_x' })).status !== 429, 'another address is unaffected');

    { // S8 gets its own block scope: its names must not collide with earlier scenarios
    // ═══ S8 — the audit trail for built-in and database actors (audit_log.actor_user_id is a UUID FK) ═══
    console.log('\n## S8 audit trail: built-in accounts and database users');
    const auditSince = (await q('select now() as t')).rows[0].t;
    const auditRows = async (action, target) => (await q('select actor_user_id, actor_username, metadata from audit_log where action=$1 and target_id=$2 and created_at >= $3', [action, target, auditSince])).rows;
    const teamCookie = sign({ userId: 'admin', username: 'team', displayName: 'Team Admin', role: 'admin', memberId: null, teamId: null, issuedAt: Date.now(), lastActive: Date.now(), mfa: true });
    const r1 = await req('POST', '/api/admin/users/reset-password', { headers: { ...SAME, cookie: S }, body: j({ id: plain2, newPassword: 'AuditPass-111' }) });
    ok(r1.status === 200, 'built-in superadmin: password reset succeeds', String(r1.status));
    const a1 = await auditRows('user.reset-password', plain2);
    ok(a1.length === 1 && a1[0].actor_user_id === null && a1[0].actor_username === 'superadmin' && a1[0].metadata?.builtinActor === 'superadmin', 'built-in superadmin: the reset IS audited (actor_user_id NULL, username "superadmin", builtinActor kept)', JSON.stringify(a1).slice(0, 160));
    const imp = await req('POST', '/api/admin/impersonate', { headers: { ...SAME, cookie: S }, body: j({ userId: plain2 }) });
    ok(imp.status === 200, 'built-in superadmin: impersonation succeeds', String(imp.status));
    const a2 = await auditRows('impersonate.start', plain2);
    ok(a2.length === 1 && a2[0].actor_user_id === null && a2[0].actor_username === 'superadmin', 'built-in superadmin: impersonation IS audited (the headline audited action)', JSON.stringify(a2).slice(0, 160));
    const r3 = await req('POST', '/api/v1/team/members/reset-password', { headers: { ...SAME, cookie: teamCookie }, body: j({ userId: plain2, teamId: team, newPassword: 'AuditPass-222' }) });
    ok(r3.status === 200, 'built-in team admin: member password reset succeeds', String(r3.status) + ' ' + r3.text.slice(0, 80));
    const a3 = (await auditRows('team.user.reset-password', plain2)).filter((r) => r.actor_username === 'team');
    ok(a3.length === 1 && a3[0].actor_user_id === null && a3[0].metadata?.builtinActor === 'admin', 'built-in team admin: the reset IS audited (actor_user_id NULL, username "team", builtinActor "admin")', JSON.stringify(a3).slice(0, 160));
    const r4 = await req('POST', '/api/v1/team/members/reset-password', { headers: { ...SAME, cookie: adminCookie() }, body: j({ userId: plain2, newPassword: 'AuditPass-333' }) });
    ok(r4.status === 200, 'database team admin: member password reset succeeds', String(r4.status) + ' ' + r4.text.slice(0, 80));
    const a4 = (await auditRows('team.user.reset-password', plain2)).filter((r) => r.actor_username === 'e2emcp-' + RUN);
    ok(a4.length === 1 && a4[0].actor_user_id === admin && !a4[0].metadata?.builtinActor && !a4[0].metadata?.actorUserMissing, 'database user: audited exactly as before (actor_user_id = their id, no marker)', JSON.stringify(a4).slice(0, 160));
    ok(!serverLog.includes('[audit-log-error]'), 'NO audit failure was logged anywhere during the whole run so far (nothing is silently lost)');
    }

    // ═══ S7 — existing built-in logins are unchanged (regression) ═══
    console.log('\n## S7 built-in accounts (existing behaviour)');
    for (const [user, home] of [['team', '/team'], ['superadmin', '/admin']]) {
      const l = await req('POST', '/api/auth/login', { headers: SAME, body: j({ username: user, password: BUILTIN[user].pw, returnTo }) });
      const lb = JSON.parse(l.text); ok(l.status === 200 && lb.mfaRequired && !lb.enroll, `${user}: password stage → MFA required (env TOTP), no enrolment`);
      const pend = l.cookies.find((c) => c.startsWith('mfa_pending='));
      const m = await req('POST', '/api/auth/mfa/verify', { headers: { ...SAME, cookie: pend }, body: j({ code: hotp(BUILTIN[user].totp, step() + (user === 'team' ? 0 : 1)) }) });
      ok(m.status === 200 && JSON.parse(m.text).redirect === home, `${user}: lands on ${home}; a supplied returnTo is IGNORED for built-in accounts`);
      const ba = await req('GET', AUTH, { headers: { cookie: m.cookies.find((c) => c.startsWith('app_session=')) } });
      ok(ba.status === 200 && ba.text.includes('Not allowed') && !/consentToken/.test(ba.text), `${user}: built-in account cannot authorize MCP access`);
    }
    ok((await req('POST', '/api/auth/login', { headers: SAME, body: j({ username: 'team', password: 'wrong-password' }) })).status === 401, 'wrong built-in password → 401');
    ok(!serverLog.includes('[audit-log-error]'), 'still no [audit-log-error] after the built-in login scenarios');
    ok(!/tt_at_|tt_rt_|tt_ac_|postgres(ql)?:\/\//.test(serverLog), 'the server log contains no token or connection string');
  } finally {
    if (tokensRenamed) await q('ALTER TABLE oauth_tokens_e2e_bak RENAME TO oauth_tokens').catch((e) => console.log('!! could not restore oauth_tokens:', e.message));
    if (purgeRenamed) { await q('DROP FUNCTION IF EXISTS mcp_oauth_purge()').catch(() => {}); await q('ALTER FUNCTION mcp_oauth_purge_e2e_bak() RENAME TO mcp_oauth_purge').catch((e) => console.log('!! could not restore mcp_oauth_purge:', e.message)); }
    await q("delete from audit_log where target_id = any($1) or actor_username like 'e2emcp-%' or action like 'mcp.%' or actor_username in ('team','superadmin') and created_at > now() - interval '1 hour'", [[...ids.users, ...ids.members, ...ids.teams, ...ids.clients]]).catch(() => {});
    await q('delete from mcp_rate_limits').catch(() => {});
    await q('delete from oauth_clients where client_id = any($1)', [ids.clients]).catch(() => {});
    await q('delete from users where id = any($1)', [ids.users]).catch(() => {});
    await q('delete from team_members where member_id = any($1)', [ids.members]).catch(() => {});
    await q('delete from members where id = any($1)', [ids.members]).catch(() => {});
    await q('delete from teams where id = any($1)', [ids.teams]).catch(() => {});
    await q("delete from auth_totp where subject = any($1)", [ids.users.map((x) => 'user:' + x)]).catch(() => {});
    await q('delete from auth_throttle').catch(() => {});
    await db.end();
  }
}

(async () => {
  try {
    if (!SKIP_BUILD) await build();
    await start();
    await main();
  } catch (e) { fails++; console.log('FAIL  harness error —', e.message); }
  finally { stop(); }
  console.log(fails ? `\n${fails} of ${total} CHECK(S) FAILED` : `\nAll ${total} e2e checks passed`);
  process.exit(fails ? 1 : 0);
})();
