import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSqlParser, MAX_SQL_LENGTH, SqlGuardError, validateSqlAst } from '../lib/admin/chat/sql-ast';
import { builtSql, REPORTS } from '../lib/admin/chat/tools';

const GRANTS = JSON.parse(fs.readFileSync('lib/admin/chat/analyst-grants.json', 'utf8')).tables as Record<string, string[]>;
const ok = (sql: string) => assert.doesNotThrow(() => validateSqlAst(sql, GRANTS), sql);
const bad = (sql: string, re?: RegExp) =>
  assert.throws(() => validateSqlAst(sql, GRANTS), (e) => e instanceof SqlGuardError && (!re || re.test(e.message)), sql);

before(async () => { await initSqlParser(); });

describe('valid queries', () => {
  const cases: Record<string, string> = {
    basic: 'SELECT id, name FROM teams LIMIT 5',
    star: 'SELECT * FROM model_context_limits',
    where: "SELECT id FROM members WHERE role = 'admin' AND team_id IS NOT NULL AND display_name ILIKE '%a%'",
    innerJoin: 'SELECT m.display_name, s.api_cost FROM sync_sessions s INNER JOIN members m ON m.id = s.member_id',
    leftJoin: 'SELECT t.name, m.id FROM teams t LEFT JOIN members m ON m.team_id = t.id',
    groupBy: 'SELECT model, COUNT(*) AS n, SUM(tokens_in) AS t, AVG(api_cost), MIN(started_at), MAX(ended_at) FROM sync_sessions GROUP BY model HAVING COUNT(*) > 2 ORDER BY n DESC LIMIT 10 OFFSET 5',
    distinct: 'SELECT DISTINCT model FROM sync_sessions',
    ctes: 'WITH a AS (SELECT member_id, SUM(api_cost) AS c FROM sync_sessions GROUP BY 1), b AS (SELECT id FROM members) SELECT * FROM a JOIN b ON b.id = a.member_id',
    nested: 'SELECT * FROM (SELECT member_id, COUNT(*) AS n FROM sync_sessions GROUP BY member_id) x WHERE x.n > (SELECT AVG(tool_calls) FROM sync_sessions)',
    exists: 'SELECT id FROM members m WHERE EXISTS (SELECT 1 FROM sync_sessions s WHERE s.member_id = m.id) AND NOT EXISTS (SELECT 1 FROM teams t WHERE t.id = m.team_id AND t.name = \'x\')',
    inList: "SELECT id FROM members WHERE role IN ('a','b') AND id NOT IN (SELECT member_id FROM sync_sessions) AND created_at BETWEEN NOW() - INTERVAL '7 days' AND NOW()",
    unionAll: 'SELECT id FROM members UNION ALL SELECT member_id FROM sync_sessions',
    caseWhen: "SELECT CASE WHEN tool_errors > 0 THEN 'bad' ELSE 'ok' END AS s, COALESCE(NULLIF(model,''),'default') FROM sync_sessions",
    dates: "SELECT date_trunc('day', started_at) d, EXTRACT(epoch FROM ended_at - started_at), to_char(started_at,'YYYY-MM'), started_at::date, CURRENT_DATE, age(NOW(), started_at), date_part('hour', started_at) FROM sync_sessions",
    window: 'SELECT member_id, ROW_NUMBER() OVER (PARTITION BY team_id ORDER BY api_cost DESC) rn, RANK() OVER (ORDER BY api_cost), DENSE_RANK() OVER (ORDER BY api_cost), LAG(api_cost) OVER (ORDER BY started_at), LEAD(api_cost,1) OVER (ORDER BY started_at) FROM sync_sessions',
    arithmetic: 'SELECT (tokens_in + tokens_out) * 2 / NULLIF(tool_calls,0) % 3, ROUND(api_cost::numeric, 2) FROM sync_sessions',
    publicQualified: 'SELECT s.model FROM public.sync_sessions s',
    trailingSemicolon: 'SELECT 1 FROM teams;',
  };
  for (const [name, sql] of Object.entries(cases)) it(name, () => ok(sql));
  for (const r of REPORTS) it(`prebuilt report ${r} passes the AST validator`, () => ok(builtSql(r, { days: 30, limit: 10 })!));
});

