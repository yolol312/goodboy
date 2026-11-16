// Track M, M6c (plan §19): the data helpers a test of a real-data sandbox imports. The TypeScript and the plain Node helper are
// run for real (under bun, the CJS one under node too when it is on the PATH), the Java helper is compiled and run when
// `javac` and `java` are on the PATH (else its test is a recorded skip). Each reads a `values.tsv` like the one the resolve step
// leaves in the `data` volume, and none of them may put a value into an error.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataHelperCjs, dataHelperJava, dataHelperTs, MAX_SEQ } from '../lib/sandbox-data-helper';

setDefaultTimeout(120_000);

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m6c-helper-')));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const hex = (s: string): string => Buffer.from(s, 'utf8').toString('hex');
// values no output may contain
const CANARY = 'Kim-Minsoo-0101234567-seoul';
const KOREAN = '김민수'.normalize('NFC');
const NFD = '김민수'.normalize('NFD');

const V = (pick: string, row: string, col: string, text: string | null): string => `V\t${pick}\t${row}\t${col}\t${text === null ? '~' : hex(text)}`;
const VALUES = [
  V('activeUser', 'aaaa', 'name', CANARY),
  V('activeUser', 'aaaa', 'nick', null),
  V('activeUser', 'aaaa', 'empty', ''),
  V('activeUser', 'bbbb', 'name', KOREAN),
  V('activeUser', 'bbbb', 'nick', NFD),
  V('activeUser', 'bbbb', 'empty', ''),
  // a cell the run did not write because it is over the cell limit (the fixed mark, never a cut value)
  'V\tactiveUser\tbbbb\tlong\t!',
  V('orders', 'cccc', 'total', '12.50'),
  'N\tactiveUsers\t27',
  'N\tnone\t0',
  'G\tnewUserEmail\temail\tabcd1234',
  'G\tnewText\ttext\tabcd1234',
  'G\tnewPhone\tphone\tabcd1234',
  'G\tnewNumber\tnumber\t0000000a',
].join('\n') + '\n';

const valuesFile = join(dir, 'values.tsv');
writeFileSync(valuesFile, VALUES);

// A driver that runs every call of the helper and prints what each one gave or threw as JSON.
const driver = join(dir, 'driver.cjs');
writeFileSync(
  driver,
  `
const H = require(process.argv[2]);
const out = {};
const t = (name, f) => {
  try { out[name] = { ok: f() }; }
  catch (e) { out[name] = { err: e.message, name: e.name, keys: Object.keys(e), stack: String(e.stack) }; }
};
t('name0', () => H.valueOf(H.pick('activeUser'), 'name'));
t('nick0', () => H.valueOf(H.pick('activeUser', 0), 'nick'));
t('empty0', () => H.valueOf(H.pick('activeUser', 0), 'empty'));
t('name1', () => H.valueOf(H.pick('activeUser', 1), 'name'));
t('nick1', () => H.valueOf(H.pick('activeUser', 1), 'nick'));
t('other', () => H.valueOf(H.pick('orders'), 'total'));
t('handle', () => JSON.stringify(H.pick('activeUser', 1)));
t('noPick', () => H.pick('missing'));
t('noPickOdd', () => H.pick('bad name with spaces'));
t('noRow', () => H.pick('activeUser', 2));
t('badRow', () => H.pick('activeUser', -1));
t('noColumn', () => H.valueOf(H.pick('activeUser'), 'nope'));
// names a test could build from a value are not echoed, even when they look like plain words
t('noPickSecret', () => H.pick('SECRET-kim'));
t('noColumnSecret', () => H.valueOf(H.pick('activeUser'), 'SECRET-kim'));
t('noCountSecret', () => H.expectedCount('SECRET-kim'));
t('noGenSecret', () => H.generate('SECRET-kim', 0));
t('badRowType', () => H.pick('activeUser', 'SECRET-kim'));
t('badHandle', () => H.valueOf({ pick: 'SECRET-kim', row: 0 }, 'name'));
t('long', () => H.valueOf(H.pick('activeUser', 1), 'long'));
t('longAssert', () => H.assertMatches('anything', H.pick('activeUser', 1), 'long', 'long-id'));
t('longSibling', () => H.valueOf(H.pick('activeUser', 1), 'name'));
t('longMissingInRow0', () => H.valueOf(H.pick('activeUser', 0), 'long'));
t('matchOk', () => H.assertMatches(${JSON.stringify(CANARY)}, H.pick('activeUser', 0), 'name', 'user-name'));
t('matchNull', () => H.assertMatches(null, H.pick('activeUser', 0), 'nick', 'user-nick'));
t('matchNumber', () => H.assertMatches(12.5, H.pick('orders'), 'total', 'order-total'));
t('matchFails', () => H.assertMatches('something else ' + ${JSON.stringify(CANARY)}.slice(0, 5), H.pick('activeUser', 0), 'name', 'order-owner-name'));
t('matchBadId', () => H.assertMatches('x', H.pick('activeUser', 0), 'name', 'has a space'));
t('count', () => H.expectedCount('activeUsers'));
t('countZero', () => H.expectedCount('none'));
t('noCount', () => H.expectedCount('nope'));
t('email', () => H.generate('newUserEmail', 7));
t('text', () => H.generate('newText', 0));
t('phone', () => H.generate('newPhone', 42));
t('number', () => H.generate('newNumber', 5));
t('badSeq', () => H.generate('newText', ${MAX_SEQ + 1}));
t('noGen', () => H.generate('nope', 0));
(async () => {
  if (typeof H.fillFrom === 'function') {
    const filled = [];
    try {
      await H.fillFrom({ fill: async (sel, v) => { filled.push([sel, v]); } }, '#name', H.pick('activeUser', 1), 'name');
      await H.fillFrom({ fill: async (sel, v) => { filled.push([sel, v]); } }, '#nick', H.pick('activeUser', 0), 'nick');
      out.filled = filled;
    } catch (e) {
      out.filled = { err: e.message };
    }
    try {
      await H.fillFrom({ fill: async (sel, v) => { filled.push([sel, v]); } }, '#long', H.pick('activeUser', 1), 'long');
      out.filledLong = { ok: true };
    } catch (e) {
      out.filledLong = { err: e.message, filled: filled.length };
    }
  }
  console.log(JSON.stringify(out));
})();
`,
);

