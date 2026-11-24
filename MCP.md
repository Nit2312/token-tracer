# Token Tracer MCP server

Remote [MCP](https://modelcontextprotocol.io) server hosted inside this Next.js app. Status: **Phase 1 — foundation only.**

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

## Later phases (not implemented)

OAuth 2.1 (Phase 2), tenant-scoped authorization (3), read-only tools (4), audit and rate limits (5), end-to-end tests (6), rollout (7).
Prompt-level data will use a dedicated read-only database role, never the application owner role.
