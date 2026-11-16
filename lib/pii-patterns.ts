// Personal-data shapes in text (track M, M6d): Korean resident and business registration numbers,
// payment cards, phone numbers, email addresses, and the secrets of lib/secret-patterns.ts. The
// records goodboy writes (lib/record-sanitize.ts) pass their text through `redactText`; M6f's
// commit scan reuses `findSensitive` (kind and offsets, never the value).
//
// Rules (each one scans the text once, or once per anchor, with bounded repeats: a record can hold a
// megabyte of suite output, and the cost tests of tests/m6d-detectors.test.ts pin it):
//   - A digit shape is bounded by non-digits on both sides (a longer digit run is no match).
//   - resident-number: YYMMDD, a gap (nothing, one space or dot, or a hyphen, also padded with spaces), a gender
//     digit 1-8, six digits, a real month and day (Feb 29 allowed). The old check digit is not required:
//     numbers issued since 2020-10 have none.
//   - business-number: 3-2-5 digits, hyphens or none, first digit not 0, middle not 00, and the
//     business-number check digit.
//   - card: 13-19 digits (a grouped run is cut to its longest 19-digit-or-shorter card prefix), single
//     spaces, dots or hyphens between groups, Luhn and a known issuer prefix (Visa, Mastercard, Amex,
//     Discover, JCB, UnionPay, Korean 9; not Diners Club 36, 38, 300-305 or Maestro).
//   - phone: Korean mobile (01[016789]), area codes (02, 03x-06x, 070, 050x), `+82` forms (also
//     `+82 (0)10`), a parenthesized area code (`(02) 123-4567`), gaps of one hyphen or dot with a space
//     on either side.
//   - email: local@domain.tld with letters, digits and marks of any script (Hangul local parts and IDN
//     domains count); the top level is two letters or more and no common file extension (`logo@2x.png`),
//     and a call (`@app.route(`) or an escaped newline before a word (`\n@app.route`) is no address. Not an
//     address either: a domain under the reserved example.com, example.net, example.org or the TLDs
//     .example, .invalid, .test, .localhost (or `localhost`), and the `git@host:path` of an ssh remote.
//   - secret: SECRET_PATTERNS; a PEM private key is covered to its END line, found once for the BEGIN
//     lines of one stretch.
// Stated limits: about 3% of the 13-digit epoch-millisecond numbers of 2001-2024 (measured by sampling)
// read as an unhyphenated resident number, and a bare 10-digit number can pass the business-number
// check; both are redacted (the safe side). Digits are read after folding full-width and Arabic-Indic
// digits, the dash and at-sign look-alikes and the no-break and thin spaces to ASCII, so those
// spellings do not slip past. Not found: a card with other separators (two spaces, an underscore), and
// an email whose top level is a file extension that is no delegated domain (`name@corp.js`).

import { PEM_PRIVATE_KEY_BEGIN, SECRET_PATTERNS } from './secret-patterns';

export type SensitiveKind = 'resident-number' | 'business-number' | 'card' | 'phone' | 'email' | 'secret';

export interface Span {
  kind: SensitiveKind;
  /** Offset of the first character. */
  start: number;
  /** Offset past the last character. */
  end: number;
}

// Arabic-Indic and extended digits, full-width digits, dash look-alikes (U+2010-2015, minus, full-width hyphen,
// small hyphen-minus), full-width at, plus and full stop, and the spaces (ideographic, no-break, en/em/thin/hair,
// narrow no-break, medium mathematical).
const FOLD_RE = /[٠-٩۰-۹０-９‐-―−－﹣＠＋．　  -   ]/g;

/** The text with look-alike digits and punctuation as ASCII, the same length (one UTF-16 unit each),
 *  so offsets found in it hold in the original. */
function fold(text: string): string {
  // ASCII-only text (the usual) skips the replace.
  // eslint-disable-next-line no-control-regex
  if (!/[^\u0000-\u007F]/.test(text)) return text;
  return text.replace(FOLD_RE, (c) => {
    const n = c.charCodeAt(0);
    if (n >= 0x0660 && n <= 0x0669) return String.fromCharCode(48 + n - 0x0660);
    if (n >= 0x06f0 && n <= 0x06f9) return String.fromCharCode(48 + n - 0x06f0);
    if (n >= 0xff10 && n <= 0xff19) return String.fromCharCode(48 + n - 0xff10);
    if (n === 0xff20) return '@';
    if (n === 0xff0b) return '+';
    if (n === 0xff0e) return '.';
    if (n === 0x3000 || n === 0x00a0 || (n >= 0x2000 && n <= 0x200a) || n === 0x202f || n === 0x205f) return ' ';
    return '-';
  });
}

const dayOk = (mm: number, dd: number): boolean => {
  const days = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mm - 1];
  return days !== undefined && dd >= 1 && dd <= days;
};

