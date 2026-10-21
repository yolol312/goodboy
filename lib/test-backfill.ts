// Test backfill state (track L, L3; plan §18): `.goodboy/test-backfill.json` in the project.
// It holds the survey's untested targets with what became of each, and the batches handed
// out. The backfill-tests skill changes it through `cli.ts backfill-*` only, each change under
// a lock. A target is done on evidence (evidenceFor): the Stop's test gate skips a turn that
// changed only tests, so the mark checks what the gate would.

import { closeSync, existsSync, lstatSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { suiteRan } from './existing-tests';
import { MAX_STATE_BYTES, readRegular } from './safe-read';
import { isTestCode, type SurveyTarget } from './test-survey';
import { recordStandsAlone, testerFor } from './test-types';
import { findRecentTestFiles } from './test-validator';
import { isTrustedTimestamp } from './trusted-time';
import type { TestResult } from './types';

export const BACKFILL_DIR = '.goodboy';
export const BACKFILL_FILE = join(BACKFILL_DIR, 'test-backfill.json');
const LOCK_FILE = join(BACKFILL_DIR, 'test-backfill.lock');
export const DEFAULT_BATCH = 5;
const MAX_BATCH = 20;
/** More targets than this are cut (the lowest ranked): the file stays small. */
export const MAX_TARGETS = 2000;
/** How far back the records are read for evidence (the Stop prunes older ones anyway). */
const RECORD_WINDOW_MIN = 7 * 24 * 60;
const LOCK_WAIT_MS = 10_000;
/** A lock older than this was left by a process that died. */
const LOCK_STALE_MS = 60_000;

export type TargetStatus = 'todo' | 'done' | 'skipped' | 'suspect';
const STATUSES: readonly TargetStatus[] = ['todo', 'done', 'skipped', 'suspect'];
const KINDS: readonly SurveyTarget['kind'][] = ['boundary', 'ui', 'code'];
const NEEDS: readonly string[] = ['any', 'integration', 'ui'];

export interface BackfillTarget extends SurveyTarget {
  status: TargetStatus;
  /** The batch that handed it out. */
  batch?: number;
  /** done and suspect: the test files that pin it, repo-relative. */
  tests?: string[];
  /** skipped: why; suspect: what looks wrong (the test keeps the current behavior). */
  note?: string;
  at?: string;
}

export interface BackfillState {
  schema: 1;
  created: string;
  updated: string;
  targets: BackfillTarget[];
  batches: { n: number; at: string; targets: string[] }[];
}

const posixRel = (root: string, abs: string) => relative(root, abs).split(sep).join('/');
const inside = (r: string) => r !== '' && r !== '..' && !r.startsWith('../') && !isAbsolute(r);
/** A path as the state names it: repo-relative with `/`, from a repo-relative or absolute one
 *  (`backfill-next` prints them repo-relative, whatever the shell's dir). */
export const repoRel = (root: string, f: string) => posixRel(root, resolve(root, f));
const posInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0;
const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');

export function emptyBackfill(now = new Date().toISOString()): BackfillState {
  return { schema: 1, created: now, updated: now, targets: [], batches: [] };
}

function validTarget(t: unknown): boolean {
  const x = t as Partial<BackfillTarget> | null;
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof x.rel === 'string' &&
    STATUSES.includes(x.status as TargetStatus) &&
    KINDS.includes(x.kind as SurveyTarget['kind']) &&
    Array.isArray(x.needs) &&
    x.needs.every((n) => NEEDS.includes(n)) &&
    typeof x.why === 'string' &&
    typeof x.bytes === 'number' &&
    (x.batch === undefined || posInt(x.batch)) &&
    (x.tests === undefined || strings(x.tests)) &&
    (x.note === undefined || typeof x.note === 'string')
  );
}

/** The state, an empty one when there is none, or an Error to show (never overwritten then). */
export function readBackfill(root: string): BackfillState | Error {
  const p = join(root, BACKFILL_FILE);
  const r = readRegular(p, MAX_STATE_BYTES, true);
  if (r === 'absent') return emptyBackfill();
  if (r === 'refused') return new Error(`${p} is not a regular file of at most ${MAX_STATE_BYTES} bytes; move it away`);
  try {
    const s = JSON.parse(r.text) as BackfillState;
    const ok =
      s?.schema === 1 &&
      typeof s.created === 'string' &&
      Array.isArray(s.targets) &&
      s.targets.every(validTarget) &&
      Array.isArray(s.batches) &&
      s.batches.every((b) => posInt(b?.n) && typeof b.at === 'string' && strings(b.targets));
    if (ok) return s;
  } catch {
    // below
  }
  return new Error(`${p} is not a backfill state goodboy wrote; move it away to start over`);
}

/** The state dir, made when missing; an Error when it is a link (a write would land outside
 *  the project) or not a dir. */
