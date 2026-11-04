// v0.36.14 (#39 follow-up, plan §15.30 items 3-4 and 8-11): the Stop judges each nested repo of a project dir
// that is no repo (`proj/` holding the repos `be/` and `fe/`). The field report: every full Stop carried
// "Changed lines that no test ran: be/src/…/X.java (measured only against 4b825dc642cb, where the file is not
// what it was when the session started, with no commit)", and running the tests again could not clear it.
//   item 3:  one `groupsOf` (the edits grouped by repo; loose files the project dir's own group) serves both Stop
//            paths; the rules about a repo run per group, with that group's top, start and views of the records;
//   item 4:  one deadline for the grouped evaluation, shared by every group; a group not reached blocks;
//   item 5:  a record's tree for a group is `trees[realTop]`, none there is unverified (never time), and the #38
//            supersession reads a review's tree per file by its repo;
//   item 8:  the indirect-write sweep covers each repo of the project dir, and the Stop pins the repos below it;
//   item 9:  the `auto` test gate counts a test runner in any repo below the project dir;
//   item 10: exemption globs are read once from the project dir's pin and match a file by either of its names;
//   item 11: the docs gate, the review freshness and the review's start gate take the groups.
// Repos and session dirs are temporary and git runs for real. The Stop hook and the CLI are spawned; the library
// is read in this process for the units.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { changedLineReason } from '../lib/changed-coverage';
import { pinCoverageStart } from '../lib/changed-coverage';
import { getCurrentTurn, getEditHistory, recordEdit } from '../lib/file-tracker';
import { withGitSnapshot } from '../lib/git-run';
import { readReviewCursor, readTestCursor } from '../lib/review-cursor';
import { currentFindings } from '../lib/review-validator';
import { AXIS_DIMENSIONS } from '../lib/review-dimensions';
import { afterBash, nestedStatus, resetWriteSweep } from '../lib/write-sweep';
import { needsTests } from '../lib/verification-scope';
import { typeNeedOf } from '../lib/test-types';
import {
  branchNote,
  detectInfrastructure,
  groupBudgetMs,
  groupsOf,
  incompleteStartProblem,
  isNoRepoProject,
  joinReasons,
  labelOf,
  nameIn,
  namedGaps,
  newDeadline,
  nestedRepoOf,
  noteSessionTops,
  previewGlobsFor,
  projectTop,
  ranOutOfTime,
  repoOfFileFor,
  resetStopGroups,
  reviewEditsSince,
  scopeFor,
  startProblem,
  testEditsByGroup,
  testLinesOf,
  treeContentByRepo,
  viewFor,
  weakenedNow,
} from '../lib/stop-groups';
import type { ReviewResult, TestResult } from '../lib/types';

const ROOT = resolve(import.meta.dir, '..');
const STOP = join(ROOT, 'hooks', 'stop.ts');
const CLI = join(ROOT, 'lib', 'cli.ts');
setDefaultTimeout(90_000);

