/**
 * Tool schemas and metadata definitions (Phase 4.1).
 *
 * Defines the strict JSON Schema specifications for the six approved metadata-only MCP tools (plus list_teams):
 * 1. list_developers
 * 2. developer_activity
 * 3. list_sessions
 * 4. session_details
 * 5. search_prompt_metadata
 * 6. prompt_metadata_batch
 *
 * Rules:
 *  - Matches P3-1 request contracts and limits exactly.
 *  - additionalProperties: false on every object to prevent parameter smuggling.
 *  - Identity is derived server-side. The only client-chosen scope is the optional `teamId`, honoured solely for an All-teams admin and re-validated by the database.
 *  - Never accepts text/query/search parameters for prompts.
 *  - Limits and date windows bounded by literals.
 */
import { INTENT_CATEGORIES } from '../data/output';
import { PAGE_SIZES, BATCH_MAX } from '../data/limits';

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/**
 * Optional on every team-scoped tool. A team admin never needs it (their own team is used; naming a different one is refused).
 * An "All teams" admin must pass it: choose from list_teams. The database re-checks both rules.
 */
const TEAM_ID_PROPERTY = {
  type: 'string',
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
  description: 'Team to query. Only needed by an All-teams admin (see list_teams); team admins always get their own team.',
} as const;

export const LIST_TEAMS_TOOL: ToolDefinition = {
  name: 'list_teams',
  description: 'List the teams you can query (name, id and number of developers). An All-teams admin sees every team; a team admin sees their own.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

export const LIST_DEVELOPERS_TOOL: ToolDefinition = {
  name: 'list_developers',
  description:
    'List developers in the authenticated team. Supports keyset pagination with cursor and limit.',
  inputSchema: {
    type: 'object',
    properties: {
      teamId: TEAM_ID_PROPERTY,
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: PAGE_SIZES.developers.max,
        description: `Maximum number of developers to return per page (1-${PAGE_SIZES.developers.max}, default ${PAGE_SIZES.developers.default}).`,
      },
      cursor: {
        type: 'string',
        maxLength: 512,
        pattern: '^[A-Za-z0-9_-]{1,512}$',
        description: 'Opaque pagination cursor returned by a previous page.',
      },
    },
    additionalProperties: false,
  },
};

export const DEVELOPER_ACTIVITY_TOOL: ToolDefinition = {
  name: 'developer_activity',
  description:
    'Daily aggregated activity metrics for one team developer over a UTC date window (up to 7 days). Days are UTC. Today is included and is live (partial until the day ends). ' +
    'A session is counted IN FULL on the UTC day it ended, so a session that ran for several days adds its whole total to its last day. ' +
    'sessionsStartedEarlier and tokensInSessionsStartedEarlier show how much of a day\'s total comes from sessions that began on an earlier day: when they are large, the day\'s totals overstate what happened on that day, and you must say so. ' +
    'unpricedSessions counts sessions without a price (their cost is counted as 0, so cost can be understated). These three are null for older days served from the nightly rollup.',
  inputSchema: {
    type: 'object',
    properties: {
      teamId: TEAM_ID_PROPERTY,
      developerId: {
        type: 'string',
        format: 'uuid',
        pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
        description: 'UUID of the developer member within the team.',
      },
      from: {
        type: 'string',
        description: 'Start of the UTC date window (ISO-8601 string or YYYY-MM-DD date). Lookback limited to 14 days.',
      },
      to: {
        type: 'string',
        description: 'End of the UTC date window (ISO-8601 string or YYYY-MM-DD date, exclusive). Maximum span 7 days.',
      },
    },
    required: ['developerId'],
    additionalProperties: false,
  },
};

export const LIST_SESSIONS_TOOL: ToolDefinition = {
  name: 'list_sessions',
  description:
    'List sync sessions for the team with optional filtering by developer, tool, model, and date window (UTC). Results are ordered newest first. ' +
    'Token, cost and edit figures are the session\'s totals for its WHOLE life, not just the window: a session can have started days before startedAt/endedAt suggests a recent window. ' +
    'Compare startedAt with endedAt before presenting a session\'s totals as usage in a period, and say so when a session spans several days. Sessions with priced=false have no cost yet (cost shown as 0).',
  inputSchema: {
    type: 'object',
    properties: {
      teamId: TEAM_ID_PROPERTY,
      developerId: {
        type: 'string',
        format: 'uuid',
        pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
        description: 'Optional developer member UUID filter.',
      },
      from: {
        type: 'string',
        description: 'Start of the UTC date window (ISO-8601 string or YYYY-MM-DD date). Lookback limited to 14 days.',
      },
      to: {
        type: 'string',
        description: 'End of the UTC date window (ISO-8601 string or YYYY-MM-DD date, exclusive). Maximum span 7 days.',
      },
      tool: {
        type: 'string',
        maxLength: 64,
        pattern: '^[A-Za-z0-9_.:+/@-]{1,64}$',
        description: 'Optional tool identifier filter (e.g. "claude-code", "cursor").',
      },
      model: {
        type: 'string',
        maxLength: 64,
        pattern: '^[A-Za-z0-9_.:+/@-]{1,64}$',
        description: 'Optional model identifier filter (e.g. "claude-3-5-sonnet").',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: PAGE_SIZES.sessions.max,
        description: `Maximum sessions to return per page (1-${PAGE_SIZES.sessions.max}, default ${PAGE_SIZES.sessions.default}).`,
      },
      cursor: {
        type: 'string',
        maxLength: 512,
        pattern: '^[A-Za-z0-9_-]{1,512}$',
        description: 'Opaque pagination cursor returned by a previous page.',
      },
    },
    additionalProperties: false,
  },
};

