// #38 in-process: how `currentFindings` (lib/review-validator.ts) reads "changed" and "seen" through
// the reviews' trees (a fake `TreeContentLookup`), and what `treeContent` (lib/changed-coverage.ts)
// answers on a real temporary repo. The Stop hook end to end is tests/i38-review-supersession-stop.test.ts.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { treeContent } from '../lib/changed-coverage';
import { setRecordBase } from '../lib/record-paths';
import { type TreeContentLookup, currentFindings, fileModifiedAt } from '../lib/review-validator';
import type { ReviewFinding, ReviewResult } from '../lib/types';

// The real-repo tests spawn several git commands each; bun's 5 s default is too tight under a loaded full run.
setDefaultTimeout(30_000);

const A = '/repo/a.ts';
const B = '/repo/b.ts';
const at = (min: number): string => new Date(Date.parse('2026-01-01T10:00:00.000Z') + min * 60_000).toISOString();
const ms = (min: number): number => Date.parse(at(min));
const ALL = ['refactoring-quality', 'security-secrets', 'performance'];
// Review trees by name: what a fake lookup is keyed by.
const TREES = { E: 'e'.repeat(40), O: 'f'.repeat(40), P: 'd'.repeat(40) } as const;

function review(over: Partial<ReviewResult>): ReviewResult {
  return {
    timestamp: at(0),
    reviewed_files: [A],
    category: 'fix-bug',
    findings: [],
    unknown_assumptions_checked: [],
    verdict: 'pass',
    dimensions_checked: ALL,
    ...over,
  };
}
const HIGH: ReviewFinding = { file: A, issue: 'token logged', severity: 'high' };
/** The finding's review, at minute 0, with tree E. */
const flagged = (over: Partial<ReviewResult> = {}): ReviewResult => review({ findings: [HIGH], tree: TREES.E, ...over });
/** A later review of the flagged file. */
const later = (min: number, tree: string | undefined, over: Partial<ReviewResult> = {}): ReviewResult =>
  review({ timestamp: at(min), ...(tree === undefined ? {} : { tree }), ...over });
/** File mtimes in minutes (null: missing); others are an hour before the finding's review. */
const mtimes =
  (changes: Record<string, number | null>) =>
  (file: string): number | null => {
    if (!(file in changes)) return ms(-60);
    const min = changes[file];
    return min === null || min === undefined ? null : ms(min);
  };

type Answer = boolean | undefined;
/** A fake lookup: `answers[treeName][file]`; whatever is not listed is undefined. Records every `asks`. */
function fake(answers: Partial<Record<keyof typeof TREES, Record<string, Answer>>>): { fn: TreeContentLookup; asked: ReadonlyMap<string, ReadonlySet<string>>[] } {
  const byTree = new Map<string, Record<string, Answer>>(Object.entries(TREES).map(([name, id]) => [id, answers[name as keyof typeof TREES] ?? {}]));
  const asked: ReadonlyMap<string, ReadonlySet<string>>[] = [];
  return {
    asked,
    fn: (asks) => {
      asked.push(asks);
      return (tree, file) => byTree.get(tree)?.[file];
    },
  };
}
const open = (reviews: ReviewResult[], m: Record<string, number | null>, lookup?: TreeContentLookup): number =>
  currentFindings(reviews, null, mtimes(m), lookup).length;

