/** Small request helpers shared by the OAuth endpoints. No application imports, no logging of request data. */
import { hashIp } from './clients';
import { NO_STORE_HEADERS, OAuthError } from './errors';

/** Vercel sets x-real-ip / overwrites x-forwarded-for; the first x-forwarded-for entry is the client. Never trusted for authorization, only for abuse limits. */
export function clientIpKey(headers: Headers): string {
  const ip = headers.get('x-real-ip')?.trim() || headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
  return hashIp(ip) ?? 'unknown';
}

/** Browsers mark cross-site fetches; the OAuth back-channel endpoints are only ever called server-to-server or same-origin. Absent header = non-browser = allowed. */
export const isBrowserCrossSite = (headers: Headers): boolean => {
  const site = headers.get('sec-fetch-site');
  return !!site && site !== 'same-origin' && site !== 'none';
};

export const hasContentType = (headers: Headers, type: string): boolean =>
  (headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() === type;

/** Read at most `max` bytes of UTF-8 text; refuses oversized bodies without buffering them. */
export async function readLimitedText(req: Request, max: number): Promise<string> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > max) throw new OAuthError('invalid_request', 'Request body too large.', 413);
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); throw new OAuthError('invalid_request', 'Request body too large.', 413); }
    chunks.push(value);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks.map((c) => Buffer.from(c)))); }
  catch { throw new OAuthError('invalid_request', 'Request body is not valid UTF-8.'); }
}

/** application/x-www-form-urlencoded → single-valued map. A repeated parameter is a protocol error (RFC 6749 §3.2). */
export function parseForm(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of new URLSearchParams(text)) {
    if (out.has(k)) throw new OAuthError('invalid_request', 'Repeated request parameter.');
    out.set(k, v);
  }
  return out;
}

export const notFound = (): Response => new Response(null, { status: 404, headers: NO_STORE_HEADERS });
