/**
 * MCP Tool Handlers Implementation (Phase 4.2).
 *
 * Implements execution handlers for the metadata-only MCP tools (list_teams plus the 6 below):
 * 1. list_developers
 * 2. developer_activity
 * 3. list_sessions
 * 4. session_details
 * 5. search_prompt_metadata
 * 6. prompt_metadata_batch
 *
 * Rules:
 *  - Principal and scope derived strictly from McpToolContext (AsyncLocalStorage).
 *  - Tool arguments can never override identity. The optional `teamId` only selects the team for an All-teams admin; a team admin's own team always applies.
 *  - Uses getReaderPool() and sessionSecret() to configure underlying services.
 *  - Errors formatted safely via formatToolError.
 */
import type { McpToolContext } from '../context';
import type { McpPool } from '../db';
import { getReaderPool } from '../data/db';
import { scopeFromPrincipal } from '../data/scope';
import { dataError } from '../data/errors';
import { listTeams } from '../data/teams';
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

const TEAM_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Splits the optional `teamId` off the tool arguments (the request parsers stay strict about every other key). */
function splitTeam(args: unknown): { teamId: string | null; rest: unknown } {
  if (args !== null && typeof args === 'object' && !Array.isArray(args) && Object.prototype.hasOwnProperty.call(args, 'teamId')) {
    const { teamId, ...rest } = args as Record<string, unknown>;
    if (teamId === undefined || teamId === null) return { teamId: null, rest };
    if (typeof teamId !== 'string' || !TEAM_UUID_RE.test(teamId)) throw dataError('invalid_argument');
    return { teamId: teamId.toLowerCase(), rest };
  }
  return { teamId: null, rest: args };
}

export async function executeListTeams(
  ctx: McpToolContext,
  args: unknown,
  deps: ToolHandlerDeps = {}
): Promise<McpToolCallResult> {
  try {
    const pool = (deps.pool ?? getReaderPool)();
    return formatToolResult(await listTeams({ pool, tokenHash: ctx.principal.tokenHash }, args));
  } catch (err) {
    return formatToolError(err);
  }
}

export async function executeListDevelopers(
  ctx: McpToolContext,
  args: unknown,
  deps: ToolHandlerDeps = {}
): Promise<McpToolCallResult> {
  try {
    const pool = (deps.pool ?? getReaderPool)();
    const secret = (deps.secret ?? resolveSecret)();
    const { teamId, rest } = splitTeam(args);
    const scope = scopeFromPrincipal(ctx.principal, teamId);

    const result = await listDevelopers({ pool, scope, secret }, rest);
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
    const { teamId, rest } = splitTeam(args);
    const scope = scopeFromPrincipal(ctx.principal, teamId);
    const now = (deps.now ?? (() => new Date()))();

    const result = await getDeveloperActivity({ pool, scope }, rest, now);
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
    const { teamId, rest } = splitTeam(args);
    const scope = scopeFromPrincipal(ctx.principal, teamId);
    const now = (deps.now ?? (() => new Date()))();

    const result = await listSessions({ pool, scope, secret }, rest, now);
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
    const { teamId, rest } = splitTeam(args);
    const scope = scopeFromPrincipal(ctx.principal, teamId);

    const result = await getSessionDetails({ pool, scope, secret }, rest);
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
    const { teamId, rest } = splitTeam(args);
    const scope = scopeFromPrincipal(ctx.principal, teamId);
    const now = (deps.now ?? (() => new Date()))();

    const result = await searchPromptMetadata({ pool, scope, secret }, rest, now);
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
    const { teamId, rest } = splitTeam(args);
    const scope = scopeFromPrincipal(ctx.principal, teamId);

    const result = await getPromptMetadataBatch({ pool, scope, secret }, rest);
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
  list_teams: executeListTeams,
  list_developers: executeListDevelopers,
  developer_activity: executeDeveloperActivity,
  list_sessions: executeListSessions,
  session_details: executeSessionDetails,
  search_prompt_metadata: executeSearchPromptMetadata,
  prompt_metadata_batch: executePromptMetadataBatch,
});
