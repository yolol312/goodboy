// Track M, M6d (§19): the detectors of lib/pii-patterns.ts. A table of positives and negatives per kind,
// the spans (kind and offsets, for M6f's detect mode), idempotence, and the cost on a megabyte of text.
import { describe, expect, test } from 'bun:test';
import { findSensitive, redactText, type SensitiveKind } from '../lib/pii-patterns';
import { maskSecrets, maskedClip, PEM_PRIVATE_KEY_BEGIN, SECRET_PATTERNS, secretRe } from '../lib/secret-patterns';

const kindsOf = (text: string): SensitiveKind[] => findSensitive(text).map((s) => s.kind);

/** [text, kind]: the whole text is one span of that kind. */
const POSITIVE: ReadonlyArray<readonly [string, SensitiveKind]> = [
  // resident-number: hyphen or none, real month and day, gender digit 1-8, no check digit needed
  ['900101-1234567', 'resident-number'],
  ['9001011234567', 'resident-number'],
  ['001231-3456789', 'resident-number'],
  ['200229-4123456', 'resident-number'],
  ['850505-5123456', 'resident-number'],
  // resident-number copied from a form or a sheet: a space, a dot, a padded hyphen, a no-break space, an en dash
  ['900101 1234567', 'resident-number'],
  ['900101.1234567', 'resident-number'],
  ['900101 - 1234567', 'resident-number'],
  ['900101\u00a01234567', 'resident-number'],
  ['900101\u20131234567', 'resident-number'],
  ['900101\u20091234567', 'resident-number'],
  // business-number: 3-2-5 with the check digit
  ['123-45-67891', 'business-number'],
  ['220-81-62517', 'business-number'],
  ['2208162517', 'business-number'],
  // card: Luhn and an issuer prefix, contiguous or grouped
  ['4111111111111111', 'card'],
  ['4111 1111 1111 1111', 'card'],
  ['4111-1111-1111-1111', 'card'],
  ['5500005555555559', 'card'],
  ['2223003122003222', 'card'],
  ['2221000000000009', 'card'],
  ['378282246310005', 'card'],
  ['3782 822463 10005', 'card'],
  ['6011111111111117', 'card'],
  ['3530111333300000', 'card'],
  ['4222222222222', 'card'],
  ['4111.1111.1111.1111', 'card'],
  // phone
  ['010-1234-5678', 'phone'],
  ['01012345678', 'phone'],
  ['010 1234 5678', 'phone'],
  ['011-123-4567', 'phone'],
  ['02-123-4567', 'phone'],
  ['02-1234-5678', 'phone'],
  ['031-123-4567', 'phone'],
  ['0212345678', 'phone'],
  ['070-1234-5678', 'phone'],
  ['+82 10 1234 5678', 'phone'],
  ['+82-10-1234-5678', 'phone'],
  ['+82-2-123-4567', 'phone'],
  ['+8201012345678', 'phone'],
  // padded separators, a parenthesized area code, `+82 (0)10`, no-break and thin spaces
  ['010 - 1234 - 5678', 'phone'],
  ['010 -1234- 5678', 'phone'],
  ['010. 1234. 5678', 'phone'],
  ['(010) 1234-5678', 'phone'],
  ['(02) 123-4567', 'phone'],
  ['(031)123-4567', 'phone'],
  ['+82 (0)10-1234-5678', 'phone'],
  ['+82 (0) 10 1234 5678', 'phone'],
  ['+82 2 1234 5678', 'phone'],
  ['010\u00a01234\u00a05678', 'phone'],
  ['010\u20091234\u20095678', 'phone'],
  // email
  ['person@corp-mail.co.kr', 'email'],
  ['kim.minsu+tag@naver.com', 'email'],
  ['a_b%c@sub.domain.example.co', 'email'],
  ['x@y.io', 'email'],
  // Hangul and other scripts in the local part or the domain, an IDN top level, a long local part whole
  ['홍길동@naver.com', 'email'],
  ['hong홍@naver.com', 'email'],
  ['user@münchen.de', 'email'],
  ['用户@例子.广告', 'email'],
  ['user@xn--mnchen-3ya.de', 'email'],
  ['user@host.xn--3e0b707e', 'email'],
  [`${'a'.repeat(70)}@corp.co.kr`, 'email'],
  ['kim@univ.edu.py', 'email'],
  ['kim@corp.md', 'email'],
  ['NAME@CORP-MAIL.CO.KR', 'email'],
  // secret (the patterns of lib/secret-patterns.ts)
  ['ghp_abcdefghijklmnopqrstuvwx', 'secret'],
  ['AKIAABCDEFGHIJKLMNOP', 'secret'],
  ['password = hunter2abc', 'secret'],
  ['Bearer abcdefghijklmnop12345', 'secret'],
  ['postgres://user:pw0rd@', 'secret'],
  // a PEM key is a secret in any case
  ['-----begin private key-----\nabc\n-----end private key-----', 'secret'],
];

