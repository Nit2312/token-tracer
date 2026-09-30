import path from 'node:path';

export const EDIT_TOOLS = new Set([
  'edit', 'write', 'notebookedit', 'multiedit', 'str_replace_editor', 'strreplace', 'apply_patch',
]);

const CORRECTION_RE = /(?:^|\b)(?:no[,—:]?|nope|wrong|incorrect|not what i|that(?:'s| is) not|you (?:missed|ignored|changed)|actually[,—:]?|instead[,—:]?|stop[,—:]?|undo|revert|go back|don(?:'t| not)|i said|please fix that)(?:\b|$)/i;

export const dayKey = (ts) => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const lineCount = (value) => {
  if (typeof value !== 'string' || value.length === 0) return 0;
  const normalized = value.replace(/\r\n/g, '\n');
  const count = normalized.split('\n').length;
  return normalized.endsWith('\n') ? count - 1 : count;
};

function cleanFilePath(value) {
  if (typeof value !== 'string') return null;
  let out = value.trim().replace(/^['"]|['"]$/g, '').replaceAll('\\', '/');
  out = out.replace(/^[ab]\//, '');
  return out && out !== '/dev/null' ? out : null;
}

function patchTextFrom(args) {
  if (typeof args === 'string') return args;
  if (!args || typeof args !== 'object') return '';
  for (const key of ['patch', 'input', 'cmd', 'command']) {
    if (typeof args[key] === 'string' && (args[key].includes('*** Begin Patch') || args[key].includes('diff --git '))) {
      let text = args[key];
      // Newer Codex wrappers can carry apply_patch inside a JavaScript string.
      if (!/^\*\*\* (?:Add|Update|Delete) File:/m.test(text)) text = decodeWrappedPatch(text);
      return text;
    }
  }
  return '';
}

function decodeWrappedPatch(source) {
  const marker = source.indexOf('*** Begin Patch');
  if (marker <= 0) return source;
  const quote = source[marker - 1];
  if (!['"', "'", '`'].includes(quote)) return source;
  let end = marker;
  while (end < source.length) {
    end = source.indexOf(quote, end + 1);
    if (end < 0) return source;
    let slashes = 0;
    for (let i = end - 1; i >= 0 && source[i] === '\\'; i--) slashes++;
    if (slashes % 2 === 0) break;
  }
  const encoded = source.slice(marker, end);
  if (quote === '"') {
    try { return JSON.parse(`"${encoded}"`); } catch { /* use tolerant decoder */ }
  }
  let out = '';
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] !== '\\' || i === encoded.length - 1) { out += encoded[i]; continue; }
    const next = encoded[++i];
    out += next === 'n' ? '\n' : next === 'r' ? '\r' : next === 't' ? '\t' : next;
  }
  return out;
}

/** Parse Codex apply_patch and ordinary unified diff bodies into per-file deltas. */
export function parsePatch(patch) {
  if (typeof patch !== 'string' || !patch) return [];
  const records = new Map();
  let current = null;
  const get = (p) => {
    p = cleanFilePath(p);
    if (!p) return null;
    if (!records.has(p)) records.set(p, { path: p, additions: 0, deletions: 0 });
    return records.get(p);
  };

  for (const line of patch.replace(/\r\n/g, '\n').split('\n')) {
    let m = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line);
    if (m) { current = get(m[1]); continue; }
    m = /^\*\*\* Move to: (.+)$/.exec(line);
    if (m) { current = get(m[1]); continue; }
    m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) { current = get(m[2]); continue; }
    m = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (m && m[1] !== '/dev/null') { current = get(m[1]); continue; }
    if (!current || /^\+\+\+|^---/.test(line)) continue;
    if (line.startsWith('+')) current.additions++;
    else if (line.startsWith('-')) current.deletions++;
  }
  return [...records.values()];
}

function stringEdit(pathValue, oldValue, newValue) {
  const p = cleanFilePath(pathValue);
  if (!p) return [];
  return [{ path: p, additions: lineCount(newValue), deletions: lineCount(oldValue) }];
}

