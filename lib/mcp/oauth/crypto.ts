import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Token, code and PKCE primitives. Pure: no I/O.
 * Secrets are 256-bit random values; only their SHA-256 digests are ever stored (a pepper adds nothing at this entropy).
 */
export const ACCESS_TOKEN_PREFIX = 'tt_at_';
export const REFRESH_TOKEN_PREFIX = 'tt_rt_';
export const AUTH_CODE_PREFIX = 'tt_ac_';
export const CLIENT_ID_PREFIX = 'tt_';

const b64url = (buf: Buffer): string => buf.toString('base64url');

/** `<prefix><43 base64url chars>` (256 bits). Prefixes make leaked values greppable by secret scanners. */
export function generateSecret(prefix: string): string {
  return prefix + b64url(randomBytes(32));
}

/** Public identifier (not a secret): 128 bits. */
export function generateClientId(): string {
  return CLIENT_ID_PREFIX + b64url(randomBytes(16));
}

export function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Shape check applied BEFORE any database lookup so garbage never reaches a query. */
export function looksLikeSecret(value: unknown, prefix: string): value is string {
  return typeof value === 'string' && value.length === prefix.length + 43 && value.startsWith(prefix) && /^[A-Za-z0-9_-]{43}$/.test(value.slice(prefix.length));
}

// RFC 7636: verifier = 43..128 unreserved chars; challenge (S256) = base64url(SHA-256(verifier)) = exactly 43 chars.
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

export const isValidCodeChallenge = (v: unknown): v is string => typeof v === 'string' && CHALLENGE_RE.test(v);
export const isValidCodeVerifier = (v: unknown): v is string => typeof v === 'string' && VERIFIER_RE.test(v);

export function s256Challenge(verifier: string): string {
  return b64url(createHash('sha256').update(verifier, 'ascii').digest());
}

/** Constant-time S256 verification. Anything malformed is simply false. */
export function verifyPkce(verifier: unknown, storedChallenge: string): boolean {
  if (!isValidCodeVerifier(verifier) || !isValidCodeChallenge(storedChallenge)) return false;
  const a = Buffer.from(s256Challenge(verifier));
  const b = Buffer.from(storedChallenge);
  return a.length === b.length && timingSafeEqual(a, b);
}