describe('rejected statements and constructs', () => {
  const cases: Array<[string, string, RegExp?]> = [
    ['delete', "DELETE FROM teams", /Only SELECT/],
    ['update', "UPDATE teams SET name='x'", /Only SELECT/],
    ['insert', "INSERT INTO teams(name) VALUES ('x')", /Only SELECT/],
    ['drop', 'DROP TABLE teams', /Only SELECT/],
    ['alter', 'ALTER TABLE teams ADD COLUMN x int', /Only SELECT/],
    ['truncate', 'TRUNCATE teams', /Only SELECT/],
    ['grant', 'GRANT ALL ON teams TO public', /Only SELECT/],
    ['copy', 'COPY teams TO PROGRAM \'x\'', /Only SELECT/],
    ['set', 'SET ROLE postgres', /Only SELECT/],
    ['reset', 'RESET ROLE', /Only SELECT/],
    ['do', "DO $$ BEGIN PERFORM 1; END $$", /Only SELECT/],
    ['call', 'CALL foo()', /Only SELECT/],
    ['prepare', 'PREPARE p AS SELECT 1', /Only SELECT/],
    ['execute', 'EXECUTE p', /Only SELECT/],
    ['explain', 'EXPLAIN ANALYZE DELETE FROM teams', /Only SELECT/],
    ['multi', 'SELECT 1 FROM teams; DROP TABLE teams', /single statement/],
    ['multi select', 'SELECT 1 FROM teams; SELECT 2 FROM teams', /single statement/],
    ['select into', 'SELECT * INTO newt FROM teams', /INTO/],
    ['for update', 'SELECT * FROM teams FOR UPDATE', /Locking/],
    ['for share', 'SELECT * FROM teams FOR SHARE', /Locking/],
    ['recursive cte', 'WITH RECURSIVE r AS (SELECT 1 AS n FROM teams UNION ALL SELECT n+1 FROM r) SELECT * FROM r', /Recursive/],
    ['modifying cte', 'WITH d AS (DELETE FROM teams RETURNING *) SELECT * FROM d'],
    ['union (distinct)', 'SELECT id FROM members UNION SELECT id FROM teams', /UNION ALL/],
    ['intersect', 'SELECT id FROM members INTERSECT SELECT id FROM teams', /UNION ALL/],
    ['except', 'SELECT id FROM members EXCEPT SELECT id FROM teams', /UNION ALL/],
    ['right join', 'SELECT 1 FROM teams t RIGHT JOIN members m ON m.team_id = t.id', /INNER and LEFT/],
    ['full join', 'SELECT 1 FROM teams t FULL JOIN members m ON m.team_id = t.id', /INNER and LEFT/],
    ['natural join', 'SELECT 1 FROM teams NATURAL JOIN members'],
    ['lateral', 'SELECT 1 FROM teams t, LATERAL (SELECT 1 AS x) s', /LATERAL/],
    ['values', 'SELECT * FROM (VALUES (1)) v(a)'],
    ['function in FROM', 'SELECT * FROM generate_series(1,10)'],
    ['comments', 'SELECT 1 FROM teams -- x', /comments/],
    ['block comment', 'SELECT /* x */ 1 FROM teams', /comments/],
    ['param ref', 'SELECT id FROM teams WHERE id = $1'],
    ['array subscript', 'SELECT (ARRAY[1,2])[1] FROM teams'],
    ['row expr', 'SELECT ROW(1,2) FROM teams'],
    ['collate', 'SELECT name COLLATE "C" FROM teams'],
    ['custom operator', 'SELECT 1 FROM teams WHERE id OPERATOR(pg_catalog.=) 1', /Operator/],
    ['regex operator', "SELECT 1 FROM teams WHERE name ~ 'a'", /Operator/],
    ['json operator', "SELECT 1 FROM teams WHERE name -> 'a' = 'b'", /Operator/],
    ['ALL sublink', 'SELECT 1 FROM members WHERE id > ALL (SELECT id FROM teams)', /Subquery form/],
    ['array sublink', 'SELECT ARRAY(SELECT id FROM teams) FROM teams'],
    ['window clause', 'SELECT SUM(tokens_in) OVER w FROM sync_sessions WINDOW w AS (ORDER BY id)'],
    ['row_number without over', 'SELECT row_number() FROM teams', /OVER/],
    ['fetch with ties', 'SELECT id FROM teams ORDER BY id FETCH FIRST 1 ROWS WITH TIES', /TIES/],
  ];
  for (const [name, sql, re] of cases) it(name, () => bad(sql, re));
});

