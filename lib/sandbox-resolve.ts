// The data a run's tests use (track M, M6c; plan §19): the manifest `.goodboy/sandbox/data.json` and the resolve step of
// `sandbox-run`. A test against a restored dump must not hold a value of it, so it asks for values by name and the run
// resolves them for it:
//
//   data.json   { "version": 1,
//                 "picks":    { "activeUser": { "table": "users", "where": {…}, "n": 3, "columns": ["name", "email"] } },
//                 "counts":   { "activeUsers": { "table": "users", "where": {…} } },
//                 "generate": { "newUserEmail": { "table": "users", "column": "email", "kind": "email" } } }
//
// It holds conditions, never values (tracked in git). `where` is the grammar of `sandbox-data` (lib/sandbox-data.ts), checked
// by the same code against the database's own catalog. Every refusal names a field path and a reason of its fixed list.
//
// The resolve step runs after each reset of the database, before the suites, in two phases:
//   1. as the reader role, answers that are counts only (stdout is read here): the schema, one statement for the enum checks,
//      how many rows each pick matches (at least 10, as `sandbox-data pick`), the width of a decimal column a number generator
//      writes, and how many of a table's first rows already sit in each generator's reserved space (none may). A run does it
//      once: the second reset restores the same dump, so the answers are kept (`Memo`) for the second resolve;
//   2. one script inside the database container: the reader role's client writes `values.tsv` into the `data` volume
//      (`/goodboy-data`), and the call prints two numbers, the file's lines and bytes (the byte limit is checked in the
//      container). goodboy's process never reads the file: the values go from the database to a volume only the test
//      containers mount (read-only) and the helpers read (lib/sandbox-data-helper.ts). They are cleared when the suites end.
// A failure is a fixed diagnostic: stdout and stderr of these calls are never shown, and each statement has its own reason
// (`<reason>-timeout` when it ran into its time limit).

import { randomBytes } from 'node:crypto';
import { join, posix } from 'node:path';
import type { Diag } from './sandbox-boundary';
import { readRegular } from './safe-read';
import { noLinksUnder } from './sandbox-proof';
import {
  catalog,
  checkCond,
  clientArgv,
  type Cond,
  type DataCtx,
  type DataTarget,
  type Dialect,
  dialect,
  enumSqlFor,
  EXEC_MS,
  findTable,
  has,
  IDENT,
  isRefusal,
  K,
  MAX_PICK,
  MAX_STDOUT,
  parseEnum,
  parseWhere,
  type Refusal,
  refuse,
  renderWhere,
  runSqlResult,
  SAMPLE_ROWS,
  script,
  type Table,
  TABLE_REF,
} from './sandbox-data';
import { SANDBOX_DIR } from './sandbox-mode';
import { DATA_DIR, DATA_FILE, DATA_VOLUME } from './sandbox-volumes';
import { GENERATED_PREFIX, LONG_MARK, MAX_CELL_CHARS, NUMBER_BASE, PHONE_PREFIX } from './sandbox-data-helper';

const MANIFEST_FILE = 'data.json';
const MAX_MANIFEST_BYTES = 64 * 1024;
/** The most `values.tsv` may hold, checked inside the database container (`wc -c`) before the file is put in place. */
export const MAX_VALUES_BYTES = 4 * 1024 * 1024;
const MAX_PICKS = 50;
const MAX_COUNTS = 50;
const MAX_GENERATE = 20;
const MAX_COLUMNS = 20;
const DEFAULT_N = 5;
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const KINDS = ['email', 'phone', 'text', 'number'] as const;
type Kind = (typeof KINDS)[number];

interface PickDef {
  name: string;
  table: string;
  where: Cond;
  n: number;
  columns: string[];
}
interface CountDef {
  name: string;
  table: string;
  where: Cond | null;
}
interface GenDef {
  name: string;
  table: string;
  column: string;
  kind: Kind;
}
export interface Manifest {
  picks: PickDef[];
  counts: CountDef[];
  generate: GenDef[];
}

// ---- the manifest ----

type Obj = Record<string, unknown>;

/** A copy of parsed JSON with null-prototype objects (a key named `__proto__` or `constructor` is then only a key), or
 *  null when it nests deeper than any manifest does. */
function plain(v: unknown, depth = 0): unknown {
  if (depth > 12) return null;
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (const x of v) {
      const c = plain(x, depth + 1);
      if (c === null && x !== null) return null;
      out.push(c);
    }
    return out;
  }
  if (typeof v === 'object' && v !== null) {
    const out: Obj = Object.create(null) as Obj;
    for (const k of Object.keys(v)) {
      const c = plain((v as Obj)[k], depth + 1);
      if (c === null && (v as Obj)[k] !== null) return null;
      out[k] = c;
    }
    return out;
  }
  return v;
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A name of the manifest: the pattern, and no name an object already has (`constructor`, `toString`, …). */
const goodName = (k: string): boolean => NAME.test(k) && !(k in Object.prototype);