describe('currentFindings with trees (#38): "changed" is the content the review saw', () => {
  test('content unchanged, mtime newer than the later review (a checkout, a touch): the finding stays open', () => {
    // E holds the content now (true): the file is what the review flagged; the later review (O) saw it too.
    const { fn } = fake({ E: { [A]: true }, O: { [A]: true } });
    expect(open([later(2, TREES.O), flagged()], { [A]: 5 }, fn)).toBe(1);
    expect(open([later(2, TREES.O), flagged()], { [A]: 1 }, fn)).toBe(1); // in between, too
    expect(open([later(2, TREES.O), flagged()], { [A]: -30 }, fn)).toBe(1); // and older than the review
  });

  test('a fix taken back (the flagged content again) stays open whatever the mtime', () => {
    const { fn } = fake({ E: { [A]: true }, O: { [A]: false } }); // O reviewed the fix, now gone
    expect(open([later(2, TREES.O), flagged()], { [A]: 9 }, fn)).toBe(1);
  });

  test('content changed, the later review holds the content now, mtime after that review: cleared', () => {
    const { fn } = fake({ E: { [A]: false }, O: { [A]: true } });
    expect(open([later(2, TREES.O), flagged()], { [A]: 5 }, fn)).toBe(0); // checkout after the delta review
    expect(open([later(2, TREES.O), flagged()], { [A]: 1 }, fn)).toBe(0); // fixed before it
  });

  test('content changed under an mtime older than the review: cleared by content, not by time', () => {
    const { fn } = fake({ E: { [A]: false }, O: { [A]: true } });
    expect(open([later(2, TREES.O), flagged()], { [A]: -30 }, fn)).toBe(0);
  });

  test('a later review that saw an intermediate version (its tree has other content now) does not clear it', () => {
    const { fn } = fake({ E: { [A]: false }, O: { [A]: false } });
    expect(open([later(2, TREES.O), flagged()], { [A]: 1 }, fn)).toBe(1);
    expect(open([later(2, TREES.O), flagged()], { [A]: 5 }, fn)).toBe(1);
  });

  test('the later review without a usable tree is judged by time where time shows the change', () => {
    const { fn } = fake({ E: { [A]: false } });
    // before = false (content changed); no tree for O: by time it saw the change only when o.ms > mtime > e.ms.
    expect(open([later(2, undefined), flagged()], { [A]: 1 }, fn)).toBe(0);
    expect(open([later(2, undefined), flagged()], { [A]: 5 }, fn)).toBe(1); // changed after the review: unseen
    expect(open([later(2, undefined), flagged()], { [A]: -30 }, fn)).toBe(1); // older than e: time shows no change
    expect(open([later(2, 'not-a-tree'), flagged()], { [A]: 1 }, fn)).toBe(0); // a malformed tree is no tree
    expect(open([later(2, 'not-a-tree'), flagged()], { [A]: 5 }, fn)).toBe(1);
  });

  test('the lookup cannot tell for the finding review (no tree, or undefined): the time rule', () => {
    const nothing = fake({}); // undefined everywhere
    expect(open([later(2, TREES.O), flagged()], { [A]: 1 }, nothing.fn)).toBe(0); // e.ms < m < o.ms
    expect(open([later(2, TREES.O), flagged()], { [A]: 5 }, nothing.fn)).toBe(1); // m after the later review
    expect(open([later(2, TREES.O), flagged()], { [A]: -30 }, nothing.fn)).toBe(1); // not changed since e
    expect(open([later(2, TREES.O), flagged({ tree: undefined })], { [A]: 1 }, nothing.fn)).toBe(0);
    expect(open([later(2, TREES.O), flagged({ tree: undefined })], { [A]: 5 }, nothing.fn)).toBe(1);
    // Before = undefined, later tree holds the content now: seen when o.ms > mtime, as time says.
    const onlyLater = fake({ O: { [A]: true } });
    expect(open([later(2, TREES.O), flagged()], { [A]: 1 }, onlyLater.fn)).toBe(0);
    expect(open([later(2, TREES.O), flagged()], { [A]: 5 }, onlyLater.fn)).toBe(1);
    expect(open([later(2, TREES.O), flagged()], { [A]: -30 }, onlyLater.fn)).toBe(1);
  });

  test('a mtime equal to the review time is no change by time (strictly after)', () => {
    const nothing = fake({});
    expect(open([later(2, TREES.O), flagged()], { [A]: 0 }, nothing.fn)).toBe(1);
  });

  test('another listed file whose content changed clears it, through a later review that lists the flagged file', () => {
    const files = [A, B];
    const { fn } = fake({ E: { [A]: true, [B]: false }, O: { [A]: true, [B]: true } });
    expect(open([later(2, TREES.O, { reviewed_files: files }), flagged({ reviewed_files: files })], { [A]: 5, [B]: 5 }, fn)).toBe(0);
    // Both unchanged: open.
    const same = fake({ E: { [A]: true, [B]: true }, O: { [A]: true, [B]: true } });
    expect(open([later(2, TREES.O, { reviewed_files: files }), flagged({ reviewed_files: files })], { [A]: 5, [B]: 5 }, same.fn)).toBe(1);
  });

  test('the flagged file missing is a change right after the review; another missing file is not', () => {
    const { fn } = fake({});
    expect(open([later(2, TREES.O), flagged()], { [A]: null }, fn)).toBe(0);
    const files = [A, B];
    const keepsA = fake({ E: { [A]: true }, O: { [A]: true } });
    expect(open([later(2, TREES.O, { reviewed_files: files }), flagged({ reviewed_files: files })], { [A]: 5, [B]: null }, keepsA.fn)).toBe(1);
  });

  test('two later reviews cover the axes together only when each saw the change', () => {
    const { fn } = fake({ E: { [A]: false }, O: { [A]: true }, P: { [A]: false } });
    const security = later(2, TREES.O, { dimensions_checked: ['security-secrets'] });
    const rest = (tree: string): ReviewResult => later(3, tree, { dimensions_checked: ['refactoring-quality', 'performance'] });
    expect(open([rest(TREES.P), security, flagged()], { [A]: 6 }, fn)).toBe(1); // P saw a version since replaced
    const both = fake({ E: { [A]: false }, O: { [A]: true }, P: { [A]: true } });
    expect(open([rest(TREES.P), security, flagged()], { [A]: 6 }, both.fn)).toBe(0);
  });

  test('another finding of the same review is judged on its own file', () => {
    const second: ReviewFinding = { file: B, issue: 'y', severity: 'high' };
    const rev = flagged({ findings: [HIGH, second], reviewed_files: [A, B] });
    const lat = later(2, TREES.O, { reviewed_files: [A, B] });
    const { fn } = fake({ E: { [A]: false, [B]: true }, O: { [A]: true, [B]: true } });
    // Both findings list A and B; A changed, so both are superseded (every listed file counts).
    expect(open([lat, rev], { [A]: 5, [B]: 5 }, fn)).toBe(0);
    const keep = fake({ E: { [A]: true, [B]: true }, O: { [A]: true, [B]: true } });
    expect(open([lat, rev], { [A]: 5, [B]: 5 }, keep.fn)).toBe(2);
  });
});