interface Out {
  [k: string]: { ok?: unknown; err?: string; name?: string; keys?: string[]; stack?: string; filled?: number };
}

function runDriver(runtime: 'bun' | 'node', helper: string, env: Record<string, string | undefined>): Out & { filled?: unknown } {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) if (v !== undefined) e[k] = v;
  if (!('GOODBOY_DATA' in env) || env.GOODBOY_DATA === undefined) delete e.GOODBOY_DATA;
  const r = Bun.spawnSync([runtime === 'bun' ? process.execPath : 'node', driver, helper], { env: e, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`driver failed (${runtime}): ${r.stderr.toString().slice(0, 500)}`);
  return JSON.parse(r.stdout.toString());
}

const tsHelper = join(dir, 'goodboy-data.ts');
const cjsHelper = join(dir, 'goodboy-data.cjs');
writeFileSync(tsHelper, dataHelperTs());
writeFileSync(cjsHelper, dataHelperCjs());

const RUNS: [string, 'bun' | 'node', string][] = [
  ['TypeScript helper under bun', 'bun', tsHelper],
  ['CJS helper under bun', 'bun', cjsHelper],
  ...(Bun.which('node') !== null ? ([['CJS helper under node', 'node', cjsHelper]] as [string, 'bun' | 'node', string][]) : []),
];

