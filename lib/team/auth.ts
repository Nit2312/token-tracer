/**
 * Auth helpers: API key generation/hashing, admin token (stateless HMAC),
 * and cookie parsing. All secrets come from env vars — never hardcoded.
 */
import crypto from 'node:crypto';
import { adminPassword } from './env';
import { query } from './db';

const KEY_PREFIX = 'av_live_';

/** Hash an API key for storage (SHA-256, hex). */
export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/** Generate a new member ingest key. */
export function generateApiKey(): string {
  return `${KEY_PREFIX}${crypto.randomBytes(24).toString('base64url')}`;
}

/** Resolve member + team from Bearer token. */
export async function memberFromAuthHeader(authHeader: string | undefined | null) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const key = authHeader.slice(7).trim();
  if (!key) return null;
  const keyHash = hashApiKey(key);
  const { rows } = await query(
    `SELECT m.id AS member_id,
            COALESCE(
              (SELECT tm.team_id 
               FROM team_members tm 
               WHERE tm.member_id = m.id 
               ORDER BY tm.created_at ASC 
               LIMIT 1),
              m.team_id
            ) AS team_id,
            m.display_name, m.role
     FROM member_keys k
     JOIN members m ON m.id = k.member_id
     WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
    [keyHash],
  );
  if (!rows[0]) return null;
  await query('UPDATE member_keys SET last_used_at = now() WHERE key_hash = $1', [keyHash]);
  return rows[0] as { member_id: string; team_id: string; display_name: string; role: string };
}

/** Check admin password at login (timing-safe). */
export function verifyAdminPassword(password: string | undefined | null): boolean {
  const expected = adminPassword();
  if (!expected || !password) return false;
  try {
    const a = crypto.createHash('sha256').update(password).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
