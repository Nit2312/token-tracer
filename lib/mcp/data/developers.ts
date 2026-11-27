/**
 * Developers data service (P3-5).
 * Invokes `mcp_data.list_developers(p_token, p_limit, p_after)` via reader pool.
 */
import type pg from 'pg';
import { withReaderTx } from './db';
import { encodeCursor, decodeCursor, type CursorPosition } from './cursor';
import { packWithinBudget } from './limits';
import { assertMetadataOnly, toDeveloperSummary, type DeveloperSummary, type Page } from './output';
import { parseListDevelopersRequest, type ListDevelopersRequest } from './requests';
import { assertScope, scopeDbArgs, type DataScope } from './scope';

export interface DeveloperServicesConfig {
  readonly pool: pg.Pool;
  readonly scope: DataScope;
  readonly secret: string;
}

export async function listDevelopers(
  config: DeveloperServicesConfig,
  input: unknown
): Promise<Page<DeveloperSummary>> {
  assertScope(config.scope);
  const req: ListDevelopersRequest = parseListDevelopersRequest(input);

  // Filters fingerprint for cursor binding (empty for listDevelopers)
  const filtersFingerprint = {};
  let afterId: string | null = null;

  if (req.cursor) {
    const pos = decodeCursor('developers', req.cursor, filtersFingerprint, {
      scope: config.scope,
      secret: config.secret,
    });
    afterId = pos.i;
  }

  // Request limit + 1 to probe for next page
  const probeLimit = req.limit + 1;
  const { tokenHash, teamId } = scopeDbArgs(config.scope);

  const rows = await withReaderTx(config.pool, async (client) => {
    const res = await client.query(
      `SELECT member_id, display_name, role FROM mcp_data.list_developers($1, $2, $3, $4)`,
      [tokenHash, probeLimit, afterId, teamId]
    );
    return res.rows;
  });

  const hasMore = rows.length > req.limit;
  const pageRows = hasMore ? rows.slice(0, req.limit) : rows;
  const rawItems = pageRows.map(toDeveloperSummary);

  // Budget packing
  const packed = packWithinBudget(rawItems);
  const finalItems = packed.items;
  const truncated = packed.truncated;

  let nextCursor: string | null = null;
  if (finalItems.length > 0) {
    if (truncated) {
      // Continuation cursor from the last packed item
      const lastItem = finalItems[finalItems.length - 1];
      const pos: CursorPosition = { t: '', i: lastItem.developerId };
      nextCursor = encodeCursor('developers', pos, filtersFingerprint, {
        scope: config.scope,
        secret: config.secret,
      });
    } else if (hasMore) {
      // Continuation cursor from the last item of the requested limit
      const lastItem = finalItems[finalItems.length - 1];
      const pos: CursorPosition = { t: '', i: lastItem.developerId };
      nextCursor = encodeCursor('developers', pos, filtersFingerprint, {
        scope: config.scope,
        secret: config.secret,
      });
    }
  }

  const result: Page<DeveloperSummary> = {
    items: finalItems,
    nextCursor,
    truncated,
  };

  assertMetadataOnly(result);
  return result;
}
