/**
 * Authenticated encryption for opaque handles and cursors (P3-1 contract). Pure (node:crypto only).
 *
 * AES-256-GCM, key derived with HKDF-SHA256 from the server secret and a PURPOSE label, so a token sealed for one purpose cannot be opened for
 * another. The associated data binds the token to its context (team, user, query fingerprint): a token copied to another principal or reused for
 * another query fails authentication. Opaque to the client (contents, including any internal id, are not readable) and tamper-evident.
 * `openJson` returns null for ANY failure: callers map that to one uniform error.
 */
import crypto from 'node:crypto';

const SALT = 'tt-mcp-data-v1';

function deriveKey(secret: string, purpose: string): Buffer {
  if (typeof secret !== 'string' || secret.length < 16) throw new Error('sealing secret is missing or too short');
  return Buffer.from(crypto.hkdfSync('sha256', secret, SALT, purpose, 32));
}

export function sealJson(payload: Record<string, unknown>, purpose: string, aad: string, secret: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret, purpose), iv);
  cipher.setAAD(Buffer.from(`${purpose}|${aad}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

export function openJson(token: string, purpose: string, aad: string, secret: string): Record<string, unknown> | null {
  try {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
    const raw = Buffer.from(token, 'base64url');
    if (raw.byteLength < 12 + 16 + 2) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret, purpose), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${purpose}|${aad}`, 'utf8'));
    decipher.setAuthTag(raw.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    const parsed: unknown = JSON.parse(plain);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