const NEGATIVE: readonly string[] = [
  // invalid dates and gender digits
  '901301-1234567',
  '900230-1234567',
  '900132-1234567',
  '900101-9234567',
  '9001019234567',
  // business number with a wrong check digit, a zero middle, a leading zero
  '123-45-67890',
  '123-00-12345',
  '0123456789',
  // card: Luhn fails, no issuer prefix, a longer or shorter run
  '4111111111111112',
  '1234567890123456',
  '1111111111111111',
  '41111111111111111111',
  '411111111111',
  // Luhn passes but no issuer starts with it (a 13-digit epoch-ms number among them)
  '1700000000004',
  '1794821772313',
  '100000000000009',
  '800000000000002',
  '3000000000000004',
  '5600000000000003',
  '2000000000000006',
  '6000000000000007',
  '6610000000000009',
  // epoch milliseconds and seconds
  '1700000000000',
  '1794821772319',
  String(Date.now()),
  '1735689600',
  // hashes, ids, versions, paths, numbers
  'da39a3ee5e6b4b0d3255bfef95601890afd80709',
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  '550e8400-e29b-41d4-a716-446655440000',
  '123e4567-e89b-12d3-a456-426614174000',
  '1.2.3',
  '12.0.1-beta.4',
  'v18.17.0',
  '2026-11-16T03:18:16.000Z',
  '2026-11-16',
  '/src/lib/a-1234.ts',
  'tests/m6d-detectors.test.ts:42',
  '192.168.0.1',
  '3.14159265358979',
  '1,234,567',
  // spec ids
  'PT-1',
  'UIUX-2',
  'AC-12',
  // Korean text, composed and decomposed
  '홍길동님의 주소는 서울시 강남구입니다',
  '홍길동 한글 텍스트'.normalize('NFD'),
  '홍길동 한글 텍스트'.normalize('NFC'),
  // not an address: a package version, a scoped package, an ssh remote, reserved domains, no top level
  'lodash@4.17.21',
  '@types/node',
  'git@github.com:org/repo.git',
  'user@example.com',
  'user@example.org',
  'user@mail.example.net',
  'user@host.example',
  'user@x.invalid',
  'user@x.test',
  'user@localhost',
  'user@host',
  'a@b.c',
  // a file name, a call or a decorator is no address (`name@2x.png`, `@app.route(`, an escaped newline before one)
  'logo@2x.png',
  'icon@2x.min.js',
  'user@host.ts',
  'a@b.json',
  'a@app.route("/x")',
  'x\\n@app.route',
  'x\\n@pytest.fixture',
  '@app.route("/x")',
  // a gap of three spaces is no gap; dates and times
  '900101   1234567',
  '2026-11-16 10:01:34',
  '260101 12',
  '4111  1111 1111 1111',
  // a grouped run of 20 digits that is no card by itself, contiguous digits likewise
  '41111111111111111115',
  // no secret: a token count, a short word
  'token count = 12345',
  'sk',
];

describe('M6d detectors: positives', () => {
  for (const [text, kind] of POSITIVE) {
    test(`${kind}: ${text}`, () => {
      expect(findSensitive(text)).toEqual([{ kind, start: 0, end: text.length }]);
      expect(redactText(text)).toBe(`[redacted:${kind}]`);
    });
  }
});

describe('M6d detectors: negatives', () => {
  for (const text of NEGATIVE) {
    test(`no match: ${text}`, () => {
      expect(findSensitive(text)).toEqual([]);
      expect(redactText(text)).toBe(text);
    });
  }
});

