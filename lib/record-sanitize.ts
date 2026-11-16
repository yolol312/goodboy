// What a record keeps of the text it was given (track M, M6d). `test-write`, `review-write` and
// `regression` write records under `.claude/` that a user may track or force-add, so every string and
// every object key of a record passes through `redactText` (lib/pii-patterns.ts) on its way to disk,
// except the fields the gates compare, which stay byte for byte. Those fields hold no free text: each is
// one goodboy makes (`computed`), an identifier or enum the writer checks (`ids`), or a path the writer
// scans and refuses (`paths`). Every other string is display text.
//
// Fail closed: a value this cannot walk (a function, a cycle, a class instance, a tree deeper than
// MAX_DEPTH) is replaced by the withheld text, never passed through. Keys named `__proto__` or
// `constructor` are copied as plain own properties. A run on real data (lib/sandbox-boundary.ts)
// records only the M6a result: with `withhold`, every display string becomes WITHHELD_TEXT and so does a
// command that is not the `sandbox-run` invocation of that run.
//
// The lists are typed by the record they describe (`FieldPath`): a path that is not a field of the record
// does not compile, and tests/m6d-schema.test.ts walks a maximal record of each type and fails when a
// string field is in no list, so a field added later is decided on, not silently display text.

import { findSensitive, redactText } from './pii-patterns';
import type { ReviewResult, TestResult } from './types';

/** What a display string becomes in the record of a real-data run (a non-empty text of 25 characters,
 *  so the rules "reason of 15 characters" and "output not empty" still hold). */
export const WITHHELD_TEXT = '[withheld: real-data run]';

/** What an identifier field (a category, an acceptance id, a dimension, an enum value) may be. */
export const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

const MAX_DEPTH = 40;

/** The dotted paths of the fields of `T` (`acceptance.[].id`: `[]` stands for any array element); a map
 *  with free keys has the path of the map itself and none below it. */
export type FieldPath<T> = T extends readonly (infer U)[]
  ? '[]' | `[].${FieldPath<U>}`
  : T extends object
    ? string extends keyof T
      ? never
      : { [K in keyof T & string]-?: K | `${K}.${FieldPath<NonNullable<T[K]>>}` }[keyof T & string]
    : never;

/** How a record's fields are treated, by path. A path names a whole subtree for `computed` and `paths`.
 *  - `computed`: made by goodboy (a timestamp, an object id, a count, the sandbox check); kept as is.
 *  - `ids`: an identifier or enum; kept as is, and the writer refuses a value that is not an identifier.
 *  - `paths`: a path or file name the gates compare; kept as is, and the writer refuses a value, or a key,
 *    that holds personal data (a file genuinely named like a phone number cannot be recorded).
 *  - `commands`: a string redacted by span (the program and the goodboy subcommand readers parse stay
 *    intact); withheld in the record of a real-data run unless it is that run's own `sandbox-run` line.
 *  - `display`: free text, redacted by span, withheld in the record of a real-data run. Also what any
 *    field in no list is; listing it states that it was decided on. */
export interface SchemaLists {
  computed: readonly string[];
  ids: readonly string[];
  paths: readonly string[];
  commands: readonly string[];
  display: readonly string[];
}
export type RecordSchema<T> = { [K in keyof SchemaLists]: readonly FieldPath<T>[] };

type Kind = keyof SchemaLists;
const KEPT: ReadonlySet<Kind> = new Set<Kind>(['computed', 'ids', 'paths']);

interface Node {
  kind: Kind | null;
  kids: Map<string, Node>;
}

const trieCache = new WeakMap<SchemaLists, Node>();

function trie(schema: SchemaLists): Node {
  const hit = trieCache.get(schema);
  if (hit !== undefined) return hit;
  const root: Node = { kind: null, kids: new Map() };
  for (const kind of ['computed', 'ids', 'paths', 'commands', 'display'] as const) {
    for (const path of schema[kind]) {
      let n = root;
      for (const seg of path.split('.')) {
        let k = n.kids.get(seg);
        if (k === undefined) {
          k = { kind: null, kids: new Map() };
          n.kids.set(seg, k);
        }
        n = k;
      }
      if (n.kind !== null) throw new Error(`record schema: ${path} is listed twice`);
      n.kind = kind;
    }
  }
  trieCache.set(schema, root);
  return root;
}

