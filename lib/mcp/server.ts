import { McpServer } from '@modelcontextprotocol/server';

export const MCP_SERVER_INFO = { name: 'token-tracer', version: '0.1.0-foundation' } as const;
export const MCP_SERVER_INSTRUCTIONS =
  'Token Tracer MCP server (foundation preview). No tools, resources or prompts are available yet, and no application data is exposed.';

/**
 * Creates a fresh server for ONE request (the SDK's stateless model: nothing is kept between requests).
 * Phase 1 registers no tools, resources or prompts, so capability discovery is empty by construction.
 */
export function createTokenTracerMcpServer(): McpServer {
  return new McpServer({ ...MCP_SERVER_INFO }, { instructions: MCP_SERVER_INSTRUCTIONS });
}
