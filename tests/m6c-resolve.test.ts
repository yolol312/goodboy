// Track M, M6c (plan §19): the resolve step against a stub that plays the database client. What the model sees of a refusal
// or a failure (a field path and a fixed code, never a value), the order of the calls (schema, one enum statement, matches,
// precision, collision, then the one write whose only answer is a line and byte count), that phase 1 is asked once for a
// run, and that nothing the database prints reaches the result.

import { describe, expect, test } from 'bun:test';
import type { Bounded } from '../lib/bounded';
import type { Diag } from '../lib/sandbox-boundary';
import type { DataCtx, DataTarget } from '../lib/sandbox-data';
import { lineBounds, type Manifest, type Memo, parseManifest, resolveValues } from '../lib/sandbox-resolve';

// What a real database could print that must never come out: a row, an error that quotes a row.
const CANARY = 'Kim-Minsoo-0101234567-seoul';
const TOKEN = 'abcd1234';

const SCHEMA = [
  'C\tpublic\tusers\tid\tinteger\tNO',
  'C\tpublic\tusers\tname\ttext\tYES',
  'C\tpublic\tusers\temail\ttext\tYES',
  'C\tpublic\tusers\tstatus\ttext\tYES',
  'C\tpublic\tusers\tage\tinteger\tYES',
  'C\tpublic\tusers\tserial\tbigint\tYES',
  'C\tpublic\tusers\tprice\tnumeric\tYES',
  'C\tpublic\tusers\tscore\tdouble precision\tYES',
  'C\tpublic\tusers\tcreated\ttimestamp without time zone\tYES',
  'C\tpublic\tnopk\tx\tinteger\tYES',
  'C\taudit\tlog\tid\tinteger\tNO',
  'C\taudit\tlog\tmsg\ttext\tYES',
  'S\t0',
  'K\tpublic\tusers\tid\tp\t1',
  'K\taudit\tlog\tid\tp\t1',
].join('\n') + '\n';

const ACTIVE = { col: 'status', op: '=', value: 'active' };
const GOOD = {
  version: 1,
  picks: { activeUser: { table: 'users', where: ACTIVE, n: 3, columns: ['name', 'email'] } },
  counts: { activeUsers: { table: 'users', where: ACTIVE } },
  generate: { newUserEmail: { table: 'users', column: 'email', kind: 'email' } },
};
const manifest = (o: unknown): Manifest => {
  const m = parseManifest(JSON.stringify(o));
  if ('reason' in m) throw new Error(`not a manifest: ${JSON.stringify(m)}`);
  return m;
};
// the lines the write of GOOD gives: 3 rows of 2 columns, one count, one generator; and a byte count it may print
const GOOD_LINES = 6 + 1 + 1;
const done = (lines: number, bytes = 900): string => `${lines} ${bytes}\n`;

type Answer = { stdout?: string; stderr?: string; code?: number | null; timedOut?: boolean; error?: string };
/** An answer, or a function of the SQL the call was given. */
type Reply = Answer | string | ((sql: string) => Answer | string);
interface Stub {
  dc: DataCtx;
  calls: { tag: string; args: string[]; sql: string }[];
}

/** A DataCtx whose database answers by script tag (the resolve step's write is the tag `resolve`). A tag with no answer fails
 *  the call, with a stderr that quotes a row. */
