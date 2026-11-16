// Track M, M6d (§19): lib/record-sanitize.ts. Strings and keys are redacted, the kept fields of a schema stay
// byte for byte, a value that cannot be walked is withheld, and `__proto__` is a plain key. The three real
// schemas are in tests/m6d-schema.test.ts.
import { describe, expect, test } from 'bun:test';
import { checkRecordFields, ID_RE, type SchemaLists, sanitizeRecord, WITHHELD_TEXT } from '../lib/record-sanitize';
import { sandboxRunFlagsOnly } from '../lib/test-backfill';

const RRN = '900101-1234567';
const MAIL = 'canary.person@corp-mail.co.kr';
const SCHEMA: SchemaLists = { computed: ['id'], ids: ['kind'], paths: ['files', 'list.[].path', 'by.[]'], commands: ['cmd', 'list.[].cmd'], display: ['text'] };

describe('M6d sanitizeRecord', () => {
  test('display strings and keys are redacted; exact fields and commands keep their rules', () => {
    const out = sanitizeRecord(
      {
        id: `id-${RRN}`,
        files: [`/src/${RRN}.ts`, 'b.ts'],
        text: `rrn ${RRN}`,
        [`key ${MAIL}`]: 'v',
        cmd: `bun test --who ${MAIL}`,
        list: [{ path: `p-${RRN}`, cmd: `run ${RRN}`, note: `n ${RRN}` }],
        n: 3,
        ok: true,
        none: null,
      },
      SCHEMA,
    ) as Record<string, any>;
    expect(out.id).toBe(`id-${RRN}`);
    expect(out.files).toEqual([`/src/${RRN}.ts`, 'b.ts']);
    expect(out.text).toBe('rrn [redacted:resident-number]');
    expect(Object.keys(out)).toContain('key [redacted:email]');
    expect(out.cmd).toBe('bun test --who [redacted:email]');
    expect(out.list[0]).toEqual({ path: `p-${RRN}`, cmd: 'run [redacted:resident-number]', note: 'n [redacted:resident-number]' });
    expect([out.n, out.ok, out.none]).toEqual([3, true, null]);
  });

  test('the input is not changed, and the copy shares no object with it', () => {
    const input = { files: { a: { b: [1] } }, text: RRN };
    const out = sanitizeRecord(input, SCHEMA) as typeof input;
    expect(input.text).toBe(RRN);
    expect(out.files).toEqual(input.files);
    expect(out.files).not.toBe(input.files);
    expect(out.files.a.b).not.toBe(input.files.a.b);
  });

  test('a kept subtree keeps every key and string (a map and an array of paths with number-like names)', () => {
    const out = sanitizeRecord({ files: { [`${RRN}.ts`]: { covered: 1 } }, by: [`x ${RRN}`] }, SCHEMA) as Record<string, any>;
    expect(Object.keys(out.files)).toEqual([`${RRN}.ts`]);
    expect(out.by).toEqual([`x ${RRN}`]);
  });

  test('`__proto__` and `constructor` keys are own plain properties and pollute nothing', () => {
    const input = JSON.parse('{"__proto__": {"polluted": "yes"}, "constructor": {"prototype": {"polluted2": "yes"}}, "nested": {"__proto__": "x"}}');
    const out = sanitizeRecord(input, SCHEMA) as Record<string, any>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted2).toBeUndefined();
    expect(Object.keys(out).sort()).toEqual(['__proto__', 'constructor', 'nested']);
    expect(Object.getOwnPropertyDescriptor(out, '__proto__')!.value).toEqual({ polluted: 'yes' });
    expect(JSON.parse(JSON.stringify(out))).toEqual(JSON.parse(JSON.stringify(input)));
    // an exact subtree with such a key too
    const exact = sanitizeRecord(JSON.parse('{"files": {"__proto__": {"a": 1}}}'), SCHEMA) as Record<string, any>;
    expect(Object.getPrototypeOf(exact.files)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(exact.files, '__proto__')!.value).toEqual({ a: 1 });
  });

  test('two keys that redact to the same text both survive', () => {
    const out = sanitizeRecord({ [`a ${MAIL}`]: 1, [`a ${MAIL.replace('canary', 'other')}`]: 2 }, SCHEMA) as Record<string, number>;
    expect(Object.values(out).sort()).toEqual([1, 2]);
    expect(Object.keys(out)).toHaveLength(2);
    expect(Object.keys(out).join('')).not.toContain('corp-mail');
  });

  test('fail closed: what cannot be walked is withheld, never passed', () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    const deep: Record<string, unknown> = {};
    let cur = deep;
    for (let i = 0; i < 60; i++) cur = (cur.n = {}) as Record<string, unknown>;
    cur.leak = RRN;
    const out = sanitizeRecord(
      {
        fn: () => RRN,
        sym: Symbol(RRN),
        big: BigInt(1),
        date: new Date(0),
        map: new Map([[RRN, RRN]]),
        cls: new (class Secret {
          v = RRN;
        })(),
        cyc,
        deep,
        getter: Object.defineProperty({}, 'x', {
          enumerable: true,
          get() {
            throw new Error(RRN);
          },
        }),
      },
      SCHEMA,
    ) as Record<string, any>;
    for (const k of ['fn', 'sym', 'big', 'date', 'map', 'cls']) expect(out[k]).toBe(WITHHELD_TEXT);
    expect(out.cyc.a).toBe(1);
    expect(out.cyc.self).toBe(WITHHELD_TEXT);
    expect(out.getter).toBe(WITHHELD_TEXT);
    expect(JSON.stringify(out)).not.toContain('1234567');
    expect(JSON.stringify(out.deep)).toContain(WITHHELD_TEXT);
  });

  test('withhold: every display string is the fixed text, kept fields stay, a command stays only when keepCommand says so', () => {
    const rec = { id: 'i-1', files: ['a.ts'], cmd: `bun test ${RRN}`, text: 'plain words', list: [{ note: 'n', path: 'p', cmd: 'c' }], deep: { a: ['x'] }, n: 4 };
    const out = sanitizeRecord(rec, SCHEMA, { withhold: true }) as Record<string, any>;
    expect(out.id).toBe('i-1');
    expect(out.files).toEqual(['a.ts']);
    // no keepCommand: every command is withheld
    expect(out.cmd).toBe(WITHHELD_TEXT);
    expect(out.list[0].cmd).toBe(WITHHELD_TEXT);
    // keepCommand: the commands it accepts stay, redacted by span; the rest are withheld
    const kept = sanitizeRecord(rec, SCHEMA, { withhold: true, keepCommand: (c) => c.startsWith('bun test') }) as Record<string, any>;
    expect(kept.cmd).toBe('bun test [redacted:resident-number]');
    expect(kept.list[0].cmd).toBe(WITHHELD_TEXT);
    // without withhold every command is kept, redacted by span
    expect((sanitizeRecord(rec, SCHEMA) as Record<string, any>).cmd).toBe('bun test [redacted:resident-number]');
    expect(out.text).toBe(WITHHELD_TEXT);
    expect(out.list[0]).toMatchObject({ note: WITHHELD_TEXT, path: 'p' });
    expect(out.deep).toEqual({ a: [WITHHELD_TEXT] });
    expect(out.n).toBe(4);
    expect(WITHHELD_TEXT.length).toBeGreaterThanOrEqual(15);
  });

  test('a string field that is not where the schema looks stays display text (an unknown key)', () => {
    const out = sanitizeRecord({ extra: { deeper: `v ${RRN}` } }, SCHEMA) as Record<string, any>;
    expect(out.extra.deeper).toBe('v [redacted:resident-number]');
  });

  test('a large array of display strings stays cheap', () => {
    const rows = Array.from({ length: 50_000 }, (_, i) => `row ${i} ${i % 1000 === 0 ? RRN : 'ok'}`);
    const t0 = performance.now();
    const out = sanitizeRecord({ rows }, SCHEMA) as { rows: string[] };
    // measured about 0.2 s
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(out.rows.join('\n')).not.toContain('1234567');
    expect(out.rows[1000]).toBe('row 1000 [redacted:resident-number]');
  });
});

