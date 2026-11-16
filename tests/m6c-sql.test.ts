// Track M, M6c (plan §19): the SQL of the resolve step per engine (golden text under tests/m6c-golden/, rewritten with
// UPDATE_GOLDEN=1), the strict reading of the phase-1 answers, and the write script that runs inside the database container.

import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clientArgv, dialect, type Engine } from '../lib/sandbox-data';
import { collisionSql, MAX_VALUES_BYTES, type Manifest, matchesSql, parseCollisions, parseDigits, parseManifest, parseMatches, precisionSql, resolveSql, writeScript } from '../lib/sandbox-resolve';
import { col } from './m6b-helpers';

const GOLDEN = join(import.meta.dir, 'm6c-golden');
const ENGINES: Engine[] = ['postgres', 'mysql', 'mariadb'];

const made: string[] = [];
const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m6c-sql-')));
  made.push(d);
  return d;
};
afterAll(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

const refFor = (engine: Engine, t: string): string => (engine === 'postgres' ? `"public"."${t}"` : `\`${t}\``);
const users = (engine: Engine) => ({
  name: 'users',
  ref: refFor(engine, 'users'),
  cols: [col('id', 'integer', 'numeric', 1), col('name', 'text', 'text'), col('email', 'text', 'text'), col('status', 'text', 'text'), col('nick', 'text', 'text'), col('phone', 'text', 'text'), col('serial', 'bigint', 'numeric'), col('price', 'numeric', 'numeric')],
});
const pairs = (engine: Engine) => ({ name: 'pairs', ref: refFor(engine, 'pairs'), cols: [col('a', 'integer', 'numeric', 1), col('b', 'integer', 'numeric', 2), col('v', 'text', 'text')] });
/** A table of another schema (Postgres), whose column the precision statement looks up by schema and name. */
const audit = (engine: Engine) => ({ name: 'audit.log', ref: engine === 'postgres' ? '"audit"."log"' : '`log`', cols: [col('id', 'integer', 'numeric', 1), col('amount', 'numeric', 'numeric')] });

const MANIFEST = {
  version: 1,
  picks: {
    activeUser: { table: 'users', where: { col: 'status', op: '=', value: "O'Neil" }, n: 3, columns: ['name', 'nick', 'email'] },
    pair: { table: 'pairs', where: { col: 'a', op: '>', value: 0 }, n: 2, columns: ['v'] },
  },
  counts: { activeUsers: { table: 'users', where: { col: 'status', op: '=', value: 'active' } }, everyone: { table: 'users' } },
  generate: {
    newUserEmail: { table: 'users', column: 'email', kind: 'email' },
    newName: { table: 'users', column: 'name', kind: 'text' },
    newPhone: { table: 'users', column: 'phone', kind: 'phone' },
    newSerial: { table: 'users', column: 'serial', kind: 'number' },
    newPrice: { table: 'users', column: 'price', kind: 'number' },
  },
};

function bound(engine: Engine) {
  const m = parseManifest(JSON.stringify(MANIFEST)) as Manifest;
  const t = (n: string) => (n === 'users' ? users(engine) : pairs(engine));
  const gens = m.generate.map((def) => ({ t: t(def.table), def }));
  return {
    d: dialect(engine),
    picks: m.picks.map((def) => ({ t: t(def.table), def })),
    counts: m.counts.map((def) => ({ t: t(def.table), def })),
    gens,
    // the decimal columns a number generator writes: one of the public schema, one of another
    decimals: [gens.find((g) => g.def.name === 'newPrice')!, { t: audit(engine), def: { name: 'amount', table: 'audit.log', column: 'amount', kind: 'number' as const } }],
  };
}

function scripts(engine: Engine): string {
  const b = bound(engine);
  return [
    ['matches (two picks)', matchesSql(b.d, b.picks)],
    ['matches (a pick only)', matchesSql(b.d, b.picks.slice(0, 1))],
    ['collision (five generators)', collisionSql(b.d, b.gens)],
    ['precision (two decimal columns)', precisionSql(b.d, b.decimals)],
    ['resolve', resolveSql(b.d, b.picks, b.counts, b.gens, 'abcd1234')],
    ['resolve (a count only)', resolveSql(b.d, [], b.counts.slice(1), [], 'abcd1234')],
    ['write script', writeScript({ engine, svc: 'db', db: 'shop' }).replace(/\t/g, '<TAB>')],
  ]
    .map(([title, sql]) => `#### ${title}\n${sql}`)
    .join('\n');
}

/** The statements of a script's one query line, without its closing `;`. */
const unions = (sql: string): string[] => sql.split('\n').find((l) => l.startsWith('SELECT'))!.replace(/;$/, '').split(' UNION ALL ');

describe('the SQL of the resolve step, per engine', () => {
  for (const engine of ENGINES) {
    test(`${engine}: golden text`, () => {
      const file = join(GOLDEN, `${engine}.sql`);
      const text = scripts(engine);
      // only UPDATE_GOLDEN=1 writes: a golden file that is missing fails the test
      if (process.env.UPDATE_GOLDEN === '1') {
        mkdirSync(GOLDEN, { recursive: true });
        writeFileSync(file, text);
      }
      expect(existsSync(file)).toBe(true);
      expect(text).toBe(readFileSync(file, 'utf8'));
    });

    test(`${engine}: every value of a pick is the hex of its text in the case the helpers read (lowercase)`, () => {
      const b = bound(engine);
      const sql = resolveSql(b.d, b.picks, [], [], 'abcd1234');
      const cells = (sql.match(/ELSE (.*?) END/g) ?? []).filter((c) => /hex|HEX/.test(c));
      // 3 + 1 columns over the two picks
      expect(cells).toHaveLength(4);
      for (const c of cells) {
        // MySQL and MariaDB `HEX()` print uppercase digits: lowered in the SQL; Postgres `encode(..., 'hex')` already is lowercase
        if (engine === 'postgres') expect(c).toMatch(/^ELSE encode\(convert_to\(CAST\(s\.c\d AS text\), 'UTF8'\), 'hex'\) END$/);
        else expect(c).toMatch(/^ELSE LOWER\(HEX\(CAST\(s\.c\d AS CHAR\)\)\) END$/);
      }
      // the shared dialect, which M6b's handles and golden SQL use, is untouched
      expect(b.d.hex('x')).toBe(engine === 'postgres' ? "encode(convert_to(CAST(x AS text), 'UTF8'), 'hex')" : 'HEX(CAST(x AS CHAR))');
    });

    test(`${engine}: each script names itself first, opens a read-only transaction and holds no write or DDL statement`, () => {
      const b = bound(engine);
      const all: [string, string][] = [
        ['matches', matchesSql(b.d, b.picks)],
        ['collision', collisionSql(b.d, b.gens)],
        ['precision', precisionSql(b.d, b.decimals)],
        ['resolve', resolveSql(b.d, b.picks, b.counts, b.gens, 'abcd1234')],
      ];
      for (const [tag, sql] of all) {
        const lines = sql.split('\n');
        expect(lines[0]).toBe(`-- goodboy-data: ${tag}`);
        expect(lines[2]).toBe(engine === 'postgres' ? 'BEGIN READ ONLY;' : 'START TRANSACTION READ ONLY;');
        expect(lines[lines.length - 2]).toBe('COMMIT;');
        const stripped = sql.replace(/'(?:[^']|'')*'/g, "''");
        expect(stripped).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|GRANT|REVOKE|TRUNCATE|COPY|CALL|EXECUTE|LOCK)\b/i);
      }
    });

    test(`${engine}: the rows of a pick are chosen once, in one derived table, and every column is read from that choice`, () => {
      const b = bound(engine);
      const sql = resolveSql(b.d, b.picks, [], [], 'abcd1234');
      const lines = sql.split('\n').filter((l) => l.startsWith("SELECT 'V', 'activeUser'"));
      expect(lines).toHaveLength(1);
      const q = lines[0]!;
      // the random order appears once per pick (not once per column), and the columns are unpivoted by a join with a list of them
      expect(q.split(b.d.rand)).toHaveLength(2);
      expect(q).toContain('CROSS JOIN (SELECT 1 AS k UNION ALL SELECT 2 UNION ALL SELECT 3) u');
      expect(q).toContain(`ORDER BY ${b.d.rand} LIMIT 3) s`);
      // values leave as hex, NULL as ~, the row by the md5 of its primary key
      expect(q).toContain("THEN '~' WHEN");
      expect(q).toContain(engine === 'postgres' ? "encode(convert_to(CAST(s.c1 AS text), 'UTF8'), 'hex')" : 'HEX(CAST(s.c1 AS CHAR))');
      expect(q).toContain(engine === 'postgres' ? 'md5(CAST(s.p1 AS text))' : "MD5(CONCAT_WS('|', s.p1))");
      // a composite key is one md5 over all its columns
      const pair = sql.split('\n').find((l) => l.startsWith("SELECT 'V', 'pair'"))!;
      expect(pair).toContain(engine === 'postgres' ? "md5(CAST(s.p1 AS text) || '|' || CAST(s.p2 AS text))" : "MD5(CONCAT_WS('|', s.p1, s.p2))");
    });

    test(`${engine}: a cell over 2000 characters is a fixed mark, decided before its hex is made, and no value is cut`, () => {
      const b = bound(engine);
      const q = resolveSql(b.d, b.picks, [], [], 'abcd1234').split('\n').find((l) => l.startsWith("SELECT 'V', 'activeUser'"))!;
      const len = (n: number): string => (engine === 'postgres' ? `char_length(CAST(s.c${n} AS text))` : `CHAR_LENGTH(CAST(s.c${n} AS CHAR))`);
      const hex = (n: number): string => (engine === 'postgres' ? `encode(convert_to(CAST(s.c${n} AS text), 'UTF8'), 'hex')` : `LOWER(HEX(CAST(s.c${n} AS CHAR)))`);
      for (const n of [1, 2, 3]) expect(q).toContain(`(CASE WHEN s.c${n} IS NULL THEN '~' WHEN ${len(n)} > 2000 THEN '!' ELSE ${hex(n)} END)`);
      // the whole value goes through the hex: there is no SUBSTR, LEFT or the like on a value
      expect(q).not.toMatch(/SUBSTR|LEFT\(|\bTRUNC|\bLPAD/i);
    });

    test(`${engine}: a quote in a condition is doubled; matches asks about picks only`, () => {
      const b = bound(engine);
      const m = matchesSql(b.d, b.picks);
      expect(m).toContain("= 'O''Neil'");
      expect(m).not.toContain("'X'");
      expect(m).not.toContain('gbx-');
      expect(m.match(/LIMIT 10\) x\)/g)).toHaveLength(2);
    });

    test(`${engine}: the collision check is a statement of its own that reads at most the first 100000 rows of a table`, () => {
      const b = bound(engine);
      const sql = collisionSql(b.d, b.gens);
      const rows = unions(sql);
      expect(rows).toHaveLength(5);
      const users = refFor(engine, 'users');
      const one = (j: number, c: string, pred: string): string => `SELECT 'X', ${j}, (SELECT count(*) FROM (SELECT 1 FROM (SELECT ${b.d.q(c)} AS v FROM ${users} LIMIT 100000) s WHERE ${pred} LIMIT 1) x)`;
      const txt = b.d.text('v');
      expect(rows).toEqual([
        one(0, 'email', `${txt} LIKE 'gbx-%'`),
        one(1, 'name', `${txt} LIKE 'gbx-%'`),
        one(2, 'phone', `${txt} LIKE '010-0000-%'`),
        one(3, 'serial', 'v >= 9000000000000'),
        one(4, 'price', 'v >= 9000000000000'),
      ]);
      // no read of a whole table: every scan sits under the row limit
      expect(sql.match(/LIMIT 100000/g)).toHaveLength(5);
    });

    test(`${engine}: the width of a decimal column is asked of the catalog by schema, table and column`, () => {
      const b = bound(engine);
      const rows = unions(precisionSql(b.d, b.decimals));
      const schema = (s: string): string => (engine === 'postgres' ? `'${s}'` : 'DATABASE()');
      const one = (j: number, s: string, table: string, column: string): string =>
        `SELECT 'D', ${j}, (SELECT COALESCE(MAX(numeric_precision - COALESCE(numeric_scale, 0)), 99) FROM information_schema.columns WHERE table_schema = ${schema(s)} AND table_name = '${table}' AND column_name = '${column}')`;
      expect(rows).toEqual([one(0, 'public', 'users', 'price'), one(1, 'audit', 'log', 'amount')]);
    });

    test(`${engine}: the run token and the names reach the script as literals, and nothing else of the manifest does`, () => {
      const b = bound(engine);
      const lines = resolveSql(b.d, [], [], b.gens, 'abcd1234').split('\n').filter((l) => l.startsWith("SELECT 'G'"));
      expect(lines).toEqual([
        "SELECT 'G', 'newUserEmail', 'email', 'abcd1234';",
        "SELECT 'G', 'newName', 'text', 'abcd1234';",
        "SELECT 'G', 'newPhone', 'phone', 'abcd1234';",
        "SELECT 'G', 'newSerial', 'number', 'abcd1234';",
        "SELECT 'G', 'newPrice', 'number', 'abcd1234';",
      ]);
    });
  }

  test('MySQL and MariaDB differ only in their time limit', () => {
    expect(scripts('mysql').replace(/max_execution_time = 5000/g, 'X').replace(/mysql/g, 'DB')).toBe(scripts('mariadb').replace(/max_statement_time = 5/g, 'X').replace(/mariadb/g, 'DB'));
  });
});

