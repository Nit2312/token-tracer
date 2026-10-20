import 'server-only';
/**
 * Persistence for MFA (TOTP secrets, replay protection) and login throttling.
 * Tables are created on first use so no manual migration is needed.
 */
import { getPool } from '@/lib/team/db';
import { decryptSecret, encryptSecret, generateTotpSecret } from './totp';

let ready: Promise<void> | null = null;

function ensureTables(): Promise<void> {
  if (!ready) {
    ready = getPool()
      .query(
        `CREATE TABLE IF NOT EXISTS auth_totp (
           subject      TEXT PRIMARY KEY,
           secret_enc   TEXT,
           confirmed    BOOLEAN NOT NULL DEFAULT false,
           last_step    BIGINT NOT NULL DEFAULT 0,
           created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
           updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
         );
         CREATE TABLE IF NOT EXISTS auth_throttle (
           key          TEXT PRIMARY KEY,
           fail_count   INT NOT NULL DEFAULT 0,
           locked_until TIMESTAMPTZ,
           updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
         );`,
      )
      .then(() => undefined)
      .catch((err) => {
        ready = null;
        throw err;
      });
  }
  return ready;
}

// ── MFA ─────────────────────────────────────────────────────────────────────

/** Env-configured secrets for the two built-in accounts. DB users store theirs in auth_totp. */
function envSecretFor(subject: string): string | null {
  if (subject === 'env:superadmin') return process.env.SUPERADMIN_TOTP_SECRET || null;
  if (subject === 'env:team') return process.env.ADMIN_TOTP_SECRET || null;
  return null;
}

export function isEnvSubject(subject: string): boolean {
  return subject.startsWith('env:');
}

export interface MfaState {
  /** Secret to verify against, or null if none is set up yet. */
  secret: string | null;
  /** True when the account has a confirmed authenticator. */
  enrolled: boolean;
}

export async function getMfaState(subject: string): Promise<MfaState> {
  if (isEnvSubject(subject)) {
    const secret = envSecretFor(subject);
    return { secret, enrolled: Boolean(secret) };
  }
  await ensureTables();
  const { rows } = await getPool().query('SELECT secret_enc, confirmed FROM auth_totp WHERE subject = $1', [subject]);
  const row = rows[0];
  if (!row?.secret_enc) return { secret: null, enrolled: false };
  return { secret: decryptSecret(row.secret_enc), enrolled: Boolean(row.confirmed) };
}

/** Start (or restart) enrollment for a DB user. Never overwrites an already-confirmed secret. */
export async function beginEnrollment(subject: string): Promise<string> {
  await ensureTables();
  const secret = generateTotpSecret();
  const { rows } = await getPool().query(
    `INSERT INTO auth_totp (subject, secret_enc, confirmed) VALUES ($1, $2, false)
     ON CONFLICT (subject) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, last_step = 0, updated_at = now()
     WHERE auth_totp.confirmed = false
     RETURNING subject`,
    [subject, encryptSecret(secret)],
  );
  if (!rows.length) throw new Error('already enrolled');
  return secret;
}

export async function confirmEnrollment(subject: string): Promise<void> {
  await ensureTables();
  await getPool().query('UPDATE auth_totp SET confirmed = true, updated_at = now() WHERE subject = $1', [subject]);
}

/** Atomically claim a time step. Returns false if this step (or a later one) was already used — i.e. a replayed code. */
export async function claimStep(subject: string, step: number): Promise<boolean> {
  await ensureTables();
  const { rowCount } = await getPool().query(
    `INSERT INTO auth_totp (subject, last_step) VALUES ($1, $2)
     ON CONFLICT (subject) DO UPDATE SET last_step = EXCLUDED.last_step, updated_at = now()
     WHERE auth_totp.last_step < EXCLUDED.last_step`,
    [subject, step],
  );
  return (rowCount ?? 0) > 0;
}

/** Remove a DB user's authenticator so they re-enroll on next login (superadmin action). */
export async function resetMfa(subject: string): Promise<void> {
  await ensureTables();
  await getPool().query('DELETE FROM auth_totp WHERE subject = $1', [subject]);
}

// ── Throttling ──────────────────────────────────────────────────────────────

export interface ThrottleRule {
  key: string;
  /** Failures within the window that trigger a lock. */
  max: number;
}

const WINDOW_MIN = 15;
const LOCK_MIN = 15;

/** Returns seconds remaining if any key is currently locked, else 0. */
export async function lockedForSeconds(keys: string[]): Promise<number> {
  await ensureTables();
  const { rows } = await getPool().query(
    `SELECT EXTRACT(EPOCH FROM (MAX(locked_until) - now()))::int AS secs
     FROM auth_throttle WHERE key = ANY($1::text[]) AND locked_until > now()`,
    [keys],
  );
  return Math.max(0, Number(rows[0]?.secs || 0));
}

export async function recordFailure(rules: ThrottleRule[]): Promise<void> {
  await ensureTables();
  for (const r of rules) {
    await getPool().query(
      `INSERT INTO auth_throttle (key, fail_count, updated_at) VALUES ($1, 1, now())
       ON CONFLICT (key) DO UPDATE SET
         fail_count = CASE WHEN auth_throttle.updated_at < now() - make_interval(mins => ${WINDOW_MIN}) THEN 1 ELSE auth_throttle.fail_count + 1 END,
         updated_at = now(),
         locked_until = CASE
           WHEN (CASE WHEN auth_throttle.updated_at < now() - make_interval(mins => ${WINDOW_MIN}) THEN 1 ELSE auth_throttle.fail_count + 1 END) >= $2
           THEN now() + make_interval(mins => ${LOCK_MIN})
           ELSE auth_throttle.locked_until END`,
      [r.key, r.max],
    );
  }
}

export async function clearFailures(keys: string[]): Promise<void> {
  await ensureTables();
  await getPool().query('DELETE FROM auth_throttle WHERE key = ANY($1::text[])', [keys]);
}

/** Standard rule set for a login attempt by `username` from `ip`. */
export function loginRules(username: string, ip: string): ThrottleRule[] {
  const u = username.toLowerCase().slice(0, 80);
  return [
    { key: `ip:${ip}`, max: 20 },          // one address hammering many accounts
    { key: `user-ip:${u}|${ip}`, max: 5 }, // classic guessing from one place
    { key: `user:${u}`, max: 30 },         // distributed guessing against one account
  ];
}
