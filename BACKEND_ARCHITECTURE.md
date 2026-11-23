# Token Tracer — Backend Architecture & Auth Guide

Purpose: explain how the backend works today, so new features follow the same patterns. Part 12 is a checklist for designing a new endpoint. Part 13 lists inconsistencies in the current code that new work should not copy.

Everything here comes from reading the code. File paths are relative to the repo root.

> `AGENTS.md` warns that this Next.js version (16.x) has breaking changes. For example, `middleware.ts` is now **`proxy.ts`**. Read `node_modules/next/dist/docs/` before using framework APIs you haven't verified.

---

## 1. What the system is

Token Tracer tracks LLM usage and cost for developers' AI coding agents (Claude Code, Cursor, etc.).

```
┌────────────────────┐   Bearer API key    ┌──────────────────────────────┐
│ Sync daemon         │ ─────────────────▶ │  Next.js app (Vercel)         │
│ (bin/sync-daemon)   │  POST /api/v1/ingest│                              │
│ runs on dev laptops │ ◀───────────────── │  • API routes (app/api/**)    │
└────────────────────┘  update-check       │  • proxy.ts (CSRF + idle)     │
                                           │  • lib/** (business logic)    │
┌────────────────────┐   session cookie    │                              │
│ Browser dashboards  │ ◀────────────────▶ │                              │
│ /  /team  /admin    │                    └──────────────┬───────────────┘
└────────────────────┘                                    │ pg (SSL, pooled)
                                                          ▼
                                                  Neon Postgres
                                                  ▲
                                   Vercel Cron ───┘ (nightly rollup, 02:00 UTC)
```

There are two completely separate kinds of caller, and they authenticate differently:

| Caller | Credential | Used on |
|---|---|---|
| **Human in a browser** | Signed `app_session` cookie (password, plus MFA for admins) | Everything under `/api/auth`, `/api/admin`, `/api/v1/team*`, `/api/stats`, `/api/state`, `/api/session`, `/api/internal/releases` |
| **Sync daemon (machine)** | `Authorization: Bearer av_live_…` ingest key | `/api/v1/ingest`, `/api/v1/update-check` |
| **Scheduler** | `CRON_SECRET` (or a superadmin cookie) | `/api/internal/rollup`, `/api/internal/rollup-research` |

---

## 2. Stack and layout

- **Next.js 16 App Router**, React 19, TypeScript, Turbopack.
- **Postgres on Neon** through the `pg` driver (no ORM). Raw parameterised SQL everywhere.
- **bcryptjs** for passwords, **node:crypto** for HMAC signing, AES-GCM and TOTP. There are no auth libraries (no NextAuth, JWT lib or OTP lib).
- Deployed on **Vercel** (`vercel.json` defines one cron).

```
app/
  api/
    auth/          login, mfa/verify, signup, me, profile       (human auth)
    v1/ingest      daemon → server data push                    (API key)
    v1/update-check daemon self-update check                    (API key)
    v1/team/*      team dashboard data & management             (cookie)
    v1/teams       list/create teams                            (cookie)
    stats, state, session   personal-dashboard data             (cookie, role=user)
    admin/*        superadmin-only operations                   (cookie, superadmin)
    internal/*     cron jobs and daemon release management      (cron secret / cookie)
    health         liveness
  admin/ team/ dashboard/ login/    pages (server components that gate on session)
proxy.ts            request gate: CSRF origin check + idle-session refresh
lib/
  session-token.ts  PURE signing/cookie code (safe to import in proxy.ts)
  auth.ts           passwords, user lookup, role helpers, team scoping
  security/         totp, mfa-flow, auth-store (MFA + throttle tables), request (ip, rateLimit), errors
  team/             db (pool/schema/query), env, auth (API keys), audit, cache, ingest, stats, research, sanitize
  admin/chat/       superadmin analyst chatbot (see SUPERADMIN_CHAT.md)
bin/ , public/      daemon source + install scripts served as static files
scripts/            migrate, rollup+prune runner, mfa setup, analyst-role setup
```

