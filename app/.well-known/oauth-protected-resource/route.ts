import { handleProtectedResourceMetadata } from '@/lib/mcp/oauth/endpoints';

/** RFC 9728 protected-resource metadata for the MCP endpoint (path-inserted form and the root fallback serve the same document). */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = (request: Request) => handleProtectedResourceMetadata(request);
