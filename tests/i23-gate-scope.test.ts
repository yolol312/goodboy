// #23 The test gate judges this session's change only: a file whose content is its blob at the
// session-start HEAD is no change (netChangedEdits); a record made on the content a file has
// now is fresh whenever it was made (freshFor, withSameContent); the forbidden-pattern scan
// counts only lines added since the start; a file a test runs only as a process counts on the
// record's subprocess evidence (subprocessEvidence, coverage.subprocess). These tests drive the
// real functions over real temporary git repos and files (integration: git and the CLI run for
// real). The Stop hook side is tests/i23-gate-scope-stop.test.ts.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { changedLines } from '../lib/diff-coverage';
import { changedLineGaps, differFromBase, netChangedEdits, subprocessEvidence, withSameContent } from '../lib/changed-coverage';
import { affectedGaps } from '../lib/existing-tests';
import type { ChangedFileEdit } from '../lib/review-validator';
import { missingTestTypes, recordStandsAlone } from '../lib/test-types';
import { freshFor, freshness, scanForbiddenPatterns, stripLiteralsAndComments, validateTestCoverage } from '../lib/test-validator';
import type { TestResult } from '../lib/types';

const ROOT = resolve(import.meta.dir, '..');
const CLI = join(ROOT, 'lib', 'cli.ts');
const BASE = 'a'.repeat(40);
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-i23-')));
  dirs.push(d);
  return d;
}
const sh = (cwd: string, cmd: string) => Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe' }).stdout.toString().trim();
function write(root: string, rel: string, text: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}
/** A repo with the files committed (the session's start); returns top, the commit and its tree. */
function repo(files: Record<string, string>): { top: string; head: string; tree: string } {
  const top = tmp();
  sh(top, 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false');
  for (const [f, t] of Object.entries(files)) write(top, f, t);
  sh(top, "git add -A && git commit -q -m 'ABC-1 start'");
  return { top, head: sh(top, 'git rev-parse HEAD'), tree: sh(top, 'git rev-parse HEAD^{tree}') };
}
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();

type Changed = NonNullable<NonNullable<TestResult['coverage']>['changed']>;
const changed = (files: Record<string, [number, number]>, inReport: string[] = Object.keys(files), diff?: Record<string, number>): Changed => ({
  covered: Object.values(files).reduce((s, [c]) => s + c, 0),
  total: Object.values(files).reduce((s, [, t]) => s + t, 0),
  files_without_executed_changes: [],
  files: Object.fromEntries(Object.entries(files).map(([f, [c, t]]) => [f, { covered: c, total: t }])),
  in_report: inReport,
  diff_lines: diff ?? Object.fromEntries([...new Set([...Object.keys(files), ...inReport])].map((f) => [f, 1])),
  base: BASE,
});
/** A passing integration-typed record that tests `tested` and lists `testFiles`. */
function record(tested: string[], over: Partial<TestResult> = {}): TestResult {
  return {
    timestamp: iso(1_000),
    tested_files: tested,
    category: 'fix-bug',
    test_files: [],
    environment: { mode: 'none' },
    suites: [{ name: 's', command: 'bun test', passed: 2, failed: 0, output: '2 pass', type: 'integration', duration_ms: 5 }],
    acceptance: [],
    verdict: 'pass',
    ...over,
  } as TestResult;
}

describe('net change: netChangedEdits', () => {
  test('a file equal to its start blob is dropped; changed, new, deleted and outside files are kept', () => {
    const { top, head } = repo({ 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' });
    write(top, 'a.ts', 'export const a = 2;\n'); // edited ...
    write(top, 'a.ts', 'export const a = 1;\n'); // ... and undone
    write(top, 'b.ts', 'export const b = 2;\n'); // really changed
    write(top, 'new.ts', 'export const n = 1;\n'); // untracked: absent at the start
    const outside = write(tmp(), 'x.ts', 'export const x = 1;\n');
    const edits = ['a.ts', 'b.ts', 'new.ts', 'gone.ts'].map((f) => ({ file: join(top, f), lastEditTimestamp: iso() }));
    edits.push({ file: outside, lastEditTimestamp: iso() });
    const kept = netChangedEdits(edits, top, head);
    expect(kept.map((e) => e.file)).toEqual([join(top, 'b.ts'), join(top, 'new.ts'), join(top, 'gone.ts'), outside]);
    // The objects themselves come back (their other fields stay).
    expect(kept[0]).toBe(edits[1]!);
  });

  test('an unknown start (undefined, null), no edits, a start git does not know: everything is kept', () => {
    const { top, head } = repo({ 'a.ts': 'export const a = 1;\n' });
    const edits = [{ file: join(top, 'a.ts') }]; // equals its start blob
    expect(netChangedEdits(edits, top, undefined)).toBe(edits);
    expect(netChangedEdits(edits, top, null)).toBe(edits);
    expect(netChangedEdits([], top, head)).toEqual([]);
    expect(netChangedEdits(edits, top, 'f'.repeat(40))).toEqual(edits); // git fails: fail-open
    expect(netChangedEdits(edits, top, head)).toEqual([]); // control: with the real start it is dropped
  });

  test('committed since the start still counts; a branch switch that brings the start content back does not', () => {
    const { top, head } = repo({ 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' });
    sh(top, 'git checkout -q -b feat');
    write(top, 'a.ts', 'export const a = 2;\n');
    write(top, 'b.ts', 'export const b = 2;\n');
    sh(top, "git commit -qam 'ABC-1 feat'");
    const edits = [{ file: join(top, 'a.ts') }, { file: join(top, 'b.ts') }];
    expect(netChangedEdits(edits, top, head)).toHaveLength(2); // both differ from the start while on feat
    sh(top, 'git checkout -q main'); // both are the start blobs again
    expect(netChangedEdits(edits, top, head)).toEqual([]);
  });
});

describe('net change: files git cannot hash safely', () => {
  /** Runs `body` (it uses TOP, HEAD and F from the environment) in a child that is killed after 20 s. */
  function child(body: string, env: Record<string, string>): { ms: number; out: string; code: number | null } {
    const t0 = Date.now();
    const p = Bun.spawnSync(['bun', '-e', `import { netChangedEdits } from ${JSON.stringify(join(ROOT, 'lib/changed-coverage'))}; import { scanForbiddenPatterns } from ${JSON.stringify(join(ROOT, 'lib/test-validator'))}; ${body}`], {
      env: { ...process.env, ...env },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 20_000,
    });
    return { ms: Date.now() - t0, out: p.stdout.toString().trim(), code: p.exitCode };
  }

  test('a symlink with the start content, and a FIFO, are not hashed and count as changed, promptly', () => {
    const { top, head } = repo({ 'a.ts': 'x\n', 'target.txt': 'x\n', 'b.ts': 'y\n' });
    const a = join(top, 'a.ts');
    const run = () => child('console.log(JSON.stringify(netChangedEdits([{ file: process.env.F! }], process.env.TOP!, process.env.HEAD!).map((e) => e.file)))', { TOP: top, HEAD: head, F: a });
    // Control: the regular file with the start content is no change.
    expect(run().out).toBe('[]');
    rmSync(a);
    symlinkSync('target.txt', a); // reads as the start content, but is a link
    const link = run();
    expect(link.code).toBe(0);
    expect(link.out).toBe(JSON.stringify([a]));
    rmSync(a);
    sh(top, 'mkfifo a.ts');
    const fifo = run();
    expect(fifo.code).toBe(0); // not killed by the 20 s limit
    expect(fifo.out).toBe(JSON.stringify([a]));
    expect(fifo.ms).toBeLessThan(5_000);
  }, 60_000);

  test('scanForbiddenPatterns skips a FIFO instead of waiting on it', () => {
    const top = tmp();
    sh(top, 'mkfifo pipe.test.ts');
    const r = child('console.log(JSON.stringify(scanForbiddenPatterns([process.env.F!])))', { F: join(top, 'pipe.test.ts') });
    expect(r.code).toBe(0);
    expect(r.out).toBe('[]');
    expect(r.ms).toBeLessThan(5_000);
  }, 60_000);
});

describe('changedLines: an added line that looks like a file header', () => {
  test('`++ b/other.ts` (shown as `+++ b/other.ts`) does not switch the file later hunks count for', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `export const l${i + 1} = ${i + 1};`);
    const { top, head } = repo({ 'a.ts': `${lines.join('\n')}\n`, 'other.ts': 'export const o = 1;\n' });
    const edited = [...lines];
    edited.splice(1, 0, '++ b/other.ts'); // an added line 2
    edited[18] = 'export const l18 = 99;'; // a second hunk, line 19 of the new file
    writeFileSync(join(top, 'a.ts'), `${edited.join('\n')}\n`);
    const out = changedLines(top, head);
    expect(out && !('error' in out)).toBe(true);
    const files = (out as { files: Map<string, Set<number>> }).files;
    expect([...files.keys()]).toEqual(['a.ts']);
    expect([...files.get('a.ts')!].sort((x, y) => x - y)).toEqual([2, 19]);
  });

  test('a hunk whose old side has no final newline is read (the `\\ No newline` marker is no header)', () => {
    const { top, head } = repo({ 'a.ts': 'one', 'b.ts': 'b1\nb2\n' });
    writeFileSync(join(top, 'a.ts'), 'two\n');
    writeFileSync(join(top, 'b.ts'), 'b1\nB2\n');
    const files = (changedLines(top, head) as { files: Map<string, Set<number>> }).files;
    expect([...files.get('a.ts')!]).toEqual([1]);
    expect([...files.get('b.ts')!]).toEqual([2]);
  });

  test('a diff cut short in the middle of a hunk is read up to the cut, never past it', () => {
    const { top, head } = repo({ 'a.ts': 'x\ny\n', 'other.ts': 'o\n' });
    // A git that prints a truncated diff: the hunk announces two lines on each side, one comes.
    const shim = tmp();
    const real = sh(top, 'command -v git');
    // The next file's header follows the cut: it must be read as a header, not as hunk body.
    write(shim, 'fake.diff', 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-x\ndiff --git a/other.ts b/other.ts\n--- a/other.ts\n+++ b/other.ts\n@@ -1 +1 @@\n-o\n+p\n');
    write(shim, 'git', `#!/bin/sh\nfor a in "$@"; do if [ "$a" = diff ]; then cat ${shim}/fake.diff; exit 0; fi; done\nexec ${real} "$@"\n`);
    sh(shim, 'chmod +x git');
    // In this process (changedLines starts git with this environment), the PATH restored after.
    const oldPath = process.env.PATH;
    process.env.PATH = `${shim}:${oldPath}`;
    try {
      const o = changedLines(top, head) as { files: Map<string, Set<number>> };
      expect([...o.files].map(([f, l]) => [f, [...l]])).toEqual([
        ['a.ts', [1, 2]],
        ['other.ts', [1]],
      ]);
    } finally {
      process.env.PATH = oldPath;
    }
  });

  test('ordinary hunks, several files and a new file are still read', () => {
    const { top, head } = repo({ 'a.ts': 'one\ntwo\nthree\nfour\nfive\n', 'b.ts': 'b1\nb2\n' });
    writeFileSync(join(top, 'a.ts'), 'one\nTWO\nthree\nfour\nFIVE\nsix\n');
    writeFileSync(join(top, 'b.ts'), 'b0\nb1\nb2\n');
    write(top, 'new.ts', 'n1\nn2\n');
    const files = (changedLines(top, head) as { files: Map<string, Set<number>> }).files;
    expect([...files.get('a.ts')!]).toEqual([2, 5, 6]);
    expect([...files.get('b.ts')!]).toEqual([1]);
    expect([...files.get('new.ts')!]).toEqual([1, 2]);
  });
});

describe('changedLines limited to paths', () => {
  test('only the named files are read, literally: other changes, untracked files and glob characters stay out', () => {
    const { top, head } = repo({ 'a.ts': 'one\n', 'b.ts': 'one\n', 'x[1].ts': 'one\n', 'x1.ts': 'one\n' });
    for (const f of ['a.ts', 'b.ts', 'x[1].ts', 'x1.ts']) writeFileSync(join(top, f), 'one\ntwo\n');
    write(top, 'new.ts', 'n1\n');
    const read = (paths?: string[]) => {
      const out = changedLines(top, head, paths) as { files: Map<string, Set<number>> };
      return [...out.files.keys()].sort();
    };
    expect(read()).toEqual(['a.ts', 'b.ts', 'new.ts', 'x1.ts', 'x[1].ts']);
    expect(read(['a.ts'])).toEqual(['a.ts']);
    expect(read(['a.ts', 'new.ts'])).toEqual(['a.ts', 'new.ts']);
    expect(read(['x[1].ts'])).toEqual(['x[1].ts']); // a literal path, not a glob that also matches x1.ts
    expect(read([])).toEqual([]);
    expect(read(['nothing.ts'])).toEqual([]);
  });
});

describe('net change: a file that vanished', () => {
  test('differFromBase counts a start file that is gone now as changed', () => {
    const { top, head } = repo({ 'a.ts': 'x\n', 'b.ts': 'y\n' });
    rmSync(join(top, 'a.ts'));
    expect([...differFromBase(top, head, ['a.ts', 'b.ts'])]).toEqual(['a.ts']);
  });
});

describe('content freshness: freshFor', () => {
  test('a record with a tree is fresh only by content (v0.36.6, R4); a record with no tree, by time', () => {
    const T = 'a'.repeat(40);
    const r = record(['x'], { timestamp: iso(10_000), tree: T });
    const edit = (over: Partial<ChangedFileEdit>): ChangedFileEdit => ({ file: '/x', lastEditTimestamp: iso(5_000), ...over });
    // Time says nothing about a record with a tree: a checkout changes a file with no edit in the log.
    expect(freshFor(r, edit({ lastEditTimestamp: iso(20_000) }))).toBe(false); // the record is newer than the edit: still no
    expect(freshFor(r, edit({ lastEditTimestamp: null }))).toBe(false);
    expect(freshFor(r, edit({ lastEditTimestamp: '' }))).toBe(false);
    expect(freshFor(r, edit({}))).toBe(false); // older, no trees
    expect(freshFor(r, edit({ sameContentTrees: new Set([T]) }))).toBe(true); // older, same content
    expect(freshFor(r, edit({ lastEditTimestamp: iso(20_000), sameContentTrees: new Set([T]) }))).toBe(true); // newer, same content
    expect(freshFor(r, edit({ sameContentTrees: new Set(['b'.repeat(40)]) }))).toBe(false); // another tree
    expect(freshFor(r, edit({ lastEditTimestamp: iso(20_000), sameContentTrees: new Set(['b'.repeat(40)]) }))).toBe(false); // newer, other content
    // A tree that is malformed, or could not be read, is never the time rule.
    expect(freshFor({ ...r, tree: 'not-a-tree' }, edit({ lastEditTimestamp: iso(20_000) }))).toBe(false);
    expect(freshFor(r, edit({ lastEditTimestamp: iso(20_000), unverifiedTrees: new Set([T]) }))).toBe(false);
    // No tree key (written before the trees): the time rule, while its time is trusted.
    const old = { ...r, tree: undefined };
    expect(freshFor(old, edit({ lastEditTimestamp: iso(20_000) }))).toBe(true); // newer than the edit
    expect(freshFor(old, edit({ lastEditTimestamp: null }))).toBe(true);
    expect(freshFor(old, edit({ lastEditTimestamp: '' }))).toBe(true);
    expect(freshFor(old, edit({}))).toBe(false); // older
    expect(freshFor(old, edit({ sameContentTrees: new Set([T]) }))).toBe(false); // nothing to match
    expect(freshFor(old, edit({ lastEditTimestamp: iso(20_000), distrustedRecords: new Set([old]) }))).toBe(false); // its checkout changed
    // (v0.36.6, R4) `tree: null` is a work-tree hash that failed: never judged by time, whatever the
    //   edit says, unless no repo could have given it a tree (timeTrustedRecords).
    const unhashed = { ...r, tree: null };
    for (const last of [iso(20_000), null, '']) expect(freshness(unhashed, edit({ lastEditTimestamp: last }))).toBe('unverified');
    expect(freshness(unhashed, edit({ lastEditTimestamp: iso(20_000), sameContentTrees: new Set([T]) }))).toBe('unverified');
    expect(freshness(unhashed, edit({ lastEditTimestamp: iso(20_000), timeTrustedRecords: new Set([unhashed]) }))).toBe('fresh');
    expect(freshness(unhashed, edit({ timeTrustedRecords: new Set([unhashed]) }))).toBe('stale'); // outside a repo: the time rule
  });

  test('withSameContent: the trees of older records that hold the file as it is now', () => {
    const { top, tree: tree1 } = repo({ 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 1;\n' });
    const a = join(top, 'src/a.ts');
    const old = record([a], { timestamp: iso(60_000), tree: tree1 });
    // v2 is committed: a second tree, where a.ts differs from the start.
    write(top, 'src/a.ts', 'export const a = 2;\n');
    sh(top, "git commit -qam 'ABC-1 v2'");
    const tree2 = sh(top, 'git rev-parse HEAD^{tree}');
    const mid = record([a], { timestamp: iso(50_000), tree: tree2 });
    const edit = (file = a, last: string | null = iso(30_000)): ChangedFileEdit => ({ file, lastEditTimestamp: last });

    // The file is back at v1 (undone): only the tree whose a.ts is v1 holds the content.
    write(top, 'src/a.ts', 'export const a = 1;\n');
    const out = withSameContent([edit()], [old, mid], top);
    expect([...out[0]!.sameContentTrees!]).toEqual([tree1]);

    // v3 matches no record tree: the edit comes back untouched.
    write(top, 'src/a.ts', 'export const a = 3;\n');
    const e3 = [edit()];
    expect(withSameContent(e3, [old, mid], top)).toBe(e3);

    write(top, 'src/a.ts', 'export const a = 1;\n');
    // (R4) Time no longer decides what is read: a record newer than the edit, and an edit with no
    //   time, are compared by content like any other.
    const none = [edit()];
    expect([...withSameContent(none, [record([a], { timestamp: iso(10_000), tree: tree1 })], top)[0]!.sameContentTrees!]).toEqual([tree1]);
    expect([...withSameContent([edit(a, null)], [old], top)[0]!.sameContentTrees!]).toEqual([tree1]);
    // Not read: one that does not list the file, a malformed tree (freshFor calls it unverified), a
    //   file outside the repo, an edit no record lists.
    expect(withSameContent(none, [record([join(top, 'src/b.ts')], { timestamp: iso(60_000), tree: tree1 })], top)).toBe(none);
    for (const tree of ['not-a-tree', 'A'.repeat(40)]) {
      expect(withSameContent(none, [record([a], { timestamp: iso(60_000), tree: tree as never })], top)).toBe(none);
    }
    const out2 = [edit(write(tmp(), 'z.ts', 'x\n')), edit(join(top, 'src/gone.ts'))];
    expect(withSameContent(out2, [old], top)).toBe(out2);
    // A record with no tree in a repo that has commits, and no commit of its own: its checkout is
    //   not known, so its time is not trusted.
    const out3 = withSameContent(none, [record([a], { timestamp: iso(60_000), tree: undefined })], top);
    expect(out3[0]!.distrustedRecords?.size).toBe(1);
    // `tree: null` (the hash failed) is unverified on its own account; no repo can have given it a tree
    //   only outside one.
    const hashFailed = record([a], { timestamp: iso(60_000), tree: null });
    const out4 = withSameContent(none, [hashFailed], top);
    expect(out4[0]!.distrustedRecords).toBeUndefined();
    expect(out4[0]!.timeTrustedRecords).toBeUndefined();
    expect(freshness(hashFailed, out4[0] ?? none[0]!)).toBe('unverified');
    const plain = tmp();
    const outside = write(plain, 'x.ts', 'x\n');
    const noRepo = record([outside], { timestamp: iso(10_000), tree: null }); // newer than the edit
    const out5 = withSameContent([edit(outside)], [noRepo], plain);
    expect(freshness(noRepo, out5[0]!)).toBe('fresh'); // outside a repo the time rule is all there is
    // A tree git does not have (a valid-looking id) cannot be compared: unverified, never the time rule.
    const ghost = withSameContent([edit()], [record([a], { timestamp: iso(60_000), tree: 'c'.repeat(40) })], top);
    expect(ghost[0]!.sameContentTrees).toBeUndefined();
    expect([...ghost[0]!.unverifiedTrees!]).toEqual(['c'.repeat(40)]);
    // A file the record's tree lacks (new in the session) has nothing to match.
    const fresh = write(top, 'src/new.ts', 'export const n = 1;\n');
    const newEdit = [edit(fresh)];
    expect(withSameContent(newEdit, [record([fresh], { timestamp: iso(60_000), tree: tree1 })], top)).toBe(newEdit);
  });

  test('withSameContent reads at most 30 record trees per call, the newest first; the rest are unverified', () => {
    const { top } = repo({ 'src/a.ts': 'export const a = 1;\n' });
    const a = join(top, 'src/a.ts');
    // 32 commits, each with a different tree that keeps a.ts as it is.
    const trees = sh(top, 'for i in $(seq 1 32); do echo $i > f$i; git add f$i; git commit -qm x$i; git rev-parse HEAD^{tree}; done').split('\n');
    const results = trees.map((tree, i) => record([a], { timestamp: iso(100_000 - i * 1_000), tree })); // trees[0] is the oldest
    // A clock that never advances: the 2 s budget is not what stops the reads here.
    const out = withSameContent<ChangedFileEdit>([{ file: a, lastEditTimestamp: iso(1_000) }], results, top, undefined, { now: () => 0 });
    const got = out[0]!.sameContentTrees!;
    expect(got.size).toBe(30);
    expect(got.has(trees[31]!)).toBe(true);
    expect(got.has(trees[0]!)).toBe(false);
    expect(got.has(trees[1]!)).toBe(false);
    // The two oldest are not read, and are not evidence either: unverified, never decided by time.
    expect([...out[0]!.unverifiedTrees!].sort()).toEqual([trees[0]!, trees[1]!].sort());
  }, 60_000);

  test('validateTestCoverage: a stale record counts when its tree holds the content, not when the content differs', () => {
    const r = record(['/p/a.ts'], { timestamp: iso(10_000), tree: 'a'.repeat(40) });
    const edit = (trees?: string[]): ChangedFileEdit => ({ file: '/p/a.ts', lastEditTimestamp: iso(5_000), ...(trees ? { sameContentTrees: new Set(trees) } : {}) });
    expect(validateTestCoverage([r], [edit()]).ok).toBe(false);
    expect(validateTestCoverage([r], [edit(['b'.repeat(40)])]).ok).toBe(false);
    const ok = validateTestCoverage([r], [edit(['a'.repeat(40)])]);
    expect(ok.ok).toBe(true);
    expect(ok.effective).toEqual([r]);
  });

  test('missingTestTypes counts a stale integration record whose tree holds the content', () => {
    const { top, tree } = repo({ 'src/server.ts': "import { readFileSync } from 'node:fs';\nexport const r = readFileSync;\n" });
    const file = join(top, 'src/server.ts');
    const test = write(top, 'tests/s.test.ts', 'test("x", () => { expect(1).toBe(1); });\n');
    const r = record([file], { timestamp: iso(10_000), tree, test_files: [test] });
    const gaps = (trees?: string[]) =>
      missingTestTypes({
        results: [r],
        accepted: new Set([r]),
        edits: [{ file, lastEditTimestamp: iso(5_000), ...(trees ? { sameContentTrees: new Set(trees) } : {}) }],
        top,
        exempt: [],
      }).gaps.map((g) => g.rel);
    expect(gaps()).toEqual(['src/server.ts']);
    expect(gaps(['d'.repeat(40)])).toEqual(['src/server.ts']);
    expect(gaps([tree])).toEqual([]);
  });

  test('affectedGaps counts a stale record that ran the existing test when its tree holds the content', () => {
    const { top, head, tree } = repo({
      'src/calc.ts': 'export const add = (a: number, b: number) => a + b;\n',
      'tests/calc.test.ts': 'import { add } from "../src/calc";\ntest("add", () => expect(add(1, 2)).toBe(3));\n',
    });
    const r = record([], { timestamp: iso(10_000), tree, test_files: [join(top, 'tests/calc.test.ts')], suites: [{ name: 's', command: 'bun test', passed: 1, failed: 0, output: '', type: 'unit', duration_ms: 1 }] });
    const gaps = (trees?: string[]) =>
      affectedGaps({
        results: [r],
        accepted: new Set([r]),
        edits: [{ file: join(top, 'src/calc.ts'), lastEditTimestamp: iso(5_000), ...(trees ? { sameContentTrees: new Set(trees) } : {}) }],
        top,
        head,
      }).map((g) => `${g.rel}:${g.tests.join(',')}`);
    expect(gaps()).toEqual(['src/calc.ts:tests/calc.test.ts']);
    expect(gaps(['e'.repeat(40)])).toEqual(['src/calc.ts:tests/calc.test.ts']);
    expect(gaps([tree])).toEqual([]);
  });

  test('changedLineGaps counts a stale record with full coverage when its tree holds the content', () => {
    const top = tmp();
    const file = write(top, 'src/a.ts', 'export const a = 1;\n');
    const r = record([file], { timestamp: iso(10_000), tree: 'a'.repeat(40), coverage: { status: 'measured', changed: changed({ 'src/a.ts': [1, 1] }) } });
    const gaps = (trees?: string[]) =>
      changedLineGaps({ results: [r], edits: [{ file, lastEditTimestamp: iso(5_000), ...(trees ? { sameContentTrees: new Set(trees) } : {}) }], top, exempt: [] }).gaps;
    expect(gaps()).toEqual([{ file: 'src/a.ts', unmeasured: true }]);
    expect(gaps(['f'.repeat(40)])).toEqual([{ file: 'src/a.ts', unmeasured: true }]);
    expect(gaps(['a'.repeat(40)])).toEqual([]);
  });
});

describe('forbidden patterns on added lines only: scanForbiddenPatterns', () => {
  const body = ['import { a } from "../src/a";', 'test.todo("old");', 'test("a", () => { expect(a).toBe(1); });', ''].join('\n');

  test('without linesOf, or with null, every line counts (the old behaviour)', () => {
    const f = write(tmp(), 'a.test.ts', body);
    const all = scanForbiddenPatterns([f]);
    expect(all.map((h) => [h.key, h.line])).toEqual([['skipped-test', 2]]);
    expect(scanForbiddenPatterns([f], () => null)).toEqual(all);
  });

  test('a todo that was there before the session is not counted; an added one is', () => {
    const f = write(tmp(), 'a.test.ts', body);
    expect(scanForbiddenPatterns([f], () => new Set([3]))).toEqual([]); // only line 3 was added
    expect(scanForbiddenPatterns([f], () => new Set())).toEqual([]); // the file did not change
    const hit = scanForbiddenPatterns([f], () => new Set([2, 3]));
    expect(hit).toHaveLength(1);
    expect(hit[0]).toMatchObject({ file: f, key: 'skipped-test', line: 2 });
  });

  test('an old match does not hide an added one of the same pattern in the same file', () => {
    const f = write(tmp(), 'b.test.ts', ['test.todo("old");', 'test("b", () => { expect(1).toBe(1); });', 'test.skip("new", () => {});', ''].join('\n'));
    const hit = scanForbiddenPatterns([f], () => new Set([3]));
    expect(hit.map((h) => [h.key, h.line])).toEqual([['skipped-test', 3]]);
  });

  test('a match that spans lines counts when any of its lines was added', () => {
    const f = write(tmp(), 'c.test.ts', ['test("c", async () => {', '  await x.catch(() => {', '  });', '});', ''].join('\n'));
    expect(scanForbiddenPatterns([f], () => new Set([3])).map((h) => [h.key, h.line])).toEqual([['swallowed-catch', 2]]);
    expect(scanForbiddenPatterns([f], () => new Set([1, 4]))).toEqual([]);
  });

  test('a file with ten thousand matches is scanned fast, and the line of the one added match is exact', () => {
    const n = 10_000;
    // Plain quotes: a nested template literal is code to the gate's own pattern scan.
    const text = `${Array.from({ length: n }, (_, i) => 'test.skip("t' + i + '", () => {});').join('\n')}\n`;
    const f = write(tmp(), 'many.test.ts', text);
    const t0 = Date.now();
    const hit = scanForbiddenPatterns([f], () => new Set([n]));
    expect(hit.map((h) => [h.key, h.line])).toEqual([['skipped-test', n]]);
    expect(scanForbiddenPatterns([f], () => new Set([1])).map((h) => h.line)).toEqual([1]);
    expect(scanForbiddenPatterns([f], () => new Set([n + 1]))).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  test('stripLiteralsAndComments keeps string contents on request, also in a Java text block', () => {
    const java = 'String s = """\nhello // x\n"""; // note\n';
    expect(stripLiteralsAndComments(java, true)).not.toContain('hello');
    const kept = stripLiteralsAndComments(java, true, true);
    expect(kept).toContain('hello');
    expect(kept).not.toContain('note'); // comments go either way
    expect(stripLiteralsAndComments('const a = "keep"; // gone\n', false, true)).toContain('keep');
    expect(stripLiteralsAndComments('const a = "keep"; // gone\n')).not.toContain('keep');
  });

  test('linesOf is asked per file; a literal or comment match is still no match; a missing file is skipped', () => {
    const dir = tmp();
    const old = write(dir, 'old.test.ts', 'test.todo("a");\n');
    const added = write(dir, 'new.test.ts', 'test.todo("b");\n');
    const asked: string[] = [];
    const hits = scanForbiddenPatterns([old, added, join(dir, 'gone.test.ts'), ''], (file) => {
      asked.push(file);
      return file === added ? new Set([1]) : new Set();
    });
    expect(hits.map((h) => h.file)).toEqual([added]);
    expect(asked).toContain(old);
    const lit = write(dir, 'lit.test.ts', '// test.todo("x");\nconst s = "test.skip(";\ntest("l", () => { expect(1).toBe(1); });\n');
    expect(scanForbiddenPatterns([lit], () => new Set([1, 2]))).toEqual([]);
  });
});

describe('a record outside the accepted set stands alone on added lines too: recordStandsAlone', () => {
  const ACC = [
    {
      id: 'AC-1',
      description: 'd',
      test: 't',
      red: { command: 'bun test (before)', output: '1 fail', exit_code: 1 },
      green: { command: 'bun test', output: '1 pass', exit_code: 0 },
    },
  ];
  test('a todo that was there before the session does not stop a member record from standing alone', () => {
    const f = write(tmp(), 'old.test.ts', 'test.todo("old");\ntest("x", () => { expect(1).toBe(1); });\n');
    const r = record([], { test_files: [f], acceptance: ACC as never });
    expect(recordStandsAlone(r)).toBe(false); // every line counts without linesOf
    expect(recordStandsAlone(r, () => null)).toBe(false);
    expect(recordStandsAlone(r, () => new Set())).toBe(true); // the file did not change
    expect(recordStandsAlone(r, () => new Set([2]))).toBe(true); // only line 2 was added
    expect(recordStandsAlone(r, () => new Set([1]))).toBe(false); // the todo is an added line
  });
});

describe('subprocess evidence: coverage.subprocess', () => {
  const HOOK = 'hooks/stop.ts';
  /** A file that runs as a program (an entry point), three lines. */
  const MAIN_FILE = 'if (import.meta.main) console.log(1);\nexport const t = 2;\nexport const u = 3;\n';
  const SPAWNING = "import { join } from 'node:path';\ntest('runs the hook', async () => { Bun.spawn(['bun', 'hooks/stop.ts']); });\n";
  /** A temp project with the hook file and a test file with `testText`; the record names the pair. */
  function setup(testText = SPAWNING, over: Partial<TestResult> = {}, file = HOOK) {
    const top = tmp();
    write(top, HOOK, MAIN_FILE);
    const test = write(top, 'tests/hook.test.ts', testText);
    const r = record([join(top, HOOK)], {
      test_files: [test],
      coverage: { status: 'measured', changed: changed({ [HOOK]: [1, 3] }), subprocess: [{ file, test: 'tests/hook.test.ts' }] },
      ...over,
    });
    return { top, test, r, edits: [{ file: join(top, HOOK), lastEditTimestamp: iso(5_000) }] };
  }
  const gapsOf = (s: ReturnType<typeof setup>) => changedLineGaps({ results: [s.r], edits: s.edits, top: s.top, exempt: [] });

  test('a partly run file whose test spawns it as a process is listed apart, not as a gap', () => {
    const s = setup();
    expect(subprocessEvidence(s.r, HOOK, s.top)).toBe(true);
    expect(gapsOf(s)).toEqual({ measured: true, gaps: [], subprocess: [HOOK] });
  });

  test('a file the report lacks counts too (absent), and an e2e suite satisfies it', () => {
    const s = setup(SPAWNING, {
      suites: [
        { name: 'u', command: 'bun test', passed: 1, failed: 0, output: '', type: 'unit', duration_ms: 1 },
        { name: 'e', command: 'playwright', passed: 1, failed: 0, output: '', type: 'e2e', duration_ms: 1 },
      ],
      coverage: { status: 'measured', changed: changed({}, [], { [HOOK]: 3 }), subprocess: [{ file: HOOK, test: 'tests/hook.test.ts' }] },
    });
    expect(gapsOf(s)).toEqual({ measured: true, gaps: [], subprocess: [HOOK] });
    // Without the evidence the same file is a gap.
    const none = setup(SPAWNING, { coverage: { status: 'measured', changed: changed({}, [], { [HOOK]: 3 }) } });
    expect(gapsOf(none).gaps).toEqual([{ file: HOOK, absent: true }]);
    expect(gapsOf(none).subprocess).toBeUndefined();
  });

  test('without the evidence a partly run file is a gap', () => {
    const s = setup(SPAWNING, { coverage: { status: 'measured', changed: changed({ [HOOK]: [1, 3] }) } });
    expect(gapsOf(s)).toEqual({ measured: true, gaps: [{ file: HOOK, covered: 1, total: 3 }] });
  });

  test('not evidence: no spawn call, a spawn that is a comment or a string, the file not named', () => {
    const noSpawn = setup("import { s } from '../hooks/stop';\ntest('x', () => { expect(s).toBe(1); }); // hooks/stop.ts\n");
    expect(subprocessEvidence(noSpawn.r, HOOK, noSpawn.top)).toBe(false);
    expect(gapsOf(noSpawn).gaps).toEqual([{ file: HOOK, covered: 1, total: 3 }]);
    const commented = setup("// Bun.spawn(['bun', 'hooks/stop.ts'])\nconst s = \"spawnSync(\";\ntest('x', () => { expect(1).toBe(1); }); // hooks/stop.ts\n");
    expect(subprocessEvidence(commented.r, HOOK, commented.top)).toBe(false);
    const unnamed = setup("test('x', () => { Bun.spawn(['bun', 'hooks/other.ts']); });\n");
    expect(subprocessEvidence(unnamed.r, HOOK, unnamed.top)).toBe(false);
    expect(gapsOf(unnamed).gaps).toHaveLength(1);
  });

  test('not evidence: a unit-only suite, a failing or empty integration suite, a verdict other than pass', () => {
    const suite = (type: string, passed = 2, failed = 0) => [{ name: 's', command: 'bun test', passed, failed, output: '', type, duration_ms: 1 }] as never;
    for (const suites of [suite('unit'), suite('ui'), suite('integration', 2, 1), suite('integration', 0), [] as never, undefined as never]) {
      const s = setup(SPAWNING, { suites });
      expect(subprocessEvidence(s.r, HOOK, s.top)).toBe(false);
    }
    const fail = setup(SPAWNING, { verdict: 'fail' });
    expect(subprocessEvidence(fail.r, HOOK, fail.top)).toBe(false);
    const blocked = setup(SPAWNING, { verdict: 'blocked' });
    expect(subprocessEvidence(blocked.r, HOOK, blocked.top)).toBe(false);
    // Through the gaps: a failing record carries no coverage at all.
    expect(gapsOf(fail).measured).toBe(false);
    // An integration suite that failed leaves the gap in place.
    expect(gapsOf(setup(SPAWNING, { suites: suite('integration', 2, 1) })).gaps).toEqual([{ file: HOOK, covered: 1, total: 3 }]);
  });

  test('not evidence: the test is not in test_files, is missing, is too large, or the pair names another file', () => {
    const s = setup();
    expect(subprocessEvidence({ ...s.r, test_files: [] }, HOOK, s.top)).toBe(false);
    expect(subprocessEvidence({ ...s.r, test_files: undefined as never }, HOOK, s.top)).toBe(false);
    expect(subprocessEvidence({ ...s.r, test_files: [join(s.top, 'tests/other.test.ts')] }, HOOK, s.top)).toBe(false);
    expect(gapsOf(setup(SPAWNING, { test_files: [] })).gaps).toHaveLength(1);
    // The test file is listed but gone, or too large to read.
    rmSync(s.test);
    expect(subprocessEvidence(s.r, HOOK, s.top)).toBe(false);
    const big = setup(`${SPAWNING}// ${'x'.repeat(2 * 1024 * 1024 + 10)}\n`);
    expect(subprocessEvidence(big.r, HOOK, big.top)).toBe(false);
    // The pair names another file, or is malformed, or the record has none.
    const other = setup(SPAWNING, {}, 'hooks/other.ts');
    expect(subprocessEvidence(other.r, HOOK, other.top)).toBe(false);
    const c = setup().r.coverage!;
    for (const subprocess of [undefined, null, 'x', [null], [{ file: HOOK }], [{ file: HOOK, test: 5 }], []] as never[]) {
      const m = setup(SPAWNING, { coverage: { ...c, subprocess } });
      expect(subprocessEvidence(m.r, HOOK, m.top)).toBe(false);
    }
    expect(subprocessEvidence({ ...s.r, coverage: undefined }, HOOK, s.top)).toBe(false);
  });

  test('the file is named by its path, its base name, or its quoted stem next to its directory name', () => {
    const byPath = setup("test('x', () => { spawnSync('bun', ['./hooks/stop.ts']); });\n");
    expect(subprocessEvidence(byPath.r, HOOK, byPath.top)).toBe(true);
    const byName = setup("test('x', () => { execFileSync('bun', [join(dir, 'stop.ts')]); });\n");
    expect(subprocessEvidence(byName.r, HOOK, byName.top)).toBe(true);
    // 'hooks' and 'stop' as separate strings: the extension is added in code.
    const byStem = setup("test('x', () => { Bun.spawn(['bun', join(ROOT, 'hooks', 'stop') + '.ts']); });\n");
    expect(subprocessEvidence(byStem.r, HOOK, byStem.top)).toBe(true);
    // The stem alone (no directory name) is too weak; a root file has no directory name to use.
    const stemOnly = setup("test('x', () => { Bun.spawn(['bun', 'stop']); });\n");
    expect(subprocessEvidence(stemOnly.r, HOOK, stemOnly.top)).toBe(false);
    const top = tmp();
    write(top, 'cli.ts', 'if (import.meta.main) console.log(1);\n');
    const test = write(top, 'tests/cli.test.ts', "test('x', () => { Bun.spawn(['bun', 'cli']); });\n");
    const rootRec = record([join(top, 'cli.ts')], { test_files: [test], coverage: { status: 'measured', changed: changed({ 'cli.ts': [0, 1] }), subprocess: [{ file: 'cli.ts', test: 'tests/cli.test.ts' }] } });
    expect(subprocessEvidence(rootRec, 'cli.ts', top)).toBe(false);
  });

  test('the changed file must run as a program: an entry point, not a library file', () => {
    const forms: Record<string, string> = {
      'import.meta.main': 'if (import.meta.main) run();\n',
      'require.main': 'if (require.main === module) run();\n',
      __main__: 'if __name__ == "__main__":\n    run()\n',
      'go main': 'package main\nfunc main() {\n}\n',
      'jvm main': 'class A { public static void main(String[] a) {} }\n',
      'top-level main()': 'function main() {}\nmain();\n',
      'await main()': 'async function main() {}\nawait main();\n',
      shebang: '#!/usr/bin/env bun\nrun();\n',
    };
    for (const [name, text] of Object.entries(forms)) {
      const s = setup();
      writeFileSync(join(s.top, HOOK), text);
      expect([name, subprocessEvidence(s.r, HOOK, s.top)]).toEqual([name, true]);
    }
    // A library file: exports only, a call of another name, a main guard that is a comment.
    const libs: Record<string, string> = {
      exports: 'export const s = 1;\nexport function run() {}\n',
      'other call': 'export function run() {}\nrun();\n',
      'commented guard': '// if (import.meta.main) run();\n/* main(); */\nexport const s = 1;\n',
      'main in an expression': 'export const m = main();\n',
    };
    for (const [name, text] of Object.entries(libs)) {
      const s = setup();
      writeFileSync(join(s.top, HOOK), text);
      expect([name, subprocessEvidence(s.r, HOOK, s.top)]).toEqual([name, false]);
      expect(gapsOf(s).gaps).toEqual([{ file: HOOK, covered: 1, total: 3 }]);
    }
    // The changed file is gone, or too large to read: no evidence.
    const gone = setup();
    rmSync(join(gone.top, HOOK));
    expect(subprocessEvidence(gone.r, HOOK, gone.top)).toBe(false);
    const big = setup();
    writeFileSync(join(big.top, HOOK), `${MAIN_FILE}// ${'x'.repeat(2 * 1024 * 1024 + 10)}\n`);
    expect(subprocessEvidence(big.r, HOOK, big.top)).toBe(false);
  });

  test('the file is named in the test code, not in a comment; a quoted path counts', () => {
    const inComment = setup("// runs hooks/stop.ts\n/* stop.ts */\ntest('x', () => { Bun.spawn(['bun', 'other.js']); });\n");
    expect(subprocessEvidence(inComment.r, HOOK, inComment.top)).toBe(false);
    const quoted = setup("test('x', () => { Bun.spawn(['bun', 'hooks/stop.ts']); }); // end\n");
    expect(subprocessEvidence(quoted.r, HOOK, quoted.top)).toBe(true);
  });

  test('at most 50 pairs of a record are read', () => {
    const s = setup();
    const good = { file: HOOK, test: 'tests/hook.test.ts' };
    const junk = (n: number) => Array.from({ length: n }, () => ({ file: 'other.ts', test: 'x' }));
    const withPairs = (pairs: unknown[]) => ({ ...s.r, coverage: { ...s.r.coverage!, subprocess: pairs as never } });
    expect(subprocessEvidence(withPairs([...junk(49), good]), HOOK, s.top)).toBe(true); // the 50th
    expect(subprocessEvidence(withPairs([...junk(50), good]), HOOK, s.top)).toBe(false); // the 51st
  });

  test('the entry point is read in code: a string or comment does not make a library file a program', () => {
    const notPrograms: Record<string, string> = {
      'js string': 'export const s = "import.meta.main";\nexport const t = \'require.main === module\';\n',
      'js template': 'export const s = `\nmain();\n`;\n',
      'py comment': '# if __name__ == "__main__":\nx = 1\n',
      'py in a string': 'x = "if __name__ == \'__main__\'"\n',
      'py not a guard': 'if __name__ == "other":\n    run()\n',
    };
    for (const [name, text] of Object.entries(notPrograms)) {
      const s = setup();
      writeFileSync(join(s.top, HOOK), text);
      expect([name, subprocessEvidence(s.r, HOOK, s.top)]).toEqual([name, false]);
    }
    // Python's guard, also indented in a block.
    const py = setup();
    writeFileSync(join(py.top, HOOK), 'def run():\n    pass\n\nif __name__ == \'__main__\':\n    run()\n');
    expect(subprocessEvidence(py.r, HOOK, py.top)).toBe(true);
    const nested = setup();
    writeFileSync(join(nested.top, HOOK), 'try:\n    pass\nfinally:\n    if __name__ == "__main__":\n        run()\n');
    expect(subprocessEvidence(nested.r, HOOK, nested.top)).toBe(true);
  });

  test('the base name must match as a whole path part: a.ts is not data.ts, my-a.ts, .a.ts or a.ts.bak', () => {
    const top = tmp();
    write(top, 'hooks/a.ts', MAIN_FILE);
    const spawnWith = (arg: string): boolean => {
      const test = write(top, 'tests/x.test.ts', `test('x', () => { Bun.spawn(['bun', ${arg}]); });\n`);
      const r = record([join(top, 'hooks/a.ts')], {
        test_files: [test],
        coverage: { status: 'measured', changed: changed({ 'hooks/a.ts': [1, 3] }), subprocess: [{ file: 'hooks/a.ts', test: 'tests/x.test.ts' }] },
      });
      return subprocessEvidence(r, 'hooks/a.ts', top);
    };
    for (const arg of ["'hooks/data.ts'", "'hooks/my-a.ts'", "'hooks/.a.ts'", "'hooks/a.ts.bak'", "'hooks/a.tsx'", "'hooks/xa.ts'"]) {
      expect([arg, spawnWith(arg)]).toEqual([arg, false]);
    }
    for (const arg of ["'hooks/a.ts'", "'./hooks/a.ts'", "'a.ts'", "join(dir, 'a.ts')", '"hooks/a.ts"', "`${root}/hooks/a.ts`"]) {
      expect([arg, spawnWith(arg)]).toEqual([arg, true]);
    }
  });

  test('absolute test paths in test_files and relative ones in the pair meet', () => {
    const s = setup();
    expect(s.r.test_files![0]!.startsWith('/')).toBe(true);
    expect(subprocessEvidence(s.r, HOOK, s.top)).toBe(true);
  });

  test('the spawn call set: common runners start a process', () => {
    for (const call of ['spawnSync(', 'Bun.spawnSync(', 'execSync(', 'exec' + 'File(', 'fork(', 'execa(', 'subprocess.run(', 'exec.Command(']) {
      const s = setup(`const f = 'hooks/stop.ts';\n${call}[f]);\n`);
      expect([call, subprocessEvidence(s.r, HOOK, s.top)]).toEqual([call, true]);
    }
    const s = setup("const f = 'hooks/stop.ts';\nconst respawn = 1; unspawn(f);\n");
    expect(subprocessEvidence(s.r, HOOK, s.top)).toBe(false);
  });
});

describe('test-write validates coverage.subprocess', () => {
  function project(): string {
    const d = repo({ 'src/a.ts': 'export const a = 1;\n', 'tests/a.test.ts': 'import { a } from "../src/a";\ntest("a", () => { expect(a).toBe(1); });\n' }).top;
    write(d, 'src/a.ts', 'export const a = 1;\nexport const b = 2;\n');
    return d;
  }
  function input(d: string, subprocess: unknown) {
    return {
      timestamp: new Date(Date.now() + 60_000).toISOString(),
      tested_files: [join(d, 'src', 'a.ts')],
      category: 'fix-bug',
      test_files: [join(d, 'tests', 'a.test.ts')],
      environment: { mode: 'none', command: 'none', evidence: 'library' },
      suites: [{ name: 'integration', command: 'bun test', passed: 1, failed: 0, output: '1 pass', type: 'integration', duration_ms: 10 }],
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
      coverage: {
        status: 'measured',
        changed: { covered: 1, total: 2, files_without_executed_changes: [], files: { 'src/a.ts': { covered: 1, total: 2 } }, in_report: ['src/a.ts'], diff_lines: { 'src/a.ts': 1 }, base: BASE },
        ...(subprocess === undefined ? {} : { subprocess }),
      },
    };
  }
  const write_ = (d: string, i: unknown) => Bun.spawnSync(['bun', CLI, 'test-write'], { cwd: d, stdin: new TextEncoder().encode(JSON.stringify(i)), stdout: 'pipe', stderr: 'pipe' });

  test('a list of {file, test} is kept in the record', () => {
    const d = project();
    const subprocess = [{ file: 'src/a.ts', test: 'tests/a.test.ts' }];
    const p = write_(d, input(d, subprocess));
    expect(p.exitCode).toBe(0);
    const name = readdirSync(join(d, '.claude', 'tests')).find((n) => n.endsWith('.json'))!;
    expect(JSON.parse(readFileSync(join(d, '.claude', 'tests', name), 'utf8')).coverage.subprocess).toEqual(subprocess);
  });

  test('a malformed list is rejected with the field named', () => {
    const d = project();
    const bad = [
      'x',
      { file: 'a', test: 'b' },
      [null],
      [5],
      [{ test: 'tests/a.test.ts' }],
      [{ file: 'src/a.ts' }],
      [{ file: '  ', test: 'tests/a.test.ts' }],
      [{ file: 'src/a.ts', test: '' }],
      [{ file: 1, test: 'tests/a.test.ts' }],
    ];
    for (const s of bad) {
      const p = write_(d, input(d, s));
      expect([JSON.stringify(s), p.exitCode === 0]).toEqual([JSON.stringify(s), false]);
      expect(p.stderr.toString()).toContain('coverage.subprocess');
    }
  });
});
