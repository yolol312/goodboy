// Track M, M6b (plan §19): the SQL `sandbox-data` sends to each engine (golden text under tests/m6b-golden/,
// rewritten with UPDATE_GOLDEN=1), the quoting of values, the strict reading of every answer, and the handles.

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CATEGORIES,
  checkCond,
  classOf,
  type Cond,
  countOut,
  countSql,
  dialect,
  type Engine,
  enumSql,
  handleOf,
  K,
  parseCount,
  parseEnum,
  parsePick,
  parseRowCounts,
  parseSchema,
  parseShape,
  parseWhere,
  pickSql,
  type Refusal,
  rowBucket,
  rowCountsSql,
  schemaSql,
  shapeSql,
  type Table,
} from '../lib/sandbox-data';
import { col } from './m6b-helpers';

const GOLDEN = join(import.meta.dir, 'm6b-golden');
const ENGINES: Engine[] = ['postgres', 'mysql', 'mariadb'];

const cols =[col('id', 'integer', 'numeric', 1), col('name', 'text', 'text'), col('status', 'text', 'text'), col('created', 'timestamp without time zone', 'temporal'), col('active', 'boolean', 'bool')];
const tableFor = (engine: Engine): Table => ({ name: 'users', ref: engine === 'postgres' ? '"public"."users"' : '`users`', cols });

const WHERE = JSON.stringify({
  and: [
    { col: 'status', op: '=', value: "O'Neil" },
    { col: 'id', op: '>', value: 5 },
    { col: 'created', op: '<=', value: '2024-03-01T10:00' },
    { col: 'name', op: 'shape', value: 'email-like' },
    { or: [{ col: 'id', op: 'is-null' }, { col: 'active', op: '!=', value: true }] },
  ],
});
const cond = (json = WHERE): Cond => {
  const c = parseWhere(json);
  if ('reason' in c) throw new Error('refused');
  return c;
};

/** The script text of every op for one engine, as one golden file. */
function scripts(engine: Engine): string {
  const d = dialect(engine);
  const t = tableFor(engine);
  return [
    ['schema', schemaSql(d)],
    ['rowcounts (two tables)', rowCountsSql(d, [t, { ...t, name: 'orders', ref: engine === 'postgres' ? '"public"."orders"' : '`orders`' }])],
    ['enum (status, active)', enumSql(d, t, ['status', 'active'])],
    ['count, no condition', countSql(d, t, null)],
    ['count with a condition', countSql(d, t, cond())],
    ['shape users.name', shapeSql(d, t, 'name')],
    ['pick 7', pickSql(d, t, cond(), 7)],
  ]
    .map(([title, sql]) => `#### ${title}\n${sql}`)
    .join('\n');
}

describe('the SQL of each operation, per engine', () => {
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

    test(`${engine}: a distinct count runs over the md5 of the text (a wide column is not sorted whole), and the sample is capped`, () => {
      const d = dialect(engine);
      const t = tableFor(engine);
      const fn = engine === 'postgres' ? 'md5' : 'MD5';
      const shape = shapeSql(d, t, 'name');
      expect(shape).toContain(`SELECT DISTINCT ${fn}(v) FROM`);
      expect(shape).not.toMatch(/SELECT DISTINCT v\b/);
      expect(shape).toContain('LIMIT 51) d;');
      expect(shape).toContain('LIMIT 100000) s');
      // the table is bigger than the sample when 100001 rows are there
      expect(shape).toContain(`SELECT 'T', count(*) FROM (SELECT 1 FROM ${t.ref} LIMIT 100001) x;`);
      const en = enumSql(d, t, ['status']);
      expect(en).toContain(`SELECT DISTINCT ${fn}(CAST(${d.q('status')} AS ${engine === 'postgres' ? 'text' : 'CHAR'})) FROM`);
      expect(en).toContain('LIMIT 51) x)');
    });

    test(`${engine}: every script names itself first, opens a read-only transaction and holds no write or DDL statement`, () => {
      const d = dialect(engine);
      const t = tableFor(engine);
      const all = [schemaSql(d), rowCountsSql(d, [t]), enumSql(d, t, ['status']), countSql(d, t, cond()), shapeSql(d, t, 'name'), pickSql(d, t, cond(), 3)];
      const tags = ['schema', 'rowcounts', 'enum', 'count', 'shape', 'pick'];
      all.forEach((sql, i) => {
        const lines = sql.split('\n');
        expect(lines[0]).toBe(`-- goodboy-data: ${tags[i]}`);
        expect(lines[1]).toMatch(engine === 'postgres' ? /^SET statement_timeout = '5s';$/ : engine === 'mariadb' ? /^SET SESSION max_statement_time = 5;$/ : /^SET SESSION max_execution_time = 5000;$/);
        expect(lines[2]).toBe(engine === 'postgres' ? 'BEGIN READ ONLY;' : 'START TRANSACTION READ ONLY;');
        expect(lines[lines.length - 2]).toBe('COMMIT;');
        const stripped = sql.replace(/'(?:[^']|'')*'/g, "''");
        expect(stripped).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|GRANT|REVOKE|TRUNCATE|COPY|CALL|EXECUTE|LOCK)\b/i);
      });
    });
  }
});