describe('dangerous constructs hidden in nested positions', () => {
  it('subquery in WHERE with FOR UPDATE', () => bad('SELECT id FROM teams WHERE id IN (SELECT id FROM members FOR UPDATE)', /Locking/));
  it('subquery in FROM with INTO', () => bad('SELECT * FROM (SELECT id INTO x FROM teams) s', /INTO/));
  it('unapproved function in a CTE', () => bad('WITH a AS (SELECT pg_sleep(10) AS s FROM teams) SELECT * FROM a', /Function not allowed/));
  it('system table in a CTE', () => bad('WITH a AS (SELECT * FROM pg_catalog.pg_shadow) SELECT * FROM a', /Schema not allowed/));
  it('unauthorized table in an EXISTS', () => bad('SELECT 1 FROM teams WHERE EXISTS (SELECT 1 FROM users)', /Table not allowed: users/));
  it('unauthorized table in a join', () => bad('SELECT 1 FROM teams t JOIN member_keys k ON k.id = t.id', /Table not allowed/));
  it('unauthorized table in a UNION ALL arm', () => bad('SELECT id FROM teams UNION ALL SELECT id FROM audit_log', /Table not allowed/));
  it('bad function in a window ORDER BY', () => bad('SELECT row_number() OVER (ORDER BY pg_sleep(1)) FROM teams', /Function not allowed/));
  it('bad function in a FILTER', () => bad('SELECT COUNT(*) FILTER (WHERE pg_sleep(1) IS NULL) FROM teams', /Function not allowed/));
  it('bad function in HAVING', () => bad('SELECT id FROM teams GROUP BY id HAVING length(version()) > 1', /Function not allowed/));
  it('bad function in ORDER BY', () => bad('SELECT id FROM teams ORDER BY random()', /Function not allowed/));
  it('bad function in a CASE branch', () => bad("SELECT CASE WHEN id > 1 THEN pg_read_file('/etc/passwd') END FROM teams", /Function not allowed/));
  it('bad function in an aggregate argument', () => bad('SELECT SUM(lo_import(\'x\')) FROM teams', /Function not allowed/));
  it('depth bomb', () => bad(`SELECT ${'(SELECT '.repeat(60)}1${')'.repeat(60)} FROM teams`, /deeply|syntax/));
});

describe('functions, types, schemas, catalogs', () => {
  for (const f of ['pg_sleep(1)', 'version()', 'current_setting(\'a\')', 'set_config(\'a\',\'b\',false)', 'pg_read_file(\'x\')',
    'lo_import(\'x\')', 'dblink(\'a\',\'b\')', 'random()', 'generate_series(1,2)', 'to_jsonb(teams)', 'row_to_json(teams)',
    'nextval(\'s\')', 'pg_catalog.pg_sleep(1)', 'public.my_func()', 'myschema.count(id)', 'pg_catalog.public.count(id)',
    'string_agg(name, \',\')', 'array_agg(name)', 'jsonb_agg(name)', 'current_database()', 'pg_terminate_backend(1)', 'txid_current()',
    'query_to_xml(\'select 1\', true, true, \'\')', 'ts_stat(\'select 1\')'])
    it(`rejects function ${f}`, () => bad(`SELECT ${f} FROM teams`, /Function not allowed|Unsupported|not allowed/));
  for (const v of ['CURRENT_USER', 'SESSION_USER', 'USER', 'CURRENT_CATALOG', 'CURRENT_SCHEMA', 'CURRENT_ROLE'])
    it(`rejects ${v}`, () => bad(`SELECT ${v} FROM teams`));
  it('quoted function name is case-sensitive (not folded)', () => bad('SELECT "COUNT"(*) FROM teams', /Function not allowed/));
  it('rejects regclass cast', () => bad("SELECT 'pg_user'::regclass FROM teams", /Type not allowed/));
  it('rejects array type cast', () => bad("SELECT '{1}'::int[] FROM teams", /Type form|Unsupported/));
  it('rejects json cast', () => bad("SELECT '{}'::jsonb FROM teams", /Type not allowed/));
  it('allows int cast', () => ok('SELECT id::int, id::bigint, name::text FROM teams'));
  for (const t of ['pg_class', 'pg_catalog.pg_class', 'information_schema.tables', 'pg_shadow', 'pg_authid', 'users', 'public.users', 'member_keys', 'auth_totp', 'audit_log', 'prompt_embeddings', 'neon.something', 'other.teams'])
    it(`rejects relation ${t}`, () => bad(`SELECT * FROM ${t}`, /not allowed/));
  it('rejects 3-part (catalog) relation', () => bad('SELECT * FROM mydb.public.teams', /Unsupported|not allowed/));
  it('rejects quoted-case table', () => bad('SELECT * FROM "Teams"', /Table not allowed/));
});

