/**
 * Error text that is safe to return to a client. Raw exception messages from the
 * database driver or runtime can contain hostnames, SQL, table/column names or
 * connection details, so in production only a generic message leaves the server
 * (the full error is still logged server-side by each route).
 */
export function publicError(err: unknown): string {
  if (process.env.NODE_ENV === 'production') return 'Internal server error';
  return String((err as { message?: string } | null)?.message || err);
}