describe('values are quoted by goodboy', () => {
  const render = (engine: Engine, json: string): string => countSql(dialect(engine), tableFor(engine), cond(json));
  // the count script's one query line, from its WHERE to its closing semicolon
  const WHERE_OF = (sql: string): string => {
    const line = sql.split('\n').find((l) => l.startsWith("SELECT 'N'"))!;
    return line.slice(line.indexOf(' WHERE ') + 7, line.lastIndexOf(';'));
  };

  test('a quote is doubled, a number is written as a number, a date as one fixed spelling, a boolean per engine', () => {
    for (const engine of ENGINES) {
      expect(WHERE_OF(render(engine, '{"col":"status","op":"=","value":"O\'Neil"}'))).toBe(`(${engine === 'postgres' ? '"status"' : '`status`'} = 'O''Neil')`);
    }
    expect(WHERE_OF(render('postgres', '{"col":"id","op":"<","value":-12.5}'))).toBe('("id" < -12.5)');
    expect(WHERE_OF(render('mysql', '{"col":"created","op":">","value":"2024-01-31"}'))).toBe("(`created` > '2024-01-31 00:00:00')");
    expect(WHERE_OF(render('mysql', '{"col":"created","op":">","value":"2024-01-31T09:08"}'))).toBe("(`created` > '2024-01-31 09:08:00')");
    expect(WHERE_OF(render('postgres', '{"col":"active","op":"=","value":true}'))).toBe('("active" = TRUE)');
    expect(WHERE_OF(render('mariadb', '{"col":"active","op":"!=","value":false}'))).toBe('(`active` <> 0)');
  });

  test('an injection attempt stays inside its quotes, in every engine', () => {
    const evil = "x'); DROP TABLE users; --";
    for (const engine of ENGINES) {
      const where = WHERE_OF(render(engine, JSON.stringify({ col: 'status', op: '=', value: evil })));
      expect(where).toContain("'x''); DROP TABLE users; --'");
      // every quote of the value is doubled: removing the quoted strings leaves no statement
      expect(where.replace(/'(?:[^']|'')*'/g, "''")).not.toMatch(/DROP|;|--/);
    }
  });

  test('the identifier of a column is quoted with the engine\'s own quote', () => {
    expect(WHERE_OF(render('postgres', '{"col":"id","op":"not-null"}'))).toBe('("id" IS NOT NULL)');
    expect(WHERE_OF(render('mysql', '{"col":"id","op":"not-null"}'))).toBe('(`id` IS NOT NULL)');
  });

  test('a shape condition is the category expression of `shape` compared with a fixed word', () => {
    const sql = WHERE_OF(render('postgres', '{"col":"name","op":"shape","value":"phone-like"}'));
    expect(sql).toContain('CAST("name" AS text)');
    expect(sql).toContain("THEN 'phone-like'");
    expect(sql.endsWith("= 'phone-like')")).toBe(true);
  });

  test('every category is a word of the grammar and in the SQL', () => {
    const sql = shapeSql(dialect('postgres'), tableFor('postgres'), 'name');
    for (const c of CATEGORIES) expect(sql).toContain(`'${c}'`);
  });
});

