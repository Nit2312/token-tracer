#!/usr/bin/env node
/**
 * Install team sync daemon as a macOS LaunchAgent (admin-only).
 * Usage:
 *   node bin/install-daemon.mjs --api-url https://... --api-key av_live_xxx
 *   node bin/install-daemon.mjs --api-url http://127.0.0.1:4488 --api-key ... --service-name com.company.devmetrics
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};

const apiUrl = arg('--api-url') || process.env.TEAM_API_URL;
const apiKey = arg('--api-key') || process.env.TEAM_API_KEY;
const serviceName = arg('--service-name') || 'com.company.devmetrics';
const intervalMin = Number(arg('--interval-min') || 60);
const nodeBin = arg('--node') || process.execPath;

if (!apiUrl || !apiKey) {
  console.error('Usage: node bin/install-daemon.mjs --api-url URL --api-key KEY [--service-name LABEL] [--interval-min 60]');
  process.exit(1);
}

if (process.platform !== 'darwin') {
  console.error('install-daemon currently supports macOS only');
  process.exit(1);
}

const configDir = path.join(os.homedir(), '.devmetrics');
const configPath = path.join(configDir, 'config.json');
const daemonPath = path.join(ROOT, 'bin', 'sync-daemon.mjs');
const launchAgents = path.join(os.homedir(), 'Library', 'LaunchAgents');
const plistPath = path.join(launchAgents, `${serviceName}.plist`);
const logPath = path.join(configDir, 'daemon.log');

fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(configPath, JSON.stringify({ apiUrl, apiKey, intervalMin, serviceName }, null, 2), { mode: 0o600 });

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${serviceName}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${daemonPath}</string>
    <string>--config</string>
    <string>${configPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  <key>ThrottleInterval</key>
  <integer>60</integer>
</dict>
</plist>
`;

fs.mkdirSync(launchAgents, { recursive: true });
fs.writeFileSync(plistPath, plist, { mode: 0o644 });

try { execSync(`launchctl bootout gui/${process.getuid()} "${plistPath}"`, { stdio: 'ignore' }); } catch { /* not loaded */ }
execSync(`launchctl bootstrap gui/${process.getuid()} "${plistPath}"`);
execSync(`launchctl enable gui/${process.getuid()}/${serviceName}`, { stdio: 'ignore' });

console.log(`installed: ${serviceName}`);
console.log(`config: ${configPath}`);
console.log(`plist: ${plistPath}`);
