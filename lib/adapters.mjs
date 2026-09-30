/**
 * Source adapters — each discovers session transcript files for one agent CLI
 * and parses them into the shared normalized trajectory model:
 *
 *   session: { id, source, agent, file, label, model, startedAt, endedAt,
 *              events[], stats, spawnCandidates[], children[], parent }
 *   event:   { kind: user|assistant|thinking|tool|meta, ts, text?, tool? }
 *   tool:    { id, name, args, result, isError, resultTs, spawnTarget? }
 *
 * All adapters are read-only and tolerant: unparseable lines are skipped.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const SPAWN_TOOL_RE = /spawn|subagent|sub_agent|^task$|^agent$/i;

// ── shared helpers ───────────────────────────────────────────────────────────
export function newSession(source, file, agent) {
  return {
    id: path.basename(file, '.jsonl'),
    source,
    agent,
    file,
    label: '',
    model: null,
    startedAt: null,
    endedAt: null,
    events: [],
    stats: { toolCounts: {}, tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0, messages: 0, errors: 0 },
    spawnCandidates: [],
    children: [],
    parent: null,
  };
}

function blocksOf(content) {
  if (content == null) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content;
  return [content];
}

function textOf(content) {
  return blocksOf(content)
    .map((b) => (typeof b === 'string' ? b : b.text ?? b.thinking ?? ''))
    .filter(Boolean)
    .join('\n');
}

function sumUsage(stats, usage) {
  if (!usage || typeof usage !== 'object') return;
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

  // BUG-1 fix: rawIn from most LLM APIs already includes cache tokens in the
  // total input_tokens count. Do NOT add cacheRead/cacheWrite again — that was
  // inflating tokensIn for every session across all adapter sources.
  stats.tokensIn += rawIn;
  stats.tokensOut += rawOut;
  stats.tokensCacheRead += cacheRead;
  stats.tokensCacheWrite += cacheWrite;
}

function estimateTokensIfMissing(session) {
  if ((session.stats.tokensIn || 0) + (session.stats.tokensOut || 0) > 0) return;
  let inChars = 0;
  let outChars = 0;
  for (const ev of session.events) {
    const len = typeof ev.text === 'string' ? ev.text.length : 0;
    if (ev.kind === 'user') {
      inChars += len || 40;
    } else if (ev.kind === 'assistant' || ev.kind === 'thinking') {
      outChars += len || 40;
    } else if (ev.kind === 'tool') {
      const argsLen = JSON.stringify(ev.tool?.args ?? {}).length;
      outChars += argsLen || 30;
    }
  }
  if (inChars > 0 || outChars > 0) {
    session.stats.tokensIn = Math.ceil(inChars / 4);
    session.stats.tokensOut = Math.ceil(outChars / 4);
  }
}

function jsonLines(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

function addToolCall(session, pending, ts, { id, name, args }) {
  const ev = { kind: 'tool', ts, tool: { id: id ?? null, name, args: args ?? {}, result: null, isError: false, resultTs: null } };
  session.stats.toolCounts[name] = (session.stats.toolCounts[name] || 0) + 1;
  session.events.push(ev);
  if (id) pending.set(id, ev);
  if (SPAWN_TOOL_RE.test(name)) {
    for (const u of JSON.stringify(args ?? {}).match(UUID_RE) ?? []) session.spawnCandidates.push({ uuid: u.toLowerCase(), ev });
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
      for (const u of (text ?? '').match(UUID_RE) ?? []) session.spawnCandidates.push({ uuid: u.toLowerCase(), ev });
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
    const first = session.events.find((e) => e.kind === 'user' || e.kind === 'assistant');
    // BUG-15 fix: first.text can be undefined (e.g. assistant events with only tool_use blocks)
    session.label = first?.text?.slice(0, 100) || '(empty session)';
  }
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function* walkJsonl(dir, depth = 4) {
  for (const name of safeReaddir(dir)) {
    const p = path.join(dir, name);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory() && depth > 0) yield* walkJsonl(p, depth - 1);
    else if (st.isFile() && name.endsWith('.jsonl')) yield p;
  }
}

// ── OpenClaw (also the generic/tolerant parser reused by hermes) ─────────────
function parseGenericMessage(session, pending, obj) {
  const m = obj.message ?? (obj.role ? obj : null);
  if (!m) {
    if (obj.type && obj.type !== 'session') session.events.push({ kind: 'meta', ts: obj.timestamp ?? null, text: obj.type });
    return;
  }
  const ts = obj.timestamp ?? m.timestamp ?? null;
  touch(session, ts);
  const role = m.role;

  if (role === 'assistant') {
    session.stats.messages++;
    if (m.model) session.model = m.model;
    sumUsage(session.stats, m.usage);

    // Extract turn-level token usage
    const turnUsage = m.usage ? {
      tokensIn: Number(m.usage.input ?? m.usage.input_tokens ?? m.usage.inputTokens ?? m.usage.prompt_tokens ?? m.usage.promptTokens ?? m.usage.tokensIn ?? m.usage.tokens_in ?? 0),
      tokensOut: Number(m.usage.output ?? m.usage.output_tokens ?? m.usage.outputTokens ?? m.usage.completion_tokens ?? m.usage.completionTokens ?? m.usage.tokensOut ?? m.usage.tokens_out ?? 0),
      cacheRead: Number(m.usage.cacheRead ?? m.usage.cache_read_input_tokens ?? m.usage.cacheReadTokens ?? m.usage.cache_read_tokens ?? m.usage.prompt_tokens_details?.cached_tokens ?? 0)
    } : null;

    for (const b of blocksOf(m.content)) {
      const t = b.type ?? 'text';
      if (t === 'thinking' || t === 'redacted_thinking') session.events.push({ kind: 'thinking', ts, text: b.thinking ?? b.text ?? '' });
      else if (t === 'text') { if (b.text) session.events.push({ kind: 'assistant', ts, text: b.text, usage: turnUsage }); }
      else if (t === 'toolCall' || t === 'tool_use' || t === 'toolUse')
        addToolCall(session, pending, ts, { id: b.id ?? b.toolCallId, name: b.name ?? b.toolName ?? 'tool', args: b.arguments ?? b.input });
    }
  } else if (role === 'toolResult' || role === 'tool') {
    attachResult(session, pending, m.toolCallId ?? m.tool_call_id ?? m.id, textOf(m.content ?? m.output ?? m.result ?? ''), m.isError ?? m.is_error, ts);
  } else if (role === 'user') {
    const blocks = blocksOf(m.content);
    const results = blocks.filter((b) => b.type === 'tool_result' || b.type === 'toolResult');
    if (results.length) {
      for (const b of results) attachResult(session, pending, b.tool_use_id ?? b.toolCallId, textOf(b.content ?? ''), b.is_error ?? b.isError, ts);
    }
    const text = blocks.filter((b) => (b.type ?? 'text') === 'text').map((b) => b.text ?? '').filter(Boolean).join('\n');
    if (text && !text.startsWith('<')) {
      session.stats.messages++;
      session.events.push({ kind: 'user', ts, text });
      if (!session.label) session.label = text.slice(0, 100);
    }
  }
}

function parseOpenclawFile(source, file, agent) {
  const session = newSession(source, file, agent);
  const pending = new Map();
  for (const obj of jsonLines(file)) {
    if (obj.type === 'session') {
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
  const roots = explicitDir
    ? [path.resolve(explicitDir)]
    : [path.join(os.homedir(), '.openclaw'), path.join(os.homedir(), '.clawdbot'), path.join(os.homedir(), '.moltbot')];
  return {
    source: 'openclaw',
    findFiles() {
      const found = [];
      for (const root of roots) {
        const agentsDir = path.join(root, 'agents');
        for (const agent of safeReaddir(agentsDir)) {
          for (const f of safeReaddir(path.join(agentsDir, agent, 'sessions'))) {
            if (f.endsWith('.jsonl')) found.push({ file: path.join(agentsDir, agent, 'sessions', f), agent });
          }
        }
        for (const f of safeReaddir(path.join(root, 'sessions'))) {
          if (f.endsWith('.jsonl')) found.push({ file: path.join(root, 'sessions', f), agent: 'default' });
        }
      }
      return found;
    },
    parseFile: ({ file, agent }) => parseOpenclawFile('openclaw', file, agent),
  };
}

// ── Claude Code (~/.claude/projects/<munged-cwd>/<sessionId>.jsonl) ──────────
const CC_SKIP_TYPES = new Set([
  'attachment', 'file-history-snapshot', 'file-history-delta', 'last-prompt',
  'mode', 'permission-mode', 'progress', 'queued-prompt',
]);

function ccParseMessageInto(session, pending, obj) {
  const ts = obj.timestamp ?? null;
  touch(session, ts);
  if (obj.type === 'system') {
    if (!obj.isMeta) session.events.push({ kind: 'meta', ts, text: obj.subtype ?? 'system' });
    return;
  }
  if (obj.isMeta) return;
  parseGenericMessage(session, pending, obj);
}

function parseClaudeCodeFile(file, projectDir) {
  const lines = jsonLines(file);
  const main = newSession('claude-code', file, projectDir);
  const pendingMain = new Map();
  let title = null;
  const sidechainLines = [];

  for (const obj of lines) {
    if (obj.cwd && main.agent === projectDir) main.agent = path.basename(obj.cwd);
    if (obj.type === 'ai-title' && obj.aiTitle) { title = obj.aiTitle; continue; }
    if (obj.type === 'summary' && obj.summary) { title ??= obj.summary; continue; }
    if (CC_SKIP_TYPES.has(obj.type)) continue;
    if (obj.isSidechain) { sidechainLines.push(obj); continue; }
    if (obj.type === 'user' || obj.type === 'assistant' || obj.type === 'system') ccParseMessageInto(main, pendingMain, obj);
  }
  if (title) main.label = title;
  finalizeLabel(main);

  // Sidechains = Task sub-agent transcripts stored in the same file. Group the
  // sidechain entries into chains by walking parentUuid to each chain's root.
  const byUuid = new Map(sidechainLines.map((o) => [o.uuid, o]));
  const rootOf = (o, seen = new Set()) => {
    while (o.parentUuid && byUuid.has(o.parentUuid) && !seen.has(o.uuid)) { seen.add(o.uuid); o = byUuid.get(o.parentUuid); }
    return o.uuid;
  };
  const chains = new Map();
  for (const o of sidechainLines) {
    const r = rootOf(o);
    if (!chains.has(r)) chains.set(r, []);
    chains.get(r).push(o);
  }
  const sessions = [main];
  let i = 0;
  for (const [, chain] of chains) {
    const child = newSession('claude-code', file, main.agent);
    child.id = `${main.id}-sub${i++}`;
    child.parent = main.id;
    const pending = new Map();
    for (const obj of chain) ccParseMessageInto(child, pending, obj);
    if (!child.events.length) continue;
    if (!child.label) child.label = '(sub-agent)';
    main.children.push(child.id);
    sessions.push(child);
    // link the Task/Agent tool call whose prompt matches this chain's first user text
    const firstUser = child.events.find((e) => e.kind === 'user')?.text ?? '';
    for (const ev of main.events) {
      if (ev.kind !== 'tool' || ev.tool.spawnTarget || !SPAWN_TOOL_RE.test(ev.tool.name)) continue;
      const prompt = ev.tool.args?.prompt ?? '';
      if (prompt && firstUser && (prompt.startsWith(firstUser.slice(0, 60)) || firstUser.startsWith(prompt.slice(0, 60)))) {
        ev.tool.spawnTarget = child.id;
        break;
      }
    }
  }
  return main.events.length ? sessions : [];
}

function claudeCodeAdapter() {
  const root = process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects')
    : path.join(os.homedir(), '.claude', 'projects');
  return {
    source: 'claude-code',
    findFiles() {
      const found = [];
      for (const proj of safeReaddir(root)) {
        const dir = path.join(root, proj);
        for (const f of walkJsonl(dir, 2)) found.push({ file: f, agent: proj });
      }
      return found;
    },
    parseFile: ({ file, agent }) => parseClaudeCodeFile(file, agent),
  };
}

// ── Codex CLI (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) ─────────────────
function parseCodexFile(file) {
  const session = newSession('codex', file, 'codex');
  const m = /rollout-.*?([0-9a-f-]{36})\.jsonl$/i.exec(path.basename(file));
  if (m) session.id = m[1];
  const pending = new Map();

  for (const obj of jsonLines(file)) {
    const ts = obj.timestamp ?? null;
    const p = obj.payload ?? obj; // older codex versions have no payload wrapper
    const type = p.type ?? obj.type;

    if (obj.type === 'session_meta') {
      if (p.id) session.id = p.id;
      if (p.cwd) session.agent = path.basename(p.cwd);
      touch(session, p.timestamp ?? ts);
      continue;
    }
    if (obj.type === 'turn_context') {
      if (p.model) session.model = p.model;
      continue;
    }
    if (obj.type === 'compacted') {
      session.events.push({ kind: 'meta', ts, text: 'context compacted' });
      touch(session, ts);
      continue;
    }
    if (obj.type === 'event_msg') {
      if (type === 'token_count' && p.info?.total_token_usage) {
        const u = p.info.total_token_usage;
        session.stats.tokensIn = u.input_tokens ?? 0;
        session.stats.tokensOut = u.output_tokens ?? 0;
        session.stats.tokensCacheRead = u.cached_input_tokens ?? 0;
      }
      continue; // messages/tool activity are taken from response_item lines
    }
    if (obj.type !== 'response_item' && obj.type !== undefined && !p.role && !type) continue;

    touch(session, ts);
    if (type === 'message') {
      const text = blocksOf(p.content).map((b) => b.text ?? '').filter(Boolean).join('\n');
      if (!text) continue;
      const injected = text.startsWith('<') || /^# AGENTS\.md instructions/.test(text);
      if (p.role === 'user' && !injected) {
        session.stats.messages++;
        session.events.push({ kind: 'user', ts, text });
        if (!session.label) session.label = text.slice(0, 100);
      } else if (p.role === 'assistant') {
        session.stats.messages++;
        session.events.push({ kind: 'assistant', ts, text });
      }
    } else if (type === 'reasoning') {
      const text = (p.summary ?? []).map((b) => b.text ?? '').filter(Boolean).join('\n');
      if (text) session.events.push({ kind: 'thinking', ts, text });
    } else if (type === 'function_call' || type === 'custom_tool_call') {
      let args = p.arguments ?? p.input ?? {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = { input: args }; } }
      addToolCall(session, pending, ts, { id: p.call_id ?? p.id, name: p.name ?? 'tool', args });
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      let out = p.output ?? '';
      if (typeof out === 'string' && out.startsWith('{')) { try { out = JSON.parse(out).output ?? out; } catch { /* keep */ } }
      const isError = /(?:exited with code (?!0\b)\d+|process exited with code (?!0\b)\d+|script (?:failed|error))/i.test(String(out).slice(0, 500));
      attachResult(session, pending, p.call_id ?? p.id, String(out), isError, ts);
    } else if (type === 'web_search_call') {
      addToolCall(session, pending, ts, { id: p.id, name: 'web_search', args: p.action ?? {} });
    }
  }
  finalizeLabel(session);
  return session.events.length ? [session] : [];
}

