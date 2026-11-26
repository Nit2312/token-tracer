/**
 * P3-3: STATIC (no database, nothing executed) guarantees for the data-plane SQL: scripts/migrations/mcp-data.sql, mcp-data.grants.sql,
 * mcp-data.rollback.sql and the mcp_data_owner / mcp_reader entries of lib/mcp/grants.json.
 * These pin the structural properties a security review relies on. They cannot prove runtime behaviour: the live isolation fixture
 * (three teams with canaries, role matrix, revocation, injection) is P3-4, on a fresh test branch, after the SQL has been reviewed.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadModule, parseSync, parsePlPgSQLSync } from 'libpg-query';
import { PAGE_SIZES, BATCH_MAX, MAX_LOOKBACK_DAYS, MAX_WINDOW_DAYS, SOURCE_RETENTION_DAYS, FUTURE_SKEW_MS } from '../lib/mcp/data/limits';
import { INTENT_CATEGORIES } from '../lib/mcp/data/output';
import { MCP_EXCLUDED_TABLES, MCP_NEVER_EXPOSED_COLUMNS, isMcpColumnAllowed } from '../lib/team/mcp-policy';

const root = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');
const MIG_RAW = read('scripts/migrations/mcp-data.sql'), GRANT_RAW = read('scripts/migrations/mcp-data.grants.sql'), ROLL_RAW = read('scripts/migrations/mcp-data.rollback.sql');
const MIG = strip(MIG_RAW), GRANT = strip(GRANT_RAW), ROLL = strip(ROLL_RAW);
const ALL_GRANTS = JSON.parse(read('lib/mcp/grants.json'));
const OWNER = ALL_GRANTS.mcp_data_owner as { select: Record<string, string[]>; ownsFunctions: string[]; ownsSchema: string; schemaUsage: string[] };
const READER = ALL_GRANTS.mcp_reader as { functions: string[]; select: object; insert: object; update: object; sequences: string[]; schemaUsage: string[]; roleSettings: Record<string, string>; connectionLimit: number; login: boolean };
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parser nodes are inspected structurally
type Node = any;

interface Fn { name: string; args: string; sig: string; body: string; full: string; callable: boolean; definer: boolean; returns: string[] }
const normArgs = (a: string) => a.split(',').map((x) => x.trim().replace(/^p(?:_\w+)?\s+/, '').replace(/\s+/g, ' ')).filter(Boolean).join(', ');
function functions(): Fn[] {
  const out: Fn[] = [];
  const parts = MIG.split(/CREATE OR REPLACE FUNCTION /).slice(1);
  for (const p of parts) {
    const full = p.slice(0, p.indexOf('$$;', p.indexOf('$$') + 2) + 3);
    const m = /^(mcp_data\.\w+)\(([\s\S]*?)\)\s*(?:RETURNS|LANGUAGE)/.exec(full)!;
    const args = m[2];
    const ret = /RETURNS TABLE \(([\s\S]*?)\)\s*LANGUAGE/.exec(full);
    out.push({
      name: m[1], args, sig: `${m[1]}(${normArgs(args)})`, full, body: full.slice(full.indexOf('$$') + 2, full.lastIndexOf('$$')),
      callable: !m[1].startsWith('mcp_data._'), definer: /SECURITY DEFINER/.test(full),
      returns: ret ? ret[1].split(',').map((c) => c.trim().split(/\s+/)[0]) : [],
    });
  }
  return out;
}
let FNS: Fn[] = [];
before(async () => { await loadModule(); FNS = functions(); });

describe('the SQL parses with the real PostgreSQL parser (nothing is executed)', () => {
  it('migration, grants and rollback parse, including every plpgsql body', () => {
    for (const [n, s] of [['migration', MIG_RAW], ['grants', GRANT_RAW], ['rollback', ROLL_RAW]]) assert.ok((parseSync(s).stmts ?? []).length > 10, n);
    const stmts = (parseSync(MIG_RAW).stmts ?? []).map((s: Node) => s.stmt).filter((s: Node) => s.CreateFunctionStmt);
    assert.equal(stmts.length, 13);
    for (const f of FNS.filter((x) => /LANGUAGE plpgsql/.test(x.full))) assert.ok((parsePlPgSQLSync(`CREATE FUNCTION ${f.full.replace(/\$\$[\s\S]*$/, '')}$$${f.body}$$;`) as Node).plpgsql_funcs.length === 1, f.name);
  });
  it('the migration defines exactly 13 functions: 6 reader-callable (SECURITY DEFINER) and 7 internal helpers', () => {
    assert.equal(FNS.length, 13);
    assert.deepEqual(FNS.filter((f) => f.callable).map((f) => f.name).sort(), ['mcp_data.developer_activity', 'mcp_data.list_developers', 'mcp_data.list_sessions', 'mcp_data.prompt_metadata_batch', 'mcp_data.search_prompt_metadata', 'mcp_data.session_details']);
    assert.ok(FNS.filter((f) => f.callable).every((f) => f.definer), 'every reader function is SECURITY DEFINER');
    assert.ok(FNS.filter((f) => !f.callable).every((f) => !f.definer), 'helpers are not SECURITY DEFINER and are not callable by the reader');
  });
});

describe('the migration is additive and does nothing outside its own schema', () => {
  it('creates no table, index, extension, trigger or sequence; alters and drops nothing; writes no data', () => {
    for (const re of [/\bCREATE\s+(UNLOGGED\s+|TEMP\w*\s+)?TABLE\b/i, /\bCREATE\s+(UNIQUE\s+)?INDEX\b/i, /\bCREATE\s+EXTENSION\b/i, /\bCREATE\s+TRIGGER\b/i, /\bCREATE\s+SEQUENCE\b/i, /\bALTER\s+TABLE\b/i,
      /\bDROP\b/i, /\bTRUNCATE\b/i, /\bINSERT\b/i, /\bUPDATE\s+\w/i, /\bDELETE\b/i, /\bCOPY\b/i, /\bCOMMENT\s+ON\b/i, /\bBEGIN\s*;/i, /\bCOMMIT\b/i, /\bROLLBACK\b/i]) assert.doesNotMatch(MIG, re, String(re));
  });
  it('no index is created (decision 5: measure first, on a production-sized copy)', () => { assert.doesNotMatch(MIG + GRANT + ROLL, /\bCREATE\s+(UNIQUE\s+)?INDEX\b/i); });
  it('the only privilege statement besides REVOKE FROM PUBLIC is the single role-membership grant the ownership transfer needs', () => {
    assert.deepEqual([...MIG.matchAll(/\bGRANT\b[^;]*;/gi)].map((m) => m[0].replace(/\s+/g, ' ')), ['GRANT mcp_data_owner TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;']);
  });
  it('requires PostgreSQL 16, the prerequisite tables, and every column the functions read, before creating anything', () => {
    assert.match(MIG, /server_version_num'\)::int < 160000/);
    for (const t of ['oauth_tokens', 'oauth_clients', 'users', 'teams', 'members', 'team_members', 'sync_sessions', 'sync_session_tools', 'session_turns', 'daily_member_usage']) assert.ok(MIG.includes(`to_regclass('public.${t}')`) || MIG.includes(`('${t}',`), t);
    assert.ok(MIG.indexOf('unexpected shape') < MIG.indexOf('CREATE ROLE') && MIG.indexOf('CREATE ROLE') < MIG.indexOf('CREATE SCHEMA') && MIG.indexOf('CREATE SCHEMA') < MIG.indexOf('SET LOCAL ROLE') && MIG.indexOf('SET LOCAL ROLE') < MIG.indexOf('CREATE OR REPLACE FUNCTION'));
  });
  it('the owner role is NOLOGIN with no attributes, and the functions are created and privileged AS that role, then the role is reset', () => {
    assert.match(MIG, /CREATE ROLE mcp_data_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;/);
    assert.doesNotMatch(MIG, /PASSWORD/i);
    assert.match(MIG, /CREATE SCHEMA IF NOT EXISTS mcp_data AUTHORIZATION mcp_data_owner;/);
    assert.match(MIG, /REVOKE ALL ON SCHEMA mcp_data FROM PUBLIC;/);
    assert.ok(MIG.trimEnd().endsWith('RESET ROLE;'));
    assert.ok(MIG.lastIndexOf('REVOKE ALL ON FUNCTION') < MIG.lastIndexOf('RESET ROLE'), 'the REVOKEs run as the owner');
  });
  it('every function is revoked from PUBLIC and the set matches grants.json exactly', () => {
    const revoked = [...MIG.matchAll(/REVOKE ALL ON FUNCTION (mcp_data\.\w+)\(([^)]*)\) FROM PUBLIC;/g)].map((m) => `${m[1]}(${normArgs(m[2])})`).sort();
    assert.deepEqual(revoked, FNS.map((f) => f.sig).sort());
    assert.deepEqual(OWNER.ownsFunctions.map((s) => s.replace(/\s+/g, ' ')).sort(), FNS.map((f) => f.sig).sort());
    assert.equal(OWNER.ownsSchema, 'mcp_data');
  });
});

describe('function hygiene (SECURITY DEFINER safety)', () => {
  it('every function pins search_path to pg_catalog, pg_temp and has an explicit volatility; nothing is VOLATILE', () => {
    for (const f of FNS) { assert.match(f.full, /SET search_path = pg_catalog, pg_temp/, f.name); assert.match(f.full, /\b(STABLE|IMMUTABLE)\b/, f.name); assert.doesNotMatch(f.full, /\bVOLATILE\b/, f.name); }
  });
  it('no dynamic SQL anywhere in the three files', () => {
    const noGrantWord = (s: string) => s.replace(/(GRANT|REVOKE)\s+EXECUTE\s+ON/gi, '');
    for (const s of [MIG, GRANT, ROLL]) { assert.doesNotMatch(noGrantWord(s), /\bEXECUTE\b/i); assert.doesNotMatch(s, /\bformat\s*\(|\bquote_ident|\bquote_literal/i); }
  });
  it('every table reference is schema-qualified (public. or mcp_data.), so nothing resolves through a search path', () => {
    for (const f of FNS) for (const m of f.body.matchAll(/\b(?:FROM|JOIN)\s+(?:LATERAL\s+)?([A-Za-z_(][\w.]*)/g)) if (!m[1].startsWith('(')) assert.match(m[1], /^(public|mcp_data|pg_catalog)\./, `${f.name}: ${m[0]}`);
  });
  it('no write, no temp table, no sequence, no extension function, no pg_sleep inside any function body', () => {
    for (const f of FNS) assert.doesNotMatch(f.body, /\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|COPY|LOCK|NOTIFY|LISTEN|SET\s+LOCAL|set_config|nextval|pg_sleep|dblink|lo_\w+|pg_read_\w+)\b/i, f.name);
  });
  it('plain SQL is used only by IMMUTABLE leaf helpers; everything that raises or reads tables is plpgsql', () => {
    for (const f of FNS) if (/LANGUAGE sql/.test(f.full)) { assert.match(f.full, /IMMUTABLE/); assert.doesNotMatch(f.body, /public\./); }
  });
  it('every plpgsql function that returns a table uses column-wins conflict resolution and qualifies columns', () => {
    for (const f of FNS.filter((x) => x.returns.length)) assert.match(f.body, /#variable_conflict use_column/, f.name);
  });
});

describe('tenant isolation is derived in the database from the token hash', () => {
  it('every reader function takes the token hash first and has NO team, org, tenant or user-identity parameter', () => {
    for (const f of FNS.filter((x) => x.callable)) {
      assert.match(f.args.trim(), /^p_token bytea\b/, f.name);
      assert.doesNotMatch(f.args, /\bp_(team|org|tenant|user|owner|admin|role|scope)\w*/i, `${f.name} must not accept an identity: ${f.args.slice(0, 80)}`);
      assert.match(f.body, /FROM mcp_data\._resolve_scope\(p_token\)/, `${f.name} derives the scope`);
      assert.ok(f.body.indexOf('_resolve_scope') < f.body.search(/RETURN QUERY|PERFORM|IF /), `${f.name}: the scope is resolved before anything else`);
    }
  });
  it('only _resolve_scope touches the OAuth tables, and its predicate matches bearer authentication', () => {
    for (const f of FNS) if (f.name !== 'mcp_data._resolve_scope') assert.doesNotMatch(f.body, /oauth_tokens|oauth_clients|public\.users/, f.name);
    const scope = FNS.find((f) => f.name === 'mcp_data._resolve_scope')!.body.replace(/\s+/g, ' ');
    const ts = read('lib/mcp/oauth/tokens.ts');
    assert.match(ts, /const ELIGIBLE_USER_SQL = `\(u\.active AND u\.role = 'admin' AND EXISTS \(SELECT 1 FROM teams tm WHERE tm\.id = u\.team_id\)\)`;/);
    for (const clause of ["u.active AND u.role = 'admin' AND EXISTS (SELECT 1 FROM public.teams tm WHERE tm.id = u.team_id)", "t.kind = 'access'", 't.revoked_at IS NULL', 't.expires_at > pg_catalog.now()', 't.absolute_expires_at > pg_catalog.now()', 'c.disabled_at IS NULL', 't.token_hash = p_token'])
      assert.ok(scope.includes(clause), `the scope predicate must contain: ${clause}`);
    assert.match(ts, /t\.kind = 'access' AND t\.revoked_at IS NULL AND t\.expires_at > now\(\) AND t\.absolute_expires_at > now\(\)/); // the TypeScript side still says the same
    assert.ok(scope.includes("octet_length(p_token) <> 32") && /RAISE EXCEPTION 'mcp_data: unauthorized'/.test(scope));
  });
  it('every query on a team-scoped table carries the team predicate, and sessions/prompts also require CURRENT team membership', () => {
    for (const f of FNS) {
      const b = f.body.replace(/\s+/g, ' ');
      if (b.includes('public.sync_sessions')) assert.match(b, /s\.team_id = p_team/, f.name);
      if (b.includes('public.session_turns')) { assert.match(b, /st\.org_id = p_team::text/, f.name); assert.match(b, /ss\.team_id = p_team/, f.name); assert.match(b, /ss\.session_id = st\.session_id AND st\.org_id = ss\.team_id::text AND st\.user_id = ss\.member_id::text AND st\.tool = ss\.source/, `${f.name}: the full 4-key identity`); }
      if (b.includes('public.daily_member_usage')) assert.match(b, /d\.team_id = v_team AND d\.member_id = p_member/, f.name);
      if (b.includes('public.team_members')) assert.match(b, /tm\.team_id = (v_team|p_team)/, f.name);
      if (/public\.(sync_sessions|session_turns)/.test(b)) assert.match(b, /EXISTS \(SELECT 1 FROM public\.team_members tm WHERE tm\.team_id = p_team AND tm\.member_id = (s|ss)\.member_id\)/, `${f.name}: current membership`);
    }
  });
  it('the internal row functions take a team id, but they are not callable by the reader and are only called with the derived team', () => {
    const internal = FNS.filter((f) => !f.callable && /\bp_team\b/.test(f.args)).map((f) => f.name).sort();
    assert.deepEqual(internal, ['mcp_data._prompt_rows', 'mcp_data._session_rows']);
    for (const f of FNS.filter((x) => x.callable)) for (const m of f.body.matchAll(/mcp_data\._(session|prompt)_rows\(\s*(\w+)/g)) assert.equal(m[2], 'v_team', `${f.name} must pass only the derived team`);
    for (const g of READER.functions) assert.doesNotMatch(g, /_session_rows|_prompt_rows|_resolve_scope/);
  });
  it('another team, a non-member and a missing row are indistinguishable: fixed error messages, no value in any message', () => {
    const msgs = [...MIG.matchAll(/RAISE EXCEPTION '([^']*)'/g)].map((m) => m[1]);
    assert.ok(msgs.length >= 15);
    const allowed = new Set(['mcp_data: unauthorized', 'mcp_data: not_found', 'mcp_data: invalid_argument', 'mcp_data: window_too_large', 'mcp_data: window_out_of_range', 'mcp_data: limit_exceeded']);
    const inBodies = FNS.flatMap((f) => [...f.body.matchAll(/RAISE EXCEPTION '([^']*)'/g)].map((m) => m[1]));
    assert.ok(inBodies.length >= 20 && inBodies.every((m) => allowed.has(m)), 'function bodies raise only the six fixed messages');
    for (const f of FNS) assert.doesNotMatch(f.body, /RAISE EXCEPTION[^;]*%/, `${f.name}: no interpolated message`);
    const codes = Object.fromEntries(FNS.flatMap((f) => [...f.body.matchAll(/RAISE EXCEPTION '(mcp_data: \w+)' USING ERRCODE = '(\w+)'/g)].map((m) => [m[1], m[2]])));
    assert.deepEqual(codes, { 'mcp_data: unauthorized': '28000', 'mcp_data: invalid_argument': '22023', 'mcp_data: window_too_large': '22023', 'mcp_data: window_out_of_range': '22023', 'mcp_data: limit_exceeded': '54000', 'mcp_data: not_found': 'P0002' });
  });
  it('the details function treats a non-member or out-of-lookback session as not found, never as an empty success', () => {
    const d = FNS.find((f) => f.name === 'mcp_data.session_details')!.body.replace(/\s+/g, ' ');
    assert.match(d, /IF NOT FOUND THEN RAISE EXCEPTION 'mcp_data: not_found'/);
    assert.match(d, /now\(\) - interval '14 days'/);
  });
});

