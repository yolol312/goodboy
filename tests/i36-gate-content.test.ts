// v0.36.6, Part 2 (plan §15.22): the gates judge records by content, not by time.
//   R4  a record with a tree counts for a file only when the file's content and kind in that tree
//       are the file's now (a real `git checkout` changes a file with no edit in the log); a tree
//       that cannot be read, a malformed one and an exhausted read budget never fall back to the
//       time; a record with no tree uses its time only while its checkout is not known to have
//       changed. Reviews follow the same rule.
//   R3  a passing record whose test files are gone is no evidence (filtered once, with a note).
//   R2  every content-matching record counts for the changed lines, and a coverage base other than
//       the start HEAD counts for a file only where the file is the same there and at the start.
//   the branch note, the narrowed LCOV exemption (layer-1 scope only), exact onSkipped counts, and
//   Unicode spellings reconciled only through the file system.
// Repos are temporary and git runs for real; budget assertions use injected clocks, and the
// subprocess tests have generous runner timeouts.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
// The new library members are read off the module namespaces (and the new modules imported inside
// the tests that need them), so a red run on an older tree fails those tests one by one, not the file.
import * as coverage from '../lib/changed-coverage';
import * as validator from '../lib/test-validator';
import { recordEdit } from '../lib/file-tracker';
import { workTreeState } from '../lib/push-test';
import { validateReviewCoverage, type ChangedFileEdit } from '../lib/review-validator';
import type { ReviewResult, TestResult } from '../lib/types';

const { changedLineGaps, changedLineReason, differFromBase, netChangedEdits, pinCoverageStart, withSameContent } = coverage;
const { freshFor, validateTestCoverage } = validator;
const freshness = (...a: Parameters<typeof validator.freshness>): ReturnType<typeof validator.freshness> => validator.freshness(...a);
const treeEntries = (...a: Parameters<typeof coverage.treeEntries>): ReturnType<typeof coverage.treeEntries> => coverage.treeEntries(...a);
const divergedFromStart = (...a: Parameters<typeof coverage.divergedFromStart>): ReturnType<typeof coverage.divergedFromStart> => coverage.divergedFromStart(...a);
const withoutAbsentTests = (...a: Parameters<typeof validator.withoutAbsentTests>): ReturnType<typeof validator.withoutAbsentTests> => validator.withoutAbsentTests(...a);
const lcovModule = () => import('../lib/lcov-report');
const spellingModule = () => import('../lib/path-spelling');

const ROOT = resolve(import.meta.dir, '..');
const STOP = join(ROOT, 'hooks', 'stop.ts');
setDefaultTimeout(30_000);

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function tmp(prefix = 'goodboy-i36c-'): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
const sh = (cwd: string, cmd: string): string => {
  const p = Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return (p.stdout.toString() + p.stderr.toString()).trim();
};
function write(root: string, rel: string, text: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}
const GIT_INIT = 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false';
/** A repo with the files committed; returns top and the start commit. */
function repo(files: Record<string, string>): { top: string; head: string } {
  const top = tmp();
  sh(top, GIT_INIT);
  for (const [f, t] of Object.entries(files)) write(top, f, t);
  sh(top, "git add -A && git commit -q -m 'ABC-1 start'");
  return { top, head: sh(top, 'git rev-parse HEAD') };
}
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const BASE = 'a'.repeat(40);

type Changed = NonNullable<NonNullable<TestResult['coverage']>['changed']>;
const changed = (files: Record<string, [number, number]>, base = BASE): Changed => ({
  covered: Object.values(files).reduce((s, [c]) => s + c, 0),
  total: Object.values(files).reduce((s, [, t]) => s + t, 0),
  files_without_executed_changes: [],
  files: Object.fromEntries(Object.entries(files).map(([f, [c, t]]) => [f, { covered: c, total: t }])),
  in_report: Object.keys(files),
  diff_lines: Object.fromEntries(Object.keys(files).map((f) => [f, 1])),
  base,
});
function record(tested: string[], over: Partial<TestResult> = {}): TestResult {
  return {
    timestamp: iso(1_000),
    tested_files: tested,
    category: 'fix-bug',
    test_files: [],
    environment: { mode: 'none' },
    suites: [{ name: 's', command: 'bun test', passed: 2, failed: 0, output: '2 pass', type: 'unit', duration_ms: 5 }],
    acceptance: [],
    verdict: 'pass',
    ...over,
  } as TestResult;
}
const review = (files: string[], over: Partial<ReviewResult> = {}): ReviewResult =>
  ({ timestamp: iso(1_000), reviewed_files: files, category: 'fix-bug', findings: [], verdict: 'pass', dimensions_checked: [], ...over }) as unknown as ReviewResult;
const treeNow = (top: string): string => workTreeState(top).tree!;
const lastEdit = (file: string, msAgo = 60_000): ChangedFileEdit => ({ file, lastEditTimestamp: iso(msAgo) });

// ── R4: content, not time ────────────────────────────────────────────────────────────────────

describe('R4: a record with a tree counts by the content of the file, never by its time', () => {
  /** main has a.ts = BASE; feat has a.ts = M (a record is made on it); feat2 has a.ts = M2. */
  function branches() {
    const { top } = repo({ 'a.ts': 'export const a = 0;\n' });
    const a = join(top, 'a.ts');
    sh(top, 'git checkout -q -b feat');
    write(top, 'a.ts', 'export const a = 1;\n');
    sh(top, "git commit -qam 'ABC-1 M'");
    sh(top, 'git checkout -q main && git checkout -q -b feat2');
    write(top, 'a.ts', 'export const a = 2;\n');
    sh(top, "git commit -qam 'ABC-1 M2'");
    sh(top, 'git checkout -q feat');
    return { top, a, tree: treeNow(top) }; // the work tree on feat: a.ts = M
  }
  const fresh = (top: string, a: string, r: TestResult): boolean => freshFor(r, withSameContent([lastEdit(a)], [r], top)[0]!);

  test('M -> main -> M: a git checkout is not an edit in the log; only the content decides, in both directions', () => {
    const { top, a, tree } = branches();
    // The record is NEWER than the last logged edit, as one made right after the edit is.
    const r = record([a], { timestamp: iso(1_000), tree });
    expect(fresh(top, a, r)).toBe(true); // on feat: a.ts is M, the tree's
    sh(top, 'git checkout -q main'); // a.ts is the base now; nothing was logged
    expect(fresh(top, a, r)).toBe(false); // the time rule said yes here
    sh(top, 'git checkout -q feat2'); // another content, again with no edit in the log
    expect(fresh(top, a, r)).toBe(false);
    sh(top, 'git checkout -q feat'); // back to M
    expect(fresh(top, a, r)).toBe(true);
    // The same through the coverage check.
    expect(validateTestCoverage([r], withSameContent([lastEdit(a)], [r], top)).ok).toBe(true);
    sh(top, 'git checkout -q main');
    const v = validateTestCoverage([r], withSameContent([lastEdit(a)], [r], top));
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('마지막 편집보다 오래된'); // stale: other content, not "never ran" and not "could not verify"
  });

  test('a newer record with the wrong content does not hide an older one with matching content', () => {
    const { top, a, tree } = branches();
    sh(top, 'git checkout -q feat2');
    const treeM2 = treeNow(top);
    sh(top, 'git checkout -q feat'); // a.ts = M
    const older = record([a], { timestamp: iso(30_000), tree, category: 'older' });
    const newer = record([a], { timestamp: iso(2_000), tree: treeM2, category: 'newer' });
    const edits = withSameContent([lastEdit(a, 60_000)], [newer, older], top);
    const v = validateTestCoverage([newer, older], edits);
    expect(v.ok).toBe(true);
    expect(v.effective).toEqual([older]); // the time rule chose `newer`, which ran other content
  });

  test('a file edited after a record that already holds its content is still covered, and one edited into other content is not', () => {
    const { top } = repo({ 'a.ts': 'export const a = 1;\n' });
    const a = join(top, 'a.ts');
    write(top, 'a.ts', 'export const a = 2;\n');
    const r = record([a], { timestamp: iso(20_000), tree: treeNow(top) });
    write(top, 'a.ts', 'export const a = 1;\n'); // edited back after the record
    expect(freshFor(r, withSameContent([lastEdit(a, 10_000)], [r], top)[0]!)).toBe(false); // older than the edit, other content
    write(top, 'a.ts', 'export const a = 2;\n');
    expect(freshFor(r, withSameContent([lastEdit(a, 10_000)], [r], top)[0]!)).toBe(true); // older than the edit, same content
    write(top, 'a.ts', 'export const a = 3;\n');
    expect(freshFor(r, withSameContent([lastEdit(a, 40_000)], [r], top)[0]!)).toBe(false); // newer than the edit, other content
  });

  test('kind counts as content: the executable bit, a link, a directory in its place, a deleted file', () => {
    const { top } = repo({ 'run.sh': 'echo 1\n' });
    const f = join(top, 'run.sh');
    const r = record([f], { tree: treeNow(top) });
    const state = () => freshness(r, withSameContent([lastEdit(f)], [r], top)[0]!);
    expect(state()).toBe('fresh');
    chmodSync(f, 0o755); // the same blob, another mode
    expect(state()).toBe('stale');
    sh(top, 'git config core.fileMode false'); // a repo that does not track the bit: the same file
    expect(state()).toBe('fresh');
    sh(top, 'git config core.fileMode true');
    chmodSync(f, 0o644);
    expect(state()).toBe('fresh');
    rmSync(f);
    symlinkSync('/etc/hosts', f); // a link cannot be compared with a regular file's blob
    expect(state()).toBe('unverified');
    rmSync(f);
    mkdirSync(f);
    expect(state()).toBe('unverified');
    rmSync(f, { recursive: true });
    expect(state()).toBe('stale'); // deleted now, present in the record's tree
    const gone = record([f], { tree: treeNow(top) }); // a record made after the deletion: absent in both
    expect(freshness(gone, withSameContent([lastEdit(f)], [gone], top)[0]!)).toBe('fresh');
  });

  test('a tree git does not have, a malformed one, and a spent read budget are unverified, never the time rule', () => {
    const { top, a, tree } = branches();
    const ghost = record([a], { timestamp: iso(500), tree: 'c'.repeat(40) });
    const out = withSameContent([lastEdit(a)], [ghost], top)[0]!;
    expect(freshness(ghost, out)).toBe('unverified');
    expect(freshFor(ghost, out)).toBe(false);
    const v = validateTestCoverage([ghost], [out]);
    expect(v.reason).toContain('Could not verify');
    expect(v.reason).toContain('not "the tests never ran"');
    expect(v.reason).not.toContain('마지막 편집보다 오래된');
    // Malformed: never compared, never the time rule, the same message.
    const bad = record([a], { timestamp: iso(500), tree: 'not-a-tree' });
    expect(freshness(bad, lastEdit(a))).toBe('unverified');
    expect(validateTestCoverage([bad], [lastEdit(a)]).reason).toContain('Could not verify');
    // A real tree, but the injected clock says the budget is spent before it is read (no time to hash it).
    const real = record([a], { timestamp: iso(500), tree });
    let t = 0;
    const spent = withSameContent([lastEdit(a)], [real], top, undefined, { now: () => (t += 10_000), budgetMs: 2_000 })[0]!;
    expect(freshness(real, spent)).toBe('unverified');
    expect(validateTestCoverage([real], [spent]).reason).toContain('Could not verify');
    // With the clock standing still the same record is read and counts.
    expect(freshness(real, withSameContent([lastEdit(a)], [real], top, undefined, { now: () => 0 })[0]!)).toBe('fresh');
  });

  test('the budget runs out between two tree reads: the first record counts, the second is unverified (never its time)', () => {
    const { top, a, tree } = branches();
    write(top, 'extra.txt', 'x\n'); // a second tree that holds the same a.ts
    const tree2 = treeNow(top);
    expect(tree2).not.toBe(tree);
    const newer = record([a], { timestamp: iso(500), tree });
    const older = record([a], { timestamp: iso(900), tree: tree2 });
    const shim = installShim({ flagOn: 'ls-tree' });
    try {
      // The clock jumps as soon as the first `ls-tree` has run: that is the one read the budget allows.
      const out = withSameContent([lastEdit(a)], [newer, older], top, undefined, { now: () => (existsSync(shim.flag) ? 10_000 : 0), budgetMs: 2_000 })[0]!;
      expect(freshness(newer, out)).toBe('fresh');
      expect(freshness(older, out)).toBe('unverified'); // newer than the edit by time, and still not evidence
      expect(freshFor(older, out)).toBe(false);
    } finally {
      shim.restore();
    }
  });

  test('the tree cap: past it a record is not read, and is unverified (not older and not "fresh")', () => {
    const { top, a, tree } = branches();
    write(top, 'extra.txt', 'x\n');
    const tree2 = treeNow(top);
    const first = record([a], { timestamp: iso(500), tree });
    const second = record([a], { timestamp: iso(900), tree: tree2 }); // a real tree that holds the content too
    const both = withSameContent([lastEdit(a)], [first, second], top, undefined, { now: () => 0 })[0]!;
    expect(freshness(second, both)).toBe('fresh'); // the control: without the cap it is read and counts
    const capped = withSameContent([lastEdit(a)], [first, second], top, undefined, { now: () => 0, maxTrees: 1 })[0]!;
    expect(freshness(first, capped)).toBe('fresh');
    expect(freshness(second, capped)).toBe('unverified');
  });

  test('the messages tell three states apart: never ran, stale, could not verify', () => {
    const { top, a, tree } = branches();
    const none = validateTestCoverage([record(['/elsewhere.ts'], { tree })], [lastEdit(a)]);
    expect(none.reason).toContain('테스트되지 않은 변경 파일'); // no record lists it
    sh(top, 'git checkout -q main');
    const r = record([a], { tree });
    const stale = validateTestCoverage([r], withSameContent([lastEdit(a)], [r], top));
    expect(stale.reason).toContain('마지막 편집보다 오래된');
    const ghost = record([a], { tree: 'e'.repeat(40) });
    const unknown = validateTestCoverage([ghost], withSameContent([lastEdit(a)], [ghost], top));
    expect(unknown.reason).toContain('Could not verify');
  });

  test('reviews follow the same rule: by content, with the reviewed files as the list', () => {
    const { top, a, tree } = branches();
    const r = review([a], { tree });
    const reviews = (): ChangedFileEdit[] => withSameContent([lastEdit(a)], [r], top, (x) => x.reviewed_files);
    expect(validateReviewCoverage([r], reviews()).ok).toBe(true);
    sh(top, 'git checkout -q main'); // a.ts is another content, the review is newer than the logged edit
    const stale = validateReviewCoverage([r], reviews());
    expect(stale.ok).toBe(false);
    expect(stale.stale).toEqual([a]); // a delta review is enough
    const ghost = review([a], { tree: 'f'.repeat(40) });
    const unknown = validateReviewCoverage([ghost], withSameContent([lastEdit(a)], [ghost], top, (x) => x.reviewed_files));
    expect(unknown.ok).toBe(false);
    expect(unknown.unverified).toEqual([a]);
    expect(unknown.reason).toContain('Could not verify');
    expect(unknown.stale ?? []).toEqual([]);
  });
});