**Code conventions that matter for new work**
- Route handlers set `export const dynamic = 'force-dynamic'` (nothing is cached by Next).
- Business logic lives in `lib/`, and routes stay thin: auth, parse, call lib, shape response.
- `lib/session-token.ts` is deliberately free of DB and `server-only` imports, because `proxy.ts` imports it. Keep it that way.
- DB code is marked `import 'server-only'`.

---

## 3. Request lifecycle

Every request passes through `proxy.ts` first (matcher: everything except `_next/static`, `_next/image` and `favicon.ico`).

1. **CSRF defence (API only).** For `POST/PUT/PATCH/DELETE` on `/api/*`:
   - If `Sec-Fetch-Site` is present and isn't `same-origin` or `none`, the request is rejected with `403 Cross-site request blocked`.
   - If `Origin` is present, its host must equal `x-forwarded-host` / `host`.
   - If neither header exists (curl, the daemon), the request passes. Those callers use Bearer keys, not cookies.
2. **`Cache-Control: no-store`** is added to every `/api/*` response.
3. **Idle-timeout refresh.** On `GET/HEAD` only, and skipping `/api/auth/*`, `/api/v1/auth/*` and `/api/admin/impersonate*`: if the cookie belongs to a privileged role (admin/superadmin) and `lastActive` is older than 60s, a new `Set-Cookie` with `lastActive = now` is issued. This is how "30 minutes idle" works without server-side session storage.

Then the route handler runs. Global response headers come from `next.config.ts`: HSTS, CSP (`default-src 'self'`, no `unsafe-eval` in production), `X-Frame-Options: DENY`, `nosniff`, a restrictive `Permissions-Policy`, and no `X-Powered-By`.

---

## 4. Authentication in depth

### 4.1 Identities and roles

| Role | Who | Home page | Session lifetime |
|---|---|---|---|
| `user` | Developer; has a `members` row, and syncs data | `/` | 7 days absolute, no idle limit |
| `admin` | Team admin | `/team` | 12h absolute, 60 min idle, **MFA required** |
| `superadmin` | Platform owner | `/admin` | 8h absolute, 30 min idle, **MFA required** |
| (impersonated) | Superadmin acting as a user | target's home | 1h absolute, no idle |

There are **two kinds of accounts**:
1. **Built-in env accounts.** Usernames `team` and `superadmin`. Passwords are `ADMIN_PASSWORD` / `SUPERADMIN_PASSWORD` environment variables. Their `userId` is the literal string `'admin'` / `'superadmin'`, not a UUID. MFA secrets are env vars (`ADMIN_TOTP_SECRET`, `SUPERADMIN_TOTP_SECRET`).
2. **Database users** in the `users` table (`role` in user/admin/superadmin). The password is a bcrypt hash (cost 12), and the MFA secret is stored encrypted in `auth_totp`.

Code often tells them apart with `userId.length === 36` (a UUID). That is how audit rows decide whether `actor_user_id` is stored.

### 4.2 The session token

Sessions are **stateless**. There is no sessions table. The cookie `app_session` contains `base64url(JSON payload) + "." + HMAC-SHA256(secret, b64)`, signed with `SESSION_SECRET` (`lib/session-token.ts`).

Payload:
```ts
{ userId, username, displayName, role, memberId, teamId,
  issuedAt, lastActive?, mfa?, impersonatedBy?, impersonatedByName? }
```

Cookie flags: `HttpOnly; SameSite=Lax; Path=/; Max-Age=<absolute lifetime>`, plus `Secure` when on HTTPS (not on localhost).

`decodeSessionToken` returns `null` (meaning "not logged in") if any of these hold:
- the signature is invalid (timing-safe comparison)
- `now - issuedAt` exceeds the role's absolute limit
- the role has an idle limit and `now - (lastActive ?? issuedAt)` exceeds it
- the role is privileged, isn't impersonating, and `mfa !== true`