function stub(answers: Record<string, Reply>, o: { target?: DataTarget | null; ready?: boolean; throws?: string } = {}): Stub {
  const calls: Stub['calls'] = [];
  const dc: DataCtx = {
    target: o.target === undefined ? { engine: 'postgres', svc: 'db', db: 'shop' } : o.target,
    comp: async (args, _ms, opts) => {
      const sql = opts?.stdin ?? '';
      const tag = /^-- goodboy-data: (\w+)/.exec(sql)?.[1] ?? 'none';
      calls.push({ tag, args, sql });
      if (o.throws === tag) throw new Error(`boom ${CANARY}`);
      const given = answers[tag];
      const a = typeof given === 'function' ? given(sql) : given;
      const r: Answer = a === undefined ? { code: 1, stderr: `ERROR: relation "${CANARY}" does not exist` } : typeof a === 'string' ? { stdout: a } : a;
      return { code: r.code === undefined ? 0 : r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut: r.timedOut ?? false, ms: 1, ...(r.error !== undefined ? { error: r.error } : {}) } satisfies Bounded;
    },
    ready: async () => o.ready ?? true,
    key: async () => null,
  };
  return { dc, calls };
}

/** Answers for the happy path of GOOD: the catalog, a pick with 10 rows, no row in the generator's space, and the line count. */
const happy = (over: Record<string, Reply> = {}): Record<string, Reply> => ({
  schema: SCHEMA,
  enum: 'E\t0\t3\n',
  matches: 'M\t0\t10\n',
  collision: 'X\t0\t0\n',
  precision: 'D\t0\t99\n',
  resolve: done(GOOD_LINES),
  ...over,
});

const stopOf = async (s: Stub, m: Manifest) => {
  const r = await resolveValues(s.dc, m, TOKEN);
  if (r === null) throw new Error('not stopped');
  // nothing that came out of the database is in what the model sees
  expect(JSON.stringify(r)).not.toContain(CANARY);
  return r;
};

describe('a run that resolves', () => {
  test('the schema, the enum check of a = condition, the matches, the collision check, then one write; null when it all works', async () => {
    const s = stub(happy());
    expect(await resolveValues(s.dc, manifest(GOOD), TOKEN)).toBeNull();
    expect(s.calls.map((c) => c.tag)).toEqual(['schema', 'enum', 'matches', 'collision', 'resolve']);
    // the write is an exec into the database service of the one script, its SQL on stdin
    const w = s.calls[4]!;
    expect(w.args.slice(0, 5)).toEqual(['exec', '-T', 'db', 'sh', '-c']);
    expect(w.args[5]).toContain('/goodboy-data/v.tmp');
    expect(w.args[5]).toContain("'psql'");
    expect(w.sql.startsWith('-- goodboy-data: resolve\n')).toBe(true);
    // the run token is in the SQL, for the generators
    expect(w.sql).toContain(`'G', 'newUserEmail', 'email', '${TOKEN}'`);
    // every phase-1 call goes through the reader role's client, none through the write script
    for (const c of s.calls.slice(0, 4)) expect(c.args[3]).toBe('psql');
  });

  test('no enum query without a = or != condition, no matches query without a pick, no collision query without a generator', async () => {
    const m = manifest({ version: 1, picks: { a: { table: 'users', where: { col: 'age', op: '>', value: 18 }, columns: ['name'] } } });
    const s = stub(happy({ resolve: done(5) }));
    expect(await resolveValues(s.dc, m, TOKEN)).toBeNull();
    expect(s.calls.map((c) => c.tag)).toEqual(['schema', 'matches', 'resolve']);
    const onlyCounts = manifest({ version: 1, counts: { all: { table: 'users' } } });
    const s2 = stub(happy({ resolve: done(1) }));
    expect(await resolveValues(s2.dc, onlyCounts, TOKEN)).toBeNull();
    expect(s2.calls.map((c) => c.tag)).toEqual(['schema', 'resolve']);
    const onlyGen = manifest({ version: 1, generate: { g: { table: 'users', column: 'name', kind: 'text' } } });
    const s3 = stub(happy({ resolve: done(1) }));
    expect(await resolveValues(s3.dc, onlyGen, TOKEN)).toBeNull();
    expect(s3.calls.map((c) => c.tag)).toEqual(['schema', 'collision', 'resolve']);
  });

  test('a manifest with nothing in it makes no call', async () => {
    const s = stub({});
    expect(await resolveValues(s.dc, manifest({ version: 1 }), TOKEN)).toBeNull();
    expect(s.calls).toEqual([]);
  });

  test('a pick with fewer rows than n is fine when the lines add up (n is a maximum, 10 rows at least)', async () => {
    const m = manifest({ version: 1, picks: { a: { table: 'users', where: { col: 'age', op: '>', value: 1 }, n: 20, columns: ['name'] } } });
    const { min, max } = lineBounds(m);
    expect([min, max]).toEqual([10, 20]);
    for (const lines of [10, 15, 20]) expect(await resolveValues(stub(happy({ matches: 'M\t0\t10\n', resolve: done(lines) })).dc, m, TOKEN)).toBeNull();
    for (const lines of [0, 9, 21]) expect((await stopOf(stub(happy({ matches: 'M\t0\t10\n', resolve: done(lines) })), m)).diagnostic).toEqual({ code: 'data-resolve-failed', step: 'resolve', reason: 'lines' });
  });

  test('a table of another schema, and the other engines', async () => {
    const m = manifest({ version: 1, counts: { logs: { table: 'audit.log', where: { col: 'id', op: 'not-null' } } } });
    expect(await resolveValues(stub(happy({ resolve: done(1) })).dc, m, TOKEN)).toBeNull();
    for (const engine of ['mysql', 'mariadb'] as const) {
      const s = stub(happy({ schema: SCHEMA.replace('timestamp without time zone', 'datetime'), resolve: done(GOOD_LINES) }), { target: { engine, svc: 'db', db: 'shop' } });
      expect(await resolveValues(s.dc, manifest(GOOD), TOKEN)).toBeNull();
      expect(s.calls.find((c) => c.tag === 'resolve')!.args[5]).toContain(`'${engine}'`);
    }
  });
});