function codexAdapter() {
  const root = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'sessions');
  return {
    source: 'codex',
    findFiles: () => [...walkJsonl(root, 4)].map((file) => ({ file, agent: 'codex' })),
    parseFile: ({ file }) => parseCodexFile(file),
  };
}

// ── Hermes (best-effort generic: HERMES_STATE_DIR or ~/.hermes) ──────────────
function hermesAdapter() {
  const root = process.env.HERMES_STATE_DIR ?? path.join(os.homedir(), '.hermes');
  return {
    source: 'hermes',
    findFiles: () => [...walkJsonl(root, 4)].map((file) => ({ file, agent: path.basename(path.dirname(file)) })),
    parseFile: ({ file, agent }) => parseOpenclawFile('hermes', file, agent),
  };
}

// ── Cursor (~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl) ─────
const CURSOR_TS_RE = /<timestamp>\s*([^<]+?)\s*<\/timestamp>/i;
const CURSOR_QUERY_RE = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i;

function cursorIsoFromMs(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return null;
}

/** Strip Cursor chat wrappers; prefer <user_query> body for labels. */
export function cursorDisplayText(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  const query = CURSOR_QUERY_RE.exec(raw);
  let text = query ? query[1].trim() : raw;
  text = text.replace(CURSOR_TS_RE, '').replace(/<\/?user_query>/gi, '').trim();
  return text;
}