describe('M6d detectors: spans and context', () => {
  test('a business number with the middle group 00 is none, though its check digit is right', () => {
    // 100-00-00009 passes the check digit; the middle group of a real number is never 00
    expect(findSensitive('100-00-00009')).toEqual([]);
    expect(findSensitive('1000000009')).toEqual([]);
  });

  test('spans that overlap only in part merge into one that covers both', () => {
    // the secret ends where the address begins its `@`; the address starts inside the secret
    const text = 'token Bearer abcdefghijklmnopqrstuv@corp-mail.co.kr end';
    expect(findSensitive(text)).toEqual([{ kind: 'secret', start: 6, end: 51 }]);
    expect(redactText(text)).toBe('token [redacted:secret] end');
  });

  test('a span is bounded by non-digits: a longer digit run holds none', () => {
    expect(kindsOf('x900101-1234567y')).toEqual(['resident-number']);
    expect(kindsOf('99001011234567')).toEqual([]);
    expect(kindsOf('010-1234-56789')).toEqual([]);
  });

  test('offsets in text; the value never leaves the function except as offsets', () => {
    const text = 'call 010-1234-5678 or mail a@corp.kr now';
    const spans = findSensitive(text);
    expect(spans.map((s) => [s.kind, text.slice(s.start, s.end)])).toEqual([
      ['phone', '010-1234-5678'],
      ['email', 'a@corp.kr'],
    ]);
    expect(redactText(text)).toBe('call [redacted:phone] or mail [redacted:email] now');
  });

  test('a card inside a longer grouped run is found from its own group', () => {
    expect(redactText('12 4111 1111 1111 1111')).toBe('12 [redacted:card]');
    expect(redactText('4111 1111 1111 1111 12')).toBe('[redacted:card] 12');
  });

  test('overlapping spans merge: a secret that holds a phone number is one span', () => {
    const text = 'password: 01012345678abc';
    expect(findSensitive(text)).toEqual([{ kind: 'secret', start: 0, end: text.length }]);
  });

  test('the same range takes the more specific kind: 4501011000000 is a resident-number shape and a Visa that passes Luhn', () => {
    // a real tie: the same 13 digits are both kinds, so only the rank decides (a card first would read `card`)
    const text = '4501011000000';
    expect(findSensitive(text)).toEqual([{ kind: 'resident-number', start: 0, end: 13 }]);
    // the card rule alone does hold for it
    expect(kindsOf('4501011000001')).toEqual(['resident-number']);
    expect(kindsOf('4222222222222')).toEqual(['card']);
  });

  test('a card has at most 19 digits: a grouped run of 20 digits is cut to a card prefix, as the contiguous run is no card', () => {
    const grouped = '4111 1111 1111 1111 1115';
    const digitsOf = (t: string): number => t.replace(/\D/g, '').length;
    const spans = findSensitive(grouped);
    expect(spans.length).toBeGreaterThan(0);
    for (const sp of spans) if (sp.kind === 'card') expect(digitsOf(grouped.slice(sp.start, sp.end))).toBeLessThanOrEqual(19);
    expect(redactText(grouped)).toBe('[redacted:card] 1115');
    expect(redactText('41111111111111111115')).toBe('41111111111111111115');
    // and a 19-digit card, grouped or not, is one
    expect(kindsOf('4111111111111111110')).toEqual(['card']);
    expect(redactText('4111 1111 1111 1111 110')).toBe('[redacted:card]');
  });

  test('stated limit: a 13-digit epoch-millisecond number can read as a resident number (redacted, the safe side)', () => {
    // mid-month samples of 2004, 2008, 2017 and 2024 match; the stated scope is about 3% of 2001-2024
    for (const ms of [Date.UTC(2004, 11, 15), Date.UTC(2008, 1, 15), Date.UTC(2017, 9, 15), Date.UTC(2024, 0, 15)]) {
      expect(redactText(String(ms))).toBe('[redacted:resident-number]');
    }
    // mid-June 2020 does not
    expect(redactText(String(Date.UTC(2020, 5, 15)))).toBe(String(Date.UTC(2020, 5, 15)));
    let hit = 0;
    let n = 0;
    for (let ms = Date.UTC(2001, 0, 1); ms < Date.UTC(2024, 0, 1); ms += 15 * 86_400_000 + 3_600_000) {
      n++;
      if (findSensitive(String(ms)).length > 0) hit++;
    }
    expect(hit / n).toBeGreaterThan(0.01);
    expect(hit / n).toBeLessThan(0.06);
  });

  test('a call or an escaped newline before a word is no address, an address after it is', () => {
    expect(redactText('x\\n@app.route("/a")')).toBe('x\\n@app.route("/a")');
    expect(redactText('mail kim@corp.kr(me)')).toBe('mail kim@corp.kr(me)');
    expect(redactText('line\\nkim@corp.kr')).toBe('line\\[redacted:email]');
    expect(redactText('logo@2x.png and kim@corp.kr')).toBe('logo@2x.png and [redacted:email]');
  });

  test('a no-break or thin space ends a local part as a space does (it is a space, not a hyphen)', () => {
    expect(redactText('Kim\u00a0kim@corp.kr')).toBe('Kim\u00a0[redacted:email]');
    expect(redactText('Kim\u2009kim@corp.kr')).toBe('Kim\u2009[redacted:email]');
    expect(redactText('Kim\u3000kim@corp.kr')).toBe('Kim\u3000[redacted:email]');
  });

  test('a long local part is redacted whole, not by its last 64 characters', () => {
    expect(redactText(`${'a'.repeat(70)}@corp.co.kr`)).toBe('[redacted:email]');
    expect(redactText(`${'a'.repeat(5000)}@corp.co.kr x`)).toBe('[redacted:email] x');
  });

  test('full-width and Arabic-Indic digits and dashes do not slip past', () => {
    expect(redactText('０１０－１２３４－５６７８')).toBe('[redacted:phone]');
    expect(redactText('９００１０１－１２３４５６７')).toBe('[redacted:resident-number]');
    expect(redactText('٠١٠-١٢٣٤-٥٦٧٨')).toBe('[redacted:phone]');
    expect(redactText('ａ＠corp.kr'.replace('ａ', 'a'))).toBe('[redacted:email]');
  });

  test('a PEM private key is found in any case, and each BEGIN line without an END reaches the end of the text', () => {
    expect(redactText('a -----begin rsa private key-----\nxyz\n-----end rsa private key----- b')).toBe('a [redacted:secret] b');
    expect(redactText('-----BEGIN PRIVATE KEY-----\none\n-----BEGIN PRIVATE KEY-----\ntwo')).toBe('[redacted:secret]');
    // the next BEGIN after an END starts a new span
    expect(redactText('-----BEGIN PRIVATE KEY-----\nk1\n-----END PRIVATE KEY----- mid -----BEGIN PRIVATE KEY-----\nk2\n-----END PRIVATE KEY-----')).toBe('[redacted:secret] mid [redacted:secret]');
    // BEGIN lines inside one key do not end it early
    expect(redactText('-----BEGIN PRIVATE KEY-----\n-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY----- tail')).toBe('[redacted:secret] tail');
  });

  test('a PEM private key is covered to its END line, not only the BEGIN line', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsecretsecretsecret\n-----END RSA PRIVATE KEY-----';
    expect(redactText(`before\n${pem}\nafter`)).toBe('before\n[redacted:secret]\nafter');
    // with no END line the rest of the text goes
    expect(redactText('before -----BEGIN PRIVATE KEY-----\nabc\ndef')).toBe('before [redacted:secret]');
  });

  test('redaction is idempotent and keeps surrounding text', () => {
    const once = redactText('a 900101-1234567 b 4111 1111 1111 1111 c');
    expect(once).toBe('a [redacted:resident-number] b [redacted:card] c');
    expect(redactText(once)).toBe(once);
  });

  test('empty text', () => {
    expect(findSensitive('')).toEqual([]);
    expect(redactText('')).toBe('');
  });
});

