/**
 * Live database tests for the MCP data plane (scripts/migrations/mcp-data.sql + mcp-data.grants.sql).
 * Needs a DISPOSABLE LOCAL PostgreSQL with the app schema, the MCP OAuth tables and the data plane applied:
 *   MCP_DATA_TEST_OWNER_URL, MCP_DATA_TEST_READER_URL (user mcp_reader), MCP_DATA_TEST_SUPER_URL.
 * Skips unless all three are set and SKIP_DB_TESTS is unset. Refuses (throws) when the host is not localhost/127.0.0.1.
 * Fixture rows carry unique random names and are removed in after(). No URL or password is ever printed.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

const OWNER_URL = process.env.MCP_DATA_TEST_OWNER_URL;
const READER_URL = process.env.MCP_DATA_TEST_READER_URL;
const SUPER_URL = process.env.MCP_DATA_TEST_SUPER_URL;
const SKIP = !OWNER_URL || !READER_URL || !SUPER_URL || !!process.env.SKIP_DB_TESTS;

function assertLocal(raw: string): void {
  const u = new URL(raw);
  if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') throw new Error('mcp-data-db tests refuse to run against a non-local host');
  // pg honours these query parameters over the URL host, so any of them could redirect the connection elsewhere
  for (const k of ['host', 'hostaddr', 'service', 'options', 'sslrootcert', 'sslcert', 'sslkey']) if (u.searchParams.has(k)) throw new Error('mcp-data-db tests refuse connection URLs with host-overriding parameters');
  if (!/^\/mcp_[a-z0-9_]+$/.test(u.pathname)) throw new Error('mcp-data-db tests only run against a disposable database whose name starts with mcp_');
}
if (!SKIP) for (const u of [OWNER_URL!, READER_URL!, SUPER_URL!]) assertLocal(u);

const RUN = crypto.randomBytes(5).toString('hex');
const uuid = () => crypto.randomUUID();
const sha = (t: string) => crypto.createHash('sha256').update(t).digest();
const MIN = 60_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const DAY = 86_400_000;

let owner: pg.Client;
let sup: pg.Client;
let rd: pg.Client;

const T = { A: uuid(), B: uuid(), C: uuid() };
const memberA1 = uuid(); // only in A
const memberB1 = uuid(); // only in B
const memberC1 = uuid();
const memberAB = uuid(); // in A and B
const memberGone = uuid(); // in A, later removed
const userA = uuid(); const userB = uuid(); const userC = uuid();
const CLIENT = `tt_datatest_${RUN}`;
const tokA = `tokA-${RUN}`; const tokB = `tokB-${RUN}`; const tokRefresh = `tokR-${RUN}`;
const hA = sha(tokA); const hB = sha(tokB); const hR = sha(tokRefresh);
const CANARY = {
  promptA: `CANARY_PROMPT_A_${RUN}`, promptB: `CANARY_PROMPT_B_${RUN}`,
  label: `CANARY_LABEL_${RUN}`, events: `CANARY_EVENTS_${RUN}`, agent: `CANARY_AGENT_${RUN}`,
  project: `CANARY_PROJECT_${RUN}`, path: `/CANARY_PATH_${RUN}/secret.ts`,
};
const sessionIds: Record<string, string[]> = { A: [], B: [], AB_A: [], AB_B: [], gone: [] };
const promptIds: Record<string, number[]> = { A: [], B: [] };
const textSessionIds = { A: [] as string[], B: [] as string[] };

async function ex(c: pg.Client, text: string, params: unknown[] = []) { return c.query(text, params); }
async function err(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; return { code: 'OK', message: '' }; } catch (e) { const x = e as { code?: string; message?: string }; return { code: x.code ?? 'ERR', message: x.message ?? '' }; }
}
async function rw(text: string): Promise<string> {
  await rd.query('BEGIN READ WRITE');
  try { return (await err(rd.query(text))).code; } finally { await rd.query('ROLLBACK'); }
}
async function sql(text: string, params: unknown[] = []) { return (await rd.query(text, params)).rows; }

const win = (fromDays = 6, toMin = 0) => [iso(fromDays * DAY), iso(toMin * MIN)];

const listDevs = (h: Buffer | null, limit = 50, after: string | null = null) => sql('SELECT * FROM mcp_data.list_developers($1,$2,$3)', [h, limit, after]);
const listSess = (h: Buffer | null, o: { member?: string | null; from?: string; to?: string; tool?: string | null; model?: string | null; limit?: number; afterTs?: string | null; afterId?: string | null } = {}) => {
  const [f, t] = win();
  return sql('SELECT * FROM mcp_data.list_sessions($1,$2,$3,$4,$5,$6,$7,$8,$9)', [h, o.member ?? null, o.from ?? f, o.to ?? t, o.tool ?? null, o.model ?? null, o.limit ?? 26, o.afterTs ?? null, o.afterId ?? null]);
};
const details = (h: Buffer | null, id: string | null) => sql('SELECT * FROM mcp_data.session_details($1,$2)', [h, id]);
const activity = (h: Buffer | null, m: string | null, from?: string, to?: string) => {
  const [f, t] = win(); return sql('SELECT * FROM mcp_data.developer_activity($1,$2,$3,$4)', [h, m, from ?? f, to ?? t]);
};
const search = (h: Buffer | null, o: { member?: string | null; from?: string; to?: string; intents?: string[] | null; tool?: string | null; model?: string | null; limit?: number; afterTs?: string | null; afterId?: number | null } = {}) => {
  const [f, t] = win(5);
  return sql('SELECT * FROM mcp_data.search_prompt_metadata($1,$2,$3,$4,$5,NULL,NULL,NULL,NULL,NULL,$6,$7,$8,$9,$10)',
    [h, o.member ?? null, o.from ?? f, o.to ?? t, o.intents ?? null, o.tool ?? null, o.model ?? null, o.limit ?? 26, o.afterTs ?? null, o.afterId ?? null]);
};
const batch = (h: Buffer | null, ids: (number | string)[]) => sql('SELECT * FROM mcp_data.prompt_metadata_batch($1,$2::bigint[])', [h, ids]);

const ALL_FUNCS: [string, (h: Buffer | null) => Promise<unknown[]>][] = [
  ['list_developers', (h) => listDevs(h)],
  ['developer_activity', (h) => activity(h, memberA1)],
  ['list_sessions', (h) => listSess(h)],
  ['session_details', (h) => details(h, sessionIds.A[0])],
  ['search_prompt_metadata', (h) => search(h)],
  ['prompt_metadata_batch', (h) => batch(h, [promptIds.A[0]])],
];

async function insertSession(team: string, member: string, source: string, msAgo: number, opts: { label?: string; model?: string } = {}): Promise<{ id: string; sid: string }> {
  const sid = `s_${RUN}_${crypto.randomBytes(4).toString('hex')}`;
  const r = await ex(owner,
    `INSERT INTO sync_sessions (team_id, member_id, source, session_id, agent, label, model, started_at, ended_at, tokens_in, tokens_out, payload_hash, events)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,10,20,$9,$10) RETURNING id`,
    [team, member, source, sid, CANARY.agent, opts.label ?? CANARY.label, opts.model ?? 'claude-test', iso(msAgo), `ph${RUN}`, JSON.stringify([{ note: CANARY.events }])]);
  const id = r.rows[0].id as string;
  await ex(owner, 'INSERT INTO sync_session_tools (sync_session_id, tool_name, call_count) VALUES ($1,$2,3),($1,$3,1)', [id, 'Edit', 'Bash']);
  await ex(owner, 'INSERT INTO sync_session_files (sync_session_id, path) VALUES ($1,$2)', [id, CANARY.path]);
  return { id, sid };
}
async function insertTurns(team: string, member: string, source: string, sid: string, msAgo: number, text: string, intent = 'bug_fix'): Promise<number> {
  const u = await ex(owner,
    `INSERT INTO session_turns (session_id, org_id, user_id, tool, model, turn_index, turn_role, prompt_text_sanitized, prompt_char_len, has_code_block, intent_category, created_at)
     VALUES ($1,$2,$3,$4,'claude-test',0,'user',$5,$6,true,$7,$8) RETURNING id`,
    [sid, team, member, source, text, text.length, intent, iso(msAgo)]);
  await ex(owner,
    `INSERT INTO session_turns (session_id, org_id, user_id, tool, model, turn_index, turn_role, input_tokens, output_tokens, created_at)
     VALUES ($1,$2,$3,$4,'claude-test',0,'assistant',100,200,$5)`, [sid, team, member, source, iso(msAgo - 1000)]);
  return Number(u.rows[0].id);
}

describe('mcp data plane (live DB)', { skip: SKIP ? 'MCP_DATA_TEST_* not set or SKIP_DB_TESTS set' : false }, () => {
  before(async () => {
    owner = new pg.Client({ connectionString: OWNER_URL }); sup = new pg.Client({ connectionString: SUPER_URL }); rd = new pg.Client({ connectionString: READER_URL });
    await owner.connect(); await sup.connect(); await rd.connect();
    for (const [k, v] of Object.entries(T)) await ex(owner, 'INSERT INTO teams (id, name) VALUES ($1,$2)', [v, `dt_${k}_${RUN}`]);
    const mem = async (id: string, name: string) => ex(owner, 'INSERT INTO members (id, display_name) VALUES ($1,$2)', [id, `${name}_${RUN}`]);
    for (const [id, n] of [[memberA1, 'a1'], [memberB1, 'b1'], [memberC1, 'c1'], [memberAB, 'ab'], [memberGone, 'gone']]) await mem(id, n);
    const tm = (t: string, m: string) => ex(owner, 'INSERT INTO team_members (team_id, member_id) VALUES ($1,$2)', [t, m]);
    await tm(T.A, memberA1); await tm(T.A, memberAB); await tm(T.A, memberGone); await tm(T.B, memberB1); await tm(T.B, memberAB); await tm(T.C, memberC1);
    for (const [u, t, n] of [[userA, T.A, 'a'], [userB, T.B, 'b'], [userC, T.C, 'c']]) {
      await ex(owner, `INSERT INTO users (id, username, password_hash, display_name, team_id, role, active) VALUES ($1,$2,'x',$3,$4,'admin',true)`, [u, `dtu_${n}_${RUN}`, `u${n}`, t]);
    }
    await ex(owner, `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, registration) VALUES ($1,'dt',ARRAY['https://example.invalid/cb'],'static')`, [CLIENT]);
    const tok = async (h: Buffer, user: string, kind = 'access') => (await ex(owner,
      `INSERT INTO oauth_tokens (token_hash, kind, family_id, client_id, user_id, resource, scope, expires_at, absolute_expires_at)
       VALUES ($1,$2,$3,$4,$5,'https://example.invalid/mcp','mcp:read', now() + interval '30 minutes', now() + interval '60 days') RETURNING id`, [h, kind, uuid(), CLIENT, user])).rows[0].id as string;
    await tok(hA, userA); await tok(hB, userB); await tok(hR, userA, 'refresh');

    // Team A: 30 sessions for a1 (with deliberate timestamp ties), AB sessions in A and in B, gone member session
    for (let i = 0; i < 30; i++) {
      const msAgo = (2 * DAY) + Math.floor(i / 2) * 10 * MIN; // pairs share the same instant
      const s = await insertSession(T.A, memberA1, 'claude', msAgo);
      sessionIds.A.push(s.id);
      promptIds.A.push(await insertTurns(T.A, memberA1, 'claude', s.sid, msAgo, `${CANARY.promptA} ${i}`, i % 2 ? 'feature' : 'bug_fix'));
      textSessionIds.A.push(s.sid);
    }
    for (let i = 0; i < 3; i++) { const s = await insertSession(T.A, memberAB, 'claude', DAY + i * MIN); sessionIds.AB_A.push(s.id); promptIds.A.push(await insertTurns(T.A, memberAB, 'claude', s.sid, DAY + i * MIN, `${CANARY.promptA} ab`)); }
    for (let i = 0; i < 2; i++) { const s = await insertSession(T.B, memberAB, 'claude', DAY + i * MIN); sessionIds.AB_B.push(s.id); promptIds.B.push(await insertTurns(T.B, memberAB, 'claude', s.sid, DAY + i * MIN, `${CANARY.promptB} ab`)); }
    for (let i = 0; i < 5; i++) {
      const s = await insertSession(T.B, memberB1, 'codex', 3 * DAY + i * MIN); sessionIds.B.push(s.id);
      promptIds.B.push(await insertTurns(T.B, memberB1, 'codex', s.sid, 3 * DAY + i * MIN, `${CANARY.promptB} ${i}`, 'explain'));
      textSessionIds.B.push(s.sid);
    }
    const g = await insertSession(T.A, memberGone, 'claude', DAY); sessionIds.gone.push(g.id);
    promptIds.A.push(await insertTurns(T.A, memberGone, 'claude', g.sid, DAY, `${CANARY.promptA} gone`));
    // daily usage
    const day = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
    for (const [t, m, n, sc] of [[T.A, memberA1, 1, 7], [T.A, memberA1, 2, 5], [T.B, memberB1, 1, 9], [T.B, memberAB, 1, 4], [T.A, memberAB, 1, 3]] as const) {
      await ex(owner, `INSERT INTO daily_member_usage (day, team_id, member_id, source, project, tokens_in, session_count) VALUES ($1,$2,$3,'claude',$4,100,$5)`, [day(n), t, m, CANARY.project, sc]);
    }
  });

  after(async () => {
    const c = sup ?? owner;
    const tryq = async (q: string, p: unknown[] = []) => { try { await c.query(q, p); } catch { /* best effort */ } };
    const teams = Object.values(T);
    await tryq(`DELETE FROM session_turns WHERE session_id LIKE $1`, [`s\\_${RUN}\\_%`]);
    await tryq(`DELETE FROM sync_session_files WHERE sync_session_id IN (SELECT id FROM sync_sessions WHERE team_id = ANY($1::uuid[]))`, [teams]);
    await tryq(`DELETE FROM sync_session_tools WHERE sync_session_id IN (SELECT id FROM sync_sessions WHERE team_id = ANY($1::uuid[]))`, [teams]);
    await tryq(`DELETE FROM sync_sessions WHERE team_id = ANY($1::uuid[])`, [teams]);
    await tryq(`DELETE FROM daily_member_usage WHERE team_id = ANY($1::uuid[])`, [teams]);
    await tryq(`DELETE FROM oauth_tokens WHERE client_id = $1`, [CLIENT]);
    await tryq(`DELETE FROM oauth_clients WHERE client_id = $1`, [CLIENT]);
    await tryq(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[userA, userB, userC]]);
    await tryq(`DELETE FROM team_members WHERE team_id = ANY($1::uuid[])`, [teams]);
    await tryq(`DELETE FROM members WHERE id = ANY($1::uuid[])`, [[memberA1, memberB1, memberC1, memberAB, memberGone]]);
    await tryq(`DELETE FROM teams WHERE id = ANY($1::uuid[])`, [teams]);
    for (const x of [rd, owner, sup]) { try { await x?.end(); } catch { /* ignore */ } }
  });

  describe('1. role matrix', () => {
    for (const t of ['users', 'members', 'team_members', 'sync_sessions', 'session_turns', 'oauth_tokens', 'daily_member_usage', 'audit_log', 'sync_session_files', 'sync_session_tools']) {
      it(`mcp_reader cannot SELECT ${t}`, async () => { assert.equal((await err(rd.query(`SELECT * FROM public.${t} LIMIT 1`))).code, '42501'); });
    }
    it('cannot call internal helpers or any function outside the six', async () => {
      assert.equal((await err(rd.query('SELECT * FROM mcp_data._resolve_scope($1)', [hA]))).code, '42501');
      assert.equal((await err(rd.query('SELECT mcp_data._safe_ident($1)', ['x']))).code, '42501');
      assert.equal((await err(rd.query('SELECT mcp_data._norm_intent($1)', ['x']))).code, '42501');
      assert.equal((await err(rd.query('SELECT mcp_data._iso_utc(now())'))).code, '42501');
      assert.equal((await err(rd.query('SELECT mcp_data._check_window(now() - interval \'1 hour\', now(), interval \'1 day\')'))).code, '42501');
      assert.equal((await err(rd.query('SELECT * FROM mcp_data._session_rows($1,NULL,NULL,now(),now(),NULL,NULL,1,NULL,NULL)', [T.A]))).code, '42501');
      assert.equal((await err(rd.query('SELECT public.nonexistent_fn_zz()'))).code, '42883');
      const allowed = new Set(ALL_FUNCS.map(([n]) => n));
      const mcpExec = (await sup.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='mcp_data' AND has_function_privilege('mcp_reader', p.oid, 'EXECUTE')`)).rows.map((r) => r.proname as string).sort();
      assert.deepEqual(mcpExec, [...allowed].sort());
    });
    it('cannot CREATE in public or mcp_data', async () => {
      assert.equal(await rw('CREATE TABLE public.zz_dt_x (a int)'), '42501');
      assert.equal(await rw('CREATE TABLE mcp_data.zz_dt_x (a int)'), '42501');
      assert.equal(await rw('CREATE FUNCTION mcp_data.zz_dt_f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$'), '42501');
      assert.equal((await err(rd.query('CREATE TABLE public.zz_dt_x (a int)'))).code, '25006', 'role is also read-only by default');
    });
    it('cannot INSERT / UPDATE / DELETE anything', async () => {
      for (const t of ['users', 'teams', 'members', 'team_members', 'sync_sessions', 'session_turns', 'oauth_tokens', 'oauth_clients', 'daily_member_usage', 'audit_log']) {
        assert.equal(await rw(`INSERT INTO public.${t} DEFAULT VALUES`), '42501', `insert ${t}`);
        assert.equal(await rw(`UPDATE public.${t} SET ${(await sup.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name<>'id' ORDER BY ordinal_position LIMIT 1", [t])).rows[0].column_name} = NULL WHERE false`), '42501', `update ${t}`);
        assert.equal(await rw(`DELETE FROM public.${t} WHERE false`), '42501', `delete ${t}`);
      }
    });
  });

  describe('2. tenant isolation', () => {
    it('list_developers: only own team, strict page keyset', async () => {
      const a = await listDevs(hA); const b = await listDevs(hB);
      assert.deepEqual(a.map((r) => r.member_id).sort(), [memberA1, memberAB, memberGone].sort());
      assert.deepEqual(b.map((r) => r.member_id).sort(), [memberB1, memberAB].sort());
      const seen: string[] = []; let after: string | null = null;
      for (;;) { const p = await listDevs(hA, 2, after); seen.push(...p.map((r) => r.member_id)); if (p.length < 2) break; after = p[p.length - 1].member_id; }
      assert.deepEqual(seen, [...seen].sort()); assert.equal(new Set(seen).size, seen.length); assert.equal(seen.length, 3);
    });
    it('list_sessions: A sees only team A sessions, B only team B', async () => {
      const a = await listSess(hA, { limit: 26 }); const b = await listSess(hB);
      const idsA = new Set([...sessionIds.A, ...sessionIds.AB_A, ...sessionIds.gone]);
      const idsB = new Set([...sessionIds.B, ...sessionIds.AB_B]);
      assert.ok(a.length > 0 && b.length > 0);
      for (const r of a) assert.ok(idsA.has(r.id), 'A row belongs to team A');
      for (const r of b) assert.ok(idsB.has(r.id), 'B row belongs to team B');
      assert.equal(b.length, 7);
    });
    it('developer in teams A and B: sessions only visible to the team whose team_id they carry', async () => {
      const a = (await listSess(hA, { member: memberAB })).map((r) => r.id).sort();
      const b = (await listSess(hB, { member: memberAB })).map((r) => r.id).sort();
      assert.deepEqual(a, [...sessionIds.AB_A].sort());
      assert.deepEqual(b, [...sessionIds.AB_B].sort());
      for (const id of sessionIds.AB_B) assert.equal((await err(details(hA, id))).code, 'P0002');
      for (const id of sessionIds.AB_A) assert.equal((await err(details(hB, id))).code, 'P0002');
    });
    it('developer_activity: own team only; foreign / missing member is not_found with identical message', async () => {
      const a = await activity(hA, memberA1);
      assert.ok(a.length >= 1);
      assert.equal(a.reduce((s, r) => s + Number(r.session_count), 0), 12);
      const abA = await activity(hA, memberAB); const abB = await activity(hB, memberAB);
      assert.equal(Number(abA[0].session_count), 3); assert.equal(Number(abB[0].session_count), 4);
      const foreign = await err(activity(hA, memberB1)); const missing = await err(activity(hA, uuid()));
      assert.equal(foreign.code, 'P0002'); assert.equal(missing.code, 'P0002'); assert.equal(foreign.message, missing.message);
    });
    it('session_details: foreign and missing ids are indistinguishable', async () => {
      const foreign = await err(details(hA, sessionIds.B[0])); const missing = await err(details(hA, uuid()));
      assert.equal(foreign.code, 'P0002'); assert.equal(foreign.code, missing.code); assert.equal(foreign.message, missing.message);
      const ok = await details(hA, sessionIds.A[0]);
      assert.equal(ok.length, 1); assert.deepEqual(ok[0].tools.map((t: { tool_name: string }) => t.tool_name).sort(), ['Bash', 'Edit']);
    });
    it('search_prompt_metadata / batch: own team only; mixed ids return only own; foreign == missing', async () => {
      const a = await search(hA, { limit: 26 }); const b = await search(hB);
      const pa = new Set(promptIds.A), pb = new Set(promptIds.B);
      for (const r of a) assert.ok(pa.has(Number(r.prompt_id)));
      for (const r of b) assert.ok(pb.has(Number(r.prompt_id)));
      assert.equal(b.length, 7);
      const mixed = await batch(hA, [promptIds.A[0], promptIds.B[0], promptIds.B[1], 999999999]);
      assert.deepEqual(mixed.map((r) => Number(r.prompt_id)), [promptIds.A[0]]);
      const onlyForeign = await batch(hA, [promptIds.B[0]]); const onlyMissing = await batch(hA, [999999998]);
      assert.deepEqual(onlyForeign, []); assert.deepEqual(onlyMissing, []);
      const abPromptsB = await batch(hA, promptIds.B.slice(-2));
      assert.deepEqual(abPromptsB, []);
    });
    it('keyset pagination returns each row exactly once (sessions and prompts, with timestamp ties)', async () => {
      const expected = sessionIds.A.length + sessionIds.AB_A.length + sessionIds.gone.length;
      let seen: string[] = []; let ts: string | null = null; let id: string | null = null;
      for (let guard = 0; guard < 20; guard++) {
        const rows = await listSess(hA, { limit: 4, afterTs: ts, afterId: id });
        seen.push(...rows.map((r) => r.id)); if (rows.length < 4) break;
        ts = rows[rows.length - 1].activity_at; id = rows[rows.length - 1].id;
      }
      assert.equal(new Set(seen).size, seen.length, 'no duplicates');
      assert.equal(seen.length, expected, 'all current-member sessions exactly once');
      seen = [];
      let pts: string | null = null; let pid: number | null = null;
      for (let guard = 0; guard < 30; guard++) {
        const rows = await search(hA, { limit: 4, afterTs: pts, afterId: pid });
        seen.push(...rows.map((r) => String(r.prompt_id))); if (rows.length < 4) break;
        pts = rows[rows.length - 1].created_at; pid = Number(rows[rows.length - 1].prompt_id);
      }
      assert.equal(new Set(seen).size, seen.length);
      assert.equal(seen.length, promptIds.A.length);
    });
    it('member removed from team_members disappears (and returns when restored)', async () => {
      const before_ = (await listSess(hA, { member: memberGone })).length;
      assert.equal(before_, 1);
      await ex(sup, 'DELETE FROM team_members WHERE team_id=$1 AND member_id=$2', [T.A, memberGone]);
      try {
        assert.equal((await listSess(hA, { member: memberGone })).length, 0);
        assert.equal((await listDevs(hA)).some((r) => r.member_id === memberGone), false);
        assert.equal((await err(details(hA, sessionIds.gone[0]))).code, 'P0002');
        assert.equal((await err(activity(hA, memberGone))).code, 'P0002');
        assert.equal((await search(hA, { member: memberGone })).length, 0);
      } finally { await ex(sup, 'INSERT INTO team_members (team_id, member_id) VALUES ($1,$2)', [T.A, memberGone]); }
      assert.equal((await listSess(hA, { member: memberGone })).length, 1);
    });
  });

  describe('3. token validity', () => {
    const flip = async (name: string, bad: () => Promise<void>, good: () => Promise<void>) => {
      assert.equal((await err(listDevs(hA))).code, 'OK', `${name}: baseline`);
      await bad();
      try { for (const [fn, f] of ALL_FUNCS) assert.equal((await err(f(hA))).code, '28000', `${name}: ${fn}`); } finally { await good(); }
      assert.equal((await err(listDevs(hA))).code, 'OK', `${name}: restored`);
    };
    it('unknown / wrong length / NULL hash -> 28000', async () => {
      for (const h of [sha('nope-' + RUN), Buffer.alloc(31, 1), Buffer.alloc(33, 1), Buffer.alloc(0), null]) {
        for (const [fn] of ALL_FUNCS) {
          const call = (await err(fn === 'list_developers' ? listDevs(h) : fn === 'developer_activity' ? activity(h, memberA1) : fn === 'list_sessions' ? listSess(h) : fn === 'session_details' ? details(h, sessionIds.A[0]) : fn === 'search_prompt_metadata' ? search(h) : batch(h, [promptIds.A[0]])));
          assert.equal(call.code, '28000', fn);
        }
      }
    });
    it('refresh-kind token -> 28000', async () => { assert.equal((await err(listDevs(hR))).code, '28000'); });
    it('revoked token (revocation is permanent: uses a throwaway token)', async () => {
      const th = sha(`tokRev-${RUN}`);
      await ex(owner, `INSERT INTO oauth_tokens (token_hash, kind, family_id, client_id, user_id, resource, scope, expires_at, absolute_expires_at)
        VALUES ($1,'access',$2,$3,$4,'https://example.invalid/mcp','mcp:read', now() + interval '30 minutes', now() + interval '60 days')`, [th, uuid(), CLIENT, userA]);
      assert.equal((await err(listDevs(th))).code, 'OK');
      await ex(sup, 'UPDATE oauth_tokens SET revoked_at = now() WHERE token_hash=$1', [th]);
      for (const [fn, f] of ALL_FUNCS) assert.equal((await err(f(th))).code, '28000', fn);
    });
    for (const [name, exp, abs] of [['expired', "now() - interval '1 second'", "now() + interval '60 days'"], ['absolute-expired', "now() + interval '30 minutes'", "now() - interval '1 second'"]]) {
      it(`${name} token (expiry columns are immutable: uses a throwaway token)`, async () => {
        const th = sha(`tok-${name}-${RUN}`);
        await ex(owner, `INSERT INTO oauth_tokens (token_hash, kind, family_id, client_id, user_id, resource, scope, expires_at, absolute_expires_at)
          VALUES ($1,'access',$2,$3,$4,'https://example.invalid/mcp','mcp:read', ${exp}, ${abs})`, [th, uuid(), CLIENT, userA]);
        for (const [fn, f] of ALL_FUNCS) assert.equal((await err(f(th))).code, '28000', fn);
      });
    }
    it('disabled client', () => flip('client', async () => { await ex(sup, 'UPDATE oauth_clients SET disabled_at = now() WHERE client_id=$1', [CLIENT]); }, async () => { await ex(sup, 'UPDATE oauth_clients SET disabled_at = NULL WHERE client_id=$1', [CLIENT]); }));
    it('deactivated user', () => flip('inactive', async () => { await ex(sup, 'UPDATE users SET active=false WHERE id=$1', [userA]); }, async () => { await ex(sup, 'UPDATE users SET active=true WHERE id=$1', [userA]); }));
    it('user demoted to role user', () => flip('demoted', async () => { await ex(sup, `UPDATE users SET role='user' WHERE id=$1`, [userA]); }, async () => { await ex(sup, `UPDATE users SET role='admin' WHERE id=$1`, [userA]); }));
    it('user without team', () => flip('noteam', async () => { await ex(sup, 'UPDATE users SET team_id=NULL WHERE id=$1', [userA]); }, async () => { await ex(sup, 'UPDATE users SET team_id=$2 WHERE id=$1', [userA, T.A]); }));
  });

  describe('4. metadata only', () => {
    it('no canary appears in any row of any function, and column names are clean', async () => {
      const results: Record<string, unknown[]> = {
        list_developers: await listDevs(hA), developer_activity: await activity(hA, memberA1), list_sessions: await listSess(hA),
        session_details: await details(hA, sessionIds.A[0]), search_prompt_metadata: await search(hA), prompt_metadata_batch: await batch(hA, promptIds.A.slice(0, 20)),
      };
      const bad = /text|label|events|path|agent|project/i;
      for (const [fn, rows] of Object.entries(results)) {
        assert.ok(rows.length > 0, `${fn} returned rows`);
        const json = JSON.stringify(rows);
        for (const c of Object.values(CANARY)) assert.equal(json.includes(c), false, `${fn} leaks ${c.slice(0, 12)}`);
        assert.equal(/CANARY_/.test(json), false);
        for (const col of Object.keys(rows[0] as object)) { if (/^has_(file_path|code_block|traceback)$/.test(col)) continue; assert.equal(bad.test(col), false, `${fn}.${col}`); } // has_* are boolean flags, not content
      }
      const intents = new Set(['bug_fix', 'feature', 'refactor', 'explain', 'test', 'other']);
      for (const r of [...(await search(hA)), ...(await search(hB)), ...(await batch(hA, promptIds.A.slice(0, 20)))]) assert.ok(intents.has(r.intent_category));
    });
    it('non-enum intent_category is mapped to other', async () => {
      await ex(sup, `UPDATE session_turns SET intent_category = $2 WHERE id = $1`, [promptIds.A[0], `FREE_TEXT_${RUN}`]);
      try {
        const rows = await batch(hA, [promptIds.A[0]]);
        assert.equal(rows[0].intent_category, 'other'); assert.equal(JSON.stringify(rows).includes('FREE_TEXT'), false);
      } finally { await ex(sup, `UPDATE session_turns SET intent_category='bug_fix' WHERE id=$1`, [promptIds.A[0]]); }
    });
  });

  describe('5. limits enforced in the database', () => {
    it('window over 7 days -> 22023 window_too_large', async () => {
      for (const f of [() => listSess(hA, { from: iso(9 * DAY), to: iso(0) }), () => activity(hA, memberA1, iso(9 * DAY), iso(0)), () => search(hA, { from: iso(8 * DAY), to: iso(0) })]) {
        const e = await err(f()); assert.equal(e.code, '22023'); assert.match(e.message, /mcp_data: window_too_large/);
      }
    });
    it('lookback: older than 14 days (7 for prompts) -> window_out_of_range', async () => {
      for (const f of [() => listSess(hA, { from: iso(16 * DAY), to: iso(15 * DAY) }), () => activity(hA, memberA1, iso(16 * DAY), iso(15 * DAY)), () => search(hA, { from: iso(9 * DAY), to: iso(8 * DAY) })]) {
        const e = await err(f()); assert.equal(e.code, '22023'); assert.match(e.message, /mcp_data: window_out_of_range/);
      }
      assert.equal((await err(listSess(hA, { from: iso(10 * DAY), to: iso(9 * DAY) }))).code, 'OK');
    });
    it('invalid / future windows -> 22023', async () => {
      assert.equal((await err(listSess(hA, { from: iso(1 * DAY), to: iso(2 * DAY) }))).code, '22023');
      assert.equal((await err(listSess(hA, { from: iso(0), to: new Date(Date.now() + DAY).toISOString() }))).code, '22023');
    });
    it('limit above 26 / 51 -> 54000; below 1 too', async () => {
      assert.equal((await err(listSess(hA, { limit: 27 }))).code, '54000');
      assert.equal((await err(search(hA, { limit: 27 }))).code, '54000');
      assert.equal((await err(listDevs(hA, 52))).code, '54000');
      assert.equal((await err(listDevs(hA, 0))).code, '54000');
      assert.equal((await err(listSess(hA, { limit: 0 }))).code, '54000');
      assert.equal((await err(listDevs(hA, 51))).code, 'OK');
    });
    it('batch of 21 / 0 ids -> 54000; 20 ok', async () => {
      assert.equal((await err(batch(hA, Array.from({ length: 21 }, (_, i) => i + 1)))).code, '54000');
      assert.equal((await err(batch(hA, []))).code, '54000');
      assert.equal((await err(batch(hA, Array.from({ length: 20 }, (_, i) => i + 1)))).code, 'OK');
      assert.equal((await err(batch(hA, [0]))).code, '22023');
    });
    it('non-identifier tool / model filters -> 22023; injection strings are rejected', async () => {
      const bad = [`x'; DROP TABLE users; --`, 'a b', 'a'.repeat(65), '', `CANARY'"\\`, 'x\ny', '%', '$(id)'];
      for (const s of bad) {
        assert.equal((await err(listSess(hA, { tool: s }))).code, '22023', `tool ${JSON.stringify(s).slice(0, 12)}`);
        assert.equal((await err(listSess(hA, { model: s }))).code, '22023');
        assert.equal((await err(search(hA, { tool: s }))).code, '22023');
        assert.equal((await err(search(hA, { model: s }))).code, '22023');
      }
      assert.equal((await sql('SELECT count(*)::int AS n FROM mcp_data.list_developers($1,50,NULL)', [hA]))[0].n, 3);
    });
    it('bad intents / char ranges / half cursors -> 22023', async () => {
      assert.equal((await err(search(hA, { intents: ['bug_fix', `evil'`] }))).code, '22023');
      assert.equal((await err(search(hA, { intents: [] }))).code, '22023');
      assert.equal((await err(listSess(hA, { afterTs: iso(0) }))).code, '22023');
      assert.equal((await err(search(hA, { afterId: 5 }))).code, '22023');
    });
    it('filters work: tool, intent', async () => {
      const codex = await listSess(hB, { tool: 'codex' }); assert.equal(codex.length, 5);
      assert.equal((await listSess(hA, { tool: 'codex' })).length, 0);
      const ex_ = await search(hB, { intents: ['explain'] }); assert.equal(ex_.length, 5);
    });
  });

  describe('6. errors never contain supplied values', () => {
    it('error messages are fixed strings', async () => {
      const val = `SUPPLIED_${RUN}`;
      const unknown = Buffer.from(sha(val));
      const msgs: string[] = [];
      msgs.push((await err(listDevs(unknown))).message);
      msgs.push((await err(listSess(hA, { tool: val + ' bad' }))).message);
      msgs.push((await err(search(hA, { model: val + "'" }))).message);
      msgs.push((await err(search(hA, { intents: [val] }))).message);
      msgs.push((await err(details(hA, uuid()))).message);
      msgs.push((await err(activity(hA, uuid()))).message);
      msgs.push((await err(batch(hA, [987654321, 0]))).message);
      msgs.push((await err(listSess(hA, { from: iso(20 * DAY), to: iso(19 * DAY) }))).message);
      const probeUuid = uuid();
      msgs.push((await err(details(hA, probeUuid))).message, (await err(activity(hA, probeUuid))).message);
      for (const m of msgs) {
        assert.match(m, /^mcp_data: [a-z_]+$/, m);
        assert.equal(m.includes(val), false); assert.equal(m.includes(probeUuid), false); assert.equal(m.includes(unknown.toString('hex')), false);
        assert.equal(m.includes(RUN), false);
      }
    });
  });
});