describe('phase 1 is asked once for a run', () => {
  test('the second resolve of a run (after the second reset) writes again and asks nothing else', async () => {
    const s = stub(happy());
    const memo: Memo = {};
    expect(await resolveValues(s.dc, manifest(GOOD), TOKEN, memo)).toBeNull();
    expect(await resolveValues(s.dc, manifest(GOOD), TOKEN, memo)).toBeNull();
    expect(s.calls.map((c) => c.tag)).toEqual(['schema', 'enum', 'matches', 'collision', 'resolve', 'resolve']);
  });

  test('without the run\'s memo every call asks it all (nothing is kept between runs)', async () => {
    const s = stub(happy());
    expect(await resolveValues(s.dc, manifest(GOOD), TOKEN)).toBeNull();
    expect(await resolveValues(s.dc, manifest(GOOD), TOKEN)).toBeNull();
    expect(s.calls.map((c) => c.tag)).toEqual(['schema', 'enum', 'matches', 'collision', 'resolve', 'schema', 'enum', 'matches', 'collision', 'resolve']);
  });

  test('a refusal is not kept: the same memo asks again', async () => {
    const memo: Memo = {};
    const refusing = stub(happy({ matches: 'M\t0\t9\n' }));
    expect((await resolveValues(refusing.dc, manifest(GOOD), TOKEN, memo))?.diagnostic).toMatchObject({ reason: 'too-few-rows' });
    expect(memo.bound).toBeUndefined();
    const s = stub(happy());
    expect(await resolveValues(s.dc, manifest(GOOD), TOKEN, memo)).toBeNull();
    expect(s.calls.map((c) => c.tag)).toContain('matches');
  });

  test('the write is a call of its own each time: its failure after the first is still a stop', async () => {
    const answers = happy();
    const s = stub(answers);
    const memo: Memo = {};
    expect(await resolveValues(s.dc, manifest(GOOD), TOKEN, memo)).toBeNull();
    answers.resolve = { code: 1, stderr: CANARY };
    const r = await resolveValues(s.dc, manifest(GOOD), TOKEN, memo);
    expect(r!.diagnostic).toEqual({ code: 'data-resolve-failed', step: 'resolve', reason: 'write' });
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });
});

