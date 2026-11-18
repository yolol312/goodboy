// Track M, M6d and M6f (§19), the fix after the M6 canary step S3 (2026-11-18): the `secret` kind of lib/pii-patterns.ts
// reads a keyword followed by a `:` TYPE annotation (`token: string`, `Map<string, string>`, `number | null`) as no secret,
// and keeps every real secret. A regex-looking value is NOT exempt (review of the S3 fix: a real password may hold a class
// and a quantifier); goodboy's own regex constant is covered by the commit scan's render exemption. The records
// (lib/record-sanitize.ts) share the detector.

import { describe, expect, test } from 'bun:test';
import { findSensitive, redactText } from '../lib/pii-patterns';

const secret = (text: string): boolean => findSensitive(text).some((s) => s.kind === 'secret');

const TYPES = [
  'token: string',
  'password: String',
  'secret?: str',
  'apiKey: number | null',
  'api_key: Optional<str>',
  'token: Map<string, string>',
  'token: string[]',
  'token: List<String>,',
  'token: (string | null)[] // the token',
  'api_key: str # the key',
  'access_key: Record<string, Array<number>>',
  'gens: Map<string, { kind: string; token: string }>',
  'export interface Auth { kind: string; token: string }',
  'function f(token: string, password: String) {}',
];
const SECRETS = [
  'token: "ghp_abcdefghijklmnopqrstuvwxyz0123"',
  'password: hunter2xyz',
  'PGPASSWORD=s3cr3tValue',
  'api_key = "AKIAIOSFODNN7EXAMPLE"',
  'TOKEN = "abc123def456abc123"',
  // by value, a dummy password is a password: the commit scan exempts goodboy's own render by content, not here
  'PASSWORD=sandbox',
  'POSTGRES_PASSWORD: "sandbox"',
  // a type is no cover for a value after it
  'token: string = "abc123def456xyz"',
  'token: string | "abc123def456"',
  'token: Map<string, hunter2xyz>',
  // a name that only starts like a type, and a quoted type name
  'token: stringvalue1',
  'password: strings',
  'token: "string"',
  // a regex-looking value is a value: a password may hold a class and a quantifier (review of the S3 fix)
  '"password": "Zx[9]k!q+Lm"',
  'password = "Hunter[2]xx?"',
  "password: 'ab[c]d?efg'",
  'secret=/Pa[s]s+word/',
  'token = decrypt("[abc]+realsecretvalue")',
  // goodboy's own regex constant is no exception here (the commit scan's render exemption covers it)
  'private static final Pattern TOKEN = Pattern.compile("^[0-9a-f]{8}$");',
  'token = /^[0-9a-f]{8}$/i',
  'token = Pattern.compile("hunter2xyz")',
  'token = "abc[0-9]"',
  'token = /abc123def456/',
  // a type name after a dot is the end of a value, not a type; and `=` is an assignment, never an annotation
  'password=Tr0ub4dor.string',
  'secret=AbCdEf123456.map',
  'token=ghp_abcdefghijkl1234.date',
  'password: Tr0ub4dor.string',
  'secret: java.lang.String;',
  'token = string',
  'password = Optional',
];

describe('the secret kind reads a type annotation after a keyword as no secret', () => {
  for (const t of TYPES) test(`a type: ${JSON.stringify(t)}`, () => expect(secret(t)).toBe(false));
  for (const t of SECRETS) test(`still a secret: ${JSON.stringify(t)}`, () => expect(secret(t)).toBe(true));

  test('a secret next to a type, in a multi-line source, is found at its own place and redacted', () => {
    const text = 'interface A {\n  token: string;\n}\nconst password = "Hunter[2]xx?";\n';
    const spans = findSensitive(text);
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual(['password = "Hunter[2]xx?']);
    expect(redactText(text)).toBe('interface A {\n  token: string;\n}\nconst [redacted:secret]";\n');
    expect(redactText('x: {"password": "Zx[9]k!q+Lm"}')).not.toContain('Zx[9]');
  });

  test('the secrets of the other patterns are unchanged (an AWS key after a type is found)', () => {
    expect(secret('token: string // AKIAIOSFODNN7EXAMPLE')).toBe(true);
    expect(secret('token: string, key=ghp_abcdefghijklmnopqrstuvwxyz0123')).toBe(true);
  });
});

describe('the precision rule stays linear', () => {
  const BOUND_MS = 3000;
  const cases: Array<[string, string]> = [
    ['type annotations', 'token: Map<string, string>\n'],
    ['unclosed generics', 'token: Map<Map<Map<Map<Map<Map<Map<Map<Map<Map<string, '],
    ['a pipe chain', 'token: string | string | string | string | string | '],
    ['open parentheses', 'token: ((((((((((((((((((((((((string'],
    ['quoted pattern starts', 'token = "[a-z]{3 '],
    ['slashes', 'token = /////////////////////////////// '],
    ['calls', 'token = a.b.c.d.e.f.g.h.i.j.k.l.m.n("[ '],
  ];
  for (const [name, unit] of cases) {
    test(`1 MB of ${name}`, () => {
      const text = unit.repeat(Math.ceil((1024 * 1024) / unit.length));
      const t0 = performance.now();
      findSensitive(text);
      expect(performance.now() - t0).toBeLessThan(BOUND_MS);
    });
  }
});
