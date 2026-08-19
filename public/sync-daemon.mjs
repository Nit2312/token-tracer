#!/usr/bin/env node

// bin/sync-daemon.mjs
import fs3 from "node:fs";
import path4 from "node:path";
import { execSync, spawn } from "node:child_process";

import { fileURLToPath } from "node:url";

// lib/scan.mjs
import fs2 from "node:fs";
import path2 from "node:path";

// lib/adapters.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
var require2 = createRequire(import.meta.url);
var UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
var SPAWN_TOOL_RE = /spawn|subagent|sub_agent|^task$|^agent$/i;
function newSession(source, file, agent) {
  return {
    id: path.basename(file, ".jsonl"),
    source,
    agent,
    file,
    label: "",
    model: null,
    startedAt: null,
    endedAt: null,
    events: [],
    stats: { toolCounts: {}, tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0, messages: 0, errors: 0 },
    spawnCandidates: [],
    children: [],
    parent: null
  };
}
function blocksOf(content) {
  if (content == null) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content;
  return [content];
}
function textOf(content) {
  return blocksOf(content).map((b) => typeof b === "string" ? b : b.text ?? b.thinking ?? "").filter(Boolean).join("\n");
}
function sumUsage(stats, usage) {
  if (!usage || typeof usage !== "object") return;
  const cacheRead = Number(
    usage.cacheRead ??
    usage.cache_read_input_tokens ??
    usage.cacheReadTokens ??
    usage.cache_read_tokens ??
    usage.prompt_tokens_details?.cached_tokens ??
    0
  );
  const cacheWrite = Number(
    usage.cacheWrite ??
    usage.cache_creation_input_tokens ??
    usage.cacheWriteTokens ??
    usage.cache_write_tokens ??
    0
  );
  const rawIn = Number(
    usage.input ??
    usage.input_tokens ??
    usage.inputTokens ??
    usage.prompt_tokens ??
    usage.promptTokens ??
    usage.tokensIn ??
    usage.tokens_in ??
    0
  );
  const rawOut = Number(
    usage.output ??
    usage.output_tokens ??
    usage.outputTokens ??
    usage.completion_tokens ??
    usage.completionTokens ??
    usage.tokensOut ??
    usage.tokens_out ??
    0
  );
  stats.tokensIn += rawIn + cacheRead + cacheWrite;
  stats.tokensOut += rawOut;
  stats.tokensCacheRead += cacheRead;
  stats.tokensCacheWrite += cacheWrite;
}
function estimateTokensIfMissing(session) {
  if ((session.stats.tokensIn || 0) + (session.stats.tokensOut || 0) > 0) return;
  let inChars = 0;
  let outChars = 0;
  for (const ev of session.events) {
    const len = typeof ev.text === "string" ? ev.text.length : 0;
    if (ev.kind === "user") inChars += len || 40;
    else if (ev.kind === "assistant" || ev.kind === "thinking") outChars += len || 40;
    else if (ev.kind === "tool") outChars += JSON.stringify(ev.tool?.args ?? {}).length || 30;
  }
  if (inChars > 0 || outChars > 0) {
    session.stats.tokensIn = Math.ceil(inChars / 4);
    session.stats.tokensOut = Math.ceil(outChars / 4);
  }
}
function jsonLines(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
    }
  }
  return out;
}
function addToolCall(session, pending, ts, { id, name, args: args2 }) {
  const ev = { kind: "tool", ts, tool: { id: id ?? null, name, args: args2 ?? {}, result: null, isError: false, resultTs: null } };
  session.stats.toolCounts[name] = (session.stats.toolCounts[name] || 0) + 1;
  session.events.push(ev);
  if (id) pending.set(id, ev);
  if (SPAWN_TOOL_RE.test(name)) {
    for (const u of JSON.stringify(args2 ?? {}).match(UUID_RE) ?? []) session.spawnCandidates.push({ uuid: u.toLowerCase(), ev });
  }
  return ev;
}
function attachResult(session, pending, callId, text, isError, ts) {
  const ev = callId && pending.get(callId);
  if (ev) {
    ev.tool.result = text;
    ev.tool.isError = Boolean(isError);
    ev.tool.resultTs = ts;
    if (SPAWN_TOOL_RE.test(ev.tool.name)) {
      for (const u of (text ?? "").match(UUID_RE) ?? []) session.spawnCandidates.push({ uuid: u.toLowerCase(), ev });
    }
  }
  if (isError) session.stats.errors++;
}
function touch(session, ts) {
  if (!ts) return;
  session.startedAt ??= ts;
  session.endedAt = ts;
}
function finalizeLabel(session) {
  if (!session.label) {
    const first = session.events.find((e) => e.kind === "user" || e.kind === "assistant");
    session.label = first ? first.text.slice(0, 100) : "(empty session)";
  }
  estimateTokensIfMissing(session);
}
function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
function* walkJsonl(dir, depth = 4) {
  for (const name of safeReaddir(dir)) {
    const p = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory() && depth > 0) yield* walkJsonl(p, depth - 1);
    else if (st.isFile() && name.endsWith(".jsonl")) yield p;
  }
}
function parseGenericMessage(session, pending, obj) {
  const m = obj.message ?? (obj.role ? obj : null);
  if (!m) {
    if (obj.type && obj.type !== "session") session.events.push({ kind: "meta", ts: obj.timestamp ?? null, text: obj.type });
    return;
  }
  const ts = obj.timestamp ?? m.timestamp ?? null;
  touch(session, ts);
  const role = m.role;
  if (role === "assistant") {
    session.stats.messages++;
    if (m.model) session.model = m.model;
    sumUsage(session.stats, m.usage);
    const turnUsage = m.usage ? {
      tokensIn: Number(m.usage.input ?? m.usage.input_tokens ?? m.usage.inputTokens ?? m.usage.prompt_tokens ?? m.usage.promptTokens ?? m.usage.tokensIn ?? m.usage.tokens_in ?? 0),
      tokensOut: Number(m.usage.output ?? m.usage.output_tokens ?? m.usage.outputTokens ?? m.usage.completion_tokens ?? m.usage.completionTokens ?? m.usage.tokensOut ?? m.usage.tokens_out ?? 0),
      cacheRead: Number(m.usage.cacheRead ?? m.usage.cache_read_input_tokens ?? m.usage.cacheReadTokens ?? m.usage.cache_read_tokens ?? m.usage.prompt_tokens_details?.cached_tokens ?? 0)
    } : null;
    for (const b of blocksOf(m.content)) {
      const t = b.type ?? "text";
      if (t === "thinking" || t === "redacted_thinking") session.events.push({ kind: "thinking", ts, text: b.thinking ?? b.text ?? "" });
      else if (t === "text") {
        if (b.text) session.events.push({ kind: "assistant", ts, text: b.text, usage: turnUsage });
      } else if (t === "toolCall" || t === "tool_use" || t === "toolUse")
        addToolCall(session, pending, ts, { id: b.id ?? b.toolCallId, name: b.name ?? b.toolName ?? "tool", args: b.arguments ?? b.input });
    }
  } else if (role === "toolResult" || role === "tool") {
    attachResult(session, pending, m.toolCallId ?? m.tool_call_id ?? m.id, textOf(m.content ?? m.output ?? m.result ?? ""), m.isError ?? m.is_error, ts);
  } else if (role === "user") {
    const blocks = blocksOf(m.content);
    const results = blocks.filter((b) => b.type === "tool_result" || b.type === "toolResult");
    if (results.length) {
      for (const b of results) attachResult(session, pending, b.tool_use_id ?? b.toolCallId, textOf(b.content ?? ""), b.is_error ?? b.isError, ts);
    }
    const text = blocks.filter((b) => (b.type ?? "text") === "text").map((b) => b.text ?? "").filter(Boolean).join("\n");
    if (text && !text.startsWith("<")) {
      session.stats.messages++;
      session.events.push({ kind: "user", ts, text });
      if (!session.label) session.label = text.slice(0, 100);
    }
  }
}
function parseOpenclawFile(source, file, agent) {
  const session = newSession(source, file, agent);
  const pending = /* @__PURE__ */ new Map();
  for (const obj of jsonLines(file)) {
    if (obj.type === "session") {
      if (obj.id) session.id = obj.id;
      touch(session, obj.timestamp);
      continue;
    }
    parseGenericMessage(session, pending, obj);
  }
  finalizeLabel(session);
  return session.events.length ? [session] : [];
}
function openclawAdapter(explicitDir) {
  const roots = explicitDir ? [path.resolve(explicitDir)] : [path.join(os.homedir(), ".openclaw"), path.join(os.homedir(), ".clawdbot"), path.join(os.homedir(), ".moltbot")];
  return {
    source: "openclaw",
    findFiles() {
      const found = [];
      for (const root of roots) {
        const agentsDir = path.join(root, "agents");
        for (const agent of safeReaddir(agentsDir)) {
          for (const f of safeReaddir(path.join(agentsDir, agent, "sessions"))) {
            if (f.endsWith(".jsonl")) found.push({ file: path.join(agentsDir, agent, "sessions", f), agent });
          }
        }
        for (const f of safeReaddir(path.join(root, "sessions"))) {
          if (f.endsWith(".jsonl")) found.push({ file: path.join(root, "sessions", f), agent: "default" });
        }
      }
      return found;
    },
    parseFile: ({ file, agent }) => parseOpenclawFile("openclaw", file, agent)
  };
}
var CC_SKIP_TYPES = /* @__PURE__ */ new Set([
  "attachment",
  "file-history-snapshot",
  "file-history-delta",
  "last-prompt",
  "mode",
  "permission-mode",
  "progress",
  "queued-prompt"
]);
function ccParseMessageInto(session, pending, obj) {
  const ts = obj.timestamp ?? null;
  touch(session, ts);
  if (obj.type === "system") {
    if (!obj.isMeta) session.events.push({ kind: "meta", ts, text: obj.subtype ?? "system" });
    return;
  }
  if (obj.isMeta) return;
  parseGenericMessage(session, pending, obj);
}
function parseClaudeCodeFile(file, projectDir) {
  const lines = jsonLines(file);
  const main2 = newSession("claude-code", file, projectDir);
  const pendingMain = /* @__PURE__ */ new Map();
  let title = null;
  const sidechainLines = [];
  for (const obj of lines) {
    if (obj.cwd && main2.agent === projectDir) main2.agent = path.basename(obj.cwd);
    if (obj.type === "ai-title" && obj.aiTitle) {
      title = obj.aiTitle;
      continue;
    }
    if (obj.type === "summary" && obj.summary) {
      title ??= obj.summary;
      continue;
    }
    if (CC_SKIP_TYPES.has(obj.type)) continue;
    if (obj.isSidechain) {
      sidechainLines.push(obj);
      continue;
    }
    if (obj.type === "user" || obj.type === "assistant" || obj.type === "system") ccParseMessageInto(main2, pendingMain, obj);
  }
  if (title) main2.label = title;
  finalizeLabel(main2);
  const byUuid = new Map(sidechainLines.map((o) => [o.uuid, o]));
  const rootOf = (o, seen = /* @__PURE__ */ new Set()) => {
    while (o.parentUuid && byUuid.has(o.parentUuid) && !seen.has(o.uuid)) {
      seen.add(o.uuid);
      o = byUuid.get(o.parentUuid);
    }
    return o.uuid;
  };
  const chains = /* @__PURE__ */ new Map();
  for (const o of sidechainLines) {
    const r = rootOf(o);
    if (!chains.has(r)) chains.set(r, []);
    chains.get(r).push(o);
  }
  const sessions = [main2];
  let i = 0;
  for (const [, chain] of chains) {
    const child = newSession("claude-code", file, main2.agent);
    child.id = `${main2.id}-sub${i++}`;
    child.parent = main2.id;
    const pending = /* @__PURE__ */ new Map();
    for (const obj of chain) ccParseMessageInto(child, pending, obj);
    if (!child.events.length) continue;
    if (!child.label) child.label = "(sub-agent)";
    main2.children.push(child.id);
    sessions.push(child);
    const firstUser = child.events.find((e) => e.kind === "user")?.text ?? "";
    for (const ev of main2.events) {
      if (ev.kind !== "tool" || ev.tool.spawnTarget || !SPAWN_TOOL_RE.test(ev.tool.name)) continue;
      const prompt = ev.tool.args?.prompt ?? "";
      if (prompt && firstUser && (prompt.startsWith(firstUser.slice(0, 60)) || firstUser.startsWith(prompt.slice(0, 60)))) {
        ev.tool.spawnTarget = child.id;
        break;
      }
    }
  }
  return main2.events.length ? sessions : [];
}
function claudeCodeAdapter() {
  const root = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, "projects") : path.join(os.homedir(), ".claude", "projects");
  return {
    source: "claude-code",
    findFiles() {
      const found = [];
      for (const proj of safeReaddir(root)) {
        const dir = path.join(root, proj);
        for (const f of walkJsonl(dir, 2)) found.push({ file: f, agent: proj });
      }
      return found;
    },
    parseFile: ({ file, agent }) => parseClaudeCodeFile(file, agent)
  };
}
function parseCodexFile(file) {
  const session = newSession("codex", file, "codex");
  const m = /rollout-.*?([0-9a-f-]{36})\.jsonl$/i.exec(path.basename(file));
  if (m) session.id = m[1];
  const pending = /* @__PURE__ */ new Map();
  for (const obj of jsonLines(file)) {
    const ts = obj.timestamp ?? null;
    const p = obj.payload ?? obj;
    const type = p.type ?? obj.type;
    if (obj.type === "session_meta") {
      if (p.id) session.id = p.id;
      if (p.cwd) session.agent = path.basename(p.cwd);
      touch(session, p.timestamp ?? ts);
      continue;
    }
    if (obj.type === "turn_context") {
      if (p.model) session.model = p.model;
      continue;
    }
    if (obj.type === "compacted") {
      session.events.push({ kind: "meta", ts, text: "context compacted" });
      touch(session, ts);
      continue;
    }
    if (obj.type === "event_msg") {
      if (type === "token_count" && p.info?.total_token_usage) {
        const u = p.info.total_token_usage;
        session.stats.tokensIn = u.input_tokens ?? 0;
        session.stats.tokensOut = u.output_tokens ?? 0;
        session.stats.tokensCacheRead = u.cached_input_tokens ?? 0;
      }
      continue;
    }
    if (obj.type !== "response_item" && obj.type !== void 0 && !p.role && !type) continue;
    touch(session, ts);
    if (type === "message") {
      const text = blocksOf(p.content).map((b) => b.text ?? "").filter(Boolean).join("\n");
      if (!text) continue;
      const injected = text.startsWith("<") || /^# AGENTS\.md instructions/.test(text);
      if (p.role === "user" && !injected) {
        session.stats.messages++;
        session.events.push({ kind: "user", ts, text });
        if (!session.label) session.label = text.slice(0, 100);
      } else if (p.role === "assistant") {
        session.stats.messages++;
        session.events.push({ kind: "assistant", ts, text });
      }
    } else if (type === "reasoning") {
      const text = (p.summary ?? []).map((b) => b.text ?? "").filter(Boolean).join("\n");
      if (text) session.events.push({ kind: "thinking", ts, text });
    } else if (type === "function_call" || type === "custom_tool_call") {
      let args2 = p.arguments ?? p.input ?? {};
      if (typeof args2 === "string") {
        try {
          args2 = JSON.parse(args2);
        } catch {
          args2 = { input: args2 };
        }
      }
      addToolCall(session, pending, ts, { id: p.call_id ?? p.id, name: p.name ?? "tool", args: args2 });
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      let out = p.output ?? "";
      if (typeof out === "string" && out.startsWith("{")) {
        try {
          out = JSON.parse(out).output ?? out;
        } catch {
        }
      }
      const isError = /(?:exited with code (?!0\b)\d+|process exited with code (?!0\b)\d+|script (?:failed|error))/i.test(String(out).slice(0, 500));
      attachResult(session, pending, p.call_id ?? p.id, String(out), isError, ts);
    } else if (type === "web_search_call") {
      addToolCall(session, pending, ts, { id: p.id, name: "web_search", args: p.action ?? {} });
    }
  }
  finalizeLabel(session);
  return session.events.length ? [session] : [];
}
function codexAdapter() {
  const root = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "sessions");
  return {
    source: "codex",
    findFiles: () => [...walkJsonl(root, 4)].map((file) => ({ file, agent: "codex" })),
    parseFile: ({ file }) => parseCodexFile(file)
  };
}
function hermesAdapter() {
  const root = process.env.HERMES_STATE_DIR ?? path.join(os.homedir(), ".hermes");
  return {
    source: "hermes",
    findFiles: () => [...walkJsonl(root, 4)].map((file) => ({ file, agent: path.basename(path.dirname(file)) })),
    parseFile: ({ file, agent }) => parseOpenclawFile("hermes", file, agent)
  };
}
var CURSOR_TS_RE = /<timestamp>\s*([^<]+?)\s*<\/timestamp>/i;
var CURSOR_QUERY_RE = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i;
function cursorIsoFromMs(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return null;
}
function cursorDisplayText(raw) {
  if (typeof raw !== "string" || !raw) return "";
  const query = CURSOR_QUERY_RE.exec(raw);
  let text = query ? query[1].trim() : raw;
  text = text.replace(CURSOR_TS_RE, "").replace(/<\/?user_query>/gi, "").trim();
  return text;
}
function cursorTimestampFromText(raw) {
  if (typeof raw !== "string") return null;
  const m = CURSOR_TS_RE.exec(raw);
  if (!m) return null;
  const parsed = Date.parse(m[1].trim());
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}
function parseCursorArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return { value: raw };
  try {
    return JSON.parse(raw);
  } catch {
    return { input: raw };
  }
}
function parseCursorJsonlInto(session, file) {
  const pending = /* @__PURE__ */ new Map();
  let toolSeq = 0;
  for (const obj of jsonLines(file)) {
    if (obj?.type === "turn_ended") {
      session.events.push({ kind: "meta", ts: null, text: `turn_ended:${obj.status ?? "unknown"}` });
      continue;
    }
    const role = obj?.role ?? obj?.message?.role;
    const message = obj?.message ?? obj;
    if (!role) continue;
    if (role === "user") {
      const raw = textOf(message.content);
      const text = cursorDisplayText(raw);
      const ts = cursorTimestampFromText(raw);
      touch(session, ts);
      if (!text) continue;
      session.stats.messages++;
      session.events.push({ kind: "user", ts, text });
      if (!session.label) session.label = text.slice(0, 100);
      continue;
    }
    if (role === "assistant") {
      session.stats.messages++;
      if (message.model) session.model = message.model;
      sumUsage(session.stats, message.usage);
      for (const b of blocksOf(message.content)) {
        const t = b.type ?? "text";
        if (t === "thinking" || t === "redacted_thinking") {
          session.events.push({ kind: "thinking", ts: null, text: b.thinking ?? b.text ?? "" });
        } else if (t === "text") {
          if (b.text) session.events.push({ kind: "assistant", ts: null, text: b.text });
        } else if (t === "tool_use" || t === "toolUse" || t === "toolCall") {
          const id = b.id ?? b.toolCallId ?? `cursor-tool-${toolSeq++}`;
          addToolCall(session, pending, null, {
            id,
            name: b.name ?? b.toolName ?? "tool",
            args: b.input ?? b.arguments ?? {}
          });
        }
      }
      continue;
    }
    if (role === "tool" || role === "toolResult") {
      attachResult(
        session,
        pending,
        message.toolCallId ?? message.tool_call_id ?? message.id,
        textOf(message.content ?? message.output ?? message.result ?? ""),
        message.isError ?? message.is_error,
        null
      );
    }
  }
  return pending;
}
var _cachedDatabaseSync = void 0;
function getCursorDatabaseSync() {
  if (_cachedDatabaseSync !== void 0) return _cachedDatabaseSync;
  try {
    _cachedDatabaseSync = require2("node:sqlite").DatabaseSync;
  } catch {
    _cachedDatabaseSync = null;
  }
  return _cachedDatabaseSync;
}
function cursorStateDbPath() {
  if (process.env.CURSOR_STATE_DB) return process.env.CURSOR_STATE_DB;
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || os.homedir(), "Cursor", "User", "globalStorage", "state.vscdb");
  }
  return path.join(os.homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
}
function enrichCursorSessionFromDb(session, composerId, DatabaseSync = getCursorDatabaseSync(), dbPath = cursorStateDbPath(), db = null) {
  if (!composerId) return;
  let owned = false;
  if (!db) {
    if (!DatabaseSync || !dbPath) return;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      owned = true;
    } catch {
      return;
    }
  }
  try {
    const composerRow = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?").get(`composerData:${composerId}`);
    if (!composerRow?.value) return;
    let composer;
    try {
      composer = JSON.parse(composerRow.value);
    } catch {
      return;
    }
    if (composer.name) {
      const weak = !session.label || session.label === "(empty session)" || session.label === "(sub-agent)" || session.label.length < 12;
      if (weak) session.label = String(composer.name).slice(0, 100);
    }
    const modelName = composer.modelConfig?.selectedModels?.[0]?.modelId ?? composer.modelConfig?.modelName ?? null;
    if (modelName && modelName !== "default") session.model = modelName;
    else if (modelName && !session.model) session.model = modelName;
    const started = cursorIsoFromMs(composer.createdAt);
    const ended = cursorIsoFromMs(composer.lastUpdatedAt);
    if (started) session.startedAt ??= started;
    if (ended) session.endedAt = ended;
    else if (started && !session.endedAt) session.endedAt = started;
    session.cursorMeta = {
      totalLinesAdded: composer.totalLinesAdded ?? 0,
      totalLinesRemoved: composer.totalLinesRemoved ?? 0,
      filesChangedCount: composer.filesChangedCount ?? 0,
      contextUsagePercent: composer.contextUsagePercent ?? null,
      unifiedMode: composer.unifiedMode ?? null
    };
    const headers = composer.fullConversationHeadersOnly ?? [];
    const getBubble = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");
    const unmatchedTools = session.events.filter((e) => e.kind === "tool" && (e.tool.result == null || e.tool.result === ""));
    let toolIdx = 0;
    for (const header of headers) {
      const bubbleId = header?.bubbleId;
      if (!bubbleId) continue;
      const row = getBubble.get(`bubbleId:${composerId}:${bubbleId}`);
      if (!row?.value) continue;
      let bubble;
      try {
        bubble = JSON.parse(row.value);
      } catch {
        continue;
      }
      const ts = cursorIsoFromMs(bubble.createdAt);
      if (ts) touch(session, ts);
      sumUsage(session.stats, {
        input_tokens: bubble.tokenCount?.inputTokens,
        output_tokens: bubble.tokenCount?.outputTokens,
        cache_read_input_tokens: bubble.tokenCount?.cacheReadTokens ?? bubble.tokenCount?.cache_read_input_tokens,
        cache_creation_input_tokens: bubble.tokenCount?.cacheWriteTokens ?? bubble.tokenCount?.cache_creation_input_tokens
      });
      if (bubble.modelInfo?.modelName && bubble.modelInfo.modelName !== "default") {
        session.model = bubble.modelInfo.modelName;
      }
      const tf = bubble.toolFormerData;
      if (!tf?.name) continue;
      const args2 = parseCursorArgs(tf.rawArgs ?? tf.params);
      const resultText = typeof tf.result === "string" ? tf.result : tf.result != null ? JSON.stringify(tf.result) : "";
      const status = String(tf.status ?? "").toLowerCase();
      const isError = Boolean(tf.isError) || /^(error|failed|cancelled|canceled)$/.test(status) || status.includes("error") || status.includes("fail");
      let target = null;
      while (toolIdx < unmatchedTools.length) {
        const candidate = unmatchedTools[toolIdx++];
        if (String(candidate.tool.name).toLowerCase() === String(tf.name).toLowerCase()) {
          target = candidate;
          break;
        }
      }
      if (target) {
        if (ts && !target.ts) target.ts = ts;
        if (!Object.keys(target.tool.args || {}).length) target.tool.args = args2;
        if (tf.toolCallId) target.tool.id = tf.toolCallId;
        const pending = /* @__PURE__ */ new Map([[target.tool.id, target]]);
        attachResult(session, pending, target.tool.id, resultText, isError, ts);
      } else {
        const pending = /* @__PURE__ */ new Map();
        const ev = addToolCall(session, pending, ts, {
          id: tf.toolCallId ?? `cursor-db-${bubbleId}`,
          name: tf.name,
          args: args2
        });
        attachResult(session, pending, ev.tool.id, resultText, isError, ts);
      }
    }
  } finally {
    if (owned) {
      try {
        db.close();
      } catch {
      }
    }
  }
}
function parseCursorFile(file, agent, { enrich = true, DatabaseSync = getCursorDatabaseSync(), dbPath = cursorStateDbPath() } = {}) {
  const composerId = path.basename(file, ".jsonl");
  const session = newSession("cursor", file, agent);
  session.id = composerId;
  parseCursorJsonlInto(session, file);
  finalizeLabel(session);
  const sessions = [];
  if (session.events.length) sessions.push(session);
  const subDir = path.join(path.dirname(file), "subagents");
  for (const name of safeReaddir(subDir)) {
    if (!name.endsWith(".jsonl")) continue;
    const childFile = path.join(subDir, name);
    const child = newSession("cursor", childFile, agent);
    child.id = path.basename(name, ".jsonl");
    child.parent = composerId;
    parseCursorJsonlInto(child, childFile);
    if (!child.events.length) continue;
    if (!child.label) child.label = "(sub-agent)";
    finalizeLabel(child);
    session.children.push(child.id);
    sessions.push(child);
    const firstUser = child.events.find((e) => e.kind === "user")?.text ?? "";
    for (const ev of session.events) {
      if (ev.kind !== "tool" || ev.tool.spawnTarget || !SPAWN_TOOL_RE.test(ev.tool.name)) continue;
      const prompt = String(ev.tool.args?.prompt ?? ev.tool.args?.description ?? "");
      if (prompt && firstUser && (prompt.startsWith(firstUser.slice(0, 60)) || firstUser.startsWith(prompt.slice(0, 60)))) {
        ev.tool.spawnTarget = child.id;
        break;
      }
    }
  }
  if (enrich && DatabaseSync && sessions.length) {
    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
    } catch {
      db = null;
    }
    if (db) {
      try {
        for (const s of sessions) enrichCursorSessionFromDb(s, s.id, DatabaseSync, dbPath, db);
      } finally {
        try {
          db.close();
        } catch {
        }
      }
    }
  }
  return sessions;
}
function cursorAdapter() {
  const root = process.env.CURSOR_PROJECTS_DIR ?? path.join(os.homedir(), ".cursor", "projects");
  return {
    source: "cursor",
    findFiles() {
      const found = [];
      for (const proj of safeReaddir(root)) {
        const transcripts = path.join(root, proj, "agent-transcripts");
        for (const sessionDir of safeReaddir(transcripts)) {
          const dir = path.join(transcripts, sessionDir);
          let st;
          try {
            st = fs.statSync(dir);
          } catch {
            continue;
          }
          if (!st.isDirectory()) continue;
          const main2 = path.join(dir, `${sessionDir}.jsonl`);
          try {
            if (fs.statSync(main2).isFile()) found.push({ file: main2, agent: proj });
          } catch {
          }
        }
      }
      return found;
    },
    parseFile: ({ file, agent }) => parseCursorFile(file, agent)
  };
}
function makeAdapters({ explicitDir = null, sources = null } = {}) {
  const all = explicitDir ? [openclawAdapter(explicitDir)] : [openclawAdapter(null), claudeCodeAdapter(), codexAdapter(), hermesAdapter(), cursorAdapter()];
  return sources ? all.filter((a) => sources.includes(a.source)) : all;
}