describe('currentFindings with trees (#38): what is asked, and when', () => {
  test('without a lookup the rule is the time rule (a grid of mtimes)', () => {
    // The old rule: changed when m > e.ms (a missing flagged file: right after e); seen when o.ms > the change.
    const oracle = (m: number | null): number => {
      const changedAt = m === null ? ms(0) : m > ms(0) ? m : Infinity;
      return ms(2) > changedAt ? 0 : 1;
    };
    for (const min of [-60, -1, 0, 1, 2, 3, null]) {
      const m = min === null ? null : ms(min);
      const got = currentFindings([later(2, TREES.O), flagged()], null, () => m).length;
      expect(got).toBe(oracle(m));
      // A lookup that tells nothing is the same.
      expect(currentFindings([later(2, TREES.O), flagged()], null, () => m, fake({}).fn).length).toBe(oracle(m));
    }
  });

  test('no candidates (no later review of its axes): no lookup, no stat', () => {
    const { fn, asked } = fake({});
    let stats = 0;
    const out = currentFindings([later(2, TREES.O, { dimensions_checked: ['performance'] }), flagged()], null, (f) => (stats++, mtimes({})(f)), fn);
    expect(out).toHaveLength(1);
    expect(asked).toHaveLength(0);
    expect(stats).toBe(0);
  });

  test('one question: the finding tree and the later trees, for the files that are there', () => {
    const { fn, asked } = fake({ E: { [A]: true } });
    const files = [A, B];
    currentFindings([later(2, TREES.O, { reviewed_files: files }), later(1, TREES.P, { reviewed_files: [A] }), flagged({ reviewed_files: files })], null, mtimes({ [A]: 5, [B]: null }), fn);
    expect(asked).toHaveLength(1);
    const asks = asked[0]!;
    expect([...asks.keys()].sort()).toEqual([TREES.E, TREES.O, TREES.P].sort());
    for (const set of asks.values()) expect([...set]).toEqual([A]); // B is missing: not asked
  });

  test('trees of reviews that are not newer than the finding review are not asked about', () => {
    const { fn, asked } = fake({});
    currentFindings([later(-5, TREES.P), later(2, TREES.O), flagged()], null, mtimes({ [A]: 5 }), fn);
    expect([...asked[0]!.keys()].sort()).toEqual([TREES.E, TREES.O].sort());
  });
});

