# Token Tracer MCP — Claude Desktop Integration & Manual Smoke Test Guide (Phase 4.7)

This runbook provides the exact, step-by-step instructions for performing a real manual smoke test of Token Tracer MCP using the official **Claude Desktop** application.

---

## 1. Safety & Isolation Model

- **Zero Production Access**: All manual tests use isolated, disposable local fixtures or mock in-memory stores. Production databases and Vercel environments are never touched.
- **Strict Metadata Only**: All tool responses return structured JSON counts, metrics, timestamps, and model names. Raw prompt text, user code, file paths, and snippets are strictly excluded by design.
- **Identity Integrity**: Tenant identity (`teamId`, `userId`, `role`) is bound server-side to the authenticated OAuth token hash. No client-side parameter can override tenant scope.

---

## 2. Server Setup & Network Transport

Claude Desktop supports two connector models for MCP:
1. **Remote HTTP Connectors (Claude Desktop → Settings → Connectors)**: Requires a publicly accessible or loopback HTTPS/HTTP URL reachable by Claude Desktop's authentication handler and callback redirect (`https://claude.ai/api/mcp/auth_callback`).
2. **Local Subprocess Connectors (`claude_desktop_config.json`)**: Executes a local command communicating over standard input/output (`stdio`).

### Step 2.1: Start the Local Smoke Server

In your terminal, start the dedicated Token Tracer smoke test server:

```bash
npx tsx scripts/run-mcp-smoke-server.ts --port 3000 --hostname 127.0.0.1
```

You should see:
```text
======================================================
 Token Tracer MCP — Smoke Test Server Running
 Local Endpoint:  http://127.0.0.1:3000/mcp
 Resource URL:    http://127.0.0.1:3000/mcp
 Discovery URL:   http://127.0.0.1:3000/.well-known/oauth-protected-resource/mcp
 Environment:     Isolated In-Memory Test Mode (0 Prod Access)
======================================================
```

*(Optional: If Claude Desktop requires an HTTPS endpoint for remote OAuth discovery, expose port 3000 using your local tunnel tool: `ngrok http 3000` or `cloudflared tunnel --url http://127.0.0.1:3000`, and set `MCP_PUBLIC_BASE_URL` to the public HTTPS URL).*

---

## 3. Step-by-Step Claude Desktop Connection Guide

### Step 3.1: Open Connectors Settings
1. Launch **Claude Desktop** (`/Applications/Claude.app`).
2. Open Settings via `Cmd + ,` (or menu: **Claude** → **Settings...**).
3. In the left navigation sidebar, select **Connectors** (or **Integrations** / **Developer** depending on desktop version).
4. Click **Add Connector** / **Add Remote MCP Server**.

### Step 3.2: Configure Server URL
1. Name: `Token Tracer Local`
2. Server URL: `http://127.0.0.1:3000/mcp` (or your tunnel HTTPS URL)
3. Click **Connect** / **Authorize**.

### Step 3.3: OAuth Browser Authorization & Consent
1. Claude Desktop initiates discovery (`GET /.well-known/oauth-protected-resource/mcp`) and opens your default web browser to:
   ```text
   http://127.0.0.1:3000/oauth/authorize?client_id=...&redirect_uri=...&response_type=code&code_challenge=...
   ```
2. The browser renders the **Token Tracer Authorization Page**:
   - Client: `Claude Desktop` / `Claude Real Client`
   - Identity: `Team Alpha Admin (Acme Alpha Team)`
   - Permitted Scopes: Read team developer summaries, inspect session activity, and query prompt metadata.
   - Privacy Banner: *"Strict metadata only. Zero prompt text or file paths exposed."*
3. Click **Approve Connection**.
4. The server records consent, generates a single-use authorization code (`tt_ac_...`), and redirects to:
   ```text
   https://claude.ai/api/mcp/auth_callback?code=tt_ac_...&state=...
   ```
5. Claude Desktop completes the token exchange (`POST /oauth/token`) and transitions the connector status to **Connected** with a green status indicator.

---

## 4. Manual Test Checklist & Verification Steps

Execute each prompt in a fresh Claude Desktop chat session:

### Test 1: Tool Discovery
- **Action**: In the chat compose box, click the attachment/tool icon or type:
  > *"What tools are available from the Token Tracer connector?"*
