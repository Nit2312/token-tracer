/**
 * NON-AUTHORITATIVE, OPTIONAL FUTURE WORK. Not part of the Phase 3 scope and not connected to anything (privacy decision, 2026-11-26, MCP.md 16.9):
 * the initial release is metadata-only, and masking does not make arbitrary prompt text safe to disclose. Nothing may depend on this module.
 *
 * Best-effort masking of prompt text (P3-2). Pure: no I/O, no environment, no logging.
 *
 * IMPORTANT, AND PART OF THE CONTRACT: this is BEST-EFFORT. It reduces the chance that a secret or a piece of personal data survives into a
 * snippet; it does NOT guarantee it, and no document, consent text or caller may describe it as a guarantee. Known gaps are listed in
 * KNOWN_LIMITATIONS and are exercised by tests, so they cannot silently grow or be forgotten. Masking is one control among several: the
 * default is metadata only, text stays behind the two-part gate in prompt-access.ts, and this module is NOT connected to any tool or query.
 *
 * What it does, in order:
 *   1. bound the input (CPU is bounded by construction: every pattern is linear, input is capped);
 *   2. normalise: NFKC (folds full-width and compatibility forms that evade patterns), remove invisible and direction-control characters
 *      (including the Unicode "tag" block used for hidden instructions), strip control characters, decode percent-encoded runs;
 *   3. redact by pattern family (private keys, tokens, credentials in URLs and headers, keyed secrets in several languages, e-mail, card
 *      numbers (Luhn), IBAN (mod 97), national-id-like numbers, phone numbers, IP addresses, home-directory user names, high-entropy strings);
 *   4. VERIFY: scan the result again; if a high-confidence pattern still matches, the whole text is WITHHELD rather than returned;
 *   5. only then cut to the character limit (on a code-point boundary, never inside a placeholder).
 * Masking runs on the full bounded text BEFORE the cut, so a secret cannot be half-cut into something no pattern recognises.
 */
import { SNIPPET_MAX_CHARS } from './limits';

/** Input is read only up to this many UTF-16 units; beyond it the text is cut at a whitespace boundary (never mid-token). */
export const MASK_INPUT_MAX_CHARS = 16_384;

export type MaskCategory =
  | 'PRIVATE_KEY' | 'TOKEN' | 'JWT' | 'URL_CREDENTIALS' | 'AUTH_HEADER' | 'SECRET_VALUE' | 'EMAIL' | 'CARD' | 'IBAN' | 'ID_NUMBER' | 'PHONE' | 'IP_ADDRESS' | 'USER_NAME'
  | 'HIGH_ENTROPY';

export const KNOWN_LIMITATIONS: readonly string[] = Object.freeze([
  'Secrets split by spaces, punctuation or line breaks ("s k - l i v e") are not recognised.',
  'Secrets that are encoded (base64 of a key, ROT13, hex of a string) are only caught if the encoded form is itself long and high-entropy.',
  'A secret with a format not listed here and shorter than 24 characters, outside a keyed assignment, is not recognised.',
  'Passwords or names written as ordinary words ("the password is correct horse battery staple") are only caught for the first word after a recognised keyword.',
  'Personal names, postal addresses, company or project names and free-form personal facts are NOT detected at all.',
  'Keyword detection covers a fixed list of languages and may miss others, dialects and misspellings.',
  'Homoglyphs from other scripts (for example Cyrillic letters that look Latin) in a secret prefix are not normalised.',
  'Numbers can be over-masked (long digit runs, hashes), which is deliberate: false positives are preferred to leaks.',
]);

const PH = (c: MaskCategory) => `[REDACTED:${c}]`;
const PLACEHOLDER_RE = /\[REDACTED:[A-Z_]+\]/;

// ───────────────────────── normalisation ─────────────────────────
// zero-width and soft-hyphen, bidi embedding/override/isolate controls, word joiner and invisible operators, BOM, tag characters, variation selectors
const INVISIBLE_RE = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufe00-\ufe0f]|[\u{e0000}-\u{e007f}]|[\u{e0100}-\u{e01ef}]/gu;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g; // REMOVED (not replaced by a space): "pass\u0000word" must read as "password"
const LINE_SEP_RE = /[\u2028\u2029]/g;
const PERCENT_RUN_RE = /(?:%[0-9A-Fa-f]{2}){1,64}/g;

