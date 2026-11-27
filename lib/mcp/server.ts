import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import type { McpToolContext } from './context';
import { TOOL_DEFINITIONS, TOOL_EXECUTORS, type ToolHandlerDeps } from './tools';

export const MCP_SERVER_INFO = { name: 'token-tracer', version: '0.1.0' } as const;
export const MCP_SERVER_INSTRUCTIONS =
  'Token Tracer MCP server. Exposes team developer activity, session summaries, session details, and prompt metadata for authenticated team administrators.';

export interface ServerOptions {
  readonly deps?: ToolHandlerDeps;
}

/**
 * Creates a fresh server for ONE authenticated request (the SDK's stateless model: nothing is kept between requests).
 * `ctx` carries the principal derived from the validated token.
 * Phase 4.4 registers exactly the six approved metadata-only tools.
 */
export function createTokenTracerMcpServer(
  ctx: McpToolContext,
  options: ServerOptions = {}
): McpServer {
  const server = new McpServer(
    { ...MCP_SERVER_INFO },
    { instructions: MCP_SERVER_INSTRUCTIONS }
  );

  for (const def of TOOL_DEFINITIONS) {
    const executor = TOOL_EXECUTORS[def.name];
    if (!executor) continue;

    const schema = fromJsonSchema(def.inputSchema);
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: schema,
      },
      async (args: unknown) => {
        return executor(ctx, args, options.deps);
      }
    );
  }

  return server;
}
