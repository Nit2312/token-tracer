import { handleToken } from '@/lib/mcp/oauth/endpoints';

/** Token endpoint (authorization_code and refresh_token grants). Feature-flagged (404 when MCP is off); see MCP.md. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export const POST = (request: Request) => handleToken(request);