/** Normalize Edit/Write/NotebookEdit/str_replace_editor/apply_patch calls. */
export function extractEditOperations(ev) {
  if (ev?.kind !== 'tool') return [];
  const name = String(ev.tool?.name ?? '').toLowerCase();
  const args = ev.tool?.args ?? {};
  const patch = patchTextFrom(args);
  if (patch) return parsePatch(patch);
  if (!EDIT_TOOLS.has(name)) return [];

  const p = args.file_path ?? args.path ?? args.notebook_path ?? args.file;
  if (name === 'multiedit' || Array.isArray(args.edits)) {
    return (args.edits ?? []).flatMap((edit) => stringEdit(p, edit.old_string ?? edit.old_str ?? '', edit.new_string ?? edit.new_str ?? ''));
  }
  if (name === 'write') return stringEdit(p, '', args.content ?? args.file_text ?? args.text ?? '');
  // BUG-4 fix: removed duplicate `args.new_source ?? args.new_source` no-op
  if (name === 'notebookedit') return stringEdit(p, args.old_source ?? '', args.new_source ?? args.source ?? '');
  if (name === 'str_replace_editor') {
    const command = String(args.command ?? '').toLowerCase();
    if (command === 'create') return stringEdit(p, '', args.file_text ?? args.new_str ?? '');
    if (command === 'insert') return stringEdit(p, '', args.new_str ?? args.text ?? '');
    return stringEdit(p, args.old_str ?? args.old_string ?? '', args.new_str ?? args.new_string ?? '');
  }
  return stringEdit(p, args.old_string ?? args.old_str ?? '', args.new_string ?? args.new_str ?? args.content ?? '');
}

function rateFor(model, source, pricing) {
  if (!pricing?.models?.length) return null;
  const value = normalizeModelName(model, source);
  for (const rate of pricing.models) {
    if (rate.source && rate.source !== source) continue;
    try {
      if (new RegExp(rate.pattern, 'i').test(value)) return rate;
    } catch { /* tolerate a bad custom pricing row */ }
  }
  return pricing.models.find((r) => r.id === 'default' || /^default$/i.test(r.pattern)) ?? null;
}

/** Cursor / Codex slugs → canonical names for pricing.json patterns. */
export function normalizeModelName(model, source) {
  let value = String(model ?? '').trim();
  if (!value || /^default$/i.test(value)) return 'default';
  value = value.replace(/^cursor-/i, '').toLowerCase();

  const aliases = {
    'composer-2-fast': 'composer-2.5-fast',
    'composer-2.5-fast': 'composer-2.5-fast',
    'composer-2': 'composer-2.5-fast',
    'composer-2.5': 'composer-2.5-fast',
    'composer-1': 'composer-1',
    'grok-4.5-fast': 'grok-4.5-fast',
    'grok-4.5-high-fast': 'grok-4.5-fast',
    'cursor-grok-4.5-high-fast': 'grok-4.5-fast',
    'grok-4.5': 'grok-4.5',
    'glm-5.2-high': 'glm-5.2',
    'glm-5.2': 'glm-5.2',
    'claude-4.6-sonnet-medium-thinking': 'claude-sonnet-4-6',
    'claude-sonnet-5-thinking-high': 'claude-sonnet-5',
    'gpt-5.4-mini': 'gpt-5.4-mini',
  };
  return aliases[value] ?? value;
}

/** True when session has token counts worth pricing. */
export function sessionHasBillableTokens(session) {
  const usage = session.stats ?? {};
  return (
    (usage.tokensIn || 0)
    + (usage.tokensOut || 0)
    + (usage.tokensCacheRead || 0)
    + (usage.tokensCacheWrite || 0)
  ) > 0;
}

/** Session lacks a rate despite having billable token usage. */
export function isSessionUnpriced(session, pricing) {
  if (priceSession(session, pricing).total != null) return false;
  return sessionHasBillableTokens(session);
}

