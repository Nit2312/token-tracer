import { McpServer } from '@modelcontextprotocol/server';
import type { McpToolContext } from './context';

export const MCP_SERVER_INFO = { name: 'token-tracer', version: '0.1.0-foundation' } as const;
export const MCP_SERVER_INSTRUCTIONS =
  'Token Tracer MCP server (foundation preview). No tools, resources or prompts are available yet, and no application data is exposed.';

/**
 * Creates a fresh server for ONE authenticated request (the SDK's stateless model: nothing is kept between requests).
 * `ctx` carries the principal derived from the validated token. Phase 1/Step 7 register no tools, resources or prompts, so capability
 * discovery is empty by construction; Phase 4 tools will close over `ctx` and must take the team/user from it exclusively.
 */
export function createTokenTracerMcpServer(ctx: McpToolContext): McpServer {
  void ctx; // no tools yet
  return new McpServer({ ...MCP_SERVER_INFO }, { instructions: MCP_SERVER_INSTRUCTIONS });
}