/** The path of `key` below `base`; a key that is no good name is shown by its place, never as it is. */
const at = (base: string, key: string, i: number): string => (goodName(key) ? `${base}.${key}` : `${base}[${i}]`);

/** The words of the manifest and the near misses a typo makes of them: a key outside `allowed` is named in a refusal only
 *  when it is one of these (`columnns` is not), else it is shown by its place, so no text of the file comes back. */
const VOCABULARY: ReadonlySet<string> = new Set(['version', 'picks', 'counts', 'generate', 'table', 'where', 'n', 'columns', 'column', 'kind', 'name', 'type', 'op', 'col', 'value', 'values', 'limit', 'count', 'pick', 'id']);

/** Keys of `o` that are not in `allowed`: the first one's path, or null. */
function strayKey(o: Obj, base: string, allowed: readonly string[]): string | null {
  const keys = Object.keys(o);
  for (const [i, k] of keys.entries()) if (!allowed.includes(k)) return VOCABULARY.has(k) ? `${base}.${k}` : `${base}[${i}]`;
  return null;
}

function tableOf(o: Obj, base: string): string | Refusal {
  if (!has(o, 'table')) return refuse(`${base}.table`, 'missing');
  return typeof o.table === 'string' && TABLE_REF.test(o.table) ? o.table : refuse(`${base}.table`, 'bad-name');
}

/** The `where` of an entry through the grammar of `sandbox-data`; its paths start at `where`, here `<base>.where`. */
function whereOf(o: Obj, base: string, required: boolean): Cond | null | Refusal {
  if (!has(o, 'where')) return required ? refuse(`${base}.where`, 'missing') : null;
  if (!isObj(o.where)) return refuse(`${base}.where`, 'bad-shape');
  const c = parseWhere(JSON.stringify(o.where));
  return isRefusal(c) ? refuse(`${base}.${c.field}`, c.reason) : c;
}

function identOf(v: unknown, field: string): string | Refusal {
  return typeof v === 'string' && IDENT.test(v) ? v : refuse(field, typeof v === 'string' ? 'bad-name' : 'bad-shape');
}

function pickOf(name: string, o: Obj, base: string): PickDef | Refusal {
  const stray = strayKey(o, base, ['table', 'where', 'n', 'columns']);
  if (stray !== null) return refuse(stray, 'bad-shape');
  const table = tableOf(o, base);
  if (isRefusal(table)) return table;
  const where = whereOf(o, base, true);
  if (isRefusal(where)) return where;
  let n = DEFAULT_N;
  if (has(o, 'n')) {
    if (typeof o.n !== 'number' || !Number.isInteger(o.n) || o.n < 1 || o.n > MAX_PICK) return refuse(`${base}.n`, 'bad-number');
    n = o.n;
  }
  if (!has(o, 'columns')) return refuse(`${base}.columns`, 'missing');
  if (!Array.isArray(o.columns) || o.columns.length === 0) return refuse(`${base}.columns`, 'bad-shape');
  if (o.columns.length > MAX_COLUMNS) return refuse(`${base}.columns`, 'too-many');
  const columns: string[] = [];
  for (const [i, c] of o.columns.entries()) {
    const id = identOf(c, `${base}.columns[${i}]`);
    if (isRefusal(id)) return id;
    if (columns.includes(id)) return refuse(`${base}.columns[${i}]`, 'bad-shape');
    columns.push(id);
  }
  return { name, table, where: where as Cond, n, columns };
}

function countOf(name: string, o: Obj, base: string): CountDef | Refusal {
  const stray = strayKey(o, base, ['table', 'where']);
  if (stray !== null) return refuse(stray, 'bad-shape');
  const table = tableOf(o, base);
  if (isRefusal(table)) return table;
  const where = whereOf(o, base, false);
  return isRefusal(where) ? where : { name, table, where };
}

function genOf(name: string, o: Obj, base: string): GenDef | Refusal {
  const stray = strayKey(o, base, ['table', 'column', 'kind']);
  if (stray !== null) return refuse(stray, 'bad-shape');
  const table = tableOf(o, base);
  if (isRefusal(table)) return table;
  if (!has(o, 'column')) return refuse(`${base}.column`, 'missing');
  const column = identOf(o.column, `${base}.column`);
  if (isRefusal(column)) return column;
  if (!has(o, 'kind')) return refuse(`${base}.kind`, 'missing');
  if (typeof o.kind !== 'string' || !(KINDS as readonly string[]).includes(o.kind)) return refuse(`${base}.kind`, 'unknown-kind');
  return { name, table, column, kind: o.kind as Kind };
}