describe('values.tsv decoded by the TypeScript and the plain Node helper', () => {
  for (const [title, runtime, helper] of RUNS) {
    const o = runDriver(runtime, helper, { GOODBOY_DATA: valuesFile });

    test(`${title}: values, NULL, empty text, Korean in both Unicode forms, rows in file order`, () => {
      expect(o.name0!.ok).toBe(CANARY);
      expect(o.nick0!.ok).toBeNull();
      expect(o.empty0!.ok).toBe('');
      expect(o.name1!.ok).toBe(KOREAN);
      // NFC and NFD stay what the database held: the helper does not normalize
      expect(o.nick1!.ok).toBe(NFD);
      expect(o.nick1!.ok).not.toBe(KOREAN);
      expect(o.other!.ok).toBe('12.50');
      // a handle is a name and a place, with no value
      expect(JSON.parse(o.handle!.ok as string)).toEqual({ pick: 'activeUser', row: 1 });
    });

    test(`${title}: counts and generators`, () => {
      expect(o.count!.ok).toBe(27);
      expect(o.countZero!.ok).toBe(0);
      expect(o.email!.ok).toBe('gbx-abcd1234-7@example.invalid');
      expect(o.text!.ok).toBe('gbx-abcd1234-0');
      expect(o.phone!.ok).toBe('010-0000-0042');
      // 9e12 + (0x0a % 1e8) * 1000 + 5
      expect(o.number!.ok).toBe(String(9_000_000_000_000 + 10 * 1000 + 5));
    });

    test(`${title}: what is not there is said without its name (a name from the caller can be a value), a row by its number`, () => {
      expect(o.noPick!.err).toBe('goodboy-data: an unknown pick name');
      expect(o.noPickOdd!.err).toBe('goodboy-data: an unknown pick name');
      expect(o.noRow!.err).toBe('goodboy-data: no row 2');
      expect(o.badRow!.err).toBe('goodboy-data: no row -1');
      expect(o.noColumn!.err).toBe('goodboy-data: an unknown column name');
      expect(o.noCount!.err).toBe('goodboy-data: an unknown count name');
      expect(o.noGen!.err).toBe('goodboy-data: an unknown generator name');
      expect(o.badSeq!.err).toBe('goodboy-data: bad sequence');
      // a name that looks like a plain word is not echoed either
      expect(o.noPickSecret!.err).toBe('goodboy-data: an unknown pick name');
      expect(o.noColumnSecret!.err).toBe('goodboy-data: an unknown column name');
      expect(o.noCountSecret!.err).toBe('goodboy-data: an unknown count name');
      expect(o.noGenSecret!.err).toBe('goodboy-data: an unknown generator name');
      expect(o.badRowType!.err).toBe('goodboy-data: a bad row index');
      expect(o.badHandle!.err).toBe('goodboy-data: an unknown row');
      expect(JSON.stringify(o)).not.toContain('SECRET');
    });

    test(`${title}: a cell over the limit is a failure that names the pick and the column, never a cut value`, () => {
      const msg = 'goodboy-data: value too long for pick activeUser column long';
      expect(o.long!.err).toBe(msg);
      expect(o.long!.name).toBe('GoodboyDataError');
      // assertMatches reads the value through the same call, so it fails the same way (not with "assertion failed")
      expect(o.longAssert!.err).toBe(msg);
      // the other cells of the row, and a column the row does not have, are as before
      expect(o.longSibling!.ok).toBe(KOREAN);
      expect(o.longMissingInRow0!.err).toBe('goodboy-data: an unknown column name');
    });

    test(`${title}: assertMatches passes on the value, and a failure holds the assertion id and no value`, () => {
      // a passing assertion returns nothing (a JSON object with no `ok` field) and does not throw
      for (const k of ['matchOk', 'matchNull', 'matchNumber']) expect(o[k]).toEqual({});
      const f = o.matchFails!;
      expect(f.err).toBe('goodboy-data: assertion order-owner-name failed');
      expect(f.name).toBe('GoodboyDataError');
      // nothing for a reporter to print: no actual, no expected, no diff, and the stack has neither value
      expect(f.keys).not.toContain('actual');
      expect(f.keys).not.toContain('expected');
      expect(f.keys!.sort()).toEqual(['name']);
      expect(f.stack).not.toContain(CANARY);
      expect(o.matchBadId!.err).toBe('goodboy-data: bad assertion id');
    });
  }

  test('fillFrom (TypeScript helper) types the value of the row into the selector, a NULL as an empty string', () => {
    const o = runDriver('bun', tsHelper, { GOODBOY_DATA: valuesFile });
    expect(o.filled).toEqual([['#name', KOREAN], ['#nick', '']]);
  });

  test('fillFrom of a cell over the limit fills nothing and fails with the same words', () => {
    const o = runDriver('bun', tsHelper, { GOODBOY_DATA: valuesFile });
    expect(o.filledLong).toEqual({ err: 'goodboy-data: value too long for pick activeUser column long', filled: 2 });
  });

  test('the plain Node helper has no fillFrom (it needs a page)', () => {
    expect(runDriver('bun', cjsHelper, { GOODBOY_DATA: valuesFile }).filled).toBeUndefined();
  });
});