describe('the enum checks are one statement', () => {
  const SEVERAL = {
    version: 1,
    picks: {
      a: { table: 'users', where: ACTIVE, columns: ['name'] },
      b: { table: 'users', where: { and: [ACTIVE, { col: 'name', op: '!=', value: 'x' }] }, columns: ['name'] },
    },
    counts: { logs: { table: 'audit.log', where: { col: 'msg', op: '=', value: 'm' } }, again: { table: 'users', where: { col: 'status', op: '!=', value: 'gone' } } },
  };

  test('every column of every entry, each once, in the one call, in the order the manifest first uses them', async () => {
    // two picks of one column (5 rows each) and two counts: 12 lines
    const m = manifest(SEVERAL);
    const s = stub(happy({ enum: 'E\t0\t3\nE\t1\t3\nE\t2\t3\n', matches: 'M\t0\t10\nM\t1\t10\n', resolve: done(lineBounds(m).max) }));
    expect(await resolveValues(s.dc, m, TOKEN)).toBeNull();
    expect(s.calls.map((c) => c.tag)).toEqual(['schema', 'enum', 'matches', 'resolve']);
    const sql = s.calls[1]!.sql;
    // users.status (tested by three entries) once, users.name once, audit.log.msg once
    expect(sql.match(/SELECT 'E', \d+,/g)).toEqual(["SELECT 'E', 0,", "SELECT 'E', 1,", "SELECT 'E', 2,"]);
    expect(sql.match(/FROM "public"\."users" LIMIT/g)).toHaveLength(2);
    expect(sql.match(/FROM "audit"\."log" LIMIT/g)).toHaveLength(1);
    expect(sql.indexOf('"status"')).toBeLessThan(sql.indexOf('"name"'));
    expect(sql.indexOf('"name"')).toBeLessThan(sql.indexOf('"msg"'));
  });

  test('a column over 50 values is refused with the path of the first entry that tested it', async () => {
    const s = stub(happy({ enum: 'E\t0\t3\nE\t1\t51\nE\t2\t3\n', matches: 'M\t0\t10\nM\t1\t10\n' }));
    const r = await stopOf(s, manifest(SEVERAL));
    expect(r.diagnostic).toEqual({ code: 'data-refused', step: 'resolve', field: 'picks.b.where.and[1].col', reason: 'not-enum-like' });
    expect(s.calls.map((c) => c.tag)).toEqual(['schema', 'enum']);
  });

  test('a long list is asked 25 columns at a time (they share a statement time limit)', async () => {
    const cols = Array.from({ length: 30 }, (_, i) => `c${i}`);
    const schema = ['C\tpublic\tbig\tid\tinteger\tNO', ...cols.map((c) => `C\tpublic\tbig\t${c}\ttext\tYES`), 'S\t0', 'K\tpublic\tbig\tid\tp\t1'].join('\n') + '\n';
    const counts = Object.fromEntries(cols.map((c, i) => [`n${i}`, { table: 'big', where: { col: c, op: '=', value: 'v' } }]));
    const m = manifest({ version: 1, counts });
    // the enum calls are answered by the number of lines they ask for
    const s = stub(happy({ schema, enum: (sql) => Array.from({ length: (sql.match(/SELECT 'E'/g) ?? []).length }, (_, i) => `E\t${i}\t2\n`).join(''), resolve: done(30) }));
    expect(await resolveValues(s.dc, m, TOKEN)).toBeNull();
    const enums = s.calls.filter((c) => c.tag === 'enum');
    expect(enums.map((c) => (c.sql.match(/SELECT 'E'/g) ?? []).length)).toEqual([25, 5]);
  });
});

