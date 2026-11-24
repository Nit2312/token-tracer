# Tests

```
npm run test:unit   # no database needed (sets SKIP_DB_TESTS=1 on purpose)
npm run test:db     # database suites only — requires the variables below
npm test            # everything; the database suites FAIL (not skip) if the variables are missing
```

## Database tests: explicit test branch only

Database tests never read `.env`, `.env.local`, `DATABASE_URL`, `NEON_CONNECTION_STRING` or `ANALYST_DATABASE_URL`. Everything
goes through `tests/helpers/test-db.ts`, which requires:

| Variable | Meaning |
|---|---|
| `TEST_DATABASE_URL` | Owner-level **direct** (non-pooled) connection string of a **dedicated test branch**. Used by the isolation, rollup, migration and `analyst_ro` permission suites. |
| `TEST_ANALYST_DATABASE_URL` | `analyst_login` connection string of the **same** test branch (pooled is fine). Used by `analyst-login-db.test.ts`. |
| `TEST_MCP_AUTH_DATABASE_URL` | `mcp_auth` login of the **same** test branch (direct host, same endpoint id; the migration `scripts/migrations/mcp-oauth.sql` and `scripts/setup-mcp-roles.mjs --apply` must have been run on it). Used by `mcp-oauth-db.test.ts`. |
| `TEST_DATABASE_EXPECTED_ENDPOINT` | The test branch's endpoint id (`ep-…`). Must equal the endpoint in both URLs, or the tests refuse to connect. |
| `SKIP_DB_TESTS=1` | Deliberately skip every database suite (the only way to skip). |

Example (never commit values; keep them in a file outside the repo and load it explicitly):

```
env -u DATABASE_URL -u NEON_CONNECTION_STRING -u ANALYST_DATABASE_URL \
  TEST_DATABASE_URL="$(cat ~/.test-branch.url)" TEST_DATABASE_EXPECTED_ENDPOINT=ep-xxxx-xxxx-xxxxxxxx \
  npm run test:db
```

Safety properties (enforced by `tests/test-db-safety.test.ts`):
- Missing/invalid test configuration makes the suite fail immediately with a clear message.
- A test URL pointing at the same endpoint as `DATABASE_URL`/`NEON_CONNECTION_STRING`/`ANALYST_DATABASE_URL` in the environment is refused.
- Importing the helper replaces those three variables with an unreachable placeholder and `SESSION_SECRET` with a test-only value, so
  application code that loads `.env.local` (`lib/team/env.ts`) cannot reach production or reuse its secrets.
- Most suites run inside a transaction on TEMP tables that is rolled back. `rollup-concurrency.test.ts` needs committed tables, so it
  creates and drops a uniquely named scratch schema on the test branch (never `public`).
