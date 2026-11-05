#!/usr/bin/env node
/**
 * Background team sync daemon — reads local transcripts, pushes aggregates only.
 * Personal dashboard (npm start) is separate; this never serves HTTP.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanSessions } from '../lib/scan.mjs';
import { sanitizeForTeamSync } from '../lib/team/sanitize.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DEFAULT_CONFIG = path.join(os.homedir(), '.devmetrics', 'config.json');
const DEFAULT_STATE = path.join(os.homedir(), '.devmetrics', 'sync-state.json');
const DEFAULT_LOG = path.join(os.homedir(), '.devmetrics', 'sync.log');
const BATCH_SIZE = 100;
const MAX_LOG_BYTES = 256 * 1024;

const args = process.argv.slice(2);
const once = args.includes('--once');
const arg = (name) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};

function loadJson(file, fallback) {
  // strip a UTF-8 BOM (Windows PowerShell 5.1 writes one) — JSON.parse rejects it
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}

function appendLog(logPath, line) {
  const dir = path.dirname(logPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > MAX_LOG_BYTES) {
      const prev = fs.readFileSync(logPath, 'utf8');
      fs.writeFileSync(logPath, prev.slice(-MAX_LOG_BYTES / 2), { mode: 0o600 });
    }
  } catch { /* ignore */ }
  fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
}

/** macOS battery check — skip sync on low battery when unplugged. */
function isLowBattery() {
  if (process.platform !== 'darwin') return false;
  try {
    const out = execSync('pmset -g batt', { encoding: 'utf8', timeout: 3000 });
    const pct = Number(out.match(/(\d+)%/)?.[1] ?? 100);
    const unplugged = /Battery Power|discharging/i.test(out);
    return unplugged && pct < 20;
  } catch {
    return false;
  }
}

function loadPricing() {
  const pricingFile = path.join(ROOT, 'lib', 'pricing.json');
  try { return JSON.parse(fs.readFileSync(pricingFile, 'utf8')); } catch { return null; }
}

function sessionKey(s) {
  return `${s.source}:${s.id}`;
}

async function postBatch(apiUrl, apiKey, sessions) {
  const url = `${apiUrl.replace(/\/$/, '')}/api/v1/ingest`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ sessions }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// Vercel rejects request bodies over 4.5 MB (before our handler runs, so nothing is
// logged server-side) and each session costs several DB round-trips, so cap both the
// bytes and the session count per request.
var MAX_BATCH_BYTES = 3 * 1024 * 1024;
var MAX_BATCH_SESSIONS = 25;
function chunkPayloads(payloads) {
  const batches = [];
  let cur = [];
  let curBytes = 0;
  for (const p of payloads) {
    let size = JSON.stringify(p).length;
    if (size > MAX_BATCH_BYTES) {
      // A single oversized session: drop its message bodies, keep stats/tools/files.
      p.events = [];
      size = JSON.stringify(p).length;
    }
    if (cur.length && (cur.length >= MAX_BATCH_SESSIONS || curBytes + size > MAX_BATCH_BYTES)) {
      batches.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(p);
    curBytes += size;
  }
  if (cur.length) batches.push(cur);
  return batches;
}
async function runSync(configPath, statePath, logPath) {
  const config = loadJson(configPath, null);
  if (!config?.apiUrl || !config?.apiKey) {
    throw new Error(`missing apiUrl/apiKey in ${configPath} (file absent, unreadable or not valid JSON)`);
  }

  if (isLowBattery()) {
    appendLog(logPath, 'skip: low battery');
    return;
  }

  const pricing = loadPricing();
  const cache = new Map();
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
    appendLog(logPath, 'ok: nothing new');
    return;
  }

  let accepted = 0;
  const batches = chunkPayloads(pending);
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    let result;
    try {
      result = await postBatch(config.apiUrl, config.apiKey, batch);
    } catch (err) {
      appendLog(logPath, `error: batch ${b + 1}/${batches.length} (${batch.length} sessions, ${(JSON.stringify(batch).length / 1024).toFixed(0)} KB) failed: ${err.message}`);
      throw err;
    }
    accepted += result.accepted ?? 0;
    for (const p of batch) {
      state.synced[`${p.source}:${p.sessionId}`] = p.payloadHash;
    }
    // Persist after every batch so a later failure doesn't redo finished work.
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 448 });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 384 });
  }
  appendLog(logPath, `ok: sent ${pending.length} updated, accepted ${accepted}`);
}

async function main() {
  const configPath = arg('--config') || process.env.DEVMETRICS_CONFIG || DEFAULT_CONFIG;
  const statePath = arg('--state') || process.env.DEVMETRICS_STATE || DEFAULT_STATE;
  const intervalMin = Number(arg('--interval-min') || loadJson(configPath, {})?.intervalMin || 120);

  const tick = async () => {
    try {
      await runSync(configPath, statePath, logPath);
    } catch (err) {
      appendLog(logPath, `error: ${err.message}`);
    }
  };

  await tick();
  if (once) return;

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
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