/** Every entry of one section (`picks`, `counts`, `generate`) through `one`. */
function section<T>(root: Obj, key: string, max: number, one: (name: string, o: Obj, base: string) => T | Refusal): T[] | Refusal {
  if (!has(root, key)) return [];
  const sec = root[key];
  if (!isObj(sec)) return refuse(key, 'bad-shape');
  const names = Object.keys(sec);
  if (names.length > max) return refuse(key, 'too-many');
  const out: T[] = [];
  for (const [i, name] of names.entries()) {
    const base = at(key, name, i);
    if (!goodName(name)) return refuse(base, 'bad-name');
    const entry = sec[name];
    if (!isObj(entry)) return refuse(base, 'bad-shape');
    const r = one(name, entry, base);
    if (isRefusal(r)) return r;
    out.push(r);
  }
  return out;
}

/** The manifest text as a manifest, or the refusal. */
export function parseManifest(text: string): Manifest | Refusal {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return refuse(MANIFEST_FILE, 'bad-json');
  }
  const root = plain(json);
  if (!isObj(root)) return refuse(MANIFEST_FILE, 'bad-shape');
  const stray = strayKey(root, '', ['version', 'picks', 'counts', 'generate']);
  if (stray !== null) return refuse(stray.replace(/^\./, ''), 'bad-shape');
  if (!has(root, 'version')) return refuse('version', 'missing');
  if (root.version !== 1) return refuse('version', 'bad-version');
  const picks = section(root, 'picks', MAX_PICKS, pickOf);
  if (isRefusal(picks)) return picks;
  const counts = section(root, 'counts', MAX_COUNTS, countOf);
  if (isRefusal(counts)) return counts;
  const generate = section(root, 'generate', MAX_GENERATE, genOf);
  if (isRefusal(generate)) return generate;
  return { picks, counts, generate };
}

/** `<root>/.goodboy/sandbox/data.json` as a manifest; null when there is none; the refusal when it cannot be read
 *  (a link, not a regular file, over 64 KB, a link on the way) or is not a manifest. */
export function readManifest(root: string): Manifest | null | Refusal {
  const p = join(root, SANDBOX_DIR, MANIFEST_FILE);
  const r = readRegular(p, MAX_MANIFEST_BYTES, true);
  if (r === 'absent') return null;
  if (r === 'refused' || !noLinksUnder(root, [...SANDBOX_DIR.split('/'), MANIFEST_FILE], 'file')) return refuse(MANIFEST_FILE, 'unreadable');
  return parseManifest(r.text);
}

/** How many entries each section holds: the only thing of the manifest a result file records. */
export const manifestCounts = (m: Manifest): { picks: number; counts: number; generate: number } => ({ picks: m.picks.length, counts: m.counts.length, generate: m.generate.length });

// ---- the SQL ----

/** A condition on `v`, the column a generator writes, that holds for a value inside the generator's reserved space. */
function reservedPredicate(d: Dialect, g: GenDef): string {
  if (g.kind === 'number') return `v >= ${NUMBER_BASE}`;
  return `${d.text('v')} LIKE '${g.kind === 'phone' ? PHONE_PREFIX : GENERATED_PREFIX}%'`;
}

/** Phase 1, one statement: `M<TAB>i<TAB>n` (up to K rows a pick's condition matches) for each pick. Counts only. */
export function matchesSql(d: Dialect, picks: readonly { t: Table; def: PickDef }[]): string {
  const sel = picks.map((p, i) => `SELECT 'M', ${i}, (SELECT count(*) FROM (SELECT 1 FROM ${p.t.ref} WHERE ${renderWhere(d, p.t, p.def.where)} LIMIT ${K}) x)`);
  return script(d, 'matches', [`${sel.join(' UNION ALL ')};`]);
}

/** Phase 1, a statement of its own: `X<TAB>j<TAB>n` (rows of the table's first SAMPLE_ROWS that already sit in a generator's
 *  reserved space, at most 1). It reads at most that many rows of a table, so it cannot run into the time limit on a big one;
 *  the limit is that a value in a row beyond them is not seen. Counts only. */
export function collisionSql(d: Dialect, gens: readonly { t: Table; def: GenDef }[]): string {
  const sel = gens.map((g, j) => `SELECT 'X', ${j}, (SELECT count(*) FROM (SELECT 1 FROM (SELECT ${d.q(g.def.column)} AS v FROM ${g.t.ref} LIMIT ${SAMPLE_ROWS}) s WHERE ${reservedPredicate(d, g.def)} LIMIT 1) x)`);
  return script(d, 'collision', [`${sel.join(' UNION ALL ')};`]);
}