Every route does `getSessionFromCookie(req.headers.get('cookie'))`. There is no shared wrapper, so **each route must do its own check**.

`SESSION_SECRET` also derives the key that encrypts stored TOTP secrets. If the env var is missing, the code falls back to `ADMIN_PASSWORD`, and in production with neither it throws. Rotating `SESSION_SECRET` logs everyone out **and** makes every stored TOTP secret undecryptable.

**Consequence of stateless sessions:** role changes, deactivation and deletion don't take effect until the token expires. The code works around this in places. `GET /api/auth/me` re-reads the user row and returns 401 (clearing the cookie) if `active`, `role` or `username` no longer match. Other routes trust the cookie.

### 4.3 Login flow (`POST /api/auth/login`)

```
body {username, password}
  │
  ├─ validate (non-empty, ≤120/512 chars)
  ├─ THROTTLE CHECK (DB-backed)  ──locked──▶ 429 + Retry-After
  │
  ├─ username == "team"        → timing-safe compare to ADMIN_PASSWORD
  ├─ username == "superadmin"  → timing-safe compare to SUPERADMIN_PASSWORD
  └─ else DB user: must exist & active; per-account lock (423); bcrypt compare
        on failure: increment failed_login_attempts (lock 15 min at 5)
        on success: reset counters; resolve teamId from team_members
  │
  any failure → recordFailure(throttle rules) + audit 'login_failed' → 401 "Invalid credentials"
  │
  ▼ password OK  → completePasswordStage()
     role=user  → set app_session immediately (mfa:false), audit 'login_success', return {redirect}
     role=admin/superadmin → MFA stage (below)
```

**Throttling** (`lib/security/auth-store.ts`, table `auth_throttle`, so it works across serverless instances). Each failure increments three counters, and any counter at its limit locks that key for 15 minutes:

| Key | Limit | Protects against |
|---|---|---|
| `ip:<ip>` | 20 fails | one address hammering many accounts |
| `user-ip:<user>\|<ip>` | 5 fails | classic guessing from one place |
| `user:<user>` | 30 fails | distributed guessing against one account |

The failure window is 15 minutes. A successful MFA step clears the user's keys.

The built-in accounts get throttling but not the per-account `locked_until` column, which exists only for DB users.

### 4.4 MFA (TOTP) for admins and superadmins

Hand-rolled RFC 6238 (SHA-1, 6 digits, 30s) in `lib/security/totp.ts`.

1. After the password passes, `completePasswordStage` looks up the MFA state for a **subject**: `env:superadmin`, `env:team` or `user:<uuid>`.
2. It sets a **`mfa_pending` cookie** (`lib/security/mfa-flow.ts`): signed, 5 minutes, `HttpOnly; SameSite=Strict; Path=/api/auth`. It holds the identity payload, the subject, the redirect and an `enroll` flag. It carries **no session power**.
3. Enrollment: a DB admin without an authenticator gets a fresh secret in the response (`enroll.secret`, `otpauthUri`). `beginEnrollment` never overwrites an already-confirmed secret.
4. Env accounts must have a TOTP secret. In **production** a missing secret returns 503 ("run `npm run mfa:setup`"). In **development only** the code logs a warning and skips MFA.
5. `POST /api/auth/mfa/verify {code}`:
   - requires a valid `mfa_pending` cookie, otherwise 401 with `restart: true`
   - applies the same throttle keys
   - `verifyTotp` accepts a small time window and returns the matched step
   - `claimStep` atomically stores `last_step` (`UPDATE … WHERE last_step < new`). This **blocks replay**: each code works once.
   - on success it confirms enrollment if needed, clears throttles, audits `login_success {mfa:true}`, then sets the real `app_session` (`mfa:true`) and clears the pending cookie.

Stored TOTP secrets are encrypted with AES-256-GCM (key derived from `SESSION_SECRET`). A superadmin can reset a DB user's MFA with `POST /api/admin/users/reset-mfa`, and the user re-enrolls on the next login.

