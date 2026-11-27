import { handleDecision } from '@/lib/mcp/oauth/authorize';

/** Consent decision (fetch from the consent page). Same-origin + signed consent token; see lib/mcp/oauth/authorize.ts. Feature-flagged (404 when MCP is off). */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export const POST = (request: Request) => handleDecision(request);
