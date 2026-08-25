/**
 * Auth helpers: API key generation/hashing, admin token (stateless HMAC),
 * and cookie parsing. All secrets come from env vars — never hardcoded.
 */
import crypto from 'node:crypto';
import { adminPassword, sessionSecret } from './env';
import { queryCol, setDocById } from './db';

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

  // Look up the member_key doc
  const keyDocs = await queryCol<{
    member_id: string;
    revoked_at: string | null;
  }>('member_keys', [
    { type: 'where', field: 'key_hash', op: '==', value: keyHash },
    { type: 'limit', n: 1 },
  ]);

  const keyDoc = keyDocs[0];
  if (!keyDoc || keyDoc.revoked_at) return null;

  // Look up the member doc
  const memberDocs = await queryCol<{
    team_id: string | null;
    display_name: string;
    role: string;
  }>('members', [
    { type: 'where', field: '__name__', op: '==', value: keyDoc.member_id },
    { type: 'limit', n: 1 },
  ]);

  // Firestore doesn't support __name__ in queryCol — fetch directly
  const { getDocById } = await import('./db');
  const memberDoc = await getDocById('members', keyDoc.member_id);
  if (!memberDoc) return null;

  // Resolve team_id: prefer team_members junction, fall back to member.team_id
  const teamMemberDocs = await queryCol<{ team_id: string }>('team_members', [
    { type: 'where', field: 'member_id', op: '==', value: keyDoc.member_id },
    { type: 'orderBy', field: 'created_at', direction: 'asc' },
    { type: 'limit', n: 1 },
  ]);
  const teamId = teamMemberDocs[0]?.team_id ?? memberDoc.team_id ?? null;

  // Update last_used_at
  await setDocById('member_keys', keyDoc.id, { last_used_at: new Date().toISOString() }, true);

  return {
    member_id: keyDoc.member_id,
    team_id: teamId as string,
    display_name: memberDoc.display_name as string,
    role: memberDoc.role as string,
  };
}

/** Issue admin session token (stateless HMAC). */
export function issueAdminToken(): string {
  const secret = sessionSecret();
  const password = adminPassword();
  if (!password) throw new Error('ADMIN_PASSWORD is not configured');
  return crypto.createHmac('sha256', secret).update(`admin:${password}`).digest('hex');
}

/** Verify admin token using timing-safe comparison. */
export function verifyAdminToken(token: string | null | undefined): boolean {
  if (!token) return false;
  try {
    const expected = issueAdminToken();
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Parse admin token from Cookie header string. */
export function adminTokenFromCookie(cookieHeader: string | undefined | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === 'team_admin') return decodeURIComponent(v || '');
  }
  return null;
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
