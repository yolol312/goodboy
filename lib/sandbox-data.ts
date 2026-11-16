// Restricted data access to the restored database of a sandbox (track M, M6b; plan §19):
// `cli.ts sandbox-data <op>`. A model that tests against real data must not read rows of it, so it gets
// no SQL, no database client and no shell into the container, only four fixed operations that answer with
// structure, categories, buckets, counts above a group size and opaque handles:
//
//   schema                      tables, columns, types, PK/FK/nullable flags, row-count buckets
//   shape <table>.<col>         counts per fixed category and length bucket, a distinct-count bucket, `enumLike`
//   count <table> [--where J]   the exact count when at least K (10), else "<10"
//   pick <table> --where J [--n N]   handles (HMAC of the primary key), only when the condition matches K rows or more
//
// The condition J is JSON from a fixed grammar (`and`/`or`, and `{col, op, value}` with op `is-null`,
// `not-null`, `shape`, `<`, `>`, `<=`, `>=`, and `=`/`!=` on an enum-like column only). Everything is checked
// against the database's own catalog before a query is made; the SQL is built here from names that passed that
// check and from values that are numbers, dates or short strings goodboy quotes itself. The answer is read
// back strictly (every line must have its exact shape, with a closing mark), and a failure of any kind is the
// fixed diagnostic `data-failed` with the op's name: the database's own text is never read into output.
//
// The pure parts (grammar, SQL text, parsing, handles) are exported for tests; `sandboxData` runs an op
// through a compose call (`exec` into the database service as the read-only role of lib/sandbox-parts.ts
// `dataRoleScript`, SQL on stdin). The handle key lives in the sandbox's `meta` volume (lib/sandbox-volumes.ts)
// and is held in memory for the length of one call: it is never written to the host and never printed.

import { createHmac, randomBytes } from 'node:crypto';
import type { Bounded } from './bounded';
import type { Diag } from './sandbox-boundary';
import { MY_READER, PG_READER } from './sandbox-parts';
import type { DockOpts } from './sandbox-store';

export type Engine = 'postgres' | 'mysql' | 'mariadb';

/** The smallest group a count or a pick answers about: a smaller one is "<10" or refused. */
export const K = 10;
const MAX_WHERE_BYTES = 4096;
const MAX_DEPTH = 4;
const MAX_NODES = 20;
const MAX_CHILDREN = 10;
const MAX_STRING = 64;
const MAX_PICK = 20;
const DEFAULT_PICK = 5;
const MAX_TABLES = 500;
const TABLE_CHUNK = 50;
const SCHEMA_ROWS = 20_000;
const ENUM_MAX = 50;
/** Rows `shape` and the enum check look at, per column. */
const SAMPLE_ROWS = 100_000;
const EXEC_MS = 60_000;
const MAX_STDOUT = 4 * 1024 * 1024;
const MAX_HEX = 4096;

const ID = '[A-Za-z_][A-Za-z0-9_$]{0,62}';
const IDENT_SRC = `^${ID}$`;
const IDENT = new RegExp(IDENT_SRC);

// ---- refusals: a field path and a fixed reason, never the input ----

const REASONS = [
  'unknown-op', // the first word is not schema, shape, count or pick
  'unexpected', // an argument the op does not take
  'unknown-option',
  'missing', // an argument the op needs
  'bad-name', // not an identifier
  'too-large',
  'bad-json',
  'bad-shape', // not the condition grammar
  'too-deep',
  'too-many-nodes',
  'bad-op', // an operator the grammar does not have
  'bad-value', // a value of the wrong kind, too long, or with characters goodboy does not quote
  'bad-number', // --n is not 1..20
  'unknown-table', // not a table of the schema
  'unknown-column',
  'bad-type', // the operator or value does not fit the column's type
  'not-enum-like', // `=` or `!=` on a column with more than 50 distinct values
  'no-primary-key',
  'too-few-rows', // a pick whose condition matches fewer than 10 rows
  'no-sql-store', // the project has no Postgres, MySQL or MariaDB store
] as const;
type Reason = (typeof REASONS)[number];

export interface Refusal {
  field: string;
  reason: Reason;
}
const refuse = (field: string, reason: Reason): Refusal => ({ field, reason });
const isRefusal = (v: unknown): v is Refusal => typeof v === 'object' && v !== null && 'reason' in v && 'field' in v;

// ---- the grammar ----

export const CATEGORIES = ['null', 'empty', 'integer', 'decimal', 'datetime', 'uuid', 'email-like', 'phone-like', 'url', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];
const CMP = ['<', '>', '<=', '>='] as const;
const OPS = ['is-null', 'not-null', 'shape', ...CMP, '=', '!='] as const;
type CondOp = (typeof OPS)[number];

type Scalar = string | number | boolean;
export type Cond = { kind: 'and' | 'or'; path: string; items: Cond[] } | { kind: 'leaf'; path: string; col: string; op: CondOp; value?: Scalar };

type Op =
  | { op: 'schema' }
  | { op: 'shape'; table: string; col: string }
  | { op: 'count'; table: string; where: Cond | null }
  | { op: 'pick'; table: string; where: Cond; n: number };

