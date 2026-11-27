/**
 * P3-2: best-effort masking engine (lib/mcp/data/masking.ts). DB-free, no I/O. Not connected to any tool or query.
 * Secrets in this file are assembled at run time from fragments, so no real-looking credential is stored in the repository.
 * "Masked" here means "the pattern families listed in the module were redacted"; nothing in these tests proves, or claims, that no secret can survive.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { KNOWN_LIMITATIONS, finalizeMasked, MASK_INPUT_MAX_CHARS, maskPromptText, normalizeForMasking, shannonEntropy, survivesMasking } from '../lib/mcp/data/masking';
import { SNIPPET_MAX_CHARS } from '../lib/mcp/data/limits';

const j = (...p: string[]) => p.join('');
const rnd = (n: number, alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') => Array.from({ length: n }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
const mask = (s: string) => maskPromptText(s);
const out = (s: string) => mask(s).maskedText;
const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const cp = (s: string) => Array.from(s).length;

// deterministic fake secrets (distinct values so a leak is detectable by substring)
const S = {
  anthropic: j('sk-', 'ant-', 'api03-', rnd(40, 'abcdefghijklmnopqrstuvwxyz0123456789_-')),
  openai: j('sk-', 'proj-', rnd(44)),
  stripe: j('sk_', 'live_', rnd(28)),
  gh: j('ghp', '_', rnd(36)),
  ghpat: j('github', '_pat_', rnd(50)),
  aws: j('AKIA', rnd(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')),
  google: j('AIza', rnd(35, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-')),
  slack: j('xox', 'b-', rnd(12, '0123456789'), '-', rnd(24)),
  sendgrid: j('SG', '.', rnd(22), '.', rnd(43)),
  npm: j('npm', '_', rnd(36)),
  hf: j('hf', '_', rnd(34)),
  own: j('tt', '_at_', rnd(43, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-')),
  jwt: j('eyJ', 'hbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', rnd(43, 'abcdefghijklmnopqrstuvwxyz0123456789_-')),
  pem: j('-----BEGIN ', 'RSA PRIVATE KEY-----\n', rnd(64), '\n', rnd(64), '\n-----END ', 'RSA PRIVATE KEY-----'),
  entropy: j('Zk3', rnd(40)),
  pw: j('Tr0ub4dor', '&3x', rnd(4)),
};
const leaks = (output: string, secret: string) => output.includes(secret) || (secret.length >= 12 && output.includes(secret.slice(4, 4 + Math.min(12, secret.length - 8))));

describe('masking: best-effort, and says so', () => {
  it('the module and its limitation list describe masking as best-effort and never as a guarantee', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'lib/mcp/data/masking.ts'), 'utf8');
    assert.match(src, /BEST-EFFORT/);
    for (const m of src.matchAll(/\bguarantee[sd]?\b/gi)) assert.match(src.slice(Math.max(0, m.index - 160), m.index), /\b(not|no|never|cannot)\b[^.]*$/i, `unqualified "guarantee" near: ${src.slice(m.index - 40, m.index + 20)}`);
    assert.ok(KNOWN_LIMITATIONS.length >= 6 && Object.isFrozen(KNOWN_LIMITATIONS));
    assert.ok(KNOWN_LIMITATIONS.some((l) => /personal names/i.test(l)) && KNOWN_LIMITATIONS.some((l) => /split/i.test(l)));
  });
  it('the listed limitations are REAL: these things survive masking (so the list is honest)', () => {
    assert.ok(out(`please email ${j('Maria', ' Gonz\u00e1lez')} at her office on Main Street`).includes('Maria'), 'names are not detected');
    const spaced = j('s k - l i v e - ', rnd(24));
    assert.ok(out(spaced).includes('s k - l i v e'), 'secrets split by spaces are not recognised');
    assert.ok(out('the launch code is correct horse battery staple').includes('horse'), 'only the first word after a keyword');
    assert.ok(out(`my project is called ${'Nightingale'} and ships in March`).includes('Nightingale'), 'project names are not detected');
  });
  it('rejects non-strings and bad caps safely', () => {
    for (const bad of [undefined, null, 5, {}, [], true, () => 1]) assert.equal(maskPromptText(bad).withheld, true);
    assert.equal(maskPromptText('hello', 0).maskedText, '');
    assert.equal(maskPromptText('hello', Number.NaN).maskedText, '');
    assert.equal(maskPromptText('x'.repeat(5000), 1_000_000).maskedText.length <= SNIPPET_MAX_CHARS, true, 'the cap cannot be raised above the snippet limit');
    assert.equal(maskPromptText('x'.repeat(5000), -5).maskedText, '');
  });
});

describe('positive corpus: pattern families are redacted', () => {
  const cases: Array<[string, string, string]> = [
    ['anthropic key', `use ${S.anthropic} for the call`, S.anthropic], ['openai project key', `OPENAI=${S.openai}`, S.openai], ['stripe secret', `stripe key ${S.stripe}!`, S.stripe],
    ['github token', `git clone https://x@github.com with ${S.gh}`, S.gh], ['github fine-grained', S.ghpat, S.ghpat], ['aws access key id', `AWS id ${S.aws}`, S.aws],
    ['google api key', `key: ${S.google}`, S.google], ['slack token', S.slack, S.slack], ['sendgrid', S.sendgrid, S.sendgrid], ['npm token', `//registry:_authToken=${S.npm}`, S.npm],
    ['huggingface', S.hf, S.hf], ['own access token', `my token ${S.own} stopped working`, S.own], ['jwt', `jwt ${S.jwt}`, S.jwt],
    ['pem block', `here is my key:\n${S.pem}\nthanks`, rnd(1) && S.pem.split('\n')[1]], ['pem without END (truncated paste)', `${S.pem.split('-----END')[0]}`, S.pem.split('\n')[1]],
    ['url credentials', `postgres://admin:${S.pw}@db.internal.example:5432/prod`, S.pw], ['url credentials, odd scheme', `amqps://svc:${S.pw}@mq.example/vhost`, S.pw],
    ['authorization header', `curl -H "Authorization: Bearer ${S.entropy}" https://x`, S.entropy], ['basic auth', `Authorization: Basic ${rnd(24)}==`, 'Basic '], ['cookie header', `Cookie: session=${S.entropy}; theme=dark`, S.entropy],
    ['x-api-key', `x-api-key: ${S.entropy}`, S.entropy], ['query secret', `https://api.example/v1/x?user=1&api_key=${S.entropy}&page=2`, S.entropy], ['signature param', `https://s3.example/o?X-Amz-Signature=${S.entropy}`, S.entropy],
    ['env assignment', `DB_PASSWORD=${S.pw}`, S.pw], ['env assignment quoted', `export CLIENT_SECRET="${S.pw}"`, S.pw], ['json', `{"password": "${S.pw}", "user": "a"}`, S.pw], ['yaml', `api_key: ${S.entropy}`, S.entropy],
    ['camelCase', `const clientSecret = '${S.pw}';`, S.pw], ['prose', `my password is ${S.pw} ok`, S.pw], ['prose, token', `the api key is ${S.entropy}`, S.entropy],
    ['high-entropy blob', `config value ${S.entropy} was copied`, S.entropy], ['hex digest', `sha ${crypto.randomBytes(32).toString('hex')}`, ''], ['email', 'write to jane.doe+work@example-corp.co.uk please', 'jane.doe'],
    ['visa card', 'card 4111 1111 1111 1111 exp 12/29', '4111 1111'], ['card dashes', 'card 5555-5555-5555-4444', '5555-5555'], ['card plain', 'pan 4012888888881881', '4012888888881881'],
    ['ssn', 'ssn 078-05-1120 on file', '078-05-1120'], ['iban', 'pay to DE89 3704 0044 0532 0130 00 today', '0532 0130'], ['iban compact', 'GB82WEST12345698765432', 'WEST1234'],
    ['phone intl', 'call +44 20 7946 0958 now', '7946 0958'], ['phone us', 'reach me at (415) 555-0132', '555-0132'], ['phone plain separators', 'tel 415-555-0132', '555-0132'],
    ['ipv4', 'server at 203.0.113.42 refused', '203.0.113.42'], ['ipv6', 'host 2001:db8:85a3::8a2e:370:7334 down', '8a2e:370'], ['unix home', 'open /Users/alice.smith/work/app/src/a.ts', 'alice.smith'],
    ['linux home', 'cd /home/bob_the_builder/proj', 'bob_the_builder'], ['windows home', 'C:\\Users\\Carol Jones\\Desktop', 'Carol'],
  ];
  for (const [name, input, needle] of cases) {
    it(name, () => {
      const r = mask(input);
      assert.equal(r.withheld, false); assert.ok(r.redactions >= 1, `nothing redacted in: ${name}`); assert.match(r.maskedText, /\[REDACTED:[A-Z_]+\]|\[USER\]/);
      if (needle) assert.ok(!leaks(r.maskedText, needle), `leaked "${needle.slice(0, 12)}…" in: ${r.maskedText.slice(0, 200)}`);
    });
  }
  it('keyed values keep the key (so the text stays readable) and drop the value; a Windows home keeps its structure', () => {
    assert.equal(out(`password=${S.pw}`), 'password=[REDACTED:SECRET_VALUE]');
    assert.equal(out('open /Users/alice/x.ts'), 'open /Users/[USER]/x.ts');
    assert.equal(out('C:\\Users\\Carol\\a.txt'), 'C:\\Users\\[USER]\\a.txt');
  });
  it('categories are counted and the total matches', () => {
    const r = mask(`mail a@b.example, ip 203.0.113.9, key ${S.anthropic}`);
    assert.equal(r.categories.EMAIL, 1); assert.equal(r.categories.IP_ADDRESS, 1); assert.equal(r.categories.TOKEN, 1);
    assert.equal(r.redactions, Object.values(r.categories).reduce((a, b) => a + (b ?? 0), 0));
  });
});

describe('multilingual and mixed-script inputs', () => {
  const v = S.pw;
  const cases: Array<[string, string]> = [
    ['Spanish', `mi contrase\u00f1a es ${v} gracias`], ['Spanish colon', `contrase\u00f1a: ${v}`], ['French', `mon mot de passe est ${v}`], ['German', `das Passwort ist ${v}`], ['German colon', `Passwort: ${v}`],
    ['Portuguese', `minha senha: ${v}`], ['Italian-ish keyword', `password = ${v}`], ['Dutch', `wachtwoord: ${v}`], ['Swedish', `l\u00f6senord: ${v}`], ['Polish', `has\u0142o: ${v}`], ['Turkish', `\u015fifre: ${v}`],
    ['Russian', `\u043c\u043e\u0439 \u043f\u0430\u0440\u043e\u043b\u044c: ${v}`], ['Russian token', `\u0442\u043e\u043a\u0435\u043d = ${v}`], ['Chinese simplified', `\u5bc6\u7801\uff1a${v}`], ['Chinese ascii colon', `\u5bc6\u7801: ${v}`], ['Chinese traditional', `\u5bc6\u78bc\uff1a${v}`],
    ['Chinese with copula', `\u5bc6\u7801\u662f ${v}`], ['Japanese', `\u30d1\u30b9\u30ef\u30fc\u30c9\uff1a${v}`], ['Japanese particle', `\u30d1\u30b9\u30ef\u30fc\u30c9\u306f ${v}`], ['Korean', `\ube44\ubc00\ubc88\ud638: ${v}`],
    ['Arabic', `\u0643\u0644\u0645\u0629 \u0627\u0644\u0633\u0631: ${v}`], ['Hindi', `\u092a\u093e\u0938\u0935\u0930\u094d\u0921: ${v}`], ['Thai', `\u0e23\u0e2b\u0e31\u0e2a\u0e1c\u0e48\u0e32\u0e19: ${v}`], ['Greek', `\u03ba\u03c9\u03b4\u03b9\u03ba\u03cc\u03c2: ${v}`], ['Hebrew', `\u05e1\u05d9\u05e1\u05de\u05d4: ${v}`],
    ['mixed language sentence', `Hi team, \u8bf7\u4f7f\u7528 token: ${v} \u8c22\u8c22, merci`],
  ];
  for (const [name, input] of cases) it(`secret after a ${name} keyword is redacted`, () => { const r = mask(input); assert.ok(!r.maskedText.includes(v) && !r.maskedText.includes(v.slice(0, 9)), `leaked: ${r.maskedText}`); assert.ok(r.redactions >= 1, name); });
  it('ordinary non-Latin prose with no secret is preserved, including emoji and combining marks', () => {
    for (const t of ['\u4eca\u5929\u6211\u4eec\u4fee\u590d\u4e86\u767b\u5f55\u9875\u9762\u7684\u9519\u8bef', '\u30ed\u30b0\u30a4\u30f3\u30da\u30fc\u30b8\u306e\u30d0\u30b0\u3092\u4fee\u6b63\u3057\u3066\u304f\u3060\u3055\u3044', '\u041f\u043e\u0436\u0430\u043b\u0443\u0439\u0441\u0442\u0430, \u0438\u0441\u043f\u0440\u0430\u0432\u044c\u0442\u0435 \u043e\u0448\u0438\u0431\u043a\u0443', '\ud654\uba74\uc744 \uace0\uccd0 \uc8fc\uc138\uc694', '\u0627\u0635\u0644\u062d \u0627\u0644\u062e\u0637\u0623 \u0645\u0646 \u0641\u0636\u0644\u0643', 'caf\u00e9 cr\u00e8me br\u00fbl\u00e9e \ud83d\ude80 fix the layout', 'e\u0301 combined']) assert.equal(out(t), t.normalize('NFKC'), t);
  });
});

describe('evasion attempts', () => {
  it('full-width and compatibility forms are folded before matching', () => {
    const fw = (s: string) => Array.from(s).map((c) => (c >= '!' && c <= '~' ? String.fromCharCode(c.charCodeAt(0) + 0xfee0) : c)).join('');
    assert.ok(!out(fw(`password=${S.pw}`)).includes(S.pw.slice(0, 6)) && out(fw(`password=${S.pw}`)).includes('REDACTED'));
    assert.ok(!out(fw(S.anthropic)).includes(S.anthropic.slice(8, 20)));
    assert.ok(!out(fw('email bob@example.com')).includes('bob@'));
  });
  it('zero-width, soft-hyphen, bidi and tag characters inserted inside a secret do not hide it', () => {
    for (const ch of ['\u200b', '\u200c', '\u200d', '\u2060', '\ufeff', '\u00ad', '\u202e', '\u2066', '\u{e0041}', '\ufe0f']) {
      const hidden = S.anthropic.split('').join(ch);
      const r = mask(`key ${hidden}`); assert.ok(!r.maskedText.includes(S.anthropic.slice(10, 24)), JSON.stringify(ch)); assert.ok(r.redactions >= 1, JSON.stringify(ch));
      assert.ok(!INVIS.test(r.maskedText), 'invisible characters are removed from the output');
    }
  });
  it('percent-encoded secrets are decoded before matching', () => {
    const enc = Array.from(Buffer.from(S.anthropic)).map((b) => `%${b.toString(16).padStart(2, '0')}`).join('');
    const r = mask(`token ${enc}`); assert.ok(!r.maskedText.includes(S.anthropic.slice(10, 24)) && !r.maskedText.toLowerCase().includes(enc.slice(0, 18).toLowerCase()), r.maskedText);
    assert.equal(mask('100%25 sure, 50% done').withheld, false); // malformed or incidental percent signs are harmless
    assert.doesNotThrow(() => mask('%E0%A4%A %ZZ %'));
  });
  it('mixed case keywords, odd spacing and quotes do not hide keyed values', () => {
    for (const t of [`PASSWORD=${S.pw}`, `PassWord : ${S.pw}`, `"Password":"${S.pw}"`, `'api_key' = '${S.pw}'`, `API-KEY=${S.pw}`, `apiKey: "${S.pw}"`, `secret_token=${S.pw}`, `my_Secret => ${S.pw}`]) assert.ok(!out(t).includes(S.pw.slice(0, 8)), t);
  });
  it('a secret inside a markdown fence, a diff or a stack trace line is still found', () => {
    for (const t of ['```env\nDB_PASSWORD=' + S.pw + '\n```', `+ const key = "${S.anthropic}";`, `    at connect (db.js:12) postgres://u:${S.pw}@h/db`, `> quoted: ${S.gh}`]) assert.ok(!leaks(out(t), t.includes(S.pw) ? S.pw : t.includes(S.gh) ? S.gh : S.anthropic), t);
  });
  it('control characters cannot be used to break a pattern or smuggle text', () => {
    const r = mask(`pass\u0000word=${S.pw}\u0007`); assert.ok(!r.maskedText.includes(S.pw.slice(0, 8)));
    assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/.test(r.maskedText));
  });
  it('a literal placeholder in the input is harmless and masking is idempotent over the whole corpus', () => {
    assert.equal(out('see [REDACTED:EMAIL] here'), 'see [REDACTED:EMAIL] here');
    const corpus = [`password=${S.pw}`, `mail a@b.example ip 203.0.113.9 ${S.anthropic}`, `Authorization: Bearer ${S.entropy}`, S.pem, `/Users/zed/x`, `\u5bc6\u7801\uff1a${S.pw}`, 'plain words only', `postgres://a:${S.pw}@h/d`, `card 4111111111111111`];
    for (const c of corpus) { const once = out(c); assert.equal(out(once), once, c); }
  });
});

describe('false positives that must NOT be redacted (readability of ordinary prompts)', () => {
  const keep = [
    'Fix the login bug in src/auth/login.ts line 42', 'bump react from 18.2.0 to 18.3.1', 'on 2026-11-26 at 12:30 the build failed', 'why does getUserById(42) return null?',
    'add a unit test for parseWindow() with 7 days', 'run `npm run test:unit -- --test-concurrency=1`', 'the function returns 3.14159 for pi', 'items: 12, 345, 6789', 'ratio 0.75 and 1,000 requests', 'use camelCaseIdentifierNames everywhere',
    'refactor the PasswordResetForm component layout', 'rename variable tokenCount to tokensUsed', 'this keyboard has a key that sticks', 'the access token expiry should be 15 minutes', 'explain how secrets managers work',
  ];
  for (const t of keep) it(`keeps: ${t.slice(0, 50)}`, () => assert.equal(out(t), t));
  it('does not treat numbers, versions or short digit groups as phones or cards', () => {
    for (const t of ['1234567', '12-34-56', 'v1.2.3.4', '2026-11-26', '3.141592653', 'line 1000 col 20', '1.2.3.4.5']) assert.ok(!out(t).includes('REDACTED:PHONE') && !out(t).includes('REDACTED:CARD'), t);
    assert.ok(!out('4111 1111 1111 1112').includes('CARD'), 'fails Luhn');
    assert.ok(!out('DE89 3704 0044 0532 0130 01').includes('IBAN'), 'fails mod 97');
  });
  it('low-entropy long strings and plain words are kept', () => { for (const t of ['a'.repeat(40), 'abababababababababababababababab', 'ThisIsAVeryLongButEntirelyOrdinaryIdentifierName', 'a-very-long-kebab-case-name-that-is-plain-words']) assert.equal(out(t), t); });
  it('shannonEntropy behaves', () => { assert.equal(shannonEntropy('aaaa'), 0); assert.ok(shannonEntropy(rnd(64)) > 4.5); });
});

describe('fail closed and bounded output', () => {
  it('survivesMasking recognises each high-confidence family, so the verification pass has teeth', () => {
    for (const x of [S.anthropic, S.gh, S.aws, S.jwt, S.pem, `postgres://u:${S.pw}@h/d`, `Bearer ${S.entropy}`]) assert.equal(survivesMasking(x), true, x.slice(0, 16));
    for (const x of ['plain text', '[REDACTED:TOKEN]', 'password=[REDACTED:SECRET_VALUE]']) assert.equal(survivesMasking(x), false, x);
    for (const x of [S.anthropic, S.gh, S.aws, S.jwt, S.pem, `postgres://u:${S.pw}@h/d`, `Bearer ${S.entropy}`]) assert.equal(survivesMasking(out(x)), false, 'the masked output of every family passes verification');
  });
  it('FAIL CLOSED: text that still holds a high-confidence secret is withheld whole, with nothing returned', () => {
    for (const x of [`ok ${S.anthropic}`, `ok ${S.gh}`, `ok ${S.pem}`, `ok postgres://u:${S.pw}@h/d`]) { const r = finalizeMasked(x, 1000, {}, false); assert.equal(r.withheld, true); assert.equal(r.maskedText, ''); assert.equal(r.redactions, 0); }
    assert.equal(finalizeMasked('clean text', 1000, {}, false).withheld, false);
  });
  it('the output never exceeds the cap, counted in code points, and never splits a surrogate pair', () => {
    for (const unit of ['a', '\u4e2d', '\ud83d\ude80', 'e\u0301', '\u00e9\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67']) {
      for (const n of [999, 1000, 1001, 1002, 1500, 5000]) { const r = maskPromptText(unit.repeat(n)); assert.ok(cp(r.maskedText) <= SNIPPET_MAX_CHARS, `${JSON.stringify(unit)}x${n}`); assert.ok(!lone.test(r.maskedText)); }
    }
    assert.equal(maskPromptText('\ud83d\ude80'.repeat(2000)).truncated, true); assert.equal(maskPromptText('short').truncated, false);
    assert.ok(cp(maskPromptText('x'.repeat(5000), 300).maskedText) <= 300);
  });
  it('a secret straddling the cut is masked BEFORE cutting, so no recognisable prefix is left', () => {
    for (const offset of [960, 980, 990, 995, 998, 1000]) {
      const text = `${'w'.repeat(offset)} ${S.anthropic} tail`;
      const r = mask(text); assert.ok(!r.maskedText.includes(S.anthropic.slice(0, 10)) && !r.maskedText.includes('sk-ant'), `offset ${offset}`);
    }
  });
  it('the cut never leaves half a placeholder', () => {
    for (let pad = 970; pad <= 1000; pad++) { const r = mask(`${'a b '.repeat(pad / 4 | 0)}${'w'.repeat(pad % 4)} mail x@y.example more`); const t = r.maskedText; const lb = t.lastIndexOf('['); assert.ok(lb === -1 || t.lastIndexOf(']') > lb, `pad ${pad}: ${t.slice(-30)}`); }
  });
  it('very long input is bounded and cut at a token boundary, never mid-secret', () => {
    const r = normalizeForMasking(`${'word '.repeat(10000)}${S.anthropic}`); assert.equal(r.cut, true); assert.ok(r.text.length <= MASK_INPUT_MAX_CHARS);
    const edge = `${'x '.repeat(MASK_INPUT_MAX_CHARS / 2 - 5)}${S.anthropic}`; const m = maskPromptText(edge);
    assert.ok(!m.maskedText.includes('sk-ant') && !m.maskedText.includes(S.anthropic.slice(0, 12)));
    const noSpace = normalizeForMasking('z'.repeat(MASK_INPUT_MAX_CHARS * 2)); assert.ok(noSpace.text.length <= MASK_INPUT_MAX_CHARS - 500);
  });
});

describe('robustness: no pathological cost, no throw', () => {
  const INPUT_CASES: Array<[string, string]> = [
    ['100k a', 'a'.repeat(100_000)], ['sk- repeated', 'sk-'.repeat(20_000)], ['password= repeated', 'password='.repeat(5_000)], ['BEGIN KEY repeated', '-----BEGIN PRIVATE KEY-----'.repeat(2_000)], ['@ repeated', 'a@'.repeat(30_000)],
    ['digits and spaces', '1 '.repeat(30_000)], ['colons', ':'.repeat(50_000)], ['dots', '1.'.repeat(30_000)], ['percent runs', '%41'.repeat(30_000)], ['percent junk', '%'.repeat(50_000)], ['://', 'a://b:'.repeat(8_000)],
    ['long word then colon', `${'p'.repeat(40)}assword ${'x'.repeat(8_000)}`], ['keyword chains', 'secret'.repeat(6_000)], ['quotes', '"\''.repeat(30_000)], ['tag block', '\u{e0041}'.repeat(30_000)], ['emoji', '\ud83d\ude80'.repeat(50_000)],
    ['entropy-like', rnd(60_000)], ['hex', 'abcdef0123456789'.repeat(5_000)], ['ipv6-ish', 'ab:'.repeat(20_000)], ['IBAN-ish', 'DE89 3704 '.repeat(8_000)], ['Authorization repeated', 'authorization:'.repeat(4_000)], ['bearer repeated', 'bearer '.repeat(8_000)],
  ];
  for (const [name, input] of INPUT_CASES) it(`bounded time and output: ${name}`, () => {
    const t0 = process.hrtime.bigint(); const r = maskPromptText(input); const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 1500, `${name} took ${ms.toFixed(0)} ms`); assert.ok(cp(r.maskedText) <= SNIPPET_MAX_CHARS); assert.ok(!lone.test(r.maskedText));
  });
  it('FUZZ: random Unicode never throws, always respects the cap, never contains invisible or control characters, and always masks a planted secret', () => {
    const pools = ['abcdefghijklmnopqrstuvwxyz ', '0123456789 -.:/@=', '\u4e2d\u6587\u65e5\u672c\u8a9e\ud55c\uad6d\u0627\u0644\u0639\u0631\u0628\u064a\u0629 ', '\u200b\u200d\u202e\u2066\ufeff\u0000\u0007', '\ud83d\ude80\ud83d\udc68\u200d\ud83d\udc69', '[]{}()"\'`<>\\%&?#!'];
    for (let i = 0; i < 400; i++) {
      const body = Array.from({ length: crypto.randomInt(0, 400) }, () => { const p = pools[crypto.randomInt(pools.length)]; return Array.from(p)[crypto.randomInt(Array.from(p).length)]; }).join('');
      const planted = i % 2 === 0; const secret = j('sk-', 'ant-', rnd(32));
      const r = mask(planted ? `${body} ${secret} ${body}` : body);
      assert.ok(cp(r.maskedText) <= SNIPPET_MAX_CHARS); assert.ok(!INVIS.test(r.maskedText)); assert.ok(!lone.test(r.maskedText));
      if (planted) assert.ok(!r.maskedText.includes(secret.slice(6)) && (r.withheld || r.redactions >= 1), `planted secret survived in iteration ${i}`);
    }
  });
});

describe('the engine stays isolated', () => {
  const dir = path.join(process.cwd(), 'lib/mcp/data');
  const src = fs.readFileSync(path.join(dir, 'masking.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  it('imports only ./limits; no environment, I/O, logging, network or dynamic code', () => {
    assert.deepEqual([...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]), ['./limits']);
    assert.doesNotMatch(src, /process\.|console\.|fetch\(|require\(|eval\(|new Function|readFile|child_process|Math\.random|setTimeout/);
  });
  it('is used by nothing yet: no tool, route, query or other module imports it (no application integration in P3-2)', () => {
    const walk = (d: string): string[] => fs.readdirSync(path.join(process.cwd(), d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : /\.(ts|tsx|mjs)$/.test(e.name) ? [`${d}/${e.name}`] : []));
    const users = [...walk('app'), ...walk('lib')].filter((f) => f !== 'lib/mcp/data/masking.ts' && /from\s+['"][^'"]*masking['"]/.test(fs.readFileSync(path.join(process.cwd(), f), 'utf8')));
    assert.deepEqual(users, []);
  });
  it('its own secret-like words appear only as patterns, never as a stored credential: no real-looking key in this test file', () => {
    const t = fs.readFileSync(path.join(process.cwd(), 'tests/mcp-masking.test.ts'), 'utf8');
    assert.doesNotMatch(t, /sk-ant-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----\n[A-Za-z0-9+/]{20,}/);
  });
});

const INVIS = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufe00-\ufe0f]|[\u{e0000}-\u{e007f}]/u;
