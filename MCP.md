# Token Tracer MCP server

Remote [MCP](https://modelcontextprotocol.io) server hosted inside this Next.js app. Status: **Phase 1 (foundation) shipped; Phase 2 (OAuth 2.1) in progress — steps 1–3 written: building blocks, migration, role. Nothing is applied to any database, and `/mcp` still has no authentication.**

## What exists

`POST /mcp` — stateless Streamable HTTP (`@modelcontextprotocol/server` 2.4.0, pinned). It answers `initialize`, `ping` and the
`notifications/initialized` notification, and advertises **empty capabilities**: no tools, resources or prompts, no database access,
no authentication or OAuth yet. 2025-era clients (what Claude speaks today) are served by the SDK's stateless fallback: no session id,
`GET`/`DELETE`/other methods → `405` with `Allow: POST`.

## Feature flag (off by default)

| Variable | Meaning |
|---|---|
| `MCP_ENABLED` | Must be exactly `true` to serve. Otherwise **every method on `/mcp` returns 404**. |
| `MCP_ALLOWED_HOSTS` | Optional, comma-separated hostnames accepted in the `Host` header. Default: the host of `NEXT_PUBLIC_SERVER_URL` (plus `localhost` outside production). If enabled with no allowed host in production, `/mcp` returns 503 (fail closed). |
| `MCP_ALLOWED_ORIGINS` | Optional extra hostnames accepted in a browser `Origin` header. `claude.ai`, `claude.com` and the allowed hosts are always accepted. A request with no `Origin` (server-to-server) is allowed. |

Request guards: Host validation (403), Origin validation (403), JSON content type (415), `Accept` must offer both `application/json` and
`text/event-stream` (406), body limit 64 KiB (413), `MCP-Protocol-Version` validation (400). Responses are `Cache-Control: no-store`.
Logs contain only a fixed rejection category, never request data.

## Code map

- `app/mcp/route.ts` — Node.js runtime route (`maxDuration = 30`), all HTTP methods delegate to the handler.
- `lib/mcp/handler.ts` — flag, configuration, Host/Origin checks, SDK handler. Imports nothing from the application.
- `lib/mcp/config.ts`, `lib/mcp/server.ts` — configuration and the per-request server factory (registers nothing).
- `tests/mcp-foundation.test.ts` — protocol, request-validation, transport, flag and "no application data" tests (no database needed).

## Phase 2 (OAuth 2.1) — decisions and what exists so far

Canonical server URL: `https://token-tracer-three.vercel.app` (resource `…/mcp`). The issuer, resource and token audience come from an explicit
`MCP_PUBLIC_BASE_URL` (to be validated at startup: https, no path) and are **never derived from a request `Host` header**. Both `*.vercel.app`
aliases serve the whole app, so the OAuth and `.well-known` endpoints must also reject any non-canonical `Host`.

Decisions: DCR + static clients (CIMD advertised **false**); hosted callbacks `https://claude.ai/api/mcp/auth_callback` and
`https://claude.com/api/mcp/auth_callback`; loopback `http://localhost|127.0.0.1|[::1][:port]/callback` with a consent warning (port ignored when
matching, per RFC 8252 / OAuth 2.1); PKCE S256 only; access token 30 min, refresh 14 days idle / 60 days absolute, authorization code 60 s;
strict refresh-reuse detection with no grace period; `offline_access` accepted (never stored); OAuth security events → `audit_log` (only via
`mcp_audit_event`), tool-access events → `mcp_access_log`; `mcp_auth` provisioned in Phase 2, `mcp_reader` designed in Phase 4.

Written, not yet applied anywhere: `lib/mcp/oauth/*` (PKCE, secrets, redirect rules, scopes, errors), `lib/security/return-url.ts`,
`scripts/migrations/mcp-oauth.sql` (+ `.rollback.sql`, runner `scripts/migrate-mcp-oauth.mjs`), `lib/mcp/grants.json` +
`scripts/setup-mcp-roles.mjs` (default mode is a printed plan). Required order: migration on a Neon **test branch** → `--verify` → live tests →
review → only then production, with explicit approval and a backup branch.

### Accepted residual risks (revisit before production rollout, Phase 7)

- **R2 — misattributed audit rows.** `mcp_auth` can only write `audit_log` through `mcp_audit_event`, which enforces a fixed event allowlist, an
  `mcp.` action prefix, known target types, a bounded target id, object-only metadata ≤ 2 KiB and a real actor whose username it looks up itself.
  A compromised `mcp_auth` credential can still record a *valid* `mcp.*` event attributed to any existing user, with free-form metadata inside those
  bounds. Mitigation today: the `mcp.` prefix distinguishes these rows; callers pass ids/counts only. Options before rollout: rate-limit the
  function, or drop the caller-supplied actor in favour of an id derived from the token row.
- **R3 — `mcp_access_log` has no event allowlist** (append-only, no prompt text). Add a `CHECK` once Phase 4 defines the event set.
- **R5/R6** — role-level `SET` defaults may not reach pooled sessions (the app must use `SET LOCAL`); Neon needs the role password in plaintext
  in the statement, so rotate it if an apply fails.
- **R1 (open, to be closed by live tests)** — trigger firing and `SECURITY DEFINER` execution privileges are verified only on a Neon test branch.

## Later phases (not implemented)

OAuth 2.1 (Phase 2), tenant-scoped authorization (3), read-only tools (4), audit and rate limits (5), end-to-end tests (6), rollout (7).
Prompt-level data will use a dedicated read-only database role, never the application owner role.

## Phase 2, Step 5 — OAuth HTTP endpoints (implemented; MCP stays disabled)

Routes (all `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`, thin wrappers over `lib/mcp/oauth/endpoints.ts`):

| Route | Method | Purpose |
|---|---|---|
| `/.well-known/oauth-authorization-server` | GET | RFC 8414 metadata (issuer = canonical base URL, S256 only, public clients, CIMD false) |
| `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-protected-resource` | GET | RFC 9728 metadata (`resource` = `<base>/mcp`) |
| `/oauth/register` | POST | RFC 7591 DCR, public clients only; 10/h per hashed IP + 300/h global |
| `/oauth/token` | POST | `authorization_code` + `refresh_token`; form-encoded only; 120/min per IP, 60/min per client |
| `/oauth/revoke` | POST | RFC 7009; always 200 |

Rules every handler enforces, in order: `MCP_ENABLED` off → 404; `MCP_PUBLIC_BASE_URL` missing/invalid → 503 (fail closed); any `Host`/`X-Forwarded-Host` that is not the canonical host → 404 (so the second Vercel alias never serves OAuth). Back-channel endpoints then refuse browser cross-site requests (`Sec-Fetch-Site`), any `Authorization` header or `client_secret`, wrong content types, repeated parameters and oversized bodies — all before any database call. Error bodies are fixed strings; nothing from the request is echoed or logged. `proxy.ts`'s CSRF check only covers `/api/`, so these routes carry their own checks.

New environment variables (NOT set anywhere yet): `MCP_PUBLIC_BASE_URL` (https origin, no path), `MCP_AUTH_DATABASE_URL` (the `mcp_auth` login), optional `MCP_ALLOW_LOOPBACK_REDIRECTS=false` (kill-switch for Claude Code loopback redirects).

Verified on a real `next build` + `next start` (production DB variables forced to an unreachable placeholder, `mcp_auth` of the test branch only): `.well-known` route folders work and coexist with `proxy.ts`; canonical host → 200; the other alias, an unknown host, `localhost` and a spoofed `X-Forwarded-Host` → 404; cross-site → 403; GET on POST-only routes → 405; `/mcp` unchanged.

Known limits: no CORS on the POST endpoints (browser-based clients are not supported; Claude's connectors call server-side); the registration limit is per hashed client address and the global cap can be exhausted by an attacker (registration only — token flows are unaffected).

## Phase 2, Step 6 — consent and login integration (implemented; MCP stays disabled)

Flow: client → `GET /oauth/authorize` → (no session) `/?returnTo=/oauth/authorize?…` → password → TOTP (admins) → back to `/oauth/authorize` → consent page → `POST /oauth/decision` (fetch) → browser navigates to the **server-built** redirect with `code`, `state`, `iss`.

Who may authorize: a **database** account with role `admin` and a team, in a full (MFA-complete), non-impersonated session. Re-read from the database at page view AND at decision time (role/team/active are never trusted from the cookie). Built-in `team`/`superadmin` logins (non-UUID ids), plain users, team-less admins, inactive accounts, impersonation and stale sessions all get a fixed refusal message and no consent token.

Rules worth remembering:
- `client_id` + `redirect_uri` are verified against the registration FIRST. If either is unusable, or any parameter is repeated, the user sees an error page and there is **no redirect**. Every later defect (scope, PKCE, state, resource) is returned to the verified redirect URI as an OAuth error.
- The consent token (`lib/mcp/oauth/consent.ts`) binds one approval to user, login session, client, redirect URI, PKCE challenge, scope, state and resource; 5-minute life; signed with a key derived from the session secret under a separate label, so it can never be accepted as a session cookie (verified by test). Not single-use (see below).
- The decision route requires `Origin == canonical base URL`, `Sec-Fetch-Site` same-origin, JSON, a valid session, and a token minted for that exact user and session. The consent page uses `fetch` because the site CSP has `form-action 'self'`.
- The client name (attacker-controlled via DCR) is rendered only as escaped React text; the page is `frame-ancestors 'none'` / `X-Frame-Options: DENY`.
- Login change (the only edit to existing auth code): the login route honours `returnTo` for **database users only**, only if `safeReturnTo()` accepts it (exactly `/oauth/authorize?…`); the MFA step already carries the signed redirect. The inline login script forwards `?returnTo=`. Everything else (`proxy.ts`, MFA verify, cookies, built-in accounts) is unchanged.
- Authorization responses carry `iss` (RFC 9207, advertised in the metadata).

Verified end to end on a real `next start` (test-branch database only): login → TOTP enrolment → redirect back → consent → decision → token exchange → code-replay revocation; hostile `returnTo` ignored; foreign/missing Origin 403; no session 401; unregistered `redirect_uri` → error page without redirect; non-canonical Host 404; non-admin refused.

Accepted residual risks (Step 6):
- **R7 — consent token replay:** within its 5 minutes, the same logged-in admin can submit one token twice and get two codes for the same client/redirect/PKCE challenge. Useless without the verifier.
- **R8 — re-authentication at consent: RESOLVED (decision 2026-11-24).** The admin must have authenticated (password + TOTP) within the previous **15 minutes** (`GRANT_MAX_LOGIN_AGE_MS`), measured by the session's `issuedAt`, which is set only at login (`proxy.ts` refreshes `lastActive`, never `issuedAt`). Enforced at page view AND again at the click. A session that is valid but older sends the admin to `GET /oauth/reauthenticate`, which clears that session cookie (only if it is stale) and redirects to the normal login with `returnTo`; `app/page.tsx` would otherwise bounce a logged-in admin straight to `/team`. After login the flow returns to consent. Accounts that can never qualify (non-admin, built-in, inactive, no team) are refused directly, not asked to sign in again. A decision made after the window closed returns `login_required` (the page reloads and re-authenticates). Residual: an attacker who has the admin's password AND current TOTP can still consent — that is the authentication assumption, not a session-theft gap.
- **R9 — unauthenticated database cost:** `/oauth/authorize`, `/oauth/token`, `/oauth/register` each cost a database round trip per request; the registration/token limits are per hashed IP and `mcp_auth` has a 3-connection pool. Add platform rate limiting (Vercel Firewall) for `/oauth/*` before enabling in production.
- **R10 — unverified client names:** DCR clients can claim any name; the page says so and shows the real destination.

## Phase 2, Step 7 — bearer authentication on `/mcp` (implemented; MCP stays disabled)

Every `/mcp` request is authenticated from scratch (`lib/mcp/bearer.ts` → `authenticateAccessToken`). Order of checks: `MCP_ENABLED` (404) → valid OAuth config (503) → Host allow-list (403) → **canonical Host** (403; tokens are bound to `<MCP_PUBLIC_BASE_URL>/mcp`, so an allowed-but-non-canonical host is refused) → Origin (403) → bearer token (401/403/503) → SDK. Refused requests never reach the database.

One query per request re-reads the token, the user, their team and the client: token is `kind='access'`, not revoked, not expired (idle and absolute), audience equals the canonical resource; user is **active, role `admin`, and in a team that still exists**; client is not disabled. The same predicate (`ELIGIBLE_USER_SQL` in `tokens.ts`) also gates code exchange and refresh, so a demoted/deactivated/team-less admin can neither use nor obtain tokens. Nothing is cached: a change in the database takes effect on the very next request with the same token (and reverts the same way); the principal's team always comes from the database, never from the token or the request.

Responses (exact strings are pinned by tests):
| Situation | Status | `WWW-Authenticate` |
|---|---|---|
| No `Authorization`, or a non-Bearer scheme | 401 | `Bearer resource_metadata="<base>/.well-known/oauth-protected-resource/mcp", scope="mcp:read"` |
| Bearer token that does not authenticate — unknown, malformed, expired, revoked, rotated/refresh token, wrong audience, user deactivated/demoted/team-less, team deleted, client disabled | 401 | `Bearer error="invalid_token", error_description="The access token is invalid or has expired.", resource_metadata="…", scope="mcp:read"` — **identical for every cause** (no oracle) |
| Valid token without `mcp:read` | 403 | `… error="insufficient_scope" …` |
| Authentication database unavailable | 503 + `Retry-After: 5` | none (a client must not discard a good token) |

Principal → tools: `lib/mcp/context.ts` (`McpToolContext`, frozen, holds the admin principal, **never the token**). The SDK handler is created once and shared (it holds no per-user state; creating one logs a warning); the context reaches `createTokenTracerMcpServer(ctx)` through an `AsyncLocalStorage` scope that lives for one request, and the factory throws if no scope exists (fail closed). Concurrent requests with different tokens are tested not to see each other's principal. Cookies, `X-Team-Id`-style headers and `?access_token=` are never read. No tools are registered, so capability discovery is still empty.

Logging: the only new log line is the fixed text `[mcp] authentication unavailable`; no token, header, error object or database detail is ever logged (guarded by a test that inspects every `console.*` call in `lib/mcp`).

Guards (`tests/mcp-foundation.test.ts`, replacing the Phase 1 "no database" rule): only six modules may import `pg` or run queries (`db.ts`, `oauth/{audit,clients,grant-user,rate-limit,tokens}.ts`); the request-serving modules reach the database only through `bearer.ts`; SQL may name only `users, teams, oauth_*, mcp_rate_limits, mcp_access_log` and never prompt/session/audit tables; environment reads are limited to `MCP_*`, `NODE_ENV`, `NEXT_PUBLIC_SERVER_URL` and (consent only) `SESSION_SECRET`. `mcp_auth` was **not** granted anything new for this step (`--verify` unchanged).

Decisions and residual notes:
- **Ineligible = invalid token (401), not 403.** A demoted admin's token is simply no longer valid; a 403 would imply the token is good. Re-authorization is then refused at consent for the same reason.
- **`last_used_at`** is updated at most every 5 minutes per token (a write on a read path; bounded).
- **No `/mcp` rate limit yet** — Phase 5. An unauthenticated flood costs one database round trip per request with a well-formed token (a missing/malformed header costs none); platform rate limiting (R9) applies.
- The SDK prints one warning at start-up about `responseMode: 'json'`; it contains no request data.

### Connection sizing for `mcp_auth` (found in Step 7 testing; open for production readiness)
`mcp_auth` has `CONNECTION LIMIT 5` and each server instance's pool allows up to 3 connections (`lib/mcp/db.ts`, `max: 3`). Running the live DB test files in parallel exceeded the limit (`53300 too many connections for role "mcp_auth"`); `npm run test:db` is now sequential (`--test-concurrency=1`). The same arithmetic applies in production: several concurrent serverless instances, each opening up to 3 connections, can exhaust 5 and make `/mcp` and `/oauth/*` answer 503 (fail closed, never open). Before enabling in production: point `MCP_AUTH_DATABASE_URL` at the Neon **pooled** (PgBouncer) endpoint, lower the per-instance pool to 1, and set the role's connection limit from measured concurrency (or confirm how Neon counts pooled connections against it). Not changed in this step.

### Production-readiness approval items (must be signed off before `MCP_ENABLED=true` in production)
1. **Consent wording — legal/HR (OPEN).** Technically approved on 2026-11-24 (it matches the access model: a team admin's connected app can read team developers' activity, session metadata and prompt text with sensitive values masked). **Not confirmed as meeting legal or HR requirements** (employee notice, monitoring disclosure, data-protection basis). Owner: product/legal. The text is in `app/oauth/authorize/consent-form.tsx`.
2. R2 (audit actor attribution by a compromised `mcp_auth`), R7, R9 (platform rate limiting for `/oauth/*`), R10, and the `mcp_auth` connection sizing above.
3. Vercel production `NEXT_PUBLIC_SERVER_URL` / `MCP_PUBLIC_BASE_URL` verification, production migration and role provisioning, new environment variables.