describe('R4: a record with no tree uses its time only while its checkout is not known to have changed', () => {
  function history() {
    const { top } = repo({ 'a.ts': 'export const a = 0;\n' });
    const a = join(top, 'a.ts');
    const c1 = sh(top, 'git rev-parse HEAD');
    sh(top, 'git checkout -q -b feat');
    write(top, 'a.ts', 'export const a = 1;\n');
    sh(top, "git commit -qam 'ABC-1 M'");
    const c2 = sh(top, 'git rev-parse HEAD');
    return { top, a, c1, c2 };
  }
  const legacy = (a: string, over: Partial<TestResult> = {}): TestResult => record([a], { timestamp: iso(1_000), tree: undefined, ...over });
  const state = (top: string, a: string, r: TestResult): string => freshness(r, withSameContent([lastEdit(a)], [r], top)[0]!);

  test('same epoch: the record\'s commit is HEAD, or an ancestor of it', () => {
    const { top, a, c1, c2 } = history();
    expect(state(top, a, legacy(a, { commit: c2 }))).toBe('fresh'); // HEAD itself, newer than the edit
    expect(state(top, a, legacy(a, { commit: c1 }))).toBe('fresh'); // an ancestor
    expect(state(top, a, legacy(a, { commit: c2, timestamp: iso(90_000) }))).toBe('stale'); // the time rule still applies inside the epoch
    sh(top, "git commit -q --allow-empty -m 'ABC-1 later'");
    expect(state(top, a, legacy(a, { commit: c2 }))).toBe('fresh'); // a commit on top keeps the line
  });

  test('after a checkout to another line, a record that is not on HEAD\'s history is not evidence', () => {
    const { top, a, c2 } = history();
    sh(top, 'git checkout -q main');
    const r = legacy(a, { commit: c2 }); // made on feat, newer than the edit
    expect(state(top, a, r)).toBe('unverified');
    const v = validateTestCoverage([r], withSameContent([lastEdit(a)], [r], top));
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('Could not verify');
    expect(freshFor(r, withSameContent([lastEdit(a)], [r], top)[0]!)).toBe(false);
  });

  test('unknown history: no commit on the record, a commit git does not have, an unusable id', () => {
    const { top, a } = history();
    expect(state(top, a, legacy(a))).toBe('unverified');
    expect(state(top, a, legacy(a, { commit: 'b'.repeat(40) }))).toBe('unverified');
    expect(state(top, a, legacy(a, { commit: 'HEAD' }))).toBe('unverified');
    expect(state(top, a, legacy(a, { commit: null }))).toBe('unverified');
  });

  test('outside a repo there is no checkout to doubt: the time rule', () => {
    const plain = tmp();
    const f = write(plain, 'a.ts', 'x\n');
    expect(state(plain, f, legacy(f))).toBe('fresh');
    expect(state(plain, f, legacy(f, { timestamp: iso(90_000) }))).toBe('stale');
  });

  test('a repo whose HEAD does not resolve (no commit, or `git checkout --orphan`) has no checkout to trust', () => {
    const born = tmp();
    sh(born, GIT_INIT);
    const g = write(born, 'a.ts', 'x\n');
    expect(state(born, g, legacy(g))).toBe('unverified'); // a repo with no commit yet
    const { top, a, c2 } = history();
    expect(state(top, a, legacy(a, { commit: c2 }))).toBe('fresh'); // control: HEAD is c2
    sh(top, 'git checkout -q --orphan elsewhere'); // the files stay, HEAD is unborn: another line starts
    expect(sh(top, 'git rev-parse --verify -q HEAD || echo unborn')).toBe('unborn');
    expect(state(top, a, legacy(a, { commit: c2 }))).toBe('unverified');
    expect(state(top, a, legacy(a, { commit: c2, timestamp: iso(90_000) }))).toBe('unverified');
  });

  test('reviews with no tree are judged the same way (they carry no commit: in a repo with history, not evidence)', () => {
    const { top, a } = history();
    const r = review([a]);
    const edits = withSameContent([lastEdit(a)], [r], top, (x) => x.reviewed_files);
    expect(validateReviewCoverage([r], edits).unverified).toEqual([a]);
    const plain = tmp();
    const f = write(plain, 'a.ts', 'x\n');
    const ok = withSameContent([lastEdit(f)], [review([f])], plain, (x) => x.reviewed_files);
    expect(validateReviewCoverage([review([f])], ok).ok).toBe(true);
  });

  test('a unit-level edit with no enrichment keeps the old time rule for a record with no tree', () => {
    const r = record(['/p/a.ts'], { timestamp: iso(10_000) });
    expect(validateTestCoverage([r], [{ file: '/p/a.ts', lastEditTimestamp: iso(20_000) }]).ok).toBe(true);
    expect(validateTestCoverage([r], [{ file: '/p/a.ts', lastEditTimestamp: iso(5_000) }]).ok).toBe(false);
  });
});

// ── R4: `tree: null` ──────────────────────────────────────────────────────────────────────────

describe('R4: `tree: null` is a work-tree hash that failed, not a record from before the trees', () => {
  /** main has a.ts = 0; feat (later on the same line) has a.ts = 1. */
  function line() {
    const { top } = repo({ 'a.ts': 'export const a = 0;\n' });
    const a = join(top, 'a.ts');
    const c1 = sh(top, 'git rev-parse HEAD');
    sh(top, 'git checkout -q -b feat');
    write(top, 'a.ts', 'export const a = 1;\n');
    sh(top, "git commit -qam 'ABC-1 a1'");
    sh(top, 'git checkout -q main');
    return { top, a, c1 };
  }

  test('an unreadable untracked file makes test-write store tree null; a checkout of a later commit of the line then changes the file, and the record is no evidence', () => {
    if (process.getuid?.() === 0) return; // root reads a mode 000 file
    const { top, a, c1 } = line();
    const secret = write(top, 'secret.txt', 'x\n');
    chmodSync(secret, 0o000);
    try {
      const state = workTreeState(top);
      expect(state).toEqual({ commit: c1, tree: null }); // what `cli.ts test-write` stores
      const r = record([a], { timestamp: iso(1_000), tree: state.tree, commit: state.commit }); // newer than the edit
      const edit = () => withSameContent([lastEdit(a)], [r], top)[0]!;
      expect(freshness(r, edit())).toBe('unverified');
      sh(top, 'git checkout -q feat'); // an edit the log never sees: a.ts changes
      expect(freshness(r, edit())).toBe('unverified'); // before the fix: fresh (HEAD is a descendant of the record's commit)
      const v = validateTestCoverage([r], [edit()]);
      expect(v.ok).toBe(false);
      expect(v.reason).toContain('Could not verify');
      expect(v.reason).toContain('`tree: null`'); // the cause: the work-tree hash failed
      expect(v.reason).toContain('work-tree hash failed');
    } finally {
      chmodSync(secret, 0o644);
    }
  });

  test('a review with tree null is the same; a plain record (no tree key) in a repo keeps its time rule', () => {
    const { top, a } = line();
    const rv = review([a], { tree: null });
    const edits = withSameContent([lastEdit(a)], [rv], top, (x) => x.reviewed_files);
    const out = validateReviewCoverage([rv], edits);
    expect(out.ok).toBe(false);
    expect(out.unverified).toEqual([a]);
    expect(out.reason).toContain('work-tree hash failed');
    const legacyHere = record([a], { timestamp: iso(1_000), tree: undefined, commit: sh(top, 'git rev-parse HEAD') });
    expect(freshness(legacyHere, withSameContent([lastEdit(a)], [legacyHere], top)[0] ?? lastEdit(a))).toBe('fresh');
  });

  test('outside a git repo no tree can be taken: tree null is judged by time there (and only there)', () => {
    const plain = tmp();
    const f = write(plain, 'a.ts', 'x\n');
    const newer = record([f], { timestamp: iso(1_000), tree: null, commit: null });
    const older = record([f], { timestamp: iso(90_000), tree: null, commit: null });
    expect(freshness(newer, withSameContent([lastEdit(f)], [newer], plain)[0]!)).toBe('fresh');
    expect(freshness(older, withSameContent([lastEdit(f)], [older], plain)[0]!)).toBe('stale');
    const { top, a } = line();
    expect(freshness(newer, withSameContent([lastEdit(a)], [{ ...newer, tested_files: [a] }], top)[0]!)).toBe('unverified');
  });

  test('allUnverified (what the Stop uses when the content check itself fails): no record counts, with a tree or without', () => {
    const { top, a } = line();
    const treeless = review([a], { tree: undefined });
    const treed = review([a], { tree: workTreeState(top).tree });
    const edits = coverage.allUnverified([lastEdit(a)], [treeless, treed]);
    expect(freshness(treeless, edits[0]!)).toBe('unverified');
    expect(freshness(treed, edits[0]!)).toBe('unverified');
    expect(freshness(review([a], { tree: null }), edits[0]!)).toBe('unverified');
    const out = validateReviewCoverage([treeless, treed], edits);
    expect(out.ok).toBe(false);
    expect(out.unverified).toEqual([a]);
  });
});