describe('the answers of phase 1 are read strictly', () => {
  test('counts by index, every one once', () => {
    expect(parseMatches('M\t0\t10\nM\t1\t4\n', 2)).toEqual([10, 4]);
    expect(parseMatches('M\t1\t4\nM\t0\t10\n', 2)).toEqual([10, 4]);
    expect(parseMatches('', 0)).toEqual([]);
    expect(parseCollisions('X\t1\t1\nX\t0\t0\n', 2)).toEqual([0, 1]);
    expect(parseDigits('D\t0\t99\nD\t1\t10\n', 2)).toEqual([99, 10]);
  });

  test('anything else is null: a missing, repeated, out of range, malformed or extra line, another tag, no end of line, too much text', () => {
    const bad = [
      'M\t0\t10\n', // pick 1 missing
      'M\t0\t10\nM\t1\t4\nM\t1\t4\n', // repeated
      'M\t0\t10\nM\t2\t4\n', // out of range
      'M\t0\tten\nM\t1\t4\n',
      'M\t0\t10\nM\t1\t4\nX\t0\t0\n', // another tag
      'X\t0\t10\nX\t1\t4\n', // the other statement's tag
      'M\t0\t10\nM\t1\t4\tx\n', // a field too many
      'M\t0\t10\nM\t1\t4', // no end of line
      `ERROR: ${'x'.repeat(10)}\n`,
      `M\t0\t10\nM\t1\t${'9'.repeat(7)}\n`,
      `${'M\t0\t10\n'.repeat(1)}${'x'.repeat(4 * 1024 * 1024)}`,
    ];
    for (const b of bad) expect(parseMatches(b, 2)).toBeNull();
    expect(parseCollisions('M\t0\t1\n', 1)).toBeNull();
    expect(parseCollisions('X\t0\t1\nX\t0\t1\n', 1)).toBeNull();
    // the digits answer has at most 3 digits
    expect(parseDigits('D\t0\t1000\n', 1)).toBeNull();
    expect(parseDigits('X\t0\t1\n', 1)).toBeNull();
  });
});