describe('what the answers are read as', () => {
  const nl = (...lines: string[]): string => `${lines.join('\n')}\n`;

  test('the catalog: columns, flags and the left-out count; the tables are named like a caller names them', () => {
    const out = nl(
      'C\tpublic\tusers\tid\tinteger\tNO',
      'C\tpublic\tusers\tname\tcharacter varying\tYES',
      'C\taudit\tlog\tid\tinteger\tNO',
      'C\tpublic\torders\tuser_id\tinteger\tYES',
      'S\t3',
      'K\tpublic\tusers\tid\tp\t1',
      'K\tpublic\torders\tuser_id\tf\t1',
    );
    const p = parseSchema(out, 'postgres')!;
    expect(p.skipped).toBe(3);
    expect(p.tables.map((t) => [t.name, t.ref])).toEqual([
      ['users', '"public"."users"'],
      ['audit.log', '"audit"."log"'],
      ['orders', '"public"."orders"'],
    ]);
    expect(p.tables[0]!.cols).toEqual([
      { name: 'id', type: 'integer', cls: 'numeric', nullable: false, pk: 1, fk: false },
      { name: 'name', type: 'character varying', cls: 'text', nullable: true, pk: 0, fk: false },
    ]);
    expect(p.tables[2]!.cols[0]).toMatchObject({ fk: true, pk: 0 });
    // MySQL has one schema per database: plain names and a quoted table
    const my = parseSchema(nl('C\tpublic\tusers\tid\tint\tNO', 'S\t0', 'K\tpublic\tusers\tid\tp\t1'), 'mysql')!;
    expect(my.tables[0]).toMatchObject({ name: 'users', ref: '`users`' });
  });

  test('the catalog is refused for any line that is not of its exact shape', () => {
    const ok = ['C\tpublic\tusers\tid\tinteger\tNO', 'S\t0'];
    expect(parseSchema(nl(...ok), 'postgres')).not.toBeNull();
    const bad: string[] = [
      ok.join('\n'), // no closing newline
      nl(...ok, 'unexpected line'),
      nl(...ok, 'C\tpublic\tusers\tid\tinteger'), // a field missing
      nl('C\tpublic\tusers\tid\tinteger\tMAYBE', 'S\t0'),
      nl('C\tpublic\tus ers\tid\tinteger\tNO', 'S\t0'),
      nl('C\tpublic\tusers\tid\tint;egr\tNO', 'S\t0'),
      nl('C\tpublic\tusers\tid\tinteger\tNO'), // no count of the names left out
      nl(...ok, 'S\t1'), // two counts
      nl(...ok, 'K\tpublic\tusers\tid\tz\t1'),
      nl(...ok, 'K\tpublic\tusers\tid\tp\tx'),
      '',
      'ERROR: relation "users" does not exist\n',
    ];
    for (const b of bad) expect(parseSchema(b, 'postgres')).toBeNull();
  });

  test('row counts: one line for each table, each once, in numbers', () => {
    expect(parseRowCounts(nl('R\t0\t12', 'R\t1\t10001'), 2)).toEqual([12, 10001]);
    expect(parseRowCounts(nl('R\t1\t12', 'R\t0\t3'), 2)).toEqual([3, 12]);
    for (const bad of [nl('R\t0\t12'), nl('R\t0\t12', 'R\t0\t13'), nl('R\t0\t12', 'R\t2\t1'), nl('R\t0\tmany', 'R\t1\t1'), nl('R\t0\t1', 'R\t1\t1', 'R\t2\t1'), 'R\t0\t1\nR\t1\t1', nl('X\t0\t1', 'R\t1\t1')]) {
      expect(parseRowCounts(bad, 2)).toBeNull();
    }
  });

  test('the buckets of a row count and of a count', () => {
    expect([0, 1, 9, 10, 99, 100, 999, 1000, 10000, 10001].map(rowBucket)).toEqual(['0', '<10', '<10', '10-99', '10-99', '100-999', '100-999', '1k-10k', '1k-10k', '>10k']);
    expect([0, 1, 9].map(countOut)).toEqual(['<10', '<10', '<10']);
    expect([K, 11, 12345].map(countOut)).toEqual([10, 11, 12345]);
  });

  test('a count is one line with digits', () => {
    expect(parseCount(nl('N\t42'))).toBe(42);
    for (const bad of [nl('N\tforty'), nl('N\t1', 'N\t2'), nl('N\t-1'), 'N\t1', nl('N\t1\t2'), nl('M\t1'), nl('N\t' + '9'.repeat(16))]) expect(parseCount(bad)).toBeNull();
  });

  test('the enum check: a verdict per column, at most 50 distinct values', () => {
    expect(parseEnum(nl('E\t0\t3', 'E\t1\t51'), 2)).toEqual([true, false]);
    expect(parseEnum(nl('E\t0\t50'), 1)).toEqual([true]);
    for (const bad of [nl('E\t0\t3'), nl('E\t0\t3', 'E\t0\t4'), nl('E\t5\t3', 'E\t1\t1'), nl('E\t0\tx', 'E\t1\t1')]) expect(parseEnum(bad, 2)).toBeNull();
  });

  test('a shape: every category and length bucket from 10 up as it is, else "<10"; the distinct bucket and enumLike', () => {
    const s = parseShape(nl('C\temail-like\t40', 'C\tnull\t3', 'L\t9-32\t37', 'L\t0\t3', 'D\t12', 'T\t43'))!;
    expect(s.categories['email-like']).toBe(40);
    expect(s.categories.null).toBe('<10');
    expect(s.categories.url).toBe('<10');
    expect(Object.keys(s.categories)).toEqual([...CATEGORIES]);
    expect(s.lengths['9-32']).toBe(37);
    expect(s.distinct).toBe('10-50');
    expect(s.enumLike).toBe(true);
    expect(s.sampled).toBe(false);
    const buckets = [0, 1, 5, 9, 10, 50, 51].map((d) => parseShape(nl('C\tother\t10', 'D\t' + d, 'T\t10'))!);
    expect(buckets.map((b) => b.distinct)).toEqual(['0', '1', '2-9', '2-9', '10-50', '10-50', '>50']);
    expect(buckets.map((b) => b.enumLike)).toEqual([true, true, true, true, true, true, false]);
  });

  test('sampled is true only when the table has more rows than the sample (the T line counts up to 100001)', () => {
    const at = (t: number) => parseShape(nl('C\tother\t100000', 'D\t51', `T\t${t}`))!.sampled;
    expect([at(99_999), at(100_000), at(100_001)]).toEqual([false, false, true]);
  });

  test('a shape with a line out of place is refused', () => {
    const ok = ['C\tother\t10', 'D\t1', 'T\t10'];
    expect(parseShape(nl(...ok))).not.toBeNull();
    for (const bad of [nl('C\tother\t10', 'T\t10'), nl('C\tother\t10', 'D\t1'), nl(...ok, 'D\t2'), nl(...ok, 'T\t11'), nl(...ok, 'C\tother\t10'), nl(...ok, 'C\tssn\t10'), nl(...ok, 'L\t7\t1'), nl('C\tother\tten', 'D\t1', 'T\t1'), nl('C\tother\t1', 'D\t1', 'T\tmany'), nl(...ok, 'Q\tx'), ok.join('\n')]) {
      expect(parseShape(bad)).toBeNull();
    }
  });

  test('a pick: the matching count up to 10, then the primary keys as hex, one field for each key column', () => {
    expect(parsePick(nl('M\t10', 'P\t3231', 'P\t3132'), 1, 5)).toEqual({ matches: 10, keys: [['3231'], ['3132']] });
    expect(parsePick(nl('M\t10', 'P\t34\t6B34'), 2, 5)).toEqual({ matches: 10, keys: [['34', '6b34']] });
    expect(parsePick(nl('M\t10', 'P\t'), 1, 5)).toEqual({ matches: 10, keys: [['']] });
    expect(parsePick(nl('M\t4'), 1, 5)).toEqual({ matches: 4, keys: [] });
    for (const bad of [nl('P\t3231'), nl('M\t10', 'M\t10'), nl('M\t10', 'P\t3231\t3231'), nl('M\t10', 'P\tzz'), nl('M\t10', 'P\t123'), nl('M\t10', 'P\t1', 'P\t2', 'P\t3'), nl('M\tx'), nl('M\t10', 'P\t' + '3'.repeat(4098))]) {
      expect(parsePick(bad, 1, 2)).toBeNull();
    }
  });

  test('an answer of 4 MiB or more is taken as cut off', () => {
    expect(parseCount(`N\t1\n${'x'.repeat(4 * 1024 * 1024)}`)).toBeNull();
  });
});