const DATE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?:[ T]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?)?$/;
/** A date or date-time that exists on the calendar (`2024-02-30` matches the shape and the database refuses it). */
const isDate = (s: string): boolean => {
  const m = DATE.exec(s);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(Date.UTC(y, mo - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === mo - 1 && at.getUTCDate() === d;
};
/** A number the grammar takes: finite, and no larger than 1e15 (it is written into SQL as it prints). */
const plainNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e15;
/** `YYYY-MM-DD HH:MM:SS`: the one spelling that goes into SQL. */
function dateLiteral(s: string): string {
  const m = DATE.exec(s)!;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4] ?? '00'}:${m[5] ?? '00'}:${m[6] ?? '00'}`;
}

/** A string value goodboy will quote: short, well-formed, with no control character and no backslash (so a quote
 *  is the one character to double, in both engines). */
function plainString(s: string): boolean {
  if (s.length > MAX_STRING) return false;
  try {
    encodeURIComponent(s); // throws on a lone surrogate
  } catch {
    return false;
  }
  return !/[\\\u0000-\u001f\u007f]/.test(s);
}

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** The condition JSON as a tree, or the field and reason it was refused for. */
export function parseWhere(text: string): Cond | Refusal {
  if (Buffer.byteLength(text, 'utf8') > MAX_WHERE_BYTES) return refuse('where', 'too-large');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return refuse('where', 'bad-json');
  }
  let nodes = 0;
  const walk = (v: unknown, path: string, depth: number): Cond | Refusal => {
    if (depth > MAX_DEPTH) return refuse(path, 'too-deep');
    if (++nodes > MAX_NODES) return refuse(path, 'too-many-nodes');
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return refuse(path, 'bad-shape');
    const keys = Object.keys(v);
    for (const kind of ['and', 'or'] as const) {
      if (!has(v, kind)) continue;
      const list = (v as Record<string, unknown>)[kind];
      if (keys.length !== 1 || !Array.isArray(list) || list.length === 0 || list.length > MAX_CHILDREN) return refuse(`${path}.${kind}`, 'bad-shape');
      const items: Cond[] = [];
      for (let i = 0; i < list.length; i++) {
        const c = walk(list[i], `${path}.${kind}[${i}]`, depth + 1);
        if (isRefusal(c)) return c;
        items.push(c);
      }
      return { kind, path, items };
    }
    if (keys.some((k) => k !== 'col' && k !== 'op' && k !== 'value')) return refuse(path, 'bad-shape');
    const o = v as { col?: unknown; op?: unknown; value?: unknown };
    if (typeof o.col !== 'string' || !IDENT.test(o.col)) return refuse(`${path}.col`, typeof o.col === 'string' ? 'bad-name' : 'missing');
    if (typeof o.op !== 'string') return refuse(`${path}.op`, 'missing');
    const op = (OPS as readonly string[]).includes(o.op) ? (o.op as CondOp) : null;
    if (op === null) return refuse(`${path}.op`, 'bad-op');
    const leaf = { kind: 'leaf' as const, path, col: o.col, op };
    if (op === 'is-null' || op === 'not-null') return has(v, 'value') ? refuse(`${path}.value`, 'unexpected') : leaf;
    if (!has(v, 'value')) return refuse(`${path}.value`, 'missing');
    const val = o.value;
    if (op === 'shape') return typeof val === 'string' && (CATEGORIES as readonly string[]).includes(val) ? { ...leaf, value: val } : refuse(`${path}.value`, 'bad-value');
    if ((CMP as readonly string[]).includes(op)) {
      if (plainNumber(val)) return { ...leaf, value: val };
      return typeof val === 'string' && isDate(val) ? { ...leaf, value: val } : refuse(`${path}.value`, 'bad-value');
    }
    // `=` and `!=`
    if (typeof val === 'number') return plainNumber(val) ? { ...leaf, value: val } : refuse(`${path}.value`, 'bad-value');
    if (typeof val === 'boolean') return { ...leaf, value: val };
    return typeof val === 'string' && plainString(val) ? { ...leaf, value: val } : refuse(`${path}.value`, 'bad-value');
  };
  return walk(json, 'where', 1);
}

/** A table reference: `name`, or `schema.name` (Postgres). */
const TABLE_REF = new RegExp(`^${ID}(?:\\.${ID})?$`);

/** `<op> …` as an operation, or the refusal. Options are `--name value` or `--name=value`. */
export function parseOp(args: readonly string[]): Op | Refusal {
  const op = args[0];
  if (op !== 'schema' && op !== 'shape' && op !== 'count' && op !== 'pick') return refuse('op', 'unknown-op');
  const allowed: readonly string[] = op === 'count' ? ['where'] : op === 'pick' ? ['where', 'n'] : [];
  const positional: string[] = [];
  const opts = new Map<string, string>();
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = a.slice(2, eq < 0 ? undefined : eq);
    if (!allowed.includes(name)) return refuse('option', 'unknown-option');
    if (opts.has(name)) return refuse(`--${name}`, 'unexpected');
    const val = eq >= 0 ? a.slice(eq + 1) : args[++i];
    if (val === undefined) return refuse(`--${name}`, 'missing');
    opts.set(name, val);
  }
  if (op === 'schema') return positional.length === 0 ? { op } : refuse('args', 'unexpected');
  if (positional.length === 0) return refuse('table', 'missing');
  if (positional.length > 1) return refuse('args', 'unexpected');
  const ref = positional[0]!;
  if (op === 'shape') {
    const dot = ref.lastIndexOf('.');
    const table = dot < 0 ? '' : ref.slice(0, dot);
    const col = ref.slice(dot + 1);
    if (dot < 0) return refuse('column', 'missing');
    return TABLE_REF.test(table) && IDENT.test(col) ? { op, table, col } : refuse('table', 'bad-name');
  }
  if (!TABLE_REF.test(ref)) return refuse('table', 'bad-name');
  const whereText = opts.get('where');
  const where = whereText === undefined ? null : parseWhere(whereText);
  if (isRefusal(where)) return where;
  if (op === 'count') return { op, table: ref, where };
  if (where === null) return refuse('where', 'missing');
  const nText = opts.get('n');
  const n = nText === undefined ? DEFAULT_PICK : /^\d{1,3}$/.test(nText) ? Number(nText) : 0;
  return n >= 1 && n <= MAX_PICK ? { op, table: ref, where, n } : refuse('--n', 'bad-number');
}

// ---- the dialects ----

/** The SQL words that differ between the engines. `expr` arguments are SQL goodboy built. */
interface Dialect {
  engine: Engine;
  q(name: string): string;
  text(expr: string): string;
  re(expr: string, pattern: string): string;
  len(expr: string): string;
  hex(expr: string): string;
  /** A fixed-width fingerprint of a text expression, to count distinct values of a wide column without sorting the text. */
  md5(expr: string): string;
  rand: string;
  /** The statements before the queries: the time limit, then a read-only transaction. */
  head: string[];
  tail: string[];
  bool(v: boolean): string;
}

export function dialect(engine: Engine): Dialect {
  if (engine === 'postgres') {
    return {
      engine,
      q: (n) => `"${n}"`,
      text: (e) => `CAST(${e} AS text)`,
      re: (e, p) => `${e} ~ '${p}'`,
      len: (e) => `char_length(${e})`,
      hex: (e) => `encode(convert_to(CAST(${e} AS text), 'UTF8'), 'hex')`,
      md5: (e) => `md5(${e})`,
      rand: 'random()',
      head: ["SET statement_timeout = '5s';", 'BEGIN READ ONLY;'],
      tail: ['COMMIT;'],
      bool: (v) => (v ? 'TRUE' : 'FALSE'),
    };
  }
  return {
    engine,
    q: (n) => `\`${n}\``,
    text: (e) => `CAST(${e} AS CHAR)`,
    re: (e, p) => `${e} REGEXP '${p}'`,
    len: (e) => `CHAR_LENGTH(${e})`,
    hex: (e) => `HEX(CAST(${e} AS CHAR))`,
    md5: (e) => `MD5(${e})`,
    rand: 'RAND()',
    head: [engine === 'mariadb' ? 'SET SESSION max_statement_time = 5;' : 'SET SESSION max_execution_time = 5000;', 'START TRANSACTION READ ONLY;'],
    tail: ['COMMIT;'],
    bool: (v) => (v ? '1' : '0'),
  };
}