export function cursorTimestampFromText(raw) {
  if (typeof raw !== 'string') return null;
  const m = CURSOR_TS_RE.exec(raw);
  if (!m) return null;
  const parsed = Date.parse(m[1].trim());
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function parseCursorArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return { value: raw };
  try { return JSON.parse(raw); } catch { return { input: raw }; }
}

function parseCursorJsonlInto(session, file) {
  const pending = new Map();
  let toolSeq = 0;
  for (const obj of jsonLines(file)) {
    if (obj?.type === 'turn_ended') {
      session.events.push({ kind: 'meta', ts: null, text: `turn_ended:${obj.status ?? 'unknown'}` });
      continue;
    }
    const role = obj?.role ?? obj?.message?.role;
    const message = obj?.message ?? obj;
    if (!role) continue;

    if (role === 'user') {
      const raw = textOf(message.content);
      const text = cursorDisplayText(raw);
      const ts = cursorTimestampFromText(raw);
      touch(session, ts);
      if (!text) continue;
      session.stats.messages++;
      session.events.push({ kind: 'user', ts, text });
      if (!session.label) session.label = text.slice(0, 100);
      continue;
    }

    if (role === 'assistant') {
      session.stats.messages++;
      if (message.model) session.model = message.model;
      sumUsage(session.stats, message.usage);
      for (const b of blocksOf(message.content)) {
        const t = b.type ?? 'text';
        if (t === 'thinking' || t === 'redacted_thinking') {
          session.events.push({ kind: 'thinking', ts: null, text: b.thinking ?? b.text ?? '' });
        } else if (t === 'text') {
          if (b.text) session.events.push({ kind: 'assistant', ts: null, text: b.text });
        } else if (t === 'tool_use' || t === 'toolUse' || t === 'toolCall') {
          const id = b.id ?? b.toolCallId ?? `cursor-tool-${toolSeq++}`;
          addToolCall(session, pending, null, {
            id,
            name: b.name ?? b.toolName ?? 'tool',
            args: b.input ?? b.arguments ?? {},
          });
        }
      }
      continue;
    }

    if (role === 'tool' || role === 'toolResult') {
      attachResult(
        session,
        pending,
        message.toolCallId ?? message.tool_call_id ?? message.id,
        textOf(message.content ?? message.output ?? message.result ?? ''),
        message.isError ?? message.is_error,
        null,
      );
    }
  }
  return pending;
}

