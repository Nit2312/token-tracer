/**
 * Sessions data service (P3-5).
 * Invokes `mcp_data.list_sessions` and `mcp_data.session_details` via reader pool.
 */
import type pg from 'pg';
import { withReaderTx } from './db';
import { encodeCursor, decodeCursor, type CursorPosition } from './cursor';
import { dataError } from './errors';
import { decodeRef } from './refs';
import { packWithinBudget } from './limits';
import {
  assertMetadataOnly,
  toSessionSummary,
  toSessionDetails,
  type SessionSummary,
  type SessionDetails,
  type Page,
} from './output';
import {
  parseListSessionsRequest,
  parseSessionDetailsRequest,
  type ListSessionsRequest,
  type SessionDetailsRequest,
} from './requests';
import { assertScope, scopeDbArgs, type DataScope } from './scope';

export interface SessionsServicesConfig {
  readonly pool: pg.Pool;
  readonly scope: DataScope;
  readonly secret: string;
}

export async function listSessions(
  config: SessionsServicesConfig,
  input: unknown,
  now?: Date
): Promise<Page<SessionSummary>> {
  assertScope(config.scope);
  const req: ListSessionsRequest = parseListSessionsRequest(input, now);

  const filtersFingerprint = {
    developerId: req.developerId,
    window: { from: req.window.from.toISOString(), to: req.window.to.toISOString() },
    tool: req.tool,
    model: req.model,
  };

  let afterTs: string | null = null;
  let afterId: string | null = null;

  if (req.cursor) {
    const pos = decodeCursor('sessions', req.cursor, filtersFingerprint, {
      scope: config.scope,
      secret: config.secret,
    }, now);
    afterTs = pos.t;
    afterId = pos.i;
  }

  const probeLimit = req.limit + 1;
  const { tokenHash, teamId } = scopeDbArgs(config.scope);

  const rows = await withReaderTx(config.pool, async (client) => {
    const res = await client.query(
      `SELECT id, member_id, source, model, started_at, ended_at, activity_at,
              tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, api_cost, priced,
              edits, additions, deletions, changed_lines, files_touched, tool_calls, tool_errors,
              rework_loops, corrections, abandoned
         FROM mcp_data.list_sessions($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        tokenHash,
        req.developerId,
        req.window.from.toISOString(),
        req.window.to.toISOString(),
        req.tool,
        req.model,
        probeLimit,
        afterTs,
        afterId,
        teamId,
      ]
    );
    return res.rows;
  });

  const hasMore = rows.length > req.limit;
  const pageRows = hasMore ? rows.slice(0, req.limit) : rows;

  const rawItems = pageRows.map((r) =>
    toSessionSummary(r, { scope: config.scope, secret: config.secret })
  );

  const packed = packWithinBudget(rawItems);
  const finalItems = packed.items;
  const truncated = packed.truncated;

  let nextCursor: string | null = null;
  if (finalItems.length > 0) {
    const lastRowIndex = finalItems.length - 1;
    if (truncated || hasMore) {
      const lastRow = pageRows[lastRowIndex];
      // activity_at is the ordering timestamp used by list_sessions
      const ts = (lastRow.activity_at as string | undefined) ?? (lastRow.started_at as string);
      const pos: CursorPosition = { t: ts, i: String(lastRow.id) };
      nextCursor = encodeCursor('sessions', pos, filtersFingerprint, {
        scope: config.scope,
        secret: config.secret,
      }, now);
    }
  }

  const result: Page<SessionSummary> = {
    items: finalItems,
    nextCursor,
    truncated,
  };

  assertMetadataOnly(result);
  return result;
}

export async function getSessionDetails(
  config: SessionsServicesConfig,
  input: unknown
): Promise<SessionDetails> {
  assertScope(config.scope);
  const req: SessionDetailsRequest = parseSessionDetailsRequest(input);
  const sessionId = decodeRef('session', req.sessionRef, {
    scope: config.scope,
    secret: config.secret,
  });

  const { tokenHash, teamId } = scopeDbArgs(config.scope);

  const rows = await withReaderTx(config.pool, async (client) => {
    const res = await client.query(
      `SELECT id, member_id, source, model, started_at, ended_at, activity_at,
              tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, api_cost, priced,
              edits, additions, deletions, changed_lines, files_touched, tool_calls, tool_errors,
              rework_loops, corrections, abandoned, tools
         FROM mcp_data.session_details($1, $2, $3)`,
      [tokenHash, sessionId, teamId]
    );
    return res.rows;
  });

  if (rows.length === 0) {
    throw dataError('not_found');
  }

  const details = toSessionDetails(rows[0], rows[0].tools, {
    scope: config.scope,
    secret: config.secret,
  });

  assertMetadataOnly(details);
  return details;
}
