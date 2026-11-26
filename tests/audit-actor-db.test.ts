/**
 * Live test of recordAuditEvent against the REAL audit_log table (explicit test branch, owner connection injected): built-in accounts
 * (`superadmin`, `team`), database users, and a deleted user's stale session. Includes a control that proves the two original failure modes
 * exist in the real schema, so the fix is not testing a hypothetical. Rows are tagged with a unique action prefix and removed in after().
 */
import { SKIP_DB, SKIP_REASON, connectionString, loadTestDb } from './helpers/test-db'; // FIRST: installs the tripwire
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import type { Queryable } from '../lib/team/db';
import { recordAuditEvent } from '../lib/team/audit';

const cfg = SKIP_DB ? undefined : loadTestDb('owner');
const RUN = crypto.randomBytes(5).toString('hex');
const ACTION = (n: string) => `audit-actor-test.${RUN}.${n}`;
let owner: pg.Client; let db: Queryable; let userId: string;
const errors: unknown[][] = []; const realError = console.error;
const row = async (action: string) => (await owner.query('SELECT actor_user_id, actor_username, action, target_type, target_id, metadata FROM audit_log WHERE action = $1', [action])).rows;

describe('audit_log actor handling (live test branch)', { skip: SKIP_DB ? SKIP_REASON : false }, () => {
  before(async () => {
    owner = new pg.Client({ connectionString: connectionString(cfg!), ssl: { rejectUnauthorized: true } }); await owner.connect();
    db = { query: ((text: string, params?: unknown[]) => owner.query(text, params)) as Queryable['query'] };
    userId = (await owner.query(`INSERT INTO users (username, password_hash, display_name, role) VALUES ($1, 'x-not-a-hash', 'Audit Actor Test', 'admin') RETURNING id`, [`audit-actor-${RUN}`])).rows[0].id;
    console.error = (...a: unknown[]) => { errors.push(a); };
  });
  after(async () => {
    console.error = realError;
    try { await owner.query(`DELETE FROM audit_log WHERE action LIKE $1`, [`audit-actor-test.${RUN}.%`]); await owner.query('DELETE FROM users WHERE id = $1', [userId]); }
    finally { await owner?.end().catch(() => {}); }
  });

  it('CONTROL: the original failure modes are real — a non-UUID actor is rejected (22P02) and a UUID with no user is rejected (23503)', async () => {
    const code = async (actor: string) => { try { await owner.query(`INSERT INTO audit_log (actor_user_id, actor_username, action) VALUES ($1, 'x', $2)`, [actor, ACTION('control')]); return 'ok'; } catch (e) { return (e as { code?: string }).code; } };
    assert.equal(await code('superadmin'), '22P02');
    assert.equal(await code('admin'), '22P02');
    assert.equal(await code(crypto.randomUUID()), '23503');
  });

  it('built-in superadmin and team: the event IS written (actor_user_id NULL, username kept, original id in metadata), nothing is logged as an error', async () => {
    errors.length = 0;
    assert.equal(await recordAuditEvent({ actorUserId: 'superadmin', actorUsername: 'superadmin', action: ACTION('sa'), targetType: 'user', targetId: 'victim-1', metadata: { targetUsername: 'bob' } }, db), true);
    assert.equal(await recordAuditEvent({ actorUserId: 'admin', actorUsername: 'team', action: ACTION('team'), targetType: 'user', targetId: 'victim-2' }, db), true);
    const sa = (await row(ACTION('sa')))[0]; const team = (await row(ACTION('team')))[0];
    assert.deepEqual([sa.actor_user_id, sa.actor_username, sa.target_type, sa.target_id, sa.metadata], [null, 'superadmin', 'user', 'victim-1', { targetUsername: 'bob', builtinActor: 'superadmin' }]);
    assert.deepEqual([team.actor_user_id, team.actor_username, team.metadata], [null, 'team', { builtinActor: 'admin' }]);
    assert.equal(errors.length, 0);
  });

  it('a database user is recorded exactly as before: actor_user_id set to their id, no marker added', async () => {
    errors.length = 0;
    assert.equal(await recordAuditEvent({ actorUserId: userId, actorUsername: `audit-actor-${RUN}`, action: ACTION('db'), targetType: 'user', targetId: 'victim-3', metadata: { teamId: 't' } }, db), true);
    const r = (await row(ACTION('db')))[0];
    assert.deepEqual([r.actor_user_id, r.actor_username, r.metadata], [userId, `audit-actor-${RUN}`, { teamId: 't' }]);
    assert.equal(errors.length, 0);
  });

  it('a stale session of a DELETED user (valid UUID, no users row) still records the event, unlinked, with the missing id noted', async () => {
    errors.length = 0; const ghost = crypto.randomUUID();
    assert.equal(await recordAuditEvent({ actorUserId: ghost, actorUsername: 'ghost-user', action: ACTION('ghost'), metadata: { k: 1 } }, db), true);
    const r = (await row(ACTION('ghost')))[0];
    assert.deepEqual([r.actor_user_id, r.actor_username, r.metadata], [null, 'ghost-user', { k: 1, actorUserMissing: ghost }]);
    assert.equal(errors.length, 0);
  });

  it('hostile or empty actor values never lose the event and never raise: SQL-looking, oversized, null, undefined, empty', async () => {
    errors.length = 0;
    const cases: Array<[string, string | null | undefined]> = [['sql', "x'; DROP TABLE users;--"], ['long', 'A'.repeat(5000)], ['null', null], ['undef', undefined], ['empty', '']];
    for (const [n, actor] of cases) assert.equal(await recordAuditEvent({ actorUserId: actor, actorUsername: 'someone', action: ACTION(n) }, db), true, n);
    for (const [n] of cases) { const r = (await row(ACTION(n)))[0]; assert.equal(r.actor_user_id, null, n); }
    assert.ok(String((await row(ACTION('long')))[0].metadata.builtinActor).length <= 64);
    assert.equal((await row(ACTION('null')))[0].metadata, null); // an anonymous event is not marked as a built-in actor
    assert.equal(errors.length, 0);
    assert.equal((await owner.query(`SELECT count(*)::int n FROM users WHERE id = $1`, [userId])).rows[0].n, 1); // the "DROP TABLE" text did nothing
  });

  it('if the database itself fails, the event reports false and logs [audit-log-error] (a failure is never invisible)', async () => {
    errors.length = 0;
    const broken: Queryable = { query: (async () => { throw Object.assign(new Error('connection lost'), { code: '08006' }); }) as Queryable['query'] };
    assert.equal(await recordAuditEvent({ actorUserId: userId, actorUsername: 'u', action: ACTION('fail') }, broken), false);
    assert.equal(errors.length, 1); assert.equal(errors[0][0], '[audit-log-error]');
  });
});