let _cachedDatabaseSync = undefined; // undefined=unset, null=unavailable, else ctor

function getCursorDatabaseSync() {
  if (_cachedDatabaseSync !== undefined) return _cachedDatabaseSync;
  try {
    _cachedDatabaseSync = require('node:sqlite').DatabaseSync;
  } catch {
    _cachedDatabaseSync = null;
  }
  return _cachedDatabaseSync;
}

function cursorStateDbPath() {
  if (process.env.CURSOR_STATE_DB) return process.env.CURSOR_STATE_DB;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || os.homedir(), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

/**
 * Best-effort read-only enrichment from Cursor's state.vscdb for one composer.
 * Queries only composerData + listed bubble keys (no full-table scan).
 * Pass an open `db` to reuse a connection across sessions.
 */
export function enrichCursorSessionFromDb(session, composerId, DatabaseSync = getCursorDatabaseSync(), dbPath = cursorStateDbPath(), db = null) {
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
    const composerRow = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(`composerData:${composerId}`);
    if (!composerRow?.value) return;
    let composer;
    try { composer = JSON.parse(composerRow.value); } catch { return; }

    const wsUri = composer.workspaceUri || composer.folderUri || composer.workspace?.target || composer.projectPath;
    if (wsUri) {
      try {
        const decoded = decodeURIComponent(String(wsUri).replace(/^file:\/\//, ''));
        const folderName = path.basename(decoded);
        if (folderName && folderName !== '/') session.agent = folderName;
      } catch { /* ignore */ }
    }

    if (composer.name) {
      const weak = !session.label || session.label === '(empty session)' || session.label === '(sub-agent)' || session.label.length < 12;
      if (weak) session.label = String(composer.name).slice(0, 100);
    }
    const modelName = composer.modelConfig?.selectedModels?.[0]?.modelId
      ?? composer.modelConfig?.modelName
      ?? null;
    if (modelName) session.model = modelName;

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
      unifiedMode: composer.unifiedMode ?? null,
    };

    const headers = composer.fullConversationHeadersOnly ?? [];
    const getBubble = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
    const unmatchedTools = session.events.filter((e) => e.kind === 'tool' && (e.tool.result == null || e.tool.result === ''));
    let toolIdx = 0;

    for (const header of headers) {
      const bubbleId = header?.bubbleId;
      if (!bubbleId) continue;
      const row = getBubble.get(`bubbleId:${composerId}:${bubbleId}`);
      if (!row?.value) continue;
      let bubble;
      try { bubble = JSON.parse(row.value); } catch { continue; }

      const ts = cursorIsoFromMs(bubble.createdAt);
      if (ts) touch(session, ts);

      // BUG-3 fix: Only add token counts from DB bubbles if the JSONL transcript
      // didn't already provide usage data. Otherwise we double-count every token.
      const hasJsonlUsage = (session.stats.tokensIn || 0) + (session.stats.tokensOut || 0) > 0;
      if (!hasJsonlUsage) {
        sumUsage(session.stats, {
          input_tokens: bubble.tokenCount?.inputTokens,
          output_tokens: bubble.tokenCount?.outputTokens,
          cache_read_input_tokens: bubble.tokenCount?.cacheReadTokens ?? bubble.tokenCount?.cache_read_input_tokens,
          cache_creation_input_tokens: bubble.tokenCount?.cacheWriteTokens ?? bubble.tokenCount?.cache_creation_input_tokens,
        });
      }
      if (bubble.modelInfo?.modelName && bubble.modelInfo.modelName !== 'default') {
        session.model = bubble.modelInfo.modelName;
      }

      const tf = bubble.toolFormerData;
      if (!tf?.name) continue;
      const args = parseCursorArgs(tf.rawArgs ?? tf.params);
      const resultText = typeof tf.result === 'string'
        ? tf.result
        : (tf.result != null ? JSON.stringify(tf.result) : '');
      const status = String(tf.status ?? '').toLowerCase();
      const isError = Boolean(tf.isError)
        || /^(error|failed|cancelled|canceled)$/.test(status)
        || status.includes('error')
        || status.includes('fail');

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
        if (!Object.keys(target.tool.args || {}).length) target.tool.args = args;
        if (tf.toolCallId) target.tool.id = tf.toolCallId;
        const pending = new Map([[target.tool.id, target]]);
        attachResult(session, pending, target.tool.id, resultText, isError, ts);
      } else {
        const pending = new Map();
        const ev = addToolCall(session, pending, ts, {
          id: tf.toolCallId ?? `cursor-db-${bubbleId}`,
          name: tf.name,
          args,
        });
        attachResult(session, pending, ev.tool.id, resultText, isError, ts);
      }
    }
  } finally {
    if (owned) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}

/**
 * Parse a Cursor agent-transcript JSONL file into normalized session(s).
 * Parent transcripts also load sibling `subagents/*.jsonl` as child sessions.
 */
export function parseCursorFile(file, agent, { enrich = true, DatabaseSync = getCursorDatabaseSync(), dbPath = cursorStateDbPath() } = {}) {
  const composerId = path.basename(file, '.jsonl');
  const session = newSession('cursor', file, agent);
  session.id = composerId;
  parseCursorJsonlInto(session, file);
  finalizeLabel(session);

  const sessions = [];
  if (session.events.length) sessions.push(session);

  const subDir = path.join(path.dirname(file), 'subagents');
  for (const name of safeReaddir(subDir)) {
    if (!name.endsWith('.jsonl')) continue;
    const childFile = path.join(subDir, name);
    const child = newSession('cursor', childFile, agent);
    child.id = path.basename(name, '.jsonl');
    child.parent = composerId;
    parseCursorJsonlInto(child, childFile);
    if (!child.events.length) continue;
    if (!child.label) child.label = '(sub-agent)';
    finalizeLabel(child);
    session.children.push(child.id);
    sessions.push(child);

    // Link a Task/Agent tool whose prompt overlaps this child's first user text.
    const firstUser = child.events.find((e) => e.kind === 'user')?.text ?? '';
    for (const ev of session.events) {
      if (ev.kind !== 'tool' || ev.tool.spawnTarget || !SPAWN_TOOL_RE.test(ev.tool.name)) continue;
      const prompt = String(ev.tool.args?.prompt ?? ev.tool.args?.description ?? '');
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
        try { db.close(); } catch { /* ignore */ }
      }
    }
  }

  return sessions;
}