describe('treeContent (#38) on a real repo', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });
  const sh = (cwd: string, cmd: string) => Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe' }).stdout.toString().trim();
  function put(root: string, rel: string, text: string): string {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
    return abs;
  }
  function repo(): { d: string; tree: string; a: string; sh: string } {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-i38u-')));
    dirs.push(d);
    sh(d, 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false');
    const a = put(d, 'src/a.ts', 'one\n');
    const run = put(d, 'bin/run.sh', '#!/bin/sh\n');
    chmodSync(run, 0o755);
    put(d, '.gitignore', 'ign/\n');
    sh(d, "git add -A && git commit -q -m 'ABC-1 init'");
    return { d, tree: sh(d, 'git rev-parse HEAD^{tree}'), a, sh: run };
  }
  const ask = (tree: string, ...files: string[]): Map<string, Set<string>> => new Map([[tree, new Set(files)]]);

  test('true for the content now, false for other content', () => {
    const { d, tree, a } = repo();
    expect(treeContent(d, ask(tree, a))(tree, a)).toBe(true);
    writeFileSync(a, 'two\n');
    expect(treeContent(d, ask(tree, a))(tree, a)).toBe(false);
    writeFileSync(a, 'one\n'); // back to it (a new mtime changes nothing)
    expect(treeContent(d, ask(tree, a))(tree, a)).toBe(true);
  });

  test('a file the answer was not asked for is undefined', () => {
    const { d, tree, a } = repo();
    const t = treeContent(d, ask(tree, a));
    expect(t(tree, join(d, 'src', 'other.ts'))).toBeUndefined();
    expect(t('c'.repeat(40), a)).toBeUndefined();
  });

  test('a git-ignored file (not in the tree) is undefined', () => {
    const { d, tree } = repo();
    const ign = put(d, 'ign/x.ts', 'x\n');
    expect(treeContent(d, ask(tree, ign))(tree, ign)).toBeUndefined();
  });

  test('a file added after the tree was taken (the tree lacks it) is undefined', () => {
    const { d, tree } = repo();
    const added = put(d, 'src/new.ts', 'n\n');
    expect(treeContent(d, ask(tree, added))(tree, added)).toBeUndefined();
  });

  test('the executable bit is no content: a mode-only difference is the same file, other bytes are not', () => {
    const { d, tree, sh: run } = repo();
    expect(treeContent(d, ask(tree, run))(tree, run)).toBe(true);
    chmodSync(run, 0o644); // the tree holds it executable
    expect(treeContent(d, ask(tree, run))(tree, run)).toBe(true);
    chmodSync(run, 0o755);
    writeFileSync(run, '#!/bin/sh\necho changed\n');
    expect(treeContent(d, ask(tree, run))(tree, run)).toBe(false);
  });

  test('a file that is no regular file now (gone, a link, a directory) is undefined', () => {
    const { d, tree, a } = repo();
    const asks = ask(tree, a);
    unlinkSync(a);
    expect(treeContent(d, asks)(tree, a)).toBeUndefined();
    symlinkSync(join(d, 'bin', 'run.sh'), a);
    expect(treeContent(d, asks)(tree, a)).toBeUndefined();
    unlinkSync(a);
    mkdirSync(a);
    expect(treeContent(d, asks)(tree, a)).toBeUndefined();
  });

  test('a tree that does not exist, or is not an id, or a path outside the repo: undefined', () => {
    const { d, tree, a } = repo();
    const ghost = 'a'.repeat(40);
    const out = treeContent(d, new Map([[ghost, new Set([a])], ['HEAD', new Set([a])], [tree, new Set(['/etc/hosts', a])]]));
    expect(out(ghost, a)).toBeUndefined();
    expect(out('HEAD', a)).toBeUndefined();
    expect(out(tree, '/etc/hosts')).toBeUndefined();
    expect(out(tree, a)).toBe(true);
  });

  test('past maxTrees the later trees are undefined; trees are read in the order asked', () => {
    const { d, tree, a } = repo();
    writeFileSync(a, 'two\n');
    sh(d, "git add -A && git commit -q -m 'ABC-1 two'");
    const tree2 = sh(d, 'git rev-parse HEAD^{tree}');
    const asks = new Map([[tree, new Set([a])], [tree2, new Set([a])]]);
    const all = treeContent(d, asks);
    expect(all(tree, a)).toBe(false);
    expect(all(tree2, a)).toBe(true);
    const capped = treeContent(d, asks, { maxTrees: 1 });
    expect(capped(tree, a)).toBe(false);
    expect(capped(tree2, a)).toBeUndefined();
    expect(treeContent(d, asks, { maxTrees: 0 })(tree, a)).toBeUndefined();
  });

  test('past the time budget everything is undefined', () => {
    const { d, tree, a } = repo();
    let t = 0;
    const spent = treeContent(d, ask(tree, a), { budgetMs: 1_000, now: () => (t += 5_000) });
    expect(spent(tree, a)).toBeUndefined();
    expect(treeContent(d, ask(tree, a), { budgetMs: 60_000, now: () => 0 })(tree, a)).toBe(true);
  });

  test('an empty ask is an empty answer', () => {
    const { d } = repo();
    expect(treeContent(d, new Map())('x', 'y')).toBeUndefined();
  });
});