describe('the write script run inside the database container', () => {
  // the script names /goodboy-data: a test runs it with that path moved into a temp dir and a stub for the database client
  function run(engine: Engine, client: string, stdin: string, seed?: string): { code: number; stdout: string; stderr: string; files: string[]; values: string | null; args: string } {
    const root = tmp();
    const data = join(root, 'data');
    const bin = join(root, 'bin');
    mkdirSync(data);
    mkdirSync(bin);
    if (seed !== undefined) writeFileSync(join(data, 'values.tsv'), seed);
    const name = engine === 'postgres' ? 'psql' : engine;
    writeFileSync(join(bin, name), client.replace('@ARGS@', join(root, 'args.txt')));
    chmodSync(join(bin, name), 0o755);
    const script = writeScript({ engine, svc: 'db', db: 'shop' }).replaceAll('/goodboy-data', data);
    const r = Bun.spawnSync(['sh', '-c', script], { env: { PATH: `${bin}:/usr/bin:/bin` }, stdin: Buffer.from(stdin), stdout: 'pipe', stderr: 'pipe' });
    const valuesFile = join(data, 'values.tsv');
    return {
      code: r.exitCode ?? -1,
      stdout: r.stdout.toString(),
      stderr: r.stderr.toString(),
      files: readdirSync(data).sort(),
      values: existsSync(valuesFile) ? readFileSync(valuesFile, 'utf8') : null,
      args: existsSync(join(root, 'args.txt')) ? readFileSync(join(root, 'args.txt'), 'utf8') : '',
    };
  }

  const ok = '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done > @ARGS@\ncat\n';

  for (const engine of ENGINES) {
    test(`${engine}: the client's answer becomes values.tsv and the one thing printed is its line and byte count`, () => {
      const answer = 'V\ta\tb\tc\td\nN\tx\t3\nG\tg\ttext\tabcd1234\n';
      const r = run(engine, ok, answer, 'old\n');
      expect(r.code).toBe(0);
      expect(r.stdout.trim().split(/\s+/)).toEqual(['3', String(Buffer.byteLength(answer))]);
      expect(r.values).toBe(answer);
      // no temp file stays behind
      expect(r.files).toEqual(['values.tsv']);
      // the client got the argv of sandbox-data's reader role, each word quoted as one (the tab of -F survives)
      expect(r.args.split('\n').slice(0, -1)).toEqual(clientArgv({ engine, svc: 'db', db: 'shop' }).slice(1));
    });

    test(`${engine}: a client that fails leaves no values.tsv (an older one is removed first) and no temp file, and prints nothing`, () => {
      const failing = '#!/bin/sh\ncat > /dev/null\necho "ERROR: relation Kim-Minsoo-0101234567" >&2\nexit 3\n';
      const r = run(engine, failing, 'SELECT 1;\n', 'older values\n');
      expect(r.code).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toBe('');
      expect(r.files).toEqual([]);
    });
  }

  test("the client's own stderr goes nowhere", () => {
    const out = run('postgres', '#!/bin/sh\ncat\necho "stderr text Kim-Minsoo-0101234567" >&2\n', 'V\n');
    expect(out.code).toBe(0);
    expect(out.stdout.trim().split(/\s+/)).toEqual(['1', '2']);
    expect(out.stderr).toBe('');
  });

  describe("a statement that ran into its time limit is told by the engine's error code, and the text never comes out", () => {
    const failWith = (text: string, code = 3): string => `#!/bin/sh\ncat > /dev/null\necho "${text}" >&2\nexit ${code}\n`;
    const cases: [Engine, string][] = [
      ['postgres', 'psql:<stdin>:4: ERROR:  57014'],
      ['mysql', 'ERROR 3024 (HY000) at line 1: Query execution was interrupted, maximum statement execution time exceeded'],
      ['mariadb', 'ERROR 1969 (70100) at line 1: Query execution was interrupted (max_statement_time exceeded)'],
    ];
    for (const [engine, text] of cases) {
      test(`${engine}: exit 124, nothing printed, nothing left in the volume`, () => {
        const r = run(engine, failWith(text), 'SELECT 1;\n', 'older\n');
        expect(r.code).toBe(124);
        expect(r.stdout).toBe('');
        expect(r.stderr).toBe('');
        expect(r.files).toEqual([]);
      });
    }

    test('another error that merely holds such a number is a plain failure', () => {
      for (const text of ['ERROR:  22P02 near 57013', 'ERROR 1064 (42000) at line 1: near ERROR3024', 'ERROR 1292 (22007): Truncated incorrect value: 3024']) {
        expect(run('mysql', failWith(text), 'x\n').code).toBe(1);
      }
    });
  });

  describe('the whole file is bounded in bytes, inside the container', () => {
    const big = (n: number): string => `#!/bin/sh\ncat > /dev/null\nhead -c ${n} /dev/zero | tr '\\0' 'x'\n`;

    test('4 MiB exactly is kept, one byte more is removed with its own exit code and nothing is printed', () => {
      expect(MAX_VALUES_BYTES).toBe(4 * 1024 * 1024);
      const at = run('postgres', big(MAX_VALUES_BYTES), 'x\n');
      expect(at.code).toBe(0);
      expect(at.stdout.trim().split(/\s+/)).toEqual(['0', String(MAX_VALUES_BYTES)]);
      expect(at.files).toEqual(['values.tsv']);
      const over = run('postgres', big(MAX_VALUES_BYTES + 1), 'x\n', 'older\n');
      expect(over.code).toBe(125);
      expect(over.stdout).toBe('');
      expect(over.files).toEqual([]);
    });
  });
});