describe('M6d sanitizeRecord: keys that redact to one text', () => {
  test('three colliding keys are told apart by #2 and #3', () => {
    const mk = (n: string) => `a ${MAIL.replace('canary', n)}`;
    const out = sanitizeRecord({ [mk('x1')]: 1, [mk('x2')]: 2, [mk('x3')]: 3 }, SCHEMA) as Record<string, number>;
    expect(Object.keys(out).sort()).toEqual(['a [redacted:email]', 'a [redacted:email]#2', 'a [redacted:email]#3']);
  });
});

describe('M6d sandboxRunFlagsOnly: the run line a real-data record may keep', () => {
  test('the invocation with --suite and --timeout-ms only, and plain runtime flags; anything else is not', () => {
    for (const ok of [
      'bun "/p/lib/cli.ts" sandbox-run',
      'bun /p/lib/cli.ts sandbox-run --suite unit -- bun test',
      'bun --smol lib/cli.ts sandbox-run --suite e2e --timeout-ms 900000',
      'node cli.ts sandbox-run --suite all -- npm test -- --who Kim',
    ]) expect([ok, sandboxRunFlagsOnly(ok)]).toEqual([ok, true]);
    for (const bad of [
      'bun cli.ts sandbox-run --suite unit --who=Kim -- bun test',
      'bun cli.ts sandbox-run --note Kim --suite unit',
      'bun --note Kim cli.ts sandbox-run --suite unit',
      'bun --env=Kim cli.ts sandbox-run',
      'bun cli.ts sandbox-run --suite Kim',
      'bun cli.ts sandbox-run --timeout-ms 10s',
      'bun cli.ts sandbox-run --suite',
      'bun cli.ts sandbox-data schema',
      'echo x; bun cli.ts sandbox-run',
      'bun cli.ts sandbox-run "unclosed',
    ]) expect([bad, sandboxRunFlagsOnly(bad)]).toEqual([bad, false]);
  });
});