### 4.5 Logout
`DELETE /api/auth/login` (and the retired `/api/v1/auth/login`) clears `app_session`, `sa_original_session` and the legacy `team_admin` cookie. `POST /api/auth/me` also clears the session.

`POST /api/v1/auth/login` is **retired** and returns 410. It used to mint a password-only admin token that skipped MFA. Don't resurrect it.

### 4.6 Signup (`POST /api/auth/signup`)
Public. Validates the username (`[a-z0-9_.-]`, ≥2 chars, reserved names blocked, case-insensitive uniqueness) and a password of 8 or more characters. Two paths:
- `role: 'user'`: creates a `members` row in the shared **"Independent"** team, a `team_members` row and an API key. It returns the key once, plus ready-made install commands.
- `role: 'admin'`: creates a new team named by the caller, with no member and no key.

Admin accounts created here still need MFA enrollment on first login, which is what gates their power.

### 4.7 Impersonation
- `POST /api/admin/impersonate {userId}`: superadmin only. It refuses if already impersonating (checks both the `impersonatedBy` flag and the presence of the backup cookie) or if the target is inactive.
- It issues an `app_session` for the target with `impersonatedBy`/`impersonatedByName` and a **1-hour** limit, and stores the superadmin's original token in the `sa_original_session` cookie (8h).
- `POST /api/admin/impersonate/return` validates the backup (must still decode and still be superadmin), restores it with a fresh `lastActive`, and clears the backup.
- Both are audited (`impersonate.start`, `impersonate.end`). The impersonated session does not require `mfa` (the rule in `decodeSessionToken` exempts it).
- Impersonating a user who is themselves a superadmin or admin is allowed by the code, so treat the audit log as the control.

---

## 5. Authorization (who can see what)

Authorization is **role plus team scoping, enforced in each route**. The helpers are in `lib/auth.ts`:

| Helper | Meaning |
|---|---|
| `isAdminRole(session)` | admin or superadmin |
| `isSystemAdmin(session)` | superadmin, **or** the built-in `team` admin (an admin with no `teamId`). Team admins created via signup have a `teamId` and are *not* system admins. |
| `getAuthorizedTeamId(req, paramTeamId)` | Returns the team a caller may act on: **superadmin** gets the requested team; **admin** gets their own `teamId`, or the requested one if they are the built-in team admin; **user** always gets their own `teamId` and can never override it with a param; unauthenticated gets `null` (route returns 401). |

Typical patterns:

```ts
// superadmin-only (most /api/admin/* routes)
const session = getSessionFromCookie(req.headers.get('cookie'));
if (!session || session.role !== 'superadmin') return 403;

// team-scoped (v1/team/*)
const teamId = getAuthorizedTeamId(req, req.nextUrl.searchParams.get('teamId'));
if (!teamId) return 401;
if (session.role === 'user') memberId = session.memberId;   // users are further narrowed to themselves

// personal dashboard (/api/stats, /api/state, /api/session)
if (session.role !== 'user') return 403;                    // these are for developers only
```

Privilege-escalation guards worth copying:
- `v1/team/members` blocks anyone but a system admin from granting `admin`, and blocks non-superadmins from editing a superadmin.
- Personal routes **re-resolve `member_id` from the DB** (`SELECT member_id FROM users WHERE id=…`) rather than trusting the cookie.
- Data-export style routes take `memberId` from the session for `role=user`, ignoring any query param.

---

## 6. Machine authentication: ingest API keys

- Key format: `av_live_` + 24 random bytes (base64url). Generated by `generateApiKey()` and **hashed with SHA-256** into `member_keys.key_hash` (unique). The raw key is shown once at creation.
- `memberFromAuthHeader(header)` (`lib/team/auth.ts`): parse `Bearer <key>`, hash it, and look it up in `member_keys` where `revoked_at IS NULL`, joined to `members`. It also requires that the linked user (if any) is not `active = false`. It resolves the team as the member's **oldest `team_members` row**, falling back to `members.team_id`, and updates `last_used_at`.
- Keys are bound to a **member**, not a team or a role. A key can only write data for that member.
- The ingest and update-check routes answer `Access-Control-Allow-Origin: *`, which is fine because they don't use cookies.