/** The integer digits (precision minus scale; 99 when the column has no limit) of each decimal column a number generator
 *  writes: `D<TAB>j<TAB>digits`, from the engine's catalog. */
export function precisionSql(d: Dialect, gens: readonly { t: Table; def: GenDef }[]): string {
  const sel = gens.map((g, j) => {
    const dot = g.t.name.lastIndexOf('.');
    const schema = d.engine === 'postgres' ? `'${dot < 0 ? 'public' : g.t.name.slice(0, dot)}'` : 'DATABASE()';
    const where = `table_schema = ${schema} AND table_name = '${g.t.name.slice(dot + 1)}' AND column_name = '${g.def.column}'`;
    return `SELECT 'D', ${j}, (SELECT COALESCE(MAX(numeric_precision - COALESCE(numeric_scale, 0)), 99) FROM information_schema.columns WHERE ${where})`;
  });
  return script(d, 'precision', [`${sel.join(' UNION ALL ')};`]);
}

/** `<tag><TAB>index<TAB>number` for each of `n` indexes, each once: the numbers by index, or null when any line is not of
 *  its exact shape. */
function parseIndexed(stdout: string, tag: string, n: number, digits: number): number[] | null {
  if (stdout.length >= MAX_STDOUT) return null;
  const lines = stdout.split('\n');
  if (lines[lines.length - 1] !== '') return null;
  lines.pop();
  const out: number[] = Array.from({ length: n }, () => -1);
  const number = new RegExp(`^\\d{1,${digits}}$`);
  for (const line of lines) {
    const f = line.split('\t');
    if (f.length !== 3 || f[0] !== tag || !/^\d{1,3}$/.test(f[1]!) || !number.test(f[2]!)) return null;
    const i = Number(f[1]);
    if (i >= n || out[i] !== -1) return null;
    out[i] = Number(f[2]);
  }
  return out.every((v) => v >= 0) ? out : null;
}

/** The counts of a `matches` answer, by pick, or null when any line is not of its exact shape. */
export const parseMatches = (stdout: string, picks: number): number[] | null => parseIndexed(stdout, 'M', picks, 6);

/** The counts of a `collision` answer, by generator, or null. */
export const parseCollisions = (stdout: string, gens: number): number[] | null => parseIndexed(stdout, 'X', gens, 6);

/** The integer digits of a `precision` answer, by generator, or null. */
export const parseDigits = (stdout: string, gens: number): number[] | null => parseIndexed(stdout, 'D', gens, 3);

/** An expression for the text of a primary key's columns, whole, to take a short key of a row. */
const rowKey = (d: Dialect, aliases: string[]): string => (d.engine === 'postgres' ? `md5(${aliases.map((a) => `CAST(${a} AS text)`).join(" || '|' || ")})` : `MD5(CONCAT_WS('|', ${aliases.join(', ')}))`);

/** The hex of a value as the helpers read it: lowercase. Postgres `encode(…, 'hex')` is lowercase already; MySQL and MariaDB
 *  `HEX()` prints uppercase digits, so it is lowered here, in the SQL (the helpers stay strict about the file). */
const lowerHex = (d: Dialect, expr: string): string => (d.engine === 'postgres' ? d.hex(expr) : `LOWER(${d.hex(expr)})`);

/** `SELECT 'V', …` for one pick: one line per picked row and column. The rows are chosen once, in a derived table, and
 *  every column of a row is read from that one choice (a CROSS JOIN with a one-column list of the columns). The
 *  value is the hex of its UTF-8 text, `~` for NULL and `!` for a text of more than MAX_CELL_CHARS characters (the length
 *  is looked at before the hex is made; a value is never cut); the row is told apart by the md5 of its primary key. */
function pickValuesSql(d: Dialect, t: Table, p: PickDef): string {
  const pk = t.cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
  const inner = [...p.columns.map((c, i) => `${d.q(c)} AS c${i + 1}`), ...pk.map((c, i) => `${d.q(c.name)} AS p${i + 1}`)].join(', ');
  const units = p.columns.map((_, i) => (i === 0 ? 'SELECT 1 AS k' : `SELECT ${i + 1}`)).join(' UNION ALL ');
  const name = `CASE u.k ${p.columns.map((c, i) => `WHEN ${i + 1} THEN '${c}'`).join(' ')} END`;
  const cell = (i: number): string => `CASE WHEN s.c${i} IS NULL THEN '~' WHEN ${d.len(d.text(`s.c${i}`))} > ${MAX_CELL_CHARS} THEN '${LONG_MARK}' ELSE ${lowerHex(d, `s.c${i}`)} END`;
  const value = `CASE u.k ${p.columns.map((_, i) => `WHEN ${i + 1} THEN (${cell(i + 1)})`).join(' ')} END`;
  return `SELECT 'V', '${p.name}', ${rowKey(d, pk.map((_, i) => `s.p${i + 1}`))}, ${name}, ${value} FROM (SELECT ${inner} FROM ${t.ref} WHERE ${renderWhere(d, t, p.where)} ORDER BY ${d.rand} LIMIT ${p.n}) s CROSS JOIN (${units}) u;`;
}

