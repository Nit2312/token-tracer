/**
 * MCP Tool Handlers Implementation (Phase 4.2).
 *
 * Implements execution handlers for all 6 metadata-only MCP tools:
 * 1. list_developers
 * 2. developer_activity
 * 3. list_sessions
 * 4. session_details
 * 5. search_prompt_metadata
 * 6. prompt_metadata_batch
 *
 * Rules:
 *  - Principal and scope derived strictly from McpToolContext (AsyncLocalStorage).
 *  - Tool arguments can NEVER override or specify teamId or userId.
 *  - Uses getReaderPool() and sessionSecret() to configure underlying services.
 *  - Errors formatted safely via formatToolError.
 */
import type { McpToolContext } from '../context';
import type { McpPool } from '../db';
import { getReaderPool } from '../data/db';
import { scopeFromPrincipal } from '../data/scope';
import { listDevelopers } from '../data/developers';
import { getDeveloperActivity } from '../data/activity';
import { listSessions, getSessionDetails } from '../data/sessions';
import { searchPromptMetadata, getPromptMetadataBatch } from '../data/prompts';
import { formatToolResult, formatToolError, type McpToolCallResult } from './format';

export interface ToolHandlerDeps {
  readonly pool?: () => McpPool;
  readonly secret?: () => string;
  readonly now?: () => Date;
}

function resolveSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    throw new Error('SESSION_SECRET is not configured or too short.');
  }
  return s;
}

export async function executeListDevelopers(
  ctx: McpToolContext,
  args: unknown,
  deps: ToolHandlerDeps = {}
): Promise<McpToolCallResult> {
  try {
    const pool = (deps.pool ?? getReaderPool)();
    const secret = (deps.secret ?? resolveSecret)();
    const scope = scopeFromPrincipal(ctx.principal);

    const result = await listDevelopers({ pool, scope, secret }, args);
    return formatToolResult(result);
  } catch (err) {
    return formatToolError(err);
  }
}

export async function executeDeveloperActivity(
  ctx: McpToolContext,
  args: unknown,
  deps: ToolHandlerDeps = {}
): Promise<McpToolCallResult> {
  try {
    const pool = (deps.pool ?? getReaderPool)();
    const scope = scopeFromPrincipal(ctx.principal);
    const now = (deps.now ?? (() => new Date()))();

    const result = await getDeveloperActivity({ pool, scope }, args, now);
    return formatToolResult(result);
  } catch (err) {
    return formatToolError(err);
  }
}

export async function executeListSessions(
  ctx: McpToolContext,
  args: unknown,
  deps: ToolHandlerDeps = {}
): Promise<McpToolCallResult> {
  try {
    const pool = (deps.pool ?? getReaderPool)();
    const secret = (deps.secret ?? resolveSecret)();
    const scope = scopeFromPrincipal(ctx.principal);
    const now = (deps.now ?? (() => new Date()))();

    const result = await listSessions({ pool, scope, secret }, args, now);
    return formatToolResult(result);
  } catch (err) {
    return formatToolError(err);
  }
}

export async function executeSessionDetails(
  ctx: McpToolContext,
  args: unknown,
  deps: ToolHandlerDeps = {}
): Promise<McpToolCallResult> {
  try {
    const pool = (deps.pool ?? getReaderPool)();
    const secret = (deps.secret ?? resolveSecret)();
    const scope = scopeFromPrincipal(ctx.principal);

    const result = await getSessionDetails({ pool, scope, secret }, args);
    return formatToolResult(result);
  } catch (err) {
    return formatToolError(err);
  }
}

export async function executeSearchPromptMetadata(
  ctx: McpToolContext,
  args: unknown,
  deps: ToolHandlerDeps = {}
): Promise<McpToolCallResult> {
  try {
    const pool = (deps.pool ?? getReaderPool)();
    const secret = (deps.secret ?? resolveSecret)();
    const scope = scopeFromPrincipal(ctx.principal);
    const now = (deps.now ?? (() => new Date()))();

    const result = await searchPromptMetadata({ pool, scope, secret }, args, now);
    return formatToolResult(result);
  } catch (err) {
    return formatToolError(err);
  }
}

export async function executePromptMetadataBatch(
  ctx: McpToolContext,
  args: unknown,
  deps: ToolHandlerDeps = {}
): Promise<McpToolCallResult> {
  try {
    const pool = (deps.pool ?? getReaderPool)();
    const secret = (deps.secret ?? resolveSecret)();
    const scope = scopeFromPrincipal(ctx.principal);

    const result = await getPromptMetadataBatch({ pool, scope, secret }, args);
    return formatToolResult(result);
  } catch (err) {
    return formatToolError(err);
  }
}

export type ToolExecutor = (
  ctx: McpToolContext,
  args: unknown,
  deps?: ToolHandlerDeps
) => Promise<McpToolCallResult>;

export const TOOL_EXECUTORS: Readonly<Record<string, ToolExecutor>> = Object.freeze({
  list_developers: executeListDevelopers,
  developer_activity: executeDeveloperActivity,
  list_sessions: executeListSessions,
  session_details: executeSessionDetails,
  search_prompt_metadata: executeSearchPromptMetadata,
  prompt_metadata_batch: executePromptMetadataBatch,
});
