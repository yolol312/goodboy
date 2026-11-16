// Track M, M6b (plan §19): `sandbox-data` end to end. First against a stub that plays the database
// client (what the model sees, call by call, and that nothing the database prints reaches the output), then
// through the CLI against the fake docker of tests/m6a-fake.ts (the handle key in the `meta` volume, handles
// across resets and across sandboxes).

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bounded } from '../lib/bounded';
import { clientArgv, type DataCtx, type DataTarget, handleOf, sandboxData } from '../lib/sandbox-data';
import { META_DIR, META_KEY_SCRIPT, parseMetaKey } from '../lib/sandbox-volumes';
import { cleanupFakeProjects, CLI, fakeProject, type FakeProject } from './m6a-project';

setDefaultTimeout(120_000);
afterEach(cleanupFakeProjects);

// What a real database could print that must never come out: a row, an error that quotes a row, a hint.
const CANARY = 'Kim-Minsoo-0101234567-seoul';
const CANARY_HEX = Buffer.from(CANARY).toString('hex');
const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

const SCHEMA = [
  'C\tpublic\tusers\tid\tinteger\tNO',
  'C\tpublic\tusers\tname\ttext\tYES',
  'C\tpublic\tusers\tstatus\ttext\tYES',
  'C\tpublic\tusers\tage\tinteger\tYES',
  'C\tpublic\tusers\tcreated\ttimestamp without time zone\tYES',
  'C\tpublic\tnopk\tx\tinteger\tYES',
  'C\taudit\tlog\tid\tinteger\tNO',
  'S\t2',
  'K\tpublic\tusers\tid\tp\t1',
  'K\taudit\tlog\tid\tp\t1',
].join('\n') + '\n';
const ROWCOUNTS = 'R\t0\t40\nR\t1\t1\nR\t2\t0\n';

type Answer = { stdout?: string; stderr?: string; code?: number | null; timedOut?: boolean; error?: string };
interface Stub {
  dc: DataCtx;
  /** Each docker call: the tag of its SQL and its argv. */
  calls: { tag: string; args: string[]; sql: string }[];
  ready: { n: number };
}

/** A DataCtx whose database answers by script tag. A tag with no answer fails the call. */
function stub(answers: Record<string, Answer | string>, o: { target?: DataTarget | null; key?: string | null; ready?: boolean } = {}): Stub {
  const calls: Stub['calls'] = [];
  const ready = { n: 0 };
  const dc: DataCtx = {
    target: o.target === undefined ? { engine: 'postgres', svc: 'db', db: 'shop' } : o.target,
    comp: async (args, _ms, opts) => {
      const sql = opts?.stdin ?? '';
      const tag = /^-- goodboy-data: (\w+)/.exec(sql)?.[1] ?? 'none';
      calls.push({ tag, args, sql });
      const a = answers[tag];
      const r: Answer = a === undefined ? { code: 1, stderr: `ERROR: relation "${CANARY}" does not exist` } : typeof a === 'string' ? { stdout: a } : a;
      return { code: r.code === undefined ? 0 : r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut: r.timedOut ?? false, ms: 1, ...(r.error !== undefined ? { error: r.error } : {}) } satisfies Bounded;
    },
    ready: async () => {
      ready.n++;
      return o.ready ?? true;
    },
    key: async () => (o.key === undefined ? KEY : o.key),
  };
  return { dc, calls, ready };
}

const run = async (s: Stub, ...args: string[]): Promise<{ out: Record<string, any>; code: number } | { error: string }> => (await sandboxData(s.dc, args)) as never;
const ok = async (s: Stub, ...args: string[]): Promise<Record<string, any>> => {
  const r = await run(s, ...args);
  if ('error' in r) throw new Error(r.error);
  return r.out;
};
const diag = async (s: Stub, ...args: string[]): Promise<{ code: number; diagnostic: Record<string, any> }> => {
  const r = await run(s, ...args);
  if ('error' in r) throw new Error(r.error);
  expect(r.out.ok).toBe(false);
  return { code: r.code, diagnostic: r.out.diagnostic };
};