describe('a manifest the schema does not fit is refused with a path and a reason', () => {
  const cases: [string, unknown, Record<string, Reply>, string, string][] = [
    ['an unknown pick table', { version: 1, picks: { a: { table: 'nope', where: ACTIVE, columns: ['x'] } } }, {}, 'picks.a.table', 'unknown-table'],
    ['an unknown count table', { version: 1, counts: { a: { table: 'nope' } } }, {}, 'counts.a.table', 'unknown-table'],
    ['an unknown generator table', { version: 1, generate: { a: { table: 'nope', column: 'x', kind: 'text' } } }, {}, 'generate.a.table', 'unknown-table'],
    ['an unknown column to pick', { version: 1, picks: { a: { table: 'users', where: ACTIVE, columns: ['name', 'nope'] } } }, {}, 'picks.a.columns[1]', 'unknown-column'],
    ['an unknown column in a condition', { version: 1, picks: { a: { table: 'users', where: { and: [ACTIVE, { col: 'nope', op: 'is-null' }] }, columns: ['name'] } } }, {}, 'picks.a.where.and[1].col', 'unknown-column'],
    ['a count condition on a column that is not there', { version: 1, counts: { a: { table: 'users', where: { col: 'nope', op: 'not-null' } } } }, {}, 'counts.a.where.col', 'unknown-column'],
    ['a comparison on a text column', { version: 1, counts: { a: { table: 'users', where: { col: 'name', op: '>', value: 3 } } } }, {}, 'counts.a.where.value', 'bad-type'],
    ['an equality of a number with a text column', { version: 1, counts: { a: { table: 'users', where: { col: 'name', op: '=', value: 3 } } } }, {}, 'counts.a.where.value', 'bad-type'],
    ['a pick of a table with no primary key', { version: 1, picks: { a: { table: 'nopk', where: { col: 'x', op: 'not-null' }, columns: ['x'] } } }, {}, 'picks.a.table', 'no-primary-key'],
    ['an email generator on a number column', { version: 1, generate: { a: { table: 'users', column: 'age', kind: 'email' } } }, {}, 'generate.a.kind', 'bad-type'],
    ['a number generator on a text column', { version: 1, generate: { a: { table: 'users', column: 'name', kind: 'number' } } }, {}, 'generate.a.kind', 'bad-type'],
    ['a number generator on a 32-bit integer column (its values need 64 bits)', { version: 1, generate: { a: { table: 'users', column: 'age', kind: 'number' } } }, {}, 'generate.a.kind', 'too-narrow'],
    ['a number generator on a floating point column', { version: 1, generate: { a: { table: 'users', column: 'score', kind: 'number' } } }, {}, 'generate.a.kind', 'too-narrow'],
    ['a number generator on a decimal column of 12 integer digits', { version: 1, generate: { a: { table: 'users', column: 'price', kind: 'number' } } }, { precision: 'D\t0\t12\n' }, 'generate.a.kind', 'too-narrow'],
    ['a generator on a column that is not there', { version: 1, generate: { a: { table: 'users', column: 'nope', kind: 'text' } } }, {}, 'generate.a.column', 'unknown-column'],
    ['a = condition on a column of more than 50 values', { version: 1, counts: { a: { table: 'users', where: ACTIVE } } }, { enum: 'E\t0\t51\n' }, 'counts.a.where.col', 'not-enum-like'],
    ['a pick with a condition that matches 9 rows', GOOD, { matches: 'M\t0\t9\n' }, 'picks.activeUser.where', 'too-few-rows'],
  ];
  for (const [title, doc, answers, field, reason] of cases) {
    test(`${title}: ${field} ${reason}`, async () => {
      const s = stub(happy(answers));
      const r = await stopOf(s, manifest(doc));
      expect(r.diagnostic).toEqual({ code: 'data-refused', step: 'resolve', field, reason });
      expect(r.stop).toBe(`data.json is refused at ${field}: ${reason}`);
      // nothing was written
      expect(s.calls.some((c) => c.tag === 'resolve')).toBe(false);
    });
  }

  test('the first refusal in the manifest order is the one named, and a refusal by the schema comes before any matches query', async () => {
    const s = stub(happy());
    const r = await stopOf(s, manifest({ version: 1, picks: { a: { table: 'nope', where: ACTIVE, columns: ['x'] }, b: { table: 'users', where: ACTIVE, columns: ['nope'] } } }));
    expect(r.diagnostic).toMatchObject({ field: 'picks.a.table' });
    expect(s.calls.map((c) => c.tag)).toEqual(['schema']);
  });

  test('a generator is judged by the kind: email, phone and text want a text column, a number a bigint or a wide enough decimal', async () => {
    const kinds = { email: 'email', phone: 'name', text: 'name' } as const;
    for (const [kind, column] of Object.entries(kinds)) {
      const m = manifest({ version: 1, generate: { g: { table: 'users', column, kind } } });
      expect(await resolveValues(stub(happy({ resolve: done(1) })).dc, m, TOKEN)).toBeNull();
    }
    const n = manifest({ version: 1, generate: { g: { table: 'users', column: 'serial', kind: 'number' } } });
    const bigint = stub(happy({ resolve: done(1) }));
    expect(await resolveValues(bigint.dc, n, TOKEN)).toBeNull();
    // a bigint column needs no question about its width
    expect(bigint.calls.map((c) => c.tag)).toEqual(['schema', 'collision', 'resolve']);
  });

  test('a decimal column is asked its width: 13 integer digits or more (or no limit) is wide enough', async () => {
    const m = manifest({ version: 1, generate: { g: { table: 'users', column: 'price', kind: 'number' } } });
    for (const digits of [13, 18, 99]) {
      const s = stub(happy({ precision: `D\t0\t${digits}\n`, resolve: done(1) }));
      expect(await resolveValues(s.dc, m, TOKEN)).toBeNull();
      expect(s.calls.map((c) => c.tag)).toEqual(['schema', 'precision', 'collision', 'resolve']);
    }
    const narrow = stub(happy({ precision: 'D\t0\t12\n' }));
    expect((await stopOf(narrow, m)).diagnostic).toEqual({ code: 'data-refused', step: 'resolve', field: 'generate.g.kind', reason: 'too-narrow' });
    // a collision is never looked for in a column the generator cannot write
    expect(narrow.calls.map((c) => c.tag)).toEqual(['schema', 'precision']);
    expect((await stopOf(stub(happy({ precision: 'D\t0\tmany\n' })), m)).diagnostic).toEqual({ code: 'data-resolve-failed', step: 'resolve', reason: 'precision' });
    expect((await stopOf(stub(happy({ precision: { code: 1, stderr: CANARY } })), m)).diagnostic).toEqual({ code: 'data-resolve-failed', step: 'resolve', reason: 'precision' });
  });
});