describe('M6d detectors: cost', () => {
  const mk = (unit: string): string => unit.repeat(Math.ceil(1_000_000 / unit.length)).slice(0, 1_000_000);
  const SHAPES: Record<string, string> = {
    prose: mk('The quick brown fox 12345 jumps over the lazy dog. '),
    digits: mk('1'),
    spaced: mk('4 '),
    hyphened: mk('4-'),
    grouped: mk('4111 1111 111 '),
    ats: mk('@'),
    locals: mk('a@'),
    emails: mk('a@b.c '),
    phones: mk('010-1234-567 '),
    korean: mk('한글 테스트 로그 출력 '),
    // the gaps and groups the later rules added
    gaps: mk('900101 . . 1'),
    phoneGaps: mk('010 - 1234 - '),
    parens: mk('(02) 123-'),
    plus82: mk('+82 (0)10-'),
    dotted: mk('1.1.1.1 '),
    hangulEmails: mk('홍길동@naver.'),
    // a PEM BEGIN line with no END: the END line is searched for once
    pemOpen: mk('-----BEGIN PRIVATE KEY-----\n'),
    pemOpenLower: mk('-----begin rsa private key----- '),
    pemPairs: mk('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n'),
    pemWide: mk(`-----BEGIN ${'A '.repeat(40)}`),
    pemEnds: mk('-----END PRIVATE KEY-----\n'),
    // patterns of lib/secret-patterns.ts that an alternation of all of them could make slow
    urlLike: mk('a://:x '),
    dashDot: mk('a-.-.'),
    bearer: mk('Bearer '),
    password: mk('password='),
    oneLongLocal: `${'a'.repeat(500_000)}@${'b'.repeat(500_000)}`,
  };
  // Measured 30-270 ms per shape (Bun 1.3.11, M-series); the bound leaves room for a loaded machine and still fails a
  // quadratic scan (1 MB of unclosed PEM BEGIN lines took 17 s before the fix).
  const BOUND_MS = 1_500;
  for (const [name, text] of Object.entries(SHAPES)) {
    test(`1 MB of ${name} stays linear`, () => {
      const t0 = performance.now();
      redactText(text);
      expect(performance.now() - t0).toBeLessThan(BOUND_MS);
    });
  }

  test('1 MB with a canary at the end is found and redacted', () => {
    const text = mk('lorem ipsum 42 dolor sit amet. ') + ' tail 900101-1234567';
    const t0 = performance.now();
    const out = redactText(text);
    expect(performance.now() - t0).toBeLessThan(BOUND_MS);
    expect(out.endsWith(' tail [redacted:resident-number]')).toBe(true);
    expect(out).not.toContain('900101-1234567');
  });
});