const WHERE_ENUM = '{"col":"status","op":"=","value":"ACTIVE"}';

describe('schema', () => {
  test('tables, columns, flags and row-count buckets, and the catalog is asked before the counts', async () => {
    const s = stub({ schema: SCHEMA, rowcounts: ROWCOUNTS });
    const out = await ok(s, 'schema');
    expect(s.calls.map((c) => c.tag)).toEqual(['schema', 'rowcounts']);
    expect(out).toMatchObject({ op: 'schema', ok: true, engine: 'postgres', skippedNames: 2 });
    expect(out.tables.map((t: any) => [t.name, t.rows])).toEqual([
      ['users', '10-99'],
      ['nopk', '<10'],
      ['audit.log', '0'],
    ]);
    expect(out.tables[0].columns[0]).toEqual({ name: 'id', type: 'integer', nullable: false, pk: true, fk: false });
    expect(out.tables[0].columns[1]).toEqual({ name: 'name', type: 'text', nullable: true, pk: false, fk: false });
    expect(out.truncated).toBeUndefined();
  });

  test('the same operation is the same code for every engine: only the client changes', async () => {
    for (const engine of ['mysql', 'mariadb'] as const) {
      const s = stub({ schema: SCHEMA.replace(/timestamp without time zone/, 'datetime'), rowcounts: ROWCOUNTS }, { target: { engine, svc: 'db', db: 'shop' } });
      const out = await ok(s, 'schema');
      expect(out.engine).toBe(engine);
      expect(s.calls[0]!.args.slice(0, 4)).toEqual(['exec', '-T', 'db', engine === 'mariadb' ? 'mariadb' : 'mysql']);
    }
  });

  test('no argument and no table is asked of the model, and bad input never reaches docker', async () => {
    const s = stub({});
    expect(await diag(s, 'schema', 'extra')).toMatchObject({ code: 1, diagnostic: { code: 'data-refused', step: 'schema', field: 'args', reason: 'unexpected' } });
    expect(s.calls).toEqual([]);
    expect(s.ready.n).toBe(0);
  });
});

describe('shape', () => {
  const SHAPE = 'C\temail-like\t40\nL\t9-32\t40\nD\t40\nT\t40\n';

  test('categories, lengths, a distinct bucket and enumLike, with no value', async () => {
    const s = stub({ schema: SCHEMA, shape: SHAPE });
    const out = await ok(s, 'shape', 'users.name');
    expect(s.calls.map((c) => c.tag)).toEqual(['schema', 'shape']);
    expect(out).toMatchObject({ op: 'shape', table: 'users', column: 'name', distinct: '10-50', enumLike: true, sampled: false });
    expect(out.categories['email-like']).toBe(40);
    expect(out.categories.null).toBe('<10');
    expect(s.calls[1]!.sql).toContain('CAST("name" AS text)');
  });

  test('a column or table the schema does not have is refused at its own field', async () => {
    const s = stub({ schema: SCHEMA, shape: SHAPE });
    expect(await diag(s, 'shape', 'users.nope')).toMatchObject({ diagnostic: { code: 'data-refused', field: 'column', reason: 'unknown-column' } });
    expect(await diag(s, 'shape', 'nowhere.name')).toMatchObject({ diagnostic: { code: 'data-refused', field: 'table', reason: 'unknown-table' } });
    expect(s.calls.every((c) => c.tag === 'schema')).toBe(true);
  });
});

