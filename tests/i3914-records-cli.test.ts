// v0.36.14 (#39 follow-up, plan §15.30 items 5-7): what the CLI writes and reads for a project dir that is
// no repo (`proj/` holding the repos `be/` and `fe/`).
//   item 5: `review-write` records `trees` (taken from git, an agent's `trees` dropped) and `extra_blobs` per
//           repo, as `test-write` does;
//   item 6: `diff-coverage` names its repo (`top`); `test-write` takes `coverage.changed` as one object or a
//           list, drops an entry whose `top` is no repo inside the project dir (with a warning); one
//           normalizer, `changedEntries`, picks the entries of a repo for every reader (the gap check, the
//           idle-file warning, the subprocess pairs), so `be/src/x.ts` and `fe/src/x.ts` never cross;
//   item 7: `diff-coverage` in a nested repo of a project dir that is no repo measures against the repo's
//           start pin in a session (read-only: nothing is written), says where its base came from
//           (`base_source`), and fails with the reason when there is no usable pin.
// Repos are temporary, git runs for real, and the CLI is spawned as a process.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { changedLineGaps, extraBlobsFor, subprocessEvidence } from '../lib/changed-coverage';
import { changedEntries, subprocessPairs } from '../lib/coverage-entries';
import { validateTestResultInput } from '../lib/cli';
import { workTreeState } from '../lib/push-test';
import { readTopStart, takeStartSnapshot, topStart } from '../lib/start-pins';
import { judgeGroups, newDeadline, unionOverGroups } from '../lib/stop-groups';
import { validateTestCoverage } from '../lib/test-validator';
import type { TestResult } from '../lib/types';

const ROOT = resolve(import.meta.dir, '..');
const CLI = join(ROOT, 'lib', 'cli.ts');
setDefaultTimeout(60_000);

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