describe('M6d checkRecordFields', () => {
  const S: SchemaLists = { computed: ['hash'], ids: ['kind', 'tags.[]'], paths: ['file', 'files.[]', 'map', 'nest.[].p'], commands: [], display: ['text'] };

  test('a clean record has no problems; display text and computed fields are not checked', () => {
    expect(checkRecordFields({ kind: 'fix-bug', tags: ['a', 'b_1'], file: 'src/a.ts', files: ['x.ts'], map: { 'dir/a.ts': { n: 1 } }, nest: [{ p: 'p.ts' }], text: `free ${RRN}`, hash: '0123456789012345678901234567890123456789' }, S)).toEqual([]);
  });

  test('a path with personal data is named by field and kind, never by value; a key too', () => {
    const problems = checkRecordFields({ file: `src/${RRN}.ts`, files: ['ok.ts', `a-${MAIL}`], map: { [`${RRN}.ts`]: { n: 1 } }, nest: [{ p: 'fine' }, { p: 'tel 010-1234-5678' }] }, S);
    expect(problems.map((p) => [p.path, p.why])).toEqual([
      ['file', 'holds a resident-number'],
      ['files[1]', 'holds a email'],
      ['map.{a key}', 'holds a resident-number'],
      ['nest[1].p', 'holds a phone'],
    ]);
    const text = JSON.stringify(problems);
    for (const v of [RRN, MAIL, '010-1234-5678', 'canary']) expect(text).not.toContain(v);
  });

  test('an identifier field takes letters, digits and _ . : - only, at most 64; objects and numbers are no identifier', () => {
    for (const ok of ['fix-bug', 'AC-1', 'UIUX-NEW-3', 'a.b:c_d', 'x'.repeat(64)]) expect(ID_RE.test(ok)).toBe(true);
    for (const bad of ['', 'a b', 'for Kim 900101-1234567', 'x@y.kr', 'x'.repeat(65), '홍길동', 'a/b']) expect(ID_RE.test(bad)).toBe(false);
    const problems = checkRecordFields({ kind: 'for Kim', tags: ['ok', { a: 1 }, 5, 'a b'] }, S);
    expect(problems.map((p) => p.path)).toEqual(['kind', 'tags[1]', 'tags[2]', 'tags[3]']);
    expect(JSON.stringify(problems)).not.toContain('Kim');
  });

  test('an identifier shaped like a phone, a card or a resident number is refused, though its characters fit (delta review)', () => {
    const problems = checkRecordFields({ kind: '010-1234-5678', tags: ['AC-1', '900101-1234567', '4111-1111-1111-1111'] }, S);
    expect(problems.map((p) => [p.path, p.why])).toEqual([
      ['kind', 'holds a phone'],
      ['tags[1]', 'holds a resident-number'],
      ['tags[2]', 'holds a card'],
    ]);
    for (const v of ['010-1234-5678', '900101-1234567', '4111-1111-1111-1111']) expect(JSON.stringify(problems)).not.toContain(v);
  });

  test('fields in no list and keys on the way are not checked, and a deep path field is reported, not skipped', () => {
    expect(checkRecordFields({ other: { file: RRN }, text: RRN }, S)).toEqual([]);
    let deep: unknown = RRN;
    for (let i = 0; i < 50; i++) deep = { a: deep };
    expect(checkRecordFields({ map: deep }, S).length).toBeGreaterThan(0);
  });

  test('a path listed twice is a bug in the schema', () => {
    expect(() => sanitizeRecord({}, { computed: ['a'], ids: ['a'], paths: [], commands: [], display: [] })).toThrow('listed twice');
  });
});