// ── R4: the tree cap is spent newest first across the files ──────────────────────────────────

describe('R4: the cap on record trees read does not let one file starve another', () => {
  test('35 old records for a.ts do not make the newest record of b.ts unverified', () => {
    const { top } = repo({ 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 1;\n' });
    const a = join(top, 'src/a.ts');
    const b = join(top, 'src/b.ts');
    // 36 commits, each with a different tree that keeps both files as they are.
    const trees = sh(top, 'for i in $(seq 1 36); do echo $i > f$i; git add f$i; git commit -qm "ABC-1 x$i"; git rev-parse HEAD^{tree}; done').split('\n');
    expect(new Set(trees).size).toBe(36);
    const olds = trees.slice(0, 35).map((tree, i) => record([a], { timestamp: iso(100_000 - i * 1_000), tree })); // newer than b's record
    const bNewest = record([b], { timestamp: iso(500_000), tree: trees[35]! }); // the only record of b, older than all
    const edits = [lastEdit(a, 600_000), lastEdit(b, 600_000)]; // a first: the old code spent the cap there
    const out = withSameContent(edits, [...olds, bNewest], top, undefined, { now: () => 0 });
    expect(freshness(bNewest, out[1]!)).toBe('fresh'); // before the fix: unverified (the 30 trees were gone)
    expect(validateTestCoverage([...olds, bNewest], out).ok).toBe(true); // both files covered
    // a.ts itself: its newest records are read first, so it is fresh as well; the cap (30 trees, one
    //   of them b's) still holds, and exhaustion means unverified only for what is left: a.ts's oldest.
    expect(freshness(olds[34]!, out[0]!)).toBe('fresh');
    expect(freshness(olds[0]!, out[0]!)).toBe('unverified');
    const capped = withSameContent(edits, [...olds, bNewest], top, undefined, { now: () => 0, maxTrees: 3 });
    expect(freshness(bNewest, capped[1]!)).toBe('fresh');
    expect(freshness(olds[34]!, capped[0]!)).toBe('fresh');
    expect(freshness(olds[0]!, capped[0]!)).toBe('unverified'); // past the cap
  });

  test('one tree read serves every edited path that asks', () => {
    const { top } = repo({ 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 1;\n' });
    const a = join(top, 'src/a.ts');
    const b = join(top, 'src/b.ts');
    const tree = workTreeState(top).tree!;
    const both = record([a, b], { timestamp: iso(1_000), tree });
    const out = withSameContent([lastEdit(a), lastEdit(b)], [both], top, undefined, { now: () => 0, maxTrees: 1 });
    expect(freshness(both, out[0]!)).toBe('fresh');
    expect(freshness(both, out[1]!)).toBe('fresh'); // one tree, two files, a cap of one
  });
});

// ── R3 ───────────────────────────────────────────────────────────────────────────────────────

describe('R3: a passing record whose test files are gone is no evidence', () => {
  test('withoutAbsentTests drops it once with a note naming the record and the path; other records stay', () => {
    const dir = tmp();
    const present = write(dir, 'tests/a.test.ts', 'x\n');
    const gone = join(dir, 'tests', 'gone.test.ts');
    const ok = record(['/p/a.ts'], { test_files: [present], category: 'ok' });
    const absent = record(['/p/a.ts'], { test_files: [present, gone], category: 'absent', timestamp: '2026-10-27T01:02:03.000Z' });
    const failed = record(['/p/a.ts'], { test_files: [gone], verdict: 'fail' });
    const blocked = record(['/p/a.ts'], { test_files: [gone], verdict: 'blocked' });
    const { kept, notes } = withoutAbsentTests([ok, absent, failed, blocked]);
    expect(kept).toEqual([ok, failed, blocked]); // a failure is not erased by a missing file
    expect(notes).toEqual([`The absent test record of 2026-10-27T01:02:03.000Z is not counted: its test file ${gone} is not in the working tree.`]);
    expect(withoutAbsentTests([record(['/p/a.ts'], { test_files: ['', ' '] })]).notes).toEqual([]);
  });

  test('when nothing remains the file is still unverified (the obligation stays), and the other record covers it', () => {
    const dir = tmp();
    const gone = join(dir, 'gone.test.ts');
    const only = [record(['/p/a.ts'], { test_files: [gone] })];
    const { kept } = withoutAbsentTests(only);
    expect(kept).toEqual([]);
    expect(validateTestCoverage(kept, [lastEdit('/p/a.ts')]).ok).toBe(false); // no result: not covered
    const present = write(dir, 'a.test.ts', 'x\n');
    const both = withoutAbsentTests([...only, record(['/p/a.ts'], { test_files: [present], timestamp: iso(40_000) })]);
    expect(validateTestCoverage(both.kept, [{ file: '/p/a.ts', lastEditTimestamp: iso(60_000) }]).ok).toBe(true);
  });
});

// ── R2 ───────────────────────────────────────────────────────────────────────────────────────

describe('R2: a coverage base other than the start counts per file, by the file\'s entry', () => {
  const rec = (a: string, base: string, cov: [number, number] = [1, 1]) => record([a], { timestamp: iso(500), tree: undefined, coverage: { status: 'measured', changed: changed({ 'a.ts': cov }, base) } });
  const run = (top: string, a: string, results: TestResult[], startHead: string | null) => changedLineGaps({ results, edits: [{ file: a, lastEditTimestamp: null }], top, exempt: [], startHead });

  test('the start itself, and a base where the file is the same blob and mode, are accepted', () => {
    const { top, head: start } = repo({ 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' });
    const a = join(top, 'a.ts');
    write(top, 'b.ts', 'export const b = 2;\n');
    sh(top, "git commit -qam 'ABC-1 b only'"); // a.ts is the same blob here
    const same = sh(top, 'git rev-parse HEAD');
    expect(run(top, a, [rec(a, start)], start)).toEqual({ measured: true, gaps: [] });
    expect(run(top, a, [rec(a, same)], start)).toEqual({ measured: true, gaps: [] });
  });

  test('an ancestor of the start where the file differs is refused (ancestry alone is not enough), and the reason names the base and the file', () => {
    const { top, head: c1 } = repo({ 'a.ts': 'export const a = 1;\n' });
    const a = join(top, 'a.ts');
    write(top, 'a.ts', 'export const a = 2;\n');
    sh(top, "git commit -qam 'ABC-1 a2'");
    const start = sh(top, 'git rev-parse HEAD');
    expect(sh(top, `git merge-base --is-ancestor ${c1} ${start} && echo yes`)).toBe('yes');
    const out = run(top, a, [rec(a, c1)], start);
    expect(out).toEqual({ measured: true, gaps: [{ file: 'a.ts', refusedBase: c1, head: start }] });
    const why = changedLineReason(out, 'cli.ts');
    expect(why).toContain(`a.ts (measured only against ${c1.slice(0, 12)}`);
    expect(why).toContain(`--base ${start}`);
  });

  test('a different mode is not the same entry', () => {
    const { top, head: c1 } = repo({ 'a.ts': 'export const a = 1;\n' });
    const a = join(top, 'a.ts');
    sh(top, 'chmod +x a.ts && git commit -qam "ABC-1 mode"');
    const start = sh(top, 'git rev-parse HEAD');
    expect(sh(top, `git rev-parse ${c1}:a.ts`)).toBe(sh(top, `git rev-parse ${start}:a.ts`)); // the same blob
    expect(run(top, a, [rec(a, c1)], start).gaps).toEqual([{ file: 'a.ts', refusedBase: c1, head: start }]);
  });

  test('absent at both the base and the start is the same entry; present at one of them is not', () => {
    const { top, head: c1 } = repo({ 'b.ts': 'export const b = 1;\n' });
    sh(top, "git commit -q --allow-empty -m 'ABC-1 empty'");
    const start = sh(top, 'git rev-parse HEAD');
    const a = write(top, 'a.ts', 'export const a = 1;\n'); // new in the session: in neither
    expect(run(top, a, [rec(a, c1)], start)).toEqual({ measured: true, gaps: [] });
    sh(top, 'git add a.ts && git commit -qm "ABC-1 a"');
    const later = sh(top, 'git rev-parse HEAD');
    expect(run(top, a, [rec(a, later)], start).gaps).toEqual([{ file: 'a.ts', refusedBase: later, head: start }]); // present at the base only
  });

  test('no commit at the start: only a base without the file counts', () => {
    const top = tmp();
    sh(top, GIT_INIT);
    const a = write(top, 'a.ts', 'export const a = 1;\n');
    sh(top, 'git add -A && git commit -qm "ABC-1 a"');
    const withFile = sh(top, 'git rev-parse HEAD');
    const noFile = sh(top, 'git hash-object -t tree /dev/null');
    expect(run(top, a, [rec(a, withFile)], null).gaps).toEqual([{ file: 'a.ts', refusedBase: withFile, head: null }]);
    expect(run(top, a, [rec(a, noFile)], null)).toEqual({ measured: true, gaps: [] });
    expect(changedLineReason(run(top, a, [rec(a, withFile)], null), 'cli.ts')).toContain('--base empty');
  });

  test('every content-matching record counts: an older one with full coverage beats a newer one that has none', () => {
    const { top, head: start } = repo({ 'a.ts': 'export const a = 1;\n' });
    const a = join(top, 'a.ts');
    const noCoverage = record([a], { timestamp: iso(500), tree: undefined }); // measured nothing
    const full = rec(a, start, [3, 3]);
    full.timestamp = iso(5_000);
    expect(run(top, a, [noCoverage, full], start)).toEqual({ measured: true, gaps: [] });
    expect(run(top, a, [full, noCoverage], start)).toEqual({ measured: true, gaps: [] });
    // A refused base next to an accepted one: the accepted record decides.
    write(top, 'a.ts', 'export const a = 2;\n');
    sh(top, "git commit -qam 'ABC-1 a2'");
    const refused = rec(a, start, [0, 3]);
    const accepted = rec(a, sh(top, 'git rev-parse HEAD'), [3, 3]);
    expect(run(top, a, [refused, accepted], sh(top, 'git rev-parse HEAD'))).toEqual({ measured: true, gaps: [] });
  });
});

// ── The branch note ──────────────────────────────────────────────────────────────────────────

describe('the branch note: a file that is an obligation only because HEAD left the start\'s line', () => {
  function branches() {
    const { top } = repo({ 'a.ts': 'export const a = 0;\n', 'b.ts': 'export const b = 0;\n' });
    sh(top, 'git checkout -q -b feat');
    write(top, 'a.ts', 'export const a = 1;\n');
    sh(top, "git commit -qam 'ABC-1 feat a'");
    return { top, start: sh(top, 'git rev-parse HEAD'), mainHead: sh(top, 'git rev-parse main') };
  }

  test('divergedFromStart lists the files equal to their merge-base blob, only after HEAD moved off the start', () => {
    const { top, start, mainHead } = branches();
    expect(divergedFromStart(top, start, ['a.ts', 'b.ts'])).toBeNull(); // HEAD is the start
    sh(top, 'git checkout -q main'); // a.ts is the base: it differs from the start only because of the switch
    write(top, 'b.ts', 'export const b = 5;\n'); // really edited
    const d = divergedFromStart(top, start, ['a.ts', 'b.ts'])!;
    expect(d.files).toEqual(['a.ts']);
    expect(d.mergeBase).toBe(mainHead);
    expect(d.head).toBe(mainHead);
    // The net-change check keeps both (they differ from the start blob), as before.
    expect(netChangedEdits([{ file: join(top, 'a.ts') }, { file: join(top, 'b.ts') }], top, start)).toHaveLength(2);
    expect(divergedFromStart(top, undefined, ['a.ts'])).toBeNull();
    expect(divergedFromStart(top, null, ['a.ts'])).toBeNull();
    expect(divergedFromStart(top, start, [])).toBeNull();
  });

  test('HEAD ahead of the start has nothing to say (its changes are the session\'s)', () => {
    const { top, start } = branches();
    write(top, 'a.ts', 'export const a = 2;\n');
    sh(top, "git commit -qam 'ABC-1 more'");
    expect(divergedFromStart(top, start, ['a.ts'])).toBeNull();
  });

  test('the Stop still blocks, and adds the note naming the file and the way out', async () => {
    const { top, start } = branches();
    const p = stopProject(top, start);
    sh(top, 'git checkout -q main'); // a.ts is the base now: a "change" against the start with no edit of the session's
    recordEdit(p.s, join(top, 'a.ts'), 0, undefined, Date.now());
    const out = await stop(p);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('(테스트 게이트)');
    expect(out.reason).toContain('Note: a.ts is an obligation only because HEAD');
    expect(out.reason).toContain('A new session started on this branch does not count it.');
    expect(out.reason).toContain('This still blocks.');
  }, 60_000);
});

// ── LCOV ─────────────────────────────────────────────────────────────────────────────────────

const REPORT = ['TN:', 'SF:/repo/src/a.ts', 'FNF:1', 'FNH:1', 'DA:1,1', 'DA:2,0', 'LF:2', 'LH:1', 'end_of_record', ''].join('\n');

describe('LCOV: isCompleteLcov, a bounded complete parse', () => {
  test('a report bun writes is complete; the parts of the format are accepted', async () => {
    const { isCompleteLcov } = await lcovModule();
    expect(isCompleteLcov(REPORT)).toBe(true);
    const full = ['TN:t', 'SF:/x/a.ts', 'FN:1,f', 'FNDA:2,f', 'FNF:1', 'FNH:1', 'BRDA:1,0,0,1', 'BRDA:1,0,1,-', 'BRF:2', 'BRH:1', 'DA:1,2,abc', 'LF:1', 'LH:1', 'end_of_record', 'SF:/x/b.ts', 'DA:1,0', 'end_of_record', ''].join('\n');
    expect(isCompleteLcov(full)).toBe(true);
  });

  test('truncated, forged, malformed and trailing content are not', async () => {
    const { isCompleteLcov } = await lcovModule();
    expect(isCompleteLcov('')).toBe(false);
    expect(isCompleteLcov(REPORT.slice(0, REPORT.indexOf('end_of_record')))).toBe(false); // cut before the end of its record
    expect(isCompleteLcov(REPORT.slice(0, -1))).toBe(false); // no final newline: cut at the end
    expect(isCompleteLcov(REPORT.slice(0, REPORT.indexOf('DA:2') + 3))).toBe(false); // cut in a line
    expect(isCompleteLcov('SF:/x/a.ts\n')).toBe(false); // an `SF:` prefix alone
    expect(isCompleteLcov('#!/bin/sh\nrm -rf x\n')).toBe(false);
    expect(isCompleteLcov(`#!/bin/sh\n${REPORT}`)).toBe(false); // a shebang before a valid report
    expect(isCompleteLcov(`${REPORT}echo hi\n`)).toBe(false); // trailing content
    expect(isCompleteLcov(`${REPORT}\n`)).toBe(false); // a blank line after the last record
    expect(isCompleteLcov(REPORT.replace('DA:1,1', 'DA:one,1'))).toBe(false); // a malformed line
    expect(isCompleteLcov(REPORT.replace('FNF:1', 'XYZ:1'))).toBe(false); // an unknown tag
    expect(isCompleteLcov(REPORT.replace('SF:/repo/src/a.ts\n', ''))).toBe(false); // a record with no source file
    expect(isCompleteLcov('DA:1,1\nend_of_record\n')).toBe(false);
    expect(isCompleteLcov(REPORT.replace(/\n/g, '\r\n'))).toBe(false);
    expect(isCompleteLcov(REPORT.replace('end_of_record\n', 'end_of_record\n\0'))).toBe(false);
    expect(isCompleteLcov(`SF:/x\nSF:/y\nend_of_record\n`)).toBe(false); // a record opened inside a record
    expect(isCompleteLcov(`SF:/${'x'.repeat(5_000)}\nend_of_record\n`)).toBe(false); // an over-long line
  });
});

describe('LCOV: the text of a complete report cannot be a script', () => {
  const rec = (...lines: string[]): string => [...lines, 'end_of_record', ''].join('\n');
  const wrap = (...mid: string[]): string => rec('TN:', 'SF:src/a.ts', ...mid, 'LF:1', 'LH:1');

  test('what bun, c8 and istanbul write is complete: paths with groups, brackets, scopes and spaces; function names of every kind', async () => {
    const { isCompleteLcov } = await lcovModule();
    const bun = rec('TN:', 'SF:src/(grp)/p.ts', 'FNF:1', 'FNH:1', 'DA:1,22', 'LF:1', 'LH:1') + rec('TN:', 'SF:src/[id]/p.ts', 'DA:1,22');
    expect(isCompleteLcov(bun)).toBe(true); // bun 1.3 writes these paths as they are
    for (const text of [
      wrap('FN:1,(anonymous_0)', 'FN:5,foo', 'FNDA:3,(anonymous_0)', 'FNDA:0,foo', 'FNF:2', 'FNH:1', 'DA:1,1'), // istanbul, nyc
      wrap('FN:3,(anonymous_12)', 'FNDA:1,(anonymous_12)'),
      wrap('FN:2,<instance_members_initializer>', 'FNDA:1,<instance_members_initializer>'), // c8 (V8)
      wrap('FN:2,Foo.bar', 'FN:3,get x', 'FN:4,#priv', 'FN:5,[Symbol.iterator]', 'FN:6,$id', 'FN:7,café'),
      wrap('FN:2,9,run', 'FNA:0,1,run'),
      wrap('DA:1,2,abcDEF0123456789+/abcd=='), // a base64 line checksum
      rec('TN:unit_tests-1', 'SF:/repo/node_modules/@scope/pkg-x/lib/a.b.js', 'DA:1,1'),
      rec('TN:', 'SF:src/my file.ts', 'DA:1,1'),
      rec('TN:', 'SF:app/routes/$id.tsx', 'DA:1,1'),
    ]) {
      expect([text, isCompleteLcov(text)]).toEqual([text, true]);
    }
  });

  test('a test name, a path, a function name or a checksum that makes code is refused (JavaScript, shell, others)', async () => {
    const { isCompleteLcov } = await lcovModule();
    const refused: string[] = [
      wrap("FNDA:1,require('child_process').execSync('id')"), // a call in a function name
      wrap('FNDA:1,process.exit(0)'),
      wrap('FN:1,eval(atob(x))'),
      wrap('FNDA:1,`${process.exit(1)}`'), // a template string
      wrap('FNDA:1,(function(){process.exit(0)})()'),
      wrap('FNDA:1,(anonymous_0)(1)'), // a call after the istanbul name
      wrap('FNDA:1,x(anonymous_0)'),
      wrap('FNDA:1,{a:process.exit(0)}'),
      wrap('FNDA:1,a//b'), // a comment
      wrap('FNDA:1,a<!--'), // an HTML comment (JavaScript)
      wrap('FNDA:1,$(id)'), // shell
      wrap('FNDA:1,`id`'),
      wrap('FNDA:1,a|sh'),
      wrap('FNDA:1,a&&id'),
      wrap('FNDA:1,a >b'), // a redirection that truncates a file
      wrap('FNDA:1,a<<EOF'),
      wrap('FNDA:1,${IFS}'),
      wrap('FNDA:1,<a>b'),
      wrap('FNDA:1,a\u2028b'), // a JavaScript line terminator
      wrap('FNDA:1,a+b'),
      wrap('FNDA:1,'),
      wrap('DA:1,1,x=process.exit(0)'), // an assignment in the checksum
      wrap('DA:1,1,a(b)'),
      wrap('DA:1,1,a;b'),
      wrap('DA:1,1,`x`'),
      rec('TN:process.exit(0)', 'SF:src/a.ts', 'DA:1,1'), // the test name
      rec('TN:x;process.exit(0)', 'SF:src/a.ts', 'DA:1,1'),
      rec('TN:a,b(1)', 'SF:src/a.ts', 'DA:1,1'),
      rec('TN:a=1', 'SF:src/a.ts', 'DA:1,1'),
      rec('TN:a;id', 'SF:src/a.ts', 'DA:1,1'),
      rec('TN:<?=`id`?>', 'SF:src/a.ts', 'DA:1,1'), // PHP
      rec('TN:', 'SF:/x/.test(process.exit(0))', 'DA:1,1'), // the source path
      rec('TN:', 'SF:a(process.exit(0))', 'DA:1,1'),
      rec('TN:', 'SF:(a)(b)', 'DA:1,1'), // a call after a group
      rec('TN:', 'SF:src/a(b)', 'DA:1,1'),
      rec('TN:', 'SF:(a)=>b', 'DA:1,1'),
      rec('TN:', 'SF:a[b](c)', 'DA:1,1'),
      rec('TN:', 'SF:src/((a))/p.ts', 'DA:1,1'),
      rec('TN:', 'SF:src/x(a)y/p.ts', 'DA:1,1'),
      rec('TN:', 'SF:src/(a b)/p.ts', 'DA:1,1'),
      rec('TN:', "SF:src/a'b.ts", 'DA:1,1'),
      rec('TN:', 'SF:src/a"b.ts', 'DA:1,1'),
      rec('TN:', 'SF:a=b', 'DA:1,1'),
      rec('TN:', 'SF:a:b', 'DA:1,1'),
      rec('TN:', 'SF:a;b', 'DA:1,1'),
      rec('TN:', 'SF:a?b:c', 'DA:1,1'),
      rec('TN:', 'SF:x>y', 'DA:1,1'),
      rec('TN:', 'SF:a\\b', 'DA:1,1'),
      rec('TN:', 'SF:$(id)', 'DA:1,1'),
      rec('TN:', 'SF:src/{a}/p.ts', 'DA:1,1'),
      rec('TN:', 'SF:a|b', 'DA:1,1'),
    ];
    for (const text of refused) expect([text, isCompleteLcov(text)]).toEqual([text, false]);
  });

  test('mutations of real reports with code-making characters: nothing accepted holds a quote, a brace, `;`, a call or an assignment', async () => {
    const { isCompleteLcov } = await lcovModule();
    const seeds = [
      'TN:\nSF:src/(grp)/a.ts\nFN:1,(anonymous_0)\nFNDA:1,(anonymous_0)\nFN:2,<instance_members_initializer>\nFNDA:0,Foo.bar\nFNF:2\nFNH:1\nDA:1,1,abcd==\nBRDA:1,0,0,1\nLF:1\nLH:1\nend_of_record\n',
      'TN:t_1\nSF:/abs/x y/[id]/p.ts\nFN:1,2,get x\nFNA:0,1,get x\nFNDA:3,[Symbol.iterator]\nDA:1,2\nend_of_record\n',
    ];
    const junk = ["'", '"', '`', ';', '=', '{', '}', '(', ')', '\\', '|', '&', '!', '?', '*', '<', '>', '/', '$', '+', '-', ',', ':', '[', ']', ' ', '\u2028', '#', '@', '~', '%', '.', '//', '/*', '=>', '${', '()', 'a(', ')(', '`x`', "('x')"];
    let state = 12345; // a fixed generator: the same cases every run
    const rnd = (n: number): number => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state % n;
    };
    let accepted = 0;
    for (let k = 0; k < 100_000; k++) {
      const lines = seeds[rnd(seeds.length)]!.split('\n');
      for (let m = 1 + rnd(3); m > 0; m--) {
        const i = rnd(lines.length - 1);
        const at = rnd(lines[i]!.length + 1);
        lines[i] = lines[i]!.slice(0, at) + junk[rnd(junk.length)]! + lines[i]!.slice(at + (rnd(3) === 0 ? 1 : 0));
      }
      const text = lines.join('\n');
      if (!isCompleteLcov(text)) continue;
      accepted++;
      expect(/['"`;{}\\|&!?*]/.test(text)).toBe(false);
      expect(text.split('\n').every((l) => !l.includes('=') || /^DA:[^=]*={1,2}$/.test(l))).toBe(true); // `=` only as base64 padding
      const open = text.replace(/(?<=^|[:,/])\(anonymous_\d+\)(?=\n)/gm, '').replace(/(?<=[/:])\([\p{L}\p{N}_.-]+\)(?=\/|\n)/gmu, '');
      expect(/[()]/.test(open)).toBe(false); // a parenthesis only as (anonymous_N) or around a whole path segment
    }
    expect(accepted).toBeGreaterThan(100); // the generator reaches accepted texts: the invariants above were checked
  });
});

describe('LCOV: isGeneratedLcov, the narrowed exemption (layer-1 scope)', () => {
  /** A repo with one commit (the start), plus a helper that writes a report. */
  function project() {
    const { top, head } = repo({ 'src/a.ts': 'export const a = 1;\n' });
    return { top, head, report: (name = 'lcov.info', text = REPORT) => write(top, `coverage/${name}`, text) };
  }
  const is = async (top: string, f: string, head: string | null | undefined): Promise<boolean> => (await lcovModule()).isGeneratedLcov(f, top, () => head);

  test('a valid report and its temp report, untracked and absent from the start, are exempt', async () => {
    const { top, head, report } = project();
    expect(await is(top, report(), head)).toBe(true);
    expect(await is(top, report('.lcov.info.12345.tmp'), head)).toBe(true);
    expect(await is(top, join(top, 'coverage', 'lcov.info'), head)).toBe(true); // an absolute path, as the edit log has it
  });

  test('inside a Stop snapshot the answer is computed once per report; outside one, every time', async () => {
    const { top, head, report } = project();
    const f = report();
    const { isGeneratedLcov } = await lcovModule();
    const { beginGitSnapshot, endGitSnapshot } = await import('../lib/git-run');
    let starts = 0;
    const start = (): string => (starts++, head);
    isGeneratedLcov(f, top, start);
    isGeneratedLcov(f, top, start);
    expect(starts).toBe(2); // no snapshot: nothing is kept
    starts = 0;
    beginGitSnapshot();
    try {
      expect([isGeneratedLcov(f, top, start), isGeneratedLcov(f, top, start), isGeneratedLcov(f, top, start)]).toEqual([true, true, true]);
      expect(starts).toBe(1); // the ls-files calls, the size check and the parse ran once
    } finally {
      endGitSnapshot();
    }
  });

  test('a report that cannot be read as UTF-8, or cannot be read at all, is not exempt', async () => {
    const { top, head, report } = project();
    // Bytes that are not UTF-8 in an otherwise complete report: the strict decode throws.
    const bad = join(top, 'coverage', 'lcov.info');
    mkdirSync(dirname(bad), { recursive: true });
    writeFileSync(bad, Buffer.concat([Buffer.from('TN:'), Buffer.from([0xff, 0xfe]), Buffer.from(REPORT.slice(3))]));
    expect(await is(top, bad, head)).toBe(false);
    // A report whose read fails (no read permission): the same answer, never a throw.
    const f = report('lcov.info', REPORT);
    expect(await is(top, f, head)).toBe(true);
    if (process.getuid?.() !== 0) {
      chmodSync(f, 0o000);
      try {
        expect(await is(top, f, head)).toBe(false);
      } finally {
        chmodSync(f, 0o644);
      }
    }
  });

  test('a report with no start commit counts (nothing was tracked); an unknown start does not', async () => {
    const top = tmp();
    sh(top, GIT_INIT);
    const f = write(top, 'coverage/lcov.info', REPORT);
    expect(await is(top, f, null)).toBe(true);
    expect(await is(top, f, undefined)).toBe(false);
    expect(await is(top, f, 'f'.repeat(40))).toBe(false); // a start git does not know: fail closed
  });

  test('a temp report that is truncated stays required; so do a forged one and one with a shebang', async () => {
    const { top, head, report } = project();
    expect(await is(top, report('.lcov.info.9.tmp', REPORT.slice(0, 40)), head)).toBe(false);
    expect(await is(top, report('lcov.info', REPORT.slice(0, REPORT.indexOf('end_of_record'))), head)).toBe(false);
    expect(await is(top, report('lcov.info', 'SF:/x\n'), head)).toBe(false);
    expect(await is(top, report('lcov.info', `#!/usr/bin/env bun\n${REPORT}`), head)).toBe(false);
    expect(await is(top, report('lcov.info', `${REPORT}console.log(1)\n`), head)).toBe(false);
    expect(await is(top, report('lcov.info', ''), head)).toBe(false);
  });

  test('names that are not the two: another file under coverage/, an unknown language, a nested directory, another temp shape', async () => {
    const { top, head, report } = project();
    expect(await is(top, report('helper.py', REPORT), head)).toBe(false); // unknown-language file under coverage/
    expect(await is(top, report('lcov-report.html', REPORT), head)).toBe(false);
    expect(await is(top, report('lcov.info.bak', REPORT), head)).toBe(false);
    expect(await is(top, report('.lcov.info..tmp', REPORT), head)).toBe(false); // an empty segment
    expect(await is(top, report('.lcov.info.a/b.tmp', REPORT), head)).toBe(false); // more than one segment
    expect(await is(top, report('LCOV.INFO', REPORT), head)).toBe(false);
    expect(await is(top, write(top, 'pkg/coverage/lcov.info', REPORT), head)).toBe(false); // nested elsewhere
    expect(await is(top, write(top, 'coverage/sub/lcov.info', REPORT), head)).toBe(false);
    expect(await is(top, write(top, 'lcov.info', REPORT), head)).toBe(false);
    expect(await is(top, join(tmp(), 'coverage', 'lcov.info'), head)).toBe(false); // outside the repo
  });

  test('a tracked report, a newly staged one, and one the start HEAD had are not exempt', async () => {
    const { top, head, report } = project();
    const f = report();
    sh(top, 'git add -f coverage/lcov.info'); // newly staged
    expect(await is(top, f, head)).toBe(false);
    sh(top, "git commit -qm 'ABC-1 report'");
    expect(await is(top, f, head)).toBe(false); // tracked now
    const committed = sh(top, 'git rev-parse HEAD');
    sh(top, 'git rm -q --cached coverage/lcov.info'); // untracked again, but the start has it
    expect(await is(top, f, committed)).toBe(false);
    expect(await is(top, f, head)).toBe(true); // the first start did not
  });

  test('links, an executable report and an oversized one are not exempt', async () => {
    const { top, head, report } = project();
    const real = write(tmp(), 'real.info', REPORT);
    mkdirSync(join(top, 'coverage'), { recursive: true });
    symlinkSync(real, join(top, 'coverage', 'lcov.info')); // a link to a valid report elsewhere
    expect(await is(top, join(top, 'coverage', 'lcov.info'), head)).toBe(false);
    rmSync(join(top, 'coverage'), { recursive: true });
    const elsewhere = tmp();
    mkdirSync(join(elsewhere, 'cov'), { recursive: true });
    writeFileSync(join(elsewhere, 'cov', 'lcov.info'), REPORT);
    symlinkSync(join(elsewhere, 'cov'), join(top, 'coverage')); // the coverage directory is a link
    expect(await is(top, join(top, 'coverage', 'lcov.info'), head)).toBe(false);
    rmSync(join(top, 'coverage'));
    const f = report();
    linkSync(f, join(top, 'second-name')); // a hard link: another name may be code
    expect(await is(top, f, head)).toBe(false);
    rmSync(join(top, 'second-name'));
    expect(await is(top, f, head)).toBe(true); // control: with one link it is
    chmodSync(f, 0o755);
    expect(await is(top, f, head)).toBe(false); // executable
    chmodSync(f, 0o644);
    const { MAX_LCOV_BYTES } = await lcovModule();
    // Over the byte bound, with few lines and every one of them valid: only the size can refuse it.
    const record = `SF:/${'x'.repeat(3_500)}\nend_of_record\n`;
    const big = record.repeat(Math.ceil(MAX_LCOV_BYTES / record.length) + 2);
    expect(big.length).toBeGreaterThan(MAX_LCOV_BYTES);
    expect((await lcovModule()).isCompleteLcov(big)).toBe(true); // a well-formed report, only too big
    expect(await is(top, report('lcov.info', big), head)).toBe(false); // oversized
    expect(await is(top, report('lcov.info', big.slice(0, MAX_LCOV_BYTES - 1000) + '\n'), head)).toBe(false); // (cut: not complete)
  });

  test('the line bound: 400 000 lines are read, one more is not', async () => {
    const { isCompleteLcov, MAX_LCOV_LINES } = await lcovModule();
    const lines = (n: number) => `SF:/x/a.ts\n${'DA:1,1\n'.repeat(n - 2)}end_of_record\n`; // n lines in all
    expect(isCompleteLcov(lines(MAX_LCOV_LINES))).toBe(true);
    expect(isCompleteLcov(lines(MAX_LCOV_LINES + 1))).toBe(false);
  });

  test('through the Stop: only the report changed, so layer 1 asks for nothing; the review still sees it', async () => {
    const { top, head, report } = project();
    const p = stopProject(top, head);
    const f = report();
    recordEdit(p.s, f, 0, undefined, Date.now());
    const out = await stop(p);
    expect(out.decision).toBe('block');
    expect(out.reason ?? '').not.toContain('(테스트 게이트)'); // no test record is asked for
    expect(out.reason ?? '').toMatch(/Review is required|review/i); // the review edit set keeps the file
    // A report under another name is code to layer 1 still.
    const q = stopProject(top, head);
    recordEdit(q.s, report('helper.py', 'print(1)\n'), 0, undefined, Date.now());
    const other = await stop(q);
    expect(other.decision).toBe('block');
    expect(other.reason ?? '').toContain('(테스트 게이트)');
  }, 60_000);
});

// ── onSkipped: exact counts, one cause each ──────────────────────────────────────────────────

describe('build copies: onSkipped counts every undecided candidate once, under one cause', () => {
  const V = (n: number) => `export const v = ${n};\n${'// pad\n'.repeat(n)}`;
  /** A repo where `target/` is ignored, with `n` tracked sources (distinct sizes) edited since the start and a
   *  byte-equal copy of each under target/. */
  function fixture(n: number) {
    const files: Record<string, string> = { '.gitignore': 'target/\n' };
    for (let i = 0; i < n; i++) files[`src/s${i}.js`] = 'export const s = 0;\n';
    const { top, head } = repo(files);
    const sources: string[] = [];
    const copies: string[] = [];
    for (let i = 0; i < n; i++) {
      sources.push(write(top, `src/s${i}.js`, V(i + 1)));
      copies.push(write(top, `target/c${i}.js`, V(i + 1)));
    }
    return { top, head, sources, copies };
  }
  type Skip = [number, string];
  const run = async (f: ReturnType<typeof fixture>, limits: Record<string, unknown>, changeSet?: () => readonly string[], more: string[] = []) => {
    const { buildCopies } = await import('../lib/build-copies');
    const skipped: Skip[] = [];
    const got = buildCopies([...f.sources, ...f.copies, ...more], f.top, f.head, changeSet, { budgetMs: 600_000, ...limits, onSkipped: (n, why) => skipped.push([n, why]) });
    return { got, skipped };
  };
  const total = (s: Skip[]) => s.reduce((n, [c]) => n + c, 0);

  test('the control: with room for everything every copy is decided and nothing is skipped', async () => {
    const f = fixture(4);
    const { got, skipped } = await run(f, {});
    expect(got.size).toBe(4);
    expect(skipped).toEqual([]);
  });

  test('the byte cap counts the copies already waiting for the tracked check too', async () => {
    const f = fixture(4);
    // Copy 0 (size s0) and its source are read; the cap refuses the read of copy 1.
    const size0 = Buffer.byteLength(V(1));
    const { got, skipped } = await run(f, { maxReadBytes: size0 * 2 });
    expect(got.size).toBe(0);
    expect(skipped).toEqual([[4, 'bytes']]); // copy 0 was found equal but not yet checked as tracked: undecided too
  });

  test('the candidate cap and a later byte cap are separate causes with disjoint counts', async () => {
    const f = fixture(5);
    const size0 = Buffer.byteLength(V(1));
    const { skipped } = await run(f, { maxCandidates: 3, maxReadBytes: size0 * 2 });
    expect(skipped).toEqual([
      [2, 'cap'],
      [3, 'bytes'],
    ]);
    expect(total(skipped)).toBe(5);
  });

  test('an injected clock that runs out in the first loop counts every candidate once, as the budget', async () => {
    const f = fixture(5);
    let t = 0;
    const { got, skipped } = await run(f, { budgetMs: 3, now: () => t++ }); // the third look at the clock is past the budget
    expect(got.size).toBe(0);
    expect(skipped).toEqual([[5, 'budget']]);
  });

  test('a clock that runs out after the ignore check counts the candidates that passed it, once', async () => {
    const f = fixture(4);
    let late = false;
    // The change set is listed after the ignore check: the clock jumps there, so the four copies that
    //   qualified (and no one else) are the ones left undecided when the next look at the clock finds it spent.
    const { got, skipped } = await run(f, { budgetMs: 1_000, now: () => (late ? 5_000 : 0) }, () => {
      late = true;
      return f.sources;
    });
    expect(got.size).toBe(0);
    expect(skipped).toEqual([[4, 'budget']]);
  });

  test('a .gitignore verdict that runs out of time is no refusal: the candidates are undecided, counted once as the budget', async () => {
    const f = fixture(3);
    const shim = installShim({ flagOn: 'ls-tree' });
    try {
      // The first `ls-tree` is the start of the verdict (the .gitignore at the start HEAD); the clock jumps after it, so the
      //   next call of the verdict has no time left and answers nothing.
      const { got, skipped } = await run(f, { budgetMs: 1_000, now: () => (existsSync(shim.flag) ? 5_000 : 0) });
      expect(got.size).toBe(0);
      expect(skipped).toEqual([[3, 'budget']]);
    } finally {
      shim.restore();
    }
  });

  test('a git that fails is its own cause, not the budget', async () => {
    const f = fixture(3);
    const { got, skipped } = await withGitShim({ failIgnore: true }, () => run(f, {}));
    expect(got.size).toBe(0);
    expect(skipped).toEqual([[3, 'git']]);
  });

  test('candidates decided before the stop are not counted: a deleted copy takes no slot, a tracked file is no copy', async () => {
    const f = fixture(3);
    rmSync(f.copies[0]!); // gone: decided at the first look
    const tracked = write(f.top, 'target/tracked.js', V(2));
    sh(f.top, 'git add -f target/tracked.js && git commit -qm "ABC-1 tracked"');
    const { got, skipped } = await run(f, { maxCandidates: 2 }, undefined, [tracked]);
    // Three plain files are left (two copies and the tracked one); the cap keeps two and names the third once.
    expect(skipped).toEqual([[1, 'cap']]);
    expect(got.size).toBe(2);
  });
});

/** A `git` first on PATH that passes everything to the real one, and can fail `check-ignore` (a git
 *  error, not a slow one) or touch a flag file when a call whose arguments hold `flagOn` starts (a
 *  test's clock reads the flag, so time can run out at exactly that call). */
function installShim(opts: { failIgnore?: boolean; flagOn?: string }): { flag: string; restore: () => void } {
  const dir = tmp('goodboy-i36c-shim-');
  const flag = join(dir, 'flag');
  writeFileSync(
    join(dir, 'git'),
    [
      '#!/bin/sh',
      'case "$*" in',
      '  *check-ignore*) [ -n "$GB_SHIM_FAIL_IGNORE" ] && exit 128 ;;',
      'esac',
      'if [ -n "$GB_SHIM_FLAG_ON" ]; then case "$*" in *"$GB_SHIM_FLAG_ON"*) : > "$GB_SHIM_FLAG" ;; esac; fi',
      'exec "$GB_SHIM_REAL" "$@"',
      '',
    ].join('\n'),
  );
  chmodSync(join(dir, 'git'), 0o755);
  const names = ['PATH', 'GB_SHIM_REAL', 'GB_SHIM_FAIL_IGNORE', 'GB_SHIM_FLAG', 'GB_SHIM_FLAG_ON'];
  const saved = names.map((n) => process.env[n]);
  process.env.GB_SHIM_REAL = Bun.which('git')!;
  if (opts.failIgnore) process.env.GB_SHIM_FAIL_IGNORE = '1';
  if (opts.flagOn) {
    process.env.GB_SHIM_FLAG = flag;
    process.env.GB_SHIM_FLAG_ON = opts.flagOn;
  }
  process.env.PATH = `${dir}:${process.env.PATH}`;
  return { flag, restore: () => names.forEach((n, i) => (saved[i] === undefined ? delete process.env[n] : (process.env[n] = saved[i]))) };
}
function withGitShim<T>(opts: { failIgnore?: boolean }, fn: () => Promise<T>): Promise<T> {
  const shim = installShim(opts);
  return fn().finally(shim.restore);
}

// ── Unicode ──────────────────────────────────────────────────────────────────────────────────

describe('Unicode: git\'s spelling is kept; NFC and NFD are one file only when the file system says so', () => {
  const NFC = 'caf\u00e9.ts';
  const NFD = 'cafe\u0301.ts';

  test('sameFileSpelling: exact first; a twin only with file-system identity; never two candidates', async () => {
    const { sameFileSpelling } = await spellingModule();
    expect(sameFileSpelling('/r', NFC, [NFC, 'x'], () => false)).toBe(NFC); // exact: no question asked
    expect(sameFileSpelling('/r', NFD, [NFC], () => true)).toBe(NFC); // the file system says one file
    expect(sameFileSpelling('/r', NFD, [NFC], () => false)).toBeNull(); // Linux: two files
    expect(sameFileSpelling('/r', 'plain.ts', ['other.ts'], () => true)).toBeNull(); // ASCII has no twin
    expect(sameFileSpelling('/r', NFD, [NFC, NFC], () => true)).toBe(NFC);
    expect(sameFileSpelling('/r', NFD, [NFC, 'caf\u00e9.ts\u0000'], () => true)).toBe(NFC); // not a twin: another name
    expect(sameFileSpelling('/r', 'x', [], () => true)).toBeNull();
    // Two names that are both the request's twin: ambiguous, never guessed (U+00C5 and U+212B are both NFC \u00c5).
    expect(sameFileSpelling('/r', 'A\u030a.ts', ['\u00c5.ts', '\u212b.ts'], () => true)).toBeNull();
  });

  test('the file-system comparison fails closed when a path cannot be examined', async () => {
    const { sameFileSpelling, hasSpelling } = await spellingModule();
    const top = tmp();
    // The default comparison (no injected one) asks the file system: neither spelling exists.
    expect(sameFileSpelling(top, NFD, [NFC])).toBeNull();
    expect(hasSpelling(top, NFD, [NFC])).toBe(false);
    // The directory itself is gone.
    expect(sameFileSpelling(join(top, 'missing-dir'), NFD, [NFC])).toBeNull();
  });

  test('git reads and compares a file named in the other form only when the file is the same on disk', () => {
    const top = tmp();
    sh(top, GIT_INIT);
    write(top, NFC, 'export const a = 1;\n');
    sh(top, "git add -A && git commit -q -m 'ABC-1 u'");
    const head = sh(top, 'git rev-parse HEAD');
    const entries = treeEntries(top, head, [NFD]);
    if (process.platform === 'darwin') {
      // The file system keeps one file for both spellings; git precomposes to NFC.
      expect(entries!.has(NFD)).toBe(true);
      expect([...differFromBase(top, head, [NFD])]).toEqual([]); // unchanged: the same file, the same blob
      write(top, NFC, 'export const a = 2;\n');
      expect([...differFromBase(top, head, [NFD])]).toEqual([NFD]);
    } else {
      // Linux: the NFD name is another file (here, none): nothing to merge.
      expect(entries!.has(NFD)).toBe(false);
      writeFileSync(join(top, NFD), 'export const other = 1;\n'); // a distinct file with the twin's name
      expect(treeEntries(top, head, [NFD])!.has(NFD)).toBe(false); // the tracked NFC file is not this one
      expect([...differFromBase(top, head, [NFD])]).toEqual([NFD]);
    }
  });

  test('a record and the edit log may spell a path differently: the coverage check meets them on macOS, never merges on Linux', () => {
    const top = tmp();
    sh(top, GIT_INIT);
    const nfc = write(top, NFC, 'export const a = 1;\n');
    sh(top, "git add -A && git commit -q -m 'ABC-1 u'");
    const tree = treeNow(top);
    const r = record([nfc], { timestamp: iso(500), tree }); // the record names the NFC spelling
    const edit = { file: join(top, NFD), lastEditTimestamp: iso(60_000) }; // the log names the NFD one
    const edits = withSameContent([edit], [r], top);
    const covered = validateTestCoverage([r], edits);
    expect(covered.ok).toBe(process.platform === 'darwin');
    if (process.platform !== 'darwin') expect(covered.reason).toContain('테스트되지 않은 변경 파일'); // a different file: nothing covers it
  });
});

// ── The Stop hook ────────────────────────────────────────────────────────────────────────────

interface StopProject {
  d: string;
  s: string;
}
let counter = 0;
/** The session pinned at `head` (the start HEAD), its dir cleaned after the test. */
function stopProject(d: string, head: string): StopProject {
  const s = `i36c${Math.random().toString(36).slice(2, 10)}${counter++}`;
  dirs.push(join(tmpdir(), `goodboy-session-${s}`));
  pinCoverageStart(s, d);
  void head;
  return { d, s };
}
interface Out {
  decision?: string;
  reason?: string;
  systemMessage?: string;
}
async function stop(p: StopProject, env: Record<string, string> = {}): Promise<Out> {
  const proc = Bun.spawn(['bun', STOP], {
    cwd: p.d,
    stdin: new TextEncoder().encode(JSON.stringify({ cwd: p.d, session_id: p.s, hook_event_name: 'Stop', stop_hook_active: false })),
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: p.d,
      GOODBOY_TEST_GATE: 'on',
      GOODBOY_DISABLE_DELEGATION: '1',
      GOODBOY_CLAIM_FLUSH_WAIT_MS: '0',
      GOODBOY_DOCS_GATE: 'off',
      ...env,
    },
  });
  const text = (await new Response(proc.stdout).text()) || '{}';
  await proc.exited;
  return JSON.parse(text) as Out;
}

describe('through the Stop: a good record counts whatever it stands behind, and a record whose test is gone does not', () => {
  /** A project with a committed a.ts and its test; a.ts edited (the session's change). */
  function project() {
    const { top, head } = repo({
      '.gitignore': '.claude/\n',
      'package.json': '{"name":"x","scripts":{"test":"bun test"}}\n',
      'src/a.ts': 'export const a = 1;\n',
      'tests/a.test.ts': 'import { a } from "../src/a";\nimport { test, expect } from "bun:test";\ntest("a", () => expect(a).toBe(1));\n',
    });
    const p = stopProject(top, head);
    const src = write(top, 'src/a.ts', 'export const a = 1;\nexport const b = 2;\n');
    recordEdit(p.s, src, 0, undefined, Date.now());
    return { p, top, src, head };
  }
  function put(top: string, name: string, rec: Record<string, unknown>): void {
    write(top, `.claude/tests/${name}.json`, JSON.stringify(rec));
  }
  function good(top: string, src: string, over: Record<string, unknown> = {}): Record<string, unknown> {
    const state = workTreeState(top);
    return {
      timestamp: new Date(Date.now() + 5_000).toISOString(),
      commit: state.commit,
      tree: state.tree,
      tested_files: [src],
      category: 'fix-bug',
      test_files: [join(top, 'tests', 'a.test.ts')],
      environment: { mode: 'none', command: 'none', evidence: 'library' },
      suites: [{ name: 'unit', command: 'bun test', passed: 1, failed: 0, output: '1 pass', type: 'unit', duration_ms: 10 }],
      acceptance: [
        {
          id: 'AC-1',
          description: 'b is exported',
          test: 'tests/a.test.ts',
          red: { command: 'bun test (before)', output: '1 fail', exit_code: 1 },
          green: { command: 'bun test', output: '1 pass', exit_code: 0 },
        },
      ],
      verdict: 'pass',
      ...over,
    };
  }
  const env = { GOODBOY_DIFF_COVERAGE: 'off' };

  test('control: one good record passes the test gate', async () => {
    const { p, top, src } = project();
    put(top, 'good', good(top, src));
    const out = await stop(p, env);
    expect(out.decision === 'block' && (out.reason ?? '').includes('(테스트 게이트)')).toBe(false);
  }, 60_000);

  test('a newer record whose test file is gone is not counted, and does not block next to a good one', async () => {
    const { p, top, src } = project();
    put(top, 'good', good(top, src, { timestamp: new Date(Date.now() + 5_000).toISOString() }));
    put(top, 'probe', good(top, src, { timestamp: new Date(Date.now() + 10_000).toISOString(), test_files: [join(top, 'tests', 'probe-gone.test.ts')], category: 'probe' }));
    const out = await stop(p, env);
    expect(out.decision === 'block' && (out.reason ?? '').includes('(테스트 게이트)')).toBe(false);
    expect(out.reason ?? '').not.toContain('test_files에 적힌 파일이 존재하지 않습니다');
  }, 60_000);

  test('a record whose test file is gone, alone, leaves the file unverified: it blocks, with the note', async () => {
    const { p, top, src } = project();
    put(top, 'probe', good(top, src, { test_files: [join(top, 'tests', 'probe-gone.test.ts')], category: 'probe' }));
    const out = await stop(p, env);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('(테스트 게이트)');
    expect(out.reason).toContain('The probe test record of');
    expect(out.reason).toContain('probe-gone.test.ts is not in the working tree');
  }, 60_000);

  test('a git checkout after the record: the newer record is no evidence for the content that came back', async () => {
    const { p, top, src } = project();
    put(top, 'good', good(top, src));
    sh(top, 'git stash -q'); // a.ts is the committed content again, with no edit in the log
    const out = await stop(p, env);
    // The edit of the session now equals the start blob: it is no change, and nothing is asked. The
    // content rule is for a change that is still one: edit the file to something else.
    expect(out.decision === 'block' && (out.reason ?? '').includes('(테스트 게이트)')).toBe(false);
    write(top, 'src/a.ts', 'export const a = 1;\nexport const c = 3;\n');
    const q = await stop(p, env);
    expect(q.decision).toBe('block');
    expect(q.reason).toContain('(테스트 게이트)');
    expect(q.reason).toContain('마지막 편집보다 오래된'); // the record ran other content
  }, 60_000);

  test('R2 through the Stop: an older record with full coverage counts next to a newer one that measured nothing', async () => {
    const { p, top, src } = project();
    const cov = { status: 'measured', changed: { covered: 1, total: 1, files_without_executed_changes: [], files: { 'src/a.ts': { covered: 1, total: 1 } }, in_report: ['src/a.ts'], diff_lines: { 'src/a.ts': 1 }, base: sh(top, 'git rev-parse HEAD') } };
    put(top, 'full', good(top, src, { timestamp: new Date(Date.now() + 5_000).toISOString(), coverage: cov }));
    put(top, 'none', good(top, src, { timestamp: new Date(Date.now() + 10_000).toISOString() }));
    const out = await stop(p, { GOODBOY_DIFF_COVERAGE: 'on' });
    expect(out.decision === 'block' && (out.reason ?? '').includes('(테스트 게이트)')).toBe(false);
  }, 60_000);
});

// ── A file the record tree cannot show: git-ignored code, kept by the record as `extra_blobs` ──

/** Runs a CLI command in this process, with its stdout and stderr captured. */
async function captured(fn: () => Promise<void>): Promise<string> {
  const o = process.stdout.write;
  const e = process.stderr.write;
  let out = '';
  process.stdout.write = ((c: string | Uint8Array) => ((out += String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
  return out;
}

describe('extra_blobs: an edited git-ignored code file is evidenced by a record that names it', () => {
  const IGNORED = '.claude/\nscripts/\nlinkdir\n.env.local\n';
  /** A project whose `scripts/` is ignored: local.js is the session's edit, in no record tree. */
  function project() {
    const { top, head } = repo({
      '.gitignore': IGNORED,
      'package.json': '{"name":"x","scripts":{"test":"bun test"}}\n',
      'src/a.ts': 'export const a = 1;\n',
      'tests/a.test.ts': 'import { a } from "../src/a";\nimport { test, expect } from "bun:test";\ntest("a", () => expect(a).toBe(1));\n',
    });
    const p = stopProject(top, head);
    const local = write(top, 'scripts/local.js', 'module.exports = 1;\n');
    recordEdit(p.s, local, 0, undefined, Date.now());
    return { p, top, local };
  }
  const testInput = (top: string, tested: string[], extra: Record<string, unknown> = {}) => ({
    timestamp: new Date().toISOString(),
    tested_files: tested,
    category: 'fix-bug',
    test_files: [join(top, 'tests', 'a.test.ts')],
    environment: { mode: 'none', command: 'none', evidence: 'library' },
    suites: [{ name: 'unit', command: 'bun test', passed: 1, failed: 0, output: '1 pass', type: 'unit', duration_ms: 10 }],
    acceptance: [{ id: 'AC-1', description: 'd', test: 'tests/a.test.ts', red: { command: 'c', output: 'o', exit_code: 1 }, green: { command: 'c', output: 'o', exit_code: 0 } }],
    verdict: 'pass',
    ...extra,
  });
  const reviewInput = (files: string[], extra: Record<string, unknown> = {}) => ({
    timestamp: new Date().toISOString(),
    reviewed_files: files,
    category: 'fix-bug',
    findings: [],
    unknown_assumptions_checked: [],
    verdict: 'pass',
    dimensions_checked: ['plan-completeness'],
    ...extra,
  });
  const inputFile = (body: unknown): string => write(tmp('goodboy-i36x-in-'), 'in.json', JSON.stringify(body));
  /** test-write through the CLI function; the saved record and its path. */
  async function testWrite(top: string, body: unknown): Promise<{ saved: Record<string, unknown>; path: string }> {
    const { cmdTestWrite } = await import('../lib/cli');
    const path = (JSON.parse(await captured(() => cmdTestWrite(top, [inputFile(body)]))) as { path: string }).path;
    return { saved: JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>, path };
  }
  async function reviewWrite(top: string, body: unknown): Promise<Record<string, unknown>> {
    const { cmdReviewWrite } = await import('../lib/cli');
    const path = (JSON.parse(await captured(() => cmdReviewWrite(top, [inputFile(body)]))) as { path: string }).path;
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  }
  const blobOf = (top: string, rel: string): string => sh(top, `git hash-object -- ${rel}`);
  const env = { GOODBOY_DIFF_COVERAGE: 'off' };
  const testGateBlock = (o: Out): boolean => o.decision === 'block' && (o.reason ?? '').includes('(테스트 게이트)');

  test('test-write keeps the id of the ignored file; the Stop accepts it', async () => {
    const { p, top, local } = project();
    const { saved } = await testWrite(top, testInput(top, ['scripts/local.js']));
    expect(saved.extra_blobs).toEqual({ [local]: blobOf(top, 'scripts/local.js') });
    expect(testGateBlock(await stop(p, env))).toBe(false);
  }, 60_000);

  test('the control: the same record with no extra_blobs leaves the file unverified and blocks (the regression)', async () => {
    const { p, top, local } = project();
    const { saved, path } = await testWrite(top, testInput(top, ['scripts/local.js']));
    delete saved.extra_blobs;
    writeFileSync(path, JSON.stringify(saved));
    const out = await stop(p, env);
    expect(testGateBlock(out)).toBe(true);
    expect(out.reason).toContain(local);
  }, 60_000);

  test('an edit after the record is stale; the id of the old content is no evidence for the new', async () => {
    const { p, top, local } = project();
    await testWrite(top, testInput(top, ['scripts/local.js']));
    write(top, 'scripts/local.js', 'module.exports = 2;\n');
    recordEdit(p.s, local, 1, undefined, Date.now());
    const out = await stop(p, env);
    expect(testGateBlock(out)).toBe(true);
    expect(out.reason).toContain('마지막 편집보다 오래된');
    expect(out.reason).toContain(local);
  }, 60_000);

  test('an edit that is undone (the same content again) is evidenced again, whatever the time says', async () => {
    const { p, top, local } = project();
    await testWrite(top, testInput(top, ['scripts/local.js']));
    write(top, 'scripts/local.js', 'module.exports = 2;\n');
    recordEdit(p.s, local, 1, undefined, Date.now());
    write(top, 'scripts/local.js', 'module.exports = 1;\n');
    recordEdit(p.s, local, 2, undefined, Date.now());
    expect(testGateBlock(await stop(p, env))).toBe(false);
  }, 60_000);

  test('an extra_blobs the agent supplies is dropped: only the ids test-write and review-write compute are kept', async () => {
    const { top, local } = project();
    const other = write(top, 'scripts/other.js', 'module.exports = 3;\n');
    const forged = { [local]: 'f'.repeat(40), [other]: blobOf(top, 'scripts/other.js'), [join(top, 'src', 'a.ts')]: 'e'.repeat(40) };
    const { saved } = await testWrite(top, testInput(top, ['scripts/local.js'], { extra_blobs: forged }));
    expect(saved.extra_blobs).toEqual({ [local]: blobOf(top, 'scripts/local.js') }); // not the forged id, not the unlisted file
    const rev = await reviewWrite(top, reviewInput(['scripts/local.js'], { extra_blobs: forged }));
    expect(rev.extra_blobs).toEqual({ [local]: blobOf(top, 'scripts/local.js') });
    // A listed file with nothing to keep gets no key at all, whatever the agent sent.
    const none = await testWrite(top, testInput(top, ['src/a.ts'], { extra_blobs: forged }));
    expect('extra_blobs' in none.saved).toBe(false);
  }, 60_000);

  test('the count cap: past it the rest are left out (fail closed), in the order listed', async () => {
    const { top } = project();
    const files = Array.from({ length: 5 }, (_, i) => write(top, `scripts/f${i}.js`, `module.exports = ${i};\n`));
    const { extraBlobsFor } = await import('../lib/changed-coverage');
    const tree = treeNow(top);
    const some = extraBlobsFor(top, tree, files, { files: 3 })!;
    expect(Object.keys(some)).toEqual(files.slice(0, 3));
    expect(some[files[0]!]).toBe(blobOf(top, 'scripts/f0.js'));
    expect(Object.keys(extraBlobsFor(top, tree, files)!)).toEqual(files); // the default cap holds these
    // The default cap, through test-write: 70 ignored files are listed, 64 are kept.
    const many = Array.from({ length: 70 }, (_, i) => write(top, `scripts/m${i}.js`, `module.exports = ${i};\n`));
    const { saved } = await testWrite(top, testInput(top, many));
    expect(Object.keys(saved.extra_blobs as object)).toEqual(many.slice(0, 64));
  }, 60_000);

  test('the byte cap: files are taken in order while their sizes fit; the rest are left out and stay unverified', async () => {
    const { p, top, local } = project();
    const sizes = [6, 6, 6, 1];
    const files = sizes.map((n, i) => write(top, `scripts/b${i}.js`, 'x'.repeat(n)));
    const { extraBlobsFor } = await import('../lib/changed-coverage');
    const tree = treeNow(top);
    expect(Object.keys(extraBlobsFor(top, tree, files, { bytes: 13 })!)).toEqual(files.slice(0, 2)); // 6 + 6 = 12; the third would make 18
    expect(extraBlobsFor(top, tree, files, { bytes: 3 })).toBeUndefined(); // nothing fits
    // At the Stop a file with no entry is unverified (the default byte cap is 8 MiB; the shared limit
    // on one file is the hash limit): here the entry is simply absent from the record.
    const { saved, path } = await testWrite(top, testInput(top, ['scripts/local.js']));
    saved.extra_blobs = {};
    writeFileSync(path, JSON.stringify(saved));
    const out = await stop(p, env);
    expect(testGateBlock(out)).toBe(true);
    expect(out.reason).toContain(local);
  }, 60_000);

  test('a symlink, a hard link, a file reached through a link out of the repo, and a file outside are not hashed', async () => {
    const { top, local } = project();
    const outsideDir = tmp('goodboy-i36x-out-');
    const out = write(outsideDir, 'x.js', 'module.exports = 9;\n');
    const sym = join(top, 'scripts', 'sym.js');
    symlinkSync(local, sym);
    const orig = write(top, 'scripts/orig.js', 'module.exports = 4;\n');
    const hard = join(top, 'scripts', 'hard.js');
    linkSync(orig, hard);
    symlinkSync(outsideDir, join(top, 'linkdir'));
    const via = join(top, 'linkdir', 'x.js');
    const { extraBlobsFor } = await import('../lib/changed-coverage');
    const got = extraBlobsFor(top, treeNow(top), [sym, orig, hard, via, out, local]);
    expect(got).toEqual({ [local]: blobOf(top, 'scripts/local.js') }); // only the plain single-link file inside
  }, 60_000);

  test('a tracked file is still judged by the tree: its id is not kept, and a forged one in a record is not read', async () => {
    const { top } = project();
    const a = join(top, 'src', 'a.ts');
    const { saved } = await testWrite(top, testInput(top, ['src/a.ts']));
    expect('extra_blobs' in saved).toBe(false);
    // The record's tree holds a.ts = 1. a.ts is edited after it, and a record that carries the new
    // content's id for it (hand-written: the CLI never writes one) is still stale: the tree lists it.
    write(top, 'src/a.ts', 'export const a = 2;\n');
    const tree = saved.tree as string;
    const r = record([a], { tree, extra_blobs: { [a]: blobOf(top, 'src/a.ts') } });
    expect(freshness(r, withSameContent([lastEdit(a)], [r], top)[0]!)).toBe('stale');
    // For an ignored file the same record is fresh only through its own entry.
    const local = join(top, 'scripts', 'local.js');
    const state = (extra?: unknown): ReturnType<typeof freshness> => {
      const rec = record([local], { tree, ...(extra === undefined ? {} : { extra_blobs: extra as Record<string, string> }) });
      return freshness(rec, withSameContent([lastEdit(local)], [rec], top)[0]!);
    };
    expect(state({ [local]: blobOf(top, 'scripts/local.js') })).toBe('fresh');
    expect(state()).toBe('stale');
    expect(state({ [local]: 'a'.repeat(40) })).toBe('stale');
    expect(state([local])).toBe('stale');
  }, 60_000);

  test('a record whose tree git cannot read is unverified even with an extra_blobs entry', async () => {
    const { top, local } = project();
    const r = record([local], { tree: 'f'.repeat(40), extra_blobs: { [local]: blobOf(top, 'scripts/local.js') } });
    expect(freshness(r, withSameContent([lastEdit(local)], [r], top)[0]!)).toBe('unverified');
  }, 60_000);

  test('the review side: review-write keeps the id, and the review covers the ignored file by content', async () => {
    const { top, local } = project();
    const saved = (await reviewWrite(top, reviewInput(['scripts/local.js']))) as unknown as ReviewResult;
    expect(saved.extra_blobs).toEqual({ [local]: blobOf(top, 'scripts/local.js') });
    const covers = (rec: ReviewResult): ReturnType<typeof validateReviewCoverage> =>
      validateReviewCoverage([rec], withSameContent([lastEdit(local, 60_000)], [rec], top, (x) => x.reviewed_files));
    expect(covers(saved).ok).toBe(true);
    const old = { ...saved, extra_blobs: undefined } as ReviewResult; // a review with no entry could never cover it
    expect(covers(old).ok).toBe(false);
    write(top, 'scripts/local.js', 'module.exports = 2;\n');
    const stale = covers(saved);
    expect(stale.ok).toBe(false);
    expect(stale.stale).toEqual([local]);
  }, 60_000);

  test('the push check is unaffected: it reads `tree` only, and the hand-off tree has no ignored file', async () => {
    const { top } = project();
    const { saved } = await testWrite(top, testInput(top, ['scripts/local.js']));
    expect(saved.tree).toBe(treeNow(top)); // the ignored file is in no tree
    expect(sh(top, `git ls-tree -r --name-only ${saved.tree as string}`)).not.toContain('scripts/local.js');
    expect(readFileSync(join(ROOT, 'lib', 'push-test.ts'), 'utf8')).not.toContain('extra_blobs');
  }, 60_000);
});