/** The first line of every script: the fake docker of the tests, and a reader of the log, tell them apart by it. */
type Tag = 'schema' | 'rowcounts' | 'enum' | 'shape' | 'count' | 'pick';
const script = (d: Dialect, tag: Tag, body: string[]): string => [`-- goodboy-data: ${tag}`, ...d.head, ...body, ...d.tail, ''].join('\n');

// What text looks like each category (no backslash, so no escaping differs between the engines). The first
// that matches wins.
const RE = {
  uuid: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
  datetime: '^[0-9]{4}-[0-9]{2}-[0-9]{2}([ T][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?([+-][0-9]{2}(:?[0-9]{2})?|Z)?)?$',
  email: '^[^@ ]+@[^@ ]+[.][^@ ]+$',
  url: '^[A-Za-z][A-Za-z0-9+.-]*://[^ ]+$',
  integer: '^-?[0-9]{1,18}$',
  decimal: '^-?[0-9]+[.][0-9]+$',
  phone: '^[+]?[0-9][0-9 ()-]{6,20}$',
};

/** SQL that names a value's category (`v` is a text expression). */
function categoryCase(d: Dialect, v: string): string {
  return [
    'CASE',
    `WHEN ${v} IS NULL THEN 'null'`,
    `WHEN ${v} = '' THEN 'empty'`,
    `WHEN ${d.re(v, RE.uuid)} THEN 'uuid'`,
    `WHEN ${d.re(v, RE.datetime)} THEN 'datetime'`,
    `WHEN ${d.re(v, RE.email)} THEN 'email-like'`,
    `WHEN ${d.re(v, RE.url)} THEN 'url'`,
    `WHEN ${d.re(v, RE.integer)} THEN 'integer'`,
    `WHEN ${d.re(v, RE.decimal)} THEN 'decimal'`,
    `WHEN ${d.re(v, RE.phone)} THEN 'phone-like'`,
    "ELSE 'other' END",
  ].join(' ');
}

const IDENT_FILTER = (d: Dialect, e: string): string => d.re(e, IDENT_SRC);

// ---- the catalog ----

type ColClass = 'numeric' | 'bool' | 'text' | 'temporal' | 'uuid' | 'other';
export interface Col {
  name: string;
  type: string;
  cls: ColClass;
  nullable: boolean;
  /** 1-based position in the primary key, 0 when the column is not part of it. */
  pk: number;
  fk: boolean;
}
export interface Table {
  /** What a caller names it: `users`, or `audit.log` for a table outside `public`. */
  name: string;
  /** SQL for the table in a FROM clause. */
  ref: string;
  cols: Col[];
}