---

## 7. Data model

Schema source of truth: `lib/team/schema.sql` (reference) and `ensureSchema()` in `lib/team/db.ts` (what actually runs). They are not identical. `auth_totp`, `auth_throttle` and `chat_usage` are created lazily by their own modules.

**Identity & tenancy**
- `teams(id, name)`: an organisation or group. Everyone who self-signs-up as a user lands in the team named `Independent`.
- `members(id, team_id, display_name, role, daemon_version, daemon_last_seen_at, sync_requested_at)`: a tracked developer. This is the owner of synced data.
- `team_members(team_id, member_id, role)`: many-to-many. **This, not `members.team_id`, is the real membership.**
- `users(id, username, password_hash, display_name, member_id, team_id, role, active, failed_login_attempts, locked_until, api_key(legacy))`: dashboard logins. `users` and `members` are different things: a user may link to a member (developers) or have none (admins).
- `member_keys(member_id, key_hash, label, last_used_at, revoked_at)`: ingest credentials.

**Raw ingested data**
- `sync_sessions`: one row per agent session. Unique on `(team_id, member_id, source, session_id)`. Holds tokens in/out/cache, `api_cost`, edits and line counts, tool calls and errors, `rework_loops`, `corrections`, `abandoned`, `payload_hash` and an optional `events` JSONB.
- `sync_session_tools`, `sync_session_files`: per-session breakdowns (children, cascade on delete).
- `ingest_events`: one row per ingest request (health and audit of the pipeline).
- `session_turns`, `session_tool_errors`, `session_outcomes`, `redundant_reprompt_events`, `model_context_limits`, `prompt_embeddings`: "research" tables derived from `events`.

**Rollups (survive pruning of raw data)**
- `daily_member_usage`, `daily_member_tools`, `daily_member_files`, `daily_punch_card` (per member/day).
- `daily_org_usage`, `daily_pipeline_health`, `daily_behavior_rollup` (per org/day).

**Config & ops**
- `model_pricing(team_id NULL = global, model_pattern, cost_in/out/cache_read_per_m)`: price rules, with team rules taking precedence.
- `daemon_releases(version, mandatory, active, release_notes, released_at, …)`: daemon update channel.
- `audit_log(actor_user_id, actor_username, action, target_type, target_id, metadata JSONB, created_at)`.
- `auth_totp`, `auth_throttle`, `chat_usage`: security and usage counters.

**DB access layer (`lib/team/db.ts`)**
- One `pg.Pool` per process, cached on `globalThis`. `max: 5`, 20s connect timeout (Neon cold start), 60s query timeout, keepAlive, and an `error` handler so idle-connection drops don't crash the process.
- Use a Neon **`-pooler`** connection string on Vercel. A startup check logs a warning otherwise.
- `query(text, params)`: always use parameters. If Postgres reports `42P01` (missing table), it runs `ensureSchema()` once and retries. If `AUTO_ENSURE_SCHEMA=true` it ensures the schema before the first query. Errors log the code, a truncated message and the query text, **never the bound parameters**.
- `insertMany(table, columns, types, rows)`: bulk insert via `unnest()` in one round trip. Table and column names are interpolated, so they must be code constants.
- Migrations: `npm run db:migrate` (`scripts/migrate.js`) or `POST /api/admin/migrate` (superadmin).

---

## 8. Data pipeline (ingest → rollup → prune)

