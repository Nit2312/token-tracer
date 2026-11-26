/**
 * Time windows (P3-1 contracts). Pure. The window is a half-open interval [from, to) in UTC and is NEVER longer than MAX_WINDOW_DAYS (7):
 * the maximum is a literal in limits.ts, not a setting. Instants must be unambiguous: a date (UTC midnight) or a date-time WITH an offset.
 */
import { dataError } from './errors';
import { DEFAULT_WINDOW_MS, FUTURE_SKEW_MS, MAX_WINDOW_MS, lookbackMs, type WindowSource } from './limits';

export interface TimeWindow { readonly from: Date; readonly to: Date }

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

function utcMs(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0): number {
  const t = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const back = new Date(t);
  // Date.UTC rolls 2026-02-31 into March; require the parts to survive the round trip.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) throw dataError('invalid_argument');
  return t;
}

export function parseInstant(value: unknown): number {
  if (typeof value !== 'string' || value.length > 40) throw dataError('invalid_argument');
  let m = DATE_RE.exec(value);
  if (m) return utcMs(Number(m[1]), Number(m[2]), Number(m[3]));
  m = DATETIME_RE.exec(value);
  if (!m) throw dataError('invalid_argument');
  const [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  const s = m[6] === undefined ? 0 : Number(m[6]);
  const ms = m[7] === undefined ? 0 : Number(m[7].padEnd(3, '0'));
  if (h > 23 || mi > 59 || s > 59) throw dataError('invalid_argument');
  let offsetMs = 0;
  if (m[8] !== 'Z') {
    const oh = Number(m[8].slice(1, 3)), om = Number(m[8].slice(4, 6));
    if (oh > 23 || om > 59) throw dataError('invalid_argument');
    offsetMs = (oh * 60 + om) * 60_000 * (m[8][0] === '-' ? -1 : 1);
  }
  const t = utcMs(y, mo, d, h, mi, s, ms) - offsetMs;
  if (!Number.isFinite(t)) throw dataError('invalid_argument');
  return t;
}

/**
 * Resolves a caller's optional `from` / `to`. Omitted `to` = now; omitted `from` = `to` minus the default window.
 * `source` selects the retention the start is checked against (prompts 7 days, others 14). Rejects: malformed instants, from >= to, a `to` further in the future than the skew allowance, and any window longer than 7 days (`window_too_large`).
 */
export function resolveWindow(input: { from?: unknown; to?: unknown } | undefined, source: WindowSource, now: Date = new Date()): TimeWindow {
  const nowMs = now.getTime();
  const toMs = input?.to === undefined ? nowMs : parseInstant(input.to);
  const fromMs = input?.from === undefined ? toMs - DEFAULT_WINDOW_MS : parseInstant(input.from);
  if (fromMs >= toMs) throw dataError('invalid_argument');
  if (toMs > nowMs + FUTURE_SKEW_MS) throw dataError('invalid_argument');
  if (toMs - fromMs > MAX_WINDOW_MS) throw dataError('window_too_large');
  // lookback: the start may not be older than min(14 days, the source's retention) before now
  if (fromMs < nowMs - lookbackMs(source)) throw dataError('window_out_of_range');
  return Object.freeze({ from: new Date(fromMs), to: new Date(toMs) });
}