const NUMERIC = /^(?:smallint|integer|bigint|int|tinyint|mediumint|decimal|numeric|real|double precision|double|float|year)$/;
const TEXT = /^(?:char|varchar|text|character varying|character|tinytext|mediumtext|longtext|citext|bpchar)$/;
const TEMPORAL = /^(?:date|datetime|timestamp|timestamp without time zone|timestamp with time zone)$/;

export function classOf(type: string): ColClass {
  const t = type.toLowerCase();
  if (NUMERIC.test(t)) return 'numeric';
  if (t === 'boolean') return 'bool';
  if (TEXT.test(t)) return 'text';
  if (TEMPORAL.test(t)) return 'temporal';
  if (t === 'uuid') return 'uuid';
  return 'other';
}

/** The catalog: columns, then the constraint columns, then how many column names were left out. */
export function schemaSql(d: Dialect): string {
  const pg = d.engine === 'postgres';
  const inSchema = pg ? "c.table_schema NOT IN ('pg_catalog', 'information_schema') AND c.table_schema !~ '^pg_'" : 'c.table_schema = DATABASE()';
  const schemaCol = pg ? 'c.table_schema' : "'public'";
  const base = `FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name WHERE t.table_type = 'BASE TABLE' AND ${inSchema}`;
  const names = `${IDENT_FILTER(d, 'c.table_name')} AND ${IDENT_FILTER(d, 'c.column_name')}${pg ? ` AND ${IDENT_FILTER(d, 'c.table_schema')}` : ''}`;
  const cols = `SELECT 'C', ${schemaCol}, c.table_name, c.column_name, c.data_type, c.is_nullable ${base} AND ${names} ORDER BY ${pg ? 'c.table_schema, ' : ''}c.table_name, c.ordinal_position LIMIT ${SCHEMA_ROWS + 1};`;
  const skipped = `SELECT 'S', count(*) ${base} AND NOT (${names});`;
  const keys = pg
    ? `SELECT 'K', n.nspname, cl.relname, a.attname, con.contype, array_position(con.conkey, a.attnum) FROM pg_constraint con JOIN pg_class cl ON cl.oid = con.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum = ANY (con.conkey) WHERE con.contype IN ('p', 'f') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_' AND ${IDENT_FILTER(d, 'n.nspname')} AND ${IDENT_FILTER(d, 'cl.relname')} AND ${IDENT_FILTER(d, 'a.attname')} ORDER BY n.nspname, cl.relname, array_position(con.conkey, a.attnum) LIMIT ${SCHEMA_ROWS + 1};`
    : `SELECT 'K', 'public', k.table_name, k.column_name, IF(k.constraint_name = 'PRIMARY', 'p', 'f'), k.ordinal_position FROM information_schema.key_column_usage k WHERE k.table_schema = DATABASE() AND (k.constraint_name = 'PRIMARY' OR k.referenced_table_name IS NOT NULL) AND ${IDENT_FILTER(d, 'k.table_name')} AND ${IDENT_FILTER(d, 'k.column_name')} ORDER BY k.table_name, k.ordinal_position LIMIT ${SCHEMA_ROWS + 1};`;
  return script(d, 'schema', [cols, skipped, keys]);
}

const TYPE_NAME = /^[A-Za-z][A-Za-z0-9 _-]{0,40}$/;

/** The catalog answer as tables, or null when any line is not of its exact shape. Names that are no plain
 *  identifier were left out by the query; `skipped` counts those columns. */
export function parseSchema(stdout: string, engine: Engine): { tables: Table[]; skipped: number; truncated: boolean } | null {
  const d = dialect(engine);
  const lines = stdout.split('\n');
  if (lines[lines.length - 1] !== '') return null;
  lines.pop();
  const byKey = new Map<string, { schema: string; table: string; cols: Col[] }>();
  const order: string[] = [];
  const keyRows: { schema: string; table: string; col: string; kind: string; pos: number }[] = [];
  let skipped: number | null = null;
  let cRows = 0;
  let kRows = 0;
  for (const line of lines) {
    const f = line.split('\t');
    if (f[0] === 'C' && f.length === 6) {
      if (++cRows > SCHEMA_ROWS) continue;
      const [, schema, table, col, type, nullable] = f as [string, string, string, string, string, string];
      if (!IDENT.test(schema) || !IDENT.test(table) || !IDENT.test(col) || !TYPE_NAME.test(type) || (nullable !== 'YES' && nullable !== 'NO')) return null;
      const key = `${schema}\u0000${table}`;
      let t = byKey.get(key);
      if (t === undefined) {
        t = { schema, table, cols: [] };
        byKey.set(key, t);
        order.push(key);
      }
      t.cols.push({ name: col, type, cls: classOf(type), nullable: nullable === 'YES', pk: 0, fk: false });
    } else if (f[0] === 'S' && f.length === 2 && /^\d{1,9}$/.test(f[1]!) && skipped === null) skipped = Number(f[1]);
    else if (f[0] === 'K' && f.length === 6) {
      if (++kRows > SCHEMA_ROWS) continue;
      const [, schema, table, col, kind, pos] = f as [string, string, string, string, string, string];
      if (!IDENT.test(schema) || !IDENT.test(table) || !IDENT.test(col) || (kind !== 'p' && kind !== 'f') || !/^\d{1,4}$/.test(pos)) return null;
      keyRows.push({ schema, table, col, kind, pos: Number(pos) });
    } else return null;
  }
  if (skipped === null) return null;
  for (const k of keyRows) {
    const col = byKey.get(`${k.schema}\u0000${k.table}`)?.cols.find((c) => c.name === k.col);
    if (col === undefined) continue;
    if (k.kind === 'p') col.pk = k.pos;
    else col.fk = true;
  }
  const truncated = cRows > SCHEMA_ROWS || kRows > SCHEMA_ROWS;
  const tables = order.map((key) => {
    const t = byKey.get(key)!;
    const name = t.schema === 'public' ? t.table : `${t.schema}.${t.table}`;
    return { name, ref: engine === 'postgres' ? `${d.q(t.schema)}.${d.q(t.table)}` : d.q(t.table), cols: t.cols };
  });
  return { tables, skipped, truncated };
}

