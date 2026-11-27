/**
 * Prompts data service (P3-5).
 * Invokes `mcp_data.search_prompt_metadata` and `mcp_data.prompt_metadata_batch` via reader pool.
 */
import type pg from 'pg';
import { withReaderTx } from './db';
import { encodeCursor, decodeCursor, type CursorPosition } from './cursor';
import { decodeRef } from './refs';
import { packWithinBudget } from './limits';
import {
  assertMetadataOnly,
  toPromptMetadata,
  type PromptMetadata,
  type Page,
} from './output';
import {
  parsePromptMetadataSearchRequest,
  parsePromptBatchRequest,
  type PromptMetadataSearchRequest,
  type PromptBatchRequest,
} from './requests';
import { assertScope, scopeDbArgs, type DataScope } from './scope';

export interface PromptServicesConfig {
  readonly pool: pg.Pool;
  readonly scope: DataScope;
  readonly secret: string;
}

export async function searchPromptMetadata(
  config: PromptServicesConfig,
  input: unknown,
  now?: Date
): Promise<Page<PromptMetadata>> {
  assertScope(config.scope);
  const req: PromptMetadataSearchRequest = parsePromptMetadataSearchRequest(input, now);

  const filtersFingerprint = {
    window: { from: req.window.from.toISOString(), to: req.window.to.toISOString() },
    developerId: req.filters.developerId,
    intents: req.filters.intents,
    hasCodeBlock: req.filters.hasCodeBlock,
    hasFilePath: req.filters.hasFilePath,
    hasTraceback: req.filters.hasTraceback,
    minChars: req.filters.minChars,
    maxChars: req.filters.maxChars,
    tool: req.filters.tool,
    model: req.filters.model,
  };

  let afterTs: string | null = null;
  let afterId: string | null = null;

  if (req.cursor) {
    const pos = decodeCursor('prompts', req.cursor, filtersFingerprint, {
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
      `SELECT prompt_id, session_uuid, member_id, turn_index, created_at, tool, model,
              prompt_char_len, has_code_block, has_file_path, has_traceback, intent_category,
              answer_input_tokens, answer_output_tokens, answer_cache_read_tokens, answer_cache_write_tokens
         FROM mcp_data.search_prompt_metadata(
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
         )`,
      [
        tokenHash,
        req.filters.developerId,
        req.window.from.toISOString(),
        req.window.to.toISOString(),
        req.filters.intents.length > 0 ? req.filters.intents : null,
        req.filters.hasCodeBlock,
        req.filters.hasFilePath,
        req.filters.hasTraceback,
        req.filters.minChars,
        req.filters.maxChars,
        req.filters.tool,
        req.filters.model,
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
    toPromptMetadata(r, { scope: config.scope, secret: config.secret })
  );

  const packed = packWithinBudget(rawItems);
  const finalItems = packed.items;
  const truncated = packed.truncated;

  let nextCursor: string | null = null;
  if (finalItems.length > 0) {
    const lastRowIndex = finalItems.length - 1;
    if (truncated || hasMore) {
      const lastRow = pageRows[lastRowIndex];
      const pos: CursorPosition = {
        t: String(lastRow.created_at ?? ''),
        i: String(lastRow.prompt_id),
      };
      nextCursor = encodeCursor('prompts', pos, filtersFingerprint, {
        scope: config.scope,
        secret: config.secret,
      }, now);
    }
  }

  const result: Page<PromptMetadata> = {
    items: finalItems,
    nextCursor,
    truncated,
  };

  assertMetadataOnly(result);
  return result;
}

export async function getPromptMetadataBatch(
  config: PromptServicesConfig,
  input: unknown
): Promise<readonly PromptMetadata[]> {
  assertScope(config.scope);
  const req: PromptBatchRequest = parsePromptBatchRequest(input);

  // Decode each sealed reference to its bigint sequence id
  const promptIds = req.promptRefs.map((ref) =>
    decodeRef('prompt', ref, { scope: config.scope, secret: config.secret })
  );

  const { tokenHash, teamId } = scopeDbArgs(config.scope);

  const rows = await withReaderTx(config.pool, async (client) => {
    const res = await client.query(
      `SELECT prompt_id, session_uuid, member_id, turn_index, created_at, tool, model,
              prompt_char_len, has_code_block, has_file_path, has_traceback, intent_category,
              answer_input_tokens, answer_output_tokens, answer_cache_read_tokens, answer_cache_write_tokens
         FROM mcp_data.prompt_metadata_batch($1, $2, $3)`,
      [tokenHash, promptIds, teamId]
    );
    return res.rows;
  });

  const rawItems = rows.map((r) =>
    toPromptMetadata(r, { scope: config.scope, secret: config.secret })
  );

  const packed = packWithinBudget(rawItems);
  const items = packed.items;

  assertMetadataOnly(items);
  return items;
}