describe('count', () => {
  test('an exact count from 10 up, "<10" below', async () => {
    expect((await ok(stub({ schema: SCHEMA, count: 'N\t1234\n' }), 'count', 'users')).count).toBe(1234);
    expect((await ok(stub({ schema: SCHEMA, count: 'N\t10\n' }), 'count', 'users')).count).toBe(10);
    expect((await ok(stub({ schema: SCHEMA, count: 'N\t9\n' }), 'count', 'users')).count).toBe('<10');
    expect((await ok(stub({ schema: SCHEMA, count: 'N\t0\n' }), 'count', 'users')).count).toBe('<10');
  });

  test('a condition on a plain column needs no enum check; `=` asks the enum check first', async () => {
    const plain = stub({ schema: SCHEMA, count: 'N\t55\n' });
    await ok(plain, 'count', 'users', '--where', '{"col":"age","op":">","value":30}');
    expect(plain.calls.map((c) => c.tag)).toEqual(['schema', 'count']);
    expect(plain.calls[1]!.sql).toContain('WHERE ("age" > 30)');
    const eq = stub({ schema: SCHEMA, enum: 'E\t0\t3\n', count: 'N\t55\n' });
    expect((await ok(eq, 'count', 'users', '--where', WHERE_ENUM)).count).toBe(55);
    expect(eq.calls.map((c) => c.tag)).toEqual(['schema', 'enum', 'count']);
    expect(eq.calls[2]!.sql).toContain(`WHERE ("status" = 'ACTIVE')`);
  });

  test('`=` on a column with more than 50 distinct values is refused, and no count is asked', async () => {
    const s = stub({ schema: SCHEMA, enum: 'E\t0\t51\n', count: 'N\t55\n' });
    expect(await diag(s, 'count', 'users', '--where', `{"and":[{"col":"age","op":">","value":1},${WHERE_ENUM}]}`)).toMatchObject({ code: 1, diagnostic: { code: 'data-refused', step: 'count', field: 'where.and[1].col', reason: 'not-enum-like' } });
    expect(s.calls.map((c) => c.tag)).toEqual(['schema', 'enum']);
  });

  test('a condition is checked against the catalog before any query of the data', async () => {
    const s = stub({ schema: SCHEMA, count: 'N\t55\n' });
    expect(await diag(s, 'count', 'users', '--where', '{"col":"ghost","op":"is-null"}')).toMatchObject({ diagnostic: { field: 'where.col', reason: 'unknown-column' } });
    expect(await diag(s, 'count', 'users', '--where', '{"col":"name","op":">","value":3}')).toMatchObject({ diagnostic: { field: 'where.value', reason: 'bad-type' } });
    expect(await diag(s, 'count', 'ghosts')).toMatchObject({ diagnostic: { field: 'table', reason: 'unknown-table' } });
    expect(s.calls.every((c) => c.tag === 'schema')).toBe(true);
  });
});

describe('pick', () => {
  const PICK = `M\t10\nP\t${CANARY_HEX}\nP\t3132\nP\t3132\n`;

  test('handles only: the primary key (as hex, even a canary one) never comes out, the handle is the HMAC of it', async () => {
    const s = stub({ schema: SCHEMA, pick: PICK });
    const out = await ok(s, 'pick', 'users', '--where', '{"col":"age","op":">","value":1}', '--n', '3');
    expect(out.op).toBe('pick');
    expect(out.handles).toEqual([handleOf(KEY, 'postgres', 'shop', 'users', [CANARY_HEX]), handleOf(KEY, 'postgres', 'shop', 'users', ['3132'])]);
    const text = JSON.stringify(out);
    for (const leak of [CANARY, CANARY_HEX, '3132']) expect(text).not.toContain(leak);
    expect(s.calls[1]!.sql).toContain('LIMIT 3;');
    expect(s.calls[1]!.sql).toContain(`encode(convert_to(CAST("id" AS text), 'UTF8'), 'hex')`);
  });

  test('refused when the condition matches fewer than 10 rows', async () => {
    const s = stub({ schema: SCHEMA, pick: `M\t9\nP\t${CANARY_HEX}\n` });
    const d = await diag(s, 'pick', 'users', '--where', '{"col":"age","op":">","value":1}');
    expect(d).toEqual({ code: 1, diagnostic: { code: 'data-refused', step: 'pick', field: 'where', reason: 'too-few-rows' } });
  });

  test('a table with no primary key has no handles', async () => {
    const s = stub({ schema: SCHEMA, pick: 'M\t10\n' });
    expect(await diag(s, 'pick', 'nopk', '--where', '{"col":"x","op":"not-null"}')).toMatchObject({ diagnostic: { field: 'table', reason: 'no-primary-key' } });
    expect(s.calls.map((c) => c.tag)).toEqual(['schema']);
  });

  test('a handle key that cannot be read is a failure, not a handle', async () => {
    const s = stub({ schema: SCHEMA, pick: PICK }, { key: null });
    expect(await diag(s, 'pick', 'users', '--where', '{"col":"age","op":">","value":1}')).toEqual({ code: 1, diagnostic: { code: 'data-failed', step: 'pick' } });
  });
});