describe('a generator whose space the dump already uses', () => {
  test('is a collision: the generator named, nothing written', async () => {
    const s = stub(happy({ collision: 'X\t0\t1\n' }));
    const r = await stopOf(s, manifest(GOOD));
    expect(r.diagnostic).toEqual({ code: 'data-collision', step: 'resolve', field: 'generate.newUserEmail' });
    expect(r.stop).toContain('generate.newUserEmail');
    expect(s.calls.map((c) => c.tag)).toEqual(['schema', 'enum', 'matches', 'collision']);
  });

  test('a pick that is too small is judged before a collision is (the collision statement is not even asked)', async () => {
    const s = stub(happy({ matches: 'M\t0\t3\n', collision: 'X\t0\t1\n' }));
    const r = await stopOf(s, manifest(GOOD));
    expect(r.diagnostic).toMatchObject({ code: 'data-refused', reason: 'too-few-rows' });
    expect(s.calls.some((c) => c.tag === 'collision')).toBe(false);
  });

  test('the check is a statement of its own: a slow one fails with the reason `collision`, a time limit with `collision-timeout`', async () => {
    const m = manifest(GOOD);
    const failed = (reason: string): Diag => ({ code: 'data-resolve-failed', step: 'resolve', reason });
    expect((await stopOf(stub(happy({ collision: { code: 1, stderr: CANARY } })), m)).diagnostic).toEqual(failed('collision'));
    expect((await stopOf(stub(happy({ collision: `X\t0\t0\n${CANARY}\n` })), m)).diagnostic).toEqual(failed('collision'));
    expect((await stopOf(stub(happy({ collision: { code: 1, stderr: 'psql:<stdin>:4: ERROR:  57014' } })), m)).diagnostic).toEqual(failed('collision-timeout'));
    expect((await stopOf(stub(happy({ collision: { timedOut: true } })), m)).diagnostic).toEqual(failed('collision-timeout'));
    // the matches statement, asked before it, is not touched by a slow collision check
    const s = stub(happy({ collision: { code: 1, stderr: 'ERROR:  57014' } }));
    await stopOf(s, m);
    expect(s.calls.map((c) => c.tag)).toEqual(['schema', 'enum', 'matches', 'collision']);
  });
});

