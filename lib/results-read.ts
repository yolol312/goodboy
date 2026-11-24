// N4 (plan §20.3): a read-only view of goodboy's result records, `cli.ts results query|show`.
//
// The result guards count any interpreter whose arguments name a result dir as a write
// (lib/role-limits.ts resultDirWrite), so an agent reading a record with a script was denied
// (7 denials in the 2026-10-26 field report). This command takes record names, never paths, so it
// names no result dir, reads only regular files reached through no link, and bounds its output:
// a record or a selection over the byte cap comes back as its keys and their sizes instead.

import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_STATE_BYTES, readRegular } from './safe-read';

export type ResultKind = 'tests' | 'reviews' | 'regression';
export const RESULT_KINDS: readonly ResultKind[] = ['tests', 'reviews', 'regression'];

/** Each kind's dir below the project dir. */
const DIRS: Readonly<Record<ResultKind, readonly string[]>> = {
  tests: ['.claude', 'tests'],
  reviews: ['.claude', 'reviews'],
  regression: ['.claude', 'tests', 'regression'],
};

/** A record name: a file name without `.json`, no path, no leading dot. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 200;
export const DEFAULT_MAX_BYTES = 20_000;
export const MAX_OUTPUT_BYTES = 200_000;
/** Records read by one query at most, however few match. */
const MAX_SCAN = 1000;

export interface ResultRow {
  kind: ResultKind;
  name: string;
  timestamp?: string;
  verdict?: string;
  category?: string;
  /** The first 10 characters of the recorded tree. */
  tree?: string;
  /** How many files the record names as tested or reviewed. */
  files?: number;
  /** Review findings per severity. */
  findings?: Record<string, number>;
  /** Test suites: tests passed and failed, summed. */
  suites?: { passed: number; failed: number };
  /** Regression runs. */
  runs?: number;
}

export type ResultsOutput = { ok: true; [k: string]: unknown } | { ok: false; error: string };

function isDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The record names of a kind (names are ISO timestamps). Nothing when a dir on the way is a link (`.claude`,
 *  `.claude/tests` for the regression kind, the kind's own dir); a record that is a link is skipped when read. */
function namesOf(root: string, kind: ResultKind): string[] {
  const parts = DIRS[kind];
  for (let i = 1; i <= parts.length; i++) if (!isDir(join(root, ...parts.slice(0, i)))) return [];
  const dir = join(root, ...parts);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((f) => f.endsWith('.json') && NAME.test(f.slice(0, -'.json'.length))).map((f) => f.slice(0, -'.json'.length));
}

/** A name's sort key: regression records write the milliseconds after a `-` (`…T05-29-31-500Z`), the others after
 *  a `.` (`…T01-29-43.199Z`); one spelling orders records of every kind by time. */
const sortKey = (name: string): string => name.replace(/^(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d)-(\d{3}Z)$/, '$1.$2');

/** A record as a JSON object, or null (absent, a link, not regular, too large, not JSON, not an object). */
function readRecord(root: string, kind: ResultKind, name: string): Record<string, unknown> | null {
  const read = readRegular(join(root, ...DIRS[kind], `${name}.json`), MAX_STATE_BYTES, true);
  if (typeof read === 'string') return null;
  try {
    const v: unknown = JSON.parse(read.text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A row's text fields are at most this long: a record is written by an agent, and a summary stays a summary. */
const MAX_ROW_TEXT = 200;
/** Keys listed for an output over the byte cap at most. */
const MAX_KEYS = 200;
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v.slice(0, MAX_ROW_TEXT) : undefined);

function rowOf(kind: ResultKind, name: string, rec: Record<string, unknown>): ResultRow {
  const row: ResultRow = { kind, name };
  const timestamp = str(rec.timestamp);
  const verdict = str(rec.verdict);
  const category = str(rec.category);
  const tree = str(rec.tree);
  if (timestamp !== undefined) row.timestamp = timestamp;
  if (verdict !== undefined) row.verdict = verdict;
  if (category !== undefined) row.category = category;
  if (tree !== undefined) row.tree = tree.slice(0, 10);
  const files = Array.isArray(rec.tested_files) ? rec.tested_files : Array.isArray(rec.reviewed_files) ? rec.reviewed_files : null;
  if (files !== null) row.files = files.length;
  if (Array.isArray(rec.findings)) {
    // Known severities by name, anything else as `other`: no key comes from the record.
    const by: Record<string, number> = {};
    for (const f of rec.findings) {
      const sev = f !== null && typeof f === 'object' ? (f as Record<string, unknown>).severity : undefined;
      const key = typeof sev === 'string' && SEVERITIES.has(sev) ? sev : 'other';
      by[key] = (by[key] ?? 0) + 1;
    }
    row.findings = by;
  }
  if (Array.isArray(rec.suites)) {
    let passed = 0;
    let failed = 0;
    for (const s of rec.suites) {
      if (s === null || typeof s !== 'object') continue;
      const o = s as Record<string, unknown>;
      if (typeof o.passed === 'number' && Number.isFinite(o.passed)) passed += o.passed;
      if (typeof o.failed === 'number' && Number.isFinite(o.failed)) failed += o.failed;
    }
    row.suites = { passed, failed };
  }
  if (Array.isArray(rec.runs)) row.runs = rec.runs.length;
  return row;
}

export interface ResultQuery {
  kinds: readonly ResultKind[];
  verdict?: string;
  /** Records whose `timestamp` is at or after this time (ms); a record without one is left out. */
  since?: number;
  limit: number;
}

/** The newest records that match, summarized. `more`: further matches exist past `limit`;
 *  `capped`: the scan stopped at MAX_SCAN records, so older ones were not looked at. */
export function queryResults(root: string, q: ResultQuery): { rows: ResultRow[]; more: boolean; capped: boolean } {
  const all = q.kinds.flatMap((kind) => namesOf(root, kind).map((name) => ({ kind, name })));
  const keyed = all.map((r) => ({ ...r, key: sortKey(r.name) }));
  keyed.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  const rows: ResultRow[] = [];
  let scanned = 0;
  for (const { kind, name } of keyed) {
    if (scanned >= MAX_SCAN) return { rows, more: false, capped: true };
    scanned++;
    const rec = readRecord(root, kind, name);
    if (rec === null) continue;
    if (q.verdict !== undefined && rec.verdict !== q.verdict) continue;
    if (q.since !== undefined) {
      const t = Date.parse(str(rec.timestamp) ?? '');
      if (!Number.isFinite(t) || t < q.since) continue;
    }
    if (rows.length === q.limit) return { rows, more: true, capped: false };
    rows.push(rowOf(kind, name, rec));
  }
  return { rows, more: false, capped: false };
}

/** The value at a dotted path (`coverage.changed.covered`, `suites.0.passed`): own keys only, array items by index. */
function valueAt(rec: unknown, path: string): { found: boolean; value?: unknown } {
  let cur: unknown = rec;
  for (const part of path.split('.')) {
    if (Array.isArray(cur)) {
      if (!/^(?:0|[1-9]\d{0,8})$/.test(part) || Number(part) >= cur.length) return { found: false };
      cur = cur[Number(part)];
    } else if (cur !== null && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, part)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: cur };
}

const bytesOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v) ?? 'null', 'utf8');

/** One record, whole or by `fields`. Over `maxBytes`, the record's (or the selection's) keys with their sizes
 *  in bytes, so the caller can ask for less. */
export function showResult(root: string, name: string, opts: { kind?: ResultKind; fields?: readonly string[]; maxBytes: number }): ResultsOutput {
  if (!NAME.test(name)) return { ok: false, error: `results show: "${name}" is no record name (the file name without .json, no path)` };
  const kinds = (opts.kind ? [opts.kind] : RESULT_KINDS).filter((k) => namesOf(root, k).includes(name));
  if (kinds.length === 0) return { ok: false, error: `results show: no record ${name}${opts.kind ? ` in ${opts.kind}` : ''} (see: results query)` };
  if (kinds.length > 1) return { ok: false, error: `results show: ${name} is in ${kinds.join(' and ')}; pass --kind` };
  const kind = kinds[0]!;
  const rec = readRecord(root, kind, name);
  if (rec === null) return { ok: false, error: `results show: ${kind}/${name}.json is not a readable JSON object` };
  // Objects with no prototype: a key the record holds (`__proto__` is an own key after JSON.parse) is only a key.
  let body: Record<string, unknown> = rec;
  const missing: string[] = [];
  if (opts.fields && opts.fields.length > 0) {
    body = Object.create(null) as Record<string, unknown>;
    for (const f of opts.fields) {
      const at = valueAt(rec, f);
      if (at.found) body[f] = at.value;
      else missing.push(f);
    }
  }
  const size = bytesOf(body);
  if (size > opts.maxBytes) {
    // The keys and their sizes, bounded too: at most MAX_KEYS keys, each name cut to MAX_ROW_TEXT.
    const keys = Object.create(null) as Record<string, number>;
    const entries = Object.entries(body);
    for (const [k, v] of entries.slice(0, MAX_KEYS)) keys[k.slice(0, MAX_ROW_TEXT)] = bytesOf(v);
    const omitted = entries.length - Math.min(entries.length, MAX_KEYS);
    return {
      ok: true, kind, name, truncated: true, bytes: size, max_bytes: opts.maxBytes, keys,
      ...(omitted > 0 ? { keys_omitted: omitted } : {}),
      ...(missing.length > 0 ? { missing } : {}),
      hint: 'pass --fields with the keys you need, or a larger --max-bytes',
    };
  }
  return { ok: true, kind, name, ...(opts.fields && opts.fields.length > 0 ? { fields: body } : { record: body }), ...(missing.length > 0 ? { missing } : {}) };
}

const USAGE_TEXT =
  'results query [--kind tests|reviews|regression[,…]] [--verdict <v>] [--since <ISO time>] [--limit N] | ' +
  'results show <name> [--kind tests|reviews|regression] [--fields a,b.c] [--max-bytes N]';

function opt(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function intIn(v: string | undefined, fallback: number, min: number, max: number): number | null {
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function kindsOf(v: string | undefined): ResultKind[] | null {
  if (v === undefined) return [...RESULT_KINDS];
  const ks = v.split(',').map((s) => s.trim());
  return ks.length > 0 && ks.every((k) => (RESULT_KINDS as readonly string[]).includes(k)) ? (ks as ResultKind[]) : null;
}

/** `cli.ts results <query|show> …` against the project dir `root`: the JSON to print. */
export function runResults(root: string, args: readonly string[]): ResultsOutput {
  const sub = args[0];
  if (sub === 'query') {
    const kinds = kindsOf(opt(args, '--kind'));
    if (kinds === null) return { ok: false, error: `results query: --kind takes tests, reviews or regression (comma-separated). ${USAGE_TEXT}` };
    const limit = intIn(opt(args, '--limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
    if (limit === null) return { ok: false, error: `results query: --limit takes 1 to ${MAX_LIMIT}` };
    const sinceText = opt(args, '--since');
    const since = sinceText === undefined ? undefined : Date.parse(sinceText);
    if (since !== undefined && !Number.isFinite(since)) return { ok: false, error: 'results query: --since takes an ISO time (2026-11-23T01:00:00Z)' };
    const verdict = opt(args, '--verdict');
    const { rows, more, capped } = queryResults(root, { kinds, limit, ...(verdict !== undefined ? { verdict } : {}), ...(since !== undefined ? { since } : {}) });
    return { ok: true, rows, more, ...(capped ? { capped: true } : {}) };
  }
  if (sub === 'show') {
    const name = args[1];
    if (name === undefined || name.startsWith('--')) return { ok: false, error: `results show: name the record. ${USAGE_TEXT}` };
    const kindText = opt(args, '--kind');
    if (kindText !== undefined && !(RESULT_KINDS as readonly string[]).includes(kindText)) return { ok: false, error: 'results show: --kind takes tests, reviews or regression' };
    const maxBytes = intIn(opt(args, '--max-bytes'), DEFAULT_MAX_BYTES, 1, MAX_OUTPUT_BYTES);
    if (maxBytes === null) return { ok: false, error: `results show: --max-bytes takes 1 to ${MAX_OUTPUT_BYTES}` };
    const fieldsText = opt(args, '--fields');
    const fields = fieldsText === undefined ? undefined : fieldsText.split(',').map((s) => s.trim()).filter((s) => s !== '');
    if (fields !== undefined && fields.length === 0) return { ok: false, error: 'results show: --fields takes a comma-separated list of keys' };
    return showResult(root, name, { maxBytes, ...(kindText !== undefined ? { kind: kindText as ResultKind } : {}), ...(fields !== undefined ? { fields } : {}) });
  }
  return { ok: false, error: `results: ${USAGE_TEXT}` };
}
