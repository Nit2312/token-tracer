/**
 * Temporary mcp_data_owner membership: STATIC checks of the three SQL files plus a pure TypeScript REFERENCE MODEL.
 * The model is NOT PostgreSQL. No database is used. Live PostgreSQL behaviour of GRANT / REVOKE ... GRANTED BY is UNVERIFIED here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

type Row = { grantor: string; admin: boolean; inherit: boolean; set: boolean };
type Mode = 'none' | 'set_option' | 'row';
type Step = 'grant' | 'set_role' | 'function_creation' | 'post_assert';
const ME = 'me';

const clone = (rows: Row[]): Row[] => rows.map((r) => ({ ...r }));
const sortRows = (rows: Row[]): Row[] => clone(rows).sort((a, b) => a.grantor.localeCompare(b.grantor));

class Failure extends Error {}

/** Reference model of one script's membership logic. Returns final rows and whether the work window had set=true. */
function runScript(initial: Row[], opts: { superuser?: boolean; failAt?: Step } = {}): { rows: Row[]; windowHasSet: boolean; mode: Mode | null } {
  let rows = clone(initial);
  let mode: Mode | null = null;
  let windowHasSet = false;
  const maybeFail = (s: Step) => { if (opts.failAt === s) throw new Failure(s); };
  try {
    if (!opts.superuser) {
      if (!rows.some((r) => r.admin)) throw new Error('lacks ADMIN OPTION');
      const snapshot = sortRows(rows);
      if (rows.some((r) => r.set)) mode = 'none';
      else if (rows.some((r) => r.grantor === ME)) {
        rows.find((r) => r.grantor === ME)!.set = true;
        mode = 'set_option';
      } else {
        rows.push({ grantor: ME, admin: false, inherit: false, set: true });
        mode = 'row';
      }
      maybeFail('grant');
      maybeFail('set_role');
      windowHasSet = rows.some((r) => r.set);
      maybeFail('function_creation');
      // restore
      if (mode === 'row') rows = rows.filter((r) => r.grantor !== ME); // REVOKE ... GRANTED BY me removes my row
      else if (mode === 'set_option') rows.find((r) => r.grantor === ME)!.set = false;
      maybeFail('post_assert');
      assert.deepEqual(sortRows(rows), snapshot, 'membership rows were not restored exactly');
    } else {
      maybeFail('grant'); maybeFail('set_role'); maybeFail('function_creation'); maybeFail('post_assert');
    }
  } catch (e) {
    if (e instanceof Failure || (e instanceof Error && e.message === 'lacks ADMIN OPTION')) return { rows: clone(initial), windowHasSet, mode }; // transaction rollback
    throw e;
  }
  return { rows, windowHasSet, mode };
}

const SCENARIOS: Record<string, { rows: Row[]; mode: Mode }> = {
  'absent membership (no ADMIN: aborts, state unchanged)': { rows: [], mode: 'none' },
  'implicit ADMIN-only row from another grantor': { rows: [{ grantor: 'boot', admin: true, inherit: false, set: false }], mode: 'row' },
  'ADMIN-only row whose grantor is me': { rows: [{ grantor: ME, admin: true, inherit: false, set: false }], mode: 'set_option' },
  'admin+inherit row of mine': { rows: [{ grantor: ME, admin: true, inherit: true, set: false }], mode: 'set_option' },
  'pre-existing set row': { rows: [{ grantor: 'boot', admin: true, inherit: false, set: true }], mode: 'none' },
  'multiple rows, none mine': { rows: [{ grantor: 'a', admin: true, inherit: false, set: false }, { grantor: 'b', admin: false, inherit: true, set: false }], mode: 'row' },
  'multiple rows, one mine': { rows: [{ grantor: 'a', admin: true, inherit: false, set: false }, { grantor: ME, admin: false, inherit: true, set: false }], mode: 'set_option' },
};