const countLineSql = (d: Dialect, t: Table, c: CountDef): string => `SELECT 'N', '${c.name}', (SELECT count(*) FROM ${t.ref}${c.where === null ? '' : ` WHERE ${renderWhere(d, t, c.where)}`});`;

/** Phase 2: the script whose answer is written to `values.tsv`: the picked values, the counts and the generators' run token. */
export function resolveSql(
  d: Dialect,
  picks: readonly { t: Table; def: PickDef }[],
  counts: readonly { t: Table; def: CountDef }[],
  gens: readonly { def: GenDef }[],
  token: string,
): string {
  return script(d, 'resolve', [...picks.map((p) => pickValuesSql(d, p.t, p.def)), ...counts.map((c) => countLineSql(d, c.t, c.def)), ...gens.map((g) => `SELECT 'G', '${g.def.name}', '${g.def.kind}', '${token}';`)]);
}

const quote = (a: string): string => `'${a.replace(/'/g, `'\\''`)}'`;

/** The exit codes of the write script that mean something besides "it failed": the client ran into a statement time limit,
 *  or `values.tsv` came out larger than MAX_VALUES_BYTES (it is removed then). */
const EXIT_TIMEOUT = 124;
const EXIT_TOO_LARGE = 125;

/** The shell script of phase 2, run by `sh -c` inside the database container with the SQL on stdin: whatever an earlier
 *  resolve left is removed first, the reader role's client writes a temp file (its stderr is read into a variable, only to
 *  tell a statement time limit by its fixed error code; it is never printed), which becomes `values.tsv` only when the client
 *  succeeded and the file is within MAX_VALUES_BYTES (`wc -c`, checked here, inside the container), and the one thing printed
 *  is `<lines> <bytes>` of the file. */
export function writeScript(t: DataTarget): string {
  const tmp = `${DATA_DIR}/v.tmp`;
  const out = `${DATA_DIR}/${DATA_FILE}`;
  const client = clientArgv(t).map(quote).join(' ');
  return `rm -f ${tmp} ${out}; if e=$(${client} 2>&1 > ${tmp}); then b=$(( $(wc -c < ${tmp}) )); if [ "$b" -gt ${MAX_VALUES_BYTES} ]; then rm -f ${tmp}; exit ${EXIT_TOO_LARGE}; fi; mv -f ${tmp} ${out} && echo "$(( $(wc -l < ${out}) )) $b"; else rm -f ${tmp}; case "$e" in *57014*|*'ERROR 3024 '*|*'ERROR 1969 '*) exit ${EXIT_TIMEOUT};; esac; exit 1; fi`;
}

/** How many lines `values.tsv` has: at least `min`, at most `max`; the lines of a pick are K rows (or `n`) times its columns. */
export function lineBounds(m: Manifest): { min: number; max: number } {
  const fixed = m.counts.length + m.generate.length;
  return {
    min: fixed + m.picks.reduce((s, p) => s + Math.min(p.n, K) * p.columns.length, 0),
    max: fixed + m.picks.reduce((s, p) => s + p.n * p.columns.length, 0),
  };
}

/** A new run token: 8 lowercase hex digits, the generators' per-run part. */
export const newToken = (): string => randomBytes(4).toString('hex');

// ---- the step ----

export interface ResolveStop {
  stop: string;
  diagnostic: Diag;
}

export const refusedStop = (r: Refusal): ResolveStop => ({
  stop: `${MANIFEST_FILE} is refused at ${r.field}: ${r.reason}`,
  diagnostic: { code: 'data-refused', step: 'resolve', field: r.field, reason: r.reason },
});

const failedStop = (reason?: string): ResolveStop => ({
  stop: `resolving the data of ${MANIFEST_FILE} failed${reason === undefined ? '' : ` (${reason})`}; the database's own answer is never shown`,
  diagnostic: { code: 'data-resolve-failed', step: 'resolve', ...(reason === undefined ? {} : { reason }) },
});

/** Why compose did not give the database or a test service the `data` volume (a sandbox made before M6c), or null. */
export const NO_DATA_VOLUME: ResolveStop = {
  stop: `the sandbox has no data volume (it was set up before ${MANIFEST_FILE} existed): run sandbox-init --force, then sandbox-up; the data of ${MANIFEST_FILE} is not resolved until then`,
  diagnostic: { code: 'data-resolve-failed', step: 'resolve', reason: 'no-data-volume' },
};