export function priceSession(session, pricing) {
  const rate = rateFor(session.model, session.source, pricing);
  if (!rate) return { total: null, rate: null, freshInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const usage = session.stats ?? {};
  const cacheRead = Math.max(0, usage.tokensCacheRead || 0);
  const cacheWrite = Math.max(0, usage.tokensCacheWrite || 0);
  // BUG-2 fix: After BUG-1 fix, tokensIn no longer includes cache tokens,
  // so it already represents fresh (non-cached) input. No subtraction needed.
  const freshInput = Math.max(0, (usage.tokensIn || 0));
  const output = Math.max(0, usage.tokensOut || 0);
  const total = (
    freshInput * (rate.input || 0)
    + cacheRead * (rate.cacheRead ?? rate.input ?? 0)
    + cacheWrite * (rate.cacheWrite ?? rate.input ?? 0)
    + output * (rate.output || 0)
  ) / 1_000_000;
  return {
    total,
    rate: { id: rate.id, label: rate.label, input: rate.input, output: rate.output, cacheRead: rate.cacheRead, cacheWrite: rate.cacheWrite },
    freshInput,
    cacheRead,
    cacheWrite,
    output,
  };
}

const median = (values) => {
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
};

function sessionIntelligence(session, pricing) {
  const files = new Map();
  const edits = [];
  const toolLatencies = [];
  const users = session.events.filter((e) => e.kind === 'user');
  let toolCalls = 0;
  let toolErrors = 0;
  let firstEditAt = null;

  for (const ev of session.events) {
    if (ev.kind !== 'tool') continue;
    toolCalls++;
    if (ev.tool.isError) toolErrors++;
    if (ev.ts && ev.tool.resultTs) {
      const ms = Date.parse(ev.tool.resultTs) - Date.parse(ev.ts);
      if (ms >= 0 && ms < 86_400_000) toolLatencies.push(ms);
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

  const corrections = users.slice(1).filter((e) => CORRECTION_RE.test(e.text ?? '')).length;
  const firstUserAt = users.find((e) => e.ts)?.ts ?? null;
  let timeToFirstEditMs = null;
  if (firstUserAt && firstEditAt) {
    const ms = Date.parse(firstEditAt) - Date.parse(firstUserAt);
    if (ms >= 0 && ms < 86_400_000) timeToFirstEditMs = ms;
  }
  const last = [...session.events].reverse().find((e) => e.kind === 'user' || e.kind === 'assistant' || e.kind === 'tool');
  // BUG-5 fix: a session is "live" if it hasn't ended yet, OR if it ended
  // very recently (within 5 minutes). Previously this required endedAt to be
  // set, which by definition means the session already ended.
  const isLive = !session.endedAt || (Date.now() - Date.parse(session.endedAt) < 5 * 60_000);
  const abandoned = Boolean(users.length && last?.kind !== 'assistant' && !isLive);
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
    cost,
  };
}

function sourceAggregate(source) {
  return {
    source, sessions: 0, edits: 0, changedLines: 0, outputTokens: 0, inputTokens: 0,
    cacheRead: 0, toolCalls: 0, toolErrors: 0, toolLatencies: [], apiCost: 0,
    pricedSessions: 0, pricedEdits: 0, pricedChangedLines: 0,
    corrections: 0, reworkLoops: 0, abandoned: 0, firstEditTimes: [],
  };
}

function finalizeSource(row) {
  // After BUG-1 fix, row.inputTokens is fresh-only. For cache efficiency ratio,
  // we need total input = fresh + cacheRead as the denominator.
  const cacheDenom = Math.max(0, row.inputTokens + row.cacheRead);
  return {
    source: row.source,
    sessions: row.sessions,
    edits: row.edits,
    changedLines: row.changedLines,
    apiCost: row.apiCost,
    pricedSessions: row.pricedSessions,
    editsPerSession: row.sessions ? row.edits / row.sessions : null,
    outputTokensPerEdit: row.edits ? row.outputTokens / row.edits : null,
    toolErrorRate: row.toolCalls ? row.toolErrors / row.toolCalls : null,
    medianToolLatencyMs: median(row.toolLatencies),
    cacheEfficiency: cacheDenom ? row.cacheRead / cacheDenom : null,
    costPerEdit: row.pricedEdits ? row.apiCost / row.pricedEdits : null,
    costPer100Lines: row.pricedChangedLines ? row.apiCost / row.pricedChangedLines * 100 : null,
    correctionsPerSession: row.sessions ? row.corrections / row.sessions : null,
    reworkPerSession: row.sessions ? row.reworkLoops / row.sessions : null,
    abandonedRate: row.sessions ? row.abandoned / row.sessions : null,
    medianTimeToFirstEditMs: median(row.firstEditTimes),
  };
}

function riskLevel(score) {
  return score >= 65 ? 'high' : score >= 30 ? 'watch' : 'low';
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Normalize YYYY-MM-DD; return null if invalid. */
export function normalizeDateParam(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return null;
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : dayKey(d);
}

/**
 * Whether a session falls in an inclusive from/to day window.
 * Undated sessions are excluded when either bound is set.
 */
export function sessionInDateRange(session, from, to) {
  const fromDay = normalizeDateParam(from);
  const toDay = normalizeDateParam(to);
  if (!fromDay && !toDay) return true;
  const iso = session?.endedAt || session?.startedAt;
  if (!iso) return false;
  const k = dayKey(iso);
  if (!k) return false;
  if (fromDay && k < fromDay) return false;
  if (toDay && k > toDay) return false;
  return true;
}

/** Inclusive day span between two YYYY-MM-DD keys. */
function daySpan(from, to) {
  const a = Date.parse(`${from}T00:00:00`);
  const b = Date.parse(`${to}T00:00:00`);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return Math.round((b - a) / 86_400_000) + 1;
}

export function buildStats(sessions, { days = 30, from = null, to = null, pricing = null } = {}) {
  const fromDay = normalizeDateParam(from);
  const toDay = normalizeDateParam(to);
  const perDay = new Map();
  const day = (k) => {
    if (!k) return null;
    if (!perDay.has(k)) perDay.set(k, { date: k, toolCalls: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0, tokensCacheWrite: 0, sessions: 0, errors: 0, additions: 0, deletions: 0, edits: 0, apiCost: 0 });
    return perDay.get(k);
  };
  const punch = Array.from({ length: 7 }, () => Array(24).fill(0));
  const tools = new Map();
  const models = new Map();
  const files = new Map();
  const directories = new Map();
  const sources = new Map();
  const totals = {
    sessions: sessions.length, spawns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0,
    cacheRead: 0, cacheWrite: 0, errors: 0, edits: 0, editCalls: 0, messages: 0,
    additions: 0, deletions: 0, changedLines: 0, filesTouched: 0,
  };
  const sessionRows = [];
  let longest = null;

  for (const session of sessions) {
    const intel = sessionIntelligence(session, pricing);
    const source = sources.get(session.source) ?? sourceAggregate(session.source);
    sources.set(session.source, source);
    source.sessions++;
    source.edits += intel.editOperations;
    source.changedLines += intel.changedLines;
    source.outputTokens += session.stats.tokensOut || 0;
    source.inputTokens += session.stats.tokensIn || 0;
    source.cacheRead += session.stats.tokensCacheRead || 0;
    source.toolCalls += intel.toolCalls;
    source.toolErrors += intel.toolErrors;
    source.toolLatencies.push(...intel.toolLatencies);
    source.corrections += intel.corrections;
    source.reworkLoops += intel.reworkLoops;
    source.abandoned += Number(intel.abandoned);
    if (intel.timeToFirstEditMs != null) source.firstEditTimes.push(intel.timeToFirstEditMs);
    if (intel.cost.total != null) {
      source.apiCost += intel.cost.total;
      source.pricedSessions++;
      source.pricedEdits += intel.editOperations;
      source.pricedChangedLines += intel.changedLines;
    }

    totals.spawns += session.children.length;
    totals.tokensIn += session.stats.tokensIn || 0;
    totals.tokensOut += session.stats.tokensOut || 0;
    totals.cacheRead += session.stats.tokensCacheRead || 0;
    totals.cacheWrite += session.stats.tokensCacheWrite || 0;
    totals.errors += intel.toolErrors;
    totals.messages += session.stats.messages || 0;
    totals.edits += intel.editOperations;
    totals.additions += intel.additions;
    totals.deletions += intel.deletions;
    totals.changedLines += intel.changedLines;

    const modelKey = session.model || '(unknown model)';
    const model = models.get(modelKey) ?? { name: modelKey, sessions: 0, apiCost: 0, pricedSessions: 0, rate: intel.cost.rate };
    model.sessions++;
    if (intel.cost.total != null) { model.apiCost += intel.cost.total; model.pricedSessions++; }
    models.set(modelKey, model);

    const startedDay = day(dayKey(session.startedAt));
    if (startedDay) {
      startedDay.sessions++;
      startedDay.tokensIn += session.stats.tokensIn || 0;
      startedDay.tokensOut += session.stats.tokensOut || 0;
      startedDay.tokensCache += session.stats.tokensCacheRead || 0;
      startedDay.tokensCacheWrite += session.stats.tokensCacheWrite || 0;
      startedDay.errors += intel.toolErrors;
      if (intel.cost.total != null) startedDay.apiCost += intel.cost.total;
    }
    if (session.startedAt && session.endedAt) {
      const ms = Date.parse(session.endedAt) - Date.parse(session.startedAt);
      if (ms > 0 && ms < 86_400_000 && (!longest || ms > longest.ms)) longest = { ms, label: session.label, id: session.id };
    }

    const seenFiles = new Set();
    for (const edit of intel.edits) {
      const k = dayKey(edit.ts) ?? dayKey(session.startedAt);
      const d = day(k);
      if (d) { d.additions += edit.additions; d.deletions += edit.deletions; d.edits++; }
      const f = files.get(edit.path) ?? { path: edit.path, additions: 0, deletions: 0, edits: 0, sessionIds: new Set(), sources: new Set() };
      f.additions += edit.additions;
      f.deletions += edit.deletions;
      f.edits++;
      f.sessionIds.add(session.id);
      f.sources.add(session.source);
      files.set(edit.path, f);
      seenFiles.add(edit.path);
    }
    if (intel.editOperations) totals.editCalls += session.events.filter((e) => extractEditOperations(e).length).length;

    sessionRows.push({
      id: session.id, source: session.source, label: session.label, model: session.model,
      apiCost: intel.cost.total, rate: intel.cost.rate, edits: intel.editOperations,
      changedLines: intel.changedLines, reworkLoops: intel.reworkLoops, corrections: intel.corrections,
      abandoned: intel.abandoned, timeToFirstEditMs: intel.timeToFirstEditMs,
    });

    for (const ev of session.events) {
      if (!ev.ts) continue;
      const t = new Date(ev.ts);
      if (!Number.isNaN(t.getTime()) && (ev.kind === 'tool' || ev.kind === 'assistant')) punch[t.getDay()][t.getHours()]++;
      if (ev.kind !== 'tool') continue;
      totals.toolCalls++;
      const d = day(dayKey(ev.ts));
      if (d) d.toolCalls++;
      const rec = tools.get(ev.tool.name) || { name: ev.tool.name, count: 0, errors: 0 };
      rec.count++;
      if (ev.tool.isError) rec.errors++;
      tools.set(ev.tool.name, rec);
    }
  }

  totals.filesTouched = files.size;
  const fileRows = [...files.values()].map((f) => {
    const sessionsTouched = f.sessionIds.size;
    const churn = Math.max(0, sessionsTouched - 1) + Math.max(0, f.edits - sessionsTouched);
    const score = Math.round(Math.min(100,
      35 * Math.min(1, sessionsTouched / 4) + 25 * Math.min(1, f.edits / 8)
      + 25 * Math.min(1, churn / 6) + 15 * Math.min(1, (f.additions + f.deletions) / 500)));
    const directory = path.posix.dirname(f.path.replaceAll('\\', '/'));
    const dir = directories.get(directory) ?? { path: directory, edits: 0, additions: 0, deletions: 0, files: new Set(), sessions: new Set() };
    dir.edits += f.edits;
    dir.additions += f.additions;
    dir.deletions += f.deletions;
    dir.files.add(f.path);
    for (const id of f.sessionIds) dir.sessions.add(id);
    directories.set(directory, dir);
    return {
      path: f.path, directory, edits: f.edits, additions: f.additions, deletions: f.deletions,
      changedLines: f.additions + f.deletions, sessions: sessionsTouched, churn,
      sources: [...f.sources], riskScore: score, risk: riskLevel(score),
    };
  }).sort((a, b) => b.riskScore - a.riskScore || b.changedLines - a.changedLines);

  const directoryRows = [...directories.values()].map((d) => ({
    path: d.path, edits: d.edits, additions: d.additions, deletions: d.deletions,
    changedLines: d.additions + d.deletions, files: d.files.size, sessions: d.sessions.size,
  })).sort((a, b) => b.edits - a.edits || b.changedLines - a.changedLines);

  const keys = [...perDay.keys()].sort();
  const today = new Date();
  const todayKey = dayKey(today);
  let start;
  let end;
  if (fromDay || toDay) {
    const endKey = toDay || todayKey;
    const startKey = fromDay || (keys.length ? keys[0] : endKey);
    start = new Date(`${startKey <= endKey ? startKey : endKey}T00:00:00`);
    end = new Date(`${startKey <= endKey ? endKey : startKey}T00:00:00`);
  } else {
    end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (Number.isFinite(days)) {
      start = new Date(today.getTime() - (Math.max(1, days) - 1) * 86_400_000);
    } else if (keys.length) {
      // Skip epoch/noise dates when charting unbounded history.
      const first = keys.find((k) => k >= '2015-01-01') || keys[0];
      start = new Date(`${first}T00:00:00`);
    } else {
      start = end;
    }
    start = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  }
  const series = [];
  for (let d = new Date(start.getFullYear(), start.getMonth(), start.getDate()); d <= end; d.setDate(d.getDate() + 1)) {
    const k = dayKey(d);
    series.push(perDay.get(k) || { date: k, toolCalls: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0, tokensCacheWrite: 0, sessions: 0, errors: 0, additions: 0, deletions: 0, edits: 0, apiCost: 0 });
  }

  let peak = { weekday: 0, hour: 0, n: 0 };
  for (let w = 0; w < 7; w++) for (let h = 0; h < 24; h++) if (punch[w][h] > peak.n) peak = { weekday: w, hour: h, n: punch[w][h] };
  const busiest = series.reduce((m, d) => (d.toolCalls > (m?.toolCalls || 0) ? d : m), null);
  const activeDays = series.filter((d) => d.toolCalls > 0 || d.sessions > 0).length;
  let streak = 0;
  for (let i = series.length - 1; i >= 0 && (series[i].toolCalls > 0 || series[i].sessions > 0); i--) streak++;

  const apiCost = sessionRows.reduce((n, s) => n + (s.apiCost || 0), 0);
  const billableSessions = sessions.filter((s) => sessionHasBillableTokens(s));
  const unpricedList = sessions.filter((s) => isSessionUnpriced(s, pricing));
  const unpricedModels = new Map();
  for (const s of unpricedList) {
    const key = `${s.source}|${s.model || '(unknown model)'}`;
    unpricedModels.set(key, (unpricedModels.get(key) ?? 0) + 1);
  }
  const pricedSessions = billableSessions.length - unpricedList.length;
  const pricedEdits = sessionRows.filter((s) => s.apiCost != null).reduce((n, s) => n + s.edits, 0);
  const workflow = {
    reworkLoops: sessionRows.reduce((n, s) => n + s.reworkLoops, 0),
    sessionsWithRework: sessionRows.filter((s) => s.reworkLoops > 0).length,
    corrections: sessionRows.reduce((n, s) => n + s.corrections, 0),
    sessionsCorrected: sessionRows.filter((s) => s.corrections > 0).length,
    abandoned: sessionRows.filter((s) => s.abandoned).length,
    medianTimeToFirstEditMs: median(sessionRows.map((s) => s.timeToFirstEditMs)),
  };

  return {
    window: {
      from: series[0]?.date ?? todayKey,
      to: series[series.length - 1]?.date ?? todayKey,
      days: (fromDay || toDay)
        ? daySpan(series[0]?.date, series[series.length - 1]?.date)
        : (Number.isFinite(days) ? days : null),
    },
    totals,
    perDay: series,
    punch,
    tools: [...tools.values()].sort((a, b) => b.count - a.count),
    models: [...models.values()].sort((a, b) => b.sessions - a.sessions),
    impact: { files: fileRows, directories: directoryRows, churnFiles: fileRows.filter((f) => f.sessions > 1 || f.churn > 1) },
    scoreboard: [...sources.values()].map(finalizeSource).sort((a, b) => b.sessions - a.sessions),
    workflow,
    cost: {
      total: apiCost,
      pricedSessions,
      unpricedSessions: unpricedList.length,
      unpricedModels: [...unpricedModels.entries()].map(([key, count]) => {
        const [source, model] = key.split('|');
        return { source, model, count };
      }).sort((a, b) => b.count - a.count),
      coverage: billableSessions.length ? pricedSessions / billableSessions.length : 1,
      billableSessions: billableSessions.length,
      perSession: pricedSessions ? apiCost / pricedSessions : null,
      perEdit: pricedEdits ? apiCost / pricedEdits : null,
      bySource: [...sources.values()].map(finalizeSource).map((s) => ({ source: s.source, total: s.apiCost, sessions: s.sessions, pricedSessions: s.pricedSessions, costPerEdit: s.costPerEdit, costPer100Lines: s.costPer100Lines })),
      sessions: sessionRows.sort((a, b) => (b.apiCost || 0) - (a.apiCost || 0)),
      pricingUpdatedAt: pricing?.updatedAt ?? null,
      currency: pricing?.currency ?? 'USD',
    },
    records: {
      longestSession: longest,
      busiestDay: busiest && busiest.toolCalls ? busiest : null,
      peakHour: peak.n ? peak : null,
      activeDays,
      streak,
    },
  };
}

export function sessionSummary(session, pricing, includeEvents = false) {
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
      medianToolLatencyMs: intel.medianToolLatencyMs,
    },
    ...(includeEvents ? { events: session.events } : {}),
  };
}
