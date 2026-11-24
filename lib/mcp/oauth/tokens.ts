/**
 * Authorization-code exchange, refresh rotation (STRICT reuse detection, no grace window), bearer authentication and revocation.
 * Only SHA-256 hashes are stored; plaintext tokens exist only in the return value of issue/exchange/refresh.
 * Every step runs through withMcpTx on the dedicated mcp_auth pool. Failures that must PERSIST (a burnt code, a revoked family) are
 * returned out of the transaction as a value and thrown AFTER commit, never thrown inside it.
 */
import { withMcpTx, type McpPool, type McpTx } from '../db';
import { audit } from './audit';
import { ACCESS_TOKEN_PREFIX, AUTH_CODE_PREFIX, REFRESH_TOKEN_PREFIX, generateSecret, looksLikeSecret, sha256, verifyPkce } from './crypto';
import { OAuthError } from './errors';
import type { McpPrincipal } from './principal';

export const ACCESS_TOKEN_TTL_SECONDS = 30 * 60;
export const REFRESH_IDLE_TTL_SECONDS = 14 * 24 * 3600;
export const REFRESH_ABSOLUTE_TTL_SECONDS = 60 * 24 * 3600;
export const AUTH_CODE_TTL_SECONDS = 60;

/**
 * The ONE definition of "this user may hold MCP access", used by code exchange, refresh and bearer authentication alike: an active DATABASE
 * user whose role is 'admin' and who belongs to a team that still exists. Evaluated against the database on every use, never cached.
 * (SQL fragment over alias `u`; constant text, no interpolated values.)
 */
const ELIGIBLE_USER_SQL = `(u.active AND u.role = 'admin' AND EXISTS (SELECT 1 FROM teams tm WHERE tm.id = u.team_id))`;

const INVALID_GRANT = () => new OAuthError('invalid_grant', 'The grant is invalid, expired or already used.');

export interface TokenPair { accessToken: string; refreshToken: string; expiresIn: number; scope: string; tokenType: 'Bearer' }

/** Insert one access + one refresh token of a family. Returns plaintexts and the new refresh id (used to link rotation). */
async function issuePair(tx: McpTx, p: { clientId: string; userId: string; resource: string; scope: string; familyId: string; absoluteExpiresAtSql: string; absoluteParams: unknown[] }): Promise<TokenPair & { refreshId: string }> {
  const accessToken = generateSecret(ACCESS_TOKEN_PREFIX);
  const refreshToken = generateSecret(REFRESH_TOKEN_PREFIX);
  const base = [p.familyId, p.clientId, p.userId, p.resource, p.scope];
  const abs = p.absoluteExpiresAtSql; // trusted constant fragments only (see callers)
  const a = await tx.query(
    `INSERT INTO oauth_tokens (token_hash, kind, family_id, client_id, user_id, resource, scope, expires_at, absolute_expires_at)
     VALUES ($1, 'access', $2, $3, $4, $5, $6, LEAST(now() + make_interval(secs => ${ACCESS_TOKEN_TTL_SECONDS}), ${abs}), ${abs}) RETURNING id`,
    [sha256(accessToken), ...base, ...p.absoluteParams]);
  void a;
  const r = await tx.query(
    `INSERT INTO oauth_tokens (token_hash, kind, family_id, client_id, user_id, resource, scope, expires_at, absolute_expires_at)
     VALUES ($1, 'refresh', $2, $3, $4, $5, $6, LEAST(now() + make_interval(secs => ${REFRESH_IDLE_TTL_SECONDS}), ${abs}), ${abs}) RETURNING id`,
    [sha256(refreshToken), ...base, ...p.absoluteParams]);
  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS, scope: p.scope, tokenType: 'Bearer', refreshId: r.rows[0].id };
}

const FRESH_ABS = { absoluteExpiresAtSql: `now() + make_interval(secs => ${REFRESH_ABSOLUTE_TTL_SECONDS})`, absoluteParams: [] as unknown[] };

