/**
 * Pagination cursors (P3-1 contract). Pure. Keyset position only (no offsets), sealed with authenticated encryption.
 *
 * A cursor is bound to: its kind (which list), the team and user it was issued to, and a fingerprint of the query filters. A cursor reused with a
 * different filter, by another principal, after expiry, or after any modification fails with one uniform `cursor_invalid`. It carries a timestamp
 * and an id as the position — never any prompt content.
 */
import crypto from 'node:crypto';
import { dataError } from './errors';
import { CURSOR_TTL_MS, STRING_LIMITS } from './limits';
import { assertScope, type DataScope } from './scope';
import { openJson, sealJson } from './sealed';

export type CursorKind = 'developers' | 'sessions' | 'prompts';
export interface CursorPosition { readonly t: string; readonly i: string } // ISO instant (or '' when the list has no time key), and the row id
export interface CursorContext { readonly scope: DataScope; readonly secret: string }

const POSITION_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const ISO_RE = /^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Stable fingerprint of the filters a list was requested with (key order does not matter). */
export const fingerprintFilters = (filters: unknown): string => crypto.createHash('sha256').update(canonical(filters)).digest('hex').slice(0, 32);

const aadOf = (scope: DataScope, fingerprint: string) => `${scope.teamId}|${scope.userId}|${fingerprint}`;

export function encodeCursor(kind: CursorKind, position: CursorPosition, filters: unknown, ctx: CursorContext, now: Date = new Date()): string {
  assertScope(ctx.scope);
  if (!ISO_RE.test(position.t) || !POSITION_ID_RE.test(position.i)) throw dataError('internal');
  const token = sealJson({ t: position.t, i: position.i, e: now.getTime() + CURSOR_TTL_MS }, `cursor:${kind}`, aadOf(ctx.scope, fingerprintFilters(filters)), ctx.secret);
  if (token.length > STRING_LIMITS.cursor) throw dataError('internal');
  return token;
}

export function decodeCursor(kind: CursorKind, cursor: unknown, filters: unknown, ctx: CursorContext, now: Date = new Date()): CursorPosition {
  assertScope(ctx.scope);
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > STRING_LIMITS.cursor) throw dataError('cursor_invalid');
  const p = openJson(cursor, `cursor:${kind}`, aadOf(ctx.scope, fingerprintFilters(filters)), ctx.secret);
  if (!p || typeof p.t !== 'string' || typeof p.i !== 'string' || typeof p.e !== 'number') throw dataError('cursor_invalid');
  if (!Number.isFinite(p.e) || p.e < now.getTime() || p.e - now.getTime() > CURSOR_TTL_MS + 1_000) throw dataError('cursor_invalid');
  if (!ISO_RE.test(p.t) || !POSITION_ID_RE.test(p.i)) throw dataError('cursor_invalid');
  return Object.freeze({ t: p.t, i: p.i });
}