- **Expected Result**:
  - Claude lists **exactly six approved tools**:
    1. `list_developers`
    2. `developer_activity`
    3. `list_sessions`
    4. `session_details`
    5. `search_prompt_metadata`
    6. `prompt_metadata_batch`
  - **Zero** unapproved tools, resource templates, or raw prompts.

### Test 2: `list_developers` Invocation
- **Prompt**:
  > *"List the developers on my team using Token Tracer."*
- **Expected Result**:
  - Claude invokes `list_developers({ limit: 10 })`.
  - Returns Alice Developer (`33333333-3333-4333-8333-333333333333`, Admin) and Bob Developer (`55555555-5555-4555-8555-555555555555`, Member).
  - Keyset cursor is returned if additional pages exist.

### Test 3: `developer_activity` Invocation
- **Prompt**:
  > *"Show me developer activity for developer 33333333-3333-4333-8333-333333333333 over the past 7 days."*
- **Expected Result**:
  - Claude invokes `developer_activity({ developerId: "33333333-3333-4333-8333-333333333333", from: "2026-11-20", to: "2026-11-27" })`.
  - Returns daily token breakdown (12,500 input tokens, 4,800 output tokens, $0.42 API cost, 8 edits, 170 lines changed).

### Test 4: `list_sessions` & `session_details` Invocation
- **Prompt**:
  > *"Find recent sessions for my team, and then get details for the first session."*
- **Expected Result**:
  - Claude invokes `list_sessions({ limit: 5 })`, receiving a session list with an opaque `sessionRef`.
  - Claude then invokes `session_details({ sessionRef: "..." })` using the opaque sealed reference.
  - Returns tool usage breakdown (e.g. 9 `read_file` calls, 5 `edit_file` calls) without leaking underlying database IDs or cross-team data.

### Test 5: `search_prompt_metadata` Invocation (Privacy Check)
- **Prompt**:
  > *"Search for recent prompts that had code blocks or feature intents."*
- **Expected Result**:
  - Claude invokes `search_prompt_metadata({ hasCodeBlock: true, intents: ["feature"] })`.
  - Returns turn index, model name (`claude-3-5-sonnet`), character count (140), and token usage.
  - **Privacy Boundary**: Verifiably **zero** prompt text, code snippets, or system paths appear in the raw tool response.

### Test 6: Tenant Isolation & Adversarial Probing
- **Prompt**:
  > *"Call session_details with sessionRef 'tt_s_dummy_foreign_token_beta' or try to inspect Team Beta's developers."*
- **Expected Result**:
  - Tool execution fails closed with `The requested resource was not found.` (`code: not_found`).
  - No existence enumeration or leakage of foreign tenant existence.

### Test 7: Token Revocation & Post-Revocation Behavior
- **Action**: In another terminal, revoke the active access token or trigger revocation via:
  ```bash
  curl -X POST http://127.0.0.1:3000/oauth/revoke -d "token=<access_token>"
  ```
  *(Or disconnect the connector in Claude Desktop Settings).*
- **Prompt in Claude**:
  > *"List developers again."*
- **Expected Result**:
  - Server immediately rejects the call with `401 Unauthorized`.
  - Claude Desktop prompts to re-authenticate or displays connector disconnected.

---

## 5. Troubleshooting & Diagnostic Guide

| Symptom | Cause | Solution |
|---|---|---|
| **`404 Not Found` on `/mcp`** | Server not running with `MCP_ENABLED=true` | Ensure `scripts/run-mcp-smoke-server.ts` is running and `MCP_ENABLED` is set. |
| **`503 Service Unavailable` on discovery** | `MCP_PUBLIC_BASE_URL` mismatch | The Host header sent by Claude must match `MCP_PUBLIC_BASE_URL` canonical host. Check terminal output for the exact URL. |
| **Browser redirects to `fatal` error page** | Invalid `redirect_uri` or unknown `client_id` | Ensure Claude Desktop registers with `https://claude.ai/api/mcp/auth_callback` or `http://localhost/callback`. |
| **`Invalid arguments supplied` on tool call** | Parameter smuggling or query field in search | Confirm that search requests do not include free-text parameters like `query` or `search`. Only structured metadata filters are permitted. |
| **Tool call hangs or timeouts** | Reader pool connection exhaustion | Verify local server concurrency settings; smoke server allows up to 5 concurrent connections. |
