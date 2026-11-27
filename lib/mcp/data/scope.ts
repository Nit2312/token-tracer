/**
 * The identity a data call runs under (P3-1 contract). Pure.
 *
 * Decision (2026-11-26): the database derives the team from the caller's TOKEN HASH; no data function accepts a team id. So the only authority a
 * scope hands to the database is `scopeDbArgs(scope).tokenHash`. `teamId` and `userId` are informational (cross-checks, sealing references) and
 * are never an input the database trusts.
 *
 * Unforgeable by construction: a DataScope can only be made by createDataScope (a module-private registry remembers every issued scope, and
 * assertScope rejects anything else, including a look-alike object literal). The hash is NOT a property of the object, so serialising or logging a
 * scope shows ids only. The plaintext bearer token is never part of a scope; the hash cannot be turned back into the token.
 */
import { dataError } from './errors';

declare const SCOPE_BRAND: unique symbol;
export interface DataScope { readonly [SCOPE_BRAND]: true; readonly userId: string; readonly teamId: string }

export interface ScopeSource { readonly tokenHash: Uint8Array; readonly userId: string; readonly teamId: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASHES = new WeakMap<object, Buffer>();

export function createDataScope(src: ScopeSource): DataScope {
  if (!(src.tokenHash instanceof Uint8Array) || src.tokenHash.byteLength !== 32) throw dataError('internal');
  if (!UUID_RE.test(src.userId) || !UUID_RE.test(src.teamId)) throw dataError('internal');
  const scope = Object.freeze({ userId: src.userId.toLowerCase(), teamId: src.teamId.toLowerCase() }) as unknown as DataScope;
  HASHES.set(scope, Buffer.from(src.tokenHash)); // a copy: later changes to the caller's buffer cannot alter the scope
  return scope;
}

export function assertScope(value: unknown): asserts value is DataScope {
  if (typeof value !== 'object' || value === null || !HASHES.has(value)) throw dataError('internal');
}

/**
 * The scope of ONE request. A team admin always acts on their own team: naming a different one is refused (`invalid_argument`).
 * An "All teams" admin (principal.teamId === null) must name the team (`team_required` when missing); the database re-checks that the caller
 * really is an All-teams admin and that the team exists. The resulting scope always carries a concrete team, which is what cursors and
 * references are bound to, so a cursor or reference from one team can never be replayed against another.
 */
export function scopeFromPrincipal(
  principal: { tokenHash: Uint8Array; userId: string; teamId: string | null },
  requestedTeamId?: string | null,
): DataScope {
  let teamId: string;
  if (principal.teamId !== null) {
    if (requestedTeamId != null && requestedTeamId.toLowerCase() !== principal.teamId.toLowerCase()) throw dataError('invalid_argument');
    teamId = principal.teamId;
  } else {
    if (requestedTeamId == null) throw dataError('team_required');
    teamId = requestedTeamId;
  }
  return createDataScope({ tokenHash: principal.tokenHash, userId: principal.userId, teamId });
}

/** The ONLY authority passed to the database for a data call. Returns a fresh copy each time. */
export function scopeDbArgs(scope: DataScope): { tokenHash: Buffer; teamId: string } {
  assertScope(scope);
  return { tokenHash: Buffer.from(HASHES.get(scope)!), teamId: scope.teamId };
}
