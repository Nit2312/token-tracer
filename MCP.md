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