describe('columns', () => {
  for (const c of ['password_hash', 'key_hash', 'api_key', 'secret_enc', 'prompt_text_sanitized', 'tool_args_summary', 'payload_hash', 'email'])
    it(`rejects column ${c}`, () => bad(`SELECT ${c} FROM members`, /Column not allowed/));
  it('rejects qualified ungranted column', () => bad('SELECT m.password_hash FROM members m', /Column not allowed/));
  it('rejects ungranted column in WHERE', () => bad("SELECT id FROM members WHERE password_hash = 'x'", /Column not allowed/));
  it('rejects whole-row reference', () => bad('SELECT (m) FROM members m', /Column not allowed/));
  it('rejects unknown qualifier', () => bad('SELECT x.id FROM members m', /Unknown table or alias/));
  it('rejects schema-qualified system column ref', () => bad('SELECT pg_catalog.pg_class.relname FROM teams', /Schema not allowed|Table not allowed/));
  it('allows output alias referenced in ORDER BY', () => ok('SELECT COUNT(*) AS n FROM teams ORDER BY n'));
  it('allows CTE column alias list', () => ok('WITH c(a, b) AS (SELECT id, name FROM teams) SELECT a, b FROM c'));
});

describe('input limits and parser failures (fail closed)', () => {
  it('empty', () => bad('   ', /empty/));
  it('only semicolons', () => bad(';', /./));
  it('non-string', () => assert.throws(() => validateSqlAst(undefined as unknown as string, GRANTS), SqlGuardError));
  it('malformed', () => bad('SELEC id FRM teams', /syntax error/));
  it('unterminated string', () => bad("SELECT 'abc FROM teams", /syntax/));
  it('excessively large', () => bad(`SELECT ${'1,'.repeat(MAX_SQL_LENGTH)}1 FROM teams`, /too long/));
  it('node-count bomb under the length limit', () => bad(`SELECT ${Array.from({ length: 2500 }, () => '1').join('+')} FROM teams`, /syntax|complex|deeply|too/));
  it('unexpected AST node type is rejected', () => {
    // Every real node type must be on the allowlist; probe a few that the grammar can produce but we never allow.
    for (const s of ['SELECT GROUPING(id) FROM teams GROUP BY ROLLUP (id)', "SELECT XMLELEMENT(NAME a) FROM teams", "SELECT id FROM teams TABLESAMPLE SYSTEM (10)", "SELECT '1'::json IS JSON FROM teams", "SELECT id FROM teams WHERE id = ANY (ARRAY[1])"])
      bad(s);
  });
  it('fails closed when the parser throws unexpectedly', () => {
    assert.throws(() => validateSqlAst('SELECT 1 FROM teams', null as unknown as Record<string, string[]>), SqlGuardError);
  });
});

describe('performance sanity', () => {
  it('validates a representative report in well under 10ms (warm)', () => {
    const sql = builtSql('friction_report', { days: 30 })!;
    for (let i = 0; i < 50; i++) validateSqlAst(sql, GRANTS);
    const t = process.hrtime.bigint();
    for (let i = 0; i < 200; i++) validateSqlAst(sql, GRANTS);
    const ms = Number(process.hrtime.bigint() - t) / 1e6 / 200;
    console.log(`  friction_report: ${ms.toFixed(3)} ms/validation`);
    assert.ok(ms < 10);
  });
});