### 8.1 Collection (the daemon)
`bin/sync-daemon.mjs` is the source. The built copy that machines actually download is `public/sync-daemon.mjs`, installed by `public/install.sh` / `install.ps1`. It scans local agent transcripts and pushes aggregates every `intervalMin` (default 120). It reads `~/.devmetrics/config.json` (`apiUrl`, `apiKey`). It batches at most 25 sessions or 3 MB per request. `lib/team/sanitize.mjs` strips paths of the home directory and has an `assertNoPromptFields` guard against forbidden keys (`prompt`, `content`, `args`, `result`, `thinking`, etc.). It checks `/api/v1/update-check` on its own 24-hour interval and before syncing, and skips syncing while a mandatory update is pending.

### 8.2 Ingest (`POST /api/v1/ingest`)
1. `memberFromAuthHeader`, otherwise 401.
2. If `X-Daemon-Version` is sent, a fire-and-forget `UPDATE members SET daemon_version, daemon_last_seen_at`.
3. Body `{ sessions: [...] }` goes to `ingestSessions(member, sessions)` (`lib/team/ingest.ts`):
   - Loads pricing rules (team-specific first, then global, then hard-coded defaults).
   - For each session: normalises fields (it accepts both camelCase and snake_case), maps `<synthetic>` to `default`, estimates tokens if the daemon reported zero but there was activity, and **computes `api_cost` on the server** from the matching rule (fresh input, output, cache read, cache write).
   - **Upserts** into `sync_sessions` on `(team_id, member_id, source, session_id)`, so re-sending a session is idempotent and updates it.
   - Optionally derives `session_turns` and related research rows from `events` (failures here are logged, not fatal).
   - Replaces the per-session tool and file rows.
4. Writes an `ingest_events` row and clears the in-memory `statsCache`.
5. Response `{ accepted, total }`. Errors return `publicError(err)`.

Design takeaways: ingest is **idempotent**, **server-priced** (clients are never trusted for cost), and **member-scoped**.

### 8.3 Nightly rollup (Vercel Cron, 02:00 UTC)
`vercel.json` calls `GET /api/internal/rollup`. It is authorised if the caller is a **superadmin cookie** *or* presents `CRON_SECRET` (`Authorization: Bearer …` or `x-cron-secret`, compared with `safeEqual`). If `CRON_SECRET` is unset, it denies. It aggregates raw data into `daily_org_usage`, `daily_pipeline_health` and `daily_behavior_rollup` using `ON CONFLICT DO UPDATE`, so it is safe to re-run. It also runs `runResearchRollup()`. `/api/internal/rollup-research` is the research-only variant.

### 8.4 Prune (`npm run db:prune`)
`scripts/run-rollup-prune.js` backfills rollups, then prunes: raw `events` JSONB older than 7 days, turn logs older than 14 days, and raw `sync_sessions` older than 30 days. **This is why rollup tables exist.** Long-range analytics must read rollups, not `sync_sessions`.

### 8.5 Caching
`lib/team/cache.ts` has a small in-memory TTL cache (`statsCache`, 500 entries, default 60s) used by the team stats builder. It is **per instance**, so it can be stale for up to the TTL on other instances. Ingest clears only the local instance's copy.

---

## 9. Daemon distribution and updates