// A gap inside a number: nothing, one space or dot, or a hyphen with up to two spaces or dots around it.
const RRN_GAP = '(?:[ .]{0,2}-[ .]{0,2}|[ .]?)';
const RRN_RE = new RegExp(`(?<!\\d)(\\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\\d|3[01])${RRN_GAP}[1-8]\\d{6}(?!\\d)`, 'g');
const BUS_RE = /(?<!\d)([1-9]\d{2})-?(\d{2})-?(\d{5})(?!\d)/g;
// Contiguous, or in groups (4-4-4-4, 4-6-5, 4-4-4-4-3 …) with one kind of separator. The first digit is one an
// issuer prefix starts with, so a run of other digits costs no attempt.
const CARD_RE = /(?<!\d)[2-69](?:\d{12,18}|\d{3}([ .-])\d{1,7}(?:\1\d{1,7}){1,3})(?!\d)/g;
// A gap between phone number groups: a hyphen or a dot, with a space on either side or none.
const PHONE_GAP = ' ?[-.]? ?';
// What follows the leading 0 of a Korean number: mobile, Seoul, regional (03x-06x), 070, 050x.
const AREA = '(?:1[016789]|2|[3-6][1-5]|70|50\\d?)';
const PHONE_RE = new RegExp(
  `(?:(?<!\\d)\\+82[ .-]{0,3}(?:\\(0\\)[ .-]{0,3}|0)?${AREA}|(?<!\\d)0${AREA}|\\(0${AREA}\\))${PHONE_GAP}\\d{3,4}${PHONE_GAP}\\d{4}(?!\\d)`,
  'g',
);

const BUS_WEIGHTS = [1, 3, 7, 1, 3, 7, 1, 3, 5];

function businessOk(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(digits[i]) * BUS_WEIGHTS[i]!;
  sum += Math.floor((Number(digits[8]) * 5) / 10);
  return (10 - (sum % 10)) % 10 === Number(digits[9]);
}

function luhnOk(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** Visa 4; Mastercard 51-55 and 2221-2720; Amex 34, 37; Discover 6011, 65, 644-649; JCB 35; UnionPay 62;
 *  9 (a Korean domestic card). */
function issuerOk(d: string): boolean {
  const p2 = Number(d.slice(0, 2));
  const p3 = Number(d.slice(0, 3));
  const p4 = Number(d.slice(0, 4));
  return d[0] === '4' || d[0] === '9' || (p2 >= 51 && p2 <= 55) || (p4 >= 2221 && p4 <= 2720) || p2 === 34 || p2 === 37 || p4 === 6011 || p2 === 65 || (p3 >= 644 && p3 <= 649) || p2 === 35 || p2 === 62;
}

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';

/** The most digits of a card. */
const MAX_CARD_DIGITS = 19;

function cardSpans(text: string, out: Span[]): void {
  const re = CARD_RE;
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const at = m.index;
    const raw = m[0];
    // digit offsets inside the match
    const pos: number[] = [];
    for (let i = 0; i < raw.length; i++) if (isDigit(raw[i])) pos.push(i);
    // the longest prefix of 13 to 19 digits that ends at a digit boundary and passes both checks
    let found = false;
    for (let n = Math.min(pos.length, MAX_CARD_DIGITS); n >= 13; n--) {
      const last = pos[n - 1]!;
      if (n < pos.length && isDigit(raw[last + 1])) continue;
      const digits = pos
        .slice(0, n)
        .map((i) => raw[i])
        .join('');
      if (issuerOk(digits) && luhnOk(digits)) {
        out.push({ kind: 'card', start: at, end: at + last + 1 });
        re.lastIndex = at + last + 1;
        found = true;
        break;
      }
    }
    // no card from this start: look again from the next run of digits inside it
    if (!found) re.lastIndex = at + 1;
  }
}

const LOCAL_CHAR = /[\p{L}\p{M}\p{N}._%+-]/u;
const LABEL_CHAR = /[\p{L}\p{M}\p{N}-]/u;
const TLD_RE = /^(?:[\p{L}\p{M}]{2,}|xn--[a-z0-9-]{2,})$/iu;
// example.com|net|org and the TLDs .example, .invalid, .test, .localhost (RFC 2606 and 6761), and `localhost`.
const RESERVED = /(?:^|\.)(?:example\.(?:com|net|org)|example|invalid|test|localhost)$/;
// File extensions that are no delegated top-level domain (md, py, rs, sh, pl, zip, mov … are, and stay addresses).
const FILE_EXT = new Set(
  ('png jpg jpeg gif svg webp ico bmp avif heic css scss sass less js mjs cjs jsx ts tsx json jsonc yml yaml toml ini conf cfg csv sql txt html htm xml ' +
    'rb java kt cpp hpp lock log map vue woff woff2 ttf otf eot mp3 mp4 webm wav gz tgz tar pdf exe dll bin').split(' '),
);