describe('REFERENCE MODEL (not PostgreSQL; live behaviour unverified): membership restore', () => {
  for (const [name, sc] of Object.entries(SCENARIOS)) {
    const hasAdmin = sc.rows.some((r) => r.admin);
    it(`model: ${name}: final rows equal initial rows`, () => {
      const r = runScript(sc.rows);
      assert.deepEqual(sortRows(r.rows), sortRows(sc.rows));
      if (hasAdmin) {
        assert.equal(r.mode, sc.mode);
        assert.equal(r.windowHasSet, true, 'work window must have set=true on some row');
      }
    });
    it(`model: ${name}: superuser performs no membership operation`, () => {
      const r = runScript(sc.rows, { superuser: true });
      assert.deepEqual(r.rows, sc.rows);
      assert.equal(r.mode, null);
    });
    for (const step of ['grant', 'set_role', 'function_creation', 'post_assert'] as Step[]) {
      it(`model: ${name}: failure injected at ${step} rolls back to initial`, () => {
        assert.deepEqual(runScript(sc.rows, { failAt: step }).rows, sc.rows);
      });
    }
    it(`model: ${name}: successful run then rollback-script identical logic`, () => {
      const first = runScript(sc.rows);
      const second = runScript(first.rows);
      assert.deepEqual(sortRows(second.rows), sortRows(sc.rows));
    });
  }
});

const root = path.join(__dirname, '..');
const files = ['mcp-data.sql', 'mcp-data.grants.sql', 'mcp-data.rollback.sql'];
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');

describe('STATIC: membership handling in the three SQL files (not executed)', () => {
  for (const f of files) {
    const sql = strip(fs.readFileSync(path.join(root, 'scripts/migrations', f), 'utf8'));
    const has = (s: string) => assert.ok(sql.includes(s), `${f} missing: ${s}`);
    it(`${f}: three branches and exact statements`, () => {
      has("'none'"); has("'set_option'"); has("'row'");
      has('GRANT mcp_data_owner TO CURRENT_USER WITH SET TRUE GRANTED BY CURRENT_USER;');
      has('GRANT mcp_data_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE GRANTED BY CURRENT_USER;');
      has('REVOKE SET OPTION FOR mcp_data_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;');
      has('REVOKE mcp_data_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;');
    });
    it(`${f}: snapshot before any GRANT, restore after the work, exact comparison`, () => {
      const snap = sql.indexOf("'mcp_data.membership_snapshot'");
      const firstGrant = sql.indexOf('GRANT mcp_data_owner TO CURRENT_USER');
      const restore = sql.indexOf('REVOKE SET OPTION FOR mcp_data_owner');
      assert.ok(snap >= 0 && snap < firstGrant, 'snapshot precedes grant');
      assert.ok(restore > firstGrant, 'restore after grant');
      assert.ok(sql.indexOf('SET LOCAL ROLE') < 0 || restore > sql.indexOf('SET LOCAL ROLE'), 'restore after SET LOCAL ROLE');
      has('membership rows were not restored exactly');
      assert.ok(sql.indexOf('membership rows were not restored exactly') > restore);
    });
    it(`${f}: ADMIN check precedes grant, superusers skipped`, () => {
      const adminChk = sql.search(/m\.admin_option\)?\s*THEN\s*RAISE|AND m\.admin_option\)/);
      assert.ok(adminChk >= 0 && adminChk < sql.indexOf('GRANT mcp_data_owner TO CURRENT_USER'));
      assert.match(sql, /NOT v_super/);
    });
    it(`${f}: adversarial: no ADMIN revoke/grant, no INHERIT TRUE, no DROP OWNED`, () => {
      assert.doesNotMatch(sql, /REVOKE\s+ADMIN\s+OPTION/i);
      assert.doesNotMatch(sql, /WITH\s+ADMIN/i);
      assert.doesNotMatch(sql, /INHERIT\s+TRUE/i);
      assert.doesNotMatch(sql, /DROP\s+OWNED/i);
    });
  }
});