- `daemon_releases` rows are managed through `/api/internal/releases` (GET list, POST create/activate, PATCH activate/deactivate for rollback, DELETE). It requires an admin or superadmin cookie, with finer checks in some handlers. A superadmin dashboard view also drives it (`/api/internal/releases/publish-current`).
- `GET /api/v1/update-check` (Bearer key + `X-Daemon-Version`) records the version and returns `{ current, latest, url, sha256, mandatory, updateAvailable }`. The daemon verifies the SHA-256 of the download.
- `POST /api/admin/users/setup-command` lets a superadmin re-fetch the install commands (including the user's key) for onboarding a machine. Each reveal is audit-logged.

---

## 10. Superadmin surface (`/api/admin/*`)

All of these require `role === 'superadmin'`.

| Route | Purpose |
|---|---|
| `users` | CRUD for dashboard users (creates linked member and key, sets team and role). |
| `users/reset-password`, `users/reset-mfa` | Credential recovery. |
| `users/sessions` | `preview` / `delete` / `reassign` a user's synced sessions (for example when a PC changed hands). It requires `confirm` equal to the username and runs each action in one transaction, including derived rollup rows. |
| `users/setup-command` | Reveal daemon install commands. |
| `members`, `teams` | Member and team management. |
| `pricing`, `pricing/sync` | Global and per-team model price rules. |
| `cost-overview`, `usage-trends`, `top-usage`, `prompts` | Analytics views. |
| `pipeline-health`, `infra-health` | Ingest and infrastructure monitoring. |
| `audit-log` | Read the audit log (filters: action, dates, limit ≤ 500). |
| `impersonate`, `impersonate/return` | See 4.7. |
| `migrate` | Run the idempotent schema setup. |
| `chat` | Analyst chatbot. See `SUPERADMIN_CHAT.md`. |

---

## 11. Cross-cutting concerns

**Audit logging** (`lib/team/audit.ts`). `recordAuditEvent({actorUserId, actorUsername, action, targetType, targetId, metadata})` inserts into `audit_log`. It **never throws**, so logging can't break the action it records. Actions seen: `login_success`, `login_failed`, `mfa_failed`, `impersonate.start/end`, `chat.query`, plus user, pricing and password operations. Put only identifiers and counts in `metadata`, never secrets or result rows.

**Error handling.** Routes use `try/catch`, log the real error server-side, and return a generic message. `publicError(err)` (`lib/security/errors.ts`) returns the raw message in dev and `"Internal server error"` in production, because driver errors can leak hostnames and SQL. Auth failures are deliberately vague (`Invalid credentials`).

**Rate limiting, two flavours:**
- `rateLimit(key, limit, windowMs)` in `lib/security/request.ts` is in-memory, fixed-window and **per instance**. It is fine for cheap abuse control (the chat endpoint uses it).
- `auth_throttle` is DB-backed and works across instances. Use it for anything security-critical.

**Client IP.** `clientIp(req)` takes the first value of `X-Forwarded-For`. It is trustworthy only because Vercel sets it.

**Secrets and env vars**

| Variable | Used for |
|---|---|
| `DATABASE_URL` / `NEON_CONNECTION_STRING` | Postgres (pooled endpoint on Vercel) |
| `SESSION_SECRET` | Cookie signing **and** TOTP-secret encryption |
| `ADMIN_PASSWORD`, `SUPERADMIN_PASSWORD` | Built-in account passwords |
| `ADMIN_TOTP_SECRET`, `SUPERADMIN_TOTP_SECRET` | MFA for built-in accounts |
| `CRON_SECRET` | Cron endpoint auth |
| `GROQ_API_KEY`, `GROQ_MODEL`, `CHAT_DAILY_TOKEN_BUDGET` | Analyst chat |
| `AUTO_ENSURE_SCHEMA` | Auto-run schema setup |
| `NEXT_PUBLIC_SERVER_URL` | Used to build install commands |

`loadEnv()` also reads `.env.local` / `.env` for scripts and dev.

**Secure-cookie detection** is duplicated across routes (`isSecure`): HTTPS if `VERCEL=1` or `x-forwarded-proto=https`, and never on localhost.

---

## 12. Checklist: designing a new endpoint

1. **Decide the caller.** Human (cookie) or machine (Bearer key)? Don't mix. Cookie routes get CSRF protection from `proxy.ts` for free. Machine routes should be **idempotent**.
2. **Auth first, before parsing or DB work.**
   - Superadmin-only: check `session.role === 'superadmin'` → 403.
   - Team data: use `getAuthorizedTeamId`, and narrow `role=user` to `session.memberId`.
   - Never trust IDs from the body or query for scoping when the session already knows them.
   - For anything powerful, **don't rely on the cookie alone** if the data could change under it (role, active). Re-read the user row, as `/api/auth/me` does.
3. **Validate input.** Check UUID format (`/^[0-9a-f]{8}-…$/i`) before using an ID in SQL, clamp numbers and limit string lengths, and use parameterised queries only. Interpolate only code constants (as `insertMany` and the chat reports do, with clamped ints).
4. **Decide the read source.** Dashboards over long windows must read **rollup tables**, because raw sessions are pruned at 30 days.
5. **Multi-step writes → one transaction** (see `users/sessions`). The shared `query()` helper isn't transactional, so take a client from `getPool()` for that.
6. **Audit sensitive actions** with `recordAuditEvent`. Include actor, target and non-secret metadata.
7. **Rate-limit** abuse-prone endpoints. Use `auth_throttle` for credentials, and `rateLimit` for cheap protection.
8. **Return safe errors.** Log the full error, return `publicError(err)`, and use the same message for different auth failures.
9. **Set `dynamic = 'force-dynamic'`**, and think about caching. If you add a cache, remember it is per instance.
10. **Don't expose raw secrets.** Show API keys once at creation. Store only hashes. Keep new secret-bearing tables and columns **out** of `lib/admin/chat/analyst-grants.json`.
11. **New table?** Add it to `ensureSchema()` or `schema.sql`, add indexes on `(team_id, …)`, and decide whether the analyst chat should be able to read it (grants file, then `npm run db:analyst-role`).
12. **Long-running or scheduled work** goes through `vercel.json` crons hitting an `/api/internal/*` route protected by `CRON_SECRET`, and written as an idempotent upsert.

---

## 13. Inconsistencies and risks to know about (don't copy these)

These are observations from the code, listed so new work doesn't inherit them.

1. **No shared auth wrapper.** Every route re-implements `getSessionFromCookie` plus a role check, and they differ in style. A new route that forgets the check is open, since nothing in `proxy.ts` blocks unauthenticated API access. Consider a `requireRole()` helper.
2. **Stateless sessions can't be revoked.** There is no logout-everywhere, and disabling a user takes effect only where a route re-checks the DB (`/api/auth/me`, and the ingest-key join for `active=false`). Most cookie routes trust the token until it expires.
3. **`users.api_key` is still written at signup** (`app/api/auth/signup/route.ts` inserts the raw key), even though comments elsewhere say raw keys are never stored. The `/api/auth/me` route no longer reads it, but the column still holds plaintext keys for users created that way. Treat it as legacy and don't build on it.
4. **Teams are two sources of truth.** `members.team_id`, `users.team_id` and `team_members` can disagree. Login and ingest resolve "the" team as the **oldest** `team_members` row. Multi-team users therefore have a single "primary" team in sessions and ingest.
5. **Open signup can create team admins.** `signup` accepts `role: 'admin'` and creates a team. The protection is that admins need MFA enrollment at first login, and that `isSystemAdmin` excludes team-bound admins. Review before adding admin-only capabilities that rely on `role === 'admin'` alone.
6. **`/api/v1/teams` `requireAdmin` includes `user`** in its role check despite the name. Read the handler before reusing it.
7. **In-memory limiter and cache are per instance** (serverless). Effective limits and freshness are looser than the numbers suggest.
8. **Dev-mode MFA bypass.** Built-in accounts skip MFA when `NODE_ENV !== 'production'` and no TOTP secret is set. Never run a shared or staging environment in development mode.
9. **Schema is defined in two places** (`schema.sql` and `ensureSchema()`) and ad hoc in modules (`CREATE TABLE IF NOT EXISTS` in `auth-store`, `usage`, and the rollup route). Keep them in sync when you add a table.
10. **TLS verification is off for the DB** (`ssl: { rejectUnauthorized: false }`). It is common with Neon, but note it.
11. **Impersonation of privileged users is permitted.** Only the audit log tracks it.
12. **`SESSION_SECRET` has two jobs.** Rotating it invalidates all sessions and all stored TOTP secrets. Plan a re-enrollment path before rotating.