/** `0`, `<10`, `10-99`, `100-999`, `1k-10k`, `>10k` for a count that was taken up to 10001. */
export function rowBucket(n: number): string {
  if (n === 0) return '0';
  if (n < 10) return '<10';
  if (n < 100) return '10-99';
  if (n < 1000) return '100-999';
  return n <= 10_000 ? '1k-10k' : '>10k';
}

/** The row-count query of up to TABLE_CHUNK tables: `R<TAB>index<TAB>count`, each count cut at 10001. */
export function rowCountsSql(d: Dialect, tables: readonly Table[]): string {
  const sel = tables.map((t, i) => `SELECT 'R', ${i}, (SELECT count(*) FROM (SELECT 1 FROM ${t.ref} LIMIT 10001) x)`);
  return script(d, 'rowcounts', [`${sel.join(' UNION ALL ')};`]);
}

/** Lines `<tag><TAB>field...` of an answer, every one with an exact shape, each tag at most `max` times; null otherwise. */
function rows(stdout: string, shapes: Record<string, { fields: number; max: number }>): string[][] | null {
  if (stdout.length >= MAX_STDOUT) return null;
  const lines = stdout.split('\n');
  if (lines[lines.length - 1] !== '') return null;
  lines.pop();
  const seen: Record<string, number> = {};
  const out: string[][] = [];
  for (const line of lines) {
    const f = line.split('\t');
    const s = shapes[f[0]!];
    if (s === undefined || f.length !== s.fields) return null;
    seen[f[0]!] = (seen[f[0]!] ?? 0) + 1;
    if (seen[f[0]!]! > s.max) return null;
    out.push(f);
  }
  return out;
}

/** `<tag><TAB>index<TAB>number` for each of `n` indexes, each once: the numbers by index, or null. */
function indexed(stdout: string, tag: 'R' | 'E', n: number): number[] | null {
  const r = rows(stdout, { [tag]: { fields: 3, max: n } });
  if (r === null || r.length !== n) return null;
  const out: number[] = Array.from({ length: n }, () => -1);
  for (const f of r) {
    if (!/^\d{1,3}$/.test(f[1]!) || !/^\d{1,6}$/.test(f[2]!)) return null;
    const i = Number(f[1]);
    if (i >= n || out[i] !== -1) return null;
    out[i] = Number(f[2]);
  }
  return out;
}

export const parseRowCounts = (stdout: string, n: number): number[] | null => indexed(stdout, 'R', n);

// ---- conditions in SQL ----

/** The SQL of a validated condition over one table (every leaf checked by `checkCond`). */
function renderWhere(d: Dialect, t: Table, c: Cond): string {
  if (c.kind !== 'leaf') return `(${c.items.map((i) => renderWhere(d, t, i)).join(c.kind === 'and' ? ' AND ' : ' OR ')})`;
  const col = d.q(c.col);
  if (c.op === 'is-null') return `(${col} IS NULL)`;
  if (c.op === 'not-null') return `(${col} IS NOT NULL)`;
  if (c.op === 'shape') return `(${categoryCase(d, d.text(col))} = '${c.value as string}')`;
  const cls = t.cols.find((x) => x.name === c.col)!.cls;
  const sqlOp = c.op === '!=' ? '<>' : c.op;
  return `(${col} ${sqlOp} ${literal(d, cls, c.value as Scalar)})`;
}

function literal(d: Dialect, cls: ColClass, v: Scalar): string {
  if (typeof v === 'boolean') return d.bool(v);
  if (typeof v === 'number') return String(v);
  return cls === 'temporal' ? `'${dateLiteral(v)}'` : `'${v.replace(/'/g, "''")}'`;
}

/** Checks every leaf of a condition against the table: the column exists and the operator and value fit its
 *  type. Returns the refusal, or the columns that `=`/`!=` need an enum-like check for (with the leaf's path). */