describe('outside the sandbox and with a bad file', () => {
  for (const [title, runtime, helper] of RUNS) {
    test(`${title}: with no GOODBOY_DATA every call fails the same way`, () => {
      const o = runDriver(runtime, helper, { GOODBOY_DATA: undefined });
      for (const k of ['name0', 'noPick', 'count', 'email', 'matchOk', 'matchBadId']) expect(o[k]!.err).toBe('goodboy-data: outside the sandbox');
    });

    test(`${title}: an empty variable is outside the sandbox, a missing file is "no data"`, () => {
      expect(runDriver(runtime, helper, { GOODBOY_DATA: '' }).name0!.err).toBe('goodboy-data: outside the sandbox');
      expect(runDriver(runtime, helper, { GOODBOY_DATA: join(dir, 'absent.tsv') }).name0!.err).toBe('goodboy-data: no data');
    });

    test(`${title}: a line of no known shape is "malformed data", and the line is not echoed`, () => {
      for (const [i, bad] of [`V\tp\tr\tc\tnothex${CANARY}`, 'V\tp\tr\tc', `X\t${CANARY}`, 'N\tc\t12x', 'G\tg\temail\tZZZZ'].entries()) {
        const f = join(dir, `bad-${i}.tsv`);
        writeFileSync(f, `${bad}\n`);
        const o = runDriver(runtime, helper, { GOODBOY_DATA: f });
        expect(o.name0!.err).toBe('goodboy-data: malformed data');
        expect(JSON.stringify(o)).not.toContain(CANARY);
      }
    });
  }

  test('an empty file is data with nothing in it: every pick is missing', () => {
    const f = join(dir, 'empty.tsv');
    writeFileSync(f, '');
    for (const [, runtime, helper] of RUNS) expect(runDriver(runtime, helper, { GOODBOY_DATA: f }).name0!.err).toBe('goodboy-data: an unknown pick name');
  });
});

