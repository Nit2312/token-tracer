import { handleMcpRequest } from '@/lib/mcp/handler';

/**
 * Remote MCP endpoint (Streamable HTTP, stateless). Feature-flagged: answers 404 unless MCP_ENABLED=true (see MCP.md).
 * Phase 1 = initialization and capability discovery only. No authentication, database access or tools yet.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const handle = (request: Request) => handleMcpRequest(request);

// Every method is routed to the handler so unsupported ones get the SDK's JSON-RPC 405 (Allow: POST), not Next's default.
export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE, handle as HEAD, handle as OPTIONS };