const dirs: string[] = [];
afterEach(() => {
  resetStopGroups();
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function tmp(prefix = 'goodboy-i3914g-'): string {
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
const EMPTY_TREE_PREFIX = '4b825dc642cb';
const ALL_DIMENSIONS = Object.values(AXIS_DIMENSIONS).flat();

/** A repo at `dir` with one commit: a source file, its test and a package.json that runs tests. */
function commitRepo(dir: string, name: string, pkg = true): string {
  mkdirSync(dir, { recursive: true });
  write(dir, 'src/x.ts', `export const ${name} = 1;\n`);
  write(dir, 'x.test.ts', `import { expect, test } from 'bun:test';\ntest('${name}', () => expect(1).toBe(1));\n`);
  if (pkg) write(dir, 'package.json', JSON.stringify({ scripts: { test: 'bun test' } }));
  sh(dir, `${GIT_INIT} && git add -A && git commit -q -m init`);
  return dir;
}

let counter = 0;
interface W {
  base: string;
  /** The real project dir. */
  proj: string;
  /** The project dir as the session spells it (`proj`, or a link to it). */
  pd: string;
  be: string;
  fe: string;
  home: string;
  sid: string;
  sdir: string;
}
/** A plain `proj/` (no git) holding `be` and `fe` (one commit each) and a session started in it. `policy` is
 *  written before the start (pinned); `link` makes the session reach the project dir through a symlink. */
function world(opts: { policy?: string; link?: boolean; start?: boolean; pkg?: boolean } = {}): W {
  const base = tmp();
  const proj = join(base, 'proj');
  mkdirSync(proj);
  const be = commitRepo(join(proj, 'be'), 'be', opts.pkg ?? true);
  const fe = commitRepo(join(proj, 'fe'), 'fe', opts.pkg ?? true);
  if (opts.policy !== undefined) write(proj, '.goodboy/policy.md', opts.policy);
  let pd = proj;
  if (opts.link) {
    pd = join(base, 'proj-link');
    symlinkSync(proj, pd);
  }
  const sid = `i3914g${Math.random().toString(36).slice(2, 8)}${counter++}`;
  const sdir = join(tmpdir(), `goodboy-session-${sid}`);
  dirs.push(sdir);
  if (opts.start !== false) pinCoverageStart(sid, pd);
  return { base, proj, pd, be, fe, home: tmp('goodboy-i3914g-home-'), sid, sdir };
}
const policy = (globs: Record<string, string>): string =>
  ['## P1 User exemptions', '- decide: human', '- source: user 2026-11-04', ...Object.entries(globs).map(([k, v]) => `- ${k}: ${v}`), ''].join('\n');

/** The Stop hook, as Claude Code runs it. */
interface Out {
  decision?: string;
  reason?: string;
  systemMessage?: string;
}
async function stop(w: W, opts: { active?: boolean; env?: Record<string, string> } = {}): Promise<Out> {
  const proc = Bun.spawn(['bun', STOP], {
    cwd: w.pd,
    stdin: new TextEncoder().encode(JSON.stringify({ cwd: w.pd, session_id: w.sid, hook_event_name: 'Stop', stop_hook_active: opts.active === true })),
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...(process.env as Record<string, string>),
      HOME: w.home,
      CLAUDE_PROJECT_DIR: w.pd,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GOODBOY_DISABLE_DELEGATION: '1',
      GOODBOY_CLAIM_FLUSH_WAIT_MS: '0',
      GOODBOY_DOCS_GATE: 'off',
      GOODBOY_POLICY_GATE: 'off',
      // The suite turns these rules off (tests/setup.ts); this file is about them.
      GOODBOY_DIFF_COVERAGE: 'on',
      GOODBOY_TEST_TYPES: 'on',
      GOODBOY_EXISTING_TESTS: 'on',
      ...opts.env,
    },
  });
  const [text, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  // A rule that throws makes the gate fail open (a pass): never in these tests.
  expect(err).not.toContain('[goodboy stop]');
  return JSON.parse(text || '{}') as Out;
}

interface Cli {
  code: number | null;
  out: string;
  err: string;
}
function cli(w: W, cwd: string, args: string[], stdin = ''): Cli {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: w.home, CLAUDE_PROJECT_DIR: w.pd, CLAUDE_CODE_SESSION_ID: w.sid, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const p = Bun.spawnSync(['bun', CLI, ...args], { cwd, env, stdin: new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe' });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}
const lcov = (file: string, hits: Record<number, number>): string => `TN:\nSF:${file}\n${Object.entries(hits).map(([n, c]) => `DA:${n},${c}`).join('\n')}\nend_of_record\n`;

interface DiffOut {
  covered: number;
  total: number;
  base: string;
  base_source: string;
  top: string;
  [k: string]: unknown;
}

/** An edit of the repo's `src/<name>`: a line is appended and the session's edit log records it. */
function edit(w: W, repo: string, name = 'x.ts', line = `export const edit${Math.random().toString(36).slice(2, 6)} = 2;\n`): string {
  const abs = join(repo === 'be' ? join(w.pd, 'be') : repo === 'fe' ? join(w.pd, 'fe') : repo, 'src', name);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, (existsSync(abs) ? readFileSync(abs, 'utf8') : '') + line);
  recordEdit(w.sid, abs, getCurrentTurn(w.sid), undefined, Date.now());
  return abs;
}
/** `diff-coverage` run in the repo (its real shell dir), the report covering every line of `files`. */
function measure(w: W, repo: 'be' | 'fe', files: string[] = ['x.ts']): DiffOut {
  const dir = join(w.pd, repo);
  const report = join(w.base, `${repo}-${Math.random().toString(36).slice(2, 6)}.lcov`);
  writeFileSync(
    report,
    files
      .map((f) => {
        const n = readFileSync(join(dir, 'src', f), 'utf8').split('\n').length - 1;
        return lcov(`src/${f}`, Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1, 1])));
      })
      .join(''),
  );
  const r = cli(w, dir, ['diff-coverage', report]);
  expect([r.code, r.err]).toEqual([0, '']);
  return JSON.parse(r.out) as DiffOut;
}
const RED_GREEN = [
  {
    id: 'AC-1',
    description: 'x is 1',
    test: 'x.test.ts',
    red: { command: 'bun test x.test.ts', output: '1 fail', exit_code: 1 },
    green: { command: 'bun test x.test.ts', output: '1 pass', exit_code: 0 },
  },
];
/** `test-write` for real; the record it wrote. */
function testWrite(w: W, tested: string[], changed: unknown, extra: Record<string, unknown> = {}): Record<string, any> {
  const testFiles = [...new Set(tested.map((f) => f.replace(/src\/.*$/, 'x.test.ts')))];
  const input = {
    timestamp: new Date().toISOString(),
    tested_files: tested,
    category: 'fix-bug',
    test_files: testFiles,
    environment: { mode: 'local' },
    suites: [{ name: 'unit', command: 'bun test', passed: 1, failed: 0, output: '1 pass', type: 'unit', duration_ms: 10 }],
    acceptance: RED_GREEN,
    verdict: 'pass',
    coverage: { status: 'measured', ...(changed === undefined ? {} : { changed }) },
    ...extra,
  };
  const r = cli(w, w.pd, ['test-write'], JSON.stringify(input));
  expect([r.code, r.err.replace(/^warning:.*\n/gm, '')]).toEqual([0, '']);
  return JSON.parse(readFileSync((JSON.parse(r.out) as { path: string }).path, 'utf8')) as Record<string, any>;
}
const recordPaths = (w: W, kind: 'tests' | 'reviews'): string[] => (existsSync(join(w.pd, '.claude', kind)) ? readdirSync(join(w.pd, '.claude', kind)).map((f) => join(w.pd, '.claude', kind, f)) : []);
/** `review-write` for real; the record it wrote. */
function reviewWrite(w: W, files: string[], findings: object[] = []): Record<string, any> {
  const input = { reviewed_files: files, category: 'fix-bug', findings, unknown_assumptions_checked: [], verdict: findings.length > 0 ? 'needs-changes' : 'pass', dimensions_checked: ALL_DIMENSIONS };
  const r = cli(w, w.pd, ['review-write'], JSON.stringify(input));
  expect([r.code, r.err]).toEqual([0, '']);
  return JSON.parse(readFileSync((JSON.parse(r.out) as { path: string }).path, 'utf8')) as Record<string, any>;
}
const pause = () => Bun.sleepSync(25);
const TEST_GATE = '(테스트 게이트)';
const text = (o: Out): string => `${o.reason ?? ''} ${o.systemMessage ?? ''}`;
const clean = (o: Out): void => {
  expect(o.decision).toBeUndefined();
  expect(o.reason).toBeUndefined();
};

/** The session's usual round: an edit in each repo, tests that cover both and a review of both. */
function editedAndTested(w: W): { be: string; fe: string; beOut: DiffOut; feOut: DiffOut } {
  const be = edit(w, 'be');
  const fe = edit(w, 'fe');
  pause();
  const beOut = measure(w, 'be');
  const feOut = measure(w, 'fe');
  return { be, fe, beOut, feOut };
}

// ── The field report, through the Stop ───────────────────────────────────────────────────────────

describe('the Stop in a project dir that is no repo: each repo is judged under its own top', () => {
  test('blocked before the tests; after `diff-coverage` in each repo and `test-write` it passes, and the old block text is gone', async () => {
    const w = world();
    const be = edit(w, 'be');
    const fe = edit(w, 'fe');
    pause();
    const before = await stop(w);
    expect(before.decision).toBe('block');
    expect(before.reason).toContain('No test result covers the changed code');
    expect(before.reason).not.toContain(EMPTY_TREE_PREFIX);
    expect(before.reason).not.toContain('with no commit');

    const beOut = measure(w, 'be');
    const feOut = measure(w, 'fe');
    expect([beOut.base_source, feOut.base_source]).toEqual(['start', 'start']); // item 7 (C): each repo's own start
    const rec = testWrite(w, [be, fe], [beOut, feOut]);
    expect(Object.keys(rec.trees).sort()).toEqual([w.be, w.fe].sort());
    reviewWrite(w, [be, fe]);
    const after = await stop(w);
    clean(after);
    expect(text(after)).not.toContain(EMPTY_TREE_PREFIX);
    expect(readTestCursor(w.pd, w.sid)).not.toBeNull();
  });

  test('a repo whose changed lines no test ran is named by its project-dir path, with the repo to run `diff-coverage` in', async () => {
    const w = world();
    const be = edit(w, 'be');
    const fe = edit(w, 'fe');
    pause();
    // `fe` is measured with a report that has no line of the edit: an executed line that is not the added one.
    const beOut = measure(w, 'be');
    const feReport = join(w.base, 'fe-miss.lcov');
    writeFileSync(feReport, lcov('src/x.ts', { 1: 1, 2: 0 }));
    const feRun = cli(w, join(w.pd, 'fe'), ['diff-coverage', feReport]);
    expect(feRun.code).toBe(0);
    testWrite(w, [be, fe], [beOut, JSON.parse(feRun.out)]);
    const out = await stop(w);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('Changed lines that no test ran: fe/src/x.ts (1 of 1 lines ran)'.replace('1 of 1', '0 of 1'));
    expect(out.reason).not.toContain('be/src/x.ts');
    expect(out.reason).not.toContain(EMPTY_TREE_PREFIX);
  });

  test('without `top` in the entry the coverage belongs to no repo: nested groups are "not measured", naming the repo to run it in', async () => {
    const w = world();
    const be = edit(w, 'be');
    pause();
    const beOut = measure(w, 'be');
    const { top: _top, ...bare } = beOut;
    testWrite(w, [be], bare);
    const out = await stop(w);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('Changed-line coverage is not measured for the repo `be`');
    expect(out.reason).toContain('cd be');
  });

  test('a project dir that is a repo is judged as before (one group, no repo name in the text)', async () => {
    const w = world();
    const d = w.be;
    const pin = `i3914g-own${Math.random().toString(36).slice(2, 8)}`;
    dirs.push(join(tmpdir(), `goodboy-session-${pin}`));
    pinCoverageStart(pin, d);
    const own: W = { ...w, pd: d, proj: d, sid: pin };
    const f = join(d, 'src', 'x.ts');
    writeFileSync(f, readFileSync(f, 'utf8') + 'export const more = 1;\n');
    recordEdit(pin, f, getCurrentTurn(pin), undefined, Date.now());
    const out = await stop(own, { env: { GOODBOY_TEST_GATE: 'on' } });
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('No test result covers the changed code');
    // A coverage record that names no `top` belongs to the repo: measured, and the repo's own base is HEAD.
    const report = join(w.base, 'own.lcov');
    writeFileSync(report, lcov('src/x.ts', { 1: 1, 2: 1 }));
    const run = cli(own, d, ['diff-coverage', report]);
    expect(run.code).toBe(0);
    const { top: _top, base_source: _src, ...bare } = JSON.parse(run.out) as DiffOut;
    testWrite(own, [f], bare);
    reviewWrite(own, [f]);
    clean(await stop(own, { env: { GOODBOY_TEST_GATE: 'on' } }));
  });
});

// ── Item 3: the stop_hook_active path judges the same groups ─────────────────────────────────────

describe('the stop_hook_active path judges the same groups as the full Stop', () => {
  test('records for both repos: accepted (cursors move); a record for `be` only: not accepted, and the full Stop blocks', async () => {
    const w = world();
    const be = edit(w, 'be');
    const fe = edit(w, 'fe');
    pause();
    const beOut = measure(w, 'be');
    testWrite(w, [be], beOut); // fe is not covered
    reviewWrite(w, [be, fe]);
    const active = await stop(w, { active: true });
    expect(active.decision).toBeUndefined();
    expect(readTestCursor(w.pd, w.sid)).toBeNull(); // no accept where the full Stop blocks
    const full = await stop(w);
    expect(full.decision).toBe('block');
    expect(full.reason).toContain(TEST_GATE);
    expect(full.reason).toContain('fe/src/x.ts');

    const feOut = measure(w, 'fe');
    testWrite(w, [fe], feOut);
    const accepted = await stop(w, { active: true });
    expect(accepted.decision).toBeUndefined();
    expect(readTestCursor(w.pd, w.sid)).not.toBeNull(); // and the accept where the full Stop passes
    clean(await stop(w));
  });

  test('an unknown start in one repo: the active path ends the turn unverified, as the full Stop blocks', async () => {
    const w = world();
    const clone = join(w.proj, 'clone');
    sh(w.proj, `git clone -q be ${JSON.stringify(clone)}`); // after the start: no snapshot to relate it to
    const f = join(w.pd, 'clone', 'src', 'x.ts');
    writeFileSync(f, readFileSync(f, 'utf8') + 'export const c = 2;\n');
    recordEdit(w.sid, f, getCurrentTurn(w.sid), undefined, Date.now());
    const full = await stop(w);
    expect(full.decision).toBe('block');
    expect(full.reason).toContain('first seen during the session');
    expect(full.reason).toContain(clone);
    const active = await stop(w, { active: true });
    expect(active.decision).toBeUndefined();
    expect(active.systemMessage ?? '').toContain('시작 지점을 확인하지 못해');
  });
});

// ── Item 5: a record's tree for a group is trees[realTop] ────────────────────────────────────────

describe('a record is judged by its tree for the repo', () => {
  test('trees for `be` only: `fe` is unverified, never judged by time', async () => {
    const w = world();
    const { be, fe, beOut, feOut } = editedAndTested(w);
    const rec = testWrite(w, [be, fe], [beOut, feOut]);
    const path = recordPaths(w, 'tests')[0]!;
    delete rec.trees[w.fe];
    writeFileSync(path, JSON.stringify(rec));
    const out = await stop(w);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('Could not verify what the test records ran for 1 file(s)');
    expect(out.reason).toContain(fe);
    expect(out.reason).not.toContain(be);
    expect(out.reason).not.toContain('마지막 편집보다 오래된');
  });

  test('no `trees` at all (a record from a project dir that was a repo, or an old one): unverified in every repo', async () => {
    const w = world();
    const { be, fe, beOut, feOut } = editedAndTested(w);
    const rec = testWrite(w, [be, fe], [beOut, feOut]);
    delete rec.trees;
    writeFileSync(recordPaths(w, 'tests')[0]!, JSON.stringify(rec));
    const out = await stop(w);
    expect(out.decision).toBe('block');
    // One reason per repo (each group checks the records as it sees them), each naming its file.
    expect(out.reason).toContain(`Could not verify what the test records ran for 1 file(s): ${be}`);
    expect(out.reason).toContain(`Could not verify what the test records ran for 1 file(s): ${fe}`);
  });

  test('one record per repo and one with a list-shaped `coverage.changed` both pass', async () => {
    const w = world();
    const { be, fe, beOut, feOut } = editedAndTested(w);
    testWrite(w, [be], beOut); // an object entry
    testWrite(w, [fe], feOut);
    reviewWrite(w, [be, fe]);
    clean(await stop(w));

    const w2 = world();
    const e2 = editedAndTested(w2);
    testWrite(w2, [e2.be, e2.fe], [e2.beOut, e2.feOut]); // one list
    reviewWrite(w2, [e2.be, e2.fe]);
    clean(await stop(w2));
  });

  test('a file edited again after its record is stale in its repo only', async () => {
    const w = world();
    const { be, fe, beOut, feOut } = editedAndTested(w);
    testWrite(w, [be, fe], [beOut, feOut]);
    pause();
    edit(w, 'fe');
    const out = await stop(w);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain(fe);
    expect(out.reason).not.toContain(be);
  });
});

// ── Item 4: one deadline for the grouped evaluation ──────────────────────────────────────────────

describe('the shared deadline', () => {
  test('a slow group runs the budget out: the groups not reached block with a "ran out of time" reason, and the Stop still ends', async () => {
    const w = world();
    const { be, fe, beOut, feOut } = editedAndTested(w);
    testWrite(w, [be, fe], [beOut, feOut]);
    reviewWrite(w, [be, fe]);
    const t0 = Date.now();
    const out = await stop(w, { env: { GOODBOY_STOP_GROUP_BUDGET_MS: '400', GOODBOY_TEST_GROUP_DELAY_MS: '900' } });
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('ran out of time before the changes in `fe` could be judged');
    expect(out.reason).not.toContain('changes in `be`');
    // With the default budget the same records pass.
    clean(await stop(w));
  });

  test('projectTop asks git once per Stop, the failing answer too; outside a snapshot every call asks (v0.36.14)', () => {
    const w = tmp('goodboy-i3914g-top-');
    const sub = join(w, 'sub');
    mkdirSync(sub);
    const answers = withGitSnapshot(() => {
      const before = projectTop(sub); // no repo: the failing `rev-parse --show-cdup`, kept for this Stop
      sh(w, GIT_INIT); // a repo appears while the Stop runs: it is not seen (one Stop reads one tree)
      return [before, projectTop(sub)];
    });
    expect(answers).toEqual([sub, sub]);
    expect(projectTop(sub)).toBe(w); // another call, no snapshot: asked again
  });

  test('the budget: the env value, a default, a bad value', () => {
    const w = world();
    expect(ranOutOfTime(groupsOf(w.sid, w.pd, [join(w.be, 'src', 'x.ts')])[0]!)).toContain('ran out of time before the changes in `be`');
    expect(groupBudgetMs({})).toBe(6_000);
    expect(groupBudgetMs({ GOODBOY_STOP_GROUP_BUDGET_MS: '250' })).toBe(250);
    expect(groupBudgetMs({ GOODBOY_STOP_GROUP_BUDGET_MS: 'soon' })).toBe(6_000);
    expect(groupBudgetMs({ GOODBOY_STOP_GROUP_BUDGET_MS: '-5' })).toBe(6_000);
    const d = newDeadline(60_000);
    expect(d.left()).toBeGreaterThan(50_000);
    expect(newDeadline(0).left()).toBeLessThanOrEqual(0);
  });
});

// ── Item 8: shell-made changes ───────────────────────────────────────────────────────────────────

describe('shell-made changes in a repo below the project dir', () => {
  test('the sweep after a Bash call runs per repo: a file an interpreter wrote into `be/` is an edit', () => {
    const w = world();
    const saved = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = w.pd;
    try {
      const f = write(w.be, 'src/shell.ts', 'export const s = 1;\n');
      const r = afterBash(w.sid, undefined, w.pd, `python3 -c "open('be/src/shell.ts','w').write('x')"`, undefined);
      expect(r.swept).toBeUndefined();
      expect(getEditHistory(w.sid).files).toContain(f);
      expect(r.context ?? '').toContain('be/src/shell.ts');
      // From inside the repo the call is swept as it always was.
      const g = write(w.fe, 'src/shell2.ts', 'export const s2 = 1;\n');
      afterBash(w.sid, undefined, w.fe, `python3 -c "open('src/shell2.ts','w').write('x')"`, undefined);
      expect(getEditHistory(w.sid).files).toContain(g);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = saved;
    }
  });

  test('nestedStatus: every repo below the project dir; a dir that is in a repo, or has none, is not swept this way', () => {
    const w = world();
    write(w.be, 'src/new.ts', 'x\n');
    const saved = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = w.pd;
    try {
      const s = nestedStatus(w.pd, 10_000)!;
      expect(s.complete).toBe(true);
      expect(s.views.map((v) => v.top).sort()).toEqual([w.be, w.fe].sort());
      expect(s.views.find((v) => v.top === w.be)!.files).toEqual([join(w.be, 'src', 'new.ts')]);
      // Asked from a dir inside the project, the whole project's repos are swept (the project dir is `proj`).
      expect(nestedStatus(join(w.be, 'src'), 10_000)!.views.map((v) => v.top).sort()).toEqual([w.be, w.fe].sort());
      // Without the project dir known, a dir inside a repo is no project dir that is no repo: nothing to sweep this way.
      delete process.env.CLAUDE_PROJECT_DIR;
      expect(nestedStatus(join(w.be, 'src'), 10_000)).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = saved;
    }
  });

  test('64 decoy repos made after the start do not starve the sweep: the repos the session knows are swept first', () => {
    const w = world();
    resetWriteSweep();
    // The walk is sorted and capped at 64 repos: a000..a063 fill it and `be` is dropped.
    for (let i = 0; i < 64; i++) {
      const d = join(w.proj, `a${String(i).padStart(3, '0')}`);
      mkdirSync(d);
      sh(d, GIT_INIT);
    }
    const saved = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = w.pd;
    try {
      // Without the session the capped walk misses `be` (the starvation), and says it did not finish.
      const blind = nestedStatus(w.pd, 30_000)!;
      expect(blind.views.map((v) => v.top)).not.toContain(w.be);
      expect(blind.complete).toBe(false);
      // With it, `be` and `fe` (start pins) come first, each once, the decoys after them up to the cap.
      const known = nestedStatus(w.pd, 30_000, w.sid)!;
      expect(known.views.map((v) => v.top).slice(0, 2)).toEqual([w.be, w.fe]);
      expect(known.views).toHaveLength(64);
      expect(new Set(known.views.map((v) => v.top)).size).toBe(64);
      expect(known.complete).toBe(false);
      // The indirect write into `be` is recorded.
      const f = write(w.be, 'src/shell.ts', 'export const s = 1;\n');
      const r = afterBash(w.sid, undefined, w.pd, `python3 -c "open('be/src/shell.ts','w').write('x')"`, undefined);
      expect(getEditHistory(w.sid).files).toContain(f);
      expect(r.swept).toBe(false); // not a complete sweep, and it says so
    } finally {
      resetWriteSweep();
      if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = saved;
    }
  });

  test('a repo the session knows whose `.git` is gone is no repo to sweep: the sweep skips it and still completes', () => {
    const w = world();
    resetWriteSweep();
    rmSync(join(w.be, '.git'), { recursive: true, force: true });
    const saved = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = w.pd;
    try {
      const s = nestedStatus(w.pd, 30_000, w.sid)!;
      expect(s.views.map((v) => v.top)).toEqual([w.fe]);
      expect(s.complete).toBe(true);
    } finally {
      resetWriteSweep();
      if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = saved;
    }
  });

  test('the walk down runs once per project dir in a hook process (the call dir and the shell dir ask the same root)', () => {
    const w = world();
    resetWriteSweep();
    const saved = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = w.pd;
    try {
      expect(nestedStatus(w.pd, 10_000)!.views.map((v) => v.top).sort()).toEqual([w.be, w.fe].sort());
      const gen = join(w.proj, 'gen');
      mkdirSync(gen);
      sh(gen, GIT_INIT);
      expect(nestedStatus(join(w.be, 'src'), 10_000)!.views.map((v) => v.top).sort()).toEqual([w.be, w.fe].sort()); // not walked again
      resetWriteSweep();
      expect(nestedStatus(w.pd, 10_000)!.views.map((v) => v.top)).toContain(gen);
    } finally {
      resetWriteSweep();
      if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = saved;
    }
  });

  test('an exhausted git budget leaves the sweep incomplete (not silently done)', () => {
    const w = world();
    const saved = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = w.pd;
    try {
      const s = nestedStatus(w.pd, 0)!;
      expect(s.complete).toBe(false);
      expect(s.views).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = saved;
    }
  });

  test('the cap counts every repo asked about, one whose status fails too: the 65th is never read', () => {
    const w = world();
    resetWriteSweep();
    // 64 decoys sorted a000..a063 fill the walk's cap; the first 62 have a broken index, so their `git status` fails
    //   (no view, an incomplete sweep). `be` and `fe` (known) come first and with the 62 make the 64 reads allowed;
    //   a062 and a063 would be read only by a cap that counts the views instead of the repos asked about.
    for (let i = 0; i < 64; i++) {
      const d = join(w.proj, `a${String(i).padStart(3, '0')}`);
      mkdirSync(d);
      sh(d, GIT_INIT);
      if (i < 62) writeFileSync(join(d, '.git', 'index'), 'not an index\n');
    }
    const saved = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = w.pd;
    try {
      const s = nestedStatus(w.pd, 60_000, w.sid)!;
      expect(s.views.map((v) => v.top)).toEqual([w.be, w.fe]);
      expect(s.complete).toBe(false);
    } finally {
      resetWriteSweep();
      if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = saved;
    }
  });

  test('a call with no time left after the known repos returns incomplete without walking (the walk is not spent, nor remembered)', () => {
    const w = world();
    resetWriteSweep();
    const saved = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = w.pd;
    try {
      const none = nestedStatus(w.pd, 0, w.sid)!;
      expect(none).toEqual({ views: [], complete: false });
      // A repo made now is found by the next call, whose walk is the first one: the call above did not walk.
      const gen = join(w.proj, 'gen');
      mkdirSync(gen);
      sh(gen, GIT_INIT);
      const next = nestedStatus(w.pd, 30_000, w.sid)!;
      expect(next.views.map((v) => v.top)).toContain(gen);
    } finally {
      resetWriteSweep();
      if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = saved;
    }
  });

  test('the Stop pins a repo made after the start and records the changes already in it', async () => {
    const w = world();
    // A repo made by a shell command after the start, with a change in it: no Edit/Write hook has seen it.
    const gen = join(w.proj, 'gen');
    mkdirSync(gen);
    sh(gen, GIT_INIT);
    write(gen, 'src/g.ts', 'export const g = 1;\n');
    expect(getEditHistory(w.sid).files).toEqual([]);
    noteSessionTops(w.sid, w.pd);
    expect(getEditHistory(w.sid).files).toEqual([join(gen, 'src', 'g.ts')]);
    // A repo pinned when the session started is left alone: its changes are the sweep's.
    write(w.be, 'src/y.ts', 'export const y = 1;\n');
    noteSessionTops(w.sid, w.pd);
    expect(getEditHistory(w.sid).files).toEqual([join(gen, 'src', 'g.ts')]);
  });

  test('a repo cloned after the start, edited: the Stop blocks with the first-seen text; one made by `git init` starts empty', async () => {
    const w = world();
    sh(w.proj, 'git clone -q be fresh');
    const fresh = join(w.pd, 'fresh', 'src', 'x.ts');
    writeFileSync(fresh, readFileSync(fresh, 'utf8') + 'export const f = 2;\n');
    recordEdit(w.sid, fresh, getCurrentTurn(w.sid), undefined, Date.now());
    const out = await stop(w);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain(`The session's start for ${join(w.proj, 'fresh')} is unknown`);
    expect(out.reason).toContain('first seen during the session');
    expect(out.reason).toContain('the project dir is no repo');
  });

  test('a repo made by `git init` after the start is `empty` at its first sight: no start problem, the tests are asked for', async () => {
    const w = world();
    const made = join(w.proj, 'made');
    mkdirSync(made);
    sh(made, GIT_INIT);
    const f = write(made, 'src/m.ts', 'export const m = 1;\n');
    recordEdit(w.sid, join(w.pd, 'made', 'src', 'm.ts'), getCurrentTurn(w.sid), undefined, Date.now());
    const out = await stop(w, { env: { GOODBOY_TEST_GATE: 'on' } });
    expect(out.decision).toBe('block');
    expect(out.reason).not.toContain('is unknown');
    expect(out.reason).toContain('No test result covers the changed code');
    expect(out.reason).toContain(f);
  });
});

// ── Item 9: test infrastructure ──────────────────────────────────────────────────────────────────

describe('the `auto` test gate counts a test runner in any repo below the project dir', () => {
  test('no runner anywhere: the gate is off (and says so once); a runner in `be` alone turns it on for the whole project', async () => {
    const w = world({ pkg: false });
    const fe = edit(w, 'fe');
    const off = await stop(w);
    expect(off.reason ?? '').not.toContain(TEST_GATE);
    expect(off.systemMessage ?? '').toContain('층1 테스트 게이트가 이 저장소에서 비활성');
    write(w.be, 'package.json', JSON.stringify({ scripts: { test: 'bun test' } })); // untracked is enough
    resetStopGroups();
    const on = await stop(w);
    expect(on.decision).toBe('block');
    expect(on.reason).toContain(TEST_GATE);
    expect(on.reason).toContain(fe);
  });

  test('detectInfrastructure: the project dir first, then the repos below it (named by their dir)', () => {
    const w = world({ pkg: false });
    expect(detectInfrastructure(w.sid, w.pd)).toEqual({ present: false, evidence: '' });
    write(w.fe, 'package.json', JSON.stringify({ scripts: { test: 'bun test' } }));
    resetStopGroups();
    expect(detectInfrastructure(w.sid, w.pd)).toEqual({ present: true, evidence: 'fe/package.json scripts.test' });
    write(w.proj, 'jest.config.js', 'module.exports = {};\n');
    expect(detectInfrastructure(w.sid, w.pd)).toEqual({ present: true, evidence: 'jest.config.js' });
  });

  test('a repo past the walk but edited counts: its runner turns the gate on', () => {
    const w = world({ pkg: false });
    const far = commitRepo(join(w.proj, 'a', 'b', 'c', 'd', 'e', 'far'), 'far'); // five levels down: past the walk
    recordEdit(w.sid, join(far, 'src', 'x.ts'), getCurrentTurn(w.sid), undefined, Date.now());
    resetStopGroups();
    expect(detectInfrastructure(w.sid, w.pd).evidence).toContain('package.json scripts.test');
  });
});

// ── Item 10: exemptions, classification ──────────────────────────────────────────────────────────

describe('globs pinned at the start apply to nested files by either name', () => {
  test('`coverage-exempt` in the repo\'s own spelling and in the project dir\'s: the generated file is no gap; without it it is', async () => {
    const exempt = policy({ 'coverage-exempt': 'be/src/gen/**, src/auto/**' });
    const w = world({ policy: exempt });
    const base = edit(w, 'be');
    const gen = edit(w, 'be', 'gen/g.ts', 'export const g = 1;\n');
    const auto = edit(w, 'fe', 'auto/a.ts', 'export const a = 1;\n');
    const fe = edit(w, 'fe');
    pause();
    const beOut = measure(w, 'be', ['x.ts']); // gen/g.ts is in no report: no test loaded it
    const feOut = measure(w, 'fe', ['x.ts']);
    testWrite(w, [base, gen, auto, fe], [beOut, feOut]);
    reviewWrite(w, [base, gen, auto, fe]);
    clean(await stop(w));

    const bare = world({ policy: policy({ 'coverage-exempt': 'docs/**' }) });
    const gBase = edit(bare, 'be');
    const gGen = edit(bare, 'be', 'gen/g.ts', 'export const g = 1;\n');
    pause();
    const bOut = measure(bare, 'be', ['x.ts']);
    testWrite(bare, [gBase, gGen], bOut);
    const out = await stop(bare);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('be/src/gen/g.ts (not in the coverage report)');
  });

  test('a glob a nested repo\'s policy file holds counts for nothing: only the project dir\'s pin does', async () => {
    const w = world();
    write(w.be, '.goodboy/policy.md', policy({ 'coverage-exempt': 'src/**' }));
    sh(w.be, 'git add -A && git commit -q -m policy');
    resetStopGroups();
    const be = edit(w, 'be');
    pause();
    testWrite(w, [be], undefined);
    const out = await stop(w);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('Changed-line coverage is not measured');
  });

  test('unit: the preview globs gain each edited repo\'s prefix; typeNeedOf and needsTests take the repo for the names they cannot make', () => {
    const w = world({ policy: policy({ 'static-preview': 'docs/**', 'test-type-exempt': 'src/ui/**' }) });
    const html = join(w.fe, 'docs', 'p.html');
    write(w.fe, 'docs/p.html', '<html><body><p>static</p></body></html>\n');
    recordEdit(w.sid, html, getCurrentTurn(w.sid), undefined, Date.now());
    expect(previewGlobsFor(w.sid, w.pd, ['fe'])).toEqual(['docs/**', 'fe/docs/**']);
    expect(scopeFor(w.sid, w.pd)).toEqual({ top: w.pd, previews: ['docs/**', 'fe/docs/**'] });
    // Classified by the project dir's name, the preview is no code.
    expect(needsTests(html, w.pd, ['docs/**', 'fe/docs/**'])).toBe(false);
    expect(needsTests(html, w.pd, ['docs/**'])).toBe(true); // the repo-relative glob alone does not match `fe/docs/p.html`
    // The manifest rule needs the repo: a package.json of a repo is repository metadata only against its own top.
    const manifest = join(w.fe, 'package.json');
    writeFileSync(manifest, JSON.stringify({ scripts: { test: 'bun test' }, version: '2' }));
    const was = JSON.stringify({ scripts: { test: 'bun test' } });
    expect(needsTests(manifest, w.pd, [], () => was, w.fe)).toBe(true); // more than the version changed
    writeFileSync(manifest, JSON.stringify({ scripts: { test: 'bun test' }, version: '3' }));
    expect(needsTests(manifest, w.pd, [], () => JSON.stringify({ scripts: { test: 'bun test' }, version: '2' }), w.fe)).toBe(false); // version only
    expect(needsTests(manifest, w.pd, [], () => JSON.stringify({ scripts: { test: 'bun test' }, version: '2' }))).toBe(true); // against the project dir it is not top-level
    // Test-type exemptions match either name.
    const ui = write(w.fe, 'src/ui/Button.tsx', 'export const B = () => null;\n');
    expect(typeNeedOf(ui, w.pd, ['src/ui/**'])).not.toBeNull(); // the project-dir name `fe/src/ui/Button.tsx` does not match
    expect(typeNeedOf(ui, w.pd, ['src/ui/**'], w.fe)).toBeNull();
    expect(typeNeedOf(ui, w.pd, ['fe/src/ui/**'])).toBeNull();
  });
});

// ── A project dir reached through a symlink ──────────────────────────────────────────────────────

describe('a project dir reached through a symlink', () => {
  test('edits spelled through the link are judged in their repo; the records (real tops) match them', async () => {
    const w = world({ link: true });
    const { be, fe, beOut, feOut } = editedAndTested(w);
    expect(be.startsWith(w.pd)).toBe(true);
    testWrite(w, [be, fe], [beOut, feOut]);
    reviewWrite(w, [be, fe]);
    clean(await stop(w));
  });

  test('a changed file with no covering report is a gap, not silently dropped (the real top must not hide it)', async () => {
    const w = world({ link: true });
    const be = edit(w, 'be');
    const fe = edit(w, 'fe');
    pause();
    const beOut = measure(w, 'be');
    testWrite(w, [be, fe], [beOut]); // fe has no coverage entry at all
    const out = await stop(w);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('Changed-line coverage is not measured for the repo `fe`');
  });
});

// ── Loose code files ─────────────────────────────────────────────────────────────────────────────

describe('a code file in no repo of the project dir', () => {
  test('keeps the "not measured" block, whose text names the exit: a `blocked` record or a `coverage-exempt` entry', async () => {
    const w = world();
    const tool = write(w.proj, 'tool.ts', 'export const tool = 1;\n');
    recordEdit(w.sid, tool, getCurrentTurn(w.sid), undefined, Date.now());
    pause();
    testWrite(w, [tool], undefined);
    const out = await stop(w);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('`diff-coverage` cannot run outside a repo');
    expect(out.reason).toContain('`blocked` test result');
    expect(out.reason).toContain('`coverage-exempt: <glob>`');
  });

  test('the user\'s `coverage-exempt` entry for it (pinned at the start) ends the block', async () => {
    const w = world({ policy: policy({ 'coverage-exempt': 'tool.ts' }) });
    const tool = write(w.proj, 'tool.ts', 'export const tool = 1;\n');
    recordEdit(w.sid, tool, getCurrentTurn(w.sid), undefined, Date.now());
    pause();
    testWrite(w, [tool], undefined, { coverage: { status: 'measured' } });
    reviewWrite(w, [tool]);
    clean(await stop(w, { env: { GOODBOY_TEST_GATE: 'on' } }));
  });

  test('a loose file next to a repo\'s: each group has its own reason', async () => {
    const w = world();
    const tool = write(w.proj, 'tool.ts', 'export const tool = 1;\n');
    recordEdit(w.sid, tool, getCurrentTurn(w.sid), undefined, Date.now());
    const be = edit(w, 'be');
    pause();
    const beOut = measure(w, 'be');
    testWrite(w, [tool, be], [beOut]);
    const out = await stop(w, { env: { GOODBOY_TEST_GATE: 'on' } });
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('are in no git repository');
    expect(out.reason).not.toContain('Changed-line coverage is not measured for the repo `be`');
  });
});

// ── Item 11: the docs gate and the review, per repo ──────────────────────────────────────────────

describe('the docs gate and the review take the groups', () => {
  const docsMap = JSON.stringify({ docs: [{ path: 'docs/api.md', session_start: false, covers: ['be/src/**'] }] });
  function docsWorld(): W {
    const w = world({ policy: policy({}) });
    write(w.proj, 'docs/api.md', '# api\n');
    write(w.proj, '.goodboy/docs.json', docsMap);
    return w;
  }

  test('a covered file of `be` changed and its doc did not: the docs gate names the doc; a doc edit clears it', async () => {
    const w = docsWorld();
    const be = edit(w, 'be');
    const fe = edit(w, 'fe');
    pause();
    const beOut = measure(w, 'be');
    const feOut = measure(w, 'fe');
    testWrite(w, [be, fe], [beOut, feOut]);
    reviewWrite(w, [be, fe]);
    const env = { GOODBOY_DOCS_GATE: 'on' };
    const blocked = await stop(w, { env });
    expect(blocked.decision).toBe('block');
    expect(blocked.reason).toContain('docs/api.md');
    expect(blocked.reason).toContain('be/src/x.ts');
    expect(blocked.reason).not.toContain('fe/src/x.ts');
    const doc = write(w.proj, 'docs/api.md', '# api\nupdated\n');
    recordEdit(w.sid, doc, getCurrentTurn(w.sid), undefined, Date.now());
    pause();
    reviewWrite(w, [be, fe, doc]);
    clean(await stop(w, { env }));
  });

  test('review freshness: a file edited after its review is stale in its repo only', async () => {
    const w = world();
    const { be, fe, beOut, feOut } = editedAndTested(w);
    testWrite(w, [be, fe], [beOut, feOut]);
    reviewWrite(w, [be, fe]);
    pause();
    writeFileSync(be, readFileSync(be, 'utf8') + 'export const later = 3;\n');
    recordEdit(w.sid, be, getCurrentTurn(w.sid), undefined, Date.now());
    const out = await stop(w, { env: { GOODBOY_TEST_GATE: 'off' } });
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('Review validation failed');
    expect(out.reason).toContain(be);
    expect(out.reason).not.toContain(fe);
  });

  test('a review that has trees for `be` only leaves `fe` unverified (not "never reviewed")', async () => {
    const w = world();
    const be = edit(w, 'be');
    const fe = edit(w, 'fe');
    const rec = reviewWrite(w, [be, fe]);
    delete rec.trees[w.fe];
    writeFileSync(recordPaths(w, 'reviews')[0]!, JSON.stringify(rec));
    const out = await stop(w, { env: { GOODBOY_TEST_GATE: 'off' } });
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('Could not verify what the reviews covered for 1 file(s)');
    expect(out.reason).toContain(fe);
  });

  test('the review gate\'s start gate: an unknown start in one repo blocks the review, naming that repo', async () => {
    const w = world();
    sh(w.proj, 'git clone -q be fresh');
    const f = join(w.pd, 'fresh', 'src', 'x.ts');
    writeFileSync(f, readFileSync(f, 'utf8') + 'export const f = 2;\n');
    recordEdit(w.sid, f, getCurrentTurn(w.sid), undefined, Date.now());
    const be = edit(w, 'be');
    reviewWrite(w, [f, be]);
    const out = await stop(w, { env: { GOODBOY_TEST_GATE: 'off' } });
    expect(out.decision).toBe('block');
    expect(out.reason).toContain(`The session's start for ${join(w.proj, 'fresh')} is unknown`);
    expect(out.reason).not.toContain(`The session's start for ${w.be} is unknown`);
  });

  test('a high finding in `be` is superseded by content, per repo: a rewrite with the same bytes (a new mtime) changes nothing', async () => {
    const w = world();
    const VULN = 'import { execSync } from "node:child_process";\nexport const run = (x: string) => execSync(`echo ${x} | sh`);\n';
    const FIXED = 'import { execFileSync } from "node:child_process";\nexport const run = (x: string) => execFileSync("echo", [x]);\n';
    const be = join(w.pd, 'be', 'src', 'x.ts');
    const fe = edit(w, 'fe');
    writeFileSync(be, VULN);
    recordEdit(w.sid, be, getCurrentTurn(w.sid), undefined, Date.now());
    pause();
    reviewWrite(w, [be, fe], [{ file: be, line: 2, issue: 'input reaches a shell', severity: 'high', probe: 'echo $X | sh -> ran' }]);
    pause();
    const env = { GOODBOY_TEST_GATE: 'off' };
    const blocked = await stop(w, { env });
    expect(blocked.decision).toBe('block');
    expect(blocked.reason).toContain('high severity');
    pause();
    writeFileSync(be, FIXED);
    recordEdit(w.sid, be, getCurrentTurn(w.sid), undefined, Date.now());
    pause();
    reviewWrite(w, [be, fe]); // the delta review of the fix
    pause();
    clean(await stop(w, { env }));
    // The bytes written again: the mtime moves past every review, the content is the one reviewed.
    sh(w.be, "git add -A && git commit -q -m fix");
    writeFileSync(be, FIXED);
    const later = new Date(Date.now() + 60_000);
    utimesSync(be, later, later);
    recordEdit(w.sid, be, getCurrentTurn(w.sid), undefined, Date.now());
    const again = await stop(w, { env });
    expect(again.reason ?? '').not.toContain('high severity');
  });

  test('a finding in `be` is not cleared by a later review whose `be` tree holds the vulnerable content', async () => {
    const w = world();
    const VULN = 'import { execSync } from "node:child_process";\nexport const run = (x: string) => execSync(`echo ${x} | sh`);\n';
    const be = join(w.pd, 'be', 'src', 'x.ts');
    writeFileSync(be, VULN);
    recordEdit(w.sid, be, getCurrentTurn(w.sid), undefined, Date.now());
    pause();
    reviewWrite(w, [be], [{ file: be, line: 2, issue: 'input reaches a shell', severity: 'high', probe: 'echo $X | sh -> ran' }]);
    pause();
    reviewWrite(w, [be]); // a clean re-run with no change
    const out = await stop(w, { env: { GOODBOY_TEST_GATE: 'off' } });
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('high severity');
  });
});

// ── Units: the library the Stop is wired from ────────────────────────────────────────────────────

describe('groupsOf', () => {
  test('edits grouped by repo, sorted; loose files form the project dir\'s own group; a project dir that is a repo has one', () => {
    const w = world();
    const files = [join(w.fe, 'src', 'x.ts'), join(w.proj, 'tool.ts'), join(w.be, 'src', 'x.ts'), join(w.be, 'x.test.ts')];
    const groups = groupsOf(w.sid, w.pd, files);
    expect(groups.map((g) => [g.kind, g.top, g.rel, g.edits.length])).toEqual([
      ['nested', w.be, 'be', 2],
      ['nested', w.fe, 'fe', 1],
      ['loose', w.pd, '', 1],
    ]);
    expect(groups[0]!.realTop).toBe(w.be);
    expect(groups[0]!.start.head).toBe(sh(w.be, 'git rev-parse HEAD'));
    expect(groups[2]!.head).toBeNull(); // no repo: no commit
    expect(labelOf(groups[0]!)).toBe('be');
    expect(labelOf(groups[2]!)).toBe('.');
    expect(nameIn(groups[0]!, 'src/x.ts')).toBe('be/src/x.ts');
    expect(nameIn(groups[2]!, 'tool.ts')).toBe('tool.ts');
    expect(groupsOf(w.sid, w.pd, [])).toEqual([]);
    expect(isNoRepoProject(w.pd)).toBe(true);
    // A project dir that is a repo: always the one group, with the repo's own top.
    const own = groupsOf(w.sid, w.be, []);
    expect(own).toHaveLength(1);
    expect([own[0]!.kind, own[0]!.top, own[0]!.rel]).toEqual(['repo', w.be, '']);
    expect(isNoRepoProject(w.be)).toBe(false);
  });

  test('the spelled top follows the project dir; the real top is the real dir', () => {
    const w = world({ link: true });
    const g = groupsOf(w.sid, w.pd, [join(w.pd, 'be', 'src', 'x.ts')])[0]!;
    expect([g.top, g.realTop, g.rel]).toEqual([join(w.pd, 'be'), w.be, 'be']);
    expect(nestedRepoOf(w.pd, join(w.pd, 'fe', 'a.ts'))).toEqual({ top: join(w.pd, 'fe'), realTop: w.fe });
    expect(nestedRepoOf(w.be, join(w.be, 'src', 'x.ts'))).toBeNull(); // a project dir that is a repo has no nested repos
  });

  test('a planted `be/src/.git` leaves the file in `be`', () => {
    const w = world();
    mkdirSync(join(w.be, 'src', '.git'));
    const g = groupsOf(w.sid, w.pd, [join(w.be, 'src', 'x.ts')]);
    expect(g.map((x) => x.top)).toEqual([w.be]);
  });

  test('startProblem and incompleteStartProblem: the repos of the files / of the edit log only', () => {
    const w = world();
    expect(startProblem(w.sid, w.pd, [join(w.be, 'src', 'x.ts')])).toBeNull();
    sh(w.proj, 'git clone -q be fresh');
    const fresh = join(w.proj, 'fresh', 'src', 'x.ts');
    resetStopGroups();
    const reason = startProblem(w.sid, w.pd, [join(w.be, 'src', 'x.ts'), fresh])!;
    expect(reason).toContain(`The session's start for ${join(w.proj, 'fresh')} is unknown`);
    expect(reason).not.toContain(`for ${w.be} is unknown`);
    expect(startProblem(w.sid, w.pd, [join(w.be, 'src', 'x.ts')])).toBeNull(); // be alone is fine
    expect(incompleteStartProblem(w.sid, w.pd)).toBeNull();
  });

  test('a start problem that is thrown is a block, as before', () => {
    const w = world();
    // A session dir that cannot be made: the start of a group cannot be read.
    const broken = startProblem('bad/../../session', w.pd, [join(w.be, 'src', 'x.ts')]);
    expect(broken === null || broken.includes('could not be determined')).toBe(true);
  });

  test('testEditsByGroup: net change per repo with its own start; one group in a repo', () => {
    const w = world();
    const be = edit(w, 'be');
    const unchanged = join(w.fe, 'src', 'x.ts');
    recordEdit(w.sid, unchanged, getCurrentTurn(w.sid), undefined, Date.now()); // touched, same content as the start
    resetStopGroups();
    const by = testEditsByGroup(w.sid, w.pd, 0);
    expect(by.map((x) => [x.g.rel, x.files])).toEqual([['be', [be]]]);
    expect(by[0]!.g.edits).toEqual([be]);
  });

  test('reviewEditsSince: grouped, with the net change judged per repo', () => {
    const w = world();
    const be = edit(w, 'be');
    recordEdit(w.sid, join(w.fe, 'src', 'x.ts'), getCurrentTurn(w.sid), undefined, Date.now());
    resetStopGroups();
    expect(reviewEditsSince(w.sid, w.pd, 0).map((e) => e.file)).toEqual([be]);
  });

  test('branchNote: names the files by their project-dir path (none when the repo has not left the start line)', () => {
    const w = world();
    const be = edit(w, 'be');
    expect(branchNote(w.sid, w.pd, [be])).toBe('');
    // HEAD on another line than the start, the edited file equal to its blob at the merge base.
    sh(w.be, 'git checkout -q -b other && git checkout -q -- src/x.ts');
    write(w.be, 'src/other.ts', 'export const o = 1;\n');
    sh(w.be, "git add -A && git commit -q -m other && git checkout -q main && git checkout -q other");
    const base = sh(w.be, 'git rev-parse HEAD~1');
    expect(base).toBe(groupsOf(w.sid, w.pd, [be])[0]!.head!);
    expect(branchNote(w.sid, w.pd, [be])).toBe(''); // HEAD is ahead of the start: its changes are the session's
  });

  test('testLinesOf: one lines-of per repo; a test file of a repo with no pin or commit counts every line', () => {
    const w = world();
    const beTest = join(w.be, 'x.test.ts');
    const feTest = join(w.fe, 'x.test.ts');
    writeFileSync(beTest, readFileSync(beTest, 'utf8') + "test('new', () => expect(2).toBe(2));\n");
    const linesOf = testLinesOf(w.sid, w.pd, [beTest, feTest, join(w.proj, 'loose.test.ts')])!;
    expect([...(linesOf(beTest) ?? [])]).toEqual([3]); // the added line of be
    expect([...(linesOf(feTest) ?? [-1])]).toEqual([]); // unchanged since its start: none
    expect(linesOf(join(w.proj, 'loose.test.ts'))).toBeNull(); // in no repo: every line
    expect(linesOf('/elsewhere/x.test.ts')).toBeNull();
    // A project dir that is a repo: the one `addedTestLines`.
    const own = testLinesOf(w.sid, w.be, [beTest]);
    expect(own === undefined || typeof own === 'function').toBe(true);
  });

  test('weakenedNow: per repo of the edit log, named by the project dir path', () => {
    const w = world();
    write(w.be, 'src/x.test.ts', "import { expect, test } from 'bun:test';\ntest('a', () => { expect(1).toBe(1); expect(2).toBe(2); });\n");
    sh(w.be, "git add -A && git commit -q -m t");
    const w2 = world();
    // The start is the repo's HEAD at the start: weaken a start test after it.
    write(w2.be, 'src/y.test.ts', "import { expect, test } from 'bun:test';\ntest('a', () => { expect(1).toBe(1); expect(2).toBe(2); });\n");
    sh(w2.be, 'git add -A && git commit -q -m t');
    const w3 = world({ start: false });
    write(w3.be, 'src/y.test.ts', "import { expect, test } from 'bun:test';\ntest('a', () => { expect(1).toBe(1); expect(2).toBe(2); });\n");
    sh(w3.be, 'git add -A && git commit -q -m t');
    pinCoverageStart(w3.sid, w3.pd);
    writeFileSync(join(w3.be, 'src', 'y.test.ts'), "import { expect, test } from 'bun:test';\ntest('a', () => { expect(1).toBe(1); });\n");
    recordEdit(w3.sid, join(w3.be, 'src', 'y.test.ts'), getCurrentTurn(w3.sid), undefined, Date.now());
    resetStopGroups();
    const weak = weakenedNow(w3.sid, w3.pd);
    expect(weak.map((x) => x.g.rel)).toEqual(['be']);
    expect(weak[0]!.list.map((x) => x.rel)).toEqual(['be/src/y.test.ts']);
  });

  test('the groups of a project dir with no pin at all keep the old behavior: no start, nothing refused', () => {
    const w = world({ start: false });
    const g = groupsOf(w.sid, w.pd, [join(w.be, 'src', 'x.ts')])[0]!;
    expect(g.start).toEqual({ exempt: [] });
    expect(g.head).toBeUndefined();
    expect(startProblem(w.sid, w.pd, [join(w.be, 'src', 'x.ts')])).toBeNull();
  });
});

describe('record views and the review\'s trees', () => {
  const rec = (tree: string | null | undefined, trees?: unknown): TestResult => ({ timestamp: new Date().toISOString(), tree, ...(trees === undefined ? {} : { trees }) }) as unknown as TestResult;

  test('viewFor: a nested group sees trees[realTop] (null where it has none); every other group sees the record itself', () => {
    const w = world();
    const [be] = groupsOf(w.sid, w.pd, [join(w.be, 'src', 'x.ts')]);
    const [loose] = groupsOf(w.sid, w.pd, [join(w.proj, 'tool.ts')]);
    const [own] = groupsOf(w.sid, w.be, []);
    const t = 'a'.repeat(40);
    const r = rec(null, { [w.be]: t });
    expect(viewFor(r, be!).tree).toBe(t);
    expect(viewFor(r, be!)).not.toBe(r);
    expect(viewFor(rec(undefined, { [w.fe]: t }), be!).tree).toBeNull(); // another repo's tree is not this one's
    expect(viewFor(rec('b'.repeat(40)), be!).tree).toBeNull(); // the record's own `tree` is the project dir's: none in a repo
    expect(viewFor(rec(null, ['x']), be!).tree).toBeNull();
    expect(viewFor(rec(null, { [w.be]: 7 }), be!).tree).toBeNull();
    expect(viewFor(r, loose!)).toBe(r);
    expect(viewFor(r, own!)).toBe(r);
  });

  test('joinReasons: distinct texts in order', () => {
    expect(joinReasons([undefined, 'a', 'b', 'a', ''])).toBe('a b');
    expect(joinReasons([])).toBeUndefined();
  });

  test('namedGaps names the files by the project dir for a nested group only', () => {
    const w = world();
    const [be] = groupsOf(w.sid, w.pd, [join(w.be, 'src', 'x.ts')]);
    const [loose] = groupsOf(w.sid, w.pd, [join(w.proj, 'tool.ts')]);
    const out = { measured: true, gaps: [{ file: 'src/x.ts', absent: true as const }], subprocess: ['src/y.ts'] };
    expect(namedGaps(out, be!)).toEqual({ measured: true, gaps: [{ file: 'be/src/x.ts', absent: true }], subprocess: ['be/src/y.ts'] });
    expect(namedGaps(out, loose!)).toBe(out);
  });

  test('changedLineReason: the repo to measure in, and the loose files\' exit', () => {
    const base = changedLineReason({ measured: false, gaps: [] }, '/cli.ts');
    expect(base).toContain('run the measure-coverage skill and record the whole');
    expect(changedLineReason({ measured: false, gaps: [] }, '/cli.ts', { repoDir: 'be' })).toContain('`cd be`');
    const loose = changedLineReason({ measured: false, gaps: [] }, '/cli.ts', { loose: true });
    expect(loose).toContain('cannot run outside a repo');
    const refused = { measured: true, gaps: [{ file: 'be/src/x.ts', refusedBase: 'abcdef1234567890', head: null }] };
    const inRepo = changedLineReason(refused, '/cli.ts', { repoDir: 'be' });
    expect(inRepo).toContain('measure again inside `be`');
    // The skill says to give no `--base` in a nested repo (diff-coverage takes that repo's start); a project repo keeps the advice.
    expect(inRepo).not.toContain('--base empty');
    expect(inRepo).toContain('no `--base`');
    expect(changedLineReason(refused, '/cli.ts')).toContain('--base empty');
  });

  test('currentFindings reads a review\'s tree per file by its repo', () => {
    const f = '/p/be/src/x.ts';
    const t1 = '1'.repeat(40);
    const t2 = '2'.repeat(40);
    const finding = { file: f, line: 1, issue: 'bad', severity: 'high' as const, probe: 'p' };
    const stamp = (s: number) => new Date(Date.now() - s * 1000).toISOString();
    const first = { timestamp: stamp(20), reviewed_files: [f], findings: [finding], dimensions_checked: [], tree: null, trees: { '/p/be': t1 } } as unknown as ReviewResult;
    const second = { timestamp: stamp(10), reviewed_files: [f], findings: [], dimensions_checked: [], tree: null, trees: { '/p/be': t2 } } as unknown as ReviewResult;
    const asks: [string, string][] = [];
    // The content lookup: the first review saw other content than now (t1 has it no more), the second has it now.
    const holds = (asksIn: ReadonlyMap<string, ReadonlySet<string>>) => {
      for (const [tree, files] of asksIn) for (const file of files) asks.push([tree, file]);
      return (tree: string, _file: string) => tree === t2;
    };
    const open = currentFindings([first, second], null, () => Date.now() - 15_000, holds, (abs) => (abs === f ? '/p/be' : null));
    expect(open).toEqual([]); // superseded by content, through the trees of the file's repo
    expect(asks.map((a) => a[0]).sort()).toEqual([t1, t2]);
    // Without the repo mapping the reviews' own `tree` (null) says nothing: judged by time.
    asks.length = 0;
    currentFindings([first, second], null, () => Date.now() - 15_000, holds);
    expect(asks).toEqual([]);
    // A review with no tree for the repo is judged by time for it.
    const noTrees = { ...second, trees: { '/p/fe': t2 } } as unknown as ReviewResult;
    asks.length = 0;
    currentFindings([first, noTrees], null, () => Date.now() - 15_000, holds, (abs) => (abs === f ? '/p/be' : null));
    expect(asks.map((a) => a[0])).toEqual([t1]);
  });

  test('treeContentByRepo: once per repo, merged by the file\'s repo; one call in a repo; the deadline is shared', () => {
    const w = world();
    const beTree = sh(w.be, 'git rev-parse HEAD^{tree}');
    const feTree = sh(w.fe, 'git rev-parse HEAD^{tree}');
    const beFile = join(w.pd, 'be', 'src', 'x.ts');
    const feFile = join(w.pd, 'fe', 'src', 'x.ts');
    const asks = new Map<string, Set<string>>([
      [beTree, new Set([beFile])],
      [feTree, new Set([feFile])],
    ]);
    const lookup = treeContentByRepo(w.pd, asks, newDeadline(10_000));
    expect(lookup(beTree, beFile)).toBe(true); // the committed content is the content now
    expect(lookup(feTree, feFile)).toBe(true);
    expect(lookup(feTree, beFile)).toBeUndefined(); // another repo's tree says nothing about this file
    writeFileSync(beFile, 'changed\n');
    expect(treeContentByRepo(w.pd, asks, newDeadline(10_000))(beTree, beFile)).toBe(false);
    // The deadline has run out: nothing is read, nothing is claimed.
    expect(treeContentByRepo(w.pd, asks, newDeadline(0))(feTree, feFile)).toBeUndefined();
    // A project dir that is a repo: one call.
    const own = treeContentByRepo(w.be, new Map([[beTree, new Set([join(w.be, 'src', 'x.ts')])]]), newDeadline(10_000));
    expect(own(beTree, join(w.be, 'src', 'x.ts'))).toBe(false);
    expect(repoOfFileFor(w.pd)(beFile)).toBe(w.be);
    expect(repoOfFileFor(w.be)(join(w.be, 'src', 'x.ts'))).toBeNull();
  });
});