/** Whether the manifest asks for nothing: there is then nothing to resolve, and no store is needed. */
export const isEmpty = (m: Manifest): boolean => m.picks.length + m.counts.length + m.generate.length === 0;

/** A volume entry of a service of `compose config --format json` (long form), or of a compose file (`source:target[:mode]`). */
interface Mount {
  type?: string;
  source?: string;
  target?: string;
  /** `rw`, `ro`, or `other` for a mode (or a field) the check does not know. */
  mode: 'rw' | 'ro' | 'other';
}

const NAMED = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function mountsOf(svc: unknown): Mount[] {
  const v = (svc as { volumes?: unknown } | undefined)?.volumes;
  if (!Array.isArray(v)) return [];
  return v.map((x): Mount => {
    if (typeof x === 'string') {
      const parts = x.split(':');
      if (parts.length === 1) return { type: 'volume', target: parts[0], mode: 'rw' };
      const [source, target, mode] = parts;
      const named = source !== undefined && NAMED.test(source);
      return { type: named ? 'volume' : 'bind', source, target, mode: mode === undefined || mode === 'rw' ? 'rw' : mode === 'ro' ? 'ro' : 'other' };
    }
    if (typeof x !== 'object' || x === null) return { mode: 'other' };
    const o = x as { type?: unknown; source?: unknown; target?: unknown; read_only?: unknown };
    return { type: typeof o.type === 'string' ? o.type : undefined, source: typeof o.source === 'string' ? o.source : undefined, target: typeof o.target === 'string' ? o.target : undefined, mode: o.read_only === true ? 'ro' : 'rw' };
  });
}

/** Whether a mount is of the `data` volume, or at the data path or anywhere below it (the target as docker cleans it:
 *  `.`, `..` and doubled slashes resolved): such a mount must be exactly the named volume `data` at the path. */
const touchesData = (m: Mount): boolean => {
  const at = m.target === undefined ? '' : posix.resolve('/', m.target);
  return at === DATA_DIR || at.startsWith(`${DATA_DIR}/`) || m.source === DATA_VOLUME;
};
const isDataVolume = (m: Mount): boolean => m.type === 'volume' && m.source === DATA_VOLUME && m.target === DATA_DIR;

/** The docker name of a top-level volume entry, when it has one; and whether it is an outside volume (`external`). */
const volumeName = (v: unknown): string | undefined => (typeof (v as { name?: unknown } | null)?.name === 'string' ? (v as { name: string }).name : undefined);
const isExternal = (v: unknown): boolean => (v as { external?: unknown } | null)?.external !== undefined && (v as { external?: unknown }).external !== false;

/** Whether the top-level volumes keep `data` as goodboy's own volume: it is not external, and no other key names the same
 *  docker volume (`name: <project>_data` under another key, or the plain name `data`), which would let a service hold it
 *  by a source this check does not read as the data volume. */
function volumesAreOwn(cfg: unknown): boolean {
  const top = (cfg as { volumes?: unknown } | undefined)?.volumes;
  if (top === undefined || top === null) return true;
  if (typeof top !== 'object' || Array.isArray(top)) return false;
  const all = top as Record<string, unknown>;
  if (isExternal(all[DATA_VOLUME])) return false;
  const own = volumeName(all[DATA_VOLUME]);
  return Object.entries(all).every(([key, v]) => key === DATA_VOLUME || (volumeName(v) !== DATA_VOLUME && (own === undefined || volumeName(v) !== own)));
}

/** Whether a service takes mounts from another service (`volumes_from`): goodboy renders none, and one on any service would
 *  give it the mounts of the database (the writable data volume) or of the runner. */
const takesVolumesFrom = (svc: unknown): boolean => {
  const v = (svc as { volumes_from?: unknown } | null | undefined)?.volumes_from;
  return v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0);
};

/** Whether the compose config gives the data volume to exactly the services that should have it: each SQL service and the
 *  reader (it clears the volume) the named volume `data` at `/goodboy-data`, to write; the runner and e2e services, where
 *  there are any, the same to read only; and no other service anything at that path (or below it) or of that volume. A bind
 *  or another volume at the path or below it, a mount of the volume at another path, a service outside those (the app, the
 *  proxy, one added by hand) holding it, a `volumes_from` on any service, or a top-level volume that is external or another
 *  key for the same docker volume makes the check fail: the database container would write values somewhere they must not go. */
