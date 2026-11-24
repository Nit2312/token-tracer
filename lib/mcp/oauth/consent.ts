/**
 * Signed, short-lived consent token: binds ONE approval to the exact request the user was shown (client, redirect URI, PKCE challenge,
 * scope, state, resource), to the user, and to that user's current login session (so signing out/in invalidates it). Pure: the secret is passed in.
 *
 * It is signed with a key DERIVED from the session secret with a distinct label, and carries no `issuedAt`/`role` fields: a consent token can
 * never be mistaken for a session cookie (session-token.ts accepts any object that was signed with the raw secret and has an `issuedAt`).
 * Replay: a token may be submitted more than once within its 5 minutes by the same logged-in admin; each submission yields another code for the
 * SAME client, redirect URI and PKCE challenge (useless without the verifier), so single-use is not enforced.
 */
import crypto from 'node:crypto';

export const CONSENT_TTL_MS = 5 * 60 * 1000;

export interface ConsentClaims {
  uid: string;          // user id (UUID)
  sia: number;          // session issuedAt the consent was shown to
  cid: string;          // client_id
  ru: string;           // redirect_uri exactly as requested
  cc: string;           // PKCE code_challenge
  sc: string;           // scope
  st: string | null;    // state
  rs: string;           // resource
  ex: number;           // expiry (ms epoch)
}

const derivedKey = (secret: string): Buffer => crypto.createHmac('sha256', secret).update('tt-mcp-consent-v1').digest();
const mac = (b64: string, secret: string): string => crypto.createHmac('sha256', derivedKey(secret)).update(`consent.${b64}`).digest('base64url');

export function signConsent(claims: Omit<ConsentClaims, 'ex'>, secret: string, now = Date.now()): string {
  const b64 = Buffer.from(JSON.stringify({ ...claims, ex: now + CONSENT_TTL_MS } satisfies ConsentClaims)).toString('base64url');
  return `${b64}.${mac(b64, secret)}`;
}

const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

export function verifyConsent(token: unknown, secret: string, now = Date.now()): ConsentClaims | null {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const b64 = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(mac(b64, secret));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let c: Partial<ConsentClaims>;
  try { c = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')); } catch { return null; }
  if (!c || typeof c !== 'object') return null;
  if (!isStr(c.uid, 64) || !isStr(c.cid, 64) || !isStr(c.ru, 2048) || !isStr(c.cc, 64) || !isStr(c.sc, 64) || !isStr(c.rs, 2048)) return null;
  if (typeof c.sia !== 'number' || typeof c.ex !== 'number') return null;
  if (c.st !== null && !isStr(c.st, 512)) return null;
  if (c.ex < now || c.ex - now > CONSENT_TTL_MS + 1000) return null;
  return c as ConsentClaims;
}