export function checkCond(t: Table, c: Cond): Refusal | { enumCols: Map<string, string> } {
  const enumCols = new Map<string, string>();
  const walk = (n: Cond): Refusal | null => {
    if (n.kind !== 'leaf') {
      for (const i of n.items) {
        const r = walk(i);
        if (r !== null) return r;
      }
      return null;
    }
    const col = t.cols.find((x) => x.name === n.col);
    if (col === undefined) return refuse(`${n.path}.col`, 'unknown-column');
    if (n.op === 'is-null' || n.op === 'not-null' || n.op === 'shape') return null;
    const v = n.value as Scalar;
    if ((CMP as readonly string[]).includes(n.op)) {
      const ok = (col.cls === 'numeric' && typeof v === 'number') || (col.cls === 'temporal' && typeof v === 'string');
      return ok ? null : refuse(`${n.path}.value`, 'bad-type');
    }
    const ok =
      (col.cls === 'numeric' && typeof v === 'number') ||
      (col.cls === 'bool' && typeof v === 'boolean') ||
      (col.cls === 'text' && typeof v === 'string') ||
      (col.cls === 'temporal' && typeof v === 'string' && isDate(v));
    if (!ok) return refuse(`${n.path}.value`, 'bad-type');
    if (!enumCols.has(col.name)) enumCols.set(col.name, n.path);
    return null;
  };
  const r = walk(c);
  return r ?? { enumCols };
}

// ---- the operations' SQL and answers ----

/** `E<TAB>index<TAB>n`: how many distinct values (up to 51) the first rows of each column hold, counted over the md5 of
 *  the text so a wide column is not sorted whole. */
export function enumSql(d: Dialect, t: Table, cols: readonly string[]): string {
  const sel = cols.map((c, i) => `SELECT 'E', ${i}, (SELECT count(*) FROM (SELECT DISTINCT ${d.md5(d.text(d.q(c)))} FROM (SELECT ${d.q(c)} FROM ${t.ref} LIMIT ${SAMPLE_ROWS}) s LIMIT ${ENUM_MAX + 1}) x)`);
  return script(d, 'enum', [`${sel.join(' UNION ALL ')};`]);
}

/** Whether each column has at most 50 distinct values, from the `E` lines. */
export function parseEnum(stdout: string, n: number): boolean[] | null {
  return indexed(stdout, 'E', n)?.map((v) => v <= ENUM_MAX) ?? null;
}

export function countSql(d: Dialect, t: Table, where: Cond | null): string {
  const w = where === null ? '' : ` WHERE ${renderWhere(d, t, where)}`;
  return script(d, 'count', [`SELECT 'N', count(*) FROM ${t.ref}${w};`]);
}

export function parseCount(stdout: string): number | null {
  const r = rows(stdout, { N: { fields: 2, max: 1 } });
  return r !== null && r.length === 1 && /^\d{1,15}$/.test(r[0]![1]!) ? Number(r[0]![1]) : null;
}

/** An exact count when at least K, else "<10". */
export const countOut = (n: number): number | string => (n >= K ? n : `<${K}`);

export function shapeSql(d: Dialect, t: Table, col: string): string {
  const c = d.q(col);
  // derived tables, not a WITH clause: MySQL 5.7 has none
  const s = `(SELECT ${d.text(c)} AS v FROM ${t.ref} LIMIT ${SAMPLE_ROWS}) s`;
  const len = d.len('v');
  const bucket = `CASE WHEN ${len} = 0 THEN '0' WHEN ${len} <= 8 THEN '1-8' WHEN ${len} <= 32 THEN '9-32' WHEN ${len} <= 128 THEN '33-128' WHEN ${len} <= 1024 THEN '129-1024' ELSE '>1024' END`;
  return script(d, 'shape', [
    `SELECT 'C', cat, count(*) FROM (SELECT ${categoryCase(d, 'v')} AS cat FROM ${s}) c GROUP BY cat;`,
    `SELECT 'L', b, count(*) FROM (SELECT ${bucket} AS b FROM ${s} WHERE v IS NOT NULL) l GROUP BY b;`,
    // the md5 of the text, so a wide column is not sorted whole
    `SELECT 'D', count(*) FROM (SELECT DISTINCT ${d.md5('v')} FROM ${s} WHERE v IS NOT NULL LIMIT ${ENUM_MAX + 1}) d;`,
    // the table is bigger than the sample when 100001 rows are there
    `SELECT 'T', count(*) FROM (SELECT 1 FROM ${t.ref} LIMIT ${SAMPLE_ROWS + 1}) x;`,
  ]);
}

const LENGTH_BUCKETS = ['0', '1-8', '9-32', '33-128', '129-1024', '>1024'];

export interface Shape {
  /** A count of K or more as it is, else "<10". */
  categories: Record<string, number | string>;
  lengths: Record<string, number | string>;
  /** `0`, `1`, `2-9`, `10-50` or `>50`. */
  distinct: string;
  enumLike: boolean;
  /** The table has more rows than the sample (100000 rows) the answer is made from. */
  sampled: boolean;
}