export function hasDataVolume(cfg: unknown, sqlServices: readonly string[]): boolean {
  const services = (cfg as { services?: Record<string, unknown> } | undefined)?.services ?? {};
  if (sqlServices.length === 0 || typeof services !== 'object' || services === null) return false;
  if (!volumesAreOwn(cfg)) return false;
  const only = (name: string, mode: 'rw' | 'ro'): boolean => {
    const ms = mountsOf(services[name]).filter(touchesData);
    return ms.length === 1 && isDataVolume(ms[0]!) && ms[0]!.mode === mode;
  };
  for (const name of Object.keys(services)) {
    if (takesVolumesFrom(services[name])) return false;
    if (sqlServices.includes(name) || name === 'reader') {
      if (!only(name, 'rw')) return false;
    } else if (name === 'runner' || name === 'e2e') {
      if (!only(name, 'ro')) return false;
    } else if (mountsOf(services[name]).some(touchesData)) return false;
  }
  return sqlServices.every((s) => services[s] !== undefined);
}

/** The tables and entries of a manifest that fits the schema, and what the answers of phase 1 still have to settle. */
interface Bound {
  picks: { t: Table; def: PickDef }[];
  counts: { t: Table; def: CountDef }[];
  gens: { t: Table; def: GenDef }[];
}
interface Bind extends Bound {
  /** The columns a `=` or `!=` condition tests, each once, with the entry and the leaf that first used it. */
  enums: { t: Table; col: string; base: string; path: string }[];
  /** The generators of kind number on a decimal column: the column's width is asked of the catalog. */
  decimals: { t: Table; def: GenDef }[];
}

/** What a run learns once and keeps: a reset restores the same dump, so phase 1 gives the same answers after each one. */
export interface Memo {
  bound?: Bound;
}

/** Digits a number generator's values need (they run up to 9.1e12). */
const NUMBER_DIGITS = 13;

/** Checks the manifest against the schema: the refusal of the first entry that does not fit, or the tables each entry uses. */
function bind(tables: readonly Table[], m: Manifest): Bind | Refusal {
  const enums: Bind['enums'] = [];
  const seen = new Set<string>();
  const find = (table: string, base: string): Table | Refusal => findTable(tables, table) ?? refuse(`${base}.table`, 'unknown-table');
  const cond = (t: Table, where: Cond | null, base: string): Refusal | null => {
    if (where === null) return null;
    const c = checkCond(t, where);
    if (isRefusal(c)) return refuse(`${base}.${c.field}`, c.reason);
    // a column is looked at once, however many entries test it with `=` or `!=`
    for (const [col, path] of c.enumCols) if (!seen.has(`${t.ref}.${col}`)) {
      seen.add(`${t.ref}.${col}`);
      enums.push({ t, col, base, path });
    }
    return null;
  };
  const picks: Bound['picks'] = [];
  for (const def of m.picks) {
    const base = `picks.${def.name}`;
    const t = find(def.table, base);
    if (isRefusal(t)) return t;
    const bad = cond(t, def.where, base);
    if (bad !== null) return bad;
    for (const [i, c] of def.columns.entries()) if (!t.cols.some((x) => x.name === c)) return refuse(`${base}.columns[${i}]`, 'unknown-column');
    if (!t.cols.some((c) => c.pk > 0)) return refuse(`${base}.table`, 'no-primary-key');
    picks.push({ t, def });
  }
  const counts: Bound['counts'] = [];
  for (const def of m.counts) {
    const base = `counts.${def.name}`;
    const t = find(def.table, base);
    if (isRefusal(t)) return t;
    const bad = cond(t, def.where, base);
    if (bad !== null) return bad;
    counts.push({ t, def });
  }
  const gens: Bound['gens'] = [];
  const decimals: Bind['decimals'] = [];
  for (const def of m.generate) {
    const base = `generate.${def.name}`;
    const t = find(def.table, base);
    if (isRefusal(t)) return t;
    const col = t.cols.find((c) => c.name === def.column);
    if (col === undefined) return refuse(`${base}.column`, 'unknown-column');
    // a number goes into a numeric column; email, phone and text into a text one
    if (col.cls !== (def.kind === 'number' ? 'numeric' : 'text')) return refuse(`${base}.kind`, 'bad-type');
    if (def.kind === 'number') {
      // its values (9e12 and up) need 64 bits: a bigint, or a decimal wide enough (asked of the catalog)
      const type = col.type.toLowerCase();
      if (type === 'decimal' || type === 'numeric') decimals.push({ t, def });
      else if (type !== 'bigint') return refuse(`${base}.kind`, 'too-narrow');
    }
    gens.push({ t, def });
  }
  return { picks, counts, gens, enums, decimals };
}

/** The enum check asks about this many columns in one statement (they share the statement's time limit). */
const ENUM_CHUNK = 25;

/** One statement of phase 1: its stdout, or the stop with the statement's own reason (`<reason>-timeout` for a time limit). */
async function ask(dc: DataCtx, t: DataTarget, sql: string, reason: string): Promise<string | ResolveStop> {
  const r = await runSqlResult(dc, t, sql);
  return r.out ?? failedStop(r.timeout ? `${reason}-timeout` : reason);
}

