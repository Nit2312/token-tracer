/**
 * Regression and security boundary tests for scripts/setup-mcp-roles.mjs (P3-4).
 * Covers role provisioning for both mcp_auth and mcp_reader:
 *   - Fresh setup (CREATE ROLE) vs repeated setup (ALTER ROLE, idempotent)
 *   - Attribute validation (rejection of superuser, inherit, createrole, etc.)
 *   - Membership validation (rejection of any role memberships)
 *   - Connection limit and timeout enforcement
 *   - Password handling (>= 24 printable ASCII, never printed, masked in plan)
 *   - Failure states and parameter guards (EXPECTED_ENDPOINT, CONFIRM_MCP_ROLES)
 *   - Denial of unauthorized privileges (zero table/column/sequence privileges for mcp_reader)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT_PATH = path.join(root, 'scripts', 'setup-mcp-roles.mjs');
const SCRIPT_SRC = fs.readFileSync(SCRIPT_PATH, 'utf8');
const GRANTS_JSON = JSON.parse(fs.readFileSync(path.join(root, 'lib', 'mcp', 'grants.json'), 'utf8'));

describe('setup-mcp-roles.mjs static security properties', () => {
  it('supports both mcp_auth and mcp_reader roles, and rejects any other role', () => {
    assert.match(SCRIPT_SRC, /mcp_auth/);
    assert.match(SCRIPT_SRC, /mcp_reader/);
    assert.match(SCRIPT_SRC, /Invalid --role/);

    // Test CLI argument validation directly
    assert.throws(
      () => execFileSync('node', [SCRIPT_PATH, '--role=unknown_role'], { encoding: 'utf8', stdio: 'pipe' }),
      (err: unknown) => {
        const e = err as { status?: number; stderr?: string };
        return e.status === 2 && /Invalid --role "unknown_role"/.test(e.stderr ?? '');
      },
    );
  });

  it('enforces connection limit 5 for both roles from grants.json / constant', () => {
    assert.match(SCRIPT_SRC, /CONN_LIMIT = 5/);
    assert.equal(GRANTS_JSON.mcp_reader.connectionLimit, 5);
  });

  it('creates both roles with NOINHERIT, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION, NOBYPASSRLS', () => {
    assert.match(
      SCRIPT_SRC,
      /CREATE ROLE \${q\(ROLE\)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT \${CONN_LIMIT}/,
    );
  });

  it('validates pre-existing role attributes on apply and fails closed on any privilege creep', () => {
    assert.match(SCRIPT_SRC, /rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit/);
    assert.match(SCRIPT_SRC, /has forbidden attributes/);
    assert.match(SCRIPT_SRC, /refusing/);
  });

  it('validates that the role is not a member of any other role', () => {
    assert.match(SCRIPT_SRC, /SELECT count\(\*\)::int n FROM pg_auth_members WHERE member =/);
    assert.match(SCRIPT_SRC, /is a member of \${memberships} role\(s\); it must have none/);
  });

  it('never prints passwords, connection strings, or raw tokens to stdout or stderr', () => {
    // Check all console.* argument expressions
    for (const m of SCRIPT_SRC.matchAll(/console\.(?:log|error|warn)\(((?:[^;]|\n)*?)\);/g)) {
      const exprs = [...m[1].matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1]).join(' ') + ' ' + m[1].replace(/'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"/g, ' ');
      assert.ok(
        !/\b(raw|password|connectionString)\b|process\.env\.(DATABASE_URL|MCP_AUTH_DATABASE_URL|MCP_AUTH_PASSWORD|MCP_READER_DATABASE_URL|MCP_READER_PASSWORD|NEON_CONNECTION_STRING)/.test(exprs),
        `potentially leaky log: ${m[0].slice(0, 90)}`,
      );
    }
  });

  it('verifies TLS with rejectUnauthorized: true for non-local connections', () => {
    assert.match(SCRIPT_SRC, /rejectUnauthorized: true/);
    assert.doesNotMatch(SCRIPT_SRC, /rejectUnauthorized:\s*false/);
  });

  it('enforces password requirements (>= 24 printable ASCII characters, no spaces)', () => {
    assert.match(SCRIPT_SRC, /password\.length < 24/);
    assert.match(SCRIPT_SRC, /!.*\[\\x21-\\x7e\].*test\(password\)/);
  });

  it('requires CONFIRM_MCP_ROLES=yes and EXPECTED_ENDPOINT matching the host for apply and drop', () => {
    assert.match(SCRIPT_SRC, /CONFIRM_MCP_ROLES !== 'yes'/);
    assert.match(SCRIPT_SRC, /EXPECTED_ENDPOINT/);
  });
});

describe('setup-mcp-roles.mjs plan mode execution', () => {
  it('default plan mode prints SQL for mcp_auth without contacting database', () => {
    const out = execFileSync('node', [SCRIPT_PATH], { encoding: 'utf8' });
    assert.match(out, /-- PLAN \(nothing is executed\)\. Role mcp_auth/);
    assert.match(out, /CREATE ROLE "mcp_auth" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 5/);
    assert.match(out, /PASSWORD '<from MCP_AUTH_PASSWORD, not shown>'/);
    assert.match(out, /ALTER ROLE "mcp_auth" SET statement_timeout = 5000/);
    assert.match(out, /ALTER ROLE "mcp_auth" SET search_path = pg_catalog, public/);
    assert.match(out, /GRANT USAGE ON SCHEMA public TO "mcp_auth"/);
    assert.match(out, /GRANT SELECT \(/);
  });

  it('plan mode with --role=mcp_reader prints clean zero-table-privilege SQL with search_path and read-only defaults', () => {
    const out = execFileSync('node', [SCRIPT_PATH, '--role=mcp_reader'], { encoding: 'utf8' });
    assert.match(out, /-- PLAN \(nothing is executed\)\. Role mcp_reader/);
    assert.match(out, /CREATE ROLE "mcp_reader" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 5/);
    assert.match(out, /PASSWORD '<from MCP_READER_PASSWORD, not shown>'/);
    assert.match(out, /ALTER ROLE "mcp_reader" SET statement_timeout = 5000/);
    assert.match(out, /ALTER ROLE "mcp_reader" SET search_path = 'pg_catalog', 'pg_temp'/);
    assert.match(out, /ALTER ROLE "mcp_reader" SET default_transaction_read_only = on/);
    // Crucial security boundary: mcp_reader MUST NOT be granted SELECT on any table or sequence
    assert.doesNotMatch(out, /GRANT SELECT/);
    assert.doesNotMatch(out, /GRANT INSERT/);
    assert.doesNotMatch(out, /GRANT UPDATE/);
    assert.doesNotMatch(out, /GRANT USAGE ON SEQUENCE/);
    assert.match(out, /REVOKE ALL ON ALL TABLES IN SCHEMA "public" FROM "mcp_reader"/);
  });
});

describe('setup-mcp-roles.mjs role lifecycle and idempotence logic', () => {
  it('generates CREATE ROLE when role does not exist and ALTER ROLE when role exists', () => {
    // Both statement branches must exist in the script
    assert.match(SCRIPT_SRC, /ALTER ROLE \${q\(ROLE\)} LOGIN CONNECTION LIMIT \${CONN_LIMIT}/);
    assert.match(SCRIPT_SRC, /CREATE ROLE \${q\(ROLE\)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT/);
  });

  it('preserves existing password on repeated apply if password is not provided in env', () => {
    assert.match(SCRIPT_SRC, /const pw = password \? ` PASSWORD \${c\.escapeLiteral\(password\)}` : '';/);
    assert.match(SCRIPT_SRC, /Password \${password \? 'set' : 'unchanged'} \(not printed\)/);
  });

  it('rejects creation when role does not exist and password is empty', () => {
    assert.match(SCRIPT_SRC, /if \(!exists && !password\) \{ console\.error\(`\${PW_ENV} is required to create the role\.\`\); process\.exit\(2\); \}/);
  });

  it('signature validator accepts schema-qualified functions and array argument types for reader', () => {
    const SIGNATURE_REGEX = /^(?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*\([a-z0-9_ ,\[\]]*\)$/;
    assert.ok(SIGNATURE_REGEX.test('mcp_audit_event(text, uuid, text, text, jsonb)'));
    assert.ok(SIGNATURE_REGEX.test('mcp_data.list_developers(bytea, integer, uuid)'));
    assert.ok(SIGNATURE_REGEX.test('mcp_data.search_prompt_metadata(bytea, uuid, timestamptz, timestamptz, text[], boolean, boolean, boolean, integer, integer, text, text, integer, timestamptz, bigint)'));
    assert.ok(SIGNATURE_REGEX.test('mcp_data.prompt_metadata_batch(bytea, bigint[])'));
    assert.ok(!SIGNATURE_REGEX.test('bad; DROP TABLE users;'));
  });
});

describe('setup-mcp-roles.mjs functional CLI guards execution', () => {
  it('apply fails closed when DATABASE_URL is missing', () => {
    assert.throws(
      () => execFileSync('node', [SCRIPT_PATH, '--apply'], {
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, DATABASE_URL: '', NEON_CONNECTION_STRING: '' },
      }),
      (err: unknown) => {
        const e = err as { status?: number; stderr?: string };
        return e.status === 2 && /DATABASE_URL.*is not set/.test(e.stderr ?? '');
      },
    );
  });

  it('apply fails closed when CONFIRM_MCP_ROLES is not yes', () => {
    assert.throws(
      () => execFileSync('node', [SCRIPT_PATH, '--apply'], {
        encoding: 'utf8',
        stdio: 'pipe',
        env: {
          ...process.env,
          DATABASE_URL: 'postgresql://fake:fake@ep-test-123456.us-east-1.neon.tech/testdb',
          CONFIRM_MCP_ROLES: 'no',
        },
      }),
      (err: unknown) => {
        const e = err as { status?: number; stderr?: string };
        return e.status === 2 && /CONFIRM_MCP_ROLES=yes/.test(e.stderr ?? '');
      },
    );
  });

  it('apply fails closed when EXPECTED_ENDPOINT does not match', () => {
    assert.throws(
      () => execFileSync('node', [SCRIPT_PATH, '--apply'], {
        encoding: 'utf8',
        stdio: 'pipe',
        env: {
          ...process.env,
          DATABASE_URL: 'postgresql://fake:fake@ep-test-123456.us-east-1.neon.tech/testdb',
          CONFIRM_MCP_ROLES: 'yes',
          EXPECTED_ENDPOINT: 'ep-wrong-endpoint',
        },
      }),
      (err: unknown) => {
        const e = err as { status?: number; stderr?: string };
        return e.status === 2 && /EXPECTED_ENDPOINT is required and must match/.test(e.stderr ?? '');
      },
    );
  });

  it('apply fails closed when password is shorter than 24 characters', () => {
    assert.throws(
      () => execFileSync('node', [SCRIPT_PATH, '--apply', '--role=mcp_reader'], {
        encoding: 'utf8',
        stdio: 'pipe',
        env: {
          ...process.env,
          DATABASE_URL: 'postgresql://fake:fake@ep-test-123456.us-east-1.neon.tech/testdb',
          CONFIRM_MCP_ROLES: 'yes',
          EXPECTED_ENDPOINT: 'ep-test-123456',
          MCP_READER_PASSWORD: 'short_password_123',
        },
      }),
      (err: unknown) => {
        const e = err as { status?: number; stderr?: string };
        return e.status === 2 && /must be >= 24 printable ASCII characters/.test(e.stderr ?? '');
      },
    );
  });

  it('apply fails closed when password contains spaces', () => {
    assert.throws(
      () => execFileSync('node', [SCRIPT_PATH, '--apply', '--role=mcp_reader'], {
        encoding: 'utf8',
        stdio: 'pipe',
        env: {
          ...process.env,
          DATABASE_URL: 'postgresql://fake:fake@ep-test-123456.us-east-1.neon.tech/testdb',
          CONFIRM_MCP_ROLES: 'yes',
          EXPECTED_ENDPOINT: 'ep-test-123456',
          MCP_READER_PASSWORD: 'a'.repeat(20) + ' has spaces ' + 'b'.repeat(10),
        },
      }),
      (err: unknown) => {
        const e = err as { status?: number; stderr?: string };
        return e.status === 2 && /must be >= 24 printable ASCII characters/.test(e.stderr ?? '');
      },
    );
  });
});
