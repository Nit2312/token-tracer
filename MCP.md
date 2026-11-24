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

### Production-readiness approval items (must be signed off before `MCP_ENABLED=true` in production)
1. **Consent wording — legal/HR (OPEN).** Technically approved on 2026-11-24 (it matches the access model: a team admin's connected app can read team developers' activity, session metadata and prompt text with sensitive values masked). **Not confirmed as meeting legal or HR requirements** (employee notice, monitoring disclosure, data-protection basis). Owner: product/legal. The text is in `app/oauth/authorize/consent-form.tsx`.
2. R2 (audit actor attribution by a compromised `mcp_auth`), R7, R9 (platform rate limiting for `/oauth/*`), R10.
3. Vercel production `NEXT_PUBLIC_SERVER_URL` / `MCP_PUBLIC_BASE_URL` verification, production migration and role provisioning, new environment variables.