describe('M6d detectors compile nothing per call', () => {
  test('findSensitive and redactText construct no RegExp (the matchers are made once, at load)', () => {
    const Orig = RegExp;
    let made = 0;
    globalThis.RegExp = new Proxy(Orig, {
      construct(target, args, newTarget) {
        made++;
        return Reflect.construct(target, args, newTarget);
      },
    });
    try {
      for (const text of ['plain words only', 'call 010-1234-5678 now', 'card 4111 1111 1111 1111 and kim@corp.kr', 'key ghp_abcdefghijklmnopqrstuvwx and password=hunter2abc', '-----BEGIN PRIVATE KEY-----\nabc', 'e\u0301 한글 ０１０－１２３４－５６７８']) {
        redactText(text);
        findSensitive(text);
      }
    } finally {
      globalThis.RegExp = Orig;
    }
    expect(made).toBe(0);
  });
});

describe('M6d lib/secret-patterns.ts keeps its own behaviour for its other users', () => {
  test('secretRe() is a fresh global case-blind matcher of every pattern, maskSecrets and maskedClip as before', () => {
    const a = secretRe();
    const b = secretRe();
    expect(a).not.toBe(b);
    expect(a.flags).toBe('gi');
    expect(a.source).toBe(new RegExp(SECRET_PATTERNS.join('|'), 'gi').source);
    expect(maskSecrets('curl -u admin:hunter2 https://x')).toBe('curl [secret] https://x');
    expect(maskSecrets('token=abcdef123456 and ghp_abcdefghijklmnopqrstuvwx')).toBe('[secret] and [secret]');
    expect(maskSecrets('docker run -u 1000:1000 img')).toBe('docker run -u 1000:1000 img');
    // a PEM BEGIN line is masked (only the BEGIN line: the END line is the detectors' job)
    expect(maskSecrets('x -----BEGIN RSA PRIVATE KEY----- y')).toBe('x [secret]----- y');
    expect(maskedClip('password=abcdefgh1234 and more text here', 15)).toBe('[secret] and mo');
    expect(SECRET_PATTERNS).toContain(PEM_PRIVATE_KEY_BEGIN);
  });

  test('the detectors cover every range secretRe() matches (per-pattern runs lose nothing of the joined run)', () => {
    const corpus = [
      'AKIAABCDEFGHIJKLMNOP ghp_abcdefghijklmnopqrstuvwx github_pat_abcdefghijklmnopqrstu glpat-abcdefghijklmnopq',
      'sk-abcdefghijklmnopqrstuv AIzaabcdefghijklmnopqrstuvwxyz12345 npm_abcdefghijklmnopqrstuvwxyz1234',
      'xoxb-1234567890-abcdef eyJabcdefghij.klmnopqrstuv Bearer abcdefghijklmnop.q',
      'redis://:pw@host curl -u user:pass1 --user=u:p2x https://hooks.slack.com/services/T0000000/B0000/XXXXXXXX',
      'password = x1y2z3w4 "token": "abc123def" --password hunter22 --api-key=k1234',
      'plain text with no secret, a count token = 12345 and -u 1000:1000',
    ].join('\n');
    const spans = findSensitive(corpus);
    const covered = (i: number): boolean => spans.some((sp) => sp.start <= i && i < sp.end);
    let n = 0;
    for (const m of corpus.matchAll(secretRe())) {
      n++;
      for (let i = m.index!; i < m.index! + m[0].length; i++) expect(covered(i)).toBe(true);
    }
    expect(n).toBeGreaterThan(10);
  });
});
