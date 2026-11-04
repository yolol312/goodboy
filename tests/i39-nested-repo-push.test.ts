// (#39) A session whose project dir is a plain folder holding nested git repos (`be/`, `fe/`, each its
// own repository): `cli.ts test-write` recorded `tree: null` (it hashed only the project dir), so the
// push test check never found a passing result for the pushed repo's tree, and `cli.ts regression`
// failed with "not inside a git repository". Now test-write also records `trees` (the work tree of each
// other repo a tested file belongs to), the push check matches any of a result's trees, and regression
// runs in the repo the shell is in.
//   1. repoTrees / treesOf / regressionTop: the units, with real repos;
//   2. checkHandoff with injected tree and diff readers: a result with `tree: null` and `trees`;
//   3. cmdTestWrite in this process: the nested layout, a forged `trees`, the no-tree warning;
//   4. real hooks and CLI as processes: test-write, regression and the PreToolUse push check from
//      inside a nested repo with the plain folder as the project dir.
// The new exports are read through a namespace so a run against the old library fails per test.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { checkHandoff, revisionTree } from '../lib/push-test';
import * as pt from '../lib/push-test';
import type { TestResult } from '../lib/types';

const ROOT = resolve(import.meta.dir, '..');
const HOOK = join(ROOT, 'hooks', 'pre-tool-use.ts');
const CLI = join(ROOT, 'lib', 'cli.ts');

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(prefix = 'goodboy-i39-'): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
function sh(cwd: string, cmd: string): string {
  const p = Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  if (p.exitCode !== 0) throw new Error(`${cmd}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
const GIT_INIT = 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false';
function write(root: string, rel: string, text: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}

/** A git repo at `dir` with one commit: its own `src/a.ts` (so no two repos share a tree), a test file
 *  and a package.json whose test script runs nothing. */
function makeRepo(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  write(dir, 'src/a.ts', `export const ${name} = 1;\n`);
  write(dir, 'a.test.ts', 'test("a", () => {});\n');
  write(dir, 'package.json', JSON.stringify({ scripts: { test: 'true' } }));
  write(dir, 'bun.lock', '');
  sh(dir, `${GIT_INIT} && git add -A && git commit -q -m init`);
  return dir;
}
const headTree = (repo: string): string => sh(repo, 'git rev-parse HEAD^{tree}');

/** A plain folder `proj` (no git) holding the repos `be` and `fe`. */
function nested() {
  const base = tmp();
  const parent = join(base, 'proj');
  mkdirSync(parent);
  const be = makeRepo(join(parent, 'be'), 'be');
  const fe = makeRepo(join(parent, 'fe'), 'fe');
  return { base, parent, be, fe };
}

const OTHER = 'c'.repeat(40);
const RED_GREEN = [
  {
    id: 'AC-1',
    description: 'a is 1',
    test: 'a.test.ts',
    red: { command: 'bun test a.test.ts', output: '1 fail', exit_code: 1 },
    green: { command: 'bun test a.test.ts', output: '1 pass', exit_code: 0 },
  },
];

// ── 1. The units ────────────────────────────────────────────────────────────────────────────────

describe('repoTrees', () => {
  test('a plain folder with two repos: each tested file\'s repo, keyed by its real top', () => {
    const w = nested();
    const out = pt.repoTrees([join(w.be, 'src', 'a.ts'), join(w.fe, 'src', 'a.ts')], w.parent);
    expect(out).toEqual({ trees: { [w.be]: headTree(w.be), [w.fe]: headTree(w.fe) }, dropped: [] });
    expect(headTree(w.be)).not.toBe(headTree(w.fe));
  }, 30_000);

  test('files of one repo, in one dir or several, give one entry', () => {
    const w = nested();
    write(w.be, 'src/b.ts', 'export const b = 1;\n');
    sh(w.be, 'git add -A && git commit -q -m b');
    const out = pt.repoTrees([join(w.be, 'src', 'a.ts'), join(w.be, 'src', 'b.ts'), join(w.be, 'a.test.ts')], w.parent);
    expect(out.trees).toEqual({ [w.be]: headTree(w.be) });
  }, 30_000);

  test('the project\'s own repo is skipped (its tree is the record\'s `tree`); a clone nested in it is not', () => {
    const w = nested();
    expect(pt.repoTrees([join(w.be, 'src', 'a.ts')], w.be).trees).toEqual({});
    const inner = makeRepo(join(w.be, 'vendor', 'lib'), 'lib');
    const out = pt.repoTrees([join(w.be, 'src', 'a.ts'), join(inner, 'src', 'a.ts')], w.be);
    expect(out.trees).toEqual({ [inner]: headTree(inner) });
  }, 30_000);

  test('the project dir may be spelled through a link; the keys are real tops', () => {
    const w = nested();
    const link = join(w.base, 'proj-link');
    symlinkSync(w.parent, link);
    const files = [join(w.be, 'src', 'a.ts'), join(link, 'fe', 'src', 'a.ts')];
    expect(pt.repoTrees(files, link).trees).toEqual({ [w.be]: headTree(w.be), [w.fe]: headTree(w.fe) });
    expect(pt.repoTrees(files, w.parent).trees).toEqual({ [w.be]: headTree(w.be), [w.fe]: headTree(w.fe) });
  }, 30_000);

  test('a tested file in a repo outside the project dir names no repo', () => {
    const w = nested();
    const other = makeRepo(join(w.base, 'other'), 'other');
    const out = pt.repoTrees([join(other, 'src', 'a.ts')], w.parent);
    expect(out).toEqual({ trees: {}, dropped: [] });
    expect(pt.repoTrees([join(other, 'src', 'a.ts'), join(w.fe, 'src', 'a.ts')], w.parent).trees).toEqual({ [w.fe]: headTree(w.fe) });
    // Nor a literal `..` path that leads out of the project dir (here to the outside sibling repo).
    // Built by concatenation: join() would normalize the `..` away before repoTrees sees it.
    expect(pt.repoTrees([`${w.parent}/../other/src/a.ts`], w.parent).trees).toEqual({});
    expect(pt.repoTrees(['../other/src/a.ts'], w.parent).trees).toEqual({});
  }, 30_000);

  test('the project dir\'s parent being a repo is outside the project (relative path exactly `..`)', () => {
    const w = nested();
    // The project dir is a repo of its own, inside a repository (base) that is not its repo: a file of base
    // is outside the project, and base is not the project's own top, so only the `..` check keeps it out.
    sh(w.parent, `${GIT_INIT} && git commit -q --allow-empty -m proj`);
    sh(w.base, GIT_INIT);
    write(w.base, 'top.ts', 'export const top = 1;\n');
    sh(w.base, 'git add top.ts && git commit -q -m top'); // base has a tree to record, were it taken for a repo of the project
    expect(pt.repoTrees([join(w.base, 'top.ts'), `${w.parent}/../top.ts`], w.parent)).toEqual({ trees: {}, dropped: [] });
    // The repos below the project dir are still found.
    expect(pt.repoTrees([join(w.base, 'top.ts'), join(w.fe, 'src', 'a.ts')], w.parent).trees).toEqual({ [w.fe]: headTree(w.fe) });
  }, 30_000);

  test('a dir inside the project whose name starts with `..` is inside it: its repo is recorded', () => {
    const w = nested();
    const odd = makeRepo(join(w.parent, '..odd'), 'odd');
    const out = pt.repoTrees([join(odd, 'src', 'a.ts'), join(w.fe, 'src', 'a.ts')], w.parent);
    expect(out).toEqual({ trees: { [odd]: headTree(odd), [w.fe]: headTree(w.fe) }, dropped: [] });
    // And a repo at the project dir's `..odd` that is the project itself is skipped as its own.
    expect(pt.repoTrees([join(odd, 'src', 'a.ts')], odd).trees).toEqual({});
  }, 30_000);

  test('a file outside any repo, in a missing dir, or no file name adds nothing', () => {
    const w = nested();
    write(w.parent, 'notes.txt', 'x\n');
    const junk = [join(w.parent, 'notes.txt'), join(w.parent, 'missing', 'x.ts'), '', 42 as unknown as string];
    expect(pt.repoTrees(junk, w.parent).trees).toEqual({});
    expect(pt.repoTrees([...junk, join(w.fe, 'src', 'a.ts')], w.parent).trees).toEqual({ [w.fe]: headTree(w.fe) });
    expect(pt.repoTrees([], w.parent)).toEqual({ trees: {}, dropped: [] });
  }, 30_000);

  test('a `.git` entry that is no repository is not one (each candidate is confirmed by git)', () => {
    const w = nested();
    write(w.parent, 'fake1/.git/HEAD', 'nothing\n');
    write(w.parent, 'fake1/x.ts', 'x\n');
    write(w.parent, 'fake2/.git', 'gitdir: /nonexistent/nowhere\n');
    write(w.parent, 'fake2/x.ts', 'x\n');
    const files = [join(w.parent, 'fake1', 'x.ts'), join(w.parent, 'fake2', 'x.ts')];
    expect(pt.repoTrees(files, w.parent)).toEqual({ trees: {}, dropped: [] });
  }, 30_000);

  // §15.30 item 1: a `.git` that is no repo top is passed over and the walk goes on up (it used to drop
  // the file: the candidate was the fake dir, and the real repo above it was never looked at).
  test('a `.git` marker inside a real repo is passed over: the file belongs to the repo above it', () => {
    const w = nested();
    write(w.be, 'sub/.git/HEAD', 'nothing\n');
    write(w.be, 'sub/x.ts', 'x\n');
    const out = pt.repoTrees([join(w.be, 'sub', 'x.ts')], w.parent);
    expect(Object.keys(out.trees)).toEqual([w.be]);
    expect(out.dropped).toEqual([]);
  }, 30_000);

  test('the tree is the content as it would be handed off: an uncommitted edit counts, and the commit then matches', () => {
    const w = nested();
    const file = join(w.be, 'src', 'a.ts');
    writeFileSync(file, 'export const be = 2;\n');
    write(w.be, 'src/new.ts', 'export const n = 1;\n'); // untracked files are content too
    const dirty = pt.repoTrees([file], w.parent).trees[w.be]!;
    expect(dirty).toMatch(/^[0-9a-f]{40}$/);
    expect(dirty).not.toBe(headTree(w.be));
    sh(w.be, 'git add -A && git commit -q -m edit');
    expect(revisionTree(w.be, 'HEAD')).toBe(dirty);
  }, 30_000);

  test('at most 8 repos are hashed; the rest come back as `dropped`', () => {
    const base = tmp();
    const files: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = makeRepo(join(base, `r${i}`), `r${i}`);
      files.push(join(r, 'src', 'a.ts'));
    }
    const out = pt.repoTrees(files, base);
    const tops = files.map((f) => dirname(dirname(f)));
    expect(Object.keys(out.trees)).toEqual(tops.slice(0, 8));
    expect(out.dropped).toEqual(tops.slice(8));
  }, 30_000);
});

describe('repoTrees: names, and the cap on confirmed repos', () => {
  test('a relative tested-file name resolves against the project dir, not the process dir', () => {
    const w = nested();
    expect(process.cwd()).not.toContain(w.base); // the process dir is elsewhere (the repo under test)
    expect(pt.repoTrees(['fe/src/a.ts'], w.parent).trees).toEqual({ [w.fe]: headTree(w.fe) });
    expect(pt.repoTrees(['./be/src/a.ts', 'fe/a.test.ts'], w.parent).trees).toEqual({ [w.be]: headTree(w.be), [w.fe]: headTree(w.fe) });
    // A relative name that climbs out of the project dir names no repo (a real repo is there), and one
    // that is a bare file name is the project dir's own file (no repo here).
    makeRepo(join(w.base, 'other'), 'other');
    expect(pt.repoTrees(['../other/src/a.ts', 'notes.txt'], w.parent)).toEqual({ trees: {}, dropped: [] });
    // The same name does not reach a repo of the process dir: a plain folder with no `fe` finds none.
    const empty = tmp();
    expect(pt.repoTrees(['lib/cli.ts', 'tests/i39-nested-repo-push.test.ts'], empty)).toEqual({ trees: {}, dropped: [] });
  }, 30_000);

  test('a fake `.git` candidate before the cap does not use up a slot: 8 real repos are still hashed', () => {
    const base = tmp();
    write(base, 'fake0/.git/HEAD', 'nothing\n');
    write(base, 'fake0/x.ts', 'x\n');
    const files = [join(base, 'fake0', 'x.ts')];
    const tops: string[] = [];
    for (let i = 0; i < 8; i++) {
      const r = makeRepo(join(base, `r${i}`), `r${i}`);
      tops.push(r);
      files.push(join(r, 'src', 'a.ts'));
      if (i === 3) {
        write(base, 'fake3/.git', 'gitdir: /nonexistent/nowhere\n');
        write(base, 'fake3/x.ts', 'x\n');
        files.push(join(base, 'fake3', 'x.ts'));
      }
    }
    const out = pt.repoTrees(files, base);
    expect(Object.keys(out.trees)).toEqual(tops);
    expect(out.dropped).toEqual([]);
  }, 60_000);

  test('a real repo after the 8th is `dropped`; a fake `.git` is no candidate at all (every `.git` is confirmed by the walk)', () => {
    const base = tmp();
    const files: string[] = [];
    const tops: string[] = [];
    for (let i = 0; i < 8; i++) {
      const r = makeRepo(join(base, `r${i}`), `r${i}`);
      tops.push(r);
      files.push(join(r, 'src', 'a.ts'));
    }
    write(base, 'fake9/.git/HEAD', 'nothing\n'); // a fake after the 8th: passed over by the walk, not a candidate
    write(base, 'fake9/x.ts', 'x\n');
    files.push(join(base, 'fake9', 'x.ts'));
    const r10 = makeRepo(join(base, 'r10'), 'r10');
    files.push(join(r10, 'src', 'a.ts'));
    const out = pt.repoTrees(files, base);
    expect(Object.keys(out.trees)).toEqual(tops);
    expect(out.dropped).toEqual([r10]);
    // Exactly 8 candidates: nothing is dropped.
    expect(pt.repoTrees(files.slice(0, 8), base).dropped).toEqual([]);
  }, 60_000);

  test('a repo whose files sit in several dirs is one candidate (the walk is shared), not one per dir', () => {
    const base = tmp();
    const files: string[] = [];
    const r = makeRepo(join(base, 'big'), 'big');
    for (let i = 0; i < 12; i++) files.push(write(r, `deep/d${i}/x.ts`, 'x\n'));
    const tops = [r];
    for (let i = 0; i < 7; i++) {
      const o = makeRepo(join(base, `o${i}`), `o${i}`);
      tops.push(o);
      files.push(join(o, 'src', 'a.ts'));
    }
    const out = pt.repoTrees(files, base);
    expect(Object.keys(out.trees)).toEqual(tops); // 8 repos in all; the 12 dirs of `big` took one slot
    expect(out.dropped).toEqual([]);
  }, 60_000);
});

describe('treesOf', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const rec = (o: Record<string, unknown>) => ({ verdict: 'pass', ...o }) as unknown as TestResult;
  test('`tree` first, then the values of `trees`, without repeats', () => {
    expect(pt.treesOf(rec({ tree: A }))).toEqual([A]);
    expect(pt.treesOf(rec({ tree: null, trees: { '/x/be': A, '/x/fe': B } }))).toEqual([A, B]);
    expect(pt.treesOf(rec({ tree: A, trees: { '/x/be': B, '/x/fe': A } }))).toEqual([A, B]);
    expect(pt.treesOf(rec({ tree: 'e'.repeat(64), trees: {} }))).toEqual(['e'.repeat(64)]); // a sha-256 repo's id
  });
  test('malformed values are ignored, never matched', () => {
    const bad = ['', 'zzz', A.slice(0, 39), A.toUpperCase(), `${A}\n`, `${A}0`, 123, null, undefined, true, { x: A }, [A]];
    expect(pt.treesOf(rec({ tree: null, trees: Object.fromEntries(bad.map((v, i) => [`/r${i}`, v])) }))).toEqual([]);
    expect(pt.treesOf(rec({ tree: bad[1] }))).toEqual([]);
    for (const trees of [A, [A], 7, null, undefined]) expect(pt.treesOf(rec({ tree: null, trees }))).toEqual([]);
    expect(pt.treesOf(rec({ tree: B, trees: { '/x': 'nope', '/y': A } }))).toEqual([B, A]);
  });
});

describe('regressionTop', () => {
  test('a project dir that is no repo: the repo the shell is in, if that is inside the project', () => {
    const w = nested();
    expect(pt.regressionTop(w.parent, w.be)).toBe(w.be);
    expect(pt.regressionTop(w.parent, join(w.fe, 'src'))).toBe(w.fe);
  }, 30_000);
  test('null when the shell is in the plain folder, in no repo, or in a repo outside the project', () => {
    const w = nested();
    const other = makeRepo(join(w.base, 'other'), 'other');
    expect(pt.regressionTop(w.parent, w.parent)).toBeNull();
    expect(pt.regressionTop(w.parent, w.base)).toBeNull();
    expect(pt.regressionTop(w.parent, other)).toBeNull();
  }, 30_000);
  test('a project dir that is a repo: its own top, unless the shell is in a clone nested in it', () => {
    const w = nested();
    const inner = makeRepo(join(w.be, 'vendor', 'lib'), 'lib');
    expect(pt.regressionTop(w.be, w.be)).toBe(w.be);
    expect(pt.regressionTop(w.be, join(w.be, 'src'))).toBe(w.be);
    expect(pt.regressionTop(join(w.be, 'src'), w.be)).toBe(w.be);
    expect(pt.regressionTop(w.be, inner)).toBe(inner);
    expect(pt.regressionTop(w.be, join(inner, 'src'))).toBe(inner);
    // A plain subdir of the project repo is the project's.
    mkdirSync(join(w.be, 'docs'));
    expect(pt.regressionTop(w.be, join(w.be, 'docs'))).toBe(w.be);
    // A shell elsewhere (another repo outside the project, or none) falls back to the project's.
    expect(pt.regressionTop(w.be, w.fe)).toBe(w.be);
    expect(pt.regressionTop(w.be, w.base)).toBe(w.be);
  }, 30_000);
});

// ── 2. The push check against a result of a nested repo ─────────────────────────────────────────

describe('checkHandoff: a result with no `tree` and the pushed repo\'s tree in `trees`', () => {
  const T1 = 'a'.repeat(40); // the pushed tree
  const T0 = 'b'.repeat(40); // the content of be before an edit
  const TF = 'd'.repeat(40); // a tree of fe
  const ran = [{ name: 'u', command: 'c', passed: 3, failed: 0, output: '' }];
  const base = { timestamp: '', tested_files: [], category: '', test_files: [__filename], environment: { mode: 'none' as const }, suites: ran, acceptance: RED_GREEN };
  const result = (over: Record<string, unknown>): TestResult => ({ ...base, verdict: 'pass', tree: null, ...over }) as unknown as TestResult;
  const treeOf = (_: string, rev: string) => (rev === 'main' ? T1 : null);
  const noDocs = () => [] as string[];
  /** The hand-off of `be` (a real repo: the check keys a result's `trees` by the repo's real top). */
  const handoff = () => {
    const w = nested();
    return { w, h: { kind: 'push' as const, what: 'git push', cwd: w.be, revs: ['main'] } };
  };

  test('the pushed repo\'s tree among `trees` is the tested tree', () => {
    const { w, h } = handoff();
    expect(checkHandoff(h, [result({ trees: { [w.be]: T1, [w.fe]: T0 } })], treeOf, () => null, noDocs)).toEqual({ ok: true });
    expect(checkHandoff(h, [result({ trees: { [w.fe]: T0 } }), result({ trees: { [w.be]: T1 } })], treeOf, () => null, noDocs)).toEqual({ ok: true });
  }, 30_000);

  test('another tree: no result, and `differs` is read against the newest pass\'s tree of THIS repo', () => {
    const { w, h } = handoff();
    const calls: string[][] = [];
    const diffOf = (cwd: string, a: string, b: string) => (calls.push([cwd, a, b]), ['src/a.ts']);
    const out = checkHandoff(h, [result({ trees: { [w.fe]: TF, [w.be]: T0 } })], treeOf, diffOf, noDocs);
    expect(out).toMatchObject({ ok: false, why: 'no-result', rev: 'main', tree: T1, differs: ['src/a.ts'] });
    expect(calls).toEqual([[w.be, T0, T1]]);
    // The newest pass has no tree of this repo (only fe's): nothing to diff against.
    calls.length = 0;
    const none = checkHandoff(h, [result({ trees: { [w.fe]: TF } })], treeOf, diffOf, noDocs);
    expect(none).toMatchObject({ ok: false, why: 'no-result' });
    expect((none as { differs?: string[] }).differs).toBeUndefined();
    expect(calls).toEqual([]);
    // A result with `tree` only (a project that is the repo) still diffs by `tree`.
    const own = checkHandoff(h, [result({ tree: T0 })], treeOf, diffOf, noDocs);
    expect(own).toMatchObject({ ok: false, differs: ['src/a.ts'] });
    expect(calls).toEqual([[w.be, T0, T1]]);
  }, 30_000);

  test('the docs-only check gets each passing result\'s tree of this repo, not the other repos\' trees', () => {
    const { w, h } = handoff();
    const seen: (readonly string[])[] = [];
    const docsOnly = (_c: string, _r: string, _t: string, passTrees: readonly string[]) => (seen.push(passTrees), [] as string[]);
    const T2 = 'e'.repeat(40);
    checkHandoff(h, [result({ trees: { [w.fe]: TF, [w.be]: T0 } }), result({ tree: T2 }), result({ trees: { [w.fe]: TF } })], treeOf, () => null, docsOnly);
    expect(seen).toEqual([[T0, T2]]);
    // And its answer counts: a docs-only base lets the hand-off through as such.
    const ok = checkHandoff(h, [result({ trees: { [w.be]: T0 } })], treeOf, () => null, () => [T0]);
    expect(ok).toEqual({ ok: true, docsOnly: { main: [T0] } });
  }, 30_000);

  test('a forged or invalid `trees` never matches', () => {
    const { w, h } = handoff();
    const forged: unknown[] = [
      { [w.be]: T1.toUpperCase() },
      { [w.be]: T1.slice(0, 39) },
      { [w.be]: `${T1}0` },
      { [w.be]: { id: T1 } },
      { [w.be]: [T1] },
      { [w.be]: 1 },
      [T1],
      T1,
      null,
    ];
    for (const trees of forged) {
      expect([JSON.stringify(trees), checkHandoff(h, [result({ trees })], treeOf, () => null, noDocs)]).toEqual([JSON.stringify(trees), expect.objectContaining({ ok: false, why: 'no-result' })]);
    }
  }, 30_000);

  test('`trees` do not lift the other checks: a failed or evidence-less result of the tree still does not count', () => {
    const { w, h } = handoff();
    for (const over of [{ verdict: 'needs-changes' }, { suites: [] }, { acceptance: [] }, { test_files: [] }]) {
      expect(checkHandoff(h, [result({ ...over, trees: { [w.be]: T1 } })], treeOf, () => null, noDocs)).toMatchObject({ ok: false, why: 'no-result' });
    }
  }, 30_000);
});

// ── 3. cmdTestWrite in this process ─────────────────────────────────────────────────────────────

/** Runs a CLI command in this process, with stdout and stderr captured. */
async function captured(fn: () => Promise<void>): Promise<{ out: string; err: string }> {
  const o = process.stdout.write;
  const e = process.stderr.write;
  const r = { out: '', err: '' };
  process.stdout.write = ((c: string | Uint8Array) => ((r.out += String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => ((r.err += String(c)), true)) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
  return r;
}

function testInput(tested: string[], testFiles: string[], extra: Record<string, unknown> = {}) {
  return {
    timestamp: new Date().toISOString(),
    tested_files: tested,
    category: 'fix-bug',
    test_files: testFiles,
    environment: { mode: 'local' },
    suites: [{ name: 'unit', command: 'bun test', passed: 1, failed: 0, output: '1 pass', type: 'unit', duration_ms: 10 }],
    acceptance: RED_GREEN,
    verdict: 'pass',
    ...extra,
  };
}

describe('cmdTestWrite in a plain folder holding repos', () => {
  async function testWrite(cwd: string, body: unknown): Promise<{ saved: Record<string, unknown>; err: string }> {
    const { cmdTestWrite } = await import('../lib/cli');
    const file = write(tmp('goodboy-i39-in-'), 'in.json', JSON.stringify(body));
    const r = await captured(() => cmdTestWrite(cwd, [file]));
    const path = (JSON.parse(r.out) as { path: string }).path;
    return { saved: JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>, err: r.err };
  }

  test('`trees` holds the work tree of each repo a tested file is in; `tree` is null; no warning', async () => {
    const w = nested();
    const { saved, err } = await testWrite(w.parent, testInput([join(w.be, 'src', 'a.ts'), join(w.fe, 'src', 'a.ts')], [join(w.be, 'a.test.ts')]));
    expect(saved.tree).toBeNull();
    expect(saved.trees).toEqual({ [w.be]: headTree(w.be), [w.fe]: headTree(w.fe) });
    expect(err).not.toContain('no tested tree');
  }, 30_000);

  test('only the repos of the tested files', async () => {
    const w = nested();
    const { saved } = await testWrite(w.parent, testInput([join(w.fe, 'src', 'a.ts')], [join(w.fe, 'a.test.ts')]));
    expect(saved.trees).toEqual({ [w.fe]: headTree(w.fe) });
  }, 30_000);

  test('a `trees` the agent supplies is dropped: it is taken here from the files', async () => {
    const w = nested();
    const forged = { '/forged': OTHER, [w.be]: OTHER };
    const { saved } = await testWrite(w.parent, testInput([join(w.be, 'src', 'a.ts')], [join(w.be, 'a.test.ts')], { trees: forged }));
    expect(saved.trees).toEqual({ [w.be]: headTree(w.be) });
    // With no tested file in a repo the forged value is not kept either.
    write(w.parent, 'notes.txt', 'x\n');
    const none = await testWrite(w.parent, testInput([join(w.parent, 'notes.txt')], [join(w.be, 'a.test.ts')], { trees: forged }));
    expect(none.saved.trees).toBeUndefined();
  }, 30_000);

  test('no tested file in any repo: no tree at all, and a warning that no push can match', async () => {
    const w = nested();
    write(w.parent, 'notes.txt', 'x\n');
    const { saved, err } = await testWrite(w.parent, testInput([join(w.parent, 'notes.txt')], [join(w.be, 'a.test.ts')]));
    expect(saved.tree).toBeNull();
    expect(saved.trees).toBeUndefined();
    expect(err).toContain(
      'warning: no tested tree recorded (no tested file is in a git repository inside the project dir, or git could not hash it), so no push can match this result.\n',
    );
  }, 30_000);

  test('a tested file in a repo outside the project dir records no tree for it', async () => {
    const w = nested();
    const other = makeRepo(join(w.base, 'other'), 'other');
    const { saved, err } = await testWrite(w.parent, testInput([join(other, 'src', 'a.ts'), join(w.be, 'src', 'a.ts')], [join(w.be, 'a.test.ts')]));
    expect(saved.trees).toEqual({ [w.be]: headTree(w.be) });
    const only = await testWrite(w.parent, testInput([join(other, 'src', 'a.ts')], [join(w.be, 'a.test.ts')]));
    expect(only.saved.trees).toBeUndefined();
    expect(only.err).toContain('warning: no tested tree recorded');
    expect(err).not.toContain('no tested tree');
  }, 30_000);

  test('repos past the 8 hashed are named in a warning, and the record holds the first 8', async () => {
    const base = tmp();
    const files = Array.from({ length: 10 }, (_, i) => join(makeRepo(join(base, `r${i}`), `r${i}`), 'src', 'a.ts'));
    const tops = files.map((f) => dirname(dirname(f)));
    const { saved, err } = await testWrite(base, testInput(files, [join(tops[0]!, 'a.test.ts')]));
    expect(Object.keys(saved.trees as object)).toEqual(tops.slice(0, 8));
    expect(err).toContain('more repos than goodboy hashes');
    expect(err).toContain(tops[8]!);
    expect(err).toContain(tops[9]!);
    expect(err).not.toContain(tops[0]!);
  }, 30_000);

  test('a project dir that is itself the repo keeps its `tree`, records no `trees` for it, and does not warn', async () => {
    const w = nested();
    const { saved, err } = await testWrite(w.be, testInput([join(w.be, 'src', 'a.ts')], [join(w.be, 'a.test.ts')]));
    expect(saved.tree).toBe(headTree(w.be));
    expect(saved.trees).toBeUndefined();
    expect(err).not.toContain('no tested tree');
    // A nested repo beside it adds its own entry.
    const inner = makeRepo(join(w.be, 'vendor', 'lib'), 'lib');
    const both = await testWrite(w.be, testInput([join(w.be, 'src', 'a.ts'), join(inner, 'src', 'a.ts')], [join(w.be, 'a.test.ts')]));
    expect(both.saved.trees).toEqual({ [inner]: headTree(inner) });
  }, 30_000);
});

// ── 4. The real hook and CLI, from inside a nested repo ─────────────────────────────────────────

describe('end to end: the push check and regression from inside be/, the plain folder being the project', () => {
  function world() {
    const w = nested();
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    delete env.CLAUDE_CODE_SESSION_ID;
    Object.assign(env, {
      TMPDIR: w.base,
      CLAUDE_PROJECT_DIR: w.parent,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GOODBOY_OUTWARD_GATE: 'off',
      GOODBOY_PUSH_REGRESSION: 'on',
    });
    const sid = `i39-${Math.random().toString(36).slice(2)}`;
    const cli = (cwd: string, args: string[], stdin = '') => {
      const p = Bun.spawnSync(['bun', CLI, ...args], { cwd, env, stdin: new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe' });
      return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
    };
    const record = (cwd: string, tested: string[], testFiles: string[]) => {
      const r = cli(cwd, ['test-write'], JSON.stringify(testInput(tested, testFiles)));
      if (r.code !== 0) throw new Error(r.err);
      const path = (JSON.parse(r.out) as { path: string }).path;
      return { path, saved: JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> };
    };
    const push = async (cwd: string, command = 'git push origin main') => {
      const payload = { session_id: sid, cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } };
      const proc = Bun.spawn(['bun', HOOK], { cwd, stdin: new TextEncoder().encode(JSON.stringify(payload)), stdout: 'pipe', stderr: 'pipe', env });
      const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as Record<string, unknown>;
      await proc.exited;
      const h = (out.hookSpecificOutput ?? {}) as Record<string, string>;
      return { denied: h.permissionDecision === 'deny', reason: h.permissionDecisionReason ?? '' };
    };
    return { ...w, env, cli, record, push };
  }

  test('a passing test record of be, then its regression, lets `git push origin main` from be/ through', async () => {
    const w = world();
    const { saved, path } = w.record(w.be, [join(w.be, 'src', 'a.ts')], [join(w.be, 'a.test.ts')]);
    // The record lands in the project dir's .claude, and holds be's tree in `trees`.
    expect(path.startsWith(join(w.parent, '.claude', 'tests'))).toBe(true);
    expect(saved.tree).toBeNull();
    expect(saved.trees).toEqual({ [w.be]: headTree(w.be) });

    // The layer-1 result counts; the full regression of the tree is what is still missing.
    const before = await w.push(w.be);
    expect(before.denied).toBe(true);
    expect(before.reason).toContain('without a passing full regression');
    expect(before.reason).not.toContain('without a passing test result');

    const reg = w.cli(join(w.be, 'src'), ['regression']);
    expect([reg.code, reg.err]).toEqual([0, '']);
    expect(JSON.parse(reg.out)).toMatchObject({ ok: true, verdict: 'pass', tree: headTree(w.be) });
    expect(readdirSync(join(w.parent, '.claude', 'tests', 'regression'))).toHaveLength(1);
    expect(existsSync(join(w.be, '.claude'))).toBe(false);

    expect((await w.push(w.be)).denied).toBe(false);
    // From a subdirectory of be too.
    expect((await w.push(join(w.be, 'src'))).denied).toBe(false);
  }, 60_000);

  test('the old record shape (`tree` null, no `trees`) never matches: denied', async () => {
    const w = world();
    const { saved, path } = w.record(w.be, [join(w.be, 'src', 'a.ts')], [join(w.be, 'a.test.ts')]);
    delete saved.trees;
    writeFileSync(path, JSON.stringify(saved));
    const out = await w.push(w.be);
    expect(out.denied).toBe(true);
    expect(out.reason).toContain('without a passing test result');
  }, 60_000);

  test('what the test recorded must be the content pushed: an edit committed after it is denied, naming the file', async () => {
    const w = world();
    w.record(w.be, [join(w.be, 'src', 'a.ts')], [join(w.be, 'a.test.ts')]);
    writeFileSync(join(w.be, 'src', 'a.ts'), 'export const be = 2;\n');
    sh(w.be, 'git add -A && git commit -q -m edit');
    const out = await w.push(w.be);
    expect(out.denied).toBe(true);
    expect(out.reason).toContain('without a passing test result');
    expect(out.reason).toContain('differs from the newest passing result in: src/a.ts');
  }, 60_000);

  test('a result of fe does not let be\'s tree out', async () => {
    const w = world();
    w.record(w.parent, [join(w.fe, 'src', 'a.ts')], [join(w.fe, 'a.test.ts')]);
    const out = await w.push(w.be);
    expect(out.denied).toBe(true);
    expect(out.reason).toContain('without a passing test result');
  }, 60_000);

  test('one result for both repos: either can be pushed once its regression ran', async () => {
    const w = world();
    w.record(w.parent, [join(w.be, 'src', 'a.ts'), join(w.fe, 'src', 'a.ts')], [join(w.be, 'a.test.ts')]);
    for (const repo of [w.be, w.fe]) {
      expect(w.cli(repo, ['regression']).code).toBe(0);
      expect([repo, (await w.push(repo)).denied]).toEqual([repo, false]);
    }
  }, 60_000);

  test('regression from the plain folder fails and says to cd into the repository', () => {
    const w = world();
    const r = w.cli(w.parent, ['regression']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('not inside a git repository');
    expect(r.err).toContain('run it from inside the repository you will push (cd into it first)');
    expect(existsSync(join(w.parent, '.claude', 'tests', 'regression'))).toBe(false);
  }, 30_000);
});