describe('the Java helper', () => {
  const javac = Bun.which('javac');
  const java = Bun.which('java');
  const ready = javac !== null && java !== null;
  if (!ready) console.warn('m6c-helper: javac or java is not on the PATH; the Java helper test is skipped (recorded skip)');

  test.skipIf(!ready)('compiles on its own, decodes values.tsv and fails without a value', () => {
    const src = join(dir, 'java', 'src', 'goodboy');
    const out = join(dir, 'java', 'out');
    mkdirSync(src, { recursive: true });
    mkdirSync(out, { recursive: true });
    writeFileSync(join(src, 'GoodboyData.java'), dataHelperJava());
    writeFileSync(
      join(src, 'Check.java'),
      `package goodboy;
public class Check {
  static String line(String k, Object v) { return k + "=" + v; }
  static String err(Runnable r) { try { r.run(); return "none"; } catch (Throwable e) { return e.getClass().getSimpleName() + ":" + e.getMessage() + ":" + e.getCause(); } }
  public static void main(String[] a) {
    GoodboyData.Handle u0 = GoodboyData.pick("activeUser", 0);
    GoodboyData.Handle u1 = GoodboyData.pick("activeUser");
    GoodboyData.Handle u2 = GoodboyData.pick("activeUser", 1);
    System.out.println(line("name0", GoodboyData.valueOf(u0, "name")));
    System.out.println(line("same", u0.row == u1.row));
    System.out.println(line("nick0", GoodboyData.valueOf(u0, "nick")));
    System.out.println(line("empty0", "[" + GoodboyData.valueOf(u0, "empty") + "]"));
    System.out.println(line("name1", GoodboyData.valueOf(u2, "name")));
    System.out.println(line("nick1", GoodboyData.valueOf(u2, "nick")));
    System.out.println(line("count", GoodboyData.expectedCount("activeUsers")));
    System.out.println(line("email", GoodboyData.generate("newUserEmail", 7)));
    System.out.println(line("text", GoodboyData.generate("newText", 0)));
    System.out.println(line("phone", GoodboyData.generate("newPhone", 42)));
    System.out.println(line("number", GoodboyData.generate("newNumber", 5)));
    GoodboyData.assertMatches(GoodboyData.valueOf(u0, "name"), u0, "name", "user-name");
    GoodboyData.assertMatches(null, u0, "nick", "user-nick");
    System.out.println(line("fails", err(() -> GoodboyData.assertMatches("other", u0, "name", "order-owner-name"))));
    System.out.println(line("badId", err(() -> GoodboyData.assertMatches("x", u0, "name", "has a space"))));
    System.out.println(line("noPick", err(() -> GoodboyData.pick("missing", 0))));
    System.out.println(line("noRow", err(() -> GoodboyData.pick("activeUser", 5))));
    System.out.println(line("noColumn", err(() -> GoodboyData.valueOf(u0, "nope"))));
    System.out.println(line("noPickSecret", err(() -> GoodboyData.pick("SECRET-kim", 0))));
    System.out.println(line("noColumnSecret", err(() -> GoodboyData.valueOf(u0, "SECRET-kim"))));
    System.out.println(line("noCountSecret", err(() -> GoodboyData.expectedCount("SECRET-kim"))));
    System.out.println(line("noGenSecret", err(() -> GoodboyData.generate("SECRET-kim", 0))));
    System.out.println(line("long", err(() -> GoodboyData.valueOf(u2, "long"))));
    System.out.println(line("longAssert", err(() -> GoodboyData.assertMatches("anything", u2, "long", "long-id"))));
    System.out.println(line("longSibling", GoodboyData.valueOf(u2, "name")));
    System.out.println(line("noCount", err(() -> GoodboyData.expectedCount("nope"))));
    System.out.println(line("badSeq", err(() -> GoodboyData.generate("newText", ${MAX_SEQ + 1}))));
  }
}
`,
    );
    const compile = Bun.spawnSync([javac!, '-Xlint:all', '-Werror', '-d', out, join(src, 'GoodboyData.java'), join(src, 'Check.java')], { stdout: 'pipe', stderr: 'pipe' });
    expect(compile.stderr.toString()).toBe('');
    expect(compile.exitCode).toBe(0);
    const run = (env: Record<string, string>) => Bun.spawnSync([java!, '-Dfile.encoding=UTF-8', '-cp', out, 'goodboy.Check'], { env: { PATH: process.env.PATH ?? '', ...env }, stdout: 'pipe', stderr: 'pipe' });
    const r = run({ GOODBOY_DATA: valuesFile });
    expect(r.stderr.toString()).toBe('');
    const got = Object.fromEntries(r.stdout.toString().trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    expect(got).toMatchObject({
      name0: CANARY,
      same: 'true',
      nick0: 'null',
      empty0: '[]',
      name1: KOREAN,
      nick1: NFD,
      count: '27',
      email: 'gbx-abcd1234-7@example.invalid',
      text: 'gbx-abcd1234-0',
      phone: '010-0000-0042',
      number: String(9_000_000_000_000 + 10 * 1000 + 5),
    });
    // a failed assertion: an AssertionError with the id, no cause, no value
    expect(got.fails).toBe('AssertionError:goodboy-data: assertion order-owner-name failed:null');
    expect(got.badId).toBe('IllegalStateException:goodboy-data: bad assertion id:null');
    expect(got.noPick).toBe('IllegalStateException:goodboy-data: an unknown pick name:null');
    expect(got.noRow).toBe('IllegalStateException:goodboy-data: no row 5:null');
    expect(got.noColumn).toBe('IllegalStateException:goodboy-data: an unknown column name:null');
    expect(got.noCount).toBe('IllegalStateException:goodboy-data: an unknown count name:null');
    // a name that looks like a plain word is not echoed
    expect(got.noPickSecret).toBe('IllegalStateException:goodboy-data: an unknown pick name:null');
    expect(got.noColumnSecret).toBe('IllegalStateException:goodboy-data: an unknown column name:null');
    expect(got.noCountSecret).toBe('IllegalStateException:goodboy-data: an unknown count name:null');
    expect(got.noGenSecret).toBe('IllegalStateException:goodboy-data: an unknown generator name:null');
    // a cell over the limit names the pick and the column; assertMatches fails the same way
    expect(got.long).toBe('IllegalStateException:goodboy-data: value too long for pick activeUser column long:null');
    expect(got.longAssert).toBe('IllegalStateException:goodboy-data: value too long for pick activeUser column long:null');
    expect(got.longSibling).toBe(KOREAN);
    expect(r.stdout.toString()).not.toContain('SECRET');
    expect(got.badSeq).toBe('IllegalStateException:goodboy-data: bad sequence:null');
    expect(r.stdout.toString()).not.toContain('other');
    // outside the sandbox the first call fails
    const outside = run({});
    expect(outside.exitCode).not.toBe(0);
    expect(outside.stderr.toString()).toContain('goodboy-data: outside the sandbox');
  });
});