function tmp(prefix = 'goodboy-i3914r-'): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
function sh(cwd: string, cmd: string): string {
  const p = Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  if (p.exitCode !== 0) throw new Error(`${cmd}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
function write(root: string, rel: string, text: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}
const GIT_INIT = 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false';
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** A repo at `dir` with one commit holding `src/x.ts` (one line), a test file and a package.json. */
function commitRepo(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  write(dir, 'src/x.ts', `export const ${name} = 1;\n`);
  write(dir, 'x.test.ts', 'test("x", () => {});\n');
  write(dir, 'package.json', JSON.stringify({ scripts: { test: 'true' } }));
  sh(dir, `${GIT_INIT} && git add -A && git commit -q -m init`);
  return dir;
}
function emptyRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  sh(dir, GIT_INIT);
  return dir;
}
const head = (repo: string): string => sh(repo, 'git rev-parse HEAD');
const headTree = (repo: string): string => sh(repo, 'git rev-parse HEAD^{tree}');
const blobOf = (file: string): string => sh(dirname(file), `git hash-object -- '${file}'`);

interface World {
  base: string;
  /** The plain project dir. */
  proj: string;
  be: string;
  fe: string;
}
/** A plain `proj/` (no git) holding `be` (one commit) and `fe` (one commit, another file content). */
function world(): World {
  const base = tmp();
  const proj = join(base, 'proj');
  mkdirSync(proj);
  return { base, proj, be: commitRepo(join(proj, 'be'), 'be'), fe: commitRepo(join(proj, 'fe'), 'fe') };
}

let counter = 0;
/** A session id, and its dir (cleaned up). */
function session(): { sid: string; sdir: string } {
  const sid = `i3914r${Math.random().toString(36).slice(2, 8)}${counter++}`;
  const sdir = join(tmpdir(), `goodboy-session-${sid}`);
  dirs.push(sdir);
  return { sid, sdir };
}
/** Every file of a dir with its content (the session dir before and after a read-only command). */
function dirState(dir: string): Record<string, string> | null {
  if (!existsSync(dir)) return null;
  return Object.fromEntries(readdirSync(dir).sort().map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
}

interface Cli {
  code: number | null;
  out: string;
  err: string;
}
function cli(cwd: string, projectDir: string, args: string[], stdin = '', sid?: string): Cli {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), CLAUDE_PROJECT_DIR: projectDir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  delete env.CLAUDE_CODE_SESSION_ID;
  if (sid !== undefined) env.CLAUDE_CODE_SESSION_ID = sid;
  const p = Bun.spawnSync(['bun', CLI, ...args], { cwd, env, stdin: new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe' });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

/** An lcov report: `file` with each line of `hits` (line → hit count). */
const lcov = (file: string, hits: Record<number, number>): string => `TN:\nSF:${file}\n${Object.entries(hits).map(([n, c]) => `DA:${n},${c}`).join('\n')}\nend_of_record\n`;

interface DiffOut {
  covered: number;
  total: number;
  files_without_executed_changes: string[];
  files: Record<string, { covered: number; total: number }>;
  in_report: string[];
  diff_lines: Record<string, number>;
  base: string;
  top: string;
  base_source: 'start' | 'head' | 'arg';
}
const diffOf = (r: Cli): DiffOut => JSON.parse(r.out) as DiffOut;

const RED_GREEN = [
  {
    id: 'AC-1',
    description: 'x is 1',
    test: 'x.test.ts',
    red: { command: 'bun test x.test.ts', output: '1 fail', exit_code: 1 },
    green: { command: 'bun test x.test.ts', output: '1 pass', exit_code: 0 },
  },
];
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
const reviewInput = (files: string[], extra: Record<string, unknown> = {}) => ({
  reviewed_files: files,
  category: 'fix-bug',
  findings: [],
  unknown_assumptions_checked: [],
  verdict: 'pass',
  dimensions_checked: [],
  ...extra,
});
/** The record a `review-write` / `test-write` run wrote. */
const saved = (r: Cli): Record<string, any> => JSON.parse(readFileSync((JSON.parse(r.out) as { path: string }).path, 'utf8')) as Record<string, any>;

// ── Item 5: review-write ─────────────────────────────────────────────────────────────────────

describe('review-write records trees and per-repo extra blobs', () => {
  test('files of two nested repos: `trees` from git; the agent\'s `trees` is dropped; `tree` is null', () => {
    const w = world();
    const forged = { [w.be]: 'a'.repeat(40), '/elsewhere': 'b'.repeat(40) };
    const r = cli(w.proj, w.proj, ['review-write'], JSON.stringify(reviewInput([join(w.be, 'src', 'x.ts'), join(w.fe, 'src', 'x.ts')], { trees: forged })));
    expect([r.code, r.err]).toEqual([0, '']);
    const rec = saved(r);
    expect(rec.tree).toBeNull();
    expect(rec.trees).toEqual({ [w.be]: headTree(w.be), [w.fe]: headTree(w.fe) });
    expect(headTree(w.be)).not.toBe(headTree(w.fe));
    expect(JSON.stringify(rec)).not.toContain('/elsewhere');
  });

  test('a work-tree edit is in the repo\'s tree, not HEAD\'s', () => {
    const w = world();
    writeFileSync(join(w.be, 'src', 'x.ts'), 'export const be = 2;\n');
    const rec = saved(cli(w.proj, w.proj, ['review-write'], JSON.stringify(reviewInput([join(w.be, 'src', 'x.ts')]))));
    expect(rec.trees[w.be]).not.toBe(headTree(w.be));
    expect(rec.trees[w.be]).toMatch(/^[0-9a-f]{40}$/);
  });

  test('a repo past the cap of hashed trees is warned about, as test-write does', () => {
    const base = tmp();
    const proj = join(base, 'proj');
    mkdirSync(proj);
    const files: string[] = [];
    for (let i = 0; i < 9; i++) files.push(join(commitRepo(join(proj, `r${i}`), `r${i}`), 'src', 'x.ts'));
    const r = cli(proj, proj, ['review-write'], JSON.stringify(reviewInput(files)));
    expect(r.code).toBe(0);
    expect(Object.keys(saved(r).trees)).toHaveLength(8);
    expect(r.err).toContain('warning: reviewed files span more repos than goodboy hashes');
    expect(r.err).toContain(join(proj, 'r8'));
  });

  test('extra_blobs: an ignored file of each repo is kept by its content id; a loose file has none', () => {
    const w = world();
    for (const repo of [w.be, w.fe]) {
      write(repo, '.gitignore', 'local.js\n');
      sh(repo, 'git add -A && git commit -q -m ignore');
    }
    const beLocal = write(w.be, 'local.js', 'be local\n');
    const feLocal = write(w.fe, 'local.js', 'fe local\n');
    const loose = write(w.proj, 'loose.js', 'loose\n');
    const r = cli(w.proj, w.proj, ['review-write'], JSON.stringify(reviewInput([beLocal, feLocal, loose, join(w.be, 'src', 'x.ts')], { extra_blobs: { [loose]: 'c'.repeat(40) } })));
    expect([r.code, r.err]).toEqual([0, '']);
    expect(saved(r).extra_blobs).toEqual({ [beLocal]: blobOf(beLocal), [feLocal]: blobOf(feLocal) });
  });

  test('a project dir that is a repo: `tree` and `extra_blobs` as before, no `trees`', () => {
    const w = world();
    write(w.be, '.gitignore', 'local.js\n');
    sh(w.be, 'git add -A && git commit -q -m ignore');
    const local = write(w.be, 'local.js', 'be local\n');
    const r = cli(w.be, w.be, ['review-write'], JSON.stringify(reviewInput([local, join(w.be, 'src', 'x.ts')])));
    expect([r.code, r.err]).toEqual([0, '']);
    const rec = saved(r);
    expect(rec.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(rec.trees).toBeUndefined();
    expect(rec.extra_blobs).toEqual({ [local]: blobOf(local) });
  });

  test('a project dir that is a repo holding a clone: `trees` names the clone, `extra_blobs` is judged against the project tree', () => {
    const w = world();
    const clone = commitRepo(join(w.be, 'vendor', 'lib'), 'lib');
    write(clone, '.gitignore', 'local.js\n');
    sh(clone, 'git add -A && git commit -q -m ignore');
    const local = write(clone, 'local.js', 'lib local\n');
    const cloneSrc = join(clone, 'src', 'x.ts');
    const rec = saved(cli(w.be, w.be, ['review-write'], JSON.stringify(reviewInput([local, cloneSrc, join(w.be, 'src', 'x.ts')]))));
    expect(rec.trees).toEqual({ [clone]: headTree(clone) });
    // The Stop judges every file of this project against its one `tree` (the clone is no group of its own), and
    //   the project's tree has neither the clone's ignored file nor its tracked ones (git holds a clone as a link).
    expect(rec.extra_blobs).toEqual({ [local]: blobOf(local), [cloneSrc]: blobOf(cloneSrc) });
  });

  test('a project repo holding a clone: a test-write record is fresh for an edited clone file (no hand-made extra_blobs)', () => {
    const w = world();
    const clone = commitRepo(join(w.be, 'vendor', 'lib'), 'lib');
    const cloneSrc = join(clone, 'src', 'x.ts');
    appendLine(clone, 'export const edited = 1;\n');
    const r = cli(w.be, w.be, ['test-write'], JSON.stringify(testInput([cloneSrc], [join(clone, 'x.test.ts')])));
    expect([r.code, r.err.includes('warning: no tested tree') ? 'no tree' : '']).toEqual([0, '']);
    const rec = saved(r) as unknown as TestResult;
    expect(rec.extra_blobs).toEqual({ [cloneSrc]: blobOf(cloneSrc) });
    // What the Stop does: one 'repo' group, the record unchanged, the file's content compared with the record.
    const { sid } = session();
    const edits = [{ file: cloneSrc, lastEditTimestamp: new Date(Date.now() + 60_000).toISOString() }];
    const judged = judgeGroups({ sessionId: sid, cwd: w.be, edits, records: [rec], deadline: newDeadline() });
    expect(judged).toHaveLength(1);
    expect(judged[0]!.g.kind).toBe('repo');
    const verdict = unionOverGroups(judged, validateTestCoverage);
    expect([verdict.ok, verdict.reason]).toEqual([true, undefined]);
    // The old per-repo blob (computed against the clone's own tree) was none: the file is in that tree, and the
    //   record then said nothing about the project's tree, which the Stop reads.
    expect(extraBlobsFor(clone, (rec as { trees?: Record<string, string> }).trees?.[clone], [cloneSrc])).toBeUndefined();
    const stale: TestResult = { ...rec };
    delete stale.extra_blobs;
    const staleVerdict = unionOverGroups(judgeGroups({ sessionId: sid, cwd: w.be, edits, records: [stale], deadline: newDeadline() }), validateTestCoverage);
    expect(staleVerdict.ok).toBe(false);
  });
});

// ── Item 6: coverage.changed ─────────────────────────────────────────────────────────────────

/** One `diff-coverage` output of the repo's `src/x.ts` (an edit made, `hit` of its lines run). */
function measured(repo: string, hit: boolean): DiffOut {
  appendLine(repo, `export const edit = 9;\n`);
  const report = join(repo, '..', `${hit ? 'hit' : 'miss'}-${Math.random().toString(36).slice(2, 6)}.lcov`);
  writeFileSync(report, lcov('src/x.ts', { 1: 1, 2: hit ? 1 : 0 }));
  const r = cli(repo, join(repo, '..'), ['diff-coverage', report]);
  expect([r.code, r.err]).toEqual([0, '']);
  return diffOf(r);
}
function appendLine(repo: string, line: string): void {
  writeFileSync(join(repo, 'src', 'x.ts'), readFileSync(join(repo, 'src', 'x.ts'), 'utf8') + line);
}

describe('diff-coverage output', () => {
  test('it names the repo it ran in: its real top, and where the base came from', () => {
    const w = world();
    const out = measured(w.be, true);
    expect(out.top).toBe(w.be);
    expect(out.base).toBe(head(w.be));
    expect(out.base_source).toBe('head');
    expect(out.files).toEqual({ 'src/x.ts': { covered: 1, total: 1 } });
  });

  test('the top is the real one when the shell stands in a link to the repo', () => {
    const w = world();
    const link = join(w.base, 'be-link');
    symlinkSync(w.be, link);
    appendLine(w.be, 'export const e = 1;\n');
    const report = join(w.base, 'r.lcov');
    writeFileSync(report, lcov('src/x.ts', { 1: 1, 2: 1 }));
    const r = cli(link, w.proj, ['diff-coverage', report]);
    expect([r.code, r.err]).toEqual([0, '']);
    expect(diffOf(r).top).toBe(w.be);
  });

  test('`--base` is the arg; a project dir that is a repo keeps HEAD, even with a session id', () => {
    const w = world();
    appendLine(w.be, 'export const e = 1;\n');
    const report = join(w.base, 'r.lcov');
    writeFileSync(report, lcov('src/x.ts', { 1: 1, 2: 1 }));
    const { sid } = session();
    expect(diffOf(cli(w.be, w.be, ['diff-coverage', report, '--base', 'HEAD'], '', sid)).base_source).toBe('arg');
    const own = diffOf(cli(w.be, w.be, ['diff-coverage', report], '', sid));
    expect([own.base_source, own.base, own.top]).toEqual(['head', head(w.be), w.be]);
  });
});

describe('diff-coverage in a nested repo, in a session: the base is the repo\'s start, read-only', () => {
  /** Pins made at the session's start (be: its commit, fe: its commit); then be commits once more and both
   *  repos are edited, so the start differs from HEAD in be. Returns the session. */
  function started(w: World) {
    const s = session();
    takeStartSnapshot(s.sid, w.proj);
    const start = head(w.be);
    appendLine(w.be, 'export const second = 2;\n');
    sh(w.be, 'git add -A && git commit -q -m second');
    appendLine(w.be, 'export const third = 3;\n');
    const report = join(w.base, 'be.lcov');
    writeFileSync(report, lcov('src/x.ts', { 1: 1, 2: 1, 3: 1 }));
    return { ...s, start, report };
  }

  test('a commit pin: measured against it (more lines than against HEAD), nothing written', () => {
    const w = world();
    const s = started(w);
    expect(readTopStart(s.sid, w.be)).toEqual({ kind: 'commit', head: s.start });
    const before = dirState(s.sdir);
    const r = cli(w.be, w.proj, ['diff-coverage', s.report], '', s.sid);
    expect([r.code, r.err]).toEqual([0, '']);
    const out = diffOf(r);
    expect([out.base, out.base_source, out.top, out.total]).toEqual([s.start, 'start', w.be, 2]); // lines 2 and 3
    expect(head(w.be)).not.toBe(s.start);
    // No pin, tips or edit-log entry was written, and nothing under the repos.
    expect(dirState(s.sdir)).toEqual(before);
    expect(existsSync(join(w.be, '.claude'))).toBe(false);
    expect(existsSync(join(w.proj, '.claude'))).toBe(false);
    // From a subdirectory of the repo too.
    expect(diffOf(cli(join(w.be, 'src'), w.proj, ['diff-coverage', s.report], '', s.sid)).base).toBe(s.start);
  });

  test('without a session id the default stays HEAD', () => {
    const w = world();
    const s = started(w);
    const out = diffOf(cli(w.be, w.proj, ['diff-coverage', s.report]));
    expect([out.base, out.base_source, out.total]).toEqual([head(w.be), 'head', 1]);
  });

  test('`--base` wins over the pin', () => {
    const w = world();
    const s = started(w);
    const out = diffOf(cli(w.be, w.proj, ['diff-coverage', s.report, '--base', 'HEAD'], '', s.sid));
    expect([out.base, out.base_source]).toEqual([head(w.be), 'arg']);
  });

  test('an empty pin (a repo with no commit at the start): the empty tree', () => {
    const base = tmp();
    const proj = join(base, 'proj');
    mkdirSync(proj);
    commitRepo(join(proj, 'be'), 'be');
    const fe = emptyRepo(join(proj, 'fe'));
    const s = session();
    takeStartSnapshot(s.sid, proj);
    expect(readTopStart(s.sid, fe)).toEqual({ kind: 'empty' });
    write(fe, 'src/x.ts', 'export const a = 1;\nexport const b = 2;\n');
    const report = join(base, 'fe.lcov');
    writeFileSync(report, lcov('src/x.ts', { 1: 1, 2: 1 }));
    const before = dirState(s.sdir);
    const r = cli(fe, proj, ['diff-coverage', report], '', s.sid);
    expect([r.code, r.err]).toEqual([0, '']);
    expect(diffOf(r)).toMatchObject({ base: EMPTY_TREE, base_source: 'start', total: 2, covered: 2, top: fe });
    expect(dirState(s.sdir)).toEqual(before);
  });

  test('no pin for the repo: fails with that reason, writes nothing, not even the session dir', () => {
    const w = world();
    const s = session();
    const report = join(w.base, 'r.lcov');
    writeFileSync(report, lcov('src/x.ts', { 1: 1 }));
    expect(readTopStart(s.sid, w.be)).toEqual({ kind: 'absent' });
    const r = cli(w.be, w.proj, ['diff-coverage', report], '', s.sid);
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toContain('no start pin');
    expect(r.err).toContain('Pass --base <rev>|empty only if the user decided to accept that base');
    expect(existsSync(s.sdir)).toBe(false);
  });

  test('an unknown pin (a repo first seen during the session, with history): fails with its reason', () => {
    const w = world();
    const s = session();
    takeStartSnapshot(s.sid, w.proj);
    const late = commitRepo(join(w.proj, 'late'), 'late'); // cloned after the start: no tips to relate it to
    expect(topStart(s.sid, late).kind).toBe('unknown');
    const report = join(w.base, 'r.lcov');
    writeFileSync(report, lcov('src/x.ts', { 1: 1 }));
    const before = dirState(s.sdir);
    const r = cli(late, w.proj, ['diff-coverage', report], '', s.sid);
    expect(r.code).toBe(1);
    expect(r.err).toContain('its start is unknown');
    expect(r.err).toContain('start snapshot');
    expect(r.err).toContain('Pass --base');
    expect(dirState(s.sdir)).toEqual(before);
    // `--base` is the escape the message names.
    expect(cli(late, w.proj, ['diff-coverage', report, '--base', 'HEAD'], '', s.sid).code).toBe(0);
  });

  test('the shell in the plain folder (no repo) fails as before', () => {
    const w = world();
    const s = session();
    takeStartSnapshot(s.sid, w.proj);
    const report = join(w.base, 'r.lcov');
    writeFileSync(report, lcov('src/x.ts', { 1: 1 }));
    const r = cli(w.proj, w.proj, ['diff-coverage', report], '', s.sid);
    expect(r.code).toBe(1);
    expect(r.err).toContain('not inside a git repository');
  });
});

// ── Item 6: test-write ───────────────────────────────────────────────────────────────────────

describe('test-write takes coverage.changed as one object or a list', () => {
  const run = (w: World, input: Record<string, unknown>, cwd: string = w.proj) => cli(cwd, w.proj, ['test-write'], JSON.stringify(input));

  test('a list with one output per repo is recorded whole, with each repo\'s `top`; the idle-file warning names the idle one', () => {
    const w = world();
    const be = measured(w.be, true);
    const fe = measured(w.fe, false);
    expect(fe.files_without_executed_changes).toEqual([join(w.fe, 'src', 'x.ts')]);
    const tested = [join(w.be, 'src', 'x.ts'), join(w.fe, 'src', 'x.ts')];
    const r = run(w, testInput(tested, [join(w.be, 'x.test.ts')], { coverage: { status: 'measured', changed: [be, fe] } }));
    expect(r.code).toBe(0);
    expect(r.err).toContain(`warning: no changed line of these tested files ran in the tests: ${join(w.fe, 'src', 'x.ts')}`);
    expect(r.err).not.toContain(join(w.be, 'src', 'x.ts'));
    const rec = saved(r);
    expect(rec.coverage.changed).toEqual([be, fe]);
    expect(rec.trees).toEqual({ [w.be]: workTreeState(w.be).tree, [w.fe]: workTreeState(w.fe).tree }); // both repos carry their edit
    // The same record read for each repo gives its own entry.
    expect(changedEntries(rec as TestResult, w.be, null)).toEqual([be]);
    expect(changedEntries(rec as TestResult, w.fe, null)).toEqual([fe]);
  });

  test('an entry whose `top` is no repo inside the project dir is dropped, with a warning; the others stay', () => {
    const w = world();
    const be = measured(w.be, true);
    const outside = commitRepo(join(w.base, 'outside'), 'outside');
    write(w.be, 'src/deep/.git', 'not a repo\n'); // a planted `.git`: not a repo top
    const entries = [
      be,
      { ...be, top: '/no/such/repo' },
      { ...be, top: outside },
      { ...be, top: join(w.be, 'src', 'deep') },
      { ...be, top: 'src' }, // not absolute
    ];
    const r = run(w, testInput([join(w.be, 'src', 'x.ts')], [join(w.be, 'x.test.ts')], { coverage: { status: 'measured', changed: entries } }));
    expect(r.code).toBe(0);
    expect(r.err.match(/names .* which is not a git repository inside the project dir; it is dropped/g)).toHaveLength(4);
    expect(r.err).toContain('coverage.changed[1] names /no/such/repo');
    expect(r.err).toContain(`coverage.changed[2] names ${outside}`);
    expect(saved(r).coverage.changed).toEqual([be]);
  });

  test('a single object with a bad `top` is dropped whole; the record is still written', () => {
    const w = world();
    const be = measured(w.be, true);
    const r = run(w, testInput([join(w.be, 'src', 'x.ts')], [join(w.be, 'x.test.ts')], { coverage: { status: 'measured', changed: { ...be, top: join(w.base, 'nowhere') } } }));
    expect(r.code).toBe(0);
    expect(r.err).toContain('coverage.changed names');
    const rec = saved(r);
    expect(rec.coverage.status).toBe('measured');
    expect(rec.coverage.changed).toBeUndefined();
  });

  test('a `top` spelled through a link is kept as the real top', () => {
    const w = world();
    const link = join(w.base, 'proj-link');
    symlinkSync(w.proj, link);
    const be = measured(w.be, true);
    const r = run(w, testInput([join(w.be, 'src', 'x.ts')], [join(w.be, 'x.test.ts')], { coverage: { status: 'measured', changed: [{ ...be, top: join(link, 'be') }] } }));
    expect(r.err).toBe('');
    expect(saved(r).coverage.changed).toEqual([be]);
  });

  test('the single-object form, with and without `top`, is recorded unchanged; a project dir that is a repo takes its own top', () => {
    const w = world();
    const be = measured(w.be, true);
    const { top: _top, base_source: _bs, ...legacy } = be;
    const tested = [join(w.be, 'src', 'x.ts')];
    // Run from the repo, which is the project dir: its own top is accepted (even above a project subdir).
    const own = cli(w.be, w.be, ['test-write'], JSON.stringify(testInput(tested, [join(w.be, 'x.test.ts')], { coverage: { status: 'measured', changed: be } })));
    expect([own.code, own.err]).toEqual([0, '']);
    expect(saved(own).coverage.changed).toEqual(be);
    const old = cli(w.be, w.be, ['test-write'], JSON.stringify(testInput(tested, [join(w.be, 'x.test.ts')], { coverage: { status: 'measured', changed: legacy } })));
    expect([old.code, old.err]).toEqual([0, '']);
    expect(saved(old).coverage.changed).toEqual(legacy);
    // The project dir is a subdir of the repo: the repo's top (above it) is still the project's own.
    const sub = join(w.be, 'src');
    const above = cli(sub, sub, ['test-write'], JSON.stringify(testInput(tested, [join(w.be, 'x.test.ts')], { coverage: { status: 'measured', changed: be } })));
    expect([above.code, above.err]).toEqual([0, '']);
    expect(saved(above).coverage.changed).toEqual(be);
    expect(changedEntries(saved(above) as TestResult, w.be)).toEqual([be]);
  });

  test('subprocess pairs: a pair with a bad `top` is dropped with a warning, a good one kept as the real top', () => {
    const w = world();
    const be = measured(w.be, true);
    const coverage = {
      status: 'measured',
      changed: be,
      subprocess: [
        { file: 'src/x.ts', test: 'x.test.ts', top: w.be },
        { file: 'src/x.ts', test: 'x.test.ts', top: '/no/such/repo' },
        { file: 'src/y.ts', test: 'x.test.ts' },
      ],
    };
    const r = run(w, testInput([join(w.be, 'src', 'x.ts')], [join(w.be, 'x.test.ts')], { coverage }));
    expect(r.code).toBe(0);
    expect(r.err).toContain('coverage.subprocess[1] names /no/such/repo');
    expect(saved(r).coverage.subprocess).toEqual([coverage.subprocess[0]!, coverage.subprocess[2]!]);
  });

  test('the schema: a bad list entry names its index; an empty list, a `top` that is no string and a bad base_source are errors', () => {
    const w = world();
    const be = measured(w.be, true);
    const bad = (changed: unknown) => {
      const v = validateTestResultInput(testInput([join(w.be, 'src', 'x.ts')], [join(w.be, 'x.test.ts')], { coverage: { status: 'measured', changed } }), [w.proj]);
      return v.ok ? [] : v.errors;
    };
    expect(bad([be, { covered: 5, total: 1, files_without_executed_changes: [] }]).join('\n')).toContain('coverage.changed[1] must be the whole `cli.ts diff-coverage` output');
    expect(bad([]).join('\n')).toContain('coverage.changed as a list needs 1 to 64 entries');
    expect(bad([be, 7]).join('\n')).toContain('coverage.changed[1] must be');
    expect(bad({ ...be, top: 7 }).join('\n')).toContain('coverage.changed.top must be the repo path');
    expect(bad({ ...be, base_source: 'tail' }).join('\n')).toContain('coverage.changed.base_source must be');
    expect(bad(be)).toEqual([]);
    expect(bad([be])).toEqual([]);
  });
});

// ── Item 6: the normalizer and its readers ───────────────────────────────────────────────────

const entry = (extra: Record<string, unknown> = {}) => ({
  covered: 1,
  total: 1,
  files_without_executed_changes: [],
  files: { 'src/x.ts': { covered: 1, total: 1 } },
  in_report: ['src/x.ts'],
  diff_lines: { 'src/x.ts': 1 },
  base: 'a'.repeat(40),
  ...extra,
});
const rec = (coverage: Record<string, unknown>, extra: Record<string, unknown> = {}): TestResult =>
  ({ timestamp: new Date().toISOString(), verdict: 'pass', tested_files: [], coverage: { status: 'measured', ...coverage }, ...extra }) as unknown as TestResult;

describe('changedEntries', () => {
  const OWN = '/real/own';
  const BE = '/real/own/be';
  const FE = '/real/fe';

  test('an object without `top` belongs to the project dir\'s own repo only', () => {
    const r = rec({ changed: entry() });
    expect(changedEntries(r, OWN, OWN)).toEqual([entry()]);
    expect(changedEntries(r, BE, OWN)).toEqual([]);
    expect(changedEntries(r, FE, OWN)).toEqual([]);
  });

  test('a project dir that is no repo (own null): an entry without `top` belongs to no repo', () => {
    const r = rec({ changed: entry() });
    expect(changedEntries(r, BE, null)).toEqual([]);
    expect(changedEntries(r, null, null)).toEqual([]);
    expect(changedEntries(r, OWN, null)).toEqual([]);
  });

  test('left out, the own top is the repo asked for: today\'s single-top reading', () => {
    const r = rec({ changed: entry() });
    expect(changedEntries(r, OWN)).toEqual([entry()]);
    expect(changedEntries(rec({ changed: entry({ top: BE }) }), OWN)).toEqual([]);
    expect(changedEntries(r, null)).toEqual([]);
  });

  test('list entries are picked by their `top`; the same record read for two repos gives two answers', () => {
    const be = entry({ top: BE, base: 'b'.repeat(40) });
    const fe = entry({ top: FE, base: 'f'.repeat(40) });
    const r = rec({ changed: [be, fe] });
    expect(changedEntries(r, BE, null)).toEqual([be]);
    expect(changedEntries(r, FE, null)).toEqual([fe]);
    expect(changedEntries(r, '/real/other', null)).toEqual([]);
    // An untagged entry in a list is the own repo's.
    const plain = entry();
    expect(changedEntries(rec({ changed: [plain, be] }), OWN, OWN)).toEqual([plain]);
    expect(changedEntries(rec({ changed: [plain, be] }), BE, OWN)).toEqual([be]);
  });

  test('a `top` through a link names the same repo (compared by real path)', () => {
    const base = tmp();
    const real = join(base, 'real');
    mkdirSync(real);
    const link = join(base, 'link');
    symlinkSync(real, link);
    const e = entry({ top: link });
    expect(changedEntries(rec({ changed: e }), real, null)).toEqual([e]);
  });

  test('what is not an entry is skipped: no coverage, a non-object, a `top` that is no path, a long list is cut', () => {
    expect(changedEntries({}, OWN)).toEqual([]);
    expect(changedEntries(rec({}), OWN)).toEqual([]);
    expect(changedEntries(rec({ changed: [null, 7, 'x', [entry()], entry({ top: 7 }), entry({ top: 'rel/be' })] }), OWN, null)).toEqual([]);
    const many = Array.from({ length: 80 }, () => entry({ top: BE }));
    expect(changedEntries(rec({ changed: many }), BE, null)).toHaveLength(64);
  });
});

describe('the readers see only the entries of their repo', () => {
  /** A record of `be/src/x.ts` and `fe/src/x.ts`, each measured in its own repo (be fully run, fe not). */
  function two() {
    const w = world();
    const be = entry({ top: w.be });
    const fe = entry({ top: w.fe, covered: 0, files: { 'src/x.ts': { covered: 0, total: 1 } } });
    const r = rec({ changed: [be, fe] }, { tested_files: [join(w.be, 'src', 'x.ts'), join(w.fe, 'src', 'x.ts')] });
    const edits = (repo: string) => [{ file: join(repo, 'src', 'x.ts'), lastEditTimestamp: null }];
    return { w, r, edits };
  }

  test('changedLineGaps: be passes on its entry, fe is judged on its own (0 of 1), neither on the other\'s', () => {
    const { w, r, edits } = two();
    expect(changedLineGaps({ results: [r], edits: edits(w.be), top: w.be, exempt: [], ownRealTop: null })).toEqual({ measured: true, gaps: [] });
    expect(changedLineGaps({ results: [r], edits: edits(w.fe), top: w.fe, exempt: [], ownRealTop: null })).toEqual({ measured: true, gaps: [{ file: 'src/x.ts', covered: 0, total: 1 }] });
  });

  test('changedLineGaps: a record measured in be only does not measure fe\'s file of the same name', () => {
    const { w, edits } = two();
    const onlyBe = rec({ changed: [entry({ top: w.be })] }, { tested_files: [join(w.be, 'src', 'x.ts'), join(w.fe, 'src', 'x.ts')] });
    expect(changedLineGaps({ results: [onlyBe], edits: edits(w.fe), top: w.fe, exempt: [], ownRealTop: null })).toEqual({ measured: false, gaps: [] });
    // And with an untagged entry (a hand-made record): it is the own repo's, never a nested repo's.
    const untagged = rec({ changed: entry() }, { tested_files: [join(w.fe, 'src', 'x.ts')] });
    expect(changedLineGaps({ results: [untagged], edits: edits(w.fe), top: w.fe, exempt: [], ownRealTop: null })).toEqual({ measured: false, gaps: [] });
  });

  test('changedLineGaps with today\'s single top: an untagged entry still measures the repo (ownRealTop left out)', () => {
    const w = world();
    const r = rec({ changed: entry() }, { tested_files: [join(w.be, 'src', 'x.ts')] });
    expect(changedLineGaps({ results: [r], edits: [{ file: join(w.be, 'src', 'x.ts'), lastEditTimestamp: null }], top: w.be, exempt: [] })).toEqual({ measured: true, gaps: [] });
  });

  test('subprocess pairs of the same name in two repos do not satisfy each other', () => {
    const w = world();
    for (const repo of [w.be, w.fe]) {
      write(repo, 'src/tool.ts', 'if (import.meta.main) console.log("run");\n');
      write(repo, 'tool.test.ts', 'import { spawnSync } from "node:child_process";\ntest("t", () => { spawnSync("bun", ["src/tool.ts"]); });\n');
    }
    const suites = [{ name: 'int', command: 'bun test', passed: 1, failed: 0, output: '', type: 'integration', duration_ms: 5 }];
    const onlyBe = rec(
      { changed: entry({ top: w.be }), subprocess: [{ file: 'src/tool.ts', test: 'tool.test.ts', top: w.be }] },
      { suites, test_files: [join(w.be, 'tool.test.ts'), join(w.fe, 'tool.test.ts')] },
    );
    expect(subprocessEvidence(onlyBe, 'src/tool.ts', w.be, undefined, null)).toBe(true);
    expect(subprocessEvidence(onlyBe, 'src/tool.ts', w.fe, undefined, null)).toBe(false);
    // Both named: each repo is satisfied by its own pair.
    const both = rec(
      { changed: [], subprocess: [{ file: 'src/tool.ts', test: 'tool.test.ts', top: w.be }, { file: 'src/tool.ts', test: 'tool.test.ts', top: w.fe }] },
      { suites, test_files: [join(w.be, 'tool.test.ts'), join(w.fe, 'tool.test.ts')] },
    );
    expect(subprocessEvidence(both, 'src/tool.ts', w.be, undefined, null)).toBe(true);
    expect(subprocessEvidence(both, 'src/tool.ts', w.fe, undefined, null)).toBe(true);
    // A pair with no `top` is the own repo's: with no own repo it satisfies neither.
    const plain = rec({ changed: [], subprocess: [{ file: 'src/tool.ts', test: 'tool.test.ts' }] }, { suites, test_files: [join(w.be, 'tool.test.ts')] });
    expect(subprocessEvidence(plain, 'src/tool.ts', w.be, undefined, null)).toBe(false);
    expect(subprocessEvidence(plain, 'src/tool.ts', w.be)).toBe(true); // today's single top
    expect(subprocessPairs(both, w.be, null)).toEqual([{ file: 'src/tool.ts', test: 'tool.test.ts', top: w.be }]);
  });
});
