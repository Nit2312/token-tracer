import { handleRegister } from '@/lib/mcp/oauth/endpoints';

/** Dynamic client registration (RFC 7591), public clients only. Feature-flagged (404 when MCP is off); see MCP.md. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export const POST = (request: Request) => handleRegister(request);
