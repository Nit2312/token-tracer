import { handleReauthenticate } from '@/lib/mcp/oauth/authorize';

/** Clears a stale login session and sends the admin to a fresh sign-in that returns to /oauth/authorize. See lib/mcp/oauth/authorize.ts. Feature-flagged (404 when MCP is off). */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = (request: Request) => handleReauthenticate(request);