function cursorAdapter() {
  const root = process.env.CURSOR_PROJECTS_DIR ?? path.join(os.homedir(), '.cursor', 'projects');
  return {
    source: 'cursor',
    findFiles() {
      const found = [];
      for (const proj of safeReaddir(root)) {
        const transcripts = path.join(root, proj, 'agent-transcripts');
        for (const sessionDir of safeReaddir(transcripts)) {
          const dir = path.join(transcripts, sessionDir);
          let st;
          try { st = fs.statSync(dir); } catch { continue; }
          if (!st.isDirectory()) continue;
          const main = path.join(dir, `${sessionDir}.jsonl`);
          try {
            if (fs.statSync(main).isFile()) found.push({ file: main, agent: proj });
          } catch { /* missing main transcript */ }
        }
      }
      return found;
    },
    parseFile: ({ file, agent }) => parseCursorFile(file, agent),
  };
}

export function makeAdapters({ explicitDir = null, sources = null } = {}) {
  // An explicit --dir points at an OpenClaw-layout state dir and disables the
  // other sources so demos/exports aren't mixed with local history.
  const all = explicitDir
    ? [openclawAdapter(explicitDir)]
    : [openclawAdapter(null), claudeCodeAdapter(), codexAdapter(), hermesAdapter(), cursorAdapter()];
  return sources ? all.filter((a) => sources.includes(a.source)) : all;
}
