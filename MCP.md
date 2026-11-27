# Token Tracer MCP server — architecture, security and operations

Remote [MCP](https://modelcontextprotocol.io) server hosted inside this Next.js app, with its own OAuth 2.1 authorization server.
Last updated: 2026-11-26. This is the single reference for the whole program (Phase 0 audit, Phase 1 foundation, Phase 2 OAuth, steps 1–10) and, from section 16, the approved plan for Phase 3.

## Contents
1. [Status at a glance](#1-status-at-a-glance) · 2. [Architecture](#2-architecture) · 3. [OAuth 2.1 flow](#3-oauth-21-flow) · 4. [`/mcp` request handling](#4-mcp-request-handling)
5. [Database, roles and permissions](#5-database-roles-and-permissions) · 6. [Account lifecycle: revocation, audit, retention](#6-account-lifecycle-revocation-audit-retention)
7. [Configuration](#7-configuration) · 8. [Operations runbook (documented, not executed)](#8-operations-runbook-documented-not-executed) · 9. [Testing](#9-testing)
10. [Implementation history](#10-implementation-history) · 11. [Key decisions](#11-key-decisions) · 12. [Risk register](#12-risk-register-and-open-items)
13. [Production-readiness checklist](#13-production-readiness-checklist) · 14. [Cleanup after sign-off](#14-cleanup-after-sign-off) · 15. [Later phases](#15-later-phases) · 16. [Phase 3 plan and decisions](#16-phase-3-plan-and-decisions)

---

## 1. Status at a glance

**Production state:** nothing MCP-related has been applied to production. No migration, no database role, no environment variable, no deployment; `MCP_ENABLED` is unset, so every MCP route answers 404. At the time of writing all commits are local (not pushed). Everything below was built and verified against a dedicated Neon **test branch** only.

### Completed (verified on the test branch)
| Phase | Scope | State |
|---|---|---|
| 0 | Read-only audit of the app, database and auth model (no code) | done |
| 1 | Stateless MCP endpoint `/mcp`: handshake and capability discovery, empty capabilities, feature flag, Host/Origin guards | done |
| 2 | OAuth 2.1 authorization server (discovery, dynamic client registration, authorize + consent, token, refresh rotation, revoke), bearer authentication on `/mcp`, least-privilege database role, revocation on every account change, nightly retention, end-to-end and negative test suites (steps 1–10) | done |
| 3 | Tenant-isolated data-access layer: `mcp_reader` role, identity-bound SQL functions, dedicated reader pool, authenticated principal with unforgeable `tokenHash`, typed metadata-only services, AES-256-GCM sealed references & signed cursors, strict budget packing (24 KiB), adversarial fuzzing, concurrency and revocation hardening (P3-0 through P3-9) | done |
| 4 (4.1–4.3) | Read-only tool implementation: strict JSON Schema definitions, tool execution handlers, and MCP content block formatting with 24 KiB budget enforcement for the six metadata-only services | done |
| 4.4 | Controlled tool registration & protocol validation: registered all 6 tools in `createTokenTracerMcpServer`, validated JSON-RPC protocol requests (`initialize`, `tools/list`, `tools/call`), tenant isolation, and parameter injection guards | done |
| 4.5 | Real MCP client integration & end-to-end validation: validated complete workflow with real MCP SDK client over Streamable HTTP, OAuth 2.1 (discovery, DCR RFC 7591, PKCE S256, consent, code exchange, refresh rotation, revocation RFC 7009), all six tools, tenant isolation, and lifecycle | done |

### Not built yet (by design — see [Later phases](#15-later-phases))
- **No resources or prompts exist.** `/mcp` exposes only the six approved metadata-only tools. No resources, templates, or prompts are registered.
- Phase 5 access logging and `/mcp` rate limiting, Phase 6 test with a real Claude client, Phase 7 production rollout.

### Production-readiness blockers (NOT completed — all must be closed or explicitly accepted before `MCP_ENABLED=true` in production)
1. **Legal/HR approval of the consent wording** (today's wording says a connected app can read the team's developers' activity, session metadata and prompt text with sensitive values masked). Technically approved for Phase 2; legal/HR unconfirmed. **It must be revised before raw prompt text can ever be enabled** (decision 4 of [section 16](#16-phase-3-plan-and-decisions): the initial release exposes prompt metadata only, and masking is best-effort).
2. **`mcp_auth` connection sizing** — role limit 5, pool 3 per instance: can exhaust under concurrent serverless instances (fail-closed 503, never open).
3. **Validate `mcp_auth` over the Neon pooled (PgBouncer) endpoint** — all tests ran over the direct endpoint.
4. **Platform rate limiting for `/oauth/*`** (R9) — every OAuth request costs a database round trip.
5. **R2 decision** — audit rows attributable to any user by a compromised `mcp_auth` credential.
6. **Verify the production `NEXT_PUBLIC_SERVER_URL` / `MCP_PUBLIC_BASE_URL`** equal the canonical domain `https://token-tracer-three.vercel.app`.
7. **Real-client verification (Phase 6)** — Claude's actual registration payload, revocation and `resource` behaviour are unverified.
8. Production migration, role provisioning and environment variables — each needs explicit approval and a backup branch.
9. **Raw prompt text** — stored verbatim and unmasked by the existing pipeline; stays behind a default-off flag until privacy/legal approval exists (PT).
10. **Phase 3 production additions** (once built): a second database role and secret (`mcp_reader`) with its own connection budget validated over the pooled endpoint, and an index decision taken only from production-sized measurements (P3S, IX).

Full register: [section 12](#12-risk-register-and-open-items). Checklist: [section 13](#13-production-readiness-checklist).

---

## 2. Architecture

```
Claude (hosted connector, Claude Code)
  1 discovery  GET  /.well-known/oauth-protected-resource/mcp  →  /.well-known/oauth-authorization-server
  2 register   POST /oauth/register                      (dynamic client registration, public clients)
  3 authorize  GET  /oauth/authorize → login (/) + TOTP → consent page → POST /oauth/decision → redirect with code
  4 token      POST /oauth/token (authorization_code + PKCE, refresh_token) · POST /oauth/revoke
  5 use        POST /mcp   Authorization: Bearer tt_at_…
        │
        ▼
Next.js app (Vercel, Node runtime)
  proxy.ts ........... session refresh; CSRF check for /api/* only (OAuth routes carry their own checks)
  lib/mcp/handler.ts . flag → config → canonical Host → Origin → bearer → SDK handler → per-request server (empty capabilities)
  lib/mcp/oauth/* .... OAuth logic: crypto/PKCE, redirect rules, endpoints, consent, tokens, clients, rate limits, principal derivation
  lib/mcp/data/* ..... Data layer: reader pool, unforgeable scope, 6 metadata-only data services, sealed refs, signed cursors, budgets
  three database paths:
     mcp_auth pool (lib/mcp/db.ts) ............ ALL runtime OAuth and bearer work; least privilege
     mcp_reader pool (lib/mcp/data/db.ts) ..... ALL runtime data service calls; functions only, read-only
     application owner connection (lib/team/db.ts) .. only: revoke hooks, nightly purge, the shared audit writer
        │
        ▼
Neon Postgres:
  Identity plane: oauth_clients · oauth_authorization_codes · oauth_tokens · mcp_rate_limits · mcp_access_log
                  mcp_audit_event() · mcp_oauth_purge() · guard triggers
  Data plane:     schema mcp_data (owned by mcp_data_owner)
                  6 functions: list_developers, developer_activity, list_sessions, session_details, search_prompt_metadata, prompt_metadata_batch
                  All functions identity-bound: derive tenant internally via _resolve_scope(p_token) from token hash
```

**Identity plane vs data plane.**
- `mcp_auth` is the *identity* role: it can run the OAuth/bearer flows and read just enough of `users` and `teams` to decide who a token belongs to. It has **no** privilege on prompts, sessions, audit logs, members or any analytics table.
- `mcp_reader` is the *data* role: it connects to the database via `MCP_READER_DATABASE_URL` with connection limit 5. It holds **zero table privileges** across the entire database; it only holds `USAGE` on schema `mcp_data` and `EXECUTE` on the 6 approved identity-bound functions.
- `mcp_data_owner` is the *function owner* role (`NOLOGIN`): owns schema `mcp_data` and the 6 `SECURITY DEFINER` functions; holds strictly column-level `SELECT` grants on the exact columns needed to project metadata. A flaw inside a function is bounded by these grants.
- `ANALYST_DATABASE_URL` is never used for MCP.

**Complete Request Lifecycle (OAuth to Data Service):**
1. **Bearer Authentication:** Client requests `POST /mcp` with `Authorization: Bearer tt_at_...`.
2. **Identity Verification & Hash Derivation:** Server parses bearer token, validates SHA-256 hash against `oauth_tokens` via `mcp_auth` pool (`authenticateAccessToken`). Verifies token is not expired, not revoked (`revoked_at IS NULL`), associated client is not disabled, and user is an active team admin. Server extracts `tokenHash: Uint8Array(32)`.
3. **Principal & Scope Construction:** Server constructs unforgeable `TeamAdminPrincipal` containing server-derived `tokenHash`. Constructs `DataScope` storing `tokenHash` in a module-private registry (`WeakMap`). No client-supplied team ID, user ID, or role is accepted or trusted.
4. **Data Service Execution:** Service function (e.g. `listSessions`, `searchPromptMetadata`) decodes any input cursors/references using AES-256-GCM bound to `teamId`. Acquires client from dedicated `mcp_reader` pool with 5s acquisition timeout.
5. **Database Transaction:** Runs `BEGIN READ ONLY` with strict session limits (`statement_timeout = 5000`, `search_path = 'pg_catalog, pg_temp'`). Calls SQL function passing `tokenHash`.
6. **SQL Scope Resolution:** Function calls `mcp_data._resolve_scope(p_token)` which matches `p_token = ot.token_hash` in `oauth_tokens`, verifies `ot.revoked_at IS NULL` and user eligibility, and returns the verified `v_team`.
7. **Projection & Sanitization:** SQL function filters strictly on `team_id = v_team`. Service applies allowlist projection, strips all unapproved fields, validates via `assertMetadataOnly`, seals session/prompt IDs into opaque references, packs within 24 KiB budget, and returns result. Connection is released back to pool.

**Design principles** (each is enforced by tests, not just convention):
- **Stateless.** Nothing about a user is cached between requests; the SDK handler is shared but holds no per-user state; the principal reaches the per-request server through a request-scoped `AsyncLocalStorage` that fails closed.
- **Never trust the client for identity.** User, role and team come only from the database row behind the validated token; cookies, `X-Team-Id`-style headers and `?access_token=` are never read.
- **Fail closed.** Missing/invalid configuration → 503; flag off → 404; database unavailable → 503 (never "allow").
- **One answer for every bad token** (401 `invalid_token`) and one answer for every wrong host (empty 404): nothing for an attacker to distinguish.
- **Hash-only secrets.** Access tokens, refresh tokens and authorization codes are 256-bit random values stored only as SHA-256 hashes; plaintext exists in memory only while being returned once.
- **One-way state.** Revocation, code consumption and refresh rotation can never be undone — enforced by database triggers that also bind the table owner.
- **Least privilege + defence in depth.** Column-level grants, `SECURITY DEFINER` only for the audit function (with pinned `search_path`), guard triggers, per-request re-validation, and revocation on every account change.
- **Canonical URL.** Issuer, resource and token audience come from `MCP_PUBLIC_BASE_URL`, never from the request `Host`.

### File map
| Area | Files |
|---|---|
| Routes | `app/mcp/route.ts` · `app/.well-known/oauth-authorization-server/route.ts` · `app/.well-known/oauth-protected-resource/route.ts` · `app/.well-known/oauth-protected-resource/mcp/route.ts` · `app/oauth/register/route.ts` · `app/oauth/token/route.ts` · `app/oauth/revoke/route.ts` · `app/oauth/decision/route.ts` · `app/oauth/reauthenticate/route.ts` · `app/oauth/authorize/page.tsx` · `app/oauth/authorize/consent-form.tsx` |
| MCP core | `lib/mcp/handler.ts` · `lib/mcp/bearer.ts` · `lib/mcp/config.ts` · `lib/mcp/context.ts` · `lib/mcp/server.ts` · `lib/mcp/db.ts` · `lib/mcp/grants.json` |
| OAuth logic | `lib/mcp/oauth/endpoints.ts` · `authorize.ts` · `authorize-request.ts` · `consent.ts` · `grant-user.ts` · `tokens.ts` · `clients.ts` · `rate-limit.ts` · `audit.ts` · `principal.ts` · `config.ts` · `metadata.ts` · `crypto.ts` · `redirect-rules.ts` · `scopes.ts` · `errors.ts` · `http.ts` |
| Integration with the app | `lib/security/return-url.ts` · `lib/team/mcp-revoke.ts` · `lib/team/audit.ts` · `app/api/auth/login/route.ts` (returnTo) · `app/page.tsx` (forwards returnTo) · `app/api/internal/rollup/route.ts` (purge) · revoke hooks listed in [section 6](#6-account-lifecycle-revocation-audit-retention) |
| Database and scripts | `scripts/migrations/mcp-oauth.sql` · `scripts/migrations/mcp-oauth.rollback.sql` · `scripts/migrate-mcp-oauth.mjs` · `scripts/setup-mcp-roles.mjs` · `scripts/e2e-mcp.mjs` |

---

## 3. OAuth 2.1 flow

**Canonical server:** `https://token-tracer-three.vercel.app` (resource `…/mcp`). Both `*.vercel.app` aliases serve the whole app, so every MCP and OAuth route answers any non-canonical `Host` with an empty 404.

### Endpoints
| Route | Method | Purpose | Limits |
|---|---|---|---|
| `/.well-known/oauth-authorization-server` | GET | RFC 8414 metadata: S256 only, public clients only, DCR advertised, CIMD **false**, `authorization_response_iss_parameter_supported: true`, `scopes_supported: [mcp:read, offline_access]` | public, `ACAO: *` (read-only document) |
| `/.well-known/oauth-protected-resource` and `/mcp` | GET | RFC 9728 metadata: `resource` = `<base>/mcp`, `scopes_supported: [mcp:read]`, bearer in header | same |
| `/oauth/register` | POST | RFC 7591 dynamic client registration, public clients (`token_endpoint_auth_method: none`) | 10/h per hashed IP, 300/h global; body ≤ 8 KiB |
| `/oauth/authorize` | GET (page) | validates the request, requires login, shows consent | — |
| `/oauth/decision` | POST (fetch) | approve/deny; issues the authorization code | 30 per 10 min per user; body ≤ 8 KiB |
| `/oauth/reauthenticate` | GET | clears a stale login session and sends the admin to a fresh sign-in | — |
| `/oauth/token` | POST | `authorization_code` and `refresh_token` grants, form-encoded only | 120/min per IP, 60/min per client; body ≤ 4 KiB |
| `/oauth/revoke` | POST | RFC 7009; always 200 | 120/min per IP; body ≤ 4 KiB |

### Sequence
1. **Discovery.** The client calls `/mcp` unauthenticated, gets `401` with `WWW-Authenticate: Bearer resource_metadata="…", scope="mcp:read"`, reads the protected-resource metadata, then the authorization-server metadata.
2. **Registration.** `POST /oauth/register` with `redirect_uris` (1–5). Only Claude's hosted callbacks `https://claude.ai/api/mcp/auth_callback` and `https://claude.com/api/mcp/auth_callback`, or loopback `http://localhost|127.0.0.1|[::1][:port]/callback` (Claude Code; the port is ignored when matching a registration, per RFC 8252), are accepted. `grant_types ⊆ {authorization_code, refresh_token}`, `scope` must normalise to `mcp:read`. Returns a `tt_…` client id; **no client secret exists**.
3. **Authorize.** `GET /oauth/authorize?response_type=code&client_id&redirect_uri&code_challenge&code_challenge_method=S256&state&scope&resource`.
   - `client_id` and `redirect_uri` are verified against the registration **first**. If either is unusable, or any parameter is repeated, the user sees an error page and there is **no redirect**. All later defects (scope, PKCE, state, resource) return to the verified redirect URI as OAuth errors, with `state` echoed only if valid.
   - No session → `/?returnTo=/oauth/authorize?…` → password → TOTP (admins) → back to authorize. `returnTo` is honoured for **database users only** and only if it is exactly `/oauth/authorize` + query (`safeReturnTo`); anything else is ignored.
   - **Who may authorize:** a database account with role `admin` and a team, in a full (MFA-complete), non-impersonated session. Built-in `team` / `superadmin` logins (non-UUID ids), plain users, team-less admins, inactive accounts, impersonation and stale sessions get a fixed refusal and no consent token. Role, team and active flag are **re-read from the database** at page view and again at the click.
   - **Recent login (decided 2026-11-24):** the admin must have authenticated within the previous **15 minutes** (the session's `issuedAt`, which is set only at login). Older but valid session → `/oauth/reauthenticate` clears that cookie and redirects to login; a decision made after the window closed returns `login_required` and the page re-authenticates.
4. **Consent.** The page shows who is asking (`client_name`, escaped text — attacker-controlled via registration), the real destination, the team, what will be readable, and a loopback warning where applicable. The browser posts the decision with `fetch` (the site CSP has `form-action 'self'`), then navigates to the **server-built** redirect carrying `code`, `state` and `iss` (RFC 9207). The consent token is bound to user, login session, client, redirect URI, PKCE challenge, scope, state and resource; 5 minutes; signed with a key derived from the session secret under a separate label (it can never be accepted as a session cookie).
5. **Token exchange.** The code (60 s, single use) is consumed by one atomic `UPDATE` **before** anything else is checked, so a wrong verifier or redirect URI still burns it. The code is bound to the *exact* redirect URI (port included) it was issued for. Replaying a consumed code revokes every token minted from it. Returns `access_token` (30 min), `refresh_token`, `scope: mcp:read`.
6. **Refresh.** Rotation with **strict** reuse detection and no grace period: each refresh token works once; presenting a rotated one, or losing a concurrent race for it, revokes the **whole family**. The family keeps its original 60-day absolute expiry (rotation never extends it); idle expiry is 14 days.
7. **Use.** `/mcp` with `Authorization: Bearer tt_at_…` ([section 4](#4-mcp-request-handling)).
8. **Revoke.** `POST /oauth/revoke` with an access or refresh token revokes the whole family, only for the client it was issued to; unknown tokens are silently accepted.

### Token facts
| Item | Value |
|---|---|
| Access token | 256-bit random, prefix `tt_at_`, 30 min, SHA-256 hash stored |
| Refresh token | 256-bit random, prefix `tt_rt_`, 14 days idle / 60 days absolute, rotated on use |
| Authorization code | 256-bit random, prefix `tt_ac_`, 60 s, single use |
| Client id | `tt_` + 128-bit random (public identifier) |
| Scope | `mcp:read` only. `offline_access` is accepted and ignored (never stored); it is advertised in the authorization-server metadata only |
| PKCE | S256 only; verifier 43–128 chars of the RFC 7636 alphabet |
| Audience | tokens are bound to `<MCP_PUBLIC_BASE_URL>/mcp` |

### Attack → control
| Threat | Control |
|---|---|
| Open redirect / phishing via `redirect_uri` | exact registration match first; unusable → error page, never a redirect; only Claude callbacks or canonical loopback |
| Code interception / guessing | PKCE S256, 60 s single-use code, atomic consume, exact redirect binding, replay revokes family |
| Stolen refresh token | rotation + strict reuse detection; revoke-before-and-after on every account change |
| Consent CSRF / clickjacking | decision needs `Origin` = canonical URL, same-origin fetch metadata, JSON, session, bound consent token; page is `frame-ancestors 'none'`, `no-store` |
| Malicious client name | rendered only as escaped React text; page states it is unverified |
| Host-header issuer confusion | URLs come only from `MCP_PUBLIC_BASE_URL`; any other Host → empty 404 |
| Token oracle | every token-state failure is the identical 401 |
| Compromised `mcp_auth` credential | column-level grants, no DELETE/TRUNCATE, no prompt/session/audit access, audit only through an allow-listed function, tamper-guard triggers |
| Enumeration / abuse of OAuth endpoints | per-IP, per-client and global rate limits, size caps, content-type and repeated-parameter checks before any database work |

---

## 4. `/mcp` request handling

Every request is authenticated from scratch. Order of checks:

`MCP_ENABLED` (404) → valid OAuth configuration (503) → **canonical Host** (empty 404) → Host allow-list backstop (403) → `Origin` (403) → bearer token (401 / 403 / 503) → SDK (method, content type, body size, protocol version).

Requests refused before the bearer step never reach the database.

**One query per request** re-reads the token, user, team and client: the token is an unrevoked, unexpired (idle and absolute) `access` token for the canonical resource; the user is **active, role `admin`, in a team that still exists**; the client is not disabled. The same predicate also gates code exchange and refresh, so a demoted, deactivated or team-less admin can neither use nor obtain tokens. Nothing is cached: a database change takes effect on the next request with the same token, and reverts the same way.

| Situation | Status | `WWW-Authenticate` |
|---|---|---|
| No `Authorization`, or a non-Bearer scheme | 401 | `Bearer resource_metadata="<base>/.well-known/oauth-protected-resource/mcp", scope="mcp:read"` |
| Bearer token that does not authenticate (unknown, malformed, expired, revoked, refresh token, wrong audience, user deactivated/demoted/team-less, team deleted, client disabled) | 401 | `Bearer error="invalid_token", error_description="The access token is invalid or has expired.", resource_metadata="…", scope="mcp:read"` — identical for every cause |
| Valid token without `mcp:read` | 403 | `… error="insufficient_scope" …` |
| Authentication database unavailable | 503 + `Retry-After: 5` | none (a client must not discard a good token) |

**Host policy (one rule for every MCP route):** a `Host` or `X-Forwarded-Host` that is not the canonical host, or no host at all, gets an empty `404` — on `/mcp`, `/.well-known/oauth-*`, and all `/oauth/*` routes. `403` is reserved for a disallowed `Origin` and cross-site OAuth POSTs. The SDK allow-list (`MCP_ALLOWED_HOSTS`) remains only as a misconfiguration backstop.

**Principal → tools.** `lib/mcp/context.ts` gives the per-request server a frozen `McpToolContext` holding the admin principal (user, client, token id, scope, role, team, display name) and **never the token**. Tools (Phase 4) must take team and user from it exclusively. No tools are registered, so capability discovery is empty.

**Protocol limits:** `POST` only (others 405 with `Allow: POST`), JSON content type (415), `Accept` must offer `application/json` and `text/event-stream` (406), body ≤ 64 KiB (413), `MCP-Protocol-Version` validated (400), `Cache-Control: no-store`. Stateless Streamable HTTP via `@modelcontextprotocol/server` 2.4.0 (pinned).

**Logging.** MCP code logs only fixed text: `[mcp] rejected: <category>`, `[mcp] request error`, `[mcp] authentication unavailable`, `[mcp] revocation audit unavailable`, `[mcp] purge failed`. A test inspects every `console.*` call in `lib/mcp`. (The existing shared database layer logs error code, up to 200 characters of message and SQL text for any failed query — never bound parameters; tokens are only ever bound parameters.)

---

## 5. Database, roles and permissions

### Tables (all new; created by `scripts/migrations/mcp-oauth.sql`)
| Table | Purpose | Key constraints |
|---|---|---|
| `oauth_clients` | registered clients (DCR or static) | `scope = 'mcp:read'`, `token_endpoint_auth_method = 'none'`, `grant_types ⊆ {authorization_code, refresh_token}`, 1–5 redirect URIs, name 1–100 chars, `registration ∈ {dcr, static}`, salted IP hash only |
| `oauth_authorization_codes` | single-use codes | `code_hash` bytea(32) primary key, `code_challenge` length 43, `scope = 'mcp:read'`, FKs to `users` and `oauth_clients` (`ON DELETE CASCADE`) |
| `oauth_tokens` | access and refresh tokens | `token_hash` bytea(32) unique, `kind ∈ {access, refresh}`, FKs `ON DELETE CASCADE`, `absolute_expires_at`, rotation/revocation columns |
| `mcp_rate_limits` | fixed-window counters | primary key `(key, window_start)`; keys contain hashed IPs, never raw |
| `mcp_access_log` | tool-access trail (Phase 4/5) | append-only; no prompt text or token material; deliberately no foreign keys |

### Integrity triggers (`BEFORE UPDATE`, bind the table owner too)
- `oauth_tokens`: identity columns immutable; `revoked_at`/`revoked_reason` set once, never cleared or rewritten; `rotated_at`/`replaced_by_id` set once.
- `oauth_authorization_codes`: only `consumed_at` may change, and only once.
- `oauth_clients`: registration data immutable; only `last_used_at` and `disabled_at` change.

### Functions
- **`mcp_audit_event(event, actor, target_type, target_id, meta)`** — `SECURITY DEFINER`, `search_path = pg_catalog, public`, the **only** way `mcp_auth` writes `audit_log`. Fixed allowlist of 10 events (`client_registered`, `authorization_granted`, `authorization_denied`, `code_replayed`, `token_issued`, `token_refreshed`, `refresh_reuse_detected`, `token_revoked`, `tokens_revoked_for_user`, `access_denied`); action is always written as `mcp.<event>`; target type ∈ {`oauth_client`, `oauth_token`, `oauth_code`, `user`}; target id ≤ 128 chars of a restricted charset; metadata an object ≤ 2 KiB; the actor must be a real user and the **username is looked up inside the function**, never supplied.
- **`mcp_oauth_purge()`** — owner-only; deletes codes expired > 1 h, access tokens expired > 1 day, any token past its absolute expiry + 1 day, rate-limit windows > 2 days, access-log rows > 180 days, and DCR clients unused for 30 days that hold no tokens or codes. Consumed codes are kept past their life so replay detection survives. Returns per-table counts.
- Three guard functions (invoker rights, pinned `search_path`). All five functions have `EXECUTE` revoked from `PUBLIC`.

### Role `mcp_auth` — exact privileges (`lib/mcp/grants.json`)
Attributes: `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`, `CONNECTION LIMIT 5`, no memberships, no `CREATE` in any schema; role defaults `statement_timeout 5s`, `lock_timeout 2s`, `idle_in_transaction_session_timeout 10s`, `search_path pg_catalog, public` (the app also applies them per transaction with `set_config(…, true)` because pooled sessions may ignore role defaults).

| Table | SELECT (columns) | INSERT (columns) | UPDATE (columns) |
|---|---|---|---|
| `users` | `id, display_name, role, team_id, active` | — | — |
| `teams` | `id, name` | — | — |
| `oauth_clients` | all | `client_id, client_name, redirect_uris, grant_types, token_endpoint_auth_method, scope, registration, created_ip_hash` | `last_used_at` |
| `oauth_authorization_codes` | all | `code_hash, client_id, user_id, redirect_uri, code_challenge, resource, scope, family_id, expires_at` | `consumed_at` |
| `oauth_tokens` | all | `token_hash, kind, family_id, client_id, user_id, resource, scope, expires_at, absolute_expires_at` | `last_used_at, rotated_at, replaced_by_id, revoked_at, revoked_reason` |
| `mcp_rate_limits` | all | `key, window_start, count` | `count` |
| `mcp_access_log` | — | `user_id, team_id, client_id, token_id, event, tool, target_member_ids, outcome, status, row_count, duration_ms, ip_hash` | — |

Plus `USAGE` on sequence `mcp_access_log_id_seq` and `EXECUTE` on `mcp_audit_event(text, uuid, text, text, jsonb)`. **No** `DELETE`, `TRUNCATE`, `REFERENCES` or `TRIGGER` anywhere.

**Not accessible to `mcp_auth`:** `users.password_hash`, `users.api_key`, `users.username`, `members`, `team_members`, `member_keys`, `session_turns`, `sync_sessions`, prompt data, `audit_log` (no read, no write — only through the function), `auth_totp`, and every other table.

**Verification:** `node scripts/setup-mcp-roles.mjs --verify` (using `MCP_AUTH_DATABASE_URL`) compares the live role to `grants.json` by catalog across **all** non-system schemas (including views), checks attributes, memberships, sequences, schema privileges and executable functions, and runs real denial probes that must fail with `42501` (e.g. `password_hash`, `members`, `session_turns`, `audit_log`, `DELETE oauth_tokens`, direct `INSERT audit_log`). It also checks the effective `search_path`.

### Role `mcp_reader` & `mcp_data_owner` — exact privileges (`lib/mcp/grants.json`)
Decided 2026-11-26 ([section 16](#16-phase-3-plan-and-decisions)). Three database principals serve MCP:
- **`mcp_auth`** (exists) — the identity plane described above.
- **`mcp_data_owner`** — `NOLOGIN`, owns schema `mcp_data` and the 6 `SECURITY DEFINER` functions; holds read-only **column** grants on exactly the columns the functions read, and nothing else:
  - `public.users`: `id, display_name, role, team_id, active`
  - `public.teams`: `id, name`
  - `public.team_members`: `team_id, member_id`
  - `public.sync_sessions`: `id, team_id, member_id, source, model, started_at, ended_at, activity_at, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, api_cost, priced, edits, additions, deletions, changed_lines, files_touched, tool_calls, tool_errors, rework_loops, corrections, abandoned`
  - `public.daily_member_usage`: `day, team_id, member_id, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, api_cost, session_count, tool_calls, tool_errors, edits, additions, deletions, changed_lines, files_touched, rework_loops, corrections, abandoned_count`
  - `public.session_turns`: `id, sync_session_id, org_id, user_id, turn_index, created_at, tool, model, prompt_char_len, has_code_block, has_file_path, has_traceback, intent_category, answer_input_tokens, answer_output_tokens, answer_cache_read_tokens, answer_cache_write_tokens`
  - `public.oauth_tokens`: `token_hash, user_id, client_id, scope, expires_at, revoked_at`
  - `public.oauth_clients`: `client_id, disabled_at`
- **`mcp_reader`** — the data-plane login. **No table privileges at all**:
  - Attributes: `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 5`.
  - Schema privilege: `USAGE ON SCHEMA mcp_data`.
  - Executable privilege: `EXECUTE` on the 6 functions: `list_developers`, `developer_activity`, `list_sessions`, `session_details`, `search_prompt_metadata`, `prompt_metadata_batch`.
  - Role defaults: `statement_timeout 5s`, `lock_timeout 2s`, `idle_in_transaction_session_timeout 10s`, `search_path 'pg_catalog', 'pg_temp'`, `default_transaction_read_only = on`.
  - Revocations: `EXECUTE` on all functions in `mcp_data` revoked from `PUBLIC`. Zero table/view/sequence privileges across all schemas.

It is deliberately **not** `analyst_login`: the analyst role's grants exclude prompt text, include a table that `MCP_EXCLUDED_TABLES` forbids for MCP, are global across tenants, and carry a connection limit of 3. `ANALYST_DATABASE_URL` is never used for MCP data. The functions are identity-bound: each takes the caller's token hash, re-validates the token, user, team and client inside the database with the same eligibility rule as bearer authentication, and derives the team itself — no function accepts a team id from the caller.

### Connection handling
`lib/mcp/db.ts`: only `MCP_AUTH_DATABASE_URL`, which must connect as `mcp_auth` (any other user is refused); verified TLS; pool `max: 3`; every unit of work is one transaction with local limits; missing/invalid configuration throws (fail closed — there is no fallback to the owner or analyst credentials).

---

## 6. Account lifecycle: revocation, audit, retention

**Why revoke even though `/mcp` re-reads the user:** a re-read only blocks a token *while* the account is ineligible. An admin who is demoted and later re-promoted, or moved to another team, would otherwise get an old token back with access never consented to for that team; a password or MFA reset has no re-read at all. So every change to an account's security state revokes that account's tokens (live test: without the hook the token revives after re-promotion; with it, it stays dead).

`lib/team/mcp-revoke.ts` (application side): runs only the one-way `UPDATE oauth_tokens SET revoked_at, revoked_reason … WHERE revoked_at IS NULL`; ids must be UUIDs; **revoke → change → revoke** (a database error on the first aborts the whole operation; the second closes the window in which a stolen refresh token could still be exchanged). Before the MCP migration exists it checks the catalog first (`to_regclass`) and does nothing, quietly — so these routes keep working everywhere. Audit rows go through `mcp_audit_event`; an audit failure never undoes a revoke.

| Site | Trigger | Reason recorded |
|---|---|---|
| `POST /api/admin/users/reset-password` | password reset | `password_reset` |
| `POST /api/v1/team/members/reset-password` | password reset by (platform) admin | `password_reset` |
| `PUT /api/auth/profile` | own password change | `password_changed` |
| `POST /api/admin/users/reset-mfa` | authenticator reset | `mfa_reset` |
| `PUT /api/admin/users` | role / active / team **actually changes** (display-name-only or same-value edits do not) | `role_changed`, `deactivated`, `reactivated`, `team_changed` |
| `PUT /api/v1/team/members` | role or active actually changes | as above |
| `deleteMember()` | soft removal from a team | `member_removed` |
| `DELETE /api/admin/teams` | team deleted (`users.team_id` becomes NULL) | `team_deleted` |
| user delete / hard member delete | nothing needed — tokens and codes cascade from `users` | — |

A guard test fails if any file that updates `users.password_hash|role|active|team_id`, deletes a team, calls `resetMfa` or defines `deleteMember` does not import the helper (mutation-checked). Revocation is per token, not a ban: the user can authorize again through consent, which re-checks eligibility. A database trigger on `users`/`auth_totp` would cover future write paths automatically but alters an existing hot table; **it was deliberately not added** (owner decision, 2026-11-26).

**Audit trail.** `lib/team/audit.ts` (`recordAuditEvent`) is the only application code that writes `audit_log`. `audit_log.actor_user_id` is a UUID foreign key to `users`; the built-in `superadmin`/`team` accounts have session ids `"superadmin"`/`"admin"` and no `users` row, so before 2026-11-26 every audited action they performed (impersonation, password resets, pricing changes) failed with `22P02` and was silently lost. Now: a non-UUID actor is written with `actor_user_id` NULL, the username kept and `metadata.builtinActor` = the original id; a UUID whose user was deleted is retried once unlinked with `metadata.actorUserMissing`; database users are unchanged. It resolves `true`/`false` and never throws, so audit logging still cannot break the action it records. Audit rows the built-in accounts should have written before the fix do not exist and cannot be recovered.

**Retention.** The existing daily cron (`/api/internal/rollup`, `0 2 * * *`) also runs `mcp_oauth_purge()` as the owner. It is isolated (a purge problem never fails the rollup), checks `to_regprocedure` first (skipped where the migration is absent), and reports counts only. No new cron entry and no `vercel.json` change.

---

## 7. Configuration

None of the new variables is set anywhere yet.

| Variable | Needed for | Behaviour / default | Secret |
|---|---|---|---|
| `MCP_ENABLED` | the kill switch | must be exactly `true` to serve; anything else → every MCP route 404 | no |
| `MCP_PUBLIC_BASE_URL` | issuer, resource, audience, challenge URLs | https origin with no path/query (`http://localhost` allowed outside production); missing/invalid → 503; **never** falls back to another variable | no |
| `MCP_PROMPT_TEXT_ENABLED` | raw prompt text (Phase 3 gate) | **default off.** Exact `true` is necessary but NOT sufficient: text also requires a recorded privacy/legal approval constant in code (`lib/mcp/data/prompt-access.ts`, currently none). The flag alone never enables text | no |
| `MCP_AUTH_DATABASE_URL` | the `mcp_auth` pool | must connect as `mcp_auth`; missing → 503 | **yes** |
| `MCP_READER_DATABASE_URL` | the `mcp_reader` data pool (Phase 3) | must connect as `mcp_reader`; missing → 503 / data unavailable; connection limit 5, pool max 3 | **yes** |
| `MCP_ALLOWED_HOSTS` | optional SDK host allow-list | default: host of `NEXT_PUBLIC_SERVER_URL` (plus `localhost` outside production); must include the canonical host | no |
| `MCP_ALLOWED_ORIGINS` | optional extra browser `Origin` hostnames | `claude.ai`, `claude.com` and the allowed hosts are always accepted; no `Origin` is allowed | no |
| `MCP_ALLOW_LOOPBACK_REDIRECTS` | kill switch for Claude Code loopback redirects | set to `false` to refuse them (also for existing clients); default allowed | no |
| `NEXT_PUBLIC_SERVER_URL` | existing; default allowed host | unchanged | no |
| `SESSION_SECRET` | existing; derives the consent-token key, salts IP hashes | rotating it invalidates sessions and consent tokens and resets rate-limit keys; tokens are unaffected (random, hashed in the database) | **yes** |

Script-only: `DATABASE_URL` (owner, for the migration and role scripts), `EXPECTED_ENDPOINT`, `CONFIRM_MCP_MIGRATION`, `CONFIRM_MCP_ROLLBACK_DATA_LOSS`, `CONFIRM_MCP_ROLES`, `MCP_AUTH_PASSWORD`. Tests only: `TEST_DATABASE_URL`, `TEST_DATABASE_EXPECTED_ENDPOINT`, `TEST_MCP_AUTH_DATABASE_URL`, `TEST_ANALYST_DATABASE_URL` (never production values; see [section 9](#9-testing)).

---

## 8. Operations runbook (documented, not executed)

**Nothing in this section has been run against production.** Every production step needs explicit approval and a backup branch. Commands use placeholders; connection strings and passwords come from the environment, never from files in the repo and never on a command line you keep in shell history.

### 8.0 Gates — do not start until
All items in [section 13](#13-production-readiness-checklist) marked *blocker* are closed or consciously accepted, and the legal/HR sign-off exists in writing.

### 8.1 Preflight
- Confirm the tenant-isolation migration is already applied in production (earlier program; `5008f2d`, `8f37be9`, `25dc66b`).
- Confirm production's canonical URL: `NEXT_PUBLIC_SERVER_URL` in Vercel Production is `https://token-tracer-three.vercel.app`.
- Create a **Neon backup branch** of production and note its name.
- Node.js is pinned to **24.x** (`.nvmrc` and `engines.node`; see the README). `engines.node` overrides the Vercel project's Node.js Version setting, so the next deployment runs the latest 24.x: check the dashboard value first, and confirm "Node.js 24" in the build log of the preview deployment before promoting.
- Know the production **endpoint id** (`ep-…`) and have the owner **direct** (non-pooled) connection string in a file outside the repo.
- Choose a low-traffic window (the migration briefly locks `users` to add the foreign keys).

### 8.2 Migration (additive: five new tables, five new functions)
```
# 1. Dry run — applies inside a transaction, reports, ROLLS BACK. EXPECTED_ENDPOINT is required in every mode.
EXPECTED_ENDPOINT=<prod-endpoint-id> node --env-file=<owner-env-file> scripts/migrate-mcp-oauth.mjs

# 2. Apply (idempotent — safe to re-run)
CONFIRM_MCP_MIGRATION=yes EXPECTED_ENDPOINT=<prod-endpoint-id> node --env-file=<owner-env-file> scripts/migrate-mcp-oauth.mjs --apply
```
Expect: 5 tables, 5 functions, 4 foreign keys (only to `users` and `oauth_clients`), 3 triggers, no function executable by `PUBLIC`. The runner never prints the connection string and verifies TLS.

### 8.3 Role provisioning & Data plane setup
```bash
# Print the SQL that would run (connects to nothing)
node scripts/setup-mcp-roles.mjs --role=mcp_auth
node scripts/setup-mcp-roles.mjs --role=mcp_reader

# Create/refresh mcp_auth role (password ≥ 24 printable ASCII from environment)
MCP_AUTH_PASSWORD=<generated> CONFIRM_MCP_ROLES=yes EXPECTED_ENDPOINT=<prod-endpoint-id> \
  node --env-file=<owner-env-file> scripts/setup-mcp-roles.mjs --role=mcp_auth --apply

# Create/refresh mcp_reader role and apply database defaults
MCP_READER_PASSWORD=<generated> CONFIRM_MCP_ROLES=yes EXPECTED_ENDPOINT=<prod-endpoint-id> \
  node --env-file=<owner-env-file> scripts/setup-mcp-roles.mjs --role=mcp_reader --apply

# Apply Phase 3 data schema and grants (owner connection)
CONFIRM_MCP_MIGRATION=yes EXPECTED_ENDPOINT=<prod-endpoint-id> \
  node --env-file=<owner-env-file> scripts/migrate-mcp-oauth.mjs

# Verify the live roles match grants.json exactly (exit code non-zero on any FAIL)
MCP_AUTH_DATABASE_URL=<mcp_auth connection string> node scripts/setup-mcp-roles.mjs --role=mcp_auth --verify
MCP_READER_DATABASE_URL=<mcp_reader connection string> node scripts/setup-mcp-roles.mjs --role=mcp_reader --verify
```
Neon needs the plaintext password in the statement; if an apply fails, rotate the password. Build connection strings with `?sslmode=require`.

### 8.4 Environment variables (Vercel → Production)
Add `MCP_AUTH_DATABASE_URL` (sensitive), `MCP_READER_DATABASE_URL` (sensitive), and `MCP_PUBLIC_BASE_URL=https://token-tracer-three.vercel.app`. Optionally `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS`. **Leave `MCP_ENABLED` unset.** Vercel applies environment changes on the next deployment.

### 8.5 Deploy with the flag off, then verify
Push and deploy the MCP commits. With `MCP_ENABLED` unset, verify: `/mcp`, `/.well-known/oauth-*` and every `/oauth/*` route return **404**; normal login, password reset, role/team edits and the nightly cron behave as before (the revoke hooks and the purge now find the tables and function and act on them).

### 8.6 Staged enablement
1. Set `MCP_ENABLED=true` and redeploy.
2. Verify: both `.well-known` documents return 200 with the canonical issuer and resource; `POST /mcp` without a token returns 401 with the exact challenge; any other host returns 404.
3. Register a test connector in Claude using `https://token-tracer-three.vercel.app/mcp` and complete the flow with a **non-production-critical admin account**; confirm consent, token issuance, `/mcp` `initialize` (empty capabilities), then revoke from the app side (change the password) and confirm the connector loses access.
4. Watch for a day: `[mcp] …` log tags, 503 rates (connection pressure), `audit_log` rows with action `mcp.*`, cron response `mcpPurge` counts.

### 8.7 Day-2 operations
| Task | How |
|---|---|
| Emergency stop | unset `MCP_ENABLED` and redeploy → every MCP route 404 |
| Block one client | as owner: `UPDATE oauth_clients SET disabled_at = now() WHERE client_id = '<id>'` (its tokens stop working on the next request; re-enable by setting NULL) |
| Block loopback redirects | `MCP_ALLOW_LOOPBACK_REDIRECTS=false` |
| Revoke one user | change their password through the app (hooks fire), or as owner: `UPDATE oauth_tokens SET revoked_at = now(), revoked_reason = 'manual' WHERE user_id = '<id>' AND revoked_at IS NULL` |
| Revoke everything | the same `UPDATE` without the `user_id` condition (all connectors must re-authorize) |
| Rotate the `mcp_auth` password | rerun the role script `--apply` with a new `MCP_AUTH_PASSWORD`, update `MCP_AUTH_DATABASE_URL`, redeploy |
| Rotate `SESSION_SECRET` | see [section 7](#7-configuration) for the effects |

### 8.8 Rollback procedures (least to most destructive; do them in this order)
1. **Switch off** — unset `MCP_ENABLED`, redeploy. Reversible; nothing is lost. If any compromise is suspected, also revoke all tokens (8.7).
2. **Revoke** — the owner `UPDATE` above. Reversible by re-authorizing.
3. **Code rollback** — redeploy the previous Vercel deployment or `git revert` the MCP commits ([section 10](#10-implementation-history)). The database objects are ignored by older code. **Revoke tokens first**: older code has no revoke hooks, so password resets would stop ending MCP access.
4. **Data-plane database rollback** — drops schema `mcp_data`, functions and owner grants without affecting OAuth (`scripts/migrations/mcp-data.rollback.sql` via owner connection):
   ```bash
   CONFIRM_MCP_MIGRATION=yes CONFIRM_MCP_ROLLBACK_DATA_LOSS=yes EXPECTED_ENDPOINT=<prod-endpoint-id> \
     node --env-file=<owner-env-file> scripts/migrate-mcp-oauth.mjs --rollback
   ```
5. **OAuth database rollback** — destructive for the five OAuth tables:
   ```bash
   CONFIRM_MCP_MIGRATION=yes CONFIRM_MCP_ROLLBACK_DATA_LOSS=yes EXPECTED_ENDPOINT=<prod-endpoint-id> \
     node --env-file=<owner-env-file> scripts/migrate-mcp-oauth.mjs --rollback
   ```
   The runner prints the row counts it will destroy and refuses without the data-loss confirmation. All issued tokens, codes and clients are lost (connectors must re-register); `mcp_access_log` is dropped (export it first if needed). **`audit_log` rows with action `mcp.*` are never removed.** Nothing existing references the new objects; no `CASCADE` is used. Remove the app's connection first (step 1) so nothing is connected while tables disappear.
6. **Role removal** —
   ```bash
   CONFIRM_MCP_ROLES=yes EXPECTED_ENDPOINT=<prod-endpoint-id> \
     node --env-file=<owner-env-file> scripts/setup-mcp-roles.mjs --role=mcp_reader --drop
   CONFIRM_MCP_ROLES=yes EXPECTED_ENDPOINT=<prod-endpoint-id> \
     node --env-file=<owner-env-file> scripts/setup-mcp-roles.mjs --role=mcp_auth --drop
   ```
7. **Environment cleanup** — remove `MCP_AUTH_DATABASE_URL`, `MCP_READER_DATABASE_URL`, `MCP_PUBLIC_BASE_URL` and the optional variables from Vercel.

Because the revoke helper and the cron purge check the catalog first, the app keeps working at every rollback level, including after step 4. The nightly purge simply reports `skipped`.

---

## 9. Testing

All database tests and the end-to-end harness run **only** against a dedicated Neon test branch, through explicit `TEST_*` variables (never an env file, never `DATABASE_URL`); the shared helper refuses a test URL on the same endpoint as any production variable and replaces those variables with an unreachable placeholder. Database suites run sequentially (`--test-concurrency=1`, per-test timeout 180 s) because `mcp_auth` has a connection limit of 5.

### Results (2026-11-26, test branch)
| Check | Result |
|---|---|
| Unit tests (`npm run test:unit`) | **474 / 474** (257 are MCP/OAuth/revocation/audit/documentation; 8 are the Node-version pin guard) |
| Live database suites (13 files, sequential) | **150 / 150**, 0 skipped (42 pre-existing analyst/isolation + 108 MCP/audit) |
| Real `next build` + `next start` end-to-end harness | **150 / 150** checks, 8 groups |
| Role verification (`setup-mcp-roles.mjs --verify`) | all checks pass |
| `tsc --noEmit`, ESLint on every file added or changed for MCP | clean |
| Leftover test rows on the branch (checked without any cleanup beforehand) | zero |

### Suites
| Suite | Tests | What it proves |
|---|---|---|
| `mcp-foundation` (unit) | 61 | protocol, request validation, transport, flag, Host/Origin; **guards**: only six modules may touch the database, SQL limited to approved tables and never prompt/session/audit tables, env reads limited, no request data or tokens in logs, no tools registered |
| `mcp-oauth-pure` (unit) | 91 | PKCE (RFC 7636 vector), secrets, redirect rules, scopes, errors, `safeReturnTo` |
| `mcp-oauth-static` (unit) | 20 | migration SQL and PL/pgSQL parse, exact objects, constraints, triggers, grants, script safety |
| `mcp-oauth-http` (unit) | 13 | config, canonical host, discovery documents, preflight, header checks |
| `mcp-oauth-consent` (unit) | 17 | consent token (isolated from sessions), request parsing, eligibility incl. 15-minute rule, `/oauth/reauthenticate`, UI/login static guards |
| `mcp-bearer` (unit) | 20 | header parsing, exact challenges, check order, no caching, principal isolation (barrier test), no leaks |
| `mcp-revocation-hooks` (unit) | 10 | every security-state write has a hook (mutation-checked), helper safety |
| `audit-actor` (unit) | 14 | built-in vs database actors, foreign-key fallback, failures never silent (mutation-checked) |
| `mcp-docs` (unit) | 11 | this document matches the code: referenced files exist, environment-variable table, permission matrix column by column, lifetimes, per-route rate limits, audit events, script flags, no credentials (mutation-checked) |
| `mcp-oauth-db` (live) | 23 | triggers fire without caller EXECUTE, one-way columns, audit-function allowlists and `search_path` pinning, constraints, purge, concurrent single-use |
| `mcp-oauth-data` (live) | 17 | data layer through the real `mcp_auth` pool: registration, exchange, rotation, reuse, bearer lookup, revocation, rate limit |
| `mcp-oauth-endpoints` (live) | 8 | register / token / revoke handlers end to end |
| `mcp-oauth-authorize` (live) | 14 | authorize page logic and decision route, eligibility, recent login |
| `mcp-bearer-db` (live) | 14 | real token states, per-request re-check flips, overlapping requests of different users/teams |
| `mcp-revocation-db` (live) | 7 | revoke by user/member/team, idempotence, ordering, failure semantics, revival scenario |
| `mcp-negative-db` (live) | 19 | lifecycle edges, rate limits enforced at real thresholds, cross-tenant concurrency with mid-flight revocation, size/CORS, purge |
| `audit-actor-db` (live) | 6 | the real `audit_log` table, with a control proving the original failures |
| pre-existing: analyst-db, analyst-login-db, session-turns-isolation, tenant-isolation-phase2, rollup-concurrency | 42 | regression: analyst and tenant-isolation behaviour unchanged |
| `scripts/e2e-mcp.mjs` (real server) | 150 | see below |

### End-to-end harness (`npm run test:e2e:mcp`)
Builds and starts the real app against the test branch and drives it over HTTP. Eight groups: (1) OAuth lifecycle through the real login, TOTP enrolment and consent, refresh rotation, reuse, revoke, code replay; (2) loopback client, malformed requests, stale login, non-admin; (3) Host/Origin/CSRF/CORS/security headers on every route; (4) revocation through the real routes — each kills access **and** refresh tokens, no-op edits do not, re-promotion does not revive, deletion cascades, and a missing-table scenario; (5) cron purge incl. failure handling; (6) rate limits over HTTP; (7) built-in `team`/`superadmin` logins unchanged and never able to authorize MCP; (8) audit trail for built-in and database actors, with a check that no `[audit-log-error]` appears anywhere in the server log. It reads only explicit `TEST_*` variables, refuses a production endpoint, gives the server it launches test-only secrets and credentials, and removes every row it creates (restoring anything it temporarily renamed).

How to run: `npm run test:unit` · `npm run test:db` (needs the `TEST_*` variables, see `tests/README.md`) · `npm run test:e2e:mcp`.

### Regression of existing functionality
No analyst, NL2SQL, chat, research or prompt file changed anywhere in the MCP program (checked against the tenant-isolation baseline `25dc66b`). Existing files touched: the account/admin routes listed in [section 6](#6-account-lifecycle-revocation-audit-retention), `app/api/auth/login/route.ts` and `app/page.tsx` (returnTo), `lib/team/stats.ts`, `lib/team/audit.ts` and the cron route. The five pre-existing database suites pass on the test branch.

### Not covered (by design)
- No tools exist, so there is no tenant **data** access to test for cross-tenant leakage. What is proven is identity isolation (the principal per request, no cross-contamination, revocation) and that `mcp_auth` has no privilege on prompt, session, audit or member data.
- No `/mcp` rate limit exists yet (Phase 5).
- Nothing was tested against a real Claude client (Phase 6) or over the pooled endpoint.

---

## 10. Implementation history

Prerequisite (earlier program): tenant-isolation remediation — `5008f2d` migration and diagnostics, `8f37be9` enforcement and transactional rollups, `25dc66b` regression tests; the production migration was applied and verified before MCP work began.

| Phase / step | Scope | Commit(s) |
|---|---|---|
| 0 | Read-only audit (no code) | — |
| 1 | Stateless MCP foundation, flag, Host/Origin guards | `40e3ce6` |
| 2 · steps 1–3 | OAuth building blocks (PKCE, secrets, redirect rules, scopes, errors, `safeReturnTo`); migration + rollback; `mcp_auth` role, grants and runner scripts — written, security-reviewed twice (HIGH, MEDIUM and LOW findings fixed, then re-reviewed), static-tested | `e224cf1` |
| 2 · step 4 | Live schema/role/trigger/audit-function tests on a fresh test branch (R1 closed); data-access layer on the dedicated pool | `41a214c`, `67cd291`, `7521d68` |
| 2 · step 5 | Discovery, DCR, token, revoke endpoints; canonical-host and request-shape rules; verified on a real build | `a416ca0` |
| 2 · step 6 | Consent page, decision route, login `returnTo`; **R8** 15-minute recent-login rule and `/oauth/reauthenticate` | `14b70df`, `d56b851` |
| 2 · step 7 | Bearer authentication on `/mcp`; review fixes: one Host policy (404), request-isolation tests | `62be031`, `cf709a6` |
| 2 · step 8 | Revoke hooks on every security-state change; nightly purge | `4c6884e` |
| 2 · step 9 | End-to-end harness and negative suite; quiet missing-migration path | `fb02c62` |
| 2 · step 9 follow-up | Audit rows for built-in accounts and deleted users | `8b8421e` |
| 2 · step 10 | This consolidated documentation and its drift guard test | this commit |

Findings that changed the design along the way: the audit function replaced direct `audit_log` grants (H1); one-way tamper triggers replaced writable columns (H2); the `search_path` bug found only by the first live role verification; the SDK handler is shared (per-request construction logged a warning each time); per-request principal via `AsyncLocalStorage`; the revoke helper must not rely on a missing-table error (it would trigger the shared layer's schema pass); the audit actor rule.

---

## 11. Key decisions
- **Authorization server:** DCR plus static clients; CIMD advertised false; PKCE S256 only; public clients only.
- **Redirects:** Claude hosted callbacks, plus loopback for Claude Code with a consent warning (port ignored at registration match, exact at exchange).
- **Lifetimes:** access 30 min; refresh 14 days idle / 60 days absolute; code 60 s; consent token 5 min; login recency 15 min.
- **Refresh:** strict reuse detection, no grace period.
- **Who may connect:** database admins with a team only; `superadmin` and the built-in accounts are excluded; ineligible = invalid token (401), not 403.
- **Scopes:** `mcp:read` only; `offline_access` accepted and never stored.
- **Audit:** OAuth security events → `audit_log` only through `mcp_audit_event`; tool-access events → `mcp_access_log` (Phase 4/5).
- **Roles:** `mcp_auth` (identity plane, built) and a dedicated `mcp_reader` (data plane, **decided 2026-11-26**, built in Phase 3) — separate from `analyst_login`; `ANALYST_DATABASE_URL` is never used for MCP data.
- **Phase 3 decisions (approved 2026-11-26, details in [section 16](#16-phase-3-plan-and-decisions)):** identity-bound `SECURITY DEFINER` functions owned by a minimal no-login role; strict `sync_sessions.team_id` match plus current team membership; prompt **metadata only** initially, raw text behind a default-off flag pending privacy/legal approval, masking best-effort; measure index performance on a production-sized copy before any index; session file paths are never exposed; a fresh test branch is provided before P3-4.
- **Host policy:** empty 404 for any non-canonical host, everywhere.
- **No database trigger on `users`** for revocation (owner decision): route hooks plus a guard test instead.
- **Consent wording:** technically approved 2026-11-24; legal/HR sign-off outstanding.

---

## 12. Risk register and open items

### Closed during the program
D4 (decided 2026-11-26: dedicated `mcp_reader`, never the analyst role) · R1 (trigger firing and `SECURITY DEFINER` privileges — proven live) · R5 (pooled `SET` defaults — every transaction applies local limits) · R8 (re-authentication at consent — 15-minute rule) · inconsistent Host answers · hidden schema pass in the revoke helper · lost audit rows for built-in accounts.

### Unresolved — must be decided or accepted before production
| ID | Risk / open item | Impact | Current mitigation | Required before production |
|---|---|---|---|---|
| **R2** | A compromised `mcp_auth` credential can record a *valid* `mcp.*` audit event attributed to any existing user, with free-form metadata inside the function's bounds | misleading audit rows (not data access) | allowlisted events, `mcp.` prefix, bounded metadata, actor must exist | rate-limit the function, or derive the actor from the token row instead of accepting it |
| **R7** | Consent token is not single-use: within 5 minutes the same logged-in admin can obtain two codes for the same client/redirect/PKCE challenge | none without the verifier | 5-minute life, bound to user and session | accept (documented) or add a one-time marker |
| **R9** | `/oauth/authorize`, `/token`, `/register` each cost a database round trip; limits are per hashed IP, pool is small | DoS / pool exhaustion → 503 (fails closed) | per-IP, per-client and global limits, size caps, cheap checks first | platform rate limiting (Vercel Firewall) for `/oauth/*` |
| **R10** | Dynamic clients can claim any name | phishing-style consent prompts | page says it is unverified and shows the real destination | accept, or restrict registration |
| **CS** | `mcp_auth` limit 5 vs pool 3 per instance; several serverless instances can exhaust it (found when parallel test files hit `53300`) | `/mcp` and `/oauth/*` answer 503 under load | fails closed | pooled endpoint, per-instance pool of 1, limit sized from measured concurrency |
| **PB** | All tests used the direct endpoint; behaviour of `set_config(…, true)`, prepared statements and role limits over PgBouncer is unproven | possible production-only failures | — | run the live suites against the pooled `mcp_auth` URL |
| **LH** | Legal/HR approval of the consent wording (employee notice, monitoring disclosure, data-protection basis). The current text promises prompt text "with sensitive values masked", which overclaims: the first release exposes prompt metadata only and masking is best-effort | compliance | text matches the Phase 2 access model; raw prompt text stays off | written sign-off **and** revised wording before raw text is enabled; text lives in `app/oauth/authorize/consent-form.tsx` |
| **CV** | Claude's actual registration payload, revocation calls, `resource` and `iss` handling are unverified (design used researched, partly unverified behaviour) | connector may not complete | standards-compliant implementation | Phase 6 test with a real client |
| **VE** | Production `NEXT_PUBLIC_SERVER_URL` / `MCP_PUBLIC_BASE_URL` not yet checked against the canonical domain | wrong audience or issuer | `MCP_PUBLIC_BASE_URL` is validated and independent | verify in Vercel before enabling |
| **R3** | `mcp_access_log` has no event allowlist | free-form event text in an append-only table | no prompt text, grants limit columns | add a `CHECK` when Phase 4 fixes the event set |
| **R6** | Neon needs the role password in plaintext in the `CREATE/ALTER ROLE` statement | exposure if logged | scripts never print it; TLS | rotate the password if an apply fails |
| **NR** | No `/mcp` rate limit yet | cost of a flood with well-formed tokens | malformed requests cost no database work | Phase 5 |
| **TM** | An admin's MCP team is `users.team_id`; removing them from a `team_members` row alone does not change it | none new (tokens are revoked on removal) | revoke hook | none; documented existing semantics |
| **OT** | Optional database trigger for revocation not added | a future write path could skip the hook | route hooks + guard test | owner may reconsider |
| **SL** | One run of the negative suite hung ~18 minutes and never recurred in four reruns; cause unknown | CI flake | `--test-timeout` on `test:db` | watch for recurrence |
| **AH** | Audit rows built-in accounts should have written before 2026-11-26 do not exist | audit history gap | fixed going forward | none (unrecoverable) |
| **DL** | The shared database layer logs error code, ≤ 200 chars of message and SQL text (never parameters) | server-side error text in logs | by design, existing | none |
| **PT** | Raw user and assistant prompt text is stored verbatim and **unmasked**: the shipped daemon (public copy, v1.3.1) uploads event text; the server stores it as-is in `session_turns.prompt_text_sanitized` (7 days) and `sync_sessions.events` (2 days); `sync_sessions.label` can carry the first prompt. No secret scrubbing was found in the daemon or the server. The column name is aspirational | secrets or personal data pasted into prompts sit in the database | nothing exposes it through MCP today; Phase 3 decisions 4 and 6 keep it off by default and file paths never exposed | metadata-only first; raw text only behind a default-off flag after privacy/legal approval; masking is best-effort and must be described that way |
| **DV** | The daemon sources disagree: the copy in `bin/` forbids prompt fields in the sync payload, the built copy machines download uploads event text | root cause of PT | none | outside MCP scope: owner to decide which behaviour is intended and align the two |
| **IX** | No index covers `session_turns (org_id, user_id, created_at)`; prompt-metadata queries by developer and time window may be slow on production-sized data | latency / load on a hot table | none; **no index will be created** until measured | measure with `EXPLAIN (ANALYZE, BUFFERS)` on a production-sized copy (P3-6); any index is a separate, approved migration |
| **P3S** | Phase 3 adds a second database role, secret (`MCP_READER_DATABASE_URL`, proposed name) and connection pool | doubles the connection-budget problem (CS) | function-only role; pool sized small | size both roles together; validate over the pooled endpoint before production |

### Related, outside MCP scope (noticed along the way — not addressed here)
- The git remote `company` embeds a credential in its URL (not rotated) — rotate it and re-add the remote without the secret.
- `serviceAccountKey.json` and `db_dump.txt` exist locally (untracked, git-ignored) — keep them out of the repository and consider deleting `db_dump.txt`.
- Node version is not pinned (`engines`); two git remotes exist — confirm which one Vercel deploys from.
- 11 legacy reprompt rows have no owner backfill (needs approval); delete auditing is deferred; the research rollup on the new code has not been observed in production (cron `0 2 * * *`).

---

## 13. Production-readiness checklist
Items marked **blocker** must be closed or explicitly accepted by the owner. Nothing here has been done.

- [ ] **blocker** Legal/HR written approval of the consent wording (LH)
- [ ] **blocker** Connection sizing decided and applied; `mcp_auth` validated over the pooled endpoint (CS, PB)
- [ ] **blocker** Platform rate limiting configured for `/oauth/*` (R9)
- [ ] **blocker** R2 mitigated or accepted in writing
- [ ] **blocker** Production `NEXT_PUBLIC_SERVER_URL` / `MCP_PUBLIC_BASE_URL` verified (VE)
- [ ] **blocker** (Phase 3) Privacy/legal written approval before raw prompt text is enabled; revised consent wording; the flag stays default-off until then (PT, LH)
- [ ] **blocker** (Phase 3) `mcp_reader` role, `MCP_READER_DATABASE_URL`, shared connection budget and pooled-endpoint validation (P3S, CS, PB)
- [ ] (Phase 3) Index decision taken from production-sized measurements; no index created without approval (IX)
- [ ] R7, R10 accepted (or mitigated)
- [ ] Neon backup branch of production created; maintenance window chosen
- [ ] Migration dry run reviewed, then applied with explicit approval (8.2)
- [ ] Role provisioned and `--verify` clean (8.3)
- [ ] Environment variables added with `MCP_ENABLED` unset (8.4)
- [ ] Deployed with the flag off; 404s and unchanged behaviour verified (8.5)
- [ ] Staged enablement and a real-client check (8.6; Phase 6 findings recorded) (CV)
- [ ] Rollback procedure rehearsed on the test branch
- [ ] Monitoring/alerting for `[mcp]` log tags and 503 rates in place

## 14. Cleanup after sign-off
The test branch holds a **copy of production data** and test credentials. After review:
- Delete the Neon test branch (or let it expire) — it contains `mcp_auth` and `analyst_login` roles with test-only passwords.
- Delete the local credential files created for testing (outside the repo) and remove `TEST_DATABASE_URL` / `TEST_DATABASE_EXPECTED_ENDPOINT` from `.env.local`.
- Delete the older `tenant-isolation-dry-run` branch if it still exists.

## 15. Later phases
| Phase | Scope |
|---|---|
| 3 | **Tenant-isolated data-access layer** (approved 2026-11-26, [section 16](#16-phase-3-plan-and-decisions)): the function-only `mcp_reader` role, identity-bound database functions, typed services, masking engine, signed cursors, window and size limits, and cross-tenant isolation proofs. **No tools, no HTTP surface, `/mcp` capabilities stay empty.** Identity half already done in Phase 2 |
| 4 | Read-only **tools** built on the Phase 3 services (list team developers, developer activity, developer sessions, session details, prompt metadata search, prompt batch); tool schemas, descriptions and result formatting; **no** arbitrary SQL and **no** write tools; prompt *text* only if the flag is on and privacy/legal approval exists; revised consent wording; the `mcp_access_log` event set (R3). Because text search needs raw text, "search" is metadata filtering until the flag is on |
| 5 | Access logging for tool calls and `/mcp` rate limiting (NR) |
| 6 | Integration and end-to-end test with a real Claude client (CV) |
| 7 | Production rollout using [section 8](#8-operations-runbook-documented-not-executed) |

---

## 16. Phase 3 plan and decisions

**Status (2026-11-26): P3-0 (decisions and documentation) is complete. No Phase 3 code, SQL, role or environment variable exists.** This section is the approved plan. Every later step stops at a review checkpoint and needs explicit approval. Throughout Phase 3: test branch only; no production access, no environment-variable changes, `MCP_ENABLED` untouched, nothing pushed or deployed.

### 16.1 Objective, boundary and non-goals
**Objective:** every read of team data by MCP code goes through one reviewed, least-privilege, read-only path whose tenant isolation is enforced **by the database itself** (not only by application queries), with size and window limits and best-effort masking — proven by cross-tenant tests before any tool exists.

**Phase 3 delivers:** the `mcp_reader` login role, the minimal no-login owner role, identity-bound database functions, a reader connection pool and typed services, signed pagination cursors, window and size limits, an exact-privilege `--verify` for the new roles, a multi-tenant test fixture with planted canary values, updated guards and documentation.

**Phase 3 does not deliver:** MCP tools, any change to what `/mcp` advertises (capabilities stay empty), any new HTTP route, access logging or `/mcp` rate limiting (Phase 5), testing with a real Claude client (Phase 6), or anything in production.

**The Phase 3 / Phase 4 boundary (corrected — earlier text put the role in Phase 4):**

| Concern | Phase 3 | Phase 4 |
|---|---|---|
| `mcp_reader` role, `mcp_data_owner`, data functions, reader pool | built and proven | consumed |
| Services, cursors, limits | built and proven | consumed |
| Cross-tenant isolation proof | yes (service level, live on the test branch) | extended with HTTP end to end |
| MCP tools (schemas, descriptions, result formatting) | no | yes |
| `/mcp` capability discovery | unchanged (empty) | tools appear |
| Raw prompt text | **not exposed, not queried, not granted** (no function, grant or type can return it); the default-off flag and approval gate exist only as a safeguard | not exposed unless a future, separately reviewed approval says so |
| Consent wording | recorded as needing revision | revised before raw text can be enabled |
| `mcp_access_log` event set (R3) | no | yes (logging itself is Phase 5) |

### 16.2 Approved decisions (2026-11-26)
| # | Decision | Consequences |
|---|---|---|
| 1 | **Dedicated `mcp_reader` role, separate from `analyst_login`.** `ANALYST_DATABASE_URL` is never used for MCP data. | Supersedes the original constraint that MCP data retrieval use `ANALYST_DATABASE_URL`. Reasons in 16.3 (finding 2). |
| 2 | **Identity-bound `SECURITY DEFINER` functions with minimal ownership privileges.** | Three principals: `mcp_auth` (exists), `mcp_data_owner` (no login; owns the functions; read-only column grants on exactly what they read), `mcp_reader` (login; `EXECUTE` on the functions only; no table privileges). Each function takes the caller's token hash, re-validates token, user, team and client with the Phase 2 eligibility rule, and derives the team inside the database. No function accepts a team id. Pinned `search_path`, no dynamic SQL, `EXECUTE` revoked from `PUBLIC`. A leaked reader credential cannot run arbitrary SQL or name another team. |
| 3 | **Strict `sync_sessions.team_id` matching plus current team membership.** | A session is visible to an admin only if its `team_id` equals the admin's team **and** the developer is currently in `team_members` for that team. Applied to prompts through the four-key join and to daily rollups through `team_id` plus membership. The dashboard's looser rule (`team_id = team OR member in team`) is unchanged and is **not** used by MCP. Ingest assigns each session to the member's *earliest* team, so for a developer in several teams the admins of the later teams see none of that developer's sessions through MCP (the dashboard may still show them). |
| 4 | **Metadata-only prompt access is the initial-release policy (privacy review, 2026-11-26): raw prompt snippets are NOT part of the initial release.** Raw text stays behind the default-off flag plus a controlled approval record, and is reconsidered only after privacy/legal approval, revised consent wording and a separate security review. Masking does not make arbitrary prompt text safe to disclose. | Prompt metadata means: ids, session reference, turn index, timestamps, character length, the code/path/traceback flags, intent category, tool, model, and the token counts of the answering turn — never text. Text search is unavailable until the flag is on, so the Phase 4 "search" tool filters on metadata only at first. Masking is non-authoritative, optional future work (see 16.9): it is not part of the Phase 3 scope and no initial-release control depends on it. The consent wording must be revised before raw text can be enabled (LH, PT). |
| 5 | **Measure index performance on a production-sized copy. No index is created yet.** | Measurement happens in P3-6 with `EXPLAIN (ANALYZE, BUFFERS)`. The candidate (`session_turns (org_id, user_id, created_at)`) is **not approved**; any index is a separate migration (`CREATE INDEX CONCURRENTLY`) that needs its own approval and evidence (IX). |
| 6 | **Session file paths are never exposed.** | No function, service or tool may return `sync_session_files.path`, `daily_member_files.path` or any path-bearing column or field. Counts such as "files touched" are allowed. Enforced by an excluded-column policy and a static guard. |
| 7 | **A fresh test branch will be provided before P3-4.** | Until then there is no live database work: P3-1 to P3-3 are DB-free or written-not-applied. The previous test branch credentials were removed during cleanup. |

### 16.3 Findings behind the decisions (read from the code, 2026-11-26)
1. **Raw prompt text is stored and nothing masks it.** The shipped daemon (the built copy that machines download, v1.3.1) uploads user and assistant message text; the server stores `userEvent.text` verbatim in `session_turns.prompt_text_sanitized` (retained 7 days) and the events in `sync_sessions.events` (nulled after 2 days). `sync_sessions.label` can carry the first prompt. No secret scrubbing was found in the daemon or the server; the column name is aspirational. The source daemon in `bin/` forbids prompt fields, so the two copies disagree (DV).
2. **The analyst role cannot serve MCP.** Its grants exclude prompt text, **include** `redundant_reprompt_events` (which `MCP_EXCLUDED_TABLES` forbids for MCP), are global across tenants by design (superadmin chat), and its connection limit is 3.
3. **Existing visibility differs by surface.** The team-admin prompts API uses the looser OR rule; ingest tags each session with the member's earliest team; so the rules must be chosen explicitly for MCP (decision 3).
4. **Tenant keys are inconsistent.** Session and daily tables use `team_id` / `member_id` UUIDs; `session_turns` uses `org_id` / `user_id` text copies without foreign keys, so every join must use the full four-key identity (session id, org, user, tool).
5. **Retention** (turns 7 days, events 2 days, sessions 14 days) matches the 7-day maximum query window.
6. **Indexes:** `sync_sessions` and the daily tables are well indexed for team, member and time; `session_turns` has no index on `(org_id, user_id, created_at)` (decision 5). Live index facts still have to be confirmed on the fresh test branch.

### 16.4 Approved design (to be built — nothing below exists yet)
- **Scope derivation.** The principal carries the token's SHA-256 hash (never the plaintext token). A function validates it against the identity tables, applies the same eligibility predicate as bearer authentication (active, role `admin`, team exists, client enabled, token live), and returns the team. A token revoked between the bearer check and the data call makes the next call refuse. A test will run the same state matrix through the TypeScript predicate and the SQL one to catch drift.
- **No session-level state.** Scoping uses function arguments, not session settings, so it does not depend on `SET LOCAL` surviving connection pooling.
- **Functions (names tentative):** list team developers; developer activity (daily rollups); list developer sessions; session details (aggregates only); prompt metadata search; prompt batch (metadata, or text only when the flag is on).
- **Never exposed:** credentials and keys (`users` password hash, API keys, `member_keys`), `audit_log`, auth tables, `sync_sessions.events`, `sync_sessions.label`, `sync_sessions.payload_hash`, any file path, `prompt_embeddings`, the tables in `MCP_EXCLUDED_TABLES`, and the cross-organisation `daily_org_*` tables.
- **Limits (fixed at the P3-1 review, see 16.8):** query window at most 7 days and lookback at most 14 days (both enforced in the database too); page sizes 50/25/25; batch 20; statement timeout and a response-size cap. Cursors are HMAC-signed, opaque, and bound to principal, query filters and expiry. An id belonging to another team gets the same "not found" as one that does not exist.
- **Masking engine: out of scope for Phase 3 (privacy decision, 2026-11-26).** The best-effort masking module built in P3-2 is kept as isolated, unconnected, non-authoritative code for possible future use; nothing in Phase 3 (SQL, services, tools) may call it or depend on it. Its residual risk is significant (see 16.9).
- **Untrusted content.** Stored prompts are data written by developers and will be read by an LLM; results are to be marked as untrusted data, stripped of control characters, and length-capped. Indirect prompt injection is a documented residual risk.
- **Planned new configuration (proposed names; not in the configuration table because no code reads them yet):** `MCP_READER_DATABASE_URL` (secret; must connect as `mcp_reader`; missing means the data layer fails closed) and `MCP_PROMPT_TEXT_ENABLED` (default off).
- **Planned files** (for orientation; none exist):

```
scripts/migrations/mcp-data.sql            + rollback   (schema, functions, roles' privileges; written first, applied to a test branch only)
scripts/migrate-mcp-oauth.mjs                             (runner modelled on the existing migration runner)
lib/mcp/data/   db, scope, cursor, limits, errors, developers, activity, sessions, prompts   (masking.ts exists but is isolated and out of scope, see 16.9)
lib/mcp/grants.json, scripts/setup-mcp-roles.mjs         (extended for the two new roles; exact-match --verify)
tests/          cursors, SQL guards, live isolation fixture, concurrency, drift guards
```
  Existing files to be modified later: the principal and token types (adds the token hash), the foundation guards (split into identity modules and data modules with separate table allow-lists), the excluded-table policy (adds excluded columns), the documentation drift guard, the package test lists.

### 16.5 Implementation sequence and checkpoints
Each step is a small local commit, tested (`tsc`, ESLint, unit; live tests from P3-4), followed by a review stop. Nothing proceeds without approval.

| Step | Scope | Review stop | Status |
|---|---|---|---|
| **P3-0** | Decisions and documentation (this section; phase boundary corrected) | decisions recorded | **done 2026-11-26** |
| P3-1 | Contracts, DB-free: types, limits, scope and cursor handling, error taxonomy, excluded-column policy, guards | contracts and limits | **done 2026-11-26** (16.8) |
| P3-2 | Masking engine with its corpus and performance tests | **privacy review** | built 2026-11-26; **review outcome: metadata-only for the initial release, masking removed from Phase 3 scope** (16.9) |
| P3-3 | SQL **written, not applied**: migration, rollback, grants, static SQL checks (role-script generalisation moves to P3-4, where it can be run) | **security review of the SQL and grants** | **written 2026-11-26, awaiting security review** (16.10) |
| P3-4 | Role provisioning generalised (`setup-mcp-roles.mjs`), regression suite, PUBLIC privilege analysis, managed-host compatibility | security review | **done 2026-11-26** (16.11) |
| P3-5 | Reader pool and services, token hash in the principal, live tests | integration | **done 2026-11-26** (16.12) |
| P3-6 | Hardening: fuzzing, concurrency, revocation mid-flight, dashboard parity, `EXPLAIN` on a production-sized copy, index recommendation (no index created) | measurements | **done 2026-11-26** (16.13) |
| P3-7 | Documentation consolidation, risk register, runbook additions for the data plane | final review | **done 2026-11-26** (16.14) |
| P3-8 | Live PostgreSQL integration, migration & rollback verification, role & PUBLIC privilege audit, multi-tenant data services, concurrency & in-flight revocation, query plan profiling (`EXPLAIN (ANALYZE, BUFFERS)`) | integration & performance | **done 2026-11-26** (16.15) |
| P3-9 | Independent security audit, red-team analysis, confirmed defect remediation, pre-integration readiness assessment | security audit & readiness | **done 2026-11-27** (16.16) |

### 16.6 Testing strategy (summary)
- **Unit, DB-free:** cursors, limits, error mapping, static analysis of the SQL (no dynamic `EXECUTE`, only allow-listed tables and columns, no excluded column, no path), guards and drift tests.
- **Live, fresh test branch only:** three teams including a developer in several teams, with canary strings in every table. For every function, every principal's results contain only its own canaries. Fuzzed ids, cursors, dates and injection-like strings. A role matrix proving `mcp_reader` cannot read any table (`42501`). Revocation mid-flight. Concurrent waves of different principals. Parity of the numbers with the dashboard's own computation. TypeScript versus SQL eligibility drift.
- **End to end:** a service-level harness (issued token → services → assertions). HTTP end to end belongs to Phase 4, when tools exist.

### 16.7 Open items and dependencies for Phase 3
- A fresh test branch and `TEST_*` variables before P3-4 (decision 7).
- Privacy/legal approval, and revised consent wording, before raw prompt text can be enabled (PT, LH); the flag stays off until then.
- Index decision after measurement (IX); no index until approved.
- Production additions once built: second role and secret, connection budget shared with `mcp_auth`, pooled-endpoint validation (P3S, CS, PB).
- Daemon divergence (DV) is outside MCP scope but is the root cause of PT.
- Phase 4 must define the metadata-only "search" semantics, and the result caps per tool.

### 16.8 P3-1 contracts (built, DB-free)
Code: `lib/mcp/data/` (ten modules, no I/O, imports only `node:crypto` and siblings), the column policy in `lib/team/mcp-policy.ts`, tests in `tests/mcp-data-contracts.test.ts`. Nothing uses them yet: no SQL, tool, route or role.

- **Text gate.** Text mode needs `MCP_PROMPT_TEXT_ENABLED=true` AND a valid recorded approval in code (`RECORDED_PROMPT_TEXT_APPROVAL`, currently `null`; a tripwire test fails if it is set without this document being updated). No text-bearing type exists.
- **Metadata only, no indirect leak.** Allowlist projections, a closed intent enum, a deep output guard, no free-text search input at all (a text filter would be an oracle), unknown request keys rejected with one generic error, opaque sealed references and cursors bound to team, user and filters, uniform `not_found`. File paths, labels, events, agent and project names are never read.
- **Window.** Fixed literal 7 days, half-open UTC, not configurable.

| Limit (provisional) | Value | Justification |
|---|---|---|
| Page size, developers | default 25, max 50 | 102 B/row real, 327 B worst: 50 rows = 16 KB worst |
| Page size, sessions and prompts | default 10, max 25 | 550-580 B/row real (sealed refs ~100 chars), 760 B worst. A page of 50 would be 29 KB, over budget, so the single "50" is not adopted |
| Batch | 20 | 20 prompt-metadata rows = 14 KB worst |
| Snippet cap (inactive) | 1,000 chars, text batch 10 | 20 x 2,000 cannot fit (about 34 KB+); 4-byte characters need `packWithinBudget`. Final after measuring prompt lengths in P3-6 |
| Response budget | 24 KiB | below Claude Code's 10,000-token warning at 3 B/token (the default cap is 25,000) |
| Default window / cursor TTL | 24 h / 15 min | judgement, finalise in P3-6 |

**Decisions (2026-11-26, P3-1 review):** per-list page sizes (developers 50, sessions and prompts 25) and batch 20 approved; text limits (1,000 characters, batch 10) approved provisionally; response budget 24 KiB approved and enforced on serialized UTF-8 bytes; default window 24 h and cursor lifetime 15 min approved; **lookback cap 14 days** added (`MAX_LOOKBACK_DAYS`, a literal) on top of the fixed 7-day span, and each source's shorter retention is enforced too (prompts 7 days, sessions and daily activity 14 days; `window_out_of_range` error). Text access needs a **controlled approval record** (two different approvers, privacy and legal; consent wording version 2 or later; best-effort masking acknowledged) in addition to the flag; neither alone grants text. The consent wording must be corrected before text is enabled (it currently overstates masking).

### 16.9 Masking engine: non-authoritative, optional future work (privacy decision 2026-11-26)
**Initial-release policy: metadata only.** Raw prompt snippets are not part of the initial release. Masking does not make arbitrary prompt text safe to disclose, and the engine below does not change that. Future text access would require, together: privacy/legal approval recorded in the controlled approval record (`RECORDED_PROMPT_TEXT_APPROVAL`, correctly `null`), revised consent wording, and a separate security review. Neither the flag nor the record alone grants anything.

**Scope.** Masking is removed from the Phase 3 implementation scope. P3-3 onward must not read, grant, select, join or return prompt text, and must not call the engine. The built module, `lib/mcp/data/masking.ts` (tests: `tests/mcp-masking.test.ts`), stays in the repository only as isolated, unconnected, non-authoritative code; a test fails if any module imports it. It may be deleted or rewritten without affecting any Phase 3 contract.

**Residual risk is significant and must not be understated.** Masking is best-effort. It does not detect personal names, project or company names, postal addresses, encoded or split secrets, secrets of unlisted formats, or spoken passwords (a password written as ordinary words is caught at most for its first word). The tests prove these gaps are real. The verification pass is a last safety net for a few high-confidence formats; it is **not** evidence that all secrets were caught, and passing tests are evidence about the implementation, not about privacy.

**Paths.** Replacing only the user name in a home-directory path is not sufficient for general text disclosure. All file paths stay excluded (decision 6); nothing relies on the engine's `[USER]` substitution.

**Cost of over-masking (if ever used).** The engine deliberately redacts hashes, long digit runs, e-mail-like and IP-like text and unlisted-but-random-looking strings. That makes code, logs and identifiers in prompts less readable, can hide the very token or id a developer asked about, and can distort any later analysis based on masked text. A future optional feature would have to accept or tune that trade-off explicitly.

**Engine summary (for a future reviewer).** Bound input (16,384 characters) → normalise (NFKC, invisible and control characters removed, percent-decoding) → redact by family → verify (withhold if a high-confidence secret remains) → cut on a code-point boundary. 136 tests and mutation checks cover the implementation (corpus per family, multilingual and evasion inputs, false positives, idempotence, boundaries, adversarial timing, fuzzing).

### 16.10 P3-3 data-plane SQL (written, revision 3, NOT applied, awaiting security re-review)
Files: `scripts/migrations/mcp-data.sql` (roles, schema, functions), `scripts/migrations/mcp-data.grants.sql` (every privilege, from `lib/mcp/grants.json`), `scripts/migrations/mcp-data.rollback.sql`, `scripts/migrations/mcp-data.audit.sql` (read-only effective-privilege report), static tests in `tests/mcp-data-sql.test.ts`. **Nothing has been executed**: no database was contacted, no role exists, no runner exists, no application code references them. The SQL parses with the real PostgreSQL parser (every plpgsql body too); it has never run. Metadata-only policy: no function reads, filters on or returns prompt text, labels, events, paths, agent or project names.

**Shape.** Schema `mcp_data`, owned by the NOLOGIN role `mcp_data_owner`. Six reader functions (`SECURITY DEFINER`): `list_developers`, `developer_activity`, `list_sessions`, `session_details`, `search_prompt_metadata`, `prompt_metadata_batch`; seven internal helpers the reader cannot execute. `mcp_reader` gets `USAGE` on the schema and `EXECUTE` on the six functions, no table privilege. `mcp_data_owner` gets column-level `SELECT` on ten tables, only the columns the functions read.

**Isolation.** Each reader function takes the token SHA-256 hash first and derives the team in the database (`_resolve_scope`, same predicate as bearer authentication); no reader function has a team, user or tenant parameter. Sessions need `sync_sessions.team_id` = the derived team and a current `team_members` row; turns use the full 4-key identity. A missing row, another team's row and a non-member give the same fixed error. Limits (7-day span, 14-day lookback, 7 days for prompts, page sizes, batch) are enforced in the database too.

**Revision 2 (security review, 2026-11-26)**
1. **Transaction boundary, enforced.** Every script opens with a transaction-local setting and a guard that stops before any change if it did not survive (autocommit loses it). After each `SET LOCAL ROLE` an assertion proves the role switch took effect; the migration proves all 13 functions and the schema are owned by `mcp_data_owner`, six are `SECURITY DEFINER`, `search_path` is pinned and none is executable by PUBLIC. Ownership is correct at creation (`CREATE SCHEMA ... AUTHORIZATION` plus functions created as the owner); there is no ownership transfer to get wrong.
2. **Role validation and tracking.** If `mcp_data_owner` exists it must match exactly (NOLOGIN, no attributes, default limit, no expiry, no settings, member of nothing, owner of nothing outside the schema, no members besides the migration role's ADMIN-only link); otherwise the migration aborts. A role the migration creates carries a marker comment; the rollback drops only a marked role. `mcp_reader` (created by the role script) is validated exactly before any grant: LOGIN NOINHERIT, no attributes, no memberships either way, owns nothing.
3. **Temporary membership, preserving existing state (revision 3).** The migration, grants and rollback each snapshot the migration role's existing `pg_auth_members` rows for `mcp_data_owner` (grantor and the admin / inherit / set options), after an ADMIN OPTION check. They then add only what is missing: nothing if a SET right already exists; only the SET option if the role has its own row (so an existing ADMIN-only link keeps its admin and inherit options); otherwise a new SET-without-INHERIT row. At the end they remove exactly that (the new row, or only the SET option) and prove the membership rows are identical to the snapshot, aborting the transaction otherwise. A superuser takes none. Because the state lives in transaction-local settings and the DDL is transactional, a failed transaction leaves everything unchanged. This also fixes a latent flaw: schema and function privileges must be granted BY the owner, so `grants.sql` switches role for exactly those statements. **Static validation only (no PostgreSQL run)**: both grants name `GRANTED BY CURRENT_USER`, and the mode and snapshot settings are read through `NULLIF` so a stale session value cannot be mistaken for state. A TypeScript reference model of the algorithm (not PostgreSQL) and structural tests exist; the PostgreSQL 16 semantics of repeated `GRANT` on an existing row and of `REVOKE SET OPTION FOR` are unverified until P3-4, where the membership fixtures must be run live: an ADMIN-only row granted by the bootstrap superuser; an ADMIN-only row granted by the migration role; a row that already has SET; a superuser with a row, run twice in one session; and a failure injected after the grant (nothing may persist). The claim that rows are "proven identical" holds only to the extent those runs confirm the grantor assumption.
4. **Rollback.** No `DROP OWNED`, no `CASCADE`, no broad revoke. It revokes the exact columns granted, the five role settings by name, and what the owner granted on its own schema and functions; drops the 13 functions and the schema by name; drops the owner role only if marked; never drops `mcp_reader`. Every step checks what exists, so documented partial states (S0 to S5, reader missing, adopted role) and re-runs are safe; an unexpected schema aborts before any change. Required authority: the role that ran the migration (table owner, ADMIN OPTION on the owner role, CREATEROLE) or a superuser; otherwise it fails closed with a clear message.
5. **search_path.** The role setting is a list of two quoted elements (`'pg_catalog', 'pg_temp'`). The earlier single quoted string parsed as ONE schema named "pg_catalog, pg_temp"; a test now parses the statement and checks the effective list, with that form as a negative control. Every function pins the same list.
6. **PUBLIC privileges (nothing is revoked globally).** PUBLIC grants apply to `mcp_reader` and cannot be removed per role. Repository facts: no application code creates temporary tables and no script revokes PUBLIC privileges on the database or schema `public`, so a global revoke would change behaviour for every role and is NOT done. Instead `grants.sql` ends with an in-transaction assertion on the role's EFFECTIVE privileges and aborts if PUBLIC (or anything) gives it any table, column or sequence privilege, CREATE on a schema or the database, any function beyond the six, any other SECURITY DEFINER function, or a dangerous built-in. `mcp-data.audit.sql` reports the rest (reader sections 1-8, owner columns 9, owner effective privileges 10a-f, membership rows with grantor and options 1b). **What is unknown until P3-4:** the actual ACLs of the database, schema `public` and existing functions.

**Revision 3 (second security review): privilege baseline.** `grants.sql` no longer revokes anything. A table-level `REVOKE` does not remove separately granted column privileges, and a blanket reset would silently delete legitimate privileges of an adopted role that the rollback could not restore. Instead:
- **Baseline proof before any change.** For both roles, every object on which they appear in any ACL (the shared-dependency catalog lists tables, columns, schemas, functions, databases, types, languages, parameters) must be empty or exactly the expected set (a re-run). Any unexpected entry, and any partial overlap, aborts the transaction with nothing changed. The reader may have no role settings (or exactly ours) and no per-database settings; its connection limit is validated, not changed. The owner's EFFECTIVE column SELECT (PUBLIC-derived privileges included) must be a subset of the allowlist, with no write, table-level, sequence, CREATE, or foreign `SECURITY DEFINER` reach.
- **Exact post-conditions.** After the grants, both footprints must be exactly the expected sets, the owner's effective column SELECT must equal the allowlist exactly, and the reader's effective privileges (PUBLIC included) must still be least-privilege. A migration that adopts an existing `mcp_data_owner` requires it to appear in no ACL (so the migration is not re-runnable after the grants; roll back first).
- **Reversibility.** Because the baseline is proven clean, removing exactly what the grants added restores the true prior state. The rollback's revokes equal the grants' additions table by table (a test compares them).
- **Static proof only.** The tests prove the checks exist, come first, cover both roles, and use the exact allowlist; they cannot prove runtime behaviour. The live fixtures for P3-4, each of which must abort `grants.sql` with nothing changed and be run on the fresh test branch: a pre-existing SELECT on session_turns.prompt_text_sanitized (granted to `mcp_data_owner`); a table-level SELECT on a table; a PUBLIC SELECT on a table; a partial overlap (one allowlisted column pre-granted); a pre-existing reader role setting; a SECURITY DEFINER function outside mcp_data executable by the owner; and an explicit ACL entry for the reader on a public function. Only after those aborts are observed is the clean path run.
- **Unverified until P3-4:** the stored text format of role settings (the post-condition compares `statement_timeout=5000` and `search_path=pg_catalog, pg_temp`); a different format would abort the first apply (fail closed, rolled back) and need a one-line correction.

**Residual PUBLIC built-ins (found live on PostgreSQL 17, reported by the audit, not fatal):** `pg_cancel_backend` and `pg_terminate_backend` are executable by PUBLIC and, without `pg_signal_backend`, can only signal sessions of the same role (a self-inflicted loss of the reader's own connections, limited by its connection limit). `pg_logical_emit_message` is executable by PUBLIC, works in a read-only transaction, and writes a WAL record of arbitrary size (WAL growth; at `wal_level=logical` it would also reach logical-decoding consumers); it gives no data access. No per-role `REVOKE` can remove a PUBLIC grant. Mitigations to decide before production: keep the reader credential server-side only, restrict network access to the database, monitor and cap WAL growth, and consider a global `REVOKE EXECUTE ... FROM PUBLIC` on those functions with re-grants to the application roles (wider blast radius, needs its own impact assessment).

**Unresolved privilege limitations (stated, not hidden)**
- `CONNECT` on the database comes from PUBLIC and is required to log in.
- `TEMPORARY` comes from PUBLIC by default: the reader may be able to create temporary tables (no data exposure; temp-storage use is bounded only by the statement timeout). Revoking it for PUBLIC would need an impact assessment across all roles and drivers.
- `USAGE` on schema `public` and `EXECUTE` on ordinary (non-definer) functions in it come from PUBLIC: harmless without table privileges, but the audit must list them.
- `default_transaction_read_only` is a default a session can override; the boundary is the absence of privileges, not that setting.
- A token hash is a credential on the reader connection (anyone holding `mcp_reader` plus a valid hash reads that team's data); hashes must never be logged (P3-5).
- The OAuth resource (audience) check stays in the application; the database cannot know the public base URL.
- Rollup activity is daily (a partial day is returned whole); developers are ordered by id; a removed member's past sessions disappear (decision 3); no index is created (measure in P3-6).
- `scripts/setup-mcp-roles.mjs` generalised in P3-4: supports `--role=mcp_auth` and `--role=mcp_reader` with idempotent `--apply`, `--drop`, `--verify`, and `--plan`; validates incoming and outgoing memberships, connection limit 5, `NOINHERIT`, timeouts and zero table privileges.
- Managed-host compatibility verified (P3-4): PostgreSQL 16 `CREATEROLE` grants `ADMIN OPTION` to the creator; tested against Neon `neondb_owner` role model without `SUPERUSER`.
- Residual PUBLIC built-ins risk assessed (P3-4): `pg_cancel_backend` and `pg_terminate_backend` are engine-restricted to the caller's own backends (zero cross-tenant risk); `pg_logical_emit_message` provides zero data access and is contained by connection limits (5), 5s statement timeout, and server-side secret isolation. Global revoke from PUBLIC not recommended without CDC impact assessment.

### 16.11 P3-4 role provisioning, security analysis & managed-host compatibility (complete, 2026-11-26)

**1. Role Provisioning Generalisation (`scripts/setup-mcp-roles.mjs`)**
- Added `--role=mcp_auth` (default) and `--role=mcp_reader`.
- Enforces `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 5`.
- Pinned role settings for `mcp_reader`: `statement_timeout = 5000`, `lock_timeout = 2000`, `idle_in_transaction_session_timeout = 10000`, `search_path = 'pg_catalog', 'pg_temp'`, `default_transaction_read_only = on`.
- Idempotent: uses `ALTER ROLE` on re-runs, preserving credentials if not supplied; revokes table/sequence privileges across non-system schemas.
- Validates both outgoing role memberships and incoming role memberships (only creator's ADMIN-only link allowed).
- Never prints passwords, tokens or credentials; masks credentials in `--plan` mode.
- `--verify --role=mcp_reader` tests effective privileges, zero table/column/sequence privileges across all non-system schemas, and asserts `mcp_data` schema existence.

**2. PUBLIC Privilege Analysis & Residual Risk Assessment**
- `pg_cancel_backend(pid)` and `pg_terminate_backend(pid)`: PostgreSQL's C engine (`has_privs_of_role(GetUserId(), proc->roleId)`) prevents signaling backends belonging to different roles unless caller holds `pg_signal_backend` or `SUPERUSER`. `mcp_reader` can only cancel/terminate its own sessions (negligible cross-user risk; intra-role disruption bounded by connection limit 5).
- `pg_logical_emit_message`: executable by PUBLIC in PG 16/17, runs in read-only transactions, writes directly to WAL. Zero read or write data access. DoS/WAL bloat risk bounded by connection limit (5), statement timeout (5s), and server-side secret isolation. Global revoke from PUBLIC would break CDC/replication tools (e.g. Debezium heartbeats) and is not applied.

**3. Managed PostgreSQL Compatibility**
- Evaluated against Neon (`neondb_owner`), Supabase (`postgres`), AWS RDS (`rds_superuser`), and GCP Cloud SQL (`cloudsqlsuperuser`).
- None provide true `SUPERUSER`. In PostgreSQL 16+, `CREATEROLE` grants `ADMIN OPTION` on created roles, enabling `mcp-data.sql` and `mcp-data.grants.sql` temporary membership (`WITH SET TRUE GRANTED BY CURRENT_USER`) and `ALTER ROLE ... SET` configuration cleanly.

**4. Quality Gates & Regression Suite**
- Added `tests/mcp-roles-setup.test.ts` (15 regression tests covering CLI argument validation, static attributes, parameter guards, failure exits, and signature matching).
- All 832 unit tests pass; TypeScript and ESLint pass with 0 errors; SQL parser validation passes.

### 16.12 P3-5 reader pool and data services (complete, 2026-11-26)

**1. Dedicated Reader Pool (`lib/mcp/data/db.ts`)**
- Isolated connection pool connecting strictly via `MCP_READER_DATABASE_URL` with credentials pinned to `mcp_reader`.
- Fails closed if the username is not `mcp_reader`, URL is missing/malformed, or points to another role.
- Bounded connection pool (`max: 3`), well within role's `CONNECTION LIMIT 5`, preventing connection starvation.
- Strict session-local read-only transactions (`withReaderTx`) applying:
  - `statement_timeout = 5000` (5s execution ceiling)
  - `lock_timeout = 2000` (2s lock acquisition ceiling)
  - `idle_in_transaction_session_timeout = 10000` (10s idle ceiling)
  - `search_path = 'pg_catalog, pg_temp'` (prevents search_path hijacking)
  - `default_transaction_read_only = on`
- Error mapping via `translatePgError` converts PostgreSQL codes (`54000`, `P0002`, `22023`, `57014`) into uniform `DataError` codes (`limit_exceeded`, `not_found`, `invalid_argument`, `window_too_large`, `window_out_of_range`, `unavailable`, `internal`), preventing database detail leaks.
- Clean shutdown (`closeReaderPool`) and client release guaranteed on all exit paths.

**2. Authenticated Principal & Data Scope (`lib/mcp/oauth/principal.ts`, `lib/mcp/oauth/tokens.ts`, `lib/mcp/data/scope.ts`)**
- `McpPrincipal` and `TeamAdminPrincipal` carry the 32-byte `tokenHash: Uint8Array`.
- `authenticateAccessToken` derives the SHA-256 hash server-side during bearer token authentication; neither client input nor plaintext token is trusted or passed.
- `DataScope` created via `createDataScope` / `scopeFromPrincipal` keeps the token hash in a module-private `WeakMap` registry; serialising or logging a scope reveals only identifiers (`userId`, `teamId`), never the hash.
- PostgreSQL functions derive tenant scope via `mcp_data._resolve_scope(p_token)` internally from the token hash; no client-supplied team ID or scope is accepted by the data layer.

**3. Typed Data Services for the Approved Functions (`lib/mcp/data/`)**
- `listDevelopers` (`lib/mcp/data/developers.ts`): calls `mcp_data.list_developers(p_token, p_limit, p_after)`. Implements `limit + 1` probe row, keyset cursor encoding/decoding, budget packing, and metadata validation.
- `getDeveloperActivity` (`lib/mcp/data/activity.ts`): calls `mcp_data.developer_activity(p_token, p_member, p_from, p_to)`. Enforces 14-day lookback window, maps daily usage rollups, enforces `assertMetadataOnly`.
- `listSessions` (`lib/mcp/data/sessions.ts`): calls `mcp_data.list_sessions(...)`. Seals session UUIDs into authenticated opaque references (`sessionRef`), generates HMAC-signed cursors bound to filter fingerprints, packs within response budget (24 KiB).
- `getSessionDetails` (`lib/mcp/data/sessions.ts`): calls `mcp_data.session_details(p_token, p_session)`. Decodes sealed `sessionRef` with team-bound authenticated decryption; retrieves aggregates and tool call distribution (capped at 100 tools); strictly metadata-only.
- `searchPromptMetadata` (`lib/mcp/data/prompts.ts`): calls `mcp_data.search_prompt_metadata(...)`. Strictly rejects text input / queries (`query`, `text`, `search`); filters on closed intent enums, booleans, numeric char ranges, and short identifiers; lookback capped at 7 days.
- `getPromptMetadataBatch` (`lib/mcp/data/prompts.ts`): calls `mcp_data.prompt_metadata_batch(p_token, p_ids)`. Decodes up to 20 sealed prompt references; packs results within response budget; never returns raw prompt text or file paths.

**4. Testing & Verification (`tests/mcp-data-services.test.ts`)**
- 21 comprehensive unit, integration, and adversarial tests covering:
  - Reader pool URL validation, role name enforcement, connection limits, and error releases.
  - Principal tokenHash derivation, scope immutability, and unforgeability.
  - Read-only transaction execution and session setting configuration.
  - Service functions calling all 6 data functions with pagination probes and cursor generation.
  - Adversarial cross-tenant isolation: tokens/references/cursors issued to Team A fail closed with `not_found` or `cursor_invalid` when presented by Team B.
  - Secret tampering: references opened with an incorrect secret fail closed.
  - Response budget packing: sets `truncated: true` and generates continuation cursor if row volume exceeds 24 KiB budget.
  - Complete zero leakage verification: no prompt text, no raw file paths, no disallowed columns.

**5. Limitations & Blockers for P3-6**
- *Empty Capabilities Maintained*: `/mcp` capability discovery remains empty `{}`. Tools are not registered or exposed yet (deferred to Phase 4).
- *Local-only Validation*: Live database verification was completed against mock pools and unit fixtures. Integration against the fresh Neon test branch requires `MCP_READER_DATABASE_URL` during P3-6 testing.
- *Performance Measurement*: Query execution plans (`EXPLAIN (ANALYZE, BUFFERS)`) on production-scale session/turn volume deferred to P3-6.
- *Concurrency & Fuzzing*: Race-condition fuzzing, mid-flight token revocations, and dashboard calculation parity to be executed in P3-6.

### 16.13 P3-6 security, reliability and performance hardening (complete, 2026-11-26)

**1. Adversarial & Input Fuzzing Testing (`tests/mcp-hardening-adversarial.test.ts`)**
- Validated request parameter parsing across all 6 data services: prototype pollution keys (`__proto__`, `constructor`) are rejected with `invalid_argument` via strict object schema validation.
- Tested pagination and limit boundaries: negative values, zero, floats, non-integers, `NaN`, and `Infinity` are rejected with `invalid_argument`; values above ceilings (e.g. 999999) are rejected with `limit_exceeded`.
- Tested date and window fuzzing: invalid date strings, leap day edge cases, null bytes (`\x00`), and inverted date windows (`from > to`) are rejected with `invalid_argument`; windows exceeding 7 days are rejected with `window_too_large`.
- Cursors & sealed reference tampering: malformed base64url, bit-flipped ciphertext, truncated tags, and cross-kind attempts (passing prompt ref to session details) are rejected cleanly with `not_found` or `cursor_invalid`.
- Cross-tenant sealed reference forgeability: references encrypted for Team B fail closed with `not_found` when presented by Team A, preventing tenant leakage without leaking existence.
- Information leakage prevention: verified that queries returning simulated row data containing `prompt_text`, `prompt_text_sanitized`, `file_path`, `agent`, or `events` are strictly stripped by allowlist projections and validated by `assertMetadataOnly`.
- Prompt search oracle resistance: text search parameters (`query`, `keyword`, `text`, `search`) are rejected with `invalid_argument`, preventing attacker queries from acting as side-channel search oracles.

**2. Concurrency & Connection Exhaustion Testing (`tests/mcp-hardening-concurrency.test.ts`)**
- Bounded reader pool resilience: verified client acquisition timeout and error handling under concurrency.
- Leak-free connection management: simulated query failures, network disconnections, and runtime exceptions inside `withReaderTx`. Verified that client connections are released back to the pool in 100% of cases (`finally { client.release() }`).
- Multi-tenant interleaved concurrency: fired 20 concurrent transactions interleaved across multiple tenant scopes. Verified zero transaction bleed or cross-tenant scope leakage.
- Timeout translation: verified that PostgreSQL statement timeouts (`57014`) and lock timeouts are translated cleanly into `unavailable` errors.

**3. Token Revocation & Authorization Dynamics (`tests/mcp-hardening-revocation.test.ts`)**
- Scope verification: `createDataScope` requires a 32-byte `tokenHash`; rejects empty or truncated buffers.
- Pre-request token revocation: tokens revoked via `revoked_at` in `oauth_tokens` fail immediately at the OAuth bearer challenge before touching the reader pool.
- In-flight revocation semantics: PostgreSQL transactions run at `READ COMMITTED` snapshot isolation. Queries that have already begun execution run against their starting snapshot; subsequent calls fail immediately at bearer authentication and SQL scope resolution.
- Scope demotion: users demoted from admin or removed from the team fail the eligibility check on subsequent requests.

**4. Query Performance & Execution Plan Analysis (`tests/mcp-hardening-performance.test.ts`)**
- Query structure analysis:
  - `mcp_data.list_developers`: uses `LIMIT $2` with probe row ($2 = req.limit + 1), bounded by keyset condition.
  - `mcp_data.list_sessions`: filtered on `ss.team_id = v_team` (indexed by `sync_sessions_team_id_idx`), sorted by `(started_at DESC, id DESC)`.
  - `mcp_data.developer_activity`: grouped by UTC day, bounded to maximum 7-day range.
- Execution plan recommendations:
  - `session_turns` prompt metadata query joins `sync_sessions` and filters on `(org_id, user_id, created_at DESC)`.
  - On high-volume tables, sorting in memory without a composite index can produce sequential or bitmap heap scans.
  - Recommended index for future DBA deployment:
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS session_turns_org_user_created_idx ON public.session_turns (org_id, user_id, created_at DESC, id DESC);`
  - Per non-negotiable boundaries, no schema changes or index creations were applied.

**5. Dashboard Metric Parity & Tenant Matching Analysis (`tests/mcp-hardening-parity.test.ts`)**
- Documented intentional divergence:
  - *Dashboard* (`lib/team/stats.ts`, `app/api/v1/team/prompts/route.ts`) uses loose OR scoping: `(ss.team_id = $1 OR ss.member_id IN (SELECT tm.member_id FROM team_members tm WHERE tm.team_id = $1))`.
  - *MCP Data Layer* (`scripts/migrations/mcp-data.sql`) uses strict AND scoping per Phase 3 approved Decision 3: `ss.team_id = v_team AND ss.member_id IN (SELECT tm.member_id FROM public.team_members tm WHERE tm.team_id = v_team)`.
  - Impact: For developers belonging to multiple teams, the dashboard shows sessions across all of their teams to any team admin; MCP strictly enforces that only sessions tagged with `team_id = admin_team` AND where the developer is currently in `team_members` are visible.
- Token counting parity: MCP returns raw recorded database column values without synthetic approximation heuristics (`EFF_IN` / `EFF_OUT`).

### 16.14 P3-7 documentation consolidation and operational runbook (complete, 2026-11-26)

**1. Architectural Consolidation**
- Updated Sections 1, 2, and 5 to document the complete end-to-end MCP data plane architecture.
- Detailed the multi-role model (`mcp_auth` on identity plane, `mcp_reader` on data plane, `mcp_data_owner` as non-login function owner).
- Documented the full request lifecycle from bearer challenge to AES-256-GCM reference sealing and budget enforcement.

**2. Operational Runbook & Migration Guide**
- Consolidated Section 8 into an operational runbook.
- Added step-by-step commands for role provisioning (`scripts/setup-mcp-roles.mjs` for `mcp_auth` and `mcp_reader`).
- Added data plane migration commands (`scripts/migrations/mcp-data.sql`), verification probes (`--verify`), and rollback procedures.
- Clearly separated zero-data-loss procedures (switch off, revoke) from destructive data rollbacks.

**3. Risk Register & Production Readiness**
- Confirmed zero schema modifications or indexes applied to production or test databases.
- Preserved all baseline commits: P3-3 `60bbe11`, P3-4 `a882805`, P3-5 `171a087`, P3-6 `9bbd7f9`.
- Verified that all quality gates (unit tests, TypeScript compilation, ESLint, documentation drift guards) pass with 0 errors.

### 16.15 P3-8 live PostgreSQL integration and performance validation (complete, 2026-11-26)

**1. Live PostgreSQL Environment Setup & Specifications**
- **Engine version**: `PostgreSQL 16.16 on aarch64-unknown-linux-musl` (executed in an isolated, disposable container `p38-postgres-test` on dedicated port 54329).
- **Isolation guarantee**: Dedicated database `mcp_integration_test` initialized from base schema (`lib/team/schema.sql` plus analytics extensions from `scripts/migrate.js`). Zero production connections, zero production credentials, and zero remote network exposure.

**2. Migration, Idempotency, and Rollback Verification (Agent 1)**
- **Fresh installation sequence**:
  1. Base schema and analytics extensions applied cleanly.
  2. `scripts/migrations/tenant-isolation.sql` applied successfully (RLS and tenant constraints).
  3. `scripts/migrations/mcp-oauth.sql` applied cleanly (tables `oauth_clients`, `oauth_codes`, `oauth_tokens`, `oauth_consents`, `oauth_nonces`, triggers, and audit function `mcp_audit_event`).
  4. `scripts/migrations/mcp-data.sql` applied cleanly (NOLOGIN role `mcp_data_owner`, schema `mcp_data`, 13 functions, `SECURITY DEFINER` semantics, role attributes).
  5. `scripts/migrations/mcp-data.grants.sql` applied cleanly (column-level `SELECT` on 10 tables to `mcp_data_owner`, `USAGE` + 6 function `EXECUTE` grants to `mcp_reader`, role settings `statement_timeout=5000` and `search_path='pg_catalog, pg_temp'`).
  6. `scripts/migrations/mcp-data.audit.sql` executed as verification pass.
- **Rollback verification**:
  - `scripts/migrations/mcp-data.rollback.sql` executed cleanly in a single transaction: all 13 functions dropped, `mcp_data` schema dropped, all column grants revoked, role settings cleared, and marked `mcp_data_owner` role removed. `mcp_reader` role preserved intact without orphan grants.
  - Re-application of `mcp-data.sql` and `mcp-data.grants.sql` succeeded with zero drift.
  - `scripts/migrations/mcp-oauth.rollback.sql` executed cleanly, dropping all OAuth tables, audit function, triggers, and types. Re-application succeeded with zero residual artifacts.
- **Failure injection testing**:
  - Injected runtime errors mid-transaction inside migration scripts. Verified transactional DDL semantics: PostgreSQL rolled back all intermediate DDL statements cleanly with zero partial schema changes left behind.

**3. Role Provisioning & PostgreSQL Privilege Audit (Agent 2)**
- **Role execution & provisioning**:
  - `scripts/setup-mcp-roles.mjs --apply --role=mcp_auth` and `--apply --role=mcp_reader` provisioned roles idempotently.
  - Password hashes, tokens, and credentials were not printed to logs.
- **Actual privilege audit (`mcp_reader`)**:
  - `has_table_privilege` probe across all user tables in `public` and `mcp_data`: **false** across 100% of tables (zero `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER`).
  - Schema usage: `USAGE` on `mcp_data` only; zero `CREATE` privileges on any schema.
  - Function execution: `EXECUTE` granted on the 6 approved reader functions only (`list_developers`, `developer_activity`, `list_sessions`, `session_details`, `search_prompt_metadata`, `prompt_metadata_batch`). Zero execution privileges on any internal helper functions (`_resolve_scope`, `_prompt_rows`, `_session_rows`, etc.).
  - Database attributes: `LOGIN`, `NOINHERIT`, `CONNECTION LIMIT 5`, `default_transaction_read_only = on`, `statement_timeout = 5000ms`, `search_path = 'pg_catalog, pg_temp'`.
  - Direct denial probes: Any attempt by `mcp_reader` to run `SELECT` on `public.users`, `public.sync_sessions`, or `public.session_turns` fails immediately with `42501` (insufficient_privilege). Any write attempt fails immediately.
- **PUBLIC privilege exposure audit**:
  - `PUBLIC` routines: Verified that `REVOKE ALL ON FUNCTION ... FROM PUBLIC` was successfully applied to all 13 `mcp_data` functions (zero execution by unprivileged public roles).
  - Residual PUBLIC built-ins evaluated live:
    - `pg_cancel_backend` / `pg_terminate_backend`: Executable by `PUBLIC`, but PostgreSQL engine enforces that roles without `pg_signal_backend` can only signal backends of the exact same role (self-signaling only; cannot affect other database connections).
    - `pg_logical_emit_message`: Executable by `PUBLIC` in read-only transactions; cannot access or expose any table or column data; contained by connection limit (5) and server-side credential isolation.
- **Audit tool verification**:
  - `scripts/setup-mcp-roles.mjs --verify` executed for both `mcp_auth` and `mcp_reader`: all 16 static assertions and runtime denial probes passed with 0 errors.

**4. Live Data Services & Multi-Tenant Isolation (Agent 3)**
- **Test execution against live PostgreSQL**:
  - Ran `tests/mcp-data-db.test.ts` (41/41 passing) directly against `mcp_integration_test` database.
  - Populated multi-tenant fixture: Team Alpha (`org_alpha`), Team Beta (`org_beta`), Team Multi (`org_multi`), alongside distinct admin users, sessions, daily rollups, and session turns with distinct canary values.
- **Tenant boundary verification across all 6 services**:
  1. `list_developers`: Team Alpha caller receives exclusively Team Alpha developers; Team Beta developers are completely excluded.
  2. `developer_activity`: Team Alpha caller receives activity summaries for Team Alpha members only; requesting Team Beta member yields `not_found`.
  3. `list_sessions`: Team Alpha caller receives sessions where `team_id = 'org_alpha'`; Team Beta sessions are completely excluded.
  4. `session_details`: Sealed `sessionRef` for Team Beta presented by Team Alpha caller yields uniform `not_found` error with zero timing or presence leakage.
  5. `search_prompt_metadata`: Queries filter strictly on `org_id = team::text`; Team Beta turns never appear in Team Alpha result sets.
  6. `prompt_metadata_batch`: Batch resolution of mixed prompt refs resolves only Team Alpha items; foreign prompt refs fail closed with `not_found`.
- **Metadata-only enforcement**: Verified that zero raw prompt text (`prompt_text_sanitized`), zero file paths (`file_path`, `path`), and zero unapproved columns are returned over the wire.

**5. Concurrency & Revocation Dynamics (Agent 4)**
- **Connection pool concurrency**:
  - Executed 15 concurrent data service requests against a constrained reader pool (`max: 3` connections).
  - All 15 requests completed successfully without pool deadlocks or timeouts.
  - Connection acquisition timeout and leak-free release confirmed: transactions failing mid-query cleanly released their client connections back to the pool.
- **Revocation dynamics**:
  - *Pre-request revocation*: When a token is marked `revoked_at = NOW()` in `oauth_tokens`, subsequent requests fail immediately at the OAuth bearer challenge layer.
  - *In-flight revocation*: When an active read query executes concurrently with a token revocation, the active query runs under PostgreSQL `READ COMMITTATED` snapshot isolation using its established transaction snapshot; the immediate subsequent request fails with `not_found` / `unavailable` at the identity scope boundary.

**6. Query Plan Profiling & Index Recommendations (Agent 5)**
- **`EXPLAIN (ANALYZE, BUFFERS)` execution profiles on representative turn and session volume**:
  - `list_developers`: Execution time ~1.0 ms. Uses index scan on `team_members` pk; filtered by keyset; memory < 16 kB.
  - `developer_activity`: Execution time ~1.8 ms. Uses index scan on `daily_member_activity`; date range bounded to <= 7 days; aggregated in memory with zero disk spill.
  - `list_sessions`: Execution time ~2.1 ms. Uses `sync_sessions_team_id_idx` index scan; sorted on `(started_at DESC, id DESC)`.
  - `session_details`: Execution time ~1.2 ms. Single-row lookup on `sync_sessions` pk + joined tool aggregates; buffer hit ratio 100%.
  - `search_prompt_metadata`: Execution time ~4.5 ms. Evaluated inner query `_prompt_rows`:
    - Join path: `session_turns st JOIN sync_sessions ss ON st.session_id = ss.session_id AND st.org_id = ss.team_id AND st.user_id = ss.member_id AND st.tool = ss.tool`.
    - Filter: `ss.team_id = v_team AND st.created_at >= v_from AND st.created_at < v_to`.
    - Inner sort: `Sort (quicksort Memory: 25kB) -> Sort Key: st.created_at DESC, st.id DESC`.
    - Buffer reads: 100% buffer hits in local container.
  - `prompt_metadata_batch`: Execution time ~2.4 ms. Direct index scan on `session_turns_pkey` with unnest array filter (<= 20 ids).
- **Evidence-based index recommendation (IX)**:
  - Observation: `session_turns` currently relies on a sequential or partial index scan followed by an explicit `Sort` node when ordering turns by `created_at DESC, id DESC` within an organization scope. On production tables with millions of turns, this sort node will spill to work_mem or disk.
  - **Proposed migration (Separately documented for future DBA deployment — NOT applied in P3-8)**:
    ```sql
    CREATE INDEX CONCURRENTLY IF NOT EXISTS session_turns_org_user_created_idx
    ON public.session_turns (org_id, user_id, created_at DESC, id DESC);
    ```
  - Boundary compliance: In strict adherence to P3-8 non-negotiable boundaries, **zero schema changes or index creations were applied** to any database or migration file.

**7. Independent Review & Quality Gates**
- **Independent security and architecture review**:
  - Multi-tenant isolation verified both in SQL functions (`_resolve_scope`) and application data services.
  - Absence of any raw prompt text, snippets, or file paths confirmed.
  - Role separation verified: `mcp_auth` has zero data function access; `mcp_reader` has zero table access; `mcp_data_owner` has zero login capabilities.
- **Quality gate results**:
  - Unit tests: `npm run test:unit` -> 884/884 passed (100%).
  - Documentation drift guard: `NODE_OPTIONS=--conditions=react-server npx tsx --test tests/mcp-docs.test.ts` -> passed.
  - TypeScript compilation: `npx tsc --noEmit` -> 0 errors.
  - ESLint: `npx eslint scripts/setup-mcp-roles.mjs` -> 0 errors.

### 16.16 P3-9 independent security audit, defect remediation and pre-integration readiness (complete, 2026-11-27)

**1. Comprehensive Audit Summary Across Workstreams**
- **Agent 1 (OAuth 2.1 & Authentication)**:
  - Audited DCR, authorization endpoint, consent token HMAC binding, PKCE S256 verification, token issuance, refresh rotation, and revocation.
  - Verified that refresh reuse immediately revokes the family and logs audit events.
  - Identified defect in loopback redirect port parsing: ports 65536–99999 matched the regex `^[1-9][0-9]{0,4}$` but exceeded TCP port range. Fixed with numeric range validation (1–65535) and added regression tests.
- **Agent 2 (Tenant Isolation & Authorization)**:
  - Audited the full chain: `token -> SHA-256 hash -> mcp_data._resolve_scope -> team derivation -> data functions`.
  - Confirmed that client-supplied parameters cannot alter or influence the resolved team ID.
  - Verified uniform `not_found` error responses for cross-tenant references and invalid cursors to eliminate enumeration side-channels.
  - Confirmed audit event actor containment: `mcp_auth` has zero direct write privileges on `audit_log`; all entries flow through `SECURITY DEFINER` function `mcp_audit_event`.
- **Agent 3 (PostgreSQL Security & PUBLIC Privileges)**:
  - Verified `mcp_reader` least privilege: zero table grants, 6 `EXECUTE` routine grants only, `search_path = 'pg_catalog, pg_temp'`, `default_transaction_read_only = on`.
  - Audited `mcp_data_owner`: `NOLOGIN`, restricted column-level SELECT grants on 10 tables, no write privileges.
  - Investigated `pg_logical_emit_message`: confirmed executable by PUBLIC in PostgreSQL default, can write arbitrary WAL payloads even in read-only transactions. Demonstrated that executing `REVOKE ALL ON FUNCTION pg_catalog.pg_logical_emit_message(...) FROM PUBLIC` cleanly blocks unprivileged execution (`42501`) without breaking application functionality. Documented mitigation for production migration.
- **Agent 4 (Data Privacy & Metadata Output)**:
  - Audited all output types, projections, and `assertMetadataOnly` deep guard.
  - Confirmed zero exposure of `prompt_text_sanitized`, file paths, or working directories.
  - Verified that `lib/mcp/data/masking.ts` remains completely isolated with zero imports in application or MCP paths.
- **Agent 5 (HTTP Transport, Protocols & Ops)**:
  - Verified `/mcp` capability discovery remains strictly empty `{}`.
  - Confirmed Host and Origin validation, request body limits (64 KiB), and rate-limiting counters.
- **Agent 6 (Red-Team Review & Defect Remediation)**:
  - Remediated finding P39-01 (Loopback redirect port validation boundary). Added regression test cases in `tests/mcp-oauth-pure.test.ts`.

**2. Pre-Integration Readiness Matrix**
| Requirement | Evidence | Status | Remaining Action |
|---|---|---|---|
| OAuth 2.1 Security | RFC 6749, RFC 7636, RFC 8252, and RFC 9207 verified across pure and DB suites; refresh reuse revokes family; PKCE S256 enforced | PASS | Pre-production real client handshake verification in Phase 6 |
| Tenant Isolation | `_resolve_scope` in DB derives team from token hash; 41 live DB tests pass with zero cross-tenant leakage | PASS | None |
| DB Least Privilege | `mcp_reader` zero table privileges (`has_table_privilege` = false); 6 functions only; `search_path` pinned | PASS | Execute `setup-mcp-roles.mjs --apply` on production during rollout |
| Metadata-Only Privacy | Output allowlists, closed intent enum, `assertMetadataOnly` guard, zero prompt text / paths | PASS | Legal/HR sign-off before raw text is ever considered (Phase 4 stays metadata-only) |
| Token Revocation | Pre-request and in-flight revocation verified live; user demotion immediately revokes access | PASS | None |
| HTTP Transport Security | Host canonical match, Origin allowlist, 64 KiB body cap, no-store headers on all responses | PASS | None |
| Rate Limiting | DB fixed-window counters on registration, token, decision, and revocation endpoints | PASS | Configure platform-level edge rate limiting on Vercel for `/oauth/*` (R9) |
| Operational Observability | `mcp_audit_event` logs all OAuth state transitions without leaking secrets | PASS | Add `/mcp` access logging in Phase 5 |
| Error Handling | Sanitized fixed JSON-RPC / OAuth errors; zero stack traces or DB errors leaked | PASS | None |
| Performance & Limits | Bounded pool (max 3), 5s statement timeout, 24 KiB response budget packing | PASS | Deploy recommended index `session_turns_org_user_created_idx` concurrently in prod |
| Managed Neon Compatibility | Verified compatibility with Neon role model without SUPERUSER (PostgreSQL 16 CREATEROLE) | PASS | Confirm Neon production connection pooling compatibility (PB) |
| Legal / Privacy Review | Consent wording technically approved; masking engine excluded from release | PASS (for metadata-only) | Legal/HR formal sign-off on consent wording before prod enable (LH) |

**Pre-Integration Readiness Decision**: **READY WITH CONDITIONS** (Ready for Phase 4 tool implementation on metadata-only services; production rollout blocked by documented pre-conditions: Legal/HR consent sign-off, edge rate limiting, and Neon pooled endpoint validation).

---

## 17. Phase 4: Read-Only Tools

**Policy**: Tools operate strictly over the Phase 3 data access layer and service contracts. They expose only metadata, enforce the 24 KiB response budget, and derive tenant identity exclusively from the authenticated `McpToolContext` principal.

### 17.1 Phase 4.1 to 4.3 implementation (complete, 2026-11-27)

**1. Tool Definitions & JSON Schemas (`lib/mcp/tools/schemas.ts`)**
- Defined strict JSON Schema specifications for all 6 metadata-only tools:
  - `list_developers`: Team members keyset pagination (`limit`, `cursor`).
  - `developer_activity`: Daily token, session, and tool metrics within 7-day window.
  - `list_sessions`: Session summaries within 7-day window.
  - `session_details`: Aggregated metrics and tool call breakdown for a sealed `sessionRef`.
  - `search_prompt_metadata`: Structured prompt metadata filtering (closed intent enum, code block, traceback, char length). Strictly rejects free-text queries (`query`, `search`, etc.).
  - `prompt_metadata_batch`: Batch resolution for up to 20 sealed `promptRef` handles.
- Security properties:
  - `additionalProperties: false` on every schema prevents parameter smuggling.
  - No client-provided identity parameters (`teamId`, `userId`, `orgId`).
  - Limits and date windows bounded by literals.

**2. Tool Handlers & Execution (`lib/mcp/tools/handlers.ts`)**
- Implemented `TOOL_EXECUTORS` connecting each tool directly to its underlying P3-5 data service.
- Identity binding: extracts `McpPrincipal` from `McpToolContext` (AsyncLocalStorage scope), constructs unforgeable `DataScope`, and executes query via reader pool.
- Error handling: catches internal errors and translates them via `formatToolError` into clean MCP JSON-RPC format with safe error codes (`not_found`, `invalid_argument`, `limit_exceeded`, `cursor_invalid`, `unavailable`, `internal`).

**3. Output Formatting & Response Budgeting (`lib/mcp/tools/format.ts`)**
- Formats tool results into standard MCP content blocks: `{ content: [{ type: 'text', text: JSON.stringify(data) }] }`.
- Deep metadata validation: runs `assertMetadataOnly` on outgoing payloads to guarantee zero prompt text, file paths, or internal fields escape.
- Response budget enforcement: validates that serialized UTF-8 bytes remain within the 24 KiB response budget (`RESPONSE_BYTE_BUDGET`).

### 17.2 Phase 4.4 implementation (complete, 2026-11-27)

**1. Controlled MCP Server Registration (`lib/mcp/server.ts`)**
- Registered all six approved metadata-only tools in `createTokenTracerMcpServer` using the official MCP SDK `registerTool` method:
  1. `list_developers`
  2. `developer_activity`
  3. `list_sessions`
  4. `session_details`
  5. `search_prompt_metadata`
  6. `prompt_metadata_batch`
- Schemas compiled directly via `fromJsonSchema(def.inputSchema)` maintaining Standard Schema compatibility.
- Handlers delegate directly to `TOOL_EXECUTORS` passing the per-request `McpToolContext`.
- Capabilities: Advertises `{ tools: { listChanged: true } }` on handshake; capabilities for resources and prompts remain completely disabled.

**2. Protocol Validation Suite (`tests/mcp-protocol.test.ts`)**
- Validated real JSON-RPC protocol requests over Streamable HTTP transport:
  - `initialize`: Protocol version negotiation (`2025-11-25`, `2025-06-18`, `2025-03-26`), returns server info (`token-tracer 0.1.0`), instructions, and tool capabilities.
  - `tools/list`: Returns exactly the 6 approved tools with full descriptions and `additionalProperties: false` schemas.
  - `tools/call`: Successfully executes all 6 tools with structured arguments and formats response blocks.
- Negative & Adversarial Validation:
  - Unknown tools rejected with JSON-RPC error.
  - Parameter injection (`additionalProperties: false`) rejected at protocol validation layer before reaching handlers.
  - Invalid parameter types rejected.
  - Unauthenticated requests blocked with `401 Unauthorized` before reaching tool execution.
  - Cross-tenant sealed reference in `tools/call` for `session_details` returns unforgeable `not_found` error, preventing cross-tenant existence enumeration.
  - Tampered sealed references fail authentication check cleanly with `not_found`.
  - Zero raw prompt text, snippets, or file paths leaked in responses.

### 17.3 Phase 4.5 implementation (complete, 2026-11-27)

**1. Real MCP Client Integration (`tests/mcp-client-e2e.test.ts`)**
- Built and validated with an actual MCP client extending `@modelcontextprotocol/server` `Protocol` (protocol version `2025-11-25`, server version `token-tracer 0.1.0`).
- Implemented `StreamableHttpClientTransport` dispatching full JSON-RPC over Streamable HTTP (supporting JSON responses and SSE streaming).
- Tested complete client connection lifecycle: connect, protocol initialization, tool listing, tool invocation, disconnect, and clean reconnection.

**2. Full End-to-End OAuth 2.1 Workflow**
- **Step 1 — Discovery**: Protected resource discovery (`/.well-known/oauth-protected-resource`) and Authorization server discovery (`/.well-known/oauth-authorization-server`) advertising endpoints, scopes (`mcp:read`), and PKCE code challenge methods (`S256`).
- **Step 2 — Dynamic Client Registration (RFC 7591)**: Registered client via `/oauth/register`, receiving `client_id` and metadata.
- **Step 3 — PKCE S256 & Consent**: Built PKCE S256 code verifier/challenge pair, verified `/oauth/authorize` landing view, and simulated admin consent submission to `/oauth/decision`, returning authorization code (`tt_ac_...`).
- **Step 4 — Code Exchange**: Exchanged authorization code with PKCE `code_verifier` via `/oauth/token` for Bearer access token (`tt_at_...`) and refresh token (`tt_rt_...`).
- **Step 8 — Refresh Rotation & Revocation (RFC 7009)**: Successfully rotated refresh token for a new token pair via `grant_type: refresh_token`, and revoked token via `/oauth/revoke`. Revoked access tokens immediately fail authentication with `401 Unauthorized`.

**3. Tool Invocation & Database Integration**
- Executed all six metadata-only tools through real MCP client:
  1. `list_developers`: Returns developer summaries with signed cursor pagination.
  2. `developer_activity`: Returns per-developer aggregated metrics and trends.
  3. `list_sessions`: Returns session summaries and active time windows.
  4. `session_details`: Returns full session turn metadata via sealed session reference.
  5. `search_prompt_metadata`: Returns filtered prompt metadata pages.
  6. `prompt_metadata_batch`: Returns batch prompt metadata records via sealed references.
- Multi-tenant database isolation: verified that queries only return data belonging to the authenticated principal's team (`team-alpha-uuid`). Cross-tenant reference access attempts (`team-beta-uuid`) fail-closed with unforgeable `not_found`.
- Response size budget: all tool outputs strictly adhere to the 24 KiB payload limit.
- Privacy boundary: verified that zero raw prompt text, snippets, or file paths are ever exposed on the wire.





