/**
 * What the tool layer receives for ONE request. The principal comes only from the validated access token's database row (re-read for this
 * request); nothing the client sends (headers, body, query, tool arguments) can set or change it. Tools (Phase 4) must take the team and user
 * from here and nowhere else. The raw bearer token is deliberately NOT part of the context.
 */
import type { TeamAdminPrincipal } from './oauth/principal';

export interface McpToolContext {
  readonly principal: Readonly<TeamAdminPrincipal>;
}

export const makeToolContext = (principal: TeamAdminPrincipal): McpToolContext => Object.freeze({ principal: Object.freeze({ ...principal }) });