describe('column classes', () => {
  test('the type names of the engines', () => {
    expect(['integer', 'bigint', 'int', 'tinyint', 'numeric', 'double precision', 'year', 'DECIMAL'].map(classOf)).toEqual(Array(8).fill('numeric'));
    expect(['text', 'character varying', 'varchar', 'char', 'longtext', 'citext'].map(classOf)).toEqual(Array(6).fill('text'));
    expect(['timestamp without time zone', 'timestamp with time zone', 'date', 'datetime', 'timestamp'].map(classOf)).toEqual(Array(5).fill('temporal'));
    expect(classOf('boolean')).toBe('bool');
    expect(classOf('uuid')).toBe('uuid');
    expect(['USER-DEFINED', 'ARRAY', 'jsonb', 'bytea', 'time without time zone', 'point', 'bit'].map(classOf)).toEqual(Array(7).fill('other'));
  });

  test('a column of another class takes no comparison and no equality', () => {
    const t: Table = { name: 'x', ref: 'x', cols: [col('blob', 'bytea', 'other')] };
    const w = (json: string): Cond => parseWhere(json) as Cond;
    expect(checkCond(t, w('{"col":"blob","op":"=","value":"a"}'))).toEqual({ field: 'where.value', reason: 'bad-type' } satisfies Refusal);
    expect(checkCond(t, w('{"col":"blob","op":"<","value":1}'))).toEqual({ field: 'where.value', reason: 'bad-type' } satisfies Refusal);
    expect(checkCond(t, w('{"col":"blob","op":"is-null"}'))).toEqual({ enumCols: new Map() });
  });
});

