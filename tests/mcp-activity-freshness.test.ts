/**
 * developer_activity: fresh (live) and honest about long sessions. DB-free; the behaviour itself is exercised on a real PostgreSQL in the DB suites.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { toDailyActivity, assertMetadataOnly } from '../lib/mcp/data/output';
import { TOOL_DEFINITIONS } from '../lib/mcp/tools/schemas';

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), 'utf8');
const base = { day: '2026-11-27', tokens_in: '1001000', tokens_out: 500, cache_read_tokens: 0, cache_write_tokens: 0, api_cost: 0.5, session_count: '2', tool_calls: 6, tool_errors: 0, edits: 0, additions: 0, deletions: 0, changed_lines: 0, files_touched: 0, rework_loops: 0, corrections: 0, abandoned_count: 0 };

describe('toDailyActivity: how far a day can be trusted', () => {
  it('maps the three detail columns (bigint strings or numbers) and lets them leave through the output guard', () => {
    const a = toDailyActivity({ ...base, sessions_started_earlier: '1', tokens_in_sessions_started_earlier: '1200000', unpriced_sessions: 1 });
    assert.deepEqual([a.sessionsStartedEarlier, a.tokensInSessionsStartedEarlier, a.unpricedSessions], [1, 1200000, 1]);
    assert.doesNotThrow(() => assertMetadataOnly([a]));
  });
  it('NULL means "unknown" (a day served from the rollup) and stays null, never 0', () => {
    const a = toDailyActivity({ ...base, sessions_started_earlier: null, tokens_in_sessions_started_earlier: null, unpriced_sessions: null });
    assert.deepEqual([a.sessionsStartedEarlier, a.tokensInSessionsStartedEarlier, a.unpricedSessions], [null, null, null]);
    assert.equal(toDailyActivity({ ...base }).unpricedSessions, null, 'absent columns are unknown too');
  });
  it('a malformed value is refused rather than shown', () => {
    for (const bad of [-1, 'x', 1.5, {}]) assert.throws(() => toDailyActivity({ ...base, sessions_started_earlier: bad }));
  });
});

describe('tool descriptions tell the assistant what the numbers mean', () => {
  const desc = (n: string) => TOOL_DEFINITIONS.find((t) => t.name === n)!.description;
  it('developer_activity: UTC days, today is live, sessions count in full on the day they ended, and the three caveat fields', () => {
    const d = desc('developer_activity');
    for (const frag of ['UTC', 'live', 'IN FULL', 'sessionsStartedEarlier', 'tokensInSessionsStartedEarlier', 'unpricedSessions', 'nightly rollup']) assert.ok(d.includes(frag), frag);
  });
  it('list_sessions and session_details: totals are for the whole life of the session', () => {
    assert.match(desc('list_sessions'), /WHOLE life/);
    assert.match(desc('list_sessions'), /startedAt/);
    assert.match(desc('session_details'), /whole life/);
  });
});

describe('the SQL (static): live first, rollup only as a fallback, same attribution as the rollup and the dashboard', () => {
  const sql = read('scripts/migrations/mcp-data.sql');
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION mcp_data.developer_activity');
  const body = sql.slice(start, sql.indexOf('CREATE OR REPLACE FUNCTION mcp_data.list_sessions')).replace(/\s+/g, ' ');
  const dayExpr = "(COALESCE(s.ended_at, s.started_at, s.synced_at) AT TIME ZONE 'UTC')::date";
  it('reads live sessions of the resolved team and member, and prefers them over the rollup', () => {
    assert.ok(body.includes('FROM public.sync_sessions s WHERE s.team_id = v_team AND s.member_id = p_member'));
    assert.ok(body.includes('COALESCE(l.l_ti, r.r_ti)') && body.includes('FROM live l FULL JOIN roll r ON r.r_day = l.l_day'));
  });
  it('attributes a session to the same day as the nightly rollup (end, else start, else sync) in UTC', () => {
    assert.ok(body.includes(dayExpr));
    const rollup = read('app/api/internal/rollup/route.ts');
    assert.ok(rollup.includes('COALESCE(s.ended_at, s.started_at, s.synced_at)::date AS day'), 'the rollup still uses the same rule');
  });
  it('the caveat columns are computed live only; the rollup branch leaves them NULL', () => {
    assert.ok(body.includes('l.l_se, l.l_tse, l.l_up'));
    assert.ok(!/r\.r_se|r\.r_tse|r\.r_up/.test(body));
    assert.ok(body.includes('FILTER (WHERE NOT s.priced)'));
  });
});
