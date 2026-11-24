/** Discovery documents (pure). Every URL is built from the validated canonical base URL, never from the request. */
import type { OAuthConfig } from './config';
import { ADVERTISED_SCOPES, MCP_SCOPE_READ } from './scopes';

/** RFC 8414 authorization server metadata. CIMD is NOT advertised (DCR + static clients only). */
export function authorizationServerMetadata(cfg: OAuthConfig) {
  return {
    issuer: cfg.baseUrl,
    authorization_endpoint: `${cfg.baseUrl}/oauth/authorize`,
    token_endpoint: `${cfg.baseUrl}/oauth/token`,
    registration_endpoint: `${cfg.baseUrl}/oauth/register`,
    revocation_endpoint: `${cfg.baseUrl}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...ADVERTISED_SCOPES],
    client_id_metadata_document_supported: false,
    authorization_response_iss_parameter_supported: true, // RFC 9207: authorization responses carry iss
  };
}

/** RFC 9728 protected resource metadata. offline_access is an AS-side convenience scope and is not a resource scope. */
export function protectedResourceMetadata(cfg: OAuthConfig) {
  return {
    resource: cfg.resource,
    authorization_servers: [cfg.baseUrl],
    scopes_supported: [MCP_SCOPE_READ],
    bearer_methods_supported: ['header'],
    resource_name: 'Token Tracer MCP',
  };
}

/** WWW-Authenticate value for a 401 from /mcp (Step 7). */
export const resourceMetadataUrl = (cfg: OAuthConfig): string => `${cfg.baseUrl}/.well-known/oauth-protected-resource/mcp`;