function put(out: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  else out[key] = value;
}

function plain(v: object): boolean {
  const proto = Object.getPrototypeOf(v) as unknown;
  return Array.isArray(v) || proto === Object.prototype || proto === null;
}

export interface SanitizeOptions {
  /** Real-data run: display strings become WITHHELD_TEXT. */
  withhold?: boolean;
  /** With `withhold`: the commands that stay (redacted by span); every other command is withheld. */
  keepCommand?: (command: string) => boolean;
}

interface Ctx {
  withhold: boolean;
  keepCommand: (command: string) => boolean;
  ancestors: Set<object>;
}

/** A copy of `v`. `node` is where `v` stands in the schema (null: nowhere, so display text); `exact`: keep text. */
function walk(v: unknown, node: Node | null, exact: boolean, depth: number, ctx: Ctx): unknown {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (exact) return v;
    if (node?.kind === 'commands') return ctx.withhold && !ctx.keepCommand(v) ? WITHHELD_TEXT : redactText(v);
    return ctx.withhold ? WITHHELD_TEXT : redactText(v);
  }
  if (v === undefined) return undefined;
  if (typeof v !== 'object') return WITHHELD_TEXT;
  if (depth >= MAX_DEPTH || ctx.ancestors.has(v) || !plain(v)) return WITHHELD_TEXT;
  ctx.ancestors.add(v);
  try {
    if (Array.isArray(v)) {
      const kid = node?.kids.get('[]') ?? null;
      const inExact = exact || (kid?.kind != null && KEPT.has(kid.kind));
      const out: unknown[] = [];
      for (let i = 0; i < v.length; i++) out.push(walk(v[i], kid, inExact, depth + 1, ctx));
      return out;
    }
    const out: Record<string, unknown> = {};
    const used = new Set<string>();
    for (const k of Object.keys(v)) {
      const kid = node?.kids.get(k) ?? null;
      const keep = exact || (kid?.kind != null && KEPT.has(kid.kind));
      const base = keep ? k : redactText(k);
      // two keys that redact to one must not overwrite each other
      let key = base;
      for (let n = 2; used.has(key); n++) key = `${base}#${n}`;
      used.add(key);
      put(out, key, walk((v as Record<string, unknown>)[k], kid, keep, depth + 1, ctx));
    }
    return out;
  } catch {
    // a getter that throws, a proxy: not a value goodboy can vouch for
    return WITHHELD_TEXT;
  } finally {
    ctx.ancestors.delete(v);
  }
}

/** A deep copy of `record` for the disk: strings and keys redacted except the schema's kept fields; with
 *  `withhold`, display strings replaced by WITHHELD_TEXT. The input is not changed. The copy is not a `T`:
 *  a subtree that cannot be walked became a string. */
export function sanitizeRecord(record: unknown, schema: SchemaLists, opts: SanitizeOptions = {}): unknown {
  return walk(record, trie(schema), false, 0, { withhold: opts.withhold === true, keepCommand: opts.keepCommand ?? (() => false), ancestors: new Set() });
}

/** One field a record must not carry: where it is (never its value) and why. */
export interface FieldProblem {
  path: string;
  why: string;
}

/** The identifier fields that are not identifiers, and the identifier and path fields (their strings and their map
 *  keys) that hold personal data, as a list of where and why, never of the value. Run by the writers of `test-write` and
 *  `review-write` before anything is written; empty when the record may be written. */