// lib/scan.mjs
function shortPath(p) {
  const home = os.homedir();
  return home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
}
function scanSessions({ explicitDir = null, sources = null, cache = /* @__PURE__ */ new Map() } = {}) {
  const adapters = makeAdapters({ explicitDir, sources });
  const sessions = [];
  const roots = /* @__PURE__ */ new Set();
  const liveFiles = /* @__PURE__ */ new Set();
  for (const adapter of adapters) {
    for (const desc of adapter.findFiles()) {
      let st;
      try {
        st = fs2.statSync(desc.file);
      } catch {
        continue;
      }
      liveFiles.add(desc.file);
      let entry = cache.get(desc.file);
      if (!entry || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
        let parsed;
        try {
          parsed = adapter.parseFile(desc);
        } catch {
          parsed = [];
        }
        entry = { mtimeMs: st.mtimeMs, size: st.size, sessions: parsed };
        cache.set(desc.file, entry);
      }
      for (const s of entry.sessions) {
        sessions.push(s);
        roots.add(`${adapter.source}: ${shortPath(path2.dirname(desc.file))}`);
      }
    }
  }
  for (const f of cache.keys()) if (!liveFiles.has(f)) cache.delete(f);
  const byId = new Map(sessions.map((s) => [s.id.toLowerCase(), s]));
  for (const s of sessions) {
    for (const { uuid, ev } of s.spawnCandidates) {
      const child = byId.get(uuid);
      if (child && child !== s && !child.parent) {
        child.parent = s.id;
        if (!s.children.includes(child.id)) s.children.push(child.id);
        ev.tool.spawnTarget ??= child.id;
      }
    }
  }
  return { roots: [...roots].sort(), sessions, byId };
}

