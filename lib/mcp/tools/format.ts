/**
 * MCP Tool Output Formatting (Phase 4.3).
 *
 * Formats tool results into standard MCP content blocks:
 * `{ content: [{ type: 'text', text: JSON.stringify(data) }] }`
 *
 * Guarantees:
 * - Checks deep metadata validity via assertMetadataOnly before serialization.
 * - Validates UTF-8 byte budget (24 KiB).
 * - Translates errors into clean MCP JSON-RPC format with safe error codes.
 * - Never returns stack traces, SQL errors, credentials, or token hashes.
 */
import { assertMetadataOnly } from '../data/output';
import { RESPONSE_BYTE_BUDGET } from '../data/limits';
import { DataError, isDataError } from '../data/errors';

export interface McpTextContent {
  readonly type: 'text';
  readonly text: string;
}

export interface McpToolCallResult {
  readonly content: McpTextContent[];
  readonly isError?: boolean;
  [key: string]: unknown;
}

/**
 * Format a successful data payload into an MCP tool result.
 */
export function formatToolResult(data: unknown): McpToolCallResult {
  // Ensure the outgoing data is strictly metadata
  assertMetadataOnly(data);

  const serialized = JSON.stringify(data);
  const bytes = Buffer.byteLength(serialized, 'utf8');

  if (bytes > RESPONSE_BYTE_BUDGET) {
    // Fails closed if individual service output somehow exceeded budget
    throw new DataError('limit_exceeded');
  }

  return {
    content: [{ type: 'text', text: serialized }],
  };
}

/**
 * Safe mapping of data errors and unexpected exceptions into MCP error responses.
 */
export function formatToolError(error: unknown): McpToolCallResult {
  let message = 'An internal error occurred.';

  if (isDataError(error)) {
    switch (error.code) {
      case 'not_found':
        message = 'The requested resource was not found.';
        break;
      case 'invalid_argument':
        message = 'Invalid arguments supplied.';
        break;
      case 'team_required':
        message = 'Pass teamId to choose a team (use list_teams to see them).';
        break;
      case 'limit_exceeded':
        message = 'The request exceeded allowed limits or size budget.';
        break;
      case 'window_too_large':
        message = 'The requested time window exceeds the 7-day maximum.';
        break;
      case 'window_out_of_range':
        message = 'The requested time window exceeds the maximum allowed lookback.';
        break;
      case 'cursor_invalid':
        message = 'The provided pagination cursor is invalid or expired.';
        break;
      case 'unavailable':
        message = 'The service is temporarily unavailable. Please retry.';
        break;
      case 'text_not_available':
        message = 'Prompt text is not available.';
        break;
      case 'internal':
      default:
        message = 'An internal error occurred.';
        break;
    }
  }

  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: message,
          code: isDataError(error) ? error.code : 'internal_error',
        }),
      },
    ],
  };
}