describe('what a failure says', () => {
  const WHERE_AGE = '{"col":"age","op":">","value":1}';

  test('any failure is data-failed with the op name; the text of the database is never in the output', async () => {
    const cases: [string, Record<string, Answer | string>][] = [
      ['a non-zero exit with an error that quotes a row', { schema: { code: 1, stderr: `ERROR: duplicate key value (${CANARY})`, stdout: CANARY } }],
      ['a timeout', { schema: { code: null, timedOut: true, stdout: CANARY } }],
      ['a client that could not start', { schema: { code: null, error: `spawn ${CANARY} failed` } }],
      ['an answer of another shape', { schema: `${CANARY}\n` }],
      ['an answer with a line of a row', { schema: `${SCHEMA}C\tpublic\tusers\t${CANARY}\ttext\tYES\n` }],
      ['an answer with no closing newline', { schema: SCHEMA.trimEnd() }],
      ['an empty answer', { schema: '' }],
      ['an answer cut off at the byte cap', { schema: 'x'.repeat(4 * 1024 * 1024) }],
    ];
    for (const [name, answers] of cases) {
      const s = stub(answers);
      const r = await run(s, 'count', 'users');
      if ('error' in r) throw new Error(r.error);
      expect([name, r.code, r.out.diagnostic]).toEqual([name, 1, { code: 'data-failed', step: 'count' }]);
      expect([name, JSON.stringify(r).includes(CANARY)]).toEqual([name, false]);
    }
  });

  test('a failing second step fails the whole operation the same way, for each op', async () => {
    const bad = { code: 3, stderr: `FATAL: ${CANARY}`, stdout: `${CANARY}\n` };
    for (const [args, tag] of [
      [['schema'], 'rowcounts'],
      [['shape', 'users.name'], 'shape'],
      [['count', 'users'], 'count'],
      [['count', 'users', '--where', WHERE_ENUM], 'enum'],
      [['pick', 'users', '--where', WHERE_AGE], 'pick'],
    ] as const) {
      const s = stub({ schema: SCHEMA, [tag]: bad });
      const r = await run(s, ...args);
      if ('error' in r) throw new Error(r.error);
      expect([tag, r.out.diagnostic]).toEqual([tag, { code: 'data-failed', step: args[0] }]);
      expect(JSON.stringify(r)).not.toContain(CANARY);
    }
  });

  test('a daemon or compose file that is not safe, an exception, and a project with no SQL store', async () => {
    expect(await diag(stub({ schema: SCHEMA }, { ready: false }), 'schema')).toEqual({ code: 1, diagnostic: { code: 'data-failed', step: 'schema' } });
    const boom = stub({ schema: SCHEMA });
    boom.dc.comp = async () => {
      throw new Error(CANARY);
    };
    const r = await run(boom, 'schema');
    expect(JSON.stringify(r)).not.toContain(CANARY);
    expect(r).toMatchObject({ code: 1, out: { diagnostic: { code: 'data-failed', step: 'schema' } } });
    expect(await diag(stub({}, { target: null }), 'count', 'users')).toMatchObject({ diagnostic: { code: 'data-refused', field: 'store', reason: 'no-sql-store' } });
  });

  test('an unknown op is a usage error naming the four ops, with none of the input', async () => {
    const r = await run(stub({}), CANARY);
    expect(r).toEqual({ error: expect.stringContaining('schema, shape <table>.<col>, count') });
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });
});