/** Revoke every live token of a family. One-way (database trigger): only ever sets revoked_at where it is still NULL. */
async function revokeFamily(tx: McpTx, familyId: string, reason: string): Promise<number> {
  const r = await tx.query('UPDATE oauth_tokens SET revoked_at = now(), revoked_reason = $2 WHERE family_id = $1 AND revoked_at IS NULL', [familyId, reason]);
  return r.rowCount ?? 0;
}

// ── Authorization codes ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CreateCodeInput { clientId: string; userId: string; redirectUri: string; codeChallenge: string; resource: string; scope: string }

/** Store a single-use authorization code (60 s). Returns the plaintext code, shown once. */
export async function createAuthorizationCode(pool: McpPool, i: CreateCodeInput): Promise<string> {
  const code = generateSecret(AUTH_CODE_PREFIX);
  await withMcpTx(pool, async (tx) => {
    await tx.query(
      `INSERT INTO oauth_authorization_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, resource, scope, family_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, gen_random_uuid(), now() + make_interval(secs => ${AUTH_CODE_TTL_SECONDS}))`,
      [sha256(code), i.clientId, i.userId, i.redirectUri, i.codeChallenge, i.resource, i.scope]);
    await audit(tx, 'authorization_granted', i.userId, 'oauth_client', i.clientId, { scope: i.scope });
  });
  return code;
}

export interface ExchangeCodeInput { code: unknown; clientId: unknown; redirectUri: unknown; codeVerifier: unknown; resource: string }

type ExchangeOutcome = { ok: TokenPair } | { fail: 'invalid' } | { fail: 'replay' };

/**
 * authorization_code grant. The code is consumed with ONE atomic UPDATE before anything else is checked, so a wrong verifier / redirect_uri
 * still burns it (no guessing). A second presentation of a consumed code revokes every token minted from it (RFC 6749 §4.1.2).
 */
export async function exchangeAuthorizationCode(pool: McpPool, i: ExchangeCodeInput): Promise<TokenPair> {
  if (!looksLikeSecret(i.code, AUTH_CODE_PREFIX) || typeof i.clientId !== 'string' || typeof i.redirectUri !== 'string') throw INVALID_GRANT();
  const hash = sha256(i.code);
  const out = await withMcpTx(pool, async (tx): Promise<ExchangeOutcome> => {
    const c = await tx.query(
      `UPDATE oauth_authorization_codes SET consumed_at = now()
        WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > now()
        RETURNING client_id, user_id, redirect_uri, code_challenge, resource, scope, family_id`, [hash]);
    const row = c.rows[0];
    if (!row) {
      const prior = await tx.query('SELECT family_id, user_id, client_id, consumed_at FROM oauth_authorization_codes WHERE code_hash = $1', [hash]);
      const p = prior.rows[0];
      if (p && p.consumed_at !== null) {
        const n = await revokeFamily(tx, p.family_id, 'code_replay');
        await audit(tx, 'code_replayed', p.user_id, 'oauth_client', p.client_id, { revoked: n });
        return { fail: 'replay' };
      }
      return { fail: 'invalid' }; // unknown or expired
    }
    if (row.client_id !== i.clientId || row.redirect_uri !== i.redirectUri || row.resource !== i.resource || !verifyPkce(i.codeVerifier, row.code_challenge)) return { fail: 'invalid' };
    const ok = await tx.query(
      `SELECT 1 FROM users u, oauth_clients c WHERE u.id = $1 AND ${ELIGIBLE_USER_SQL} AND c.client_id = $2 AND c.disabled_at IS NULL`, [row.user_id, row.client_id]);
    if (ok.rowCount !== 1) return { fail: 'invalid' };
    const pair = await issuePair(tx, { clientId: row.client_id, userId: row.user_id, resource: row.resource, scope: row.scope, familyId: row.family_id, ...FRESH_ABS });
    await audit(tx, 'token_issued', row.user_id, 'oauth_token', pair.refreshId, { grant: 'authorization_code' });
    await tx.query('UPDATE oauth_clients SET last_used_at = now() WHERE client_id = $1', [row.client_id]);
    const { refreshId: _unused, ...publicPair } = pair; void _unused;
    return { ok: publicPair };
  });
  if ('ok' in out) return out.ok;
  throw INVALID_GRANT();
}

