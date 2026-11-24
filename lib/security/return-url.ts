/**
 * Safe post-login return URL (open-redirect defence). Pure: no I/O. Used for the OAuth consent flow only.
 *
 * The client supplies `returnTo`; we never trust it. It is accepted only if it is a same-site RELATIVE path that is exactly
 * /oauth/authorize (plus a query string), in canonical form. The value we return is RE-SERIALISED from the parsed URL, never the
 * raw input. Anything else → null, and the caller falls back to the normal post-login destination.
 */
export const RETURN_TO_ALLOWED_PATH = '/oauth/authorize';
export const RETURN_TO_MAX_LENGTH = 2048;

export function safeReturnTo(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > RETURN_TO_MAX_LENGTH) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  if (/[\u0000-\u001f\u007f\\\s]/.test(value)) return null; // control chars, whitespace, backslash
  if (value.includes('#')) return null;
  // The RAW path must already be exactly the allowed path: this rejects dot-segments (/oauth/./authorize), encoded variants
  // (%2e, %2f, %5c), doubled or trailing slashes and case tricks, none of which the URL parser would otherwise preserve visibly.
  if (value.split('?')[0] !== RETURN_TO_ALLOWED_PATH) return null;
  let u: URL;
  try { u = new URL(value, 'https://return-url.invalid'); } catch { return null; }
  if (u.origin !== 'https://return-url.invalid') return null;
  if (u.pathname !== RETURN_TO_ALLOWED_PATH) return null;
  if (u.hash) return null;
  return `${u.pathname}${u.search}`;
}
