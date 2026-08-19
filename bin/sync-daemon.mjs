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
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
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

async function runSync(configPath, statePath, logPath) {
  const config = loadJson(configPath, null);
  if (!config?.apiUrl || !config?.apiKey) {
    throw new Error(`missing apiUrl/apiKey in ${configPath}`);
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
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    const result = await postBatch(config.apiUrl, config.apiKey, batch);
    accepted += result.accepted ?? 0;
    for (const p of batch) {
      state.synced[`${p.source}:${p.sessionId}`] = p.payloadHash;
    }
  }

  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
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