function stateDir(root: string): string | Error {
  const d = join(root, BACKFILL_DIR);
  try {
    const st = lstatSync(d);
    if (st.isSymbolicLink() || !st.isDirectory()) return new Error(`${d} is a link or not a directory; goodboy writes its state only into a real directory`);
  } catch {
    mkdirSync(d, { recursive: true });
  }
  return d;
}

export function writeBackfill(root: string, s: BackfillState, now = new Date().toISOString()): string {
  const d = stateDir(root);
  if (d instanceof Error) throw d;
  const p = join(root, BACKFILL_FILE);
  s.updated = now;
  const tmp = `${p}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { flag: 'wx' });
  renameSync(tmp, p);
  return p;
}

/** Runs `fn` holding the state's lock (an exclusive file), so that marks run in parallel do
 *  not lose each other's changes. A lock older than a minute is taken over. */
export function withBackfillLock<T>(root: string, fn: () => T): T {
  const d = stateDir(root);
  if (d instanceof Error) throw d;
  const lock = join(root, LOCK_FILE);
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - lstatSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
      } catch {
        // gone meanwhile: try again
      }
      if (Date.now() > until) throw new Error(`${lock} is held by another backfill command; try again`);
      Bun.sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // already gone
    }
  }
}

/** A fresh survey merged into the state. A known target keeps its status, batch and evidence;
 *  a `todo` one takes the survey's ranking and reasons. A `todo` target the survey no longer
 *  lists (now named by a test, or gone) is dropped unless a batch handed it out; the others
 *  stay as history. */
export function mergeSurvey(s: BackfillState, surveyed: readonly SurveyTarget[]): { state: BackfillState; added: number; dropped: number } {
  const prev = new Map(s.targets.map((t) => [t.rel, t]));
  const seen = new Set<string>();
  const targets: BackfillTarget[] = [];
  let added = 0;
  for (const t of surveyed.slice(0, MAX_TARGETS)) {
    seen.add(t.rel);
    const old = prev.get(t.rel);
    if (!old) added++;
    targets.push(old && old.status !== 'todo' ? old : { ...t, status: 'todo', ...(old?.batch !== undefined ? { batch: old.batch } : {}) });
  }
  let dropped = 0;
  for (const t of s.targets) {
    if (seen.has(t.rel)) continue;
    if (t.status === 'todo' && t.batch === undefined) dropped++;
    else targets.push(t);
  }
  return { state: { ...s, targets }, added, dropped };
}

export interface Batch {
  n: number;
  resumed: boolean;
  targets: (BackfillTarget & { tester: 'test-unit' | 'test-ui' | 'test-lead' })[];
}

const testerOf = (t: SurveyTarget) => {
  const types = t.needs.filter((x) => x !== 'any') as ('integration' | 'ui')[];
  return testerFor([types.length > 0 ? { abs: '', rel: t.rel, types, why: {} } : null]);
};

/** The next batch: the open targets of the last batch first (a batch is finished only when
 *  each of its targets is marked), else the next `size` `todo` targets in rank order, or the
 *  `pick`ed ones. */
export function nextBatch(s: BackfillState, size = DEFAULT_BATCH, pick: readonly string[] = [], now = new Date().toISOString()): Batch | Error {
  const n = Math.min(Math.max(1, Math.floor(size)), MAX_BATCH);
  const last = s.batches[s.batches.length - 1];
  const open = last ? s.targets.filter((t) => t.status === 'todo' && t.batch === last.n) : [];
  if (open.length > 0) {
    if (pick.length > 0) return new Error(`batch ${last!.n} is still open (${open.map((t) => t.rel).join(', ')}); mark each of its targets first`);
    return { n: last!.n, resumed: true, targets: open.map((t) => ({ ...t, tester: testerOf(t) })) };
  }
  let chosen: BackfillTarget[];
  if (pick.length > 0) {
    chosen = [];
    for (const rel of pick) {
      const t = s.targets.find((x) => x.rel === rel);
      if (!t) return new Error(`${rel} is not a target; run backfill-plan, or pick one of its targets`);
      if (t.status !== 'todo') return new Error(`${rel} is ${t.status}, not todo`);
      if (!chosen.includes(t)) chosen.push(t);
    }
    if (chosen.length > MAX_BATCH) return new Error(`at most ${MAX_BATCH} targets in a batch`);
  } else chosen = s.targets.filter((t) => t.status === 'todo').slice(0, n);
  if (chosen.length === 0) return new Error('no todo targets left; run backfill-plan to survey again');
  const b = s.batches.length > 0 ? s.batches[s.batches.length - 1]!.n + 1 : 1;
  for (const t of chosen) t.batch = b;
  s.batches.push({ n: b, at: now, targets: chosen.map((t) => t.rel) });
  return { n: b, resumed: false, targets: chosen.map((t) => ({ ...t, tester: testerOf(t) })) };
}

/** When a file last changed: its modification or status change time, whichever is later (a
 *  reset modification time does not make an old record fresh). */
function changedAt(abs: string): number {
  const st = statSync(abs);
  return Math.max(st.mtimeMs, st.ctimeMs);
}

/** Why `tests` do not yet prove `target`, or null. The evidence is passing layer-1 records, one
 *  or several (a test-lead's members record their own), each standing on its own (no failing
 *  suite, its test files exist, its evidence holds, no do-nothing pattern) and naming the
 *  target among its tested files:
 *  - each test is in such a record made after the test last changed, with a passing suite that
 *    ran it;
 *  - one such record, made after every test last changed, has an acceptance entry whose
 *    mutation of the target was detected.
 *  Paths in a record resolve from the project root. */
export function evidenceProblem(projectDir: string, root: string, target: string, tests: readonly string[], records?: TestResult[]): string | null {
  const all = records ?? findRecentTestFiles(join(projectDir, '.claude', 'tests'), RECORD_WINDOW_MIN);
  const abs = (f: string) => resolve(root, f);
  const targetAbs = abs(target);
  const fit = all.filter(
    (r) =>
      r.verdict === 'pass' &&
      isTrustedTimestamp(r.timestamp) &&
      (r.tested_files ?? []).some((f) => typeof f === 'string' && abs(f) === targetAbs) &&
      recordStandsAlone(r),
  );
  if (fit.length === 0) return `no passing layer-1 record that stands on its own names ${target} in tested_files`;
  const at = (r: TestResult) => Date.parse(r.timestamp);
  let newest = 0;
  for (const t of tests) {
    const changed = changedAt(abs(t));
    newest = Math.max(newest, changed);
    const ran = fit.some(
      (r) =>
        at(r) >= changed &&
        (r.test_files ?? []).some((f) => typeof f === 'string' && abs(f) === abs(t)) &&
        (r.suites ?? []).some((s) => s.failed === 0 && s.passed > 0 && typeof s.command === 'string' && suiteRan(s.command, t, root)),
    );
    if (!ran) return `no such record, made after ${t} last changed, lists it in test_files with a passing suite that ran it`;
  }
  const mutated = fit.some(
    (r) =>
      at(r) >= newest &&
      (r.acceptance ?? []).some((a) => a?.mutation?.detected === true && typeof a.mutation.file === 'string' && repoRel(root, a.mutation.file) === target),
  );
  if (!mutated) return `no such record, made after the tests last changed, has an acceptance entry whose mutation of ${target} the tests detected (mutation.file: "${target}")`;
  return null;
}

export interface MarkInput {
  rel: string;
  status: Exclude<TargetStatus, 'todo'>;
  tests: string[];
  note?: string;
}

/** Records an outcome. done and suspect need the tests (test files in the repo) and their
 *  evidence (evidenceProblem); suspect and skipped need a note. */
export function markTarget(s: BackfillState, projectDir: string, root: string, m: MarkInput, now = new Date().toISOString(), records?: TestResult[]): Error | null {
  const rel = repoRel(root, m.rel);
  const t = s.targets.find((x) => x.rel === rel);
  if (!t) return new Error(`${m.rel} is not a target`);
  const note = (m.note ?? '').trim();
  if ((m.status === 'skipped' || m.status === 'suspect') && note === '') return new Error(`${m.status} needs --note: ${m.status === 'skipped' ? 'why it was skipped' : 'what looks wrong'}`);
  let tests: string[] = [];
  if (m.status !== 'skipped') {
    if (m.tests.length === 0) return new Error(`${m.status} needs --tests: the test files that pin ${rel}`);
    for (const f of m.tests) {
      const tr = repoRel(root, f);
      if (!inside(tr)) return new Error(`${f} is outside the project`);
      if (!isTestCode(tr)) return new Error(`${f} is not a test file by its name or dir`);
      if (!existsSync(join(root, tr))) return new Error(`${f} does not exist`);
      tests.push(tr);
    }
    tests = [...new Set(tests)];
    const problem = evidenceProblem(projectDir, root, rel, tests, records);
    if (problem) return new Error(`${problem}; run the tests and record them (record-tests) first`);
  }
  t.status = m.status;
  t.at = now;
  if (tests.length > 0) t.tests = tests;
  else delete t.tests;
  if (note !== '') t.note = note;
  else delete t.note;
  return null;
}

export function backfillSummary(s: BackfillState): Record<string, unknown> {
  const counts: Record<TargetStatus, number> = { todo: 0, done: 0, skipped: 0, suspect: 0 };
  for (const t of s.targets) counts[t.status]++;
  const last = s.batches[s.batches.length - 1];
  return {
    counts,
    batches: s.batches.length,
    open: last ? s.targets.filter((t) => t.status === 'todo' && t.batch === last.n).map((t) => t.rel) : [],
    next: s.targets.filter((t) => t.status === 'todo').slice(0, DEFAULT_BATCH).map((t) => ({ rel: t.rel, kind: t.kind, needs: t.needs })),
    suspects: s.targets.filter((t) => t.status === 'suspect').map((t) => ({ rel: t.rel, note: t.note, tests: t.tests })),
  };
}