function decodePercentRuns(s: string): string {
  if (!s.includes('%')) return s;
  return s.replace(PERCENT_RUN_RE, (run) => { try { return decodeURIComponent(run); } catch { return run; } });
}

export function normalizeForMasking(input: string): { text: string; cut: boolean } {
  let s = input;
  let cut = false;
  if (s.length > MASK_INPUT_MAX_CHARS) {
    cut = true;
    s = s.slice(0, MASK_INPUT_MAX_CHARS);
    const ws = Math.max(s.lastIndexOf(' '), s.lastIndexOf('\n'), s.lastIndexOf('\t'));
    s = ws > MASK_INPUT_MAX_CHARS - 512 ? s.slice(0, ws) : s.slice(0, Math.max(0, MASK_INPUT_MAX_CHARS - 512)); // never end mid-token
  }
  s = s.normalize('NFKC');
  s = s.replace(INVISIBLE_RE, '').replace(CONTROL_RE, '').replace(LINE_SEP_RE, '\n');
  s = decodePercentRuns(s).replace(INVISIBLE_RE, '').replace(CONTROL_RE, '').replace(LINE_SEP_RE, '\n');
  return { text: s, cut };
}

// ───────────────────────── detectors ─────────────────────────
const COUNTS = () => ({} as Partial<Record<MaskCategory, number>>);

