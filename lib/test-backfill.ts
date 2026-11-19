// Test backfill state (track L, L3; plan §18): `.goodboy/test-backfill.json` in the project.
// It holds the survey's untested targets with what became of each, and the batches handed
// out. The backfill-tests skill changes it through `cli.ts backfill-*` only, each change under
// a lock. A target is done on evidence (evidenceFor): the Stop's test gate skips a turn that
// changed only tests, so the mark checks what the gate would.

import { closeSync, existsSync, lstatSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { suiteRan } from './existing-tests';
import { redactText } from './pii-patterns';
import { E2E_DIR } from './sandbox-e2e';
import { type RunProof, runStartsAfter, sandboxProof } from './sandbox-proof';
import { MAX_STATE_BYTES, readRegular } from './safe-read';
import { isTestCode, type SurveyTarget } from './test-survey';
import { recordStandsAlone, testerFor } from './test-types';
import { findRecentTestFiles } from './test-validator';
import { isTrustedTimestamp } from './trusted-time';
import type { TestResult } from './types';

export const BACKFILL_DIR = '.goodboy';
export const BACKFILL_FILE = join(BACKFILL_DIR, 'test-backfill.json');
const LOCK_FILE = join(BACKFILL_DIR, 'test-backfill.lock');
/** Track M: a project with this file has an isolated sandbox (`sandbox-init`); its tests run there. */
const SANDBOX_COMPOSE = join(BACKFILL_DIR, 'sandbox', 'compose.yml');
const hasSandbox = (root: string) => existsSync(join(root, SANDBOX_COMPOSE));
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

/** The words of a command line, quotes taken off, or null when it holds shell syntax that is
 *  not data: unquoted `;` `&` `|` `#` `<` `>` or `\`, a backtick or `$(` (also inside double
 *  quotes), a newline anywhere, an unclosed quote. Inside quotes `#` `&` `;` `|` are text, so
 *  Maven's `-Dtest='Foo#bar'` is fine. */
export function shellWords(cmd: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let q: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (c === '\n' || c === '\r') return null;
    if (q === "'") {
      if (c === "'") q = null;
      else cur += c;
      continue;
    }
    if (q === '"') {
      if (c === '"') q = null;
      else if (c === '`' || c === '\\' || (c === '$' && cmd[i + 1] === '(')) return null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      has = true;
    } else if (/[;&|#<>`\\]/.test(c) || (c === '$' && cmd[i + 1] === '(')) return null;
    else if (/\s/.test(c)) {
      if (has || cur !== '') out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (q !== null) return null;
  if (has || cur !== '') out.push(cur);
  return out;
}

/** What a suite's command is, against the run a record names: `command` for the `sandbox-run`
 *  line with `--` and the command the run recorded (word for word), `whole` for the line with no
 *  `--` (the run's own commands: the project's test command, the e2e tests), null for anything
 *  else. The line IS the invocation from its first word (a JS runtime with flags, a `cli.ts`,
 *  `sandbox-run`, flags), with no shell syntax around it (shellWords): not a comment, an echo or the
 *  second half of a chain. A host command, even the same one, is not. `--suite` must be the run's.
 *  For an e2e-only run `--` is refused: its words would replace the e2e service's command. */
export function lineKind(command: string, proof: RunProof): 'command' | 'whole' | null {
  const w = shellWords(command);
  if (w === null) return null;
  let i = 0;
  if (/^(?:bun|bunx|node|nodejs|tsx)$/.test((w[0] ?? '').split('/').pop()!)) {
    i = 1;
    while (i < w.length && w[i]!.startsWith('-')) i++;
  }
  if (!/(^|\/)cli\.ts$/.test(w[i] ?? '') || w[i + 1] !== 'sandbox-run') return null;
  const rest = w.slice(i + 2);
  const dd = rest.indexOf('--');
  const flags = dd < 0 ? rest : rest.slice(0, dd);
  const si = flags.indexOf('--suite');
  if (proof.suite !== null && (si >= 0 ? flags[si + 1] : 'all') !== proof.suite) return null;
  if (dd < 0) return 'whole';
  if (proof.suite === 'e2e' || proof.command.length === 0) return null;
  const tail = rest.slice(dd + 1);
  return tail.length === proof.command.length && tail.every((x, k) => x === proof.command[k]) ? 'command' : null;
}

/** Whether a `sandbox-run` line holds nothing but the invocation and its own flags before `--`: no runtime flag
 *  with a value, and only `--suite unit|e2e|all` and `--timeout-ms <digits>` after `sandbox-run`. A real-data run's
 *  test record keeps such a line (M6d); any other word there could carry text the caller chose (a name has no
 *  shape the detectors know), so a line with one is withheld. The words after `--` are the run's own command,
 *  which `lineKind` matches word for word. */
export function sandboxRunFlagsOnly(command: string): boolean {
  const w = shellWords(command);
  if (w === null) return false;
  let i = 0;
  if (/^(?:bun|bunx|node|nodejs|tsx)$/.test((w[0] ?? '').split('/').pop()!)) {
    i = 1;
    while (i < w.length && /^--?[a-z][a-z-]*$/.test(w[i]!)) i++;
  }
  if (!/(^|\/)cli\.ts$/.test(w[i] ?? '') || w[i + 1] !== 'sandbox-run') return false;
  const rest = w.slice(i + 2);
  const dd = rest.indexOf('--');
  const flags = dd < 0 ? rest : rest.slice(0, dd);
  for (let k = 0; k < flags.length; k += 2) {
    const [f, v] = [flags[k], flags[k + 1] ?? ''];
    if (f === '--suite' && /^(?:unit|e2e|all)$/.test(v)) continue;
    if (f === '--timeout-ms' && /^\d{1,9}$/.test(v)) continue;
    return false;
  }
  return true;
}

/** The one line a counted suite must be, for the run of a record (named in the refusal). */
function expectedLine(proof: RunProof): string {
  const base = `bun "$GB/lib/cli.ts" sandbox-run --suite ${proof.suite ?? 'unit'}`;
  return proof.suite === 'e2e' ? base : `${base} -- ${proof.command.join(' ')}`;
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
  const named = all.filter(
    (r) =>
      r.verdict === 'pass' &&
      isTrustedTimestamp(r.timestamp) &&
      (r.tested_files ?? []).some((f) => typeof f === 'string' && abs(f) === targetAbs) &&
      recordStandsAlone(r),
  );
  if (named.length === 0) return `no passing layer-1 record that stands on its own names ${target} in tested_files`;
  // With a sandbox the tests count only when they ran inside it (track M): the record names a
  // sandbox-run whose result.json is still on disk with the recorded hash, passed its check
  // (all three flags) and exited 0.
  const sandboxed = hasSandbox(root);
  const proofs = new Map<TestResult, RunProof>();
  const why: string[] = [];
  if (sandboxed) {
    for (const r of named) {
      const p = sandboxProof(root, r);
      if (typeof p === 'string') why.push(p);
      else proofs.set(r, p);
    }
  }
  const fit = sandboxed ? named.filter((r) => proofs.has(r)) : named;
  if (fit.length === 0) {
    return `the project has a sandbox (${SANDBOX_COMPOSE.split(sep).join('/')}), so a record counts only when its tests ran inside it: ${named.length} record(s) name ${target} but none proves a sandbox run (${[...new Set(why)].slice(0, 3).join('; ')}); run the suites with sandbox-run (run-sandbox) and record with sandbox: {run: "<ts>"}`;
  }
  const at = (r: TestResult) => Date.parse(r.timestamp);
  /** The suite is the sandbox-run line of the record's run (lineKind); it ran the test when the
   *  run's command (the project's tests, or the one after `--`) did, or, for a run that includes
   *  the e2e suite, when the test is in the e2e dir (the e2e service runs every file in it). */
  const suiteRanTest = (r: TestResult, command: string, t: string): boolean => {
    const proof = proofs.get(r);
    if (proof === undefined) return suiteRan(command, t, root);
    const kind = lineKind(command, proof);
    if (kind === null) return false;
    if (proof.suite !== 'e2e' && suiteRan(proof.command.join(' '), t, root)) return true;
    return (proof.suite === 'e2e' || proof.suite === 'all') && repoRel(root, abs(t)).startsWith(`${E2E_DIR}/`);
  };
  /** The run started in or after the second of the change: a run before the last edit proves nothing about it. */
  const runAfter = (r: TestResult, changed: number): boolean => {
    const proof = proofs.get(r);
    return proof === undefined || runStartsAfter(proof.run, changed);
  };
  let targetChanged = 0;
  try {
    targetChanged = changedAt(targetAbs);
  } catch {
    // the target is gone: the other checks say so
  }
  let newest = 0;
  for (const t of tests) {
    const changed = changedAt(abs(t));
    newest = Math.max(newest, changed);
    const ran = fit.some(
      (r) =>
        at(r) >= changed &&
        runAfter(r, Math.max(changed, targetChanged)) &&
        (r.test_files ?? []).some((f) => typeof f === 'string' && abs(f) === abs(t)) &&
        (r.suites ?? []).some((s) => s.failed === 0 && s.passed > 0 && typeof s.command === 'string' && suiteRanTest(r, s.command, t)),
    );
    if (!ran) {
      const proof = [...proofs.entries()].find(([r]) => (r.test_files ?? []).some((f) => typeof f === 'string' && abs(f) === abs(t)))?.[1] ?? [...proofs.values()][0];
      return `no such record, made after ${t} last changed, lists it in test_files with a passing suite that ran it${proof ? `; in a project with a sandbox a counted suite is exactly this one line, with no other shell syntax: ${expectedLine(proof)} (the run must have started after the last edit of the target and its tests)` : ''}`;
    }
  }
  const mutated = fit.some(
    (r) =>
      at(r) >= newest &&
      runAfter(r, Math.max(newest, targetChanged)) &&
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
  // the note lands in `.goodboy/test-backfill.json`, which a project commits: no personal data or secret in it (M6d)
  const note = redactText((m.note ?? '').trim());
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

/** `root` (the repo top) tells whether the project has a sandbox: the goal is then `complete`
 *  (coverage-check and ui-check both ok), else `batches` (track L). */
export function backfillSummary(s: BackfillState, root?: string): Record<string, unknown> {
  const counts: Record<TargetStatus, number> = { todo: 0, done: 0, skipped: 0, suspect: 0 };
  for (const t of s.targets) counts[t.status]++;
  const last = s.batches[s.batches.length - 1];
  return {
    goal: root !== undefined && hasSandbox(root) ? 'complete' : 'batches',
    counts,
    batches: s.batches.length,
    open: last ? s.targets.filter((t) => t.status === 'todo' && t.batch === last.n).map((t) => t.rel) : [],
    next: s.targets.filter((t) => t.status === 'todo').slice(0, DEFAULT_BATCH).map((t) => ({ rel: t.rel, kind: t.kind, needs: t.needs })),
    suspects: s.targets.filter((t) => t.status === 'suspect').map((t) => ({ rel: t.rel, note: t.note, tests: t.tests })),
  };
}
