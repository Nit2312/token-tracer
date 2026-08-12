import fs from 'node:fs';
import path from 'node:path';

let loaded = false;

/** Fallback loader for .env.local and .env files */
export function loadEnv() {
  if (loaded) return;
  loaded = true;
  const files = ['.env.local', '.env'];
  for (const f of files) {
    const filePath = path.join(process.cwd(), f);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!val) continue;
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    } catch {
      // ignore
    }
  }
}

export function databaseUrl(): string | null {
  loadEnv();
  return process.env.DATABASE_URL || process.env.NEON_CONNECTION_STRING || null;
}

let warnedAboutDirectConnection = false;

export function requireDatabaseUrl(): string {
  const url = databaseUrl();
  if (!url) throw new Error('DATABASE_URL or NEON_CONNECTION_STRING is required');

  // On Vercel, each concurrent Fluid Compute instance opens its own pg.Pool —
  // a direct (non-pooled) Neon endpoint runs out of native Postgres
  // connections at a fraction of the concurrency a PgBouncer pooler endpoint
  // can sustain. Warn loudly rather than fail silently under load.
  if (!warnedAboutDirectConnection && process.env.VERCEL === '1') {
    try {
      const host = new URL(url).hostname;
      if (host.includes('neon.tech') && !host.includes('-pooler')) {
        warnedAboutDirectConnection = true;
        console.error(
          `[db config warning] DATABASE_URL host "${host}" does not look like a Neon pooled ` +
          `("-pooler") endpoint. Under Vercel Fluid Compute, many concurrent instances each open ` +
          `their own connection pool — a direct endpoint will exhaust Neon's connection limit ` +
          `well before a pooled one does. Use the "-pooler" connection string from the Neon dashboard.`
        );
      }
    } catch {
      // Malformed URL — let the pg client surface the real error downstream.
    }
  }

  return url;
}

export function adminPassword(): string | null {
  loadEnv();
  return process.env.ADMIN_PASSWORD || null;
}

export function superadminPassword(): string | null {
  loadEnv();
  return process.env.SUPERADMIN_PASSWORD || null;
}

export function sessionSecret(): string {
  loadEnv();
  const secret = process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'CRITICAL SECURITY ERROR: SESSION_SECRET or ADMIN_PASSWORD must be configured in production mode. ' +
        'Refusing to fallback to insecure default secret.'
      );
    }
    return 'dev-insecure-change-me';
  }
  return secret;
}

export function cronSecret(): string | null {
  loadEnv();
  return process.env.CRON_SECRET || null;
}