describe('a failure is a fixed code and no text of the database', () => {
  const m = manifest(GOOD);
  const failed = (reason?: string): Diag => ({ code: 'data-resolve-failed', step: 'resolve', ...(reason === undefined ? {} : { reason }) });

  test('the catalog cannot be read, or is cut off', async () => {
    expect((await stopOf(stub(happy({ schema: { code: 1, stderr: CANARY } })), m)).diagnostic).toEqual(failed('schema'));
    expect((await stopOf(stub(happy({ schema: `${SCHEMA}${CANARY}` })), m)).diagnostic).toEqual(failed('schema'));
    expect((await stopOf(stub(happy({ schema: { timedOut: true } })), m)).diagnostic).toEqual(failed('schema'));
    expect((await stopOf(stub(happy({ schema: { error: `spawn ${CANARY}` } })), m)).diagnostic).toEqual(failed('schema'));
  });

  test('the enum, matches and write answers are of an exact shape or the run stops', async () => {
    expect((await stopOf(stub(happy({ enum: `E\t0\t3\n${CANARY}\n` })), m)).diagnostic).toEqual(failed('enum'));
    expect((await stopOf(stub(happy({ enum: { code: 2 } })), m)).diagnostic).toEqual(failed('enum'));
    expect((await stopOf(stub(happy({ matches: `M\t0\t10\n${CANARY}\n` })), m)).diagnostic).toEqual(failed('matches'));
    // another statement's tag in the answer
    expect((await stopOf(stub(happy({ matches: 'M\t0\t10\nX\t0\t0\n' })), m)).diagnostic).toEqual(failed('matches'));
    expect((await stopOf(stub(happy({ matches: '' })), m)).diagnostic).toEqual(failed('matches'));
    expect((await stopOf(stub(happy({ matches: { code: 1, stderr: CANARY } })), m)).diagnostic).toEqual(failed('matches'));
  });

  test('a statement that ran into its time limit has a reason of its own (the call\'s time, or the engine\'s time limit error code)', async () => {
    for (const [tag, reason] of [['enum', 'enum-timeout'], ['matches', 'matches-timeout'], ['collision', 'collision-timeout']] as const) {
      expect((await stopOf(stub(happy({ [tag]: { timedOut: true, stderr: CANARY } })), m)).diagnostic).toEqual(failed(reason));
      for (const text of ['psql:<stdin>:4: ERROR:  57014', `ERROR 3024 (HY000) at line 1: ${CANARY}`, 'ERROR 1969 (70100) at line 1: Query execution was interrupted']) {
        expect((await stopOf(stub(happy({ [tag]: { code: 1, stderr: text } })), m)).diagnostic).toEqual(failed(reason));
      }
      // an error that only mentions such a number is not a time limit
      expect((await stopOf(stub(happy({ [tag]: { code: 1, stderr: 'ERROR:  22P02 near 57013 or 3024' } })), m)).diagnostic).toEqual(failed(tag));
    }
  });

  test('the write fails, times out, runs into a statement limit, is too large, or prints numbers that cannot be this manifest', async () => {
    for (const w of [{ code: 1, stderr: `ERROR ${CANARY}` }, { error: CANARY }, { code: null }, { code: 3 }]) {
      expect((await stopOf(stub(happy({ resolve: w })), m)).diagnostic).toEqual(failed('write'));
    }
    // the script's exit codes: 124 a statement time limit, 125 a file over the byte limit; the call's own time is a time limit too
    for (const w of [{ timedOut: true }, { code: 124, stderr: CANARY }]) expect((await stopOf(stub(happy({ resolve: w })), m)).diagnostic).toEqual(failed('write-timeout'));
    expect((await stopOf(stub(happy({ resolve: { code: 125, stderr: CANARY } })), m)).diagnostic).toEqual(failed('too-large'));
    for (const out of ['', 'ok\n', done(GOOD_LINES - 1), done(GOOD_LINES + 1), `${GOOD_LINES}\n`, `${GOOD_LINES} 5 5\n`, `${GOOD_LINES}\n${GOOD_LINES} 5\n`, `V\ta\t${Buffer.from(CANARY).toString('hex')}\n`, `x${GOOD_LINES} 5`, '-8 5\n']) {
      expect([out, (await stopOf(stub(happy({ resolve: out })), m)).diagnostic]).toEqual([out, failed('lines')]);
    }
    // the container checks the byte limit; goodboy checks the number it is told too
    expect(await resolveValues(stub(happy({ resolve: done(GOOD_LINES, 4 * 1024 * 1024) })).dc, m, TOKEN)).toBeNull();
    expect((await stopOf(stub(happy({ resolve: done(GOOD_LINES, 4 * 1024 * 1024 + 1) })), m)).diagnostic).toEqual(failed('too-large'));
    // spaces round the numbers are what `wc` prints on some systems
    expect(await resolveValues(stub(happy({ resolve: `   ${GOOD_LINES}   42  \n` })).dc, m, TOKEN)).toBeNull();
  });

  test('the daemon or the compose file is not safe, and an exception is a code too', async () => {
    const notReady = stub(happy(), { ready: false });
    expect((await stopOf(notReady, m)).diagnostic).toEqual(failed('compose'));
    expect(notReady.calls).toEqual([]);
    expect((await stopOf(stub(happy(), { throws: 'matches' }), m)).diagnostic).toEqual(failed());
  });

  test('a project with no SQL store has no data to resolve', async () => {
    const s = stub({}, { target: null });
    const r = await stopOf(s, m);
    expect(r.diagnostic).toEqual({ code: 'data-refused', step: 'resolve', field: 'store', reason: 'no-sql-store' });
    expect(s.calls).toEqual([]);
  });

  test('an empty manifest needs no store: nothing is asked, nothing refused', async () => {
    const s = stub({}, { target: null });
    expect(await resolveValues(s.dc, manifest({ version: 1 }), TOKEN)).toBeNull();
    expect(await resolveValues(s.dc, manifest({ version: 1, picks: {}, counts: {}, generate: {} }), TOKEN)).toBeNull();
    expect(s.calls).toEqual([]);
  });

  test('what the write printed is never in the result, even when it holds a value', async () => {
    const hex = Buffer.from(CANARY).toString('hex');
    const r = await stopOf(stub(happy({ resolve: `V\tactiveUser\taaaa\tname\t${hex}\n${CANARY}\n` })), m);
    expect(r.diagnostic.reason).toBe('lines');
    expect(JSON.stringify(r)).not.toContain(hex);
  });
});