// Vendor and format-specific tokens. Each is anchored on a distinctive prefix and uses bounded quantifiers.
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bpk_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bwhsec_[A-Za-z0-9]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\bya29\.[0-9A-Za-z_-]{20,}/g,
  /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g,
  /\bxapp-[A-Za-z0-9-]{10,}/g,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
  /\bSK[0-9a-fA-F]{32}\b/g,
  /\bdop_v1_[a-f0-9]{40,}/g,
  /\bfm[12]_[A-Za-z0-9+/=_-]{20,}/g,
  /\btt_(?:at|rt|ac)_[A-Za-z0-9_-]{16,}/g,
  /\bnapi_[A-Za-z0-9]{30,}/g,
];
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{0,}/g;
const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g;
const URL_CRED_RE = /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@]{1,200}:[^\s@/]{1,200}@[^\s'"<>]{1,300}/gi;
const URL_SECRET_PARAM_RE = /([?&;](?:access_token|refresh_token|id_token|token|api_?key|apikey|key|secret|client_secret|password|passwd|pwd|sig|signature|auth|code|session|sessionid|x-amz-signature|x-amz-credential)=)[^&\s'"<>]{1,300}/gi;
const AUTH_HEADER_RE = /\b(authorization|proxy-authorization|x-api-key|x-auth-token|cookie|set-cookie)(\s*[:=]\s*)([^\r\n]{1,300})/gi;
const BEARER_RE = /\b(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

// Keywords that introduce a secret, in several languages. Latin-script words use word boundaries; CJK/Cyrillic/Arabic/Hangul keywords use none.
const KW_LATIN = '(?:password|passwd|passcode|passphrase|pwd|pass|secret|token|api[ _-]?key|apikey|access[ _-]?key|private[ _-]?key|credentials?|client[ _-]?secret|auth(?:orization)?[ _-]?key|session[ _-]?(?:id|key|token)|cookie|pin|'
  + 'contrase\u00f1a|clave|mot de passe|mdp|jeton|cl\u00e9 api|cl\u00e9 secr\u00e8te|passwort|kennwort|geheim(?:nis)?|schl\u00fcssel|senha|palavra-passe|chave|segredo|wachtwoord|geheim|l\u00f6senord|has\u0142o|parola|heslo|salasana|jelsz\u00f3)';
const KW_OTHER = '(?:\u5bc6\u7801|\u5bc6\u78bc|\u53e3\u4ee4|\u79d8\u5bc6|\u79d8\u9470|\u4ee4\u724c|\u91d1\u94a5|\u91d1\u9470|\u30d1\u30b9\u30ef\u30fc\u30c9|\u6697\u8a3c\u756a\u53f7|\u30c8\u30fc\u30af\u30f3|\u79d8\u5bc6\u9375|'
  + '\u043f\u0430\u0440\u043e\u043b\u044c|\u0442\u043e\u043a\u0435\u043d|\u0441\u0435\u043a\u0440\u0435\u0442|\u043a\u043b\u044e\u0447|'
  + '\ube44\ubc00\ubc88\ud638|\uc554\ud638|\ud1a0\ud070|\ube44\ubc00\ud0a4|'
  + '\u0643\u0644\u0645\u0629 \u0627\u0644\u0633\u0631|\u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631|\u0631\u0645\u0632|\u0e23\u0e2b\u0e31\u0e2a\u0e1c\u0e48\u0e32\u0e19|\u092a\u093e\u0938\u0935\u0930\u094d\u0921|\u03ba\u03c9\u03b4\u03b9\u03ba\u03cc\u03c2|\u05e1\u05d9\u05e1\u05de\u05d4|\u015fifre|\u0432\u0430\u0448 \u043f\u0430\u0440\u043e\u043b\u044c)';
const CONNECTOR = '(?:is|was|are|es|est|ist|\u00e9|\u00e4r|jest|is:|es:|ist:)';
const VALUE = `["'\`\u201c\u2018]?([^\\s"'\`\u201d\u2019,;\u3001\u3002\uff0c]{4,200})`;
// keyword (optionally embedded in an identifier such as DB_PASSWORD or clientSecret), then = or : or a connector word, then the value
const KEYED_LATIN_RE = new RegExp(`(?<![A-Za-z])((?:[A-Za-z0-9_.-]{0,40})${KW_LATIN}(?:[A-Za-z0-9_.-]{0,40}))(["'\`]?\\s*(?:[:=]|=>|\\s${CONNECTOR}\\s)\\s*)${VALUE}`, 'giu');
const KEYED_OTHER_RE = new RegExp(`(${KW_OTHER})(\\s*(?:[:=]|\\s${CONNECTOR}\\s|\u662f|\u70ba|\u4e3a|\u306f|\u306f:|\u0e04\u0e37\u0e2d)\\s*)${VALUE}`, 'gu');
const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}/g;
const CARD_CANDIDATE_RE = /(?<![\d])(?:\d[ -]?){12,18}\d(?![\d])/g;
const SSN_RE = /(?<![\d-])\d{3}-\d{2}-\d{4}(?![\d-])/g;
const IBAN_RE = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{2,4}){3,8}\b/g;
const PHONE_RE = /(?<![\w.])(?:\+\d|\(\d)[\d ().-]{7,18}\d(?![\w])|(?<![\w.+-])\d{2,4}[ .-]\d{2,4}[ .-]\d{3,4}(?:[ .-]\d{2,4})?(?![\w.-])/g;
const IPV4_RE = /(?<![\d.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![\d.])/g;
const IPV6_CANDIDATE_RE = /(?<![A-Za-z0-9:.])[0-9A-Fa-f:]{5,45}(?![A-Za-z0-9:.])/g;
const HOME_UNIX_RE = /(\/(?:Users|home)\/)[^/\s\\:*?"<>|]{1,64}/g;
const HOME_WIN_RE = /([A-Za-z]:[\\/]Users[\\/])[^\\/\s:*?"<>|]{1,64}/gi;
const ENTROPY_CANDIDATE_RE = /[A-Za-z0-9+/_=-]{24,512}/g;

/** Loose IPv6 check: groups of 1-4 hex digits, either exactly 8 groups or one "::"; requires a digit so words and C++ scopes are mostly left alone. */
const isIpv6 = (m: string): boolean => {
  if (!/\d/.test(m) || (m.match(/::/g) ?? []).length > 1 || m.includes(':::')) return false;
  const groups = m.split(':').filter((g) => g.length > 0);
  if (groups.some((g) => g.length > 4)) return false;
  return m.includes('::') ? groups.length >= 2 && groups.length <= 7 : groups.length === 8 && m.split(':').length === 8;
};
const luhn = (digits: string): boolean => {
  let sum = 0; let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) { let d = digits.charCodeAt(i) - 48; if (alt) { d *= 2; if (d > 9) d -= 9; } sum += d; alt = !alt; }
  return sum % 10 === 0;
};
const ibanOk = (raw: string): boolean => {
  const s = raw.replace(/ /g, '');
  if (s.length < 15 || s.length > 34) return false;
  const re = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of re) { const v = ch >= 'A' ? ch.charCodeAt(0) - 55 : ch.charCodeAt(0) - 48; rem = (v > 9 ? rem * 100 + v : rem * 10 + v) % 97; }
  return rem === 1;
};
export const shannonEntropy = (s: string): number => {
  const f = new Map<string, number>();
  for (const ch of s) f.set(ch, (f.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of f.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
};
/** A long run that looks random: both letters and digits, enough distinct characters, high entropy; or a long pure-hex run. */
function looksRandom(tok: string): boolean {
  if (/^\[?REDACTED/.test(tok)) return false;
  const hasDigit = /\d/.test(tok), hasLetter = /[A-Za-z]/.test(tok);
  if (/^[0-9a-fA-F]{32,}$/.test(tok)) return new Set(tok).size >= 8; // md5/sha digests, hex keys (over-masks commit ids deliberately)
  if (!hasDigit || !hasLetter) return false;
  if (new Set(tok).size < 10) return false;
  return shannonEntropy(tok) >= 3.5;
}

/** Applies every rule once, in order. Counts redactions per category. Idempotent: a placeholder is never re-matched into a longer one. */
function redact(text: string, counts: Partial<Record<MaskCategory, number>>): string {
  const bump = (c: MaskCategory) => { counts[c] = (counts[c] ?? 0) + 1; };
  const sub = (s: string, re: RegExp, c: MaskCategory, fn?: (m: string, ...g: string[]) => string | null): string =>
    s.replace(re, (m: string, ...g: unknown[]) => {
      if (PLACEHOLDER_RE.test(m) && !fn) return m;
      const out = fn ? fn(m, ...(g as string[])) : PH(c);
      if (out === null) return m;
      bump(c); return out;
    });
  let s = text;
  s = sub(s, PRIVATE_KEY_RE, 'PRIVATE_KEY');
  s = sub(s, URL_CRED_RE, 'URL_CREDENTIALS');
  s = sub(s, JWT_RE, 'JWT');
  for (const re of TOKEN_PATTERNS) s = sub(s, re, 'TOKEN');
  s = sub(s, AUTH_HEADER_RE, 'AUTH_HEADER', (_m, name, sep, value) => (PLACEHOLDER_RE.test(value) ? null : `${name}${sep}${PH('AUTH_HEADER')}`));
  s = sub(s, BEARER_RE, 'AUTH_HEADER', (m) => (PLACEHOLDER_RE.test(m) ? null : PH('AUTH_HEADER')));
  s = sub(s, URL_SECRET_PARAM_RE, 'SECRET_VALUE', (_m, prefix) => `${prefix}${PH('SECRET_VALUE')}`);
  const keyed = (_m: string, key: string, sep: string, value: string) => (value.startsWith('[REDACTED:') ? null : `${key}${sep}${PH('SECRET_VALUE')}`);
  s = sub(s, KEYED_LATIN_RE, 'SECRET_VALUE', keyed);
  s = sub(s, KEYED_OTHER_RE, 'SECRET_VALUE', keyed);
  s = sub(s, EMAIL_RE, 'EMAIL');
  s = sub(s, CARD_CANDIDATE_RE, 'CARD', (m) => { const d = m.replace(/[ -]/g, ''); return d.length >= 13 && d.length <= 19 && luhn(d) ? PH('CARD') : null; });
  s = sub(s, SSN_RE, 'ID_NUMBER');
  s = sub(s, IBAN_RE, 'IBAN', (m) => (ibanOk(m) ? PH('IBAN') : null));
  s = sub(s, PHONE_RE, 'PHONE', (m) => { const n = m.replace(/\D/g, '').length; return n >= 9 && n <= 15 ? PH('PHONE') : null; });
  s = sub(s, IPV4_RE, 'IP_ADDRESS');
  s = sub(s, IPV6_CANDIDATE_RE, 'IP_ADDRESS', (m) => (isIpv6(m) ? PH('IP_ADDRESS') : null));
  s = sub(s, HOME_UNIX_RE, 'USER_NAME', (m, p) => (m.endsWith('[USER]') ? null : `${p}[USER]`));
  s = sub(s, HOME_WIN_RE, 'USER_NAME', (m, p) => (m.endsWith('[USER]') ? null : `${p}[USER]`));
  s = sub(s, ENTROPY_CANDIDATE_RE, 'HIGH_ENTROPY', (m) => (looksRandom(m) ? PH('HIGH_ENTROPY') : null));
  return s;
}

/** High-confidence families that must NOT survive. If any still matches after redaction, the text is withheld entirely (fail closed). */
const VERIFY_RES: readonly RegExp[] = [PRIVATE_KEY_RE, JWT_RE, URL_CRED_RE, ...TOKEN_PATTERNS, BEARER_RE];
export const survivesMasking = (s: string): boolean => VERIFY_RES.some((re) => { re.lastIndex = 0; const hit = re.test(s); re.lastIndex = 0; return hit; });

export interface MaskResult {
  /** Masked text, at most `maxChars` code points. Empty when withheld. */
  readonly maskedText: string;
  readonly redactions: number;
  readonly categories: Readonly<Partial<Record<MaskCategory, number>>>;
  /** The output was cut to the character limit or the input was cut at the input bound. */
  readonly truncated: boolean;
  /** The verification pass still found a high-confidence secret; nothing is returned. */
  readonly withheld: boolean;
}

const WITHHELD: MaskResult = Object.freeze({ maskedText: '', redactions: 0, categories: Object.freeze({}), truncated: false, withheld: true });

function cutCodePoints(s: string, max: number): { text: string; cut: boolean } {
  if (s.length <= max) return { text: s, cut: false }; // UTF-16 length is an upper bound on code points
  const out: string[] = [];
  let n = 0;
  for (const ch of s) { if (n === max) break; out.push(ch); n++; }
  if (n < max || out.join('').length === s.length) return { text: out.join(''), cut: false };
  let t = out.join('');
  const lb = t.lastIndexOf('[');
  if (lb > t.lastIndexOf(']') && /^\[R?E?D?A?C?T?E?D?:?[A-Z_]*$/.test(t.slice(lb))) t = t.slice(0, lb); // never leave half a placeholder
  t = t.replace(/[\u200d\ufe0f\u0300-\u036f]+$/u, ''); // no dangling joiner or combining mark
  return { text: t, cut: true };
}

/** Masks, verifies, then cuts. `maxChars` defaults to the provisional snippet cap and can never exceed it. */
export function maskPromptText(input: unknown, maxChars: number = SNIPPET_MAX_CHARS): MaskResult {
  if (typeof input !== 'string') return WITHHELD;
  const max = Math.max(0, Math.min(Math.trunc(Number.isFinite(maxChars) ? maxChars : 0), SNIPPET_MAX_CHARS));
  const { text: normalized, cut: inputCut } = normalizeForMasking(input);
  const counts = COUNTS();
  return finalizeMasked(redact(normalized, counts), max, counts, inputCut);
}

/** Verification and cut, separate so the fail-closed step can be tested on text that redaction did not clean. */
export function finalizeMasked(masked: string, max: number, counts: Partial<Record<MaskCategory, number>>, inputCut: boolean): MaskResult {
  if (survivesMasking(masked)) return WITHHELD;
  
  const { text, cut } = cutCodePoints(masked, max);
  const categories = Object.freeze({ ...counts });
  return Object.freeze({ maskedText: text, redactions: Object.values(categories).reduce((a, b) => a + (b ?? 0), 0), categories, truncated: cut || inputCut, withheld: false });
}
