/**
 * Error taxonomy of the MCP data layer (P3-1 contracts). Pure: no I/O.
 *
 * Every error carries ONLY a code; the message is a fixed string chosen here, never built from caller input, a database message or a stored value.
 * That keeps error text from becoming a side channel (an id, a filter value or a prompt fragment can never be echoed).
 * `not_found` is deliberately the single answer for "does not exist", "belongs to another team" and "reference could not be opened": an
 * attacker must not be able to tell those apart.
 */
export type DataErrorCode =
  | 'invalid_argument'   // malformed or unknown request field (including any attempt to send a text query)
  | 'window_too_large'   // the time window is longer than the fixed 7-day maximum
  | 'window_out_of_range' // the window starts before the lookback limit (14 days, or the shorter retention of the source)
  | 'limit_exceeded'     // a requested page or batch size is above the maximum
  | 'cursor_invalid'     // tampered, expired, wrong principal, wrong query
  | 'not_found'          // missing, other team's, or an undecodable reference — indistinguishable by design
  | 'text_not_available' // prompt text was requested while it is not enabled and approved
  | 'unavailable'        // the data service cannot be reached; callers may retry
  | 'internal';          // an invariant failed; never describes why

export const DATA_ERROR_MESSAGES: Readonly<Record<DataErrorCode, string>> = Object.freeze({
  invalid_argument: 'The request is not valid.',
  window_too_large: 'The time window is longer than the 7-day maximum.',
  window_out_of_range: 'The time window starts earlier than the data that is available.',
  limit_exceeded: 'A requested size is above the allowed maximum.',
  cursor_invalid: 'The page cursor is invalid or has expired.',
  not_found: 'Not found.',
  text_not_available: 'Prompt text is not available.',
  unavailable: 'The data service is temporarily unavailable.',
  internal: 'The request could not be completed.',
});

/** Codes that describe a problem with the caller's request (as opposed to the service). */
export const CLIENT_ERROR_CODES: ReadonlySet<DataErrorCode> = new Set<DataErrorCode>(['invalid_argument', 'window_too_large', 'window_out_of_range', 'limit_exceeded', 'cursor_invalid', 'not_found', 'text_not_available']);

export class DataError extends Error {
  readonly code: DataErrorCode;
  constructor(code: DataErrorCode) {
    super(DATA_ERROR_MESSAGES[code]); // fixed text only: there is intentionally no way to pass detail
    this.name = 'DataError';
    this.code = code;
  }
}

export const dataError = (code: DataErrorCode): DataError => new DataError(code);
export const isDataError = (e: unknown): e is DataError => e instanceof DataError;
/** Anything that is not already a DataError becomes a generic `internal` error: no message, stack or driver text is carried over. */
export const toDataError = (e: unknown): DataError => (isDataError(e) ? e : new DataError('internal'));