// lib/team/sanitize.mjs
import crypto from "node:crypto";
import path3 from "node:path";

// lib/analytics.mjs
var EDIT_TOOLS = /* @__PURE__ */ new Set([
  "edit",
  "write",
  "notebookedit",
  "multiedit",
  "str_replace_editor",
  "strreplace",
  "apply_patch"
]);
var CORRECTION_RE = /(?:^|\b)(?:no[,—:]?|nope|wrong|incorrect|not what i|that(?:'s| is) not|you (?:missed|ignored|changed)|actually[,—:]?|instead[,—:]?|stop[,—:]?|undo|revert|go back|don(?:'t| not)|i said|please fix that)(?:\b|$)/i;
var lineCount = (value) => {
  if (typeof value !== "string" || value.length === 0) return 0;
  const normalized = value.replace(/\r\n/g, "\n");
  const count = normalized.split("\n").length;
  return normalized.endsWith("\n") ? count - 1 : count;
};
function cleanFilePath(value) {
  if (typeof value !== "string") return null;
  let out = value.trim().replace(/^['"]|['"]$/g, "").replaceAll("\\", "/");
  out = out.replace(/^[ab]\//, "");
  return out && out !== "/dev/null" ? out : null;
}
function patchTextFrom(args2) {
  if (typeof args2 === "string") return args2;
  if (!args2 || typeof args2 !== "object") return "";
  for (const key of ["patch", "input", "cmd", "command"]) {
    if (typeof args2[key] === "string" && (args2[key].includes("*** Begin Patch") || args2[key].includes("diff --git "))) {
      let text = args2[key];
      if (!/^\*\*\* (?:Add|Update|Delete) File:/m.test(text)) text = decodeWrappedPatch(text);
      return text;
    }
  }
  return "";
}
function decodeWrappedPatch(source) {
  const marker = source.indexOf("*** Begin Patch");
  if (marker <= 0) return source;
  const quote = source[marker - 1];
  if (!['"', "'", "`"].includes(quote)) return source;
  let end = marker;
  while (end < source.length) {
    end = source.indexOf(quote, end + 1);
    if (end < 0) return source;
    let slashes = 0;
    for (let i = end - 1; i >= 0 && source[i] === "\\"; i--) slashes++;
    if (slashes % 2 === 0) break;
  }
  const encoded = source.slice(marker, end);
  if (quote === '"') {
    try {
      return JSON.parse(`"${encoded}"`);
    } catch {
    }
  }
  let out = "";
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] !== "\\" || i === encoded.length - 1) {
      out += encoded[i];
      continue;
    }
    const next = encoded[++i];
    out += next === "n" ? "\n" : next === "r" ? "\r" : next === "t" ? "	" : next;
  }
  return out;
}
function parsePatch(patch) {
  if (typeof patch !== "string" || !patch) return [];
  const records = /* @__PURE__ */ new Map();
  let current = null;
  const get = (p) => {
    p = cleanFilePath(p);
    if (!p) return null;
    if (!records.has(p)) records.set(p, { path: p, additions: 0, deletions: 0 });
    return records.get(p);
  };
  for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
    let m = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line);
    if (m) {
      current = get(m[1]);
      continue;
    }
    m = /^\*\*\* Move to: (.+)$/.exec(line);
    if (m) {
      current = get(m[1]);
      continue;
    }
    m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) {
      current = get(m[2]);
      continue;
    }
    m = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (m && m[1] !== "/dev/null") {
      current = get(m[1]);
      continue;
    }
    if (!current || /^\+\+\+|^---/.test(line)) continue;
    if (line.startsWith("+")) current.additions++;
    else if (line.startsWith("-")) current.deletions++;
  }
  return [...records.values()];
}
function stringEdit(pathValue, oldValue, newValue) {
  const p = cleanFilePath(pathValue);
  if (!p) return [];
  return [{ path: p, additions: lineCount(newValue), deletions: lineCount(oldValue) }];
}
function extractEditOperations(ev) {
  if (ev?.kind !== "tool") return [];
  const name = String(ev.tool?.name ?? "").toLowerCase();
  const args2 = ev.tool?.args ?? {};
  const patch = patchTextFrom(args2);
  if (patch) return parsePatch(patch);
  if (!EDIT_TOOLS.has(name)) return [];
  const p = args2.file_path ?? args2.path ?? args2.notebook_path ?? args2.file;
  if (name === "multiedit" || Array.isArray(args2.edits)) {
    return (args2.edits ?? []).flatMap((edit) => stringEdit(p, edit.old_string ?? edit.old_str ?? "", edit.new_string ?? edit.new_str ?? ""));
  }
  if (name === "write") return stringEdit(p, "", args2.content ?? args2.file_text ?? args2.text ?? "");
  if (name === "notebookedit") return stringEdit(p, args2.old_source ?? "", args2.new_source ?? args2.new_source ?? args2.source ?? "");
  if (name === "str_replace_editor") {
    const command = String(args2.command ?? "").toLowerCase();
    if (command === "create") return stringEdit(p, "", args2.file_text ?? args2.new_str ?? "");
    if (command === "insert") return stringEdit(p, "", args2.new_str ?? args2.text ?? "");
    return stringEdit(p, args2.old_str ?? args2.old_string ?? "", args2.new_str ?? args2.new_string ?? "");
  }
  return stringEdit(p, args2.old_string ?? args2.old_str ?? "", args2.new_string ?? args2.new_str ?? args2.content ?? "");
}
function rateFor(model, source, pricing) {
  if (!pricing?.models?.length) return null;
  const value = normalizeModelName(model, source);
  if (!value) return null;
  for (const rate of pricing.models) {
    if (rate.source && rate.source !== source) continue;
    try {
      if (new RegExp(rate.pattern, "i").test(value)) return rate;
    } catch {
    }
  }
  return null;
}
function normalizeModelName(model, source) {
  let value = String(model ?? "").trim();
  if (!value || /^default$/i.test(value)) return "";
  value = value.replace(/^cursor-/i, "").toLowerCase();
  const aliases = {
    "composer-2-fast": "composer-2.5-fast",
    "composer-2.5-fast": "composer-2.5-fast",
    "composer-2": "composer-2.5-fast",
    "composer-2.5": "composer-2.5-fast",
    "composer-1": "composer-1",
    "grok-4.5-fast": "grok-4.5-fast",
    "grok-4.5-high-fast": "grok-4.5-fast",
    "cursor-grok-4.5-high-fast": "grok-4.5-fast",
    "grok-4.5": "grok-4.5",
    "glm-5.2-high": "glm-5.2",
    "glm-5.2": "glm-5.2",
    "claude-4.6-sonnet-medium-thinking": "claude-sonnet-4-6",
    "claude-sonnet-5-thinking-high": "claude-sonnet-5",
    "gpt-5.4-mini": "gpt-5.4-mini"
  };
  return aliases[value] ?? value;
}
function priceSession(session, pricing) {
  const rate = rateFor(session.model, session.source, pricing);
  if (!rate) return { total: null, rate: null, freshInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const usage = session.stats ?? {};
  const cacheRead = Math.max(0, usage.tokensCacheRead || 0);
  const cacheWrite = Math.max(0, usage.tokensCacheWrite || 0);
  const freshInput = Math.max(0, (usage.tokensIn || 0) - cacheRead - cacheWrite);
  const output = Math.max(0, usage.tokensOut || 0);
  const total = (freshInput * (rate.input || 0) + cacheRead * (rate.cacheRead ?? rate.input ?? 0) + cacheWrite * (rate.cacheWrite ?? rate.input ?? 0) + output * (rate.output || 0)) / 1e6;
  return {
    total,
    rate: { id: rate.id, label: rate.label, input: rate.input, output: rate.output, cacheRead: rate.cacheRead, cacheWrite: rate.cacheWrite },
    freshInput,
    cacheRead,
    cacheWrite,
    output
  };
}
var median = (values) => {
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
};
function sessionIntelligence(session, pricing) {
  const files = /* @__PURE__ */ new Map();
  const edits = [];
  const toolLatencies = [];
  const users = session.events.filter((e) => e.kind === "user");
  let toolCalls = 0;
  let toolErrors = 0;
  let firstEditAt = null;
  for (const ev of session.events) {
    if (ev.kind !== "tool") continue;
    toolCalls++;
    if (ev.tool.isError) toolErrors++;
    if (ev.ts && ev.tool.resultTs) {
      const ms = Date.parse(ev.tool.resultTs) - Date.parse(ev.ts);
      if (ms >= 0 && ms < 864e5) toolLatencies.push(ms);
    }
    const ops = extractEditOperations(ev);
    if (!ops.length) continue;
    firstEditAt ??= ev.ts;
    for (const op of ops) {
      edits.push({ ...op, ts: ev.ts });
      const rec = files.get(op.path) ?? { path: op.path, additions: 0, deletions: 0, edits: 0 };
      rec.additions += op.additions;
      rec.deletions += op.deletions;
      rec.edits++;
      files.set(op.path, rec);
    }
  }
  const corrections = users.slice(1).filter((e) => CORRECTION_RE.test(e.text ?? "")).length;
  const firstUserAt = users.find((e) => e.ts)?.ts ?? null;
  let timeToFirstEditMs = null;
  if (firstUserAt && firstEditAt) {
    const ms = Date.parse(firstEditAt) - Date.parse(firstUserAt);
    if (ms >= 0 && ms < 864e5) timeToFirstEditMs = ms;
  }
  const last = [...session.events].reverse().find((e) => e.kind === "user" || e.kind === "assistant" || e.kind === "tool");
  const isLive = session.endedAt && Date.now() - Date.parse(session.endedAt) < 5 * 6e4;
  const abandoned = Boolean(users.length && last?.kind !== "assistant" && !isLive);
  const reworkLoops = [...files.values()].reduce((n, f) => n + Math.max(0, f.edits - 1), 0);
  const cost = priceSession(session, pricing);
  return {
    edits,
    files: [...files.values()],
    editOperations: edits.length,
    changedLines: edits.reduce((n, e) => n + e.additions + e.deletions, 0),
    additions: edits.reduce((n, e) => n + e.additions, 0),
    deletions: edits.reduce((n, e) => n + e.deletions, 0),
    reworkLoops,
    corrections,
    abandoned,
    timeToFirstEditMs,
    toolCalls,
    toolErrors,
    toolLatencies,
    medianToolLatencyMs: median(toolLatencies),
    cost
  };
}
function sessionSummary(session, pricing, includeEvents = false) {
  const intel = sessionIntelligence(session, pricing);
  return {
    id: session.id,
    source: session.source,
    agent: session.agent,
    label: session.label,
    model: session.model,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    parent: session.parent,
    children: session.children,
    stats: session.stats,
    eventCount: session.events.length,
    intelligence: {
      apiCost: intel.cost.total,
      rate: intel.cost.rate,
      edits: intel.editOperations,
      additions: intel.additions,
      deletions: intel.deletions,
      changedLines: intel.changedLines,
      files: intel.files,
      reworkLoops: intel.reworkLoops,
      corrections: intel.corrections,
      abandoned: intel.abandoned,
      timeToFirstEditMs: intel.timeToFirstEditMs,
      medianToolLatencyMs: intel.medianToolLatencyMs
    },
    ...includeEvents ? { events: session.events } : {}
  };
}

// lib/team/sanitize.mjs
var FORBIDDEN_KEYS = /* @__PURE__ */ new Set([
  "content",
  "prompt",
  "result",
  "args",
  "message",
  "thinking"
]);
function sanitizePath(filePath) {
  if (typeof filePath !== "string" || !filePath) return "";
  let p = filePath.replaceAll("\\", "/");
  const home = os.homedir().replaceAll("\\", "/");
  if (home && p.startsWith(home)) p = p.slice(home.length);
  // Strip macOS /Users/<name> or Windows /C/Users/<name> patterns that may remain
  p = p.replace(/^\/Users\/[^/]+/, "").replace(/^\/[A-Za-z]\/Users\/[^/]+/, "");
  return p.startsWith("/") ? p.slice(1) : p;
}
function stablePayloadHash(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
function assertNoPromptFields(obj, trail = "") {
  if (obj == null || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) assertNoPromptFields(obj[i], `${trail}[${i}]`);
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (FORBIDDEN_KEYS.has(k.toLowerCase())) {
      throw new Error(`forbidden sync field: ${trail}.${k}`);
    }
    if (v && typeof v === "object") assertNoPromptFields(v, `${trail}.${k}`);
  }
}
function sanitizeForTeamSync(session, pricing) {
  const summary = sessionSummary(session, pricing);
  const intel = summary.intelligence;
  const tools = Object.entries(session.stats?.toolCounts ?? {}).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  const files = (intel.files ?? []).map((f) => ({
    path: sanitizePath(f.path),
    edits: f.edits ?? 0,
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0
  })).filter((f) => f.path);
  const body = {
    sessionId: session.id,
    source: session.source,
    agent: session.agent || path3.basename(String(session.agent || "unknown")),
    model: session.model,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    tokensIn: session.stats?.tokensIn ?? 0,
    tokensOut: session.stats?.tokensOut ?? 0,
    tokensCacheRead: session.stats?.tokensCacheRead ?? 0,
    tokensCacheWrite: session.stats?.tokensCacheWrite ?? 0,
    apiCost: intel.apiCost,
    priced: intel.apiCost != null,
    edits: intel.edits ?? 0,
    additions: intel.additions ?? 0,
    deletions: intel.deletions ?? 0,
    changedLines: intel.changedLines ?? 0,
    filesTouched: files.length,
    toolCalls: tools.reduce((n, t) => n + t.count, 0),
    toolErrors: session.stats?.errors ?? 0,
    reworkLoops: intel.reworkLoops ?? 0,
    corrections: intel.corrections ?? 0,
    abandoned: intel.abandoned ?? false,
    tools,
    files,
    events: (session.events ?? [])
      .filter((e) => e.kind === "user" || e.kind === "assistant")
      .map((e) => ({
        kind: e.kind,
        ts: e.ts ?? null,
        text: e.text ?? null,
        usage: e.usage ? {
          tokensIn: e.usage.tokensIn,
          tokensOut: e.usage.tokensOut,
          cacheRead: e.usage.cacheRead
        } : null
      }))
  };
  assertNoPromptFields(body);
  body.payloadHash = stablePayloadHash(body);
  return body;
}

// ── Daemon version (single source of truth) ──────────────────────────────
// Bump this string when you publish a new release to /api/internal/releases.
var DAEMON_VERSION = "1.2.0";

// Canonical backend URL — self-heals any machine whose config.json still
// points somewhere stale (e.g. a decommissioned deployment).
var CANONICAL_API_URL = "https://token-tracer-three.vercel.app";

// Sync interval is centrally controlled as of v1.2.0 — no longer read from
// config.json, so it can't drift per machine (now 2 hours / 120 mins).
var SYNC_INTERVAL_MIN = 120;

// bin/sync-daemon.mjs
var __dirname = path4.dirname(fileURLToPath(import.meta.url));
var ROOT = path4.join(__dirname, "..");
var DEFAULT_CONFIG = path4.join(os.homedir(), ".token-tracer", "config.json");
var DEFAULT_STATE = path4.join(os.homedir(), ".token-tracer", "sync-state.json");
var DEFAULT_LOG = path4.join(os.homedir(), ".token-tracer", "sync.log");
var DEFAULT_UPDATE_LOG = path4.join(os.homedir(), ".token-tracer", "update.log");
var BATCH_SIZE = 100;
var MAX_LOG_BYTES = 256 * 1024;
var UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
var args = process.argv.slice(2);
var once = args.includes("--once");
var arg = (name) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};
function loadJson(file, fallback) {
  try {
    return JSON.parse(fs3.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function appendLog(logPath, line) {
  const dir = path4.dirname(logPath);
  fs3.mkdirSync(dir, { recursive: true, mode: 448 });
  try {
    if (fs3.existsSync(logPath) && fs3.statSync(logPath).size > MAX_LOG_BYTES) {
      const prev = fs3.readFileSync(logPath, "utf8");
      fs3.writeFileSync(logPath, prev.slice(-MAX_LOG_BYTES / 2), { mode: 384 });
    }
  } catch {
  }
  fs3.appendFileSync(logPath, `${(/* @__PURE__ */ new Date()).toISOString()} ${line}
`, { mode: 384 });
}
function isLowBattery() {
  if (process.platform !== "darwin") return false;
  try {
    const out = execSync("pmset -g batt", { encoding: "utf8", timeout: 3e3 });
    const pct = Number(out.match(/(\d+)%/)?.[1] ?? 100);
    const unplugged = /Battery Power|discharging/i.test(out);
    return unplugged && pct < 20;
  } catch {
    return false;
  }
}
function loadPricing() {
  const pricingFile = path4.join(ROOT, "lib", "pricing.json");
  try {
    return JSON.parse(fs3.readFileSync(pricingFile, "utf8"));
  } catch {
    return null;
  }
}
function sessionKey(s) {
  return `${s.source}:${s.id}`;
}
async function postBatch(apiUrl, apiKey, sessions) {
  const url = `${apiUrl.replace(/\/$/, "")}/api/v1/ingest`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-Daemon-Version": DAEMON_VERSION,
    },
    body: JSON.stringify({ sessions })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// ── Self-update logic ─────────────────────────────────────────────────────
// crypto is already imported above (from the bundled lib/team/auth.ts path).
// spawn is imported at the top of this file alongside execSync.

/**
 * Check the backend for a newer daemon version.
 * Downloads, verifies SHA-256, atomically replaces the running daemon,
 * then re-execs the new version as a detached child and exits.
 *
 * Returns true if a self-replace-and-restart happened (caller should not
 * continue after this returns true — process.exit(0) is called internally).
 * Returns false if no update is needed or the update failed non-fatally.
 * Throws if update is mandatory and failed (caller should skip sync).
 *
 * @param {object} config   - loaded config.json { apiUrl, apiKey }
 * @param {string} updateLogPath - path to update.log
 */
async function checkForUpdate(config, updateLogPath) {
  const url = `${config.apiUrl.replace(/\/$/, "")}/api/v1/update-check`;
  let data;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "X-Daemon-Version": DAEMON_VERSION,
      },
      signal: AbortSignal.timeout(15000),
    });
    data = await res.json().catch(() => ({}));
    if (!res.ok) {
      appendLog(updateLogPath, `update-check warn: HTTP ${res.status} — ${data?.error || "unknown"}`);
      return false;
    }
  } catch (err) {
    // Network failure — non-fatal, continue with current version
    appendLog(updateLogPath, `update-check warn: ${err.message}`);
    return false;
  }

  if (!data.updateAvailable) {
    appendLog(updateLogPath, `update: up-to-date v${DAEMON_VERSION}`);
    return false;
  }

  appendLog(updateLogPath, `update: new version v${data.latest} available (mandatory=${data.mandatory}), downloading…`);

  // Determine paths for atomic swap
  const currentPath = fileURLToPath(import.meta.url);
  const tempPath = currentPath + ".tmp";

  try {
    // 1. Download to temp file
    const dlRes = await fetch(data.url, { signal: AbortSignal.timeout(60000) });
    if (!dlRes.ok) throw new Error(`download HTTP ${dlRes.status}`);
    const buffer = Buffer.from(await dlRes.arrayBuffer());

    // 2. Verify SHA-256 checksum
    const actualHash = crypto.createHash("sha256").update(buffer).digest("hex");
    if (actualHash.toLowerCase() !== data.sha256.toLowerCase()) {
      throw new Error(
        `checksum mismatch: expected ${data.sha256}, got ${actualHash}`
      );
    }

    // 3. Write to temp file (mode 0o755 so new file is executable)
    fs3.writeFileSync(tempPath, buffer, { mode: 0o755 });

    // 4. Atomic replace
    //    On POSIX (macOS/Linux): fs.renameSync is atomic.
    //    On Windows: rename across processes can fail if the file is locked;
    //    fall back to copy+delete.
    try {
      fs3.renameSync(tempPath, currentPath);
    } catch {
      // Windows fallback: copy then delete temp
      fs3.copyFileSync(tempPath, currentPath);
      try { fs3.unlinkSync(tempPath); } catch { /* ignore */ }
    }

    appendLog(updateLogPath, `update: v${data.latest} installed, restarting…`);

    // 5. Re-exec: spawn the new daemon as a detached child with same args,
    //    then exit this process so the OS service manager restarts us cleanly.
    //    The service manager (launchd / systemd / Task Scheduler) will keep the
    //    service alive; we just need to hand off.
    const child = spawn(process.execPath, [currentPath, ...process.argv.slice(2)], {
      detached: true,
      stdio: "inherit",
      env: process.env,
    });
    child.unref();
    process.exit(0);
    return true; // never reached, but satisfies linters
  } catch (err) {
    // Clean up temp file if it exists
    try { fs3.unlinkSync(tempPath); } catch { /* ignore */ }

    appendLog(updateLogPath, `update error: ${err.message}`);
    if (data.mandatory) {
      throw new Error(`mandatory update to v${data.latest} failed: ${err.message}`);
    }
    // Non-mandatory failure: log and continue running current version
    return false;
  }
}