// Time and content read the same file, and a mode change is no fix, with the real lookup and real files.
describe('currentFindings (#38) with the real lookup', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });
  const sh = (cwd: string, cmd: string) => Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe' }).stdout.toString().trim();
  const min = (n: number): number => Date.now() + n * 60_000;
  const iso = (n: number): string => new Date(min(n)).toISOString();
  const rev = (n: number, tree: string, files: string[], over: Partial<ReviewResult> = {}): ReviewResult =>
    review({ timestamp: iso(n), tree, reviewed_files: files, ...over });

  test('chmod +x and a later clean review do not clear a finding (a mode change is no fix)', () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-i38m-')));
    dirs.push(d);
    sh(d, 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false');
    const a = join(d, 'a.sh');
    writeFileSync(a, '#!/bin/sh\nrm -rf "$1"\n');
    chmodSync(a, 0o644);
    sh(d, "git add -A && git commit -q -m 'ABC-1 init'");
    const flaggedTree = sh(d, 'git rev-parse HEAD^{tree}');
    chmodSync(a, 0o755);
    sh(d, 'git add -A && git write-tree > /dev/null');
    const laterTree = sh(d, 'git write-tree');
    expect(laterTree).not.toBe(flaggedTree); // the mode differs in the tree
    const finding: ReviewFinding = { file: a, issue: 'unquoted rm', severity: 'high' };
    const reviews = [rev(-5, laterTree, [a]), rev(-10, flaggedTree, [a], { findings: [finding] })];
    const later = new Date(min(-1)); // the chmod moved the mtime past the later review
    utimesSync(a, later, later);
    const lookup: TreeContentLookup = (asks) => treeContent(d, asks);
    expect(currentFindings(reviews, null, fileModifiedAt, lookup)).toHaveLength(1);
    // A real change of the bytes, reviewed after, clears it.
    writeFileSync(a, '#!/bin/sh\nrm -rf -- "$1"\n');
    sh(d, 'git add -A');
    const fixedTree = sh(d, 'git write-tree');
    const fixed = [rev(-5, fixedTree, [a]), rev(-10, flaggedTree, [a], { findings: [finding] })];
    const t = new Date(min(-8)); // the fix is between the two reviews
    utimesSync(a, t, t);
    expect(currentFindings(fixed, null, fileModifiedAt, lookup)).toHaveLength(0);
  });

  test('a `link/../f.ts` spelling: the mtime is read where the content is (the OS-resolved path), not at the lexical one', () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-i38l-')));
    dirs.push(d);
    mkdirSync(join(d, 'other', 'deep'), { recursive: true });
    symlinkSync(join(d, 'other', 'deep'), join(d, 'link'));
    const lexical = join(d, 'f.ts'); // `link/../f.ts` collapsed by `resolve`, as the Stop's mtime callback does
    const opened = join(d, 'other', 'f.ts'); // what the OS opens, and what a record path normalizes to
    writeFileSync(lexical, 'x\n');
    writeFileSync(opened, 'x\n');
    const old = new Date(min(-60));
    utimesSync(lexical, old, old);
    const fixedAt = new Date(min(-8)); // between the finding review and the later one
    utimesSync(opened, fixedAt, fixedAt);
    const spelled = 'link/../f.ts'; // relative: resolved against the pinned project dir
    const finding: ReviewFinding = { file: spelled, issue: 'y', severity: 'high' };
    const reviews = [review({ timestamp: iso(-5), reviewed_files: [spelled] }), review({ timestamp: iso(-10), reviewed_files: [spelled], findings: [finding] })];
    const seen: string[] = [];
    // As hooks/stop.ts: the callback resolves what it is given against the project dir.
    const stopLike = (file: string): number | null => (seen.push(resolve(d, file)), fileModifiedAt(resolve(d, file)));
    setRecordBase(d);
    try {
      const out = currentFindings(reviews, null, stopLike);
      expect(seen).toEqual([opened]);
      expect(out).toHaveLength(0); // the fix at the opened file is seen by the later review
    } finally {
      setRecordBase();
    }
  });
});
