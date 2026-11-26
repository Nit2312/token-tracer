/**
 * Opaque references to sessions and prompts (P3-1 contract). Pure.
 *
 * The API never shows a raw database id: ids of prompt turns come from one platform-wide sequence (showing them would reveal ingest volume
 * across tenants), and client-supplied session ids are free text. A reference is the id sealed (authenticated encryption) and bound to the TEAM
 * and the kind, so a reference cannot be read by the client, used for another kind, or used by another team.
 * Any reference that cannot be opened — tampered, wrong team, wrong kind, malformed — fails with the SAME `not_found` as a missing row.
 * (Ownership is still decided by the database from the token; a reference only says WHICH row to look at.)
 */
import { dataError } from './errors';
import { STRING_LIMITS } from './limits';
import { assertScope, type DataScope } from './scope';
import { openJson, sealJson } from './sealed';

export type RefKind = 'prompt' | 'session';
export interface RefContext { readonly scope: DataScope; readonly secret: string }

const ID_RE: Record<RefKind, RegExp> = {
  prompt: /^\d{1,19}$/, // a bigint sequence value, as text
  session: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // sync_sessions.id (server-generated UUID)
};

export function encodeRef(kind: RefKind, id: string, ctx: RefContext): string {
  assertScope(ctx.scope);
  if (typeof id !== 'string' || !ID_RE[kind].test(id)) throw dataError('internal'); // a malformed id here is a bug in our own projection
  return sealJson({ i: id.toLowerCase() }, `ref:${kind}`, ctx.scope.teamId, ctx.secret);
}

export function decodeRef(kind: RefKind, ref: unknown, ctx: RefContext): string {
  assertScope(ctx.scope);
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > STRING_LIMITS.ref) throw dataError('not_found');
  const payload = openJson(ref, `ref:${kind}`, ctx.scope.teamId, ctx.secret);
  const id = payload?.i;
  if (typeof id !== 'string' || !ID_RE[kind].test(id)) throw dataError('not_found');
  return id;
}