describe('metadata only: no prompt text, no label, no events, no path, no credential — in any file', () => {
  const FORBIDDEN = ['prompt_text_sanitized', 'label', 'events', 'payload_hash', 'agent', 'project', 'path', 'file_path', 'sync_session_files', 'daily_member_files', 'password_hash', 'username', 'api_key', 'member_keys', 'key_hash', 'audit_log', 'prompt_embeddings', 'redundant_reprompt_events',
    'session_outcomes', 'session_tool_errors', 'tool_args_summary', 'daily_org_usage', 'daily_pipeline_health', 'daily_behavior_rollup', 'ingest_events'];
  it('no forbidden table, column or word appears in the migration, the grants or the rollback code', () => {
    for (const [n, s] of [['migration', MIG], ['grants', GRANT], ['rollback', ROLL]] as const) for (const w of FORBIDDEN) assert.doesNotMatch(s, new RegExp(`\\b${w}\\b`, 'i'), `${n} mentions ${w}`);
  });
  it('no function parameter or returned column can carry text: no search term, no snippet, no free string except short-identifier filters', () => {
    for (const f of FNS) {
      assert.doesNotMatch(f.args, /\bp_(query|search|text|term|keyword|contains|like|pattern|q|prompt|content|snippet|filter)\b/i, f.name);
      for (const c of f.returns) assert.doesNotMatch(c.replace(/^has_file_path$/, 'has_flag'), /text|snippet|excerpt|preview|content|body|message|label|events?$|path|prompt$/i, `${f.name} returns ${c}`);
    }
    const stringParams = FNS.filter((f) => f.callable).flatMap((f) => [...f.args.matchAll(/(p_\w+)\s+text(\[\])?/g)].map((m) => `${f.name}.${m[1]}`));
    assert.deepEqual(stringParams.sort(), ['mcp_data.list_sessions.p_model', 'mcp_data.list_sessions.p_tool', 'mcp_data.search_prompt_metadata.p_intents', 'mcp_data.search_prompt_metadata.p_model', 'mcp_data.search_prompt_metadata.p_tool']);
    for (const f of FNS.filter((x) => x.callable)) for (const p of ['p_tool', 'p_model']) if (f.args.includes(p)) assert.match(f.body, new RegExp(`${p} IS NOT NULL AND mcp_data\\._safe_ident\\(${p}\\) IS NULL`), `${f.name} validates ${p} as a short identifier`);
    assert.match(FNS.find((f) => f.name === 'mcp_data.search_prompt_metadata')!.body, /p_intents <@ ARRAY\['bug_fix','feature','refactor','explain','test','other'\]/);
  });
  it('free-text columns pass only through closed mappings: intent -> closed enum, tool/model/tool_name -> short identifier or NULL/unknown', () => {
    assert.deepEqual([...MIG.matchAll(/ARRAY\['bug_fix'[^\]]*\]/g)].map((m) => m[0]).filter((x, i, a) => a.indexOf(x) === i), [`ARRAY['${INTENT_CATEGORIES.join("','")}']`]);
    const prompt = FNS.find((f) => f.name === 'mcp_data._prompt_rows')!.body;
    assert.match(prompt, /mcp_data\._norm_intent\(st\.intent_category\),/);
    assert.doesNotMatch(prompt.replace(/mcp_data\._norm_intent\(st\.intent_category\)/g, ''), /st\.intent_category\s*[,)]\s*$/m);
    assert.match(prompt, /COALESCE\(mcp_data\._safe_ident\(st\.tool\), 'unknown'\), mcp_data\._safe_ident\(st\.model\)/);
    const safe = FNS.find((f) => f.name === 'mcp_data._safe_ident')!.body;
    assert.match(safe, /'\^\[A-Za-z0-9_\.:\+\/@-\]\{1,64\}\$'/);
  });
  it('the SQL identifier pattern is the TypeScript one, and timestamps use the exact ISO shape the contract validates', () => {
    const ts = read('lib/mcp/data/output.ts');
    assert.ok(ts.includes('/^[A-Za-z0-9_.:+\\/@-]{1,64}$/'));
    assert.match(MIG, /'YYYY-MM-DD"T"HH24:MI:SS\.MS"Z"'/);
  });
  it('the owner role is granted COLUMNS (never a whole table), and none of the forbidden ones', () => {
    assert.ok(Object.keys(OWNER.select).length === 10);
    for (const line of GRANT.match(/GRANT SELECT[^;]*;/g) ?? []) assert.match(line, /^GRANT SELECT \([a-z_, ]+\) ON public\.\w+ TO mcp_data_owner;$/, line);
    for (const [t, cols] of Object.entries(OWNER.select)) for (const c of cols) assert.ok(!FORBIDDEN.includes(c), `${t}.${c}`);
    assert.ok(!OWNER.select.session_turns.includes('prompt_text_sanitized') && !OWNER.select.sync_sessions.some((c) => ['label', 'events', 'agent', 'payload_hash'].includes(c)) && !OWNER.select.daily_member_usage.includes('project'));
  });
  it('the owner grants agree with the application-side column policy on every DATA table', () => {
    for (const t of ['sync_sessions', 'sync_session_tools', 'session_turns', 'daily_member_usage', 'members', 'team_members', 'teams']) for (const c of OWNER.select[t]) assert.equal(isMcpColumnAllowed(t, c), true, `${t}.${c} is granted but the policy forbids it`);
    for (const t of Object.keys(OWNER.select)) assert.ok(!MCP_EXCLUDED_TABLES.includes(t), t);
    for (const [t, cols] of Object.entries(MCP_NEVER_EXPOSED_COLUMNS)) for (const c of cols) assert.ok(!(OWNER.select[t] ?? []).includes(c), `${t}.${c}`);
  });
  it('every column a function reads is granted to the owner role (and a column that is not granted is never read)', () => {
    for (const f of FNS) {
      const alias = new Map<string, string>();
      for (const m of f.body.matchAll(/\b(?:FROM|JOIN)\s+public\.(\w+)\s+(?:AS\s+)?(\w+)/g)) alias.set(m[2], m[1]);
      for (const [a, table] of alias) {
        assert.ok(OWNER.select[table], `${f.name}: ${table} has no grant`);
        for (const m of f.body.matchAll(new RegExp(`\\b${a}\\.(\\w+)\\b`, 'g'))) assert.ok(OWNER.select[table].includes(m[1]), `${f.name}: ${a}.${m[1]} (${table}.${m[1]}) is read but not granted`);
      }
    }
    for (const [table, cols] of Object.entries(OWNER.select)) for (const c of cols) {
      const used = FNS.some((f) => { const aliases = [...f.body.matchAll(new RegExp(`\\b(?:FROM|JOIN)\\s+public\\.${table}\\s+(?:AS\\s+)?(\\w+)`, 'g'))].map((m) => m[1]); return aliases.some((a) => new RegExp(`\\b${a}\\.${c}\\b`).test(f.body)); });
      assert.ok(used, `${table}.${c} is granted but no function reads it (grant is wider than needed)`);
    }
  });
  it('the columns the TypeScript projections read are exactly the columns the SQL returns', () => {
    const src = read('lib/mcp/data/output.ts');
    const reads = (fn: string) => { const s = src.slice(src.indexOf(`export function ${fn}`)); return new Set([...s.slice(0, s.indexOf('\n}\n')).matchAll(/\br\.([a-z_]+)\b/g)].map((m) => m[1])); };
    const ret = (n: string) => new Set(FNS.find((f) => f.name === n)!.returns);
    const sub = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x));
    assert.deepEqual(sub(reads('toDeveloperSummary'), ret('mcp_data.list_developers')), []);
    assert.deepEqual(sub(reads('toDailyActivity'), ret('mcp_data.developer_activity')), []);
    assert.deepEqual(sub(reads('toSessionSummary'), ret('mcp_data.list_sessions')), []);
    assert.deepEqual(sub(reads('toSessionSummary'), ret('mcp_data.session_details')), []);
    assert.deepEqual(sub(reads('toPromptMetadata'), ret('mcp_data.search_prompt_metadata')), []);
    assert.deepEqual(sub(reads('toPromptMetadata'), ret('mcp_data.prompt_metadata_batch')), []);
    assert.deepEqual(sub(ret('mcp_data.search_prompt_metadata'), reads('toPromptMetadata')), [], 'the search returns nothing the contract does not use');
    assert.deepEqual(sub(ret('mcp_data.list_sessions'), new Set([...reads('toSessionSummary'), 'activity_at'])), []);
  });
});