async function runSync(configPath, statePath, logPath) {
  const config = loadJson(configPath, null);
  if (!config?.apiUrl || !config?.apiKey) {
    throw new Error(`missing apiUrl/apiKey in ${configPath}`);
  }
  if (isLowBattery()) {
    appendLog(logPath, "skip: low battery");
    return;
  }
  const pricing = loadPricing();
  const cache = /* @__PURE__ */ new Map();
  const { sessions } = scanSessions({ cache });
  const state = loadJson(statePath, { synced: {} });
  const pending = [];
  for (const session of sessions) {
    const key = sessionKey(session);
    const payload = sanitizeForTeamSync(session, pricing);
    const prev = state.synced[key];
    if (prev === payload.payloadHash) continue;
    pending.push(payload);
  }
  if (!pending.length) {
    appendLog(logPath, "ok: nothing new");
    return;
  }
  let accepted = 0;
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    const result = await postBatch(config.apiUrl, config.apiKey, batch);
    accepted += result.accepted ?? 0;
    for (const p of batch) {
      state.synced[`${p.source}:${p.sessionId}`] = p.payloadHash;
    }
  }
  fs3.mkdirSync(path4.dirname(statePath), { recursive: true, mode: 448 });
  fs3.writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 384 });
  appendLog(logPath, `ok: sent ${pending.length} updated, accepted ${accepted}`);
}
async function main() {
  const configPath = arg("--config") || process.env.DEVMETRICS_CONFIG || DEFAULT_CONFIG;
  const statePath = arg("--state") || process.env.DEVMETRICS_STATE || DEFAULT_STATE;
  const logPath = arg("--log") || process.env.DEVMETRICS_LOG || DEFAULT_LOG;
  const updateLogPath = arg("--update-log") || process.env.DEVMETRICS_UPDATE_LOG || DEFAULT_UPDATE_LOG;
  const intervalMin = Number(arg("--interval-min")) || SYNC_INTERVAL_MIN;

  // Attempt an update check before the very first sync.
  // checkForUpdate() re-execs and exits if an update is applied, so if we
  // reach the line after this call, either no update was needed or the update
  // was non-mandatory and failed (both safe to continue).
  const config = loadJson(configPath, null);
  if (config && config.apiUrl !== CANONICAL_API_URL) {
    appendLog(updateLogPath, `config: correcting stale apiUrl (${config.apiUrl} -> ${CANONICAL_API_URL})`);
    config.apiUrl = CANONICAL_API_URL;
    fs3.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 384 });
  }
  if (config?.apiUrl && config?.apiKey) {
    try {
      await checkForUpdate(config, updateLogPath);
    } catch (err) {
      // Mandatory update failure — log and skip first sync; do NOT crash the daemon
      appendLog(updateLogPath, `update mandatory-fail: ${err.message}`);
      appendLog(logPath, `skip: mandatory update required but failed (see update.log)`);
      if (!once) {
        // Keep the update-check interval alive; skip sync until updated
        setInterval(async () => {
          const cfg = loadJson(configPath, null);
          if (!cfg?.apiUrl || !cfg?.apiKey) return;
          try { await checkForUpdate(cfg, updateLogPath); } catch { /* retry next interval */ }
        }, UPDATE_CHECK_INTERVAL_MS);
      }
      return;
    }
  }

  const tick = async () => {
    try {
      await runSync(configPath, statePath, logPath);
    } catch (err) {
      appendLog(logPath, `error: ${err.message}`);
    }
  };

  await tick();
  if (once) return;

  // Sync interval (centrally fixed at 2 hours / 120 minutes with ±15m randomized jitter)
  const scheduleNextTick = () => {
    const baseMs = Math.max(1, intervalMin) * 60_000;
    const jitterMs = (Math.random() * 30 - 15) * 60_000; // ±15 minutes
    const delay = Math.max(60_000, baseMs + jitterMs);
    setTimeout(async () => {
      await tick();
      scheduleNextTick();
    }, delay);
  };
  scheduleNextTick();

  // Independent 24-hour update-check interval
  setInterval(async () => {
    const cfg = loadJson(configPath, null);
    if (!cfg?.apiUrl || !cfg?.apiKey) return;
    try {
      await checkForUpdate(cfg, updateLogPath);
    } catch (err) {
      // Mandatory update failed during long-running session: log, don't crash
      appendLog(updateLogPath, `update mandatory-fail (runtime): ${err.message}`);
      appendLog(logPath, `warn: mandatory update required but failed \u2014 see update.log`);
    }
  }, UPDATE_CHECK_INTERVAL_MS);
}
main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

