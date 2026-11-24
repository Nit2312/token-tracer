import { handleRevoke } from '@/lib/mcp/oauth/endpoints';

/** Token revocation (RFC 7009). Feature-flagged (404 when MCP is off); see MCP.md. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export const POST = (request: Request) => handleRevoke(request);