export function parseShape(stdout: string): Shape | null {
  const r = rows(stdout, { C: { fields: 3, max: CATEGORIES.length }, L: { fields: 3, max: LENGTH_BUCKETS.length }, D: { fields: 2, max: 1 }, T: { fields: 2, max: 1 } });
  if (r === null) return null;
  const cat: Record<string, number> = {};
  const len: Record<string, number> = {};
  let distinct: number | null = null;
  let rowsSeen: number | null = null;
  for (const f of r) {
    if (f[0] === 'D' || f[0] === 'T') {
      if (!/^\d{1,9}$/.test(f[1]!) || (f[0] === 'D' && f[1]!.length > 3)) return null;
      if (f[0] === 'D') distinct = Number(f[1]);
      else rowsSeen = Number(f[1]);
      continue;
    }
    const target = f[0] === 'C' ? cat : len;
    const names: readonly string[] = f[0] === 'C' ? CATEGORIES : LENGTH_BUCKETS;
    if (!names.includes(f[1]!) || !/^\d{1,9}$/.test(f[2]!) || has(target, f[1]!)) return null;
    target[f[1]!] = Number(f[2]);
  }
  if (distinct === null || rowsSeen === null) return null;
  const shown = (src: Record<string, number>, names: readonly string[]): Record<string, number | string> => Object.fromEntries(names.map((n) => [n, countOut(src[n] ?? 0)]));
  return {
    categories: shown(cat, CATEGORIES),
    lengths: shown(len, LENGTH_BUCKETS),
    distinct: distinct === 0 ? '0' : distinct === 1 ? '1' : distinct < 10 ? '2-9' : distinct <= ENUM_MAX ? '10-50' : '>50',
    enumLike: distinct <= ENUM_MAX,
    sampled: rowsSeen > SAMPLE_ROWS,
  };
}

/** The pick query: how many rows (up to K) the condition matches, then up to `n` random rows' primary keys as hex. */
export function pickSql(d: Dialect, t: Table, where: Cond, n: number): string {
  const w = renderWhere(d, t, where);
  const pk = t.cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
  const hexes = pk.map((c) => d.hex(d.q(c.name))).join(', ');
  return script(d, 'pick', [`SELECT 'M', count(*) FROM (SELECT 1 FROM ${t.ref} WHERE ${w} LIMIT ${K}) x;`, `SELECT 'P', ${hexes} FROM ${t.ref} WHERE ${w} ORDER BY ${d.rand} LIMIT ${n};`]);
}

/** The matching count (cut at K) and the primary keys' hex of the rows picked. */
export function parsePick(stdout: string, pkWidth: number, n: number): { matches: number; keys: string[][] } | null {
  const r = rows(stdout, { M: { fields: 2, max: 1 }, P: { fields: 1 + pkWidth, max: n } });
  if (r === null) return null;
  const m = r.find((f) => f[0] === 'M');
  if (m === undefined || !/^\d{1,3}$/.test(m[1]!)) return null;
  const keys: string[][] = [];
  for (const f of r) {
    if (f[0] !== 'P') continue;
    const parts = f.slice(1).map((h) => h.toLowerCase());
    if (!parts.every((h) => /^[0-9a-f]*$/.test(h) && h.length <= MAX_HEX && h.length % 2 === 0)) return null;
    keys.push(parts);
  }
  return { matches: Number(m[1]), keys };
}