describe('limits are enforced in the database as well, and equal the TypeScript constants', () => {
  const body = (n: string) => FNS.find((f) => f.name === n)!.body.replace(/\s+/g, ' ');
  it('window span, skew and lookback', () => {
    const w = body('mcp_data._check_window');
    assert.equal(MAX_WINDOW_DAYS, 7); assert.ok(w.includes(`p_to - p_from > interval '${MAX_WINDOW_DAYS} days'`));
    assert.ok(w.includes(`interval '${FUTURE_SKEW_MS / 60000} minutes'`));
    assert.ok(w.includes('p_from < pg_catalog.now() - p_lookback'));
    assert.ok(w.indexOf('invalid_argument') < w.indexOf('window_too_large') && w.indexOf('window_too_large') < w.indexOf('window_out_of_range'), 'same order as time-window.ts');
    assert.equal(MAX_LOOKBACK_DAYS, 14);
    assert.ok(body('mcp_data.developer_activity').includes(`_check_window(p_from, p_to, interval '${Math.min(MAX_LOOKBACK_DAYS, SOURCE_RETENTION_DAYS.activity)} days')`));
    assert.ok(body('mcp_data.list_sessions').includes(`_check_window(p_from, p_to, interval '${Math.min(MAX_LOOKBACK_DAYS, SOURCE_RETENTION_DAYS.sessions)} days')`));
    assert.ok(body('mcp_data.search_prompt_metadata').includes(`_check_window(p_from, p_to, interval '${Math.min(MAX_LOOKBACK_DAYS, SOURCE_RETENTION_DAYS.prompts)} days')`));
    assert.ok(body('mcp_data.prompt_metadata_batch').includes(`now() - interval '${SOURCE_RETENTION_DAYS.prompts} days'`));
    assert.ok(body('mcp_data.session_details').includes(`now() - interval '${SOURCE_RETENTION_DAYS.sessions} days'`));
  });
  it('page sizes (max + 1 for the next-page probe) and batch', () => {
    assert.ok(body('mcp_data.list_developers').includes(`p_limit > ${PAGE_SIZES.developers.max + 1}`));
    assert.ok(body('mcp_data.list_sessions').includes(`p_limit > ${PAGE_SIZES.sessions.max + 1}`));
    assert.ok(body('mcp_data.search_prompt_metadata').includes(`p_limit > ${PAGE_SIZES.prompts.max + 1}`));
    assert.ok(body('mcp_data.prompt_metadata_batch').includes(`NOT BETWEEN 1 AND ${BATCH_MAX}`));
    assert.ok(body('mcp_data.session_details').includes('LIMIT 100'));
  });
  it('keyset pagination is total and stable: ordered by (time truncated to ms, id) with the same expression in the cursor comparison', () => {
    for (const n of ['mcp_data._session_rows', 'mcp_data._prompt_rows']) {
      const b = body(n);
      const ex = n.endsWith('session_rows') ? "date_trunc('milliseconds', COALESCE(s.ended_at, s.started_at, s.synced_at))" : "date_trunc('milliseconds', st.created_at)";
      assert.ok(b.includes(`(pg_catalog.${ex}, ${n.endsWith('session_rows') ? 's' : 'st'}.id) < (p_after_ts, p_after_id)`), n);
      assert.ok(b.includes(`ORDER BY pg_catalog.${ex} DESC, ${n.endsWith('session_rows') ? 's' : 'st'}.id DESC`), n);
    }
    assert.ok(body('mcp_data.search_prompt_metadata').includes('(p_after_ts IS NULL) <> (p_after_id IS NULL)'));
  });
  it('prompt rows are USER turns only, one answering turn at most (no duplicate rows), and the text column is never named', () => {
    const b = body('mcp_data._prompt_rows');
    assert.ok(b.includes("st.turn_role = 'user'") && b.includes("x.turn_role = 'assistant'") && b.includes('ORDER BY x.id LIMIT 1'));
    assert.doesNotMatch(b, /prompt_text/);
  });
});