export const SESSION_DETAILS_TOOL: ToolDefinition = {
  name: 'session_details',
  description:
    'Retrieve detailed metrics and tool call breakdown for a specific session using an opaque, sealed session reference. Figures are totals for the session\'s whole life (see startedAt and endedAt), not for any single day.',
  inputSchema: {
    type: 'object',
    properties: {
      teamId: TEAM_ID_PROPERTY,
      sessionRef: {
        type: 'string',
        maxLength: 256,
        description: 'Opaque sealed session handle previously returned in a session summary.',
      },
    },
    required: ['sessionRef'],
    additionalProperties: false,
  },
};

export const SEARCH_PROMPT_METADATA_TOOL: ToolDefinition = {
  name: 'search_prompt_metadata',
  description:
    'Search and filter prompt metadata across the team using structured filters (intent category, code block, traceback, character length). Strictly metadata only: does NOT accept free-text query strings or return prompt text.',
  inputSchema: {
    type: 'object',
    properties: {
      teamId: TEAM_ID_PROPERTY,
      developerId: {
        type: 'string',
        format: 'uuid',
        pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
        description: 'Optional developer member UUID filter.',
      },
      from: {
        type: 'string',
        description: 'Start of the UTC date window (ISO-8601 string or YYYY-MM-DD date). Lookback limited to 7 days.',
      },
      to: {
        type: 'string',
        description: 'End of the UTC date window (ISO-8601 string or YYYY-MM-DD date, exclusive). Maximum span 7 days.',
      },
      intents: {
        type: 'array',
        items: {
          type: 'string',
          enum: [...INTENT_CATEGORIES],
        },
        maxItems: INTENT_CATEGORIES.length,
        description: 'Filter by classified intent categories (e.g. "bug_fix", "feature", "refactor").',
      },
      hasCodeBlock: {
        type: 'boolean',
        description: 'Filter for prompts containing markdown code blocks.',
      },
      hasFilePath: {
        type: 'boolean',
        description: 'Filter for prompts referencing file paths.',
      },
      hasTraceback: {
        type: 'boolean',
        description: 'Filter for prompts containing stack traces or error logs.',
      },
      minChars: {
        type: 'integer',
        minimum: 0,
        maximum: 1_000_000,
        description: 'Minimum prompt character length.',
      },
      maxChars: {
        type: 'integer',
        minimum: 0,
        maximum: 1_000_000,
        description: 'Maximum prompt character length.',
      },
      tool: {
        type: 'string',
        maxLength: 64,
        pattern: '^[A-Za-z0-9_.:+/@-]{1,64}$',
        description: 'Optional tool identifier filter.',
      },
      model: {
        type: 'string',
        maxLength: 64,
        pattern: '^[A-Za-z0-9_.:+/@-]{1,64}$',
        description: 'Optional model identifier filter.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: PAGE_SIZES.prompts.max,
        description: `Maximum prompt records to return per page (1-${PAGE_SIZES.prompts.max}, default ${PAGE_SIZES.prompts.default}).`,
      },
      cursor: {
        type: 'string',
        maxLength: 512,
        pattern: '^[A-Za-z0-9_-]{1,512}$',
        description: 'Opaque pagination cursor returned by a previous page.',
      },
    },
    additionalProperties: false,
  },
};

export const PROMPT_METADATA_BATCH_TOOL: ToolDefinition = {
  name: 'prompt_metadata_batch',
  description:
    'Retrieve prompt metadata in bulk for up to 20 sealed prompt references.',
  inputSchema: {
    type: 'object',
    properties: {
      teamId: TEAM_ID_PROPERTY,
      promptRefs: {
        type: 'array',
        items: {
          type: 'string',
          maxLength: 256,
        },
        minItems: 1,
        maxItems: BATCH_MAX,
        description: `Array of 1 to ${BATCH_MAX} opaque sealed prompt handles.`,
      },
    },
    required: ['promptRefs'],
    additionalProperties: false,
  },
};

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze([
  LIST_TEAMS_TOOL,
  LIST_DEVELOPERS_TOOL,
  DEVELOPER_ACTIVITY_TOOL,
  LIST_SESSIONS_TOOL,
  SESSION_DETAILS_TOOL,
  SEARCH_PROMPT_METADATA_TOOL,
  PROMPT_METADATA_BATCH_TOOL,
]);
