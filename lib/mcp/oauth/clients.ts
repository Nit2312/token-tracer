/** OAuth client registry (DCR + static). Registration data is immutable once written (database trigger); only last_used_at changes. */
import crypto from 'node:crypto';
import { withMcpTx, type McpPool } from '../db';
import { audit } from './audit';
import { generateClientId } from './crypto';
import { OAuthError } from './errors';
import { DEFAULT_REDIRECT_POLICY, redirectUriMatches, validateRedirectUris, type RedirectPolicy } from './redirect-rules';

export interface OAuthClient { clientId: string; name: string; redirectUris: string[]; disabled: boolean; hasLoopback: boolean }

export interface RegisterClientInput { name: unknown; redirectUris: unknown; registration?: 'dcr' | 'static'; clientIp?: string | null; policy?: RedirectPolicy }

/** Salted hash of the client IP (never stored raw). Salt = the session secret; if absent the IP is simply not recorded. */
export function hashIp(ip: string | null | undefined, secret = process.env.SESSION_SECRET): string | null {
  if (!ip || !secret) return null;
  return crypto.createHmac('sha256', secret).update(`mcp-ip:${ip}`).digest('hex').slice(0, 32);
}

export async function registerClient(pool: McpPool, input: RegisterClientInput): Promise<OAuthClient> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length < 1 || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) throw new OAuthError('invalid_client_metadata', 'client_name must be 1-100 printable characters.');
  const v = validateRedirectUris(input.redirectUris, input.policy ?? DEFAULT_REDIRECT_POLICY);
  if (!v.ok) throw new OAuthError('invalid_redirect_uri', 'One or more redirect_uris are not allowed.');
  const clientId = generateClientId();
  await withMcpTx(pool, async (tx) => {
    await tx.query(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, registration, created_ip_hash) VALUES ($1, $2, $3, $4, $5)`,
      [clientId, name, v.uris, input.registration ?? 'dcr', hashIp(input.clientIp)]);
    await audit(tx, 'client_registered', null, 'oauth_client', clientId, { redirect_uris: v.uris.length, loopback: v.hasLoopback });
  });
  return { clientId, name, redirectUris: v.uris, disabled: false, hasLoopback: v.hasLoopback };
}

export async function getClient(pool: McpPool, clientId: unknown): Promise<OAuthClient | null> {
  if (typeof clientId !== 'string' || clientId.length < 4 || clientId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(clientId)) return null;
  return withMcpTx(pool, async (tx) => {
    const r = await tx.query('SELECT client_id, client_name, redirect_uris, disabled_at FROM oauth_clients WHERE client_id = $1', [clientId]);
    const row = r.rows[0];
    if (!row) return null;
    const uris: string[] = row.redirect_uris;
    return { clientId: row.client_id, name: row.client_name, redirectUris: uris, disabled: row.disabled_at !== null, hasLoopback: uris.some((u) => u.startsWith('http://')) };
  });
}

/** Exact match for hosted callbacks, port-agnostic for loopback (see redirect-rules). A disabled client never matches. */
export function clientAllowsRedirect(client: OAuthClient, requested: unknown, policy: RedirectPolicy = DEFAULT_REDIRECT_POLICY): boolean {
  return !client.disabled && redirectUriMatches(client.redirectUris, requested, policy);
}