// ── Refresh ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

class RotationRace extends Error {}
type RefreshOutcome = { ok: TokenPair } | { fail: 'invalid' } | { fail: 'reuse'; familyId: string; userId: string };

export interface RefreshInput { refreshToken: unknown; clientId: unknown }

/**
 * refresh_token grant with rotation. A refresh token can be exchanged exactly once: presenting an already-rotated token (or losing a
 * concurrent race for it) revokes the WHOLE family and fails — strict, no grace window. The old and new rows are linked in the same
 * UPDATE (rotated_at + replaced_by_id are one-way in the database).
 */
export async function refreshTokens(pool: McpPool, i: RefreshInput): Promise<TokenPair> {
  if (!looksLikeSecret(i.refreshToken, REFRESH_TOKEN_PREFIX) || typeof i.clientId !== 'string') throw INVALID_GRANT();
  const hash = sha256(i.refreshToken);
  const clientId = i.clientId;

  let out: RefreshOutcome;
  try {
    out = await withMcpTx(pool, async (tx): Promise<RefreshOutcome> => {
      const s = await tx.query(
        `SELECT t.id, t.user_id, t.client_id, t.family_id, t.resource, t.scope, t.rotated_at, t.revoked_at,
                (t.expires_at > now() AND t.absolute_expires_at > now()) AS live, (${ELIGIBLE_USER_SQL} AND c.disabled_at IS NULL) AS allowed
           FROM oauth_tokens t JOIN users u ON u.id = t.user_id JOIN oauth_clients c ON c.client_id = t.client_id
          WHERE t.token_hash = $1 AND t.kind = 'refresh'`, [hash]);
      const t = s.rows[0];
      if (!t || t.client_id !== clientId || t.revoked_at !== null) return { fail: 'invalid' };
      if (t.rotated_at !== null) return { fail: 'reuse', familyId: t.family_id, userId: t.user_id };
      if (!t.live || !t.allowed) return { fail: 'invalid' };
      // The family keeps its ORIGINAL absolute expiry: rotation never extends the 60-day cap.
      const abs = (await tx.query('SELECT absolute_expires_at FROM oauth_tokens WHERE id = $1', [t.id])).rows[0].absolute_expires_at as Date;
      const pair = await issuePair(tx, { clientId, userId: t.user_id, resource: t.resource, scope: t.scope, familyId: t.family_id, absoluteExpiresAtSql: '$7::timestamptz', absoluteParams: [abs] });
      const mark = await tx.query(
        'UPDATE oauth_tokens SET rotated_at = now(), replaced_by_id = $2 WHERE id = $1 AND rotated_at IS NULL AND revoked_at IS NULL', [t.id, pair.refreshId]);
      if (mark.rowCount !== 1) throw new RotationRace(); // lost a concurrent rotation: roll the new pair back
      await audit(tx, 'token_refreshed', t.user_id, 'oauth_token', pair.refreshId);
      await tx.query('UPDATE oauth_clients SET last_used_at = now() WHERE client_id = $1', [clientId]);
      const { refreshId: _unused, ...publicPair } = pair; void _unused;
      return { ok: publicPair };
    });
  } catch (e) {
    if (!(e instanceof RotationRace)) throw e;
    // Two requests presented the same refresh token: treat as reuse. Re-read the family in a fresh transaction.
    out = await withMcpTx(pool, async (tx): Promise<RefreshOutcome> => {
      const s = await tx.query(`SELECT family_id, user_id FROM oauth_tokens WHERE token_hash = $1 AND kind = 'refresh'`, [hash]);
      return s.rows[0] ? { fail: 'reuse', familyId: s.rows[0].family_id, userId: s.rows[0].user_id } : { fail: 'invalid' };
    });
  }

  if ('ok' in out) return out.ok;
  if (out.fail === 'reuse') {
    const { familyId, userId } = out;
    await withMcpTx(pool, async (tx) => {
      const n = await revokeFamily(tx, familyId, 'refresh_reuse');
      await audit(tx, 'refresh_reuse_detected', userId, 'oauth_client', clientId, { revoked: n });
    });
  }
  throw INVALID_GRANT();
}