describe('the client', () => {
  test('connects as the read-only role, reads the SQL from stdin, and holds no password', () => {
    const pg = clientArgv({ engine: 'postgres', svc: 'db', db: 'shop' });
    expect(pg).toEqual(['psql', '-X', '-q', '-U', 'goodboy_reader', '-d', 'shop', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate', '-A', '-t', '-F', '\t', '-f', '-']);
    expect(clientArgv({ engine: 'mysql', svc: 'db', db: 'shop' })).toEqual(['mysql', '-N', '-B', '--default-character-set=utf8mb4', '--connect-timeout=5', '-u', 'gb_reader', 'shop']);
    expect(clientArgv({ engine: 'mariadb', svc: 'db', db: 'shop' })[0]).toBe('mariadb');
    for (const engine of ['postgres', 'mysql', 'mariadb'] as const) {
      const argv = clientArgv({ engine, svc: 'db', db: 'shop' }).join(' ');
      expect(argv).not.toMatch(/password|-p\S|sandbox|root|-h /i);
    }
  });

  test('every call is `exec -T <service>` with the SQL on stdin and a cap on what comes back', async () => {
    const seen: { args: string[]; stdin?: string; max?: { stdout: number; stderr: number } }[] = [];
    const s = stub({ schema: SCHEMA, rowcounts: ROWCOUNTS });
    const comp = s.dc.comp;
    s.dc.comp = (args, ms, o) => {
      seen.push({ args, stdin: o?.stdin, max: o?.max });
      return comp(args, ms, o);
    };
    await ok(s, 'schema');
    for (const c of seen) {
      expect(c.args.slice(0, 3)).toEqual(['exec', '-T', 'db']);
      expect(c.stdin).toMatch(/^-- goodboy-data: /);
      expect(c.max).toEqual({ stdout: 4 * 1024 * 1024, stderr: 64 * 1024 });
    }
  });
});

// ---- the reader's key script, run under sh with /meta moved ----

describe('the meta-key script of the reader', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });
  const meta = (): string => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m6b-meta-')));
    dirs.push(d);
    return d;
  };
  const call = (dir: string, stdin: string): string | null => {
    const r = Bun.spawnSync(['sh', '-c', META_KEY_SCRIPT.replaceAll(META_DIR, dir), 'sh'], { stdin: new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe' });
    // the script's own `@@F <path>` frames name the moved path: move it back as the fake docker does
    return parseMetaKey(r.stdout.toString().replaceAll(dir, META_DIR));
  };
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);

  test('the first candidate becomes the key, mode 0600; later candidates change nothing', () => {
    const d = meta();
    expect(call(d, `${A}\n`)).toBe(A);
    expect(statSync(join(d, 'handle.key')).mode & 0o777).toBe(0o600);
    expect(call(d, `${B}\n`)).toBe(A);
    expect(readFileSync(join(d, 'handle.key'), 'utf8')).toBe(`${A}\n`);
  });

  test('a candidate that is not 64 lower-case hex digits is never written', () => {
    for (const bad of ['', '\n', 'xyz\n', `${'a'.repeat(63)}\n`, `${'a'.repeat(65)}\n`, `${'A'.repeat(64)}\n`, `${'a'.repeat(63)}g\n`]) {
      const d = meta();
      expect([bad, call(d, bad)]).toEqual([bad, null]);
      expect(existsSync(join(d, 'handle.key'))).toBe(false);
    }
  });

  test('a link, a directory or a file of another shape in the key\'s place is refused, and nothing is written through it', () => {
    const d = meta();
    writeFileSync(join(d, 'victim'), `${B}\n`);
    symlinkSync(join(d, 'victim'), join(d, 'handle.key'));
    expect(call(d, `${A}\n`)).toBeNull();
    expect(readFileSync(join(d, 'victim'), 'utf8')).toBe(`${B}\n`);
    const e = meta();
    mkdirSync(join(e, 'handle.key'));
    expect(call(e, `${A}\n`)).toBeNull();
    const g = meta();
    writeFileSync(join(g, 'handle.key'), `${A}\nmore\n`);
    expect(call(g, `${B}\n`)).toBeNull();
    const h = meta();
    writeFileSync(join(h, 'handle.key'), 'not hex');
    expect(call(h, `${B}\n`)).toBeNull();
  });

  test('a dangling link where the key goes is not followed to a file made there', () => {
    const d = meta();
    symlinkSync(join(d, 'elsewhere'), join(d, 'handle.key'));
    expect(call(d, `${A}\n`)).toBeNull();
    expect(existsSync(join(d, 'elsewhere'))).toBe(false);
  });

  test('parseMetaKey: a run that did not reach its end, or printed another file, has no key', () => {
    expect(parseMetaKey('')).toBeNull();
    expect(parseMetaKey(`@@F ${META_DIR}/handle.key\n${Buffer.from(`${A}\n`).toString('base64')}\n`)).toBeNull(); // no @@END
    expect(parseMetaKey(`@@F /meta/other\n${Buffer.from(`${A}\n`).toString('base64')}\n@@END\n`)).toBeNull();
    expect(parseMetaKey(`@@A ${META_DIR}/handle.key\n@@END\n`)).toBeNull();
    expect(parseMetaKey(`@@F ${META_DIR}/handle.key\n${Buffer.from(`${A}\n`).toString('base64')}\n@@END\n`)).toBe(A);
  });
});