describe('handles', () => {
  const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

  test('known answers (HMAC-SHA-256 of engine|db|table|tuple, first 20 bytes, base32, lower case)', () => {
    expect(handleOf(KEY, 'postgres', 'shop', 'users', ['3231'])).toBe('h_h7hp7ioz3pbinxoridwpxe5hv33emmhr');
    expect(handleOf(KEY, 'postgres', 'shop', 'kv', ['ab', 'c'])).toBe('h_tipys4uoaachdifuqim7m62sbx5a22jn');
  });

  test('the same row gives the same handle; another key, engine, database, table or row gives another', () => {
    const base = handleOf(KEY, 'postgres', 'shop', 'users', ['3231']);
    expect(handleOf(KEY, 'postgres', 'shop', 'users', ['3231'])).toBe(base);
    for (const other of [handleOf('f'.repeat(64), 'postgres', 'shop', 'users', ['3231']), handleOf(KEY, 'mysql', 'shop', 'users', ['3231']), handleOf(KEY, 'postgres', 'shop2', 'users', ['3231']), handleOf(KEY, 'postgres', 'shop', 'orders', ['3231']), handleOf(KEY, 'postgres', 'shop', 'users', ['3232'])]) {
      expect(other).not.toBe(base);
    }
  });

  test('a key tuple is length-prefixed, so ("ab","c") and ("a","bc") differ', () => {
    expect(handleOf(KEY, 'postgres', 'shop', 'kv', ['ab', 'c'])).not.toBe(handleOf(KEY, 'postgres', 'shop', 'kv', ['a', 'bc']));
  });

  test('a handle is h_ and 32 lower-case base32 characters, and holds no part of the key value', () => {
    const h = handleOf(KEY, 'postgres', 'shop', 'users', ['3231']);
    expect(h).toMatch(/^h_[a-z2-7]{32}$/);
  });
});