/** Phase 1: the schema, the enum checks (one statement for all the columns, up to ENUM_CHUNK of them), how many rows each
 *  pick matches, the width of a decimal column a number generator writes, and the rows of a generator's reserved space. Counts
 *  only (stdout is read here); each statement has a reason of its own. */
async function check(dc: DataCtx, t: DataTarget, m: Manifest): Promise<Bound | ResolveStop> {
  const d = dialect(t.engine);
  const cat = await catalog(dc, t);
  if (cat === null) return failedStop('schema');
  const b = bind(cat.tables, m);
  if (isRefusal(b)) return refusedStop(b);
  for (let i = 0; i < b.enums.length; i += ENUM_CHUNK) {
    const chunk = b.enums.slice(i, i + ENUM_CHUNK);
    const out = await ask(dc, t, enumSqlFor(d, chunk), 'enum');
    if (typeof out !== 'string') return out;
    const like = parseEnum(out, chunk.length);
    if (like === null) return failedStop('enum');
    const bad = chunk.findIndex((_, j) => !like[j]);
    if (bad >= 0) return refusedStop(refuse(`${chunk[bad]!.base}.${chunk[bad]!.path}.col`, 'not-enum-like'));
  }
  if (b.picks.length > 0) {
    const out = await ask(dc, t, matchesSql(d, b.picks), 'matches');
    if (typeof out !== 'string') return out;
    const found = parseMatches(out, b.picks.length);
    if (found === null) return failedStop('matches');
    const few = found.findIndex((n) => n < K);
    if (few >= 0) return refusedStop(refuse(`picks.${b.picks[few]!.def.name}.where`, 'too-few-rows'));
  }
  if (b.decimals.length > 0) {
    const out = await ask(dc, t, precisionSql(d, b.decimals), 'precision');
    if (typeof out !== 'string') return out;
    const digits = parseDigits(out, b.decimals.length);
    if (digits === null) return failedStop('precision');
    const narrow = digits.findIndex((n) => n < NUMBER_DIGITS);
    if (narrow >= 0) return refusedStop(refuse(`generate.${b.decimals[narrow]!.def.name}.kind`, 'too-narrow'));
  }
  if (b.gens.length > 0) {
    const out = await ask(dc, t, collisionSql(d, b.gens), 'collision');
    if (typeof out !== 'string') return out;
    const found = parseCollisions(out, b.gens.length);
    if (found === null) return failedStop('collision');
    const hit = found.findIndex((n) => n > 0);
    if (hit >= 0) {
      const field = `generate.${b.gens[hit]!.def.name}`;
      return { stop: `the dump already holds values in the reserved space of ${field}; the generator would collide with them`, diagnostic: { code: 'data-collision', step: 'resolve', field } };
    }
  }
  return { picks: b.picks, counts: b.counts, gens: b.gens };
}

/** Resolves the values of the manifest into the `data` volume: null when it worked, else the step that stops the run.
 *  `token` is the run's generator token (`newToken()`); `memo` keeps phase 1 for the run's next call (the second resolve of a
 *  run that has two suites). Neither phase's output is ever shown. */
export async function resolveValues(dc: DataCtx, m: Manifest, token: string, memo: Memo = {}): Promise<ResolveStop | null> {
  if (isEmpty(m)) return null;
  const t = dc.target;
  if (t === null) return refusedStop({ field: 'store', reason: 'no-sql-store' });
  try {
    if (!(await dc.ready())) return failedStop('compose');
    if (memo.bound === undefined) {
      const c = await check(dc, t, m);
      if ('stop' in c) return c;
      memo.bound = c;
    }
    const b = memo.bound;
    const sql = resolveSql(dialect(t.engine), b.picks, b.counts, b.gens, token);
    const r = await dc.comp(['exec', '-T', t.svc, 'sh', '-c', writeScript(t)], 2 * EXEC_MS, { stdin: sql, max: { stdout: 4096, stderr: 4096 } });
    if (r.timedOut || r.code === EXIT_TIMEOUT) return failedStop('write-timeout');
    if (r.code === EXIT_TOO_LARGE) return failedStop('too-large');
    if (r.error !== undefined || r.code !== 0) return failedStop('write');
    // the one thing of the file goodboy reads: how many lines and bytes it has
    const got = /^\s*(\d{1,9})\s+(\d{1,12})\s*$/.exec(r.stdout);
    const { min, max } = lineBounds(m);
    if (got === null || Number(got[1]) < min || Number(got[1]) > max) return failedStop('lines');
    if (Number(got[2]) > MAX_VALUES_BYTES) return failedStop('too-large');
    return null;
  } catch {
    return failedStop();
  }
}
