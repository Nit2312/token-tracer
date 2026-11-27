import { handleAuthorizationServerMetadata } from '@/lib/mcp/oauth/endpoints';

/** RFC 8414 metadata. Feature-flagged with the MCP endpoint (404 when off). See MCP.md. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = (request: Request) => handleAuthorizationServerMetadata(request);