// ---- handles ----

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32(bytes: Uint8Array): string {
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

/** `h_` and the base32 of the first 20 bytes of HMAC-SHA-256(key, engine|db|table|pk-tuple). The tuple is
 *  each key column's value bytes (hex), length-prefixed, so two rows never share an input; it is the same
 *  row after a reset and in a rebuilt database, and another sandbox (another key) gives another handle. */
export function handleOf(keyHex: string, engine: Engine, db: string, table: string, pkHex: readonly string[]): string {
  const tuple = pkHex.map((h) => `${h.length}:${h}`).join(',');
  const mac = createHmac('sha256', Buffer.from(keyHex, 'hex')).update(`${engine}|${db}|${table}|${tuple}`).digest();
  return `h_${base32(mac.subarray(0, 20))}`;
}

// ---- running an operation ----

export interface DataTarget {
  engine: Engine;
  /** The database's compose service. */
  svc: string;
  /** The app database's name. */
  db: string;
}

export interface DataCtx {
  /** The first SQL store of the project, or null. */
  target: DataTarget | null;
  comp(args: string[], timeoutMs: number, o?: DockOpts): Promise<Bounded>;
  /** The daemon is the local one and the compose file passes the static check (asked once the input is parsed, before any query). */
  ready(): Promise<boolean>;
  /** The handle key out of the sandbox's `meta` volume (made when there is none), or null when it could not be read. */
  key(candidate: string): Promise<string | null>;
}

type DataResult = { out: Record<string, unknown>; code: number };

/** The client's argv after `exec -T <svc>` (the SQL is on stdin). */
export function clientArgv(t: DataTarget): string[] {
  if (t.engine === 'postgres') return ['psql', '-X', '-q', '-U', PG_READER, '-d', t.db, '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate', '-A', '-t', '-F', '\t', '-f', '-'];
  return [t.engine === 'mariadb' ? 'mariadb' : 'mysql', '-N', '-B', '--default-character-set=utf8mb4', '--connect-timeout=5', '-u', MY_READER, t.db];
}

/** Runs one script as the reader role: its stdout, or null for a failure of any kind (exit code, time, a cut-off
 *  answer, a start error). Neither stream is ever shown. */
async function runSql(dc: DataCtx, t: DataTarget, sql: string): Promise<string | null> {
  const r = await dc.comp(['exec', '-T', t.svc, ...clientArgv(t)], EXEC_MS, { stdin: sql, max: { stdout: MAX_STDOUT, stderr: 64 * 1024 } });
  if (r.error !== undefined || r.timedOut || r.code !== 0 || r.stdout.length >= MAX_STDOUT) return null;
  return r.stdout;
}

const failed = (op: string): DataResult => ({ out: { op, ok: false, diagnostic: { code: 'data-failed', step: op } satisfies Diag }, code: 1 });
const refused = (op: string, r: Refusal): DataResult => ({ out: { op, ok: false, diagnostic: { code: 'data-refused', step: op, field: r.field, reason: r.reason } satisfies Diag }, code: 1 });

/** The tables of the schema, or the diagnostic. */
async function catalog(dc: DataCtx, t: DataTarget): Promise<{ tables: Table[]; skipped: number; truncated: boolean } | null> {
  const out = await runSql(dc, t, schemaSql(dialect(t.engine)));
  return out === null ? null : parseSchema(out, t.engine);
}

const findTable = (tables: readonly Table[], name: string): Table | undefined => tables.find((x) => x.name === name);

/** `sandbox-data <op> …`: one operation, answered with JSON goodboy builds. `{ok: false, diagnostic}` and exit code 1
 *  for a refusal (`data-refused`, with the field and a fixed reason) or any failure (`data-failed`, the op's name). */
export async function sandboxData(dc: DataCtx, args: readonly string[]): Promise<DataResult | { error: string }> {
  const parsed = parseOp(args);
  if (isRefusal(parsed)) {
    if (parsed.reason === 'unknown-op') return { error: 'sandbox-data: the first word is schema, shape <table>.<col>, count <table> [--where <json>] or pick <table> --where <json> [--n N]' };
    return refused(opName(args[0]), parsed);
  }
  const t = dc.target;
  if (t === null) return refused(parsed.op, refuse('store', 'no-sql-store'));
  try {
    if (!(await dc.ready())) return failed(parsed.op);
    const d = dialect(t.engine);
    const cat = await catalog(dc, t);
    if (cat === null) return failed(parsed.op);
    if (parsed.op === 'schema') {
      const listed = cat.tables.slice(0, MAX_TABLES);
      const buckets: string[] = [];
      for (let i = 0; i < listed.length; i += TABLE_CHUNK) {
        const chunk = listed.slice(i, i + TABLE_CHUNK);
        const out = await runSql(dc, t, rowCountsSql(d, chunk));
        const counts = out === null ? null : parseRowCounts(out, chunk.length);
        if (counts === null) return failed('schema');
        buckets.push(...counts.map(rowBucket));
      }
      return {
        out: {
          op: 'schema',
          ok: true,
          engine: t.engine,
          tables: listed.map((tb, i) => ({
            name: tb.name,
            rows: buckets[i],
            columns: tb.cols.map((c) => ({ name: c.name, type: c.type, nullable: c.nullable, pk: c.pk > 0, fk: c.fk })),
          })),
          ...(cat.tables.length > MAX_TABLES || cat.truncated ? { truncated: true } : {}),
          ...(cat.skipped > 0 ? { skippedNames: cat.skipped } : {}),
        },
        code: 0,
      };
    }
    const tb = findTable(cat.tables, parsed.table);
    if (tb === undefined) return refused(parsed.op, refuse('table', 'unknown-table'));
    if (parsed.op === 'shape') {
      if (!tb.cols.some((c) => c.name === parsed.col)) return refused('shape', refuse('column', 'unknown-column'));
      const out = await runSql(dc, t, shapeSql(d, tb, parsed.col));
      const shape = out === null ? null : parseShape(out);
      return shape === null ? failed('shape') : { out: { op: 'shape', ok: true, table: tb.name, column: parsed.col, ...shape }, code: 0 };
    }
    if (parsed.where !== null) {
      const checked = checkCond(tb, parsed.where);
      if (isRefusal(checked)) return refused(parsed.op, checked);
      if (checked.enumCols.size > 0) {
        const cols = [...checked.enumCols.keys()];
        const out = await runSql(dc, t, enumSql(d, tb, cols));
        const enums = out === null ? null : parseEnum(out, cols.length);
        if (enums === null) return failed(parsed.op);
        const bad = cols.findIndex((_, i) => !enums[i]);
        if (bad >= 0) return refused(parsed.op, refuse(`${checked.enumCols.get(cols[bad]!)!}.col`, 'not-enum-like'));
      }
    }
    if (parsed.op === 'count') {
      const out = await runSql(dc, t, countSql(d, tb, parsed.where));
      const n = out === null ? null : parseCount(out);
      return n === null ? failed('count') : { out: { op: 'count', ok: true, table: tb.name, count: countOut(n) }, code: 0 };
    }
    const pk = tb.cols.filter((c) => c.pk > 0);
    if (pk.length === 0) return refused('pick', refuse('table', 'no-primary-key'));
    const out = await runSql(dc, t, pickSql(d, tb, parsed.where, parsed.n));
    const picked = out === null ? null : parsePick(out, pk.length, parsed.n);
    if (picked === null) return failed('pick');
    if (picked.matches < K) return refused('pick', refuse('where', 'too-few-rows'));
    const key = await dc.key(randomBytes(32).toString('hex'));
    if (key === null) return failed('pick');
    const handles = [...new Set(picked.keys.map((k) => handleOf(key, t.engine, t.db, tb.name, k)))];
    return { out: { op: 'pick', ok: true, table: tb.name, handles }, code: 0 };
  } catch {
    return failed(opName(args[0]));
  }
}

const opName = (v: string | undefined): string => (v === 'schema' || v === 'shape' || v === 'count' || v === 'pick' ? v : 'op');
