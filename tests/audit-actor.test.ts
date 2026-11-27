/**
 * DB-free tests of recordAuditEvent's actor handling. audit_log.actor_user_id is a UUID foreign key to users(id): the built-in accounts
 * (`team`, `superadmin`, session ids 'admin' / 'superadmin') have no users row, and a deleted user's stale session has a UUID with no row.
 * Both used to make the insert fail and the event vanish (swallowed, only logged). Database users must be recorded exactly as before.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Queryable } from '../lib/team/db';
import { recordAuditEvent } from '../lib/team/audit';

type Call = { sql: string; params: unknown[] };
function fakeDb(plan: Array<'ok' | { code: string } | 'throw-sync'> = []) {
  const calls: Call[] = [];
  const db = { query: ((sql: string, params: unknown[] = []) => {
    calls.push({ sql, params }); const step = plan[calls.length - 1] ?? 'ok';
    if (step === 'throw-sync') throw new Error('sync boom');
    if (step === 'ok') return Promise.resolve({ rows: [], rowCount: 1 });
    return Promise.reject(Object.assign(new Error(`pg ${step.code}`), { code: step.code }));
  }) as unknown as Queryable['query'] } as Queryable;
  return { db, calls };
}
const errors: unknown[][] = [];
const realError = console.error;
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => { errors.length = 0; console.error = (...a: unknown[]) => { errors.push(a); }; try { return await fn(); } finally { console.error = realError; } };

const UUID = '3f2b8c1e-9d4a-4e6b-8a7c-1b2c3d4e5f60';
const base = { actorUsername: 'someone', action: 'test.action', targetType: 'user', targetId: 'target-1' };

describe('built-in accounts never put a non-UUID into actor_user_id', () => {
  for (const [id, username] of [['superadmin', 'superadmin'], ['admin', 'team']] as const) {
    it(`session id "${id}" (${username}) → actor_user_id NULL, username kept, original id preserved in metadata.builtinActor`, async () => {
      const { db, calls } = fakeDb();
      const ok = await recordAuditEvent({ ...base, actorUserId: id, actorUsername: username, metadata: { ip: '1.2.3.4' } }, db);
      assert.equal(ok, true); assert.equal(calls.length, 1);
      const [actor, name, action, ttype, tid, meta] = calls[0].params;
      assert.deepEqual([actor, name, action, ttype, tid], [null, username, 'test.action', 'user', 'target-1']);
      assert.deepEqual(meta, { ip: '1.2.3.4', builtinActor: id }); // existing metadata is kept
    });
  }
  it('every non-UUID shape is neutralised (garbage, SQL-looking, very long, UUID-with-extra); the marker is truncated; nothing throws', async () => {
    for (const bad of ["x'; DROP TABLE users;--", 'not-a-uuid', ` ${UUID}`, `${UUID}x`, UUID.slice(1), 'A'.repeat(500), '00000000-0000-0000-0000-00000000000g']) {
      const { db, calls } = fakeDb(); assert.equal(await recordAuditEvent({ ...base, actorUserId: bad }, db), true);
      assert.equal(calls[0].params[0], null, bad.slice(0, 20));
      assert.ok(String((calls[0].params[5] as { builtinActor: string }).builtinActor).length <= 64);
    }
  });
  it('no actor at all (null, undefined, empty) → NULL and NO marker (an anonymous event is not a built-in actor)', async () => {
    for (const none of [null, undefined, '']) {
      const { db, calls } = fakeDb(); await recordAuditEvent({ ...base, actorUserId: none, metadata: null }, db);
      assert.equal(calls[0].params[0], null); assert.equal(calls[0].params[5], null);
    }
  });
});

describe('database users are recorded exactly as before', () => {
  it('a real UUID is passed through unchanged (any case) with the caller\'s metadata untouched and no marker', async () => {
    for (const id of [UUID, UUID.toUpperCase()]) {
      const { db, calls } = fakeDb(); const meta = { targetUsername: 'bob', teamId: 't' };
      assert.equal(await recordAuditEvent({ ...base, actorUserId: id, metadata: meta }, db), true);
      assert.equal(calls.length, 1); assert.equal(calls[0].params[0], id); assert.deepEqual(calls[0].params[5], { targetUsername: 'bob', teamId: 't' });
      assert.ok(!('builtinActor' in (calls[0].params[5] as object)));
    }
  });
  it('the SQL is the same single parameterised INSERT (no values interpolated)', async () => {
    const { db, calls } = fakeDb(); await recordAuditEvent({ ...base, actorUserId: UUID }, db);
    assert.match(calls[0].sql, /INSERT INTO audit_log \(actor_user_id, actor_username, action, target_type, target_id, metadata\)\s+VALUES \(\$1, \$2, \$3, \$4, \$5, \$6\)/);
    assert.ok(!calls[0].sql.includes(UUID));
  });
});

describe('failures are never silent', () => {
  it('an actor UUID whose user was deleted (foreign key 23503) is retried ONCE unlinked, with the missing id recorded; the event is not lost', async () => {
    const { db, calls } = fakeDb([{ code: '23503' }, 'ok']);
    const ok = await quiet(() => recordAuditEvent({ ...base, actorUserId: UUID, metadata: { a: 1 } }, db));
    assert.equal(ok, true); assert.equal(calls.length, 2); assert.equal(errors.length, 0);
    assert.equal(calls[0].params[0], UUID); assert.equal(calls[1].params[0], null); assert.deepEqual(calls[1].params[5], { a: 1, actorUserMissing: UUID });
  });
  it('if the unlinked retry ALSO fails, it returns false and logs [audit-log-error] (never throws, never silent)', async () => {
    const { db, calls } = fakeDb([{ code: '23503' }, { code: '57P01' }]);
    const ok = await quiet(() => recordAuditEvent({ ...base, actorUserId: UUID }, db));
    assert.equal(ok, false); assert.equal(calls.length, 2); assert.equal(errors.length, 1); assert.equal(errors[0][0], '[audit-log-error]'); assert.equal(errors[0][1], 'test.action');
  });
  it('any other database error returns false, is logged with the tag, is NOT retried, and never throws (even a synchronous throw)', async () => {
    for (const plan of [[{ code: '08006' }], [{ code: '42P01' }], ['throw-sync']] as const) {
      const { db, calls } = fakeDb([...plan]);
      const ok = await quiet(() => recordAuditEvent({ ...base, actorUserId: 'superadmin' }, db));
      assert.equal(ok, false); assert.equal(calls.length, 1); assert.equal(errors.length, 1); assert.equal(errors[0][0], '[audit-log-error]');
    }
  });
  it('the retry is only for a real UUID: a built-in actor that hits a foreign-key error (impossible: it is sent as NULL) is not retried as if it were a user', async () => {
    const { db, calls } = fakeDb([{ code: '23503' }]);
    const ok = await quiet(() => recordAuditEvent({ ...base, actorUserId: 'superadmin' }, db));
    assert.equal(ok, false); assert.equal(calls.length, 1);
  });
  it('successful paths log nothing', async () => {
    const { db } = fakeDb(); await quiet(async () => { await recordAuditEvent({ ...base, actorUserId: 'superadmin' }, db); await recordAuditEvent({ ...base, actorUserId: UUID }, db); });
    assert.equal(errors.length, 0);
  });
});

describe('static guards', () => {
  const root = process.cwd();
  const walk = (d: string): string[] => fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : /\.(ts|tsx)$/.test(e.name) ? [`${d}/${e.name}`] : []));
  const files = [...walk('app'), ...walk('lib')];
  it('recordAuditEvent is the ONLY code that inserts into audit_log (application side), so the actor rule cannot be bypassed', () => {
    const writers = files.filter((f) => /INSERT\s+INTO\s+audit_log/i.test(fs.readFileSync(path.join(root, f), 'utf8')));
    assert.deepEqual(writers, ['lib/team/audit.ts']);
  });
  it('the helper keeps the UUID guard, the foreign-key fallback and a boolean result', () => {
    const src = fs.readFileSync(path.join(root, 'lib/team/audit.ts'), 'utf8');
    assert.match(src, /UUID_RE\.test\(raw\)/); assert.match(src, /'23503'/); assert.match(src, /Promise<boolean>/); assert.match(src, /\[audit-log-error\]/);
  });
  it('the 12 routes that pass session.userId need no change: the rule is in the helper (and each still passes an actorUsername)', () => {
    const callers = files.filter((f) => f !== 'lib/team/audit.ts' && /recordAuditEvent\(/.test(fs.readFileSync(path.join(root, f), 'utf8')));
    assert.ok(callers.length >= 10);
    for (const f of callers) assert.match(fs.readFileSync(path.join(root, f), 'utf8'), /actorUsername/, f);
  });
});