export function checkRecordFields(record: unknown, schema: SchemaLists): FieldProblem[] {
  const out: FieldProblem[] = [];
  const kinds = (s: string): string => [...new Set(findSensitive(s).map((x) => x.kind))].join('+');
  const visit = (v: unknown, node: Node | null, mode: 'ids' | 'paths' | null, path: string, depth: number): void => {
    if (depth >= MAX_DEPTH) {
      if (mode !== null) out.push({ path, why: 'nested too deep to check' });
      return;
    }
    if (typeof v === 'string') {
      if (mode === 'ids' && !ID_RE.test(v)) out.push({ path, why: 'not an identifier (letters, digits and _ . : - only, at most 64)' });
      else if (mode !== null) {
        // an identifier is not redacted either, and its characters fit a phone, a card or a resident number
        const k = kinds(v);
        if (k !== '') out.push({ path, why: `holds a ${k}` });
      }
      return;
    }
    if (v === null || typeof v !== 'object') {
      if (mode === 'ids' && v !== undefined) out.push({ path, why: 'not an identifier (letters, digits and _ . : - only, at most 64)' });
      return;
    }
    if (mode === 'ids') {
      out.push({ path, why: 'not an identifier (letters, digits and _ . : - only, at most 64)' });
      return;
    }
    if (Array.isArray(v)) {
      const kid = node?.kids.get('[]') ?? null;
      const m = mode ?? (kid?.kind === 'ids' || kid?.kind === 'paths' ? kid.kind : null);
      v.forEach((x, i) => visit(x, kid, m, `${path}[${i}]`, depth + 1));
      return;
    }
    for (const k of Object.keys(v)) {
      const kid = node?.kids.get(k) ?? null;
      const m = mode ?? (kid?.kind === 'ids' || kid?.kind === 'paths' ? kid.kind : null);
      if (mode === 'paths') {
        const kk = kinds(k);
        if (kk !== '') out.push({ path: `${path}.{a key}`, why: `holds a ${kk}` });
      }
      visit((v as Record<string, unknown>)[k], kid, m, mode === 'paths' ? `${path}.${kid !== null ? k : '{a key}'}` : path === '' ? k : `${path}.${k}`, depth + 1);
    }
  };
  visit(record, trie(schema), null, '', 0);
  return out;
}

/** `test-write`. Everything not listed (a number, a boolean, an unknown field) is not text the gates read. */
export const TEST_SCHEMA: RecordSchema<TestResult> = {
  computed: ['timestamp', 'commit', 'tree', 'trees', 'extra_blobs', 'by_type', 'sandbox', 'coverage.changed.base', 'coverage.changed.[].base'],
  ids: [
    'category', 'verdict', 'environment.mode', 'suites.[].type', 'acceptance.[].id', 'prototype_diff.mismatches.[].severity', 'coverage.status',
    'coverage.changed.base_source', 'coverage.changed.[].base_source',
  ],
  paths: [
    'tested_files.[]', 'test_files.[]', 'worktree', 'repo', 'acceptance.[].test', 'acceptance.[].mutation.file',
    'coverage.changed.files', 'coverage.changed.diff_lines', 'coverage.changed.files_without_executed_changes.[]', 'coverage.changed.in_report.[]', 'coverage.changed.top',
    'coverage.changed.[].files', 'coverage.changed.[].diff_lines', 'coverage.changed.[].files_without_executed_changes.[]', 'coverage.changed.[].in_report.[]', 'coverage.changed.[].top',
    'coverage.subprocess.[].file', 'coverage.subprocess.[].test', 'coverage.subprocess.[].top',
  ],
  commands: ['environment.command', 'suites.[].command', 'acceptance.[].red.command', 'acceptance.[].green.command', 'acceptance.[].mutation.command', 'blocked.evidence.[].command'],
  display: [
    'environment.services.[]', 'environment.evidence', 'suites.[].name', 'suites.[].output', 'acceptance.[].description', 'acceptance.[].red.output', 'acceptance.[].green.output',
    'acceptance.[].mutation.output', 'prototype_diff.prototype_path', 'prototype_diff.mismatches.[].selector', 'prototype_diff.mismatches.[].issue', 'blocked.reason', 'blocked.evidence.[].output',
    'coverage.tool', 'coverage.reason', 'notes',
  ],
};

/** `review-write`. */
export const REVIEW_SCHEMA: RecordSchema<ReviewResult> = {
  computed: ['timestamp', 'tree', 'trees', 'extra_blobs'],
  ids: ['category', 'verdict', 'dimensions_checked.[]', 'findings.[].severity', 'findings.[].source', 'codex.status'],
  paths: ['reviewed_files.[]', 'findings.[].file'],
  commands: [],
  display: ['findings.[].issue', 'findings.[].probe', 'unknown_assumptions_checked.[].assumption', 'unknown_assumptions_checked.[].note', 'codex.reason', 'codex.output'],
};