// ---- through the CLI, against the fake docker ----

function answers(f: FakeProject, files: Record<string, string>, extra: Record<string, string> = {}): void {
  mkdirSync(join(f.state, 'db'), { recursive: true });
  for (const [name, text] of Object.entries({ ...files, ...extra })) writeFileSync(join(f.state, 'db', name), text);
}
const baseAnswers = { 'schema.out': SCHEMA, 'rowcounts.out': ROWCOUNTS, 'count.out': 'N\t77\n', 'pick.out': `M\t10\nP\t${CANARY_HEX}\nP\t3132\nP\t3334\n`, 'shape.out': 'C\tother\t40\nL\t1-8\t40\nD\t3\nT\t40\n', 'enum.out': 'E\t0\t3\n' };
const REAL = { dump: null, dumpFormat: null, realData: true } as const;
const keyFile = (f: FakeProject): string => join(f.state, 'vol', 'meta', 'handle.key');
const PICK_ARGS = ['sandbox-data', 'pick', 'users', '--where', '{"col":"age","op":">","value":1}'];

describe('through the CLI and the fake docker', () => {
  test('every op prints JSON of goodboy\'s own making and exits 0', () => {
    const f = fakeProject(REAL);
    answers(f, baseAnswers);
    const schema = f.cli(['sandbox-data', 'schema']);
    expect(schema.code).toBe(0);
    expect(JSON.parse(schema.stdout)).toMatchObject({ op: 'schema', ok: true });
    expect(schema.stderr).toBe('');
    expect(JSON.parse(f.cli(['sandbox-data', 'shape', 'users.name']).stdout)).toMatchObject({ op: 'shape', ok: true });
    expect(JSON.parse(f.cli(['sandbox-data', 'count', 'users', '--where', WHERE_ENUM]).stdout)).toMatchObject({ op: 'count', count: 77 });
    expect(JSON.parse(f.cli(PICK_ARGS).stdout)).toMatchObject({ op: 'pick', ok: true });
  });

  test('a plain project (no dump, no real data) goes the same way: one code path', () => {
    const f = fakeProject(null);
    answers(f, baseAnswers);
    expect(JSON.parse(f.cli(['sandbox-data', 'count', 'users']).stdout)).toMatchObject({ op: 'count', count: 77 });
    expect(JSON.parse(f.cli(PICK_ARGS).stdout)).toMatchObject({ op: 'pick', ok: true });
  });

  test('canaries in rows, in errors and in a bad exit never reach the output of the CLI', () => {
    const f = fakeProject(REAL);
    answers(f, baseAnswers, { 'schema.out': `${SCHEMA}C\tpublic\tusers\t${CANARY}\ttext\tYES\n`, 'schema.err': `ERROR: ${CANARY}\nDETAIL: Key (email)=(${CANARY}) already exists.\n` });
    for (const args of [['sandbox-data', 'schema'], ['sandbox-data', 'count', 'users'], PICK_ARGS, ['sandbox-data', 'shape', 'users.name']]) {
      const r = f.cli(args);
      expect([args[1], r.code]).toEqual([args[1], 1]);
      expect(r.stdout + r.stderr).not.toContain(CANARY);
      expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, diagnostic: { code: 'data-failed' } });
    }
    answers(f, baseAnswers, { 'schema.exit': '1' });
    const r = f.cli(['sandbox-data', 'schema']);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).not.toContain(CANARY);
  });

  test('a string value reaches the database only quoted, in the count script and after the enum check; an unknown column reaches it not at all', () => {
    const f = fakeProject(REAL);
    answers(f, baseAnswers);
    const sqlLog = (): string[] => (existsSync(join(f.state, 'db-sql.log')) ? readFileSync(join(f.state, 'db-sql.log'), 'utf8').split('=== ').filter(Boolean) : []);
    f.cli(['sandbox-data', 'count', 'users', '--where', JSON.stringify({ col: 'status', op: '=', value: CANARY })]);
    const first = sqlLog();
    // schema, enum, count: the value is in the count script, between quotes, and nowhere else
    expect(first).toHaveLength(3);
    expect(first.map((b) => /-- goodboy-data: (\w+)/.exec(b)![1])).toEqual(['schema', 'enum', 'count']);
    expect(first.filter((b) => b.includes(CANARY)).map((b) => /-- goodboy-data: (\w+)/.exec(b)![1])).toEqual(['count']);
    expect(first[2]).toContain(`WHERE ("status" = '${CANARY}')`);
    // a name that is a plain identifier the catalog does not list: the catalog is asked, the request stops at its own refusal
    f.cli(['sandbox-data', 'count', 'users', '--where', JSON.stringify({ col: 'ghost_col', op: 'is-null' })]);
    const second = sqlLog().slice(first.length);
    expect(second.map((b) => /-- goodboy-data: (\w+)/.exec(b)![1])).toEqual(['schema']);
    expect(second.join('')).not.toContain('ghost_col');
    // a name that is no identifier at all never leaves goodboy
    f.cli(['sandbox-data', 'count', 'users', '--where', JSON.stringify({ col: CANARY, op: 'is-null' })]);
    expect(sqlLog().slice(first.length + second.length)).toEqual([]);
    expect(sqlLog().join('')).not.toContain(`"${CANARY}"`);
    expect(sqlLog().join('')).not.toMatch(/\bDROP\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b/i);
  });

  test('the handle key is made once in the meta volume, mode 0600, and used for every handle', () => {
    const f = fakeProject(REAL);
    answers(f, baseAnswers);
    expect(existsSync(keyFile(f))).toBe(false);
    const a = JSON.parse(f.cli(PICK_ARGS).stdout);
    const key = readFileSync(keyFile(f), 'utf8').trim();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(keyFile(f)).mode & 0o777).toBe(0o600);
    expect(a.handles).toEqual([handleOf(key, 'postgres', 'shop', 'users', [CANARY_HEX]), handleOf(key, 'postgres', 'shop', 'users', ['3132']), handleOf(key, 'postgres', 'shop', 'users', ['3334'])]);
    // a second call keeps the key and gives the same handles for the same rows
    const b = JSON.parse(f.cli(PICK_ARGS).stdout);
    expect(readFileSync(keyFile(f), 'utf8').trim()).toBe(key);
    expect(b.handles).toEqual(a.handles);
  });

  test('handles are the same after the database is reset, and differ between sandboxes', async () => {
    const f = fakeProject(REAL);
    answers(f, baseAnswers);
    const before = JSON.parse(f.cli(PICK_ARGS).stdout).handles as string[];
    const r = await f.inproc('sandbox-run', ['--suite', 'unit']);
    expect(r.code).toBe(0);
    expect(f.calls().filter((l) => l.includes('reset.sh')).length).toBeGreaterThan(0);
    expect(JSON.parse(f.cli(PICK_ARGS).stdout).handles).toEqual(before);
    // another sandbox has its own key: the same rows give other handles
    const g = fakeProject(REAL);
    answers(g, baseAnswers);
    const other = JSON.parse(g.cli(PICK_ARGS).stdout).handles as string[];
    expect(readFileSync(keyFile(g), 'utf8')).not.toBe(readFileSync(keyFile(f), 'utf8'));
    for (const h of other) expect(before).not.toContain(h);
  });

  test('two first calls at once agree on one key', async () => {
    const f = fakeProject(REAL);
    answers(f, baseAnswers);
    const env = { ...process.env, GOODBOY_DOCKER_BIN: f.bin, FAKE_DOCKER_DIR: f.state, CLAUDE_PROJECT_DIR: f.root };
    const spawn = () => Bun.spawn(['bun', CLI, ...PICK_ARGS], { cwd: f.root, env, stdout: 'pipe', stderr: 'pipe' });
    const [a, b] = [spawn(), spawn()];
    const [ta, tb] = await Promise.all([new Response(a.stdout).text(), new Response(b.stdout).text()]);
    await Promise.all([a.exited, b.exited]);
    expect(JSON.parse(ta).handles).toEqual(JSON.parse(tb).handles);
  });

  test('the key is never on the host: not in the project, not in any output, not in the calls or the SQL', () => {
    const f = fakeProject(REAL);
    answers(f, baseAnswers);
    const outputs = [f.cli(PICK_ARGS), f.cli(['sandbox-data', 'schema']), f.cli(PICK_ARGS)];
    const key = readFileSync(keyFile(f), 'utf8').trim();
    for (const o of outputs) expect(o.stdout + o.stderr).not.toContain(key);
    const walk = (dir: string, hits: string[]): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p, hits);
        else if (e.isFile() && statSync(p).size < 5_000_000 && readFileSync(p, 'utf8').includes(key)) hits.push(p);
      }
    };
    const inProject: string[] = [];
    walk(f.root, inProject);
    expect(inProject).toEqual([]);
    // in the state dir of the fake docker only the volume holds it (and the pipe the reader's answer came through)
    const inState: string[] = [];
    walk(f.state, inState);
    expect(inState.map((p) => p.slice(f.state.length + 1)).filter((p) => p !== 'vol/meta/handle.key' && p !== 'reader.out' && p !== 'db-sql.in').sort()).toEqual([]);
    expect(readFileSync(join(f.state, 'calls.log'), 'utf8')).not.toContain(key);
    expect(readFileSync(join(f.state, 'db-sql.log'), 'utf8')).not.toContain(key);
    // and not as base64 either
    expect(readFileSync(join(f.state, 'calls.log'), 'utf8')).not.toContain(Buffer.from(key).toString('base64'));
  });

  test('a refused request makes no exec and no SQL call and reads no key (the preflight and the sweep still ask docker, as for any command)', () => {
    const f = fakeProject(REAL);
    answers(f, baseAnswers);
    const r = f.cli(['sandbox-data', 'count', 'users', '--where', '{"col":"x","op":"nope"}']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).diagnostic).toEqual({ code: 'data-refused', step: 'count', field: 'where.op', reason: 'bad-op' });
    const calls = f.calls();
    expect(calls.filter((l) => l.includes(' exec '))).toEqual([]);
    expect(calls.filter((l) => l.startsWith('reader:meta-key'))).toEqual([]);
    expect(calls.filter((l) => l.includes(' run ') && !l.startsWith('reader:'))).toEqual([]);
    expect(existsSync(join(f.state, 'db-sql.log'))).toBe(false);
  });

  test('an unknown op is an error with the usage', () => {
    const f = fakeProject(REAL);
    const r = f.cli(['sandbox-data', 'select']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('schema, shape <table>.<col>, count');
  });
});