// ── Bearer authentication (every MCP request) ───────────────────────────────────────────────────────────────────────────────────

/**
 * Resolve an access token to a principal, re-reading the user's CURRENT state: a deactivated or demoted user, a user without a (still existing)
 * team, a disabled client, a revoked/expired token, a refresh token, or a token minted for another resource all yield null. Never throws for a bad token (callers answer 401); database failure throws.
 */
export async function authenticateAccessToken(pool: McpPool, token: unknown, expectedResource: string): Promise<McpPrincipal | null> {
  if (!looksLikeSecret(token, ACCESS_TOKEN_PREFIX)) return null;
  const hash = sha256(token);
  return withMcpTx(pool, async (tx) => {
    const r = await tx.query(
      `SELECT t.id, t.user_id, t.client_id, t.scope, t.resource, u.role, u.team_id, u.display_name
         FROM oauth_tokens t JOIN users u ON u.id = t.user_id JOIN oauth_clients c ON c.client_id = t.client_id
        WHERE t.token_hash = $1 AND t.kind = 'access' AND t.revoked_at IS NULL AND t.expires_at > now() AND t.absolute_expires_at > now()
          AND ${ELIGIBLE_USER_SQL} AND c.disabled_at IS NULL`, [hash]);
    const row = r.rows[0];
    if (!row || row.resource !== expectedResource) return null;
    await tx.query(`UPDATE oauth_tokens SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes')`, [row.id]);
    return { userId: row.user_id, clientId: row.client_id, tokenId: row.id, scope: row.scope, role: row.role, teamId: row.team_id, displayName: row.display_name };
  });
}

// ── Revocation ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** RFC 7009: revoke the token's whole family (access + refresh). Only for the client it was issued to; unknown tokens are silently accepted. */
export async function revokeToken(pool: McpPool, token: unknown, clientId: unknown): Promise<void> {
  if (typeof clientId !== 'string' || !(looksLikeSecret(token, ACCESS_TOKEN_PREFIX) || looksLikeSecret(token, REFRESH_TOKEN_PREFIX))) return;
  const hash = sha256(token as string);
  await withMcpTx(pool, async (tx) => {
    const s = await tx.query('SELECT id, family_id, user_id FROM oauth_tokens WHERE token_hash = $1 AND client_id = $2', [hash, clientId]);
    const t = s.rows[0];
    if (!t) return;
    const n = await revokeFamily(tx, t.family_id, 'client_revoked');
    await audit(tx, 'token_revoked', t.user_id, 'oauth_token', t.id, { revoked: n });
  });
}

/** Revoke everything a user holds (password reset, MFA reset, deactivation, role/team change, deletion). Idempotent. */
export async function revokeAllForUser(pool: McpPool, userId: string, reason: string): Promise<number> {
  if (!/^[a-z_]{1,40}$/.test(reason)) throw new Error('invalid revoke reason');
  return withMcpTx(pool, async (tx) => {
    const r = await tx.query('UPDATE oauth_tokens SET revoked_at = now(), revoked_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL', [userId, reason]);
    const n = r.rowCount ?? 0;
    if (n > 0) await audit(tx, 'tokens_revoked_for_user', userId, 'user', userId, { revoked: n, reason });
    return n;
  });
}