describe('grants file', () => {
  it('is exactly what lib/mcp/grants.json says (no drift between the two)', () => {
    const lines = GRANT.split('\n').map((l) => l.trim()).filter((l) => /^(GRANT|REVOKE|ALTER ROLE)/.test(l));
    const expected: string[] = [];
    for (const role of ['mcp_data_owner', 'mcp_reader']) expected.push(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role};`, `REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${role};`, `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${role};`, `REVOKE ALL ON SCHEMA public FROM ${role};`);
    expected.push('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA mcp_data FROM mcp_reader;', 'REVOKE ALL ON SCHEMA mcp_data FROM mcp_reader;');
    for (const s of OWNER.schemaUsage) expected.push(`GRANT USAGE ON SCHEMA ${s} TO mcp_data_owner;`);
    for (const [t, cols] of Object.entries(OWNER.select)) expected.push(`GRANT SELECT (${cols.join(', ')}) ON public.${t} TO mcp_data_owner;`);
    for (const s of READER.schemaUsage) expected.push(`GRANT USAGE ON SCHEMA ${s} TO mcp_reader;`);
    for (const f of READER.functions) expected.push(`GRANT EXECUTE ON FUNCTION ${f} TO mcp_reader;`);
    expected.push(`ALTER ROLE mcp_reader CONNECTION LIMIT ${READER.connectionLimit};`);
    for (const [k, v] of Object.entries(READER.roleSettings)) expected.push(`ALTER ROLE mcp_reader SET ${k} = ${/^\d+$/.test(v) || v === 'on' ? v : `'${v}'`};`);
    assert.deepEqual(lines, expected);
  });
  it('the reader holds NO table, column, sequence or other privilege: only schema USAGE and EXECUTE on exactly the six functions', () => {
    const forReader = (GRANT.match(/GRANT [^;]*TO mcp_reader;/g) ?? []);
    assert.equal(forReader.length, 7);
    for (const g of forReader) assert.match(g, /^GRANT (USAGE ON SCHEMA mcp_data|EXECUTE ON FUNCTION mcp_data\.\w+\([^)]*\)) TO mcp_reader;$/);
    assert.deepEqual(READER.select, {}); assert.deepEqual(READER.insert, {}); assert.deepEqual(READER.update, {}); assert.deepEqual(READER.sequences, []);
    assert.deepEqual(READER.functions.map((s) => s.replace(/\s+/g, ' ')).sort(), FNS.filter((f) => f.callable).map((f) => f.sig).sort());
  });
  it('no write privilege, no ALL PRIVILEGES, no grant option, no PUBLIC grant, no role membership in the grants file', () => {
    for (const re of [/GRANT\s+(INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|ALL)\b/i, /WITH GRANT OPTION/i, /TO PUBLIC/i, /GRANT\s+\w+\s+TO\s+\w+\s*;/i, /\bCREATE\b/i, /\bSUPERUSER\b|\bBYPASSRLS\b/i, /\bPASSWORD\b/i, /\bLOGIN\b/i]) assert.doesNotMatch(GRANT.replace(/NOLOGIN/g, ''), re, String(re));
  });
  it('the reader role is read-only by default, has hard timeouts, a pinned search_path and a connection limit', () => {
    assert.deepEqual(READER.roleSettings, { statement_timeout: '5000', lock_timeout: '2000', idle_in_transaction_session_timeout: '10000', search_path: 'pg_catalog, pg_temp', default_transaction_read_only: 'on' });
    assert.ok(READER.login === true && READER.connectionLimit >= 1 && READER.connectionLimit <= 5);
  });
  it('the existing mcp_auth entry is untouched and the role script does not read the new entries yet', () => {
    const auth = ALL_GRANTS.mcp_auth; assert.deepEqual(Object.keys(auth).sort(), ['functions', 'insert', 'select', 'sequences', 'update']);
    assert.ok(!('mcp_data_owner' in auth) && !JSON.stringify(auth).includes('mcp_data'));
    const script = read('scripts/setup-mcp-roles.mjs'); assert.ok(!script.includes('mcp_reader') || script.includes('NOT created here')); assert.doesNotMatch(script, /mcp_data_owner|mcp-data/);
  });
  it('does not mention any password, URL or credential', () => { for (const s of [MIG_RAW, GRANT_RAW, ROLL_RAW]) assert.doesNotMatch(s, /postgres(ql)?:\/\/|PASSWORD\s+'/i); for (const s of [MIG, GRANT, ROLL]) assert.doesNotMatch(s, /secret|token_value|plaintext/i); });
});

describe('rollback', () => {
  it('drops exactly the thirteen functions, the schema and the two roles; no CASCADE, no table, no data', () => {
    const dropped = [...ROLL.matchAll(/DROP FUNCTION IF EXISTS (mcp_data\.\w+)\(([^)]*)\);/g)].map((m) => `${m[1]}(${normArgs(m[2])})`).sort();
    assert.deepEqual(dropped, FNS.map((f) => f.sig).sort());
    assert.match(ROLL, /DROP SCHEMA IF EXISTS mcp_data;/); assert.match(ROLL, /DROP ROLE IF EXISTS mcp_reader;/); assert.match(ROLL, /DROP ROLE IF EXISTS mcp_data_owner;/);
    for (const re of [/\bCASCADE\b/i, /DROP\s+TABLE/i, /DELETE|TRUNCATE|UPDATE\s+\w|INSERT/i, /DROP\s+(DATABASE|SCHEMA\s+public)/i, /\bmcp_auth\b/i, /oauth_/i]) assert.doesNotMatch(ROLL, re, String(re));
  });
  it('order: reader loses access, functions go (reader functions before the helpers they call), then the schema, then the roles', () => {
    const at = (s: string) => ROLL.indexOf(s);
    assert.ok(at('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA mcp_data FROM mcp_reader') < at('DROP FUNCTION'));
    assert.ok(at('DROP FUNCTION IF EXISTS mcp_data.prompt_metadata_batch') < at('DROP FUNCTION IF EXISTS mcp_data._prompt_rows') && at('DROP FUNCTION IF EXISTS mcp_data._prompt_rows') < at('DROP FUNCTION IF EXISTS mcp_data._safe_ident'));
    assert.ok(at('DROP FUNCTION IF EXISTS mcp_data._safe_ident') < at('DROP SCHEMA') && at('DROP SCHEMA') < at('DROP ROLE IF EXISTS mcp_reader'));
  });
});

describe('nothing is wired up: the SQL is written, not applied', () => {
  const walk = (d: string): string[] => fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' || e.name === '.next' ? [] : e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
  it('no script, application file or package script references the data-plane SQL files, and no runner for them exists', () => {
    const refs = [...walk('scripts'), ...walk('app'), ...walk('lib'), 'package.json'].filter((f) => !f.startsWith('scripts/migrations/mcp-data') && /\.(m?js|cjs|ts|tsx|json)$/.test(f) && /mcp-data\.(sql|grants|rollback)|migrate-mcp-data|mcp_data\./.test(read(f)));
    assert.deepEqual(refs.filter((f) => f !== 'lib/mcp/grants.json'), []);
    assert.ok(!fs.existsSync(path.join(root, 'scripts/migrate-mcp-data.mjs')));
  });
  it('no application code names the mcp_reader role, the schema or the owner (the reader pool is P3-5)', () => {
    for (const f of [...walk('app'), ...walk('lib')].filter((x) => /\.(ts|tsx|mjs)$/.test(x) && !x.startsWith('lib/mcp/data/'))) assert.doesNotMatch(read(f), /mcp_data_owner|mcp_data\.|MCP_READER_DATABASE_URL/, f);
  });
  it('the SQL files never mention the masking engine or the text flag (metadata-only policy)', () => { for (const s of [MIG_RAW, GRANT_RAW, ROLL_RAW]) assert.doesNotMatch(s, /masking|MCP_PROMPT_TEXT_ENABLED|snippet/i); });
});