function emailSpans(text: string, out: Span[]): void {
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
    // Backwards to the run's start: a run ends at the previous `@` at the latest, so the scans add up to
    // the text's length.
    let s = at;
    while (s > 0 && LOCAL_CHAR.test(text[s - 1]!)) s--;
    if (s === at) continue;
    // `\n@app.route`: an escaped newline (a backslash and one letter) before a decorator, not a local part
    if (at - s === 1 && s > 0 && text[s - 1] === '\\') continue;
    let e = at + 1;
    while (e < text.length && e - at < 256 && (LABEL_CHAR.test(text[e]!) || (text[e] === '.' && LABEL_CHAR.test(text[e + 1] ?? '')))) e++;
    // the domain needs a dot and a top level of two letters or more
    const domain = text.slice(at + 1, e).replace(/[-.]+$/, '');
    const dot = domain.lastIndexOf('.');
    if (dot < 1) continue;
    const tld = domain.slice(dot + 1);
    if (!TLD_RE.test(tld) || FILE_EXT.has(tld.toLowerCase())) continue;
    const end = at + 1 + domain.length;
    // `@app.route(...)`, a call
    if (text[end] === '(') continue;
    const local = text.slice(s, at);
    // `git@github.com:org/repo.git`, an ssh remote
    if (local === 'git' && text[end] === ':') continue;
    if (RESERVED.test(domain.toLowerCase())) continue;
    out.push({ kind: 'email', start: s, end });
  }
}

// One compiled matcher per pattern, made once (a joined alternation of all of them cost about six times as
// much on plain text).
const SECRET_MATCHERS = SECRET_PATTERNS.map((p) => ({ re: new RegExp(p, 'gi'), pem: p === PEM_PRIVATE_KEY_BEGIN }));
const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/gi;

/** A PEM private key reaches its END line (the secret pattern matches only the BEGIN line); without one,
 *  the rest of the text. The search for the END line runs once per stretch: the scan resumes after it (or ends
 *  with the text), so many BEGIN lines cost no more than one. */
function secretSpans(text: string, out: Span[]): void {
  for (const { re, pem } of SECRET_MATCHERS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      const start = m.index;
      let end = start + m[0].length;
      if (pem) {
        PEM_END.lastIndex = end;
        const c = PEM_END.exec(text);
        end = c !== null ? c.index + c[0].length : text.length;
        out.push({ kind: 'secret', start, end });
        // no END line: nothing after this is outside the span; else resume after it
        if (c === null) break;
        re.lastIndex = end;
        continue;
      }
      out.push({ kind: 'secret', start, end });
    }
  }
}

const RANK: Record<SensitiveKind, number> = { secret: 0, 'resident-number': 1, 'business-number': 2, card: 3, phone: 4, email: 5 };

/** Every sensitive span of `text`, in order and not overlapping: spans that overlap merge into the
 *  longest first (the kind of the first of the merged group; equal ranges take the more specific kind). */
export function findSensitive(text: string): Span[] {
  if (text === '') return [];
  const v = fold(text);
  const raw: Span[] = [];
  if (/\d/.test(v)) {
    for (const m of v.matchAll(RRN_RE)) {
      if (dayOk(Number(m[2]), Number(m[3]))) raw.push({ kind: 'resident-number', start: m.index!, end: m.index! + m[0].length });
    }
    for (const m of v.matchAll(BUS_RE)) {
      if (m[2] !== '00' && businessOk(m[1]! + m[2]! + m[3]!)) raw.push({ kind: 'business-number', start: m.index!, end: m.index! + m[0].length });
    }
    cardSpans(v, raw);
    for (const m of v.matchAll(PHONE_RE)) raw.push({ kind: 'phone', start: m.index!, end: m.index! + m[0].length });
  }
  if (v.includes('@')) emailSpans(v, raw);
  secretSpans(v, raw);
  if (raw.length === 0) return [];
  raw.sort((a, b) => a.start - b.start || b.end - a.end || RANK[a.kind] - RANK[b.kind]);
  const out: Span[] = [];
  for (const s of raw) {
    const last = out[out.length - 1];
    if (last !== undefined && s.start < last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

/** The text with each sensitive span replaced by `[redacted:<kind>]`. */
export function redactText(text: string): string {
  const spans = findSensitive(text);
  if (spans.length === 0) return text;
  const parts: string[] = [];
  let at = 0;
  for (const s of spans) {
    parts.push(text.slice(at, s.start), `[redacted:${s.kind}]`);
    at = s.end;
  }
  parts.push(text.slice(at));
  return parts.join('');
}
