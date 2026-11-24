/**
 * RFC 6749 §5.2 error responses for the OAuth endpoints. Pure: no I/O.
 * Error descriptions are FIXED strings chosen by us; never echo client-supplied values (they may reach logs or other clients).
 */
export type OAuthErrorCode =
  | 'invalid_request' | 'invalid_client' | 'invalid_grant' | 'unauthorized_client' | 'unsupported_grant_type'
  | 'invalid_scope' | 'invalid_target' | 'invalid_redirect_uri' | 'invalid_client_metadata'
  | 'access_denied' | 'server_error' | 'temporarily_unavailable';

export class OAuthError extends Error {
  constructor(readonly code: OAuthErrorCode, readonly description: string, readonly status = 400) {
    super(`${code}: ${description}`);
    this.name = 'OAuthError';
  }
}

export const NO_STORE_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
};

export function oauthErrorResponse(err: OAuthError, extraHeaders: Record<string, string> = {}): Response {
  return Response.json({ error: err.code, error_description: err.description }, { status: err.status, headers: { ...NO_STORE_HEADERS, ...extraHeaders } });
}

/** Anything that is not an OAuthError becomes a generic server_error: no internal detail leaks to the client. */
export function toOAuthError(e: unknown): OAuthError {
  return e instanceof OAuthError ? e : new OAuthError('server_error', 'The server could not complete the request.', 503);
}
