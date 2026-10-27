// v0.36.7 (#33, plan §15.23): the session's start is pinned per repo top. Before it, one pin held the
// first checkout's HEAD, and every linked worktree of the repository (its object store has that
// commit) was judged against it: its own tests looked deleted or went unseen, changed lines were
// refused or counted that the session never wrote, a copy of the start content passed with no test and
// no review, and a resume from the worktree overwrote the pin.
//   - the research's repro modes (in / out / nestpin / nest, against the control that starts in the
//     worktree) through the real SessionStart, PostToolUse and Stop hooks;
//   - rules 1-3: the frozen tips, eager and first-sight pins, the boundary rule, dirt at first sight;
//   - rule 4: an unknown start never grants an exemption or an acceptance;
//   - rule 5: criteria baselines and seen lists per top;
//   - rules 7-10: atomic pins, a recreated worktree, per-top cursors, legacy sessions;
//   - rule 11: a nested worktree whose start differs from the first checkout's blocks;
//   - round 9: git names a checkout whose .git cannot be read, the empty start needs a complete frozen tip set
//     (or an object store with no commit), first-sight dirt comes from three sets, an incomplete first sight
//     blocks every Stop, the start block's own text, frozen grants, the first top's identity, a missing pin,
//     one deadline, one worktree list and the PostToolUse git cost;
//   - round 10: an identity change at a pinned path keeps the original start (continuity) or has none, no git at a
//     pinned path is unknown, a pass-through hook pins no other repository, the active Stop with an unresolved
//     baseline ends the turn with a warning and accepts nothing, a failing incomplete-start gate blocks, and the
//     "not a git repository" probe reads English. (Rule 8 and round 9's fix 7 were replaced by the continuity rule.)
// Repos are temporary and git (worktrees included) runs for real; the hooks are spawned. Subprocess
// tests have generous runner timeouts.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { ensureSessionDir } from '../lib/file-tracker';
import { workTreeState } from '../lib/push-test';
import { restoreGateState, snapshotGateState } from '../lib/state-guard';

// New modules are imported inside the tests that need them, so a red run on the older tree fails those
// tests one by one, not the file.
const pinsModule = () => import('../lib/start-pins');
const coverageModule = () => import('../lib/changed-coverage');
const criteriaModule = () => import('../lib/session-criteria');

const ROOT = resolve(import.meta.dir, '..');
setDefaultTimeout(90_000);

const dirs: string[] = [];
const restore: (() => void)[] = [];
afterEach(async () => {
  while (restore.length) restore.pop()!();
  try {
    (await import('../lib/git-binary')).resetGitBinary();
    (await import('../lib/start-pins')).startPinDeadline(Number.POSITIVE_INFINITY);
  } catch {
    // an older tree has neither
  }
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function tmp(prefix = 'goodboy-i33-'): string {
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
const T = 'import { expect, test } from "bun:test";\n';

// ── The world: repo A with commits Y (B's base) and X (A's HEAD at the session's start) ──────

const CALC_Y = 'export const add = (a: number, b: number) => a + b;\nexport const old = (a: number) => a * 2;\n';
const CALC_X = 'export const add = (a: number, b: number) => a + b;\nexport const sub = (a: number, b: number) => a - b;\n';

interface World {
  /** The main checkout; its HEAD is X. */
  A: string;
  X: string;
  Y: string;
  sid: string;
  /** What the hooks take as the project dir. */
  project: string;
  home: string;
  sdir: string;
}

let counter = 0;
function world(before?: (A: string) => void): World {
  const A = tmp();
  const home = tmp('goodboy-i33-home-');
  sh(A, GIT_INIT);
  write(A, 'package.json', '{"name":"p","version":"1.0.0","scripts":{"test":"bun test"}}');
  write(A, '.gitignore', '.claude/\ncoverage/\n');
  write(A, 'src/calc.ts', CALC_Y);
  write(A, 'tests/calc.test.ts', `${T}import { add } from "../src/calc";\ntest("add", () => { expect(add(1, 2)).toBe(3); expect(add(0, 0)).toBe(0); });\n`);
  write(A, 'tests/legacy.test.ts', `${T}import { old } from "../src/calc";\ntest("old", () => { expect(old(2)).toBe(4); });\n`);
  sh(A, "git add -A && git commit -q -m 'ABC-1 Y'");
  const Y = sh(A, 'git rev-parse HEAD');
  write(A, 'src/calc.ts', CALC_X);
  sh(A, 'git rm -q tests/legacy.test.ts');
  for (const n of [1, 2, 3]) write(A, `tests/extra${n}.test.ts`, `${T}import { add } from "../src/calc";\ntest("e${n}", () => { expect(add(${n}, 0)).toBe(${n}); });\n`);
  sh(A, "git add -A && git commit -q -m 'ABC-1 X'");
  const X = sh(A, 'git rev-parse HEAD');
  before?.(A);
  const sid = `i33${Math.random().toString(36).slice(2, 8)}${counter++}`;
  const sdir = join(tmpdir(), `goodboy-session-${sid}`);
  dirs.push(sdir);
  return { A, X, Y, sid, project: A, home, sdir };
}

const baseEnv = (w: World, env: Record<string, string> = {}): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  HOME: w.home,
  CLAUDE_PLUGIN_ROOT: ROOT,
  CLAUDE_PROJECT_DIR: w.project,
  GOODBOY_DISABLE_DELEGATION: '1',
  GOODBOY_CLAIM_FLUSH_WAIT_MS: '0',
  GOODBOY_POLICY_GATE: 'off',
  GOODBOY_DOCS_GATE: 'off',
  // The suite switches the I1/I5 rules off (tests/setup.ts); each test turns on what it is about.
  GOODBOY_DIFF_COVERAGE: 'off',
  GOODBOY_EXISTING_TESTS: 'off',
  ...env,
});

async function hook(w: World, cwd: string, script: string, payload: Record<string, unknown>, env: Record<string, string> = {}): Promise<string> {
  const p = Bun.spawn(['bun', join(ROOT, 'hooks', script)], {
    cwd,
    env: baseEnv(w, env),
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: w.sid, cwd, ...payload })),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out;
}
const startSession = (w: World, cwd: string = w.A, source = 'startup') => hook(w, cwd, 'session-start.ts', { hook_event_name: 'SessionStart', source });
const post = (w: World, cwd: string, file: string) => hook(w, cwd, 'post-tool-use.ts', { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: file } });
interface Stopped {
  decision?: string;
  reason?: string;
  systemMessage?: string;
}
async function stop(w: World, cwd: string, env: Record<string, string> = {}): Promise<Stopped> {
  const text = (await hook(w, cwd, 'stop.ts', { hook_event_name: 'Stop', stop_hook_active: false }, env)) || '{}';
  return JSON.parse(text) as Stopped;
}
const worktree = (w: World, dir: string, rev: string) => sh(w.A, `git worktree add -q --detach ${JSON.stringify(dir)} ${rev}`);

// ── Records the gates accept ─────────────────────────────────────────────────────────────────

const DIMS = ['hallucination', 'performance', 'refactoring-quality', 'security-secrets', 'security-authz', 'security-injection', 'error-path', 'test-quality'];
function reviewRecord(top: string, files: string[]): void {
  write(top, '.claude/reviews/r.json', JSON.stringify({ timestamp: new Date(Date.now() + 1000).toISOString(), tree: workTreeState(top).tree, reviewed_files: files, category: 'fix-bug', findings: [], unknown_assumptions_checked: [], verdict: 'pass', dimensions_checked: DIMS }));
}
const ACC = [{ id: 'AC-1', description: 'add', test: 'tests/calc-new.test.ts', red: { command: 'bun test', output: '1 fail', exit_code: 1 }, green: { command: 'bun test', output: '1 pass', exit_code: 0 } }];
function testRecord(top: string, tested: string[], extra: Record<string, unknown> = {}, testFiles = ['tests/calc-new.test.ts']): void {
  write(top, '.claude/tests/result.json', JSON.stringify({ timestamp: new Date(Date.now() + 1000).toISOString(), ...workTreeState(top), tested_files: tested, category: 'fix-bug', test_files: testFiles.map((t) => join(top, t)), environment: { mode: 'local' }, suites: [{ name: 'unit', command: 'bun test', passed: 3, failed: 0, output: '3 pass', type: 'unit', duration_ms: 5 }], acceptance: ACC, verdict: 'pass', ...extra }));
}
const newTest = (top: string) => write(top, 'tests/calc-new.test.ts', `${T}import { add } from "../src/calc";\ntest("neg", () => { expect(add(-1, 1)).toBe(0); });\n`);

// ── The research's repro modes ───────────────────────────────────────────────────────────────

type Mode = 'in' | 'out' | 'nestpin' | 'control';
interface Setup {
  w: World;
  B: string;
}
async function setup(mode: Mode): Promise<Setup> {
  const w = world();
  let B: string;
  if (mode === 'control') {
    B = join(tmp(), 'B');
    worktree(w, B, w.Y);
    w.project = B;
    await startSession(w, B);
  } else if (mode === 'nestpin') {
    B = join(w.A, 'wt', 'b');
    worktree(w, B, w.Y);
    await startSession(w, w.A);
  } else {
    await startSession(w, w.A);
    B = mode === 'in' ? join(w.A, '.claude', 'worktrees', 'b') : join(tmp(), 'B');
    worktree(w, B, w.Y);
  }
  return { w, B };
}
const MODES: Mode[] = ['in', 'out', 'nestpin', 'control'];

describe('the research repro: a linked worktree is judged against its own start (control: the session starts in it)', () => {
  test.each(MODES)('%s / I5: its own deleted and weakened tests are listed, A-only tests are not', async (mode) => {
    const { w, B } = await setup(mode);
    const calc = write(B, 'src/calc.ts', CALC_Y.replace('a + b;', 'a + b; // typed'));
    const nt = newTest(B);
    unlinkSync(join(B, 'tests/legacy.test.ts')); // a test only B has: A deleted it before the session started
    const ct = write(B, 'tests/calc.test.ts', `${T}import { add } from "../src/calc";\ntest("add", () => { expect(add(1, 2)).toBe(3); });\n`);
    for (const f of [calc, nt, ct]) await post(w, B, f);
    reviewRecord(B, [calc, nt, ct, join(B, 'tests/legacy.test.ts')]);
    const out = await stop(w, B, { GOODBOY_TEST_GATE: 'off', GOODBOY_EXISTING_TESTS: 'on' });
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('tests/legacy.test.ts (deleted)'); // the old pin never saw it: A had deleted it already
    expect(out.reason).toContain('tests/calc.test.ts');
    expect(out.reason).not.toContain('extra'); // tests only A has are not B's to lose
  });

  test.each(MODES)('%s / net: B rewritten to the content of the start of A needs a test and a review', async (mode) => {
    const { w, B } = await setup(mode);
    const calc = write(B, 'src/calc.ts', CALC_X); // A's HEAD content: a real change in B (drops old(), adds sub())
    await post(w, B, calc);
    const out = await stop(w, B, { GOODBOY_TEST_GATE: 'on' });
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('No test result covers the changed code');
    expect(out.reason).toContain('src/calc.ts');
  });

  test.each(MODES)('%s / changed lines: a record measured against HEAD (B\'s start) counts the session\'s line only', async (mode) => {
    const { w, B } = await setup(mode);
    const calc = write(B, 'src/calc.ts', CALC_Y.replace('a + b;', 'a + b; // typed'));
    const nt = newTest(B);
    for (const f of [calc, nt]) await post(w, B, f);
    write(B, 'coverage/lcov.info', 'TN:\nSF:src/calc.ts\nDA:1,1\nDA:2,0\nend_of_record\n'); // the session's line ran; old() is Y's, untouched
    const cli = Bun.spawnSync(['bun', join(ROOT, 'lib', 'cli.ts'), 'diff-coverage', 'coverage/lcov.info'], { cwd: B, stdout: 'pipe', stderr: 'pipe', env: baseEnv(w) });
    const changed = JSON.parse(cli.stdout.toString()) as Record<string, unknown>;
    testRecord(B, [calc], { coverage: { status: 'measured', changed } }, ['tests/calc-new.test.ts', 'tests/calc.test.ts', 'tests/legacy.test.ts']);
    const out = await stop(w, B, { GOODBOY_TEST_GATE: 'on', GOODBOY_EXISTING_TESTS: 'on', GOODBOY_DIFF_COVERAGE: 'on' });
    // Past the test gate: the review is what is missing now. Before, in / out / nestpin refused HEAD as a base
    // (it is not A's start) and counted old()'s line, which the session never wrote.
    expect(out.reason ?? '').not.toContain('Changed lines that no test ran');
    expect(out.reason ?? '').not.toContain('measured only against');
    expect(out.reason ?? '').toContain('Review is required');
  });

  test('nest: a worktree made mid-session inside A, outside .claude/worktrees, stays deferred but its Stop blocks instead of using A\'s start', async () => {
    const w = world();
    await startSession(w, w.A);
    const B = join(w.A, 'wt', 'b');
    worktree(w, B, w.Y);
    const calc = write(B, 'src/calc.ts', CALC_X);
    await post(w, w.A, calc); // the shell is in A: the worktree is not resolved as a project
    for (const gate of ['on', 'off']) {
      const out = await stop(w, B, { GOODBOY_TEST_GATE: gate });
      expect(out.decision).toBe('block');
      expect(out.reason).toContain('linked worktree nested in');
      expect(out.reason).toContain(`start is ${w.Y.slice(0, 12)}`);
    }
  });

  test('nest: a nested worktree at the same commit as A\'s start is no ambiguity', async () => {
    const w = world();
    await startSession(w, w.A);
    const B = join(w.A, 'wt', 'b');
    worktree(w, B, w.X);
    const calc = write(B, 'src/calc.ts', CALC_X + '// edit\n');
    await post(w, w.A, calc);
    const out = await stop(w, w.A, { GOODBOY_TEST_GATE: 'on' });
    expect(out.reason ?? '').not.toContain('linked worktree nested in');
  });
});

describe('rule 1: SessionStart freezes the tips and pins the worktrees that exist', () => {
  test('the snapshot has every ref tip and every worktree HEAD (a detached one too), and each worktree is pinned by its top', async () => {
    const w = world((A) => {
      sh(A, 'git branch other HEAD~1 && git tag -a v1 -m v1 HEAD~1');
    });
    const B = join(tmp(), 'B');
    worktree(w, B, w.Y); // detached
    write(B, 'z.txt', 'z');
    sh(B, "git add -A && git commit -q -m 'ABC-1 z'"); // the detached HEAD moves to a commit no ref names
    const zid = sh(B, 'git rev-parse HEAD');
    await startSession(w);
    const tips = JSON.parse(readFileSync(join(w.sdir, 'start-tips.json'), 'utf8')) as { tips: string[]; worktrees: { top: string }[]; common: string };
    expect(tips.tips).toContain(w.X);
    expect(tips.tips).toContain(w.Y); // branch `other` and the tag's commit
    expect(tips.tips).toContain(zid); // the detached worktree's HEAD
    expect(tips.worktrees.map((t) => t.top).sort()).toEqual([w.A, B].sort());
    expect(tips.common).toBe(realpathSync(join(w.A, '.git')));
    const { topStart } = await pinsModule();
    expect(topStart(w.sid, B)).toEqual({ kind: 'commit', head: zid });
    expect(topStart(w.sid, w.A)).toEqual({ kind: 'commit', head: w.X });
    expect(readdirSync(w.sdir).filter((f) => f.startsWith('start-pin-')).length).toBe(2);
  });

  test('a resume neither overwrites the pin nor refreshes the snapshot, from A or from a worktree', async () => {
    const w = world();
    const B = join(tmp(), 'B');
    worktree(w, B, w.Y);
    await startSession(w);
    const files = () => ['coverage-pin.json', 'start-tips.json', ...readdirSync(w.sdir).filter((f) => f.startsWith('start-pin-'))].map((f) => readFileSync(join(w.sdir, f), 'utf8'));
    const before = files();
    sh(w.A, "git commit -q --allow-empty -m 'ABC-1 later' && git branch moved"); // refs move after the start
    w.project = B;
    await startSession(w, B, 'resume');
    expect(files()).toEqual(before); // checked before the next resume: one from A would restore a pin that B overwrote
    w.project = w.A;
    await startSession(w, w.A, 'resume');
    expect(files()).toEqual(before);
    const pin = JSON.parse(before[0]!) as { top: string; head: string };
    expect(pin).toMatchObject({ top: w.A, head: w.X });
  });

  test('A -> B -> A: each checkout keeps its own start through the Stop', async () => {
    const w = world();
    await startSession(w);
    const B = join(tmp(), 'B');
    worktree(w, B, w.Y);
    const { sessionCoverageStart, repoTop } = await coverageModule();
    expect(sessionCoverageStart(w.sid, B, repoTop(B)).head).toBe(w.Y);
    expect(sessionCoverageStart(w.sid, w.A, repoTop(w.A)).head).toBe(w.X);
    // A resume from B, then back in A.
    w.project = B;
    await startSession(w, B, 'resume');
    expect(sessionCoverageStart(w.sid, B, repoTop(B)).head).toBe(w.Y);
    expect(sessionCoverageStart(w.sid, w.A, repoTop(w.A)).head).toBe(w.X);
  });
});

describe('rule 2: a checkout first seen mid-session', () => {
  test('HEAD reachable from the frozen tips is the start, even after the refs moved', async () => {
    const w = world();
    await startSession(w);
    // X stops being reachable from any current ref; the frozen tips still have it.
    sh(w.A, `git checkout -q --detach ${w.Y} && git branch -f main ${w.Y}`);
    const B = join(tmp(), 'B');
    worktree(w, B, w.X);
    const { topStart } = await pinsModule();
    expect(topStart(w.sid, B)).toEqual({ kind: 'commit', head: w.X });
  });

  test('commits the session made: the start is the one boundary to the tips, never the new HEAD', async () => {
    const w = world();
    await startSession(w);
    write(w.A, 'src/calc.ts', CALC_X + 'export const mul = (a: number, b: number) => a * b;\n');
    sh(w.A, "git commit -qam 'ABC-1 mul'"); // the session's own commit in A
    const c1 = sh(w.A, 'git rev-parse HEAD');
    const B = join(tmp(), 'B');
    worktree(w, B, c1);
    const { topStart } = await pinsModule();
    expect(topStart(w.sid, B)).toEqual({ kind: 'commit', head: w.X });
    // And a commit made in B itself before any hook saw it.
    const B2 = join(tmp(), 'B2');
    worktree(w, B2, w.Y);
    write(B2, 'src/extra.ts', 'export const e = 1;\n');
    sh(B2, "git add -A && git commit -q -m 'ABC-1 extra'");
    expect(topStart(w.sid, B2)).toEqual({ kind: 'commit', head: w.Y });
  });

  test('several boundaries, an orphan, another repository with history: unknown; an unborn repository: the empty tree', async () => {
    const w = world((A) => {
      sh(A, 'git checkout -q -b l1 HEAD~1 && git commit -q --allow-empty -m l1 && git checkout -q -b l2 HEAD~1 && git commit -q --allow-empty -m l2 && git checkout -q main');
    });
    await startSession(w);
    const { topStart } = await pinsModule();
    const merged = join(tmp(), 'M');
    sh(w.A, `git worktree add -q -b merged ${JSON.stringify(merged)} l1 && git -C ${JSON.stringify(merged)} merge -q --no-edit l2`);
    const m = topStart(w.sid, merged);
    expect(m.kind).toBe('unknown');
    expect(m.kind === 'unknown' && m.reason).toContain('merges 2 lines');
    const orphan = join(tmp(), 'O');
    worktree(w, orphan, w.Y);
    sh(orphan, "git checkout -q --orphan o && git rm -rfq . && git commit -q --allow-empty -m root");
    const o = topStart(w.sid, orphan);
    expect(o.kind).toBe('unknown');
    expect(o.kind === 'unknown' && o.reason).toContain('unrelated');
    const other = tmp();
    sh(other, `${GIT_INIT} && git commit -q --allow-empty -m other`);
    const r = topStart(w.sid, other);
    expect(r.kind).toBe('unknown');
    expect(r.kind === 'unknown' && r.reason).toContain('another repository');
    const fresh = tmp();
    sh(fresh, GIT_INIT);
    expect(topStart(w.sid, fresh)).toEqual({ kind: 'empty' });
    // An unknown answer is the pinned answer: the second ask does not change it.
    expect(topStart(w.sid, merged)).toEqual(m);
  });

  test('no snapshot (a session from before the snapshot): an unborn repo is empty, a repo with history is unknown', async () => {
    const w = world();
    const { topStart } = await pinsModule();
    const fresh = tmp();
    sh(fresh, GIT_INIT);
    expect(topStart(w.sid, fresh)).toEqual({ kind: 'empty' });
    const s = topStart(w.sid, w.A);
    expect(s.kind).toBe('unknown');
    expect(s.kind === 'unknown' && s.reason).toContain('no start snapshot');
  });
});

describe('rule 3: what is already in a checkout when a hook first sees it counts as the session\'s', () => {
  test('a dirty edit, an untracked test, a deleted test and a commit made before the first hook: all are obligations, not hidden', async () => {
    const w = world();
    await startSession(w);
    const B = join(tmp(), 'B');
    worktree(w, B, w.Y);
    write(B, 'src/committed.ts', 'export const c = 1;\n');
    sh(B, "git add -A && git commit -q -m 'ABC-1 committed'");
    write(B, 'src/calc.ts', CALC_Y.replace('a + b;', 'a + b; // dirty')); // a Bash edit: no edit-log entry
    write(B, 'src/untracked.ts', 'export const u = 1;\n');
    unlinkSync(join(B, 'tests/legacy.test.ts'));
    w.project = B;
    const out = await stop(w, B, { GOODBOY_TEST_GATE: 'on' });
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('No test result covers the changed code');
    for (const f of ['src/committed.ts', 'src/calc.ts', 'src/untracked.ts']) expect(out.reason).toContain(f);
    const edits = readFileSync(join(w.sdir, 'edits.jsonl'), 'utf8');
    expect(edits).toContain(join(B, 'src/committed.ts'));
    expect(edits).toContain(join(B, 'src/calc.ts'));
    // The deleted test is read from git against B's own start: it is B's, and is judged as weakened.
    const review = await (async () => {
      reviewRecord(B, [join(B, 'src/calc.ts'), join(B, 'src/committed.ts'), join(B, 'src/untracked.ts'), join(B, 'tests/legacy.test.ts')]);
      return stop(w, B, { GOODBOY_TEST_GATE: 'off', GOODBOY_EXISTING_TESTS: 'on' });
    })();
    expect(review.reason).toContain('tests/legacy.test.ts (deleted)');
  });

  test('a hook that sees the checkout first (PostToolUse) pins it once; the Stop reads the same pin', async () => {
    const w = world();
    await startSession(w);
    const B = join(tmp(), 'B');
    worktree(w, B, w.Y);
    write(B, 'src/calc.ts', CALC_Y.replace('a + b;', 'a + b; // dirty'));
    await post(w, B, write(B, 'src/other.ts', 'export const o = 1;\n'));
    const pinned = readdirSync(w.sdir).filter((f) => f.startsWith('start-pin-'));
    expect(pinned.length).toBe(2); // A's (eager) and B's
    const bytes = pinned.map((f) => readFileSync(join(w.sdir, f), 'utf8'));
    w.project = B;
    await stop(w, B, { GOODBOY_TEST_GATE: 'on' });
    expect(readdirSync(w.sdir).filter((f) => f.startsWith('start-pin-')).map((f) => readFileSync(join(w.sdir, f), 'utf8'))).toEqual(bytes);
  });
});

describe('rule 4: an unknown start grants nothing and borrows nothing', () => {
  async function unknownWorld() {
    const w = world((A) => {
      write(A, '.goodboy/policy.md', ['## P1 Exempt', '- decide: human', '- source: user', '- date: 2026-10-27', '- checked: 2026-10-27', '- coverage-exempt: src/**', ''].join('\n'));
    });
    await startSession(w);
    const B = join(tmp(), 'B');
    worktree(w, B, w.Y);
    sh(B, "git checkout -q --orphan o && git rm -rfq . && git commit -q --allow-empty -m root"); // unrelated history: unknown
    write(B, 'src/calc.ts', CALC_Y);
    write(B, 'package.json', '{"name":"p","scripts":{"test":"bun test"}}');
    write(B, '.gitignore', '.claude/\n');
    return { w, B };
  }

  test('the exemptions are the first checkout\'s alone, and the start is unknown, not A\'s and not "none"', async () => {
    const { w, B } = await unknownWorld();
    const { sessionCoverageStart, repoTop } = await coverageModule();
    expect(sessionCoverageStart(w.sid, w.A, repoTop(w.A)).exempt).toEqual(['src/**']);
    write(B, '.goodboy/policy.md', ['## P1 Exempt', '- decide: human', '- source: user', '- date: 2026-10-27', '- checked: 2026-10-27', '- coverage-exempt: src/**', ''].join('\n'));
    const s = sessionCoverageStart(w.sid, B, repoTop(B));
    expect(s.exempt).toEqual([]);
    expect(s.head).toBeUndefined();
    expect(s.unknown).toContain('unrelated');
  });

  test('valid test and review records are no acceptance: both gates block with the reason', async () => {
    const { w, B } = await unknownWorld();
    w.project = B;
    const calc = write(B, 'src/calc.ts', CALC_Y.replace('a + b;', 'a + b; // typed'));
    const nt = newTest(B);
    for (const f of [calc, nt]) await post(w, B, f);
    testRecord(B, [calc]);
    reviewRecord(B, [calc, nt]);
    const tests = await stop(w, B, { GOODBOY_TEST_GATE: 'on', GOODBOY_DIFF_COVERAGE: 'off', GOODBOY_EXISTING_TESTS: 'off' });
    expect(tests.decision).toBe('block');
    expect(tests.reason).toContain("The session's start for");
    expect(tests.reason).toContain('unrelated');
    const review = await stop(w, B, { GOODBOY_TEST_GATE: 'off', GOODBOY_EXISTING_TESTS: 'off' });
    expect(review.decision).toBe('block');
    expect(review.reason).toContain("The session's start for");
    // Nothing was accepted: no cursor was written.
    expect(readdirSync(w.sdir).filter((f) => f.startsWith('.goodboy-last-'))).toEqual([]);
  });
});

describe('rule 4: a pin with no HEAD is unknown, never "no base check"', () => {
  test('git could not say HEAD at the start: the first checkout\'s own start is unknown and the gates block', async () => {
    const w = world();
    ensureSessionDir(w.sid);
    writeFileSync(join(w.sdir, 'coverage-pin.json'), JSON.stringify({ top: w.A, exemptions: [] })); // v0.36.6 wrote this when git failed
    const { sessionCoverageStart, repoTop } = await coverageModule();
    const s = sessionCoverageStart(w.sid, w.A, repoTop(w.A));
    expect(s.head).toBeUndefined();
    expect(s.unknown).toContain('could not resolve HEAD');
    const calc = write(w.A, 'src/calc.ts', CALC_X + '// edit\n');
    await post(w, w.A, calc);
    const out = await stop(w, w.A, { GOODBOY_TEST_GATE: 'on' });
    expect(out.decision).toBe('block');
    expect(out.reason).toContain("The session's start for");
    expect(out.reason).toContain('could not resolve HEAD');
    // Valid records are no acceptance, on the full Stop and on the accept a Stop makes when it answers its own
    // block (stop_hook_active): with the start known the same records pass (the control below).
    const nt = newTest(w.A);
    await post(w, w.A, nt);
    testRecord(w.A, [calc]);
    reviewRecord(w.A, [calc, nt]);
    const env = { GOODBOY_DIFF_COVERAGE: 'off', GOODBOY_EXISTING_TESTS: 'off' };
    expect((await stop(w, w.A, { ...env, GOODBOY_TEST_GATE: 'on' })).reason).toContain("The session's start for");
    expect((await stop(w, w.A, { ...env, GOODBOY_TEST_GATE: 'off' })).reason).toContain("The session's start for");
    for (const gate of ['on', 'off']) await hook(w, w.A, 'stop.ts', { hook_event_name: 'Stop', stop_hook_active: true }, { ...env, GOODBOY_TEST_GATE: gate });
    expect(readdirSync(w.sdir).filter((f) => f.startsWith('.goodboy-last-'))).toEqual([]);
  });

  test('control: the same records pass once the pin has its HEAD', async () => {
    const w = world();
    ensureSessionDir(w.sid);
    writeFileSync(join(w.sdir, 'coverage-pin.json'), JSON.stringify({ top: w.A, head: w.X, exemptions: [] }));
    const calc = write(w.A, 'src/calc.ts', CALC_X + '// edit\n');
    const nt = newTest(w.A);
    await post(w, w.A, calc);
    await post(w, w.A, nt);
    testRecord(w.A, [calc]);
    reviewRecord(w.A, [calc, nt]);
    const out = await stop(w, w.A, { GOODBOY_DIFF_COVERAGE: 'off', GOODBOY_EXISTING_TESTS: 'off', GOODBOY_TEST_GATE: 'on' });
    expect(out.decision).toBeUndefined();
    expect(readdirSync(w.sdir).filter((f) => f.startsWith('.goodboy-last-')).length).toBe(2);
  });
});

describe('rule 5: criteria are per checkout', () => {
  const reqs = (rows: [number, string, string][]) => ['# Requirements', '', '## Requirements', '', '| Rank | Requirement | Status |', '|---|---|---|', ...rows.map(([n, t, s]) => `| ${n} | ${t} | ${s} |`), ''].join('\n');
  const policy = (test?: string) => ['## P1 Ids', '- decide: ai', '- source: review', '- date: 2026-10-27', '- checked: 2026-10-27', ...(test ? [`- test: ${test}`] : []), ''].join('\n');
  const docs = (top: string, rows: [number, string, string][], pol?: string) => {
    write(top, 'docs/CYCLE.md', '# Cycle\n\n- **Current version**: 1.0\n- **Current stage**: 5\n');
    write(top, 'docs/versions/1.0/REQUIREMENTS.md', reqs(rows));
    write(top, '.goodboy/policy.md', policy(pol));
  };

  test('a worktree that existed at the start has its own baseline: its policy criteria are kept, A\'s rows are not its', async () => {
    const w = world((A) => docs(A, [[1, 'login', 'in progress']]));
    const B = join(tmp(), 'B');
    worktree(w, B, w.Y);
    docs(B, [[7, 'export', 'in progress']]); // B's own documents, not committed
    await startSession(w);
    const { sessionCriteria } = await criteriaModule();
    docs(B, [[7, 'export', 'in progress']], 'ids are UUIDs'); // the session adds a policy test line in B
    const inB = sessionCriteria(w.sid, B);
    expect(inB.problem).toBeUndefined();
    expect(inB.criteria.map((c) => c.id).sort()).toEqual(['POL-P1', 'REQ-7']);
    const inA = sessionCriteria(w.sid, w.A);
    expect(inA.criteria.map((c) => c.id)).toEqual(['REQ-1']); // B's did not leak into A's seen list, nor A's into B's
    expect(sessionCriteria(w.sid, B).criteria.map((c) => c.id).sort()).toEqual(['POL-P1', 'REQ-7']);
    const seen = readdirSync(w.sdir).filter((f) => /^criteria-seen/.test(f));
    expect(seen.length).toBe(2);
  });

  test('a worktree made later takes its baseline from its start commit, not from documents it edited before the first hook', async () => {
    const w = world((A) => docs(A, [[1, 'login', 'in progress'], [2, 'export', 'in progress']]));
    sh(w.A, "git add -A && git commit -q -m 'ABC-1 docs'");
    const docsCommit = sh(w.A, 'git rev-parse HEAD');
    await startSession(w);
    const B = join(tmp(), 'B');
    worktree(w, B, docsCommit);
    docs(B, [[1, 'login', 'implemented'], [2, 'export', 'implemented']]); // edited before any hook saw B: the baseline is the commit's
    const { sessionCriteria } = await criteriaModule();
    const c = sessionCriteria(w.sid, B);
    expect(c.problem).toBeUndefined();
    expect(c.criteria.map((x) => x.id).sort()).toEqual(['REQ-1', 'REQ-2']);
  });

  test('an unknown baseline blocks: the policy criteria are not silently dropped', async () => {
    const w = world((A) => docs(A, [[1, 'login', 'in progress']]));
    await startSession(w);
    const B = join(tmp(), 'B');
    worktree(w, B, w.Y);
    sh(B, "git checkout -q --orphan o && git rm -rfq . && git commit -q --allow-empty -m root");
    docs(B, [[1, 'login', 'in progress']], 'ids are UUIDs');
    const { sessionCriteria } = await criteriaModule();
    const c = sessionCriteria(w.sid, B);
    expect(c.problem).toContain('cannot be established');
    expect(c.problem).toContain('unrelated');
  });

  test('the starting stage is per checkout', async () => {
    const w = world((A) => docs(A, [[1, 'login', 'in progress']]));
    const B = join(tmp(), 'B');
    worktree(w, B, w.Y);
    docs(B, [[1, 'login', 'in progress']]);
    write(B, 'docs/CYCLE.md', '# Cycle\n\n- **Current version**: 1.0\n- **Current stage**: 6\n'); // B started at verification
    await startSession(w);
    const { sessionCriteria, startedBeforeVerification } = await criteriaModule();
    expect(startedBeforeVerification(w.sid)).toBe(true);
    sessionCriteria(w.sid, B);
    expect(startedBeforeVerification(w.sid, B)).toBe(false);
    expect(startedBeforeVerification(w.sid, w.A)).toBe(true);
  });
});

describe('rule 7: pin writes are atomic', () => {
  test('writeOnce: of many writers at one path exactly one wins and its text stays', async () => {
    const dir = tmp();
    const target = join(dir, 'pin.json');
    const script = `import { writeOnce } from ${JSON.stringify(join(ROOT, 'lib', 'start-pins.ts'))};\nconsole.log(writeOnce(${JSON.stringify(target)}, process.argv[2]!));`;
    const file = write(tmp(), 'w.ts', script);
    const runs = await Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        const p = Bun.spawn(['bun', file, `writer-${i}`], { stdout: 'pipe', stderr: 'pipe' });
        const out = (await new Response(p.stdout).text()).trim();
        await p.exited;
        return out;
      }),
    );
    expect(runs.filter((r) => r === 'true').length).toBe(1);
    expect(readFileSync(target, 'utf8')).toMatch(/^writer-\d$/);
    expect(readdirSync(dir)).toEqual(['pin.json']); // no temp file left
  });

  test('hooks that meet a new checkout together all read one start, and one pin file exists', async () => {
    const w = world();
    await startSession(w);
    const B = join(tmp(), 'B');
    worktree(w, B, w.Y);
    write(B, 'src/calc.ts', CALC_Y.replace('a + b;', 'a + b; // dirty'));
    const script = `import { topStart } from ${JSON.stringify(join(ROOT, 'lib', 'start-pins.ts'))};\nconsole.log(JSON.stringify(topStart(${JSON.stringify(w.sid)}, ${JSON.stringify(B)})));`;
    const file = write(tmp(), 'c.ts', script);
    const runs = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const p = Bun.spawn(['bun', file], { stdout: 'pipe', stderr: 'pipe', env: baseEnv(w) });
        const out = (await new Response(p.stdout).text()).trim();
        await p.exited;
        return out;
      }),
    );
    expect(new Set(runs).size).toBe(1);
    expect(JSON.parse(runs[0]!)).toEqual({ kind: 'commit', head: w.Y });
    expect(readdirSync(w.sdir).filter((f) => f.startsWith('start-pin-')).length).toBe(2);
    expect(readdirSync(w.sdir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

// Round 10 replaced round 9's "a worktree recreated at the same path is another checkout": the new
// identity keeps the original start (continuity), it never takes the new HEAD (see 'round 10, fix 1').
describe('rule 8: a worktree recreated at the same path', () => {
  test('it keeps the removed one\'s start (it never moves to the new HEAD) and gets a pin of its own', async () => {
    const w = world();
    const B = join(tmp(), 'B');
    worktree(w, B, w.Y);
    await startSession(w);
    const { topStart } = await pinsModule();
    expect(topStart(w.sid, B)).toEqual({ kind: 'commit', head: w.Y });
    sh(w.A, `git worktree remove --force ${JSON.stringify(B)}`);
    Bun.sleepSync(20);
    worktree(w, B, w.X); // same path, another commit
    expect(topStart(w.sid, B)).toEqual({ kind: 'commit', head: w.Y });
    const pins = readdirSync(w.sdir).filter((f) => f.startsWith('start-pin-'));
    expect(pins.length).toBe(3); // A, the removed B, the new B (with the inherited start)
  });
});

describe('rule 9: acceptance cursors are per checkout', () => {
  test('accepting in A does not advance past B\'s pending edits', async () => {
    const w = world();
    await startSession(w);
    const B = join(tmp(), 'B');
    worktree(w, B, w.Y);
    const env = { GOODBOY_TEST_GATE: 'on', GOODBOY_DIFF_COVERAGE: 'off', GOODBOY_EXISTING_TESTS: 'off' };
    // B's edit comes first: it sits at an earlier turn than the one A's accept will write into its cursor.
    const b = write(B, 'src/calc.ts', CALC_Y.replace('a + b;', 'a + b; // typed'));
    await post(w, B, b);
    // A: an edit, a passing record, a passing review.
    const a = write(w.A, 'src/calc.ts', CALC_X + '// edit\n');
    const at = newTest(w.A);
    await post(w, w.A, a);
    await post(w, w.A, at);
    testRecord(w.A, [a]);
    reviewRecord(w.A, [a, at]);
    const inA = await stop(w, w.A, env);
    expect(inA.decision).toBeUndefined();
    expect(readdirSync(w.sdir).filter((f) => f.startsWith('.goodboy-last-test-')).length).toBe(1);
    expect(readdirSync(w.sdir).filter((f) => f.startsWith('.goodboy-last-review-')).length).toBe(1);
    // B: its edit is still pending in both layers; A's accept moved A's cursors only.
    const inB = await stop(w, B, env);
    expect(inB.decision).toBe('block');
    expect(inB.reason).toContain('No test result covers the changed code');
    const reviewB = await stop(w, B, { ...env, GOODBOY_TEST_GATE: 'off' });
    expect(reviewB.decision).toBe('block');
    expect(reviewB.reason).toContain('Review is required');
  });

  test('a nested worktree with another start: A\'s Stop neither accepts nor writes a cursor', async () => {
    const w = world();
    await startSession(w);
    const B = join(w.A, 'wt', 'b');
    worktree(w, B, w.Y);
    const b = write(B, 'src/calc.ts', CALC_Y.replace('a + b;', 'a + b; // typed'));
    const nt = newTest(B);
    await post(w, w.A, b);
    await post(w, w.A, nt);
    testRecord(w.A, [b]);
    reviewRecord(w.A, [b, nt]);
    const out = await stop(w, w.A, { GOODBOY_TEST_GATE: 'on', GOODBOY_DIFF_COVERAGE: 'off', GOODBOY_EXISTING_TESTS: 'off' });
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('linked worktree nested in');
    expect(readdirSync(w.sdir).filter((f) => f.startsWith('.goodboy-last-'))).toEqual([]);
  });
});

describe('rule 10: a session from before the snapshot', () => {
  test('keeps its pin for its own checkout, takes no snapshot on a resume, and every other checkout is unknown', async () => {
    const w = world();
    // The pin as v0.36.6 wrote it.
    ensureSessionDir(w.sid);
    writeFileSync(join(w.sdir, 'coverage-pin.json'), JSON.stringify({ top: w.A, head: w.X, exemptions: [], globs: {} }));
    await startSession(w, w.A, 'resume');
    expect(existsSync(join(w.sdir, 'start-tips.json'))).toBe(false); // never manufactured during an upgrade
    expect(readdirSync(w.sdir).filter((f) => f.startsWith('start-pin-'))).toEqual([]);
    const B = join(tmp(), 'B');
    worktree(w, B, w.Y);
    const { sessionCoverageStart, repoTop } = await coverageModule();
    expect(sessionCoverageStart(w.sid, w.A, repoTop(w.A)).head).toBe(w.X);
    const other = sessionCoverageStart(w.sid, B, repoTop(B));
    expect(other.head).toBeUndefined();
    expect(other.unknown).toContain('no start snapshot');
    // And the Stop in B refuses to accept, with the reason.
    w.project = B;
    const calc = write(B, 'src/calc.ts', CALC_Y.replace('a + b;', 'a + b; // typed'));
    await post(w, B, calc);
    const out = await stop(w, B, { GOODBOY_TEST_GATE: 'on' });
    expect(out.decision).toBe('block');
    expect(out.reason).toContain("The session's start for");
    expect(out.reason).toContain('no start snapshot');
  });
});

describe('the state guard keeps the new pins', () => {
  test('a pin a Bash call created is removed, one it rewrote is restored', async () => {
    const w = world();
    await startSession(w);
    const key = readdirSync(w.sdir).find((f) => f.startsWith('start-pin-'))!;
    const dir = ensureSessionDir(w.sid);
    snapshotGateState(w.sid, 'toolu_i33guard');
    const before = readFileSync(join(dir, key), 'utf8');
    const tips = readFileSync(join(dir, 'start-tips.json'), 'utf8');
    writeFileSync(join(dir, key), JSON.stringify({ v: 1, forged: true }));
    writeFileSync(join(dir, 'start-tips.json'), '{}');
    writeFileSync(join(dir, 'start-pin-0123456789abcdef.json'), '{}');
    writeFileSync(join(dir, 'criteria-pin-0123456789abcdef.json'), '{}');
    writeFileSync(join(dir, 'criteria-seen-0123456789abcdef.json'), '[]');
    const restored = restoreGateState(w.sid, 'toolu_i33guard');
    expect(restored.sort()).toEqual([key, 'criteria-pin-0123456789abcdef.json', 'criteria-seen-0123456789abcdef.json', 'start-pin-0123456789abcdef.json', 'start-tips.json'].sort());
    expect(readFileSync(join(dir, key), 'utf8')).toBe(before);
    expect(readFileSync(join(dir, 'start-tips.json'), 'utf8')).toBe(tips);
    expect(existsSync(join(dir, 'start-pin-0123456789abcdef.json'))).toBe(false);
  });
});

// ═══ Round 9 (Codex, the security and the evidence/quality/performance reviews) ══════════════════

// ── A git first on PATH that records every call and can fail the ones that match ─────────────

/** The real git, as `bun test` finds it before any fake is installed. */
const REAL_GIT = Bun.which('git', { PATH: process.env.PATH })!;
const FAKE_GIT = [
  '#!/bin/sh',
  'printf \'%s\\n\' "$*" >> "$GB_LOG"',
  // GB_FAIL: every call whose arguments contain it fails (as a git that cannot answer).
  'if [ -n "$GB_FAIL" ]; then case "$*" in *"$GB_FAIL"*) echo "fatal: injected failure" >&2; exit "${GB_FAIL_CODE:-128}" ;; esac; fi',
  // GB_SLEEP: every call whose arguments contain it hangs (a git that never answers).
  'if [ -n "$GB_SLEEP" ]; then case "$*" in *"$GB_SLEEP"*) exec sleep 30 ;; esac; fi',
  'exec "$GB_REAL" "$@"',
  '',
].join('\n');

interface Fake {
  calls: () => string[];
  reset: () => void;
  fail: (substring: string | null) => void;
  /** Calls whose arguments contain `substring` hang until they are killed (null: none). */
  hang: (substring: string | null) => void;
}
/** Installs the recording git first on PATH of this process (and of every hook spawned with its env);
 *  undone after the test. */
function fakeGit(): Fake {
  const dir = tmp('goodboy-i33-fake-');
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  writeFileSync(join(dir, 'git'), FAKE_GIT);
  chmodSync(join(dir, 'git'), 0o755);
  const names = ['PATH', 'GB_LOG', 'GB_REAL', 'GB_FAIL', 'GB_SLEEP'];
  const saved = names.map((n) => process.env[n]);
  process.env.GB_LOG = log;
  process.env.GB_REAL = REAL_GIT;
  delete process.env.GB_FAIL;
  delete process.env.GB_SLEEP;
  process.env.PATH = `${dir}${delimiter}${process.env.PATH}`;
  restore.push(() => names.forEach((n, i) => (saved[i] === undefined ? delete process.env[n] : (process.env[n] = saved[i]))));
  return {
    calls: () => readFileSync(log, 'utf8').split('\n').filter((l) => l !== ''),
    reset: () => writeFileSync(log, ''),
    fail: (sub) => (sub === null ? delete process.env.GB_FAIL : (process.env.GB_FAIL = sub)),
    hang: (sub) => (sub === null ? delete process.env.GB_SLEEP : (process.env.GB_SLEEP = sub)),
  };
}
const startPins = (w: World): string[] => (existsSync(w.sdir) ? readdirSync(w.sdir).filter((f) => f.startsWith('start-pin-')) : []);
const POLICY = (globs: string): string => ['## P1 Exempt', '- decide: human', '- source: user', '- date: 2026-10-27', '- checked: 2026-10-27', `- coverage-exempt: ${globs}`, ''].join('\n');
/** A worktree `B` of the world's repo at `rev`, made after the session started (first sight). */
function laterWorktree(w: World, rev: string): string {
  const B = join(tmp(), 'B');
  worktree(w, B, rev);
  return B;
}

describe('round 9, fix 1: git names a checkout whose .git this cannot read', () => {
  function symlinkDotGit(B: string): void {
    const admin = sh(B, 'cat .git').replace('gitdir: ', '').trim();
    sh(B, `rm .git && ln -s ${JSON.stringify(admin)} .git`);
  }

  test('a symlinked .git: the start is the real commit, so I5 judges its tests (it was the empty tree, with I5 off)', async () => {
    const w = world();
    await startSession(w);
    const B = laterWorktree(w, w.X);
    symlinkDotGit(B);
    const { topStart, topIdentity } = await pinsModule();
    const who = topIdentity(B);
    expect(who.unknown).toBeUndefined();
    expect(who.id).not.toBe('nogit');
    expect(topStart(w.sid, B)).toEqual({ kind: 'commit', head: w.X });
    const calc = write(B, 'src/calc.ts', CALC_X + '// typed\n');
    const weak = write(B, 'tests/calc.test.ts', `${T}test("add", () => {});\n`); // the old test lost its only assertion
    for (const f of [calc, weak]) await post(w, B, f);
    reviewRecord(B, [calc, weak]);
    const out = await stop(w, B, { GOODBOY_TEST_GATE: 'off', GOODBOY_EXISTING_TESTS: 'on' });
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('tests/calc.test.ts');
  });

  test('git cannot say what the checkout is: unknown and incomplete (never empty), nothing pinned; asked again later', async () => {
    const w = world();
    await startSession(w);
    const B = laterWorktree(w, w.X);
    symlinkDotGit(B);
    const f = fakeGit();
    const { topStart } = await pinsModule();
    const before = startPins(w).length;
    f.fail('--show-toplevel');
    const down = topStart(w.sid, B);
    f.fail(null);
    expect(down).toMatchObject({ kind: 'unknown', incomplete: true });
    expect(startPins(w).length).toBe(before);
    expect(topStart(w.sid, B)).toEqual({ kind: 'commit', head: w.X });
  });

  test('git out of time (the hook\'s deadline is spent) is unknown for a checkout whose .git cannot be read, never "no repo"', async () => {
    const w = world();
    await startSession(w);
    const B = laterWorktree(w, w.X);
    symlinkDotGit(B);
    const { topIdentity, topStart, startPinDeadline } = await pinsModule();
    startPinDeadline(-1);
    const who = topIdentity(B);
    const s = topStart(w.sid, B);
    startPinDeadline(Number.POSITIVE_INFINITY);
    expect(who.unknown).toBeDefined();
    expect(s).toMatchObject({ kind: 'unknown', incomplete: true });
  });

  test('a .git that git does not accept (a dangling symlink) is unknown, not "no repo": git says "not a git repository" but the path has a .git', async () => {
    const w = world();
    await startSession(w);
    const bad = tmp();
    symlinkSync(join(bad, 'nowhere'), join(bad, '.git'));
    const { topIdentity, topStart } = await pinsModule();
    expect(sh(bad, 'git rev-parse --git-dir')).toContain('not a git repository');
    expect(topIdentity(bad).unknown).toBeDefined();
    expect(topStart(w.sid, bad)).toMatchObject({ kind: 'unknown', incomplete: true });
  });

  test('a directory that is no repository (git says so) is empty and never pinned', async () => {
    const w = world();
    await startSession(w);
    const plain = tmp();
    const { topStart } = await pinsModule();
    const before = startPins(w).length;
    expect(topStart(w.sid, plain)).toEqual({ kind: 'empty' });
    expect(startPins(w).length).toBe(before); // a no-git identity is never kept
  });
});

describe('round 9, fix 2: the empty start needs a complete frozen tip set (or an object store with no commit)', () => {
  test('refs deleted, a detached HEAD holds the history: an unborn checkout is unknown, not empty (at the start and mid-session)', async () => {
    const w = world();
    const B = join(tmp(), 'B');
    worktree(w, B, w.X);
    sh(B, 'git checkout -q --orphan o'); // unborn at the session's start
    sh(w.A, 'git checkout -q --detach && git branch -D main');
    expect(sh(w.A, 'git for-each-ref')).toBe(''); // no ref at all: A's detached HEAD is the only history
    await startSession(w);
    const { topStart } = await pinsModule();
    expect(topStart(w.sid, B).kind).toBe('unknown'); // eager pin: the tip set is not empty
    const C = laterWorktree(w, w.X);
    sh(C, 'git checkout -q --orphan p');
    expect(topStart(w.sid, C)).toMatchObject({ kind: 'unknown', incomplete: true });
  });

  test('another repository that looks unborn is empty only when its object store holds no commit', async () => {
    const w = world();
    await startSession(w);
    const { topStart } = await pinsModule();
    const had = tmp();
    sh(had, `${GIT_INIT} && git commit -q --allow-empty -m c && git checkout -q --orphan o && git update-ref -d refs/heads/main`);
    expect(sh(had, 'git for-each-ref')).toBe(''); // HEAD unresolved, no ref at all, a commit object stored
    expect(topStart(w.sid, had)).toMatchObject({ kind: 'unknown', incomplete: true });
    const none = tmp();
    sh(none, `${GIT_INIT} && echo x | git hash-object -w --stdin`); // objects, but no commit
    expect(topStart(w.sid, none)).toEqual({ kind: 'empty' });
  });

  test('control: a session that started in a repository with no commit has the empty start there', async () => {
    const w = world();
    const fresh = tmp();
    sh(fresh, GIT_INIT);
    const { pinCoverageStart } = await coverageModule();
    const { topStart } = await pinsModule();
    pinCoverageStart(w.sid, fresh);
    expect(JSON.parse(readFileSync(join(w.sdir, 'start-tips.json'), 'utf8')).tips).toEqual([]);
    expect(topStart(w.sid, fresh)).toEqual({ kind: 'empty' });
  });
});

describe('round 9, fix 4: first sight lists what differs from three sets that cannot cancel', () => {
  test('a staged edit that the work tree reverted is recorded (one comparison with the start sees nothing)', async () => {
    const w = world();
    await startSession(w);
    const B = laterWorktree(w, w.Y);
    write(B, 'src/calc.ts', CALC_Y + '// staged\n');
    sh(B, 'git add src/calc.ts');
    write(B, 'src/calc.ts', CALC_Y); // back to the start's content in the work tree
    expect(sh(B, `git diff --name-only ${w.Y}`)).toBe('');
    const { topStart } = await pinsModule();
    expect(topStart(w.sid, B)).toEqual({ kind: 'commit', head: w.Y });
    expect(readFileSync(join(w.sdir, 'edits.jsonl'), 'utf8')).toContain(join(B, 'src/calc.ts'));
  });

  test('an unknown start records the dirt too: a shell revert in a checkout with unrelated history is not hidden (p2)', async () => {
    const w = world();
    await startSession(w);
    const forged = sh(w.A, `git commit-tree -m orphan ${w.X}^{tree}`); // no parent: unrelated to the frozen tips
    const B = laterWorktree(w, forged);
    write(B, 'src/calc.ts', CALC_Y); // a Bash edit, no hook saw it
    w.project = B;
    const out = await stop(w, B, { GOODBOY_TEST_GATE: 'on' });
    expect(out.decision).toBe('block');
    expect(out.reason).toContain("The session's start for");
    expect(out.reason).toContain('unrelated');
    expect(readFileSync(join(w.sdir, 'edits.jsonl'), 'utf8')).toContain(join(B, 'src/calc.ts'));
  });
});

describe('round 9, fix 4: an incomplete first sight blocks every Stop in the top, whatever its edit list holds', () => {
  test('no HEAD in a repository with history: blocked with no edits at all, counted, and the marker notice shows', async () => {
    const w = world();
    await startSession(w);
    const B = laterWorktree(w, w.X);
    sh(B, 'git checkout -q --orphan o');
    w.project = B;
    const first = await stop(w, B, { GOODBOY_TEST_GATE: 'on' });
    expect(first.decision).toBe('block');
    expect(first.reason).toContain('could not be established');
    expect(first.reason).toContain('new session');
    expect(first.reason).toContain('approval marker');
    expect(first.reason).not.toMatch(/record a `blocked`|ends the turn as unverified/);
    const second = await stop(w, B, { GOODBOY_TEST_GATE: 'on' });
    expect(second.decision).toBe('block');
    expect(second.systemMessage).toContain('touch'); // the user is shown the one-shot marker
  });

  test('more than 20,000 files differ at first sight: unknown, pinned, and every Stop blocks (an edit-free one too)', async () => {
    const w = world();
    await startSession(w);
    const B = laterWorktree(w, w.X);
    for (let i = 0; i <= 20_000; i++) write(B, `many/f${i}.txt`, '');
    w.project = B;
    const out = await stop(w, B, { GOODBOY_TEST_GATE: 'on' });
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('more than 20000 files');
    const pin = startPins(w).map((f) => readFileSync(join(w.sdir, f), 'utf8')).find((t) => t.includes('"incomplete":true'));
    expect(pin).toBeDefined();
    // A few files are fine: the cap is a count, not a guess.
    const { topStart } = await pinsModule();
    const ok = laterWorktree(w, w.X);
    for (let i = 0; i < 5; i++) write(ok, `few/f${i}.txt`, '');
    expect(topStart(w.sid, ok)).toEqual({ kind: 'commit', head: w.X });
  });

  test('a git error at first sight blocks that Stop and pins nothing; once git answers the checkout is pinned and passes', async () => {
    const w = world();
    await startSession(w);
    const B = laterWorktree(w, w.X);
    w.project = B;
    const f = fakeGit();
    const before = startPins(w).length;
    f.fail('rev-list');
    const bad = await stop(w, B, { GOODBOY_TEST_GATE: 'on' });
    f.fail(null);
    expect(bad.decision).toBe('block');
    expect(bad.reason).toContain('could not be established');
    expect(startPins(w).length).toBe(before);
    const good = await stop(w, B, { GOODBOY_TEST_GATE: 'on' });
    expect(good.decision).toBeUndefined();
    expect(startPins(w).length).toBe(before + 1);
  });

  test.each([['rev-list'], ['diff'], ['ls-files']])('a failing %s at first sight is a transient unknown: not pinned', async (call) => {
    const w = world();
    await startSession(w);
    const B = laterWorktree(w, w.X);
    const f = fakeGit();
    const { topStart } = await pinsModule();
    const before = startPins(w).length;
    f.fail(call);
    const s = topStart(w.sid, B);
    f.fail(null);
    expect(s).toMatchObject({ kind: 'unknown', incomplete: true });
    expect(startPins(w).length).toBe(before);
    expect(topStart(w.sid, B)).toEqual({ kind: 'commit', head: w.X });
  });

  test('a clone made mid-session (another repository with history) stays unknown and blocks when edited', async () => {
    const w = world();
    await startSession(w);
    const C = join(tmp(), 'C');
    sh(w.A, `git clone -q ${JSON.stringify(w.A)} ${JSON.stringify(C)} && cd ${JSON.stringify(C)} && git config user.email t@e.com && git config user.name t`);
    const { topStart } = await pinsModule();
    const s = topStart(w.sid, C);
    expect(s.kind).toBe('unknown');
    expect(s.kind === 'unknown' && s.reason).toContain('another repository');
    const calc = write(C, 'src/calc.ts', CALC_X + '// edit\n');
    await post(w, C, calc);
    const out = await stop(w, C, { GOODBOY_TEST_GATE: 'on' });
    expect(out.decision).toBe('block');
    expect(out.reason).toContain("The session's start for");
  });
});

describe('round 9, fix 5: the start block has its own text and still counts', () => {
  test.each([['on'], ['off']])('test gate %s: a new session or the user\'s marker; no "record a blocked result"; the notice shows on the second block', async (gate) => {
    const w = world();
    await startSession(w);
    const B = laterWorktree(w, w.Y);
    sh(B, 'git checkout -q --orphan o && git rm -rfq . && git commit -q --allow-empty -m root'); // unrelated history: unknown
    write(B, 'package.json', '{"name":"p","scripts":{"test":"bun test"}}');
    write(B, '.gitignore', '.claude/\n');
    w.project = B;
    const calc = write(B, 'src/calc.ts', CALC_Y.replace('a + b;', 'a + b; // typed'));
    await post(w, B, calc);
    const env = { GOODBOY_TEST_GATE: gate, GOODBOY_DIFF_COVERAGE: 'off', GOODBOY_EXISTING_TESTS: 'off' };
    const first = await stop(w, B, env);
    expect(first.decision).toBe('block');
    expect(first.reason).toContain("The session's start for");
    expect(first.reason).toContain('new session');
    expect(first.reason).toContain('approval marker');
    expect(first.reason).not.toMatch(/record a `blocked`|ends the turn as unverified|passes only on its evidence/);
    expect(first.systemMessage).toBeUndefined();
    const second = await stop(w, B, env);
    expect(second.decision).toBe('block');
    expect(second.systemMessage).toContain('touch');
  });
});

describe('round 9, fix 6: grants freeze at the initial pin', () => {
  test('a resume takes a grant away and never adds one', async () => {
    const w = world((A) => write(A, '.goodboy/policy.md', POLICY('hooks/**')));
    const { pinCoverageStart, sessionCoverageStart, repoTop } = await coverageModule();
    const grants = () => sessionCoverageStart(w.sid, w.A, repoTop(w.A)).exempt;
    pinCoverageStart(w.sid, w.A);
    expect(grants()).toEqual(['hooks/**']);
    write(w.A, '.goodboy/policy.md', POLICY('hooks/**, src/**')); // the session writes one in
    pinCoverageStart(w.sid, w.A); // a resume or compact
    expect(grants()).toEqual(['hooks/**']);
    write(w.A, '.goodboy/policy.md', POLICY('src/**')); // the user removes one; the one written in stays out
    pinCoverageStart(w.sid, w.A);
    expect(grants()).toEqual([]);
    write(w.A, '.goodboy/policy.md', POLICY('hooks/**, src/**')); // and the removed one does not come back by a restart
    pinCoverageStart(w.sid, w.A);
    expect(grants()).toEqual([]);
  });

  test('the other user globs (static previews) freeze the same way', async () => {
    const preview = (globs: string) => ['## P2 Previews', '- decide: human', '- source: user', '- date: 2026-10-27', '- checked: 2026-10-27', `- static-preview: ${globs}`, ''].join('\n');
    const w = world((A) => write(A, '.goodboy/policy.md', preview('docs/a/**')));
    const { pinCoverageStart, sessionUserGlobs, repoTop } = await coverageModule();
    const previews = () => sessionUserGlobs(w.sid, w.A, repoTop(w.A), 'static-preview');
    pinCoverageStart(w.sid, w.A);
    expect(previews()).toEqual(['docs/a/**']);
    write(w.A, '.goodboy/policy.md', preview('docs/a/**, docs/b/**'));
    pinCoverageStart(w.sid, w.A);
    expect(previews()).toEqual(['docs/a/**']);
  });
});

describe('round 9, fix 7: the first top\'s identity', () => {
  test('a repository recreated at the first top\'s path is a new top: the first pin does not apply to it', async () => {
    const w = world((A) => write(A, '.goodboy/policy.md', POLICY('src/**')));
    await startSession(w);
    const { sessionCoverageStart, repoTop, pinCoverageStart } = await coverageModule();
    expect(sessionCoverageStart(w.sid, w.A, repoTop(w.A))).toEqual({ exempt: ['src/**'], head: w.X });
    rmSync(join(w.A, '.git'), { recursive: true, force: true });
    Bun.sleepSync(20);
    sh(w.A, `${GIT_INIT} && git add -A && git commit -q -m 'ABC-1 new world'`);
    const s = sessionCoverageStart(w.sid, w.A, repoTop(w.A));
    expect(s.head).toBeUndefined();
    expect(s.unknown).toBeDefined();
    expect(s.exempt).toEqual([]); // the grants were the old repository's
    const pinBytes = readFileSync(join(w.sdir, 'coverage-pin.json'), 'utf8');
    pinCoverageStart(w.sid, w.A); // a resume there does not move the first pin onto the new repository
    expect(readFileSync(join(w.sdir, 'coverage-pin.json'), 'utf8')).toBe(pinBytes);
    w.project = w.A;
    await post(w, w.A, write(w.A, 'src/calc.ts', CALC_X + '// edit\n'));
    const out = await stop(w, w.A, { GOODBOY_TEST_GATE: 'on' });
    expect(out.decision).toBe('block');
    expect(out.reason).toMatch(/start/);
    expect(out.reason).not.toContain('No test result covers'); // not judged against the old start as if nothing happened
  });

  test('a legacy pin without an identity still matches by path and gets none on a resume (rule 10)', async () => {
    const w = world();
    ensureSessionDir(w.sid);
    writeFileSync(join(w.sdir, 'coverage-pin.json'), JSON.stringify({ top: w.A, head: w.X, exemptions: [] }));
    const { sessionCoverageStart, repoTop, pinCoverageStart } = await coverageModule();
    expect(sessionCoverageStart(w.sid, w.A, repoTop(w.A)).head).toBe(w.X);
    pinCoverageStart(w.sid, w.A);
    expect(JSON.parse(readFileSync(join(w.sdir, 'coverage-pin.json'), 'utf8')).identity).toBeUndefined(); // never manufactured on an upgrade
  });
});

describe('round 9, fix 8: a missing coverage pin', () => {
  test('after SessionStart ran it is unknown and is not made again by a resume; with no sign of a SessionStart the old skip stays', async () => {
    const w = world();
    await startSession(w);
    rmSync(join(w.sdir, 'coverage-pin.json'));
    const { sessionCoverageStart, repoTop } = await coverageModule();
    const s = sessionCoverageStart(w.sid, w.A, repoTop(w.A));
    expect(s.head).toBeUndefined();
    expect(s.unknown).toContain('missing or unreadable');
    await startSession(w, w.A, 'resume');
    expect(existsSync(join(w.sdir, 'coverage-pin.json'))).toBe(false); // not healed at a later HEAD
    await post(w, w.A, write(w.A, 'src/calc.ts', CALC_X + '// edit\n'));
    const out = await stop(w, w.A, { GOODBOY_TEST_GATE: 'on' });
    expect(out.decision).toBe('block');
    expect(out.reason).toContain("The session's start for");
    // An unreadable pin is the same.
    const w2 = world();
    await startSession(w2);
    writeFileSync(join(w2.sdir, 'coverage-pin.json'), '{not json');
    expect(sessionCoverageStart(w2.sid, w2.A, repoTop(w2.A)).unknown).toContain('missing or unreadable');
    // No SessionStart at all (a plugin installed mid-session, a test): the checks that need a base are skipped.
    const w3 = world();
    expect(sessionCoverageStart(w3.sid, w3.A, repoTop(w3.A))).toEqual({ exempt: [] });
  });
});

describe('round 9, fix 9: one deadline for the start-pin git calls', () => {
  test('past it no snapshot is taken and a first sight is a transient unknown, pinned nowhere', async () => {
    const w = world();
    const B = laterWorktree(w, w.X);
    const { startPinDeadline, takeStartSnapshot, topStart } = await pinsModule();
    startPinDeadline(-1);
    takeStartSnapshot(w.sid, w.A);
    expect(existsSync(join(w.sdir, 'start-tips.json'))).toBe(false);
    expect(startPins(w)).toEqual([]);
    expect(topStart(w.sid, B)).toMatchObject({ kind: 'unknown', incomplete: true });
    expect(startPins(w)).toEqual([]);
    startPinDeadline(Number.POSITIVE_INFINITY);
    takeStartSnapshot(w.sid, w.A);
    expect(existsSync(join(w.sdir, 'start-tips.json'))).toBe(true);
  });
});

describe('round 9, fix 9: a call is cut at its own limit and at what the deadline has left', () => {
  test('a git that never answers: one call is cut at about 5 s, and a spent-in-part deadline cuts it sooner', async () => {
    const w = world();
    const f = fakeGit();
    const { takeStartSnapshot, startPinDeadline } = await pinsModule();
    f.hang('for-each-ref');
    startPinDeadline(1500); // one deadline for the hook: the call gets what is left
    let t0 = Date.now();
    takeStartSnapshot(w.sid, w.A);
    const withDeadline = Date.now() - t0;
    startPinDeadline(Number.POSITIVE_INFINITY); // no deadline: the per-call limit alone
    t0 = Date.now();
    takeStartSnapshot(w.sid, w.A);
    const perCall = Date.now() - t0;
    f.hang(null);
    expect(existsSync(join(w.sdir, 'start-tips.json'))).toBe(false);
    expect(withDeadline).toBeLessThan(4_000);
    expect(perCall).toBeGreaterThan(3_000);
    expect(perCall).toBeLessThan(9_000); // 5 s, not the 15 s of the hook's own timeout
  });
});

describe('round 9: a snapshot that fails or is cut writes no tips file', () => {
  test.each([['for-each-ref'], ['worktree list']])('a failing %s: no tips file and no pin', async (call) => {
    const w = world();
    const f = fakeGit();
    const { takeStartSnapshot } = await pinsModule();
    f.fail(call);
    takeStartSnapshot(w.sid, w.A);
    f.fail(null);
    expect(existsSync(join(w.sdir, 'start-tips.json'))).toBe(false);
    expect(startPins(w)).toEqual([]);
  });

  test('a tag of a tag (its commit is not in the listed set): the set is not complete, so no snapshot', async () => {
    const w = world();
    sh(w.A, 'git tag -a t1 -m one HEAD && git tag -a t2 -m two t1');
    const { takeStartSnapshot } = await pinsModule();
    takeStartSnapshot(w.sid, w.A);
    expect(existsSync(join(w.sdir, 'start-tips.json'))).toBe(false);
  });

  test('more than 100,000 tips: no snapshot (a truncated list is never a complete one)', async () => {
    const w = world();
    // 100,001 distinct commits, each named by a packed ref (one fast-import; no loose ref per commit).
    const N = 100_001;
    const stream: string[] = [];
    for (let i = 0; i < N; i++) stream.push(`commit refs/tmp/x\nmark :${i + 1}\ncommitter t <t@e.com> ${1_700_000_000 + i} +0000\ndata 1\nx\n`);
    const marks = join(tmp(), 'marks');
    const p = Bun.spawnSync(['git', 'fast-import', '--quiet', '--force', `--export-marks=${marks}`], { cwd: w.A, stdin: Buffer.from(stream.join('\n')), stdout: 'pipe', stderr: 'pipe' });
    expect(p.exitCode).toBe(0);
    const ids = readFileSync(marks, 'utf8').split('\n').filter((l) => l !== '').map((l) => l.split(' ')[1]!);
    const lines = ids.map((id, i) => `${id} refs/heads/b${String(i).padStart(6, '0')}`).sort();
    writeFileSync(join(w.A, '.git', 'packed-refs'), ['# pack-refs with: peeled fully-peeled sorted ', ...lines, ''].join('\n'));
    sh(w.A, 'git update-ref -d refs/tmp/x');
    expect(Number(sh(w.A, 'git for-each-ref | wc -l'))).toBeGreaterThan(100_000);
    const { takeStartSnapshot } = await pinsModule();
    takeStartSnapshot(w.sid, w.A);
    expect(existsSync(join(w.sdir, 'start-tips.json'))).toBe(false);
    expect(startPins(w)).toEqual([]);
  });
});

describe('round 9, fix 10 and 11: git cost', () => {
  test.each([['in'], ['out']])('a later PostToolUse in a top the session pinned spawns no git (%s .claude/worktrees)', async (where) => {
    const w = world();
    await startSession(w);
    const B = where === 'in' ? join(w.A, '.claude', 'worktrees', 'b') : join(tmp(), 'B');
    worktree(w, B, w.Y); // made after the start: the first hook to see it pins it
    const f = fakeGit();
    await post(w, B, write(B, 'src/one.ts', 'export const one = 1;\n'));
    expect(f.calls().length).toBeGreaterThan(0); // the first sight asks git
    expect(startPins(w).length).toBe(2);
    f.reset();
    await post(w, B, write(B, 'src/two.ts', 'export const two = 2;\n'));
    expect(f.calls()).toEqual([]);
    await post(w, w.A, write(w.A, 'src/three.ts', 'export const three = 3;\n')); // the first top: none either
    expect(f.calls()).toEqual([]);
    // The first top is known from the coverage pin alone, even where it has no start pin of its own.
    for (const name of startPins(w)) if (readFileSync(join(w.sdir, name), 'utf8').includes(JSON.stringify(w.A))) rmSync(join(w.sdir, name));
    await post(w, w.A, write(w.A, 'src/four.ts', 'export const four = 4;\n'));
    expect(f.calls()).toEqual([]);
  });

  test('SessionStart lists the worktrees once, for the note and for the snapshot', async () => {
    const w = world();
    laterWorktree(w, w.Y);
    const f = fakeGit();
    await startSession(w);
    expect(f.calls().filter((l) => /(?:^| )worktree list/.test(l)).length).toBe(1);
    expect(existsSync(join(w.sdir, 'start-tips.json'))).toBe(true);
    expect(existsSync(join(w.sdir, 'worktrees.txt'))).toBe(true);
  });
});

describe('round 9, fix 12: one commit reader with a tri-state result', () => {
  test('blobAtCommitResult: text, absent, refused (a symlink, a tree, over the size) and error (unknown commit, malformed)', async () => {
    const w = world();
    symlinkSync('package.json', join(w.A, 'link.json'));
    sh(w.A, "git add -A && git commit -q -m 'ABC-1 link'");
    const head = sh(w.A, 'git rev-parse HEAD');
    const { blobAtCommitResult, blobAtCommit } = await coverageModule();
    expect(blobAtCommitResult(w.A, head, 'package.json', 1000)).toEqual({ kind: 'text', text: '{"name":"p","version":"1.0.0","scripts":{"test":"bun test"}}' });
    expect(blobAtCommitResult(w.A, head, 'none.txt', 1000)).toEqual({ kind: 'absent' });
    expect(blobAtCommitResult(w.A, head, 'link.json', 1000)).toEqual({ kind: 'refused' });
    expect(blobAtCommitResult(w.A, head, 'src', 1000)).toEqual({ kind: 'refused' });
    expect(blobAtCommitResult(w.A, head, 'package.json', 5)).toEqual({ kind: 'refused' });
    expect(blobAtCommitResult(w.A, 'f'.repeat(40), 'package.json', 1000)).toEqual({ kind: 'error' });
    expect(blobAtCommitResult(w.A, 'HEAD', 'package.json', 1000)).toEqual({ kind: 'error' });
    expect(blobAtCommit(w.A, head, 'link.json', 1000)).toBeNull(); // the old reader's answers are unchanged
    expect(blobAtCommit(w.A, head, 'none.txt', 1000)).toBeNull();
  });

  const reqs = ['# Requirements', '', '## Requirements', '', '| Rank | Requirement | Status |', '|---|---|---|', '| 1 | login | in progress |', ''].join('\n');
  async function docsWorld(extra: (A: string) => void) {
    const w = world((A) => {
      write(A, 'docs/CYCLE.md', '# Cycle\n\n- **Current version**: 1.0\n- **Current stage**: 5\n');
      write(A, 'docs/versions/1.0/REQUIREMENTS.md', reqs);
      extra(A);
    });
    sh(w.A, "git add -A && git commit -q -m 'ABC-1 docs'");
    w.X = sh(w.A, 'git rev-parse HEAD');
    await startSession(w);
    return w;
  }

  test('docs at a commit follow the work tree\'s rules: an unreadable CYCLE.md is no cycle; an unreadable table or policy, and a git error, block', async () => {
    const { sessionCriteria } = await criteriaModule();
    // CYCLE.md a symlink in the start commit: the work-tree read refuses it and reads no cycle (no rows), it is no problem.
    const a = await docsWorld((A) => {
      unlinkSync(join(A, 'docs/CYCLE.md'));
      write(A, 'docs/real-cycle.md', '- **Current version**: 1.0\n');
      symlinkSync('real-cycle.md', join(A, 'docs/CYCLE.md'));
    });
    const Ba = laterWorktree(a, a.X);
    expect(sessionCriteria(a.sid, Ba).problem).toBeUndefined();
    // REQUIREMENTS.md a symlink: a problem, as in the work tree.
    const b = await docsWorld((A) => {
      unlinkSync(join(A, 'docs/versions/1.0/REQUIREMENTS.md'));
      write(A, 'docs/req-real.md', reqs);
      symlinkSync('../../req-real.md', join(A, 'docs/versions/1.0/REQUIREMENTS.md'));
    });
    expect(sessionCriteria(b.sid, laterWorktree(b, b.X)).problem).toContain('cannot be established');
    // policy.md over the size limit.
    const c = await docsWorld((A) => write(A, '.goodboy/policy.md', 'x'.repeat(2_100_000)));
    expect(sessionCriteria(c.sid, laterWorktree(c, c.X)).problem).toContain('cannot be established');
    // A git error reading the documents.
    const d = await docsWorld(() => {});
    const Bd = laterWorktree(d, d.X);
    const f = fakeGit();
    f.fail('ls-tree');
    const hit = sessionCriteria(d.sid, Bd);
    f.fail(null);
    expect(hit.problem).toContain('cannot be established');
    expect(sessionCriteria(d.sid, Bd).problem).toBeUndefined(); // not kept as a baseline: read again when git answers
  });
});

describe('round 9, rule 9: acceptance cursors, the other direction', () => {
  test('accepting in B does not advance past A\'s pending edits', async () => {
    const w = world();
    await startSession(w);
    const B = laterWorktree(w, w.Y);
    const env = { GOODBOY_TEST_GATE: 'on', GOODBOY_DIFF_COVERAGE: 'off', GOODBOY_EXISTING_TESTS: 'off' };
    const a = write(w.A, 'src/calc.ts', CALC_X + '// edit\n'); // A's edit comes first, at an earlier turn than B's accept
    await post(w, w.A, a);
    const b = write(B, 'src/calc.ts', CALC_Y.replace('a + b;', 'a + b; // typed'));
    const bt = newTest(B);
    await post(w, B, b);
    await post(w, B, bt);
    testRecord(B, [b]);
    reviewRecord(B, [b, bt]);
    const inB = await stop(w, B, env);
    expect(inB.decision).toBeUndefined();
    expect(readdirSync(w.sdir).filter((f) => f.startsWith('.goodboy-last-test-')).length).toBe(1);
    expect(readdirSync(w.sdir).filter((f) => f.startsWith('.goodboy-last-review-')).length).toBe(1);
    const inA = await stop(w, w.A, env);
    expect(inA.decision).toBe('block');
    expect(inA.reason).toContain('No test result covers the changed code');
    const reviewA = await stop(w, w.A, { ...env, GOODBOY_TEST_GATE: 'off' });
    expect(reviewA.decision).toBe('block');
    expect(reviewA.reason).toContain('Review is required');
  });
});

// ═══ Round 10 (Codex, the security and the evidence/quality/performance re-reviews) ═══════════════

/** A world whose HEAD X2 also has a test only X2 has (`tests/xonly.test.ts`, added on top of X). */
function xonlyWorld(before?: (A: string) => void): World & { X2: string } {
  const w = world((A) => {
    write(A, 'tests/xonly.test.ts', `${T}test("x only", () => { expect(1).toBe(1); });\n`);
    sh(A, "git add -A && git commit -q -m 'ABC-1 xonly'");
    before?.(A);
  });
  return { ...w, X2: sh(w.A, 'git rev-parse HEAD') };
}
/** The model's way to make a new admin dir at the same path: copy `.git` aside, remove it, copy it back. */
function recreateGitDir(top: string): void {
  const keep = join(tmp(), 'g');
  sh(top, `cp -a .git ${JSON.stringify(keep)} && rm -rf .git && cp -a ${JSON.stringify(keep)} .git`);
}
const I5 = { GOODBOY_TEST_GATE: 'on', GOODBOY_EXISTING_TESTS: 'on', GOODBOY_DIFF_COVERAGE: 'off' };
/** The tests that load src/calc.ts, as a record that ran them lists them (existing-tests rule, I5). */
const CALC_TESTS = ['tests/calc-new.test.ts', 'tests/calc.test.ts', 'tests/extra1.test.ts', 'tests/extra2.test.ts', 'tests/extra3.test.ts'];

describe('round 10, fix 1: an identity change at a pinned path never moves its baseline', () => {
  test('the first top: a backward reset after the admin dir was recreated keeps the start, so a deleted test is still found (q8)', async () => {
    const w = xonlyWorld();
    await startSession(w);
    unlinkSync(join(w.A, 'tests/xonly.test.ts')); // a shell deletion of a test the session started with
    const calc = write(w.A, 'src/calc.ts', CALC_X + '// typed\n');
    const nt = newTest(w.A);
    for (const f of [calc, nt]) await post(w, w.A, f);
    recreateGitDir(w.A);
    sh(w.A, `git reset -q --mixed ${w.Y}`); // an older pre-session commit: the new HEAD would have no xonly test to lose
    const { topStart } = await pinsModule();
    expect(topStart(w.sid, w.A)).toEqual({ kind: 'commit', head: w.X2 });
    testRecord(w.A, [calc, join(w.A, 'package.json')], {}, CALC_TESTS);
    reviewRecord(w.A, [calc, nt, join(w.A, 'package.json'), join(w.A, '.gitignore'), join(w.A, 'tests/xonly.test.ts'), join(w.A, 'tests/calc.test.ts')]);
    const out = await stop(w, w.A, I5);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('tests/xonly.test.ts (deleted)');
  });

  // Guard: with the frozen tips the boundary rule gives the same start here, so this does not prove the
  // continuity rule; the cases below that fail without it are the reset, the worktrees, the merge and the fast-forward.
  test('the first top: a session commit before the admin dir is recreated does not become the start (guard)', async () => {
    const w = xonlyWorld();
    await startSession(w);
    sh(w.A, "git rm -q tests/xonly.test.ts && git commit -q -m 'ABC-1 drop xonly'"); // the session's own commit deletes it
    const calc = write(w.A, 'src/calc.ts', CALC_X + '// typed\n');
    const nt = newTest(w.A);
    for (const f of [calc, nt]) await post(w, w.A, f);
    recreateGitDir(w.A);
    const { topStart } = await pinsModule();
    expect(topStart(w.sid, w.A)).toEqual({ kind: 'commit', head: w.X2 });
    testRecord(w.A, [calc, join(w.A, 'package.json')], {}, CALC_TESTS);
    reviewRecord(w.A, [calc, nt, join(w.A, 'package.json'), join(w.A, '.gitignore'), join(w.A, 'tests/xonly.test.ts'), join(w.A, 'tests/calc.test.ts')]);
    const out = await stop(w, w.A, I5);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('tests/xonly.test.ts (deleted)');
  });

  test.each([
    ['forward: made again at a newer commit', 'start-at-Y'],
    ['backward: made again at an older commit', 'start-at-X2'],
  ])('a linked worktree %s keeps its original start, so the tests that differ from it are found', async (_label, which) => {
    const w = xonlyWorld();
    const fromY = which === 'start-at-Y';
    await startSession(w);
    const B = laterWorktree(w, fromY ? w.Y : w.X2); // first sight: pinned by the first hook that sees it
    const calc = write(B, 'src/calc.ts', CALC_X.replace('a - b;', 'a - b; // typed'));
    const nt = newTest(B);
    for (const f of [calc, nt]) await post(w, B, f);
    sh(w.A, `git worktree remove --force ${JSON.stringify(B)}`);
    Bun.sleepSync(20);
    worktree(w, B, fromY ? w.X2 : w.Y);
    const { topStart } = await pinsModule();
    expect(topStart(w.sid, B)).toEqual({ kind: 'commit', head: fromY ? w.Y : w.X2 });
    write(B, 'src/calc.ts', CALC_X.replace('a - b;', 'a - b; // typed'));
    newTest(B);
    for (const f of [calc, nt]) await post(w, B, f);
    // The files that differ between the two commits are the session's changes now (carried-over start): reviewed too.
    reviewRecord(B, [calc, nt, ...['legacy', 'xonly', 'extra1', 'extra2', 'extra3'].map((n) => join(B, `tests/${n}.test.ts`))]);
    const out = await stop(w, B, { GOODBOY_TEST_GATE: 'off', GOODBOY_EXISTING_TESTS: 'on' });
    expect(out.decision).toBe('block');
    expect(out.reason).toContain(fromY ? 'tests/legacy.test.ts (deleted)' : 'tests/xonly.test.ts (deleted)');
  });

  test('an honest git-dir copy keeps the start and does not block, also when the session merged two lines that existed before it', async () => {
    const w = xonlyWorld((A) => {
      sh(A, 'git branch side HEAD~2'); // a second pre-session tip: the session will merge it
      sh(A, "git checkout -q side && mkdir -p docs && echo side > docs/side.md && git add -A && git commit -q -m 'ABC-1 side' && git checkout -q main");
    });
    await startSession(w);
    sh(w.A, "git merge -q --no-ff side -m 'ABC-1 merge side'"); // HEAD now merges two pre-session lines
    const calc = write(w.A, 'src/calc.ts', CALC_X + '// typed\n');
    const nt = newTest(w.A);
    for (const f of [calc, nt]) await post(w, w.A, f);
    recreateGitDir(w.A);
    const { topStart, topIdentity } = await pinsModule();
    expect(topStart(w.sid, w.A)).toEqual({ kind: 'commit', head: w.X2 }); // a rediscovery from the merge would be unknown
    expect(topIdentity(w.A).id).not.toBe('nogit');
    testRecord(w.A, [calc], {}, CALC_TESTS);
    reviewRecord(w.A, [calc, nt, join(w.A, 'docs/side.md')]); // the merge the session made is its change too
    const out = await stop(w, w.A, I5);
    expect(out.decision).toBeUndefined();
  });

  test('the original start holds only inside the repository the session started in, with its commit readable', async () => {
    const w = xonlyWorld();
    await startSession(w);
    // A new repository at the same path (another history): the start commit is not in it.
    rmSync(join(w.A, '.git'), { recursive: true, force: true });
    Bun.sleepSync(20);
    sh(w.A, `${GIT_INIT} && git add -A && git commit -q -m 'ABC-1 other world'`);
    const { topStart } = await pinsModule();
    const s = topStart(w.sid, w.A);
    expect(s).toMatchObject({ kind: 'unknown', incomplete: true });
    expect(s.kind === 'unknown' && s.reason).toContain('original start commit');
  });

  test('the first top: a fast-forward to a pre-session tip before the admin dir is recreated keeps the start (the boundary rule would take the new HEAD)', async () => {
    const w = xonlyWorld((A) => sh(A, 'git checkout -q --detach HEAD~2')); // the session starts detached at Y; main (X2) is a pre-session tip
    await startSession(w);
    sh(w.A, 'git merge -q --ff-only main'); // HEAD is X2 now: reachable from the frozen tips, so a first sight would take it as the start
    const calc = write(w.A, 'src/calc.ts', CALC_X + '// typed\n');
    const nt = newTest(w.A);
    for (const f of [calc, nt]) await post(w, w.A, f);
    recreateGitDir(w.A);
    const { topStart } = await pinsModule();
    expect(topStart(w.sid, w.A)).toEqual({ kind: 'commit', head: w.Y });
    testRecord(w.A, [calc, join(w.A, 'package.json')], {}, CALC_TESTS);
    reviewRecord(w.A, [calc, nt, join(w.A, 'package.json'), join(w.A, '.gitignore'), join(w.A, 'tests/calc.test.ts'), ...['legacy', 'xonly', 'extra1', 'extra2', 'extra3'].map((n) => join(w.A, `tests/${n}.test.ts`))]);
    const out = await stop(w, w.A, I5);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('tests/legacy.test.ts (deleted)');
  });

  describe('what differs from the carried-over start counts as the session\'s changes', () => {
    const editsOf = (w: World) => (existsSync(join(w.sdir, 'edits.jsonl')) ? readFileSync(join(w.sdir, 'edits.jsonl'), 'utf8') : '');
    /** B pinned at Y at the session's start, then removed and added again at X2 (new files and edits that Y did not have). */
    async function again() {
      const w = xonlyWorld();
      const B = join(tmp(), 'B');
      worktree(w, B, w.Y);
      await startSession(w);
      sh(w.A, `git worktree remove --force ${JSON.stringify(B)}`);
      Bun.sleepSync(20);
      worktree(w, B, w.X2);
      write(B, 'src/wip.ts', 'export const wip = 1;\n'); // untracked, in no commit: not the session's
      return { w, B };
    }

    test('the files in which the commits differ from the original start are recorded as edits; the user\'s untracked and modified files are not', async () => {
      const { w, B } = await again();
      const { topStart } = await pinsModule();
      expect(topStart(w.sid, B)).toEqual({ kind: 'commit', head: w.Y });
      expect(editsOf(w)).toContain(join(B, 'tests/xonly.test.ts'));
      expect(editsOf(w)).toContain(join(B, 'src/calc.ts'));
      expect(editsOf(w)).not.toContain('wip.ts');
      w.project = B;
      const out = await stop(w, B, { GOODBOY_TEST_GATE: 'on' });
      expect(out.decision).toBe('block');
      expect(out.reason).toContain('No test result covers the changed code');
      expect(out.reason).toContain('src/calc.ts');
    });

    test('a listing that fails is unknown and incomplete, and pins nothing (asked again)', async () => {
      const { w, B } = await again();
      const f = fakeGit();
      const { topStart } = await pinsModule();
      const before = startPins(w).length;
      f.fail('--no-renames'); // the committed-differences listing
      const s = topStart(w.sid, B);
      f.fail(null);
      expect(s).toMatchObject({ kind: 'unknown', incomplete: true });
      expect(startPins(w).length).toBe(before);
      expect(topStart(w.sid, B)).toEqual({ kind: 'commit', head: w.Y });
    });

    test('more than 20,000 files in which the commits differ: unknown and incomplete, pinned', async () => {
      const w = xonlyWorld((A) => {
        for (let i = 0; i <= 20_000; i++) write(A, `many/f${i}.txt`, '');
        sh(A, "git add -A && git commit -q -m 'ABC-1 many'");
      });
      const B = join(tmp(), 'B');
      worktree(w, B, w.Y);
      await startSession(w);
      sh(w.A, `git worktree remove --force ${JSON.stringify(B)}`);
      Bun.sleepSync(20);
      worktree(w, B, 'main'); // 20,001 files that Y does not have
      const { topStart } = await pinsModule();
      const s = topStart(w.sid, B);
      expect(s).toMatchObject({ kind: 'unknown', incomplete: true });
      expect(s.kind === 'unknown' && s.reason).toContain('more than 20000 files');
    });
  });

  test('the first top: the user\'s work in progress from before the session is not the session\'s after an honest .git copy (r15)', async () => {
    const w = world();
    write(w.A, 'src/wip.ts', 'export const wip = 1;\n'); // untracked
    write(w.A, 'tests/calc.test.ts', 'x // user edit before the session\n'); // tracked, modified
    await startSession(w);
    const calc = write(w.A, 'src/calc.ts', CALC_X + '// typed\n');
    const nt = newTest(w.A);
    for (const f of [calc, nt]) await post(w, w.A, f);
    testRecord(w.A, [calc, join(w.A, 'package.json')], {}, CALC_TESTS);
    reviewRecord(w.A, [calc, nt, join(w.A, 'package.json'), join(w.A, '.gitignore')]);
    recreateGitDir(w.A);
    const { topStart } = await pinsModule();
    expect(topStart(w.sid, w.A)).toEqual({ kind: 'commit', head: w.X });
    expect(existsSync(join(w.sdir, 'edits.jsonl')) ? readFileSync(join(w.sdir, 'edits.jsonl'), 'utf8') : '').not.toContain('wip.ts');
    const out = await stop(w, w.A, { GOODBOY_TEST_GATE: 'on', GOODBOY_EXISTING_TESTS: 'off', GOODBOY_DIFF_COVERAGE: 'off' });
    expect(out.decision).toBeUndefined();
  });

  test('registered starts that disagree (a start pin of the same path with another commit) are unknown', async () => {
    const w = xonlyWorld();
    const B = join(tmp(), 'B');
    worktree(w, B, w.Y);
    await startSession(w);
    const { topIdentity, topStart } = await pinsModule();
    const mine = topIdentity(B);
    writeFileSync(join(w.sdir, 'start-pin-0123456789abcdef.json'), JSON.stringify({ v: 1, top: mine.top, id: 'another-identity', start: { kind: 'commit', head: w.X2 } }));
    sh(w.A, `git worktree remove --force ${JSON.stringify(B)}`);
    Bun.sleepSync(20);
    worktree(w, B, w.Y);
    const s = topStart(w.sid, B);
    expect(s).toMatchObject({ kind: 'unknown', incomplete: true });
    expect(s.kind === 'unknown' && s.reason).toContain('disagree');
  });

  test('a registration that is lost next to one that is not (the snapshot lists a pin that is gone) is unknown, not the surviving start', async () => {
    const w = xonlyWorld();
    const B = join(tmp(), 'B');
    worktree(w, B, w.Y);
    await startSession(w);
    const { topIdentity, topStart } = await pinsModule();
    const mine = topIdentity(B);
    const tipsFile = join(w.sdir, 'start-tips.json');
    const tips = JSON.parse(readFileSync(tipsFile, 'utf8'));
    tips.worktrees.push({ top: mine.top, key: 'deadbeefdeadbeef' }); // listed at the start, its pin file never existed here
    writeFileSync(tipsFile, JSON.stringify(tips));
    sh(w.A, `git worktree remove --force ${JSON.stringify(B)}`);
    Bun.sleepSync(20);
    worktree(w, B, w.Y);
    const s = topStart(w.sid, B);
    expect(s).toMatchObject({ kind: 'unknown', incomplete: true });
    expect(s.kind === 'unknown' && s.reason).toContain('missing or unreadable');
  });

  test('a clone put at a pinned worktree\'s path has the commit but not the repository the session started in: unknown', async () => {
    const w = xonlyWorld();
    const B = join(tmp(), 'B');
    worktree(w, B, w.Y);
    await startSession(w); // B is pinned at Y
    sh(w.A, `git worktree remove --force ${JSON.stringify(B)}`);
    Bun.sleepSync(20);
    sh(w.A, `git clone -q ${JSON.stringify(w.A)} ${JSON.stringify(B)} && cd ${JSON.stringify(B)} && git checkout -q ${w.Y}`); // Y is readable there
    const { topStart } = await pinsModule();
    expect(sh(B, `git cat-file -t ${w.Y}`)).toBe('commit');
    const s = topStart(w.sid, B);
    expect(s).toMatchObject({ kind: 'unknown', incomplete: true });
    expect(s.kind === 'unknown' && s.reason).toContain('not in the repository the session started in');
  });

  test('a worktree made again after its start was unknown stays unknown: an ordinary checkout of a known commit does not restore one', async () => {
    const w = xonlyWorld();
    await startSession(w);
    const B = laterWorktree(w, w.X2);
    sh(B, 'git checkout -q --orphan o'); // no HEAD in a repository with history: unknown and incomplete at first sight
    const { topStart } = await pinsModule();
    expect(topStart(w.sid, B)).toMatchObject({ kind: 'unknown', incomplete: true });
    sh(w.A, `git worktree remove --force ${JSON.stringify(B)}`);
    Bun.sleepSync(20);
    worktree(w, B, w.X2);
    expect(topStart(w.sid, B)).toMatchObject({ kind: 'unknown', incomplete: true });
  });

  test('criteria stay: the first top keeps its pin and seen list, a worktree its own, across a recreated admin dir', async () => {
    const reqs = ['# Requirements', '', '## Requirements', '', '| Rank | Requirement | Status |', '|---|---|---|', '| 1 | login | in progress |', ''].join('\n');
    const policy = (test?: string) => ['## P1 Ids', '- decide: ai', '- source: review', '- date: 2026-10-27', '- checked: 2026-10-27', ...(test ? [`- test: ${test}`] : []), ''].join('\n');
    const docs = (top: string, pol?: string) => {
      write(top, 'docs/CYCLE.md', '# Cycle\n\n- **Current version**: 1.0\n- **Current stage**: 5\n');
      write(top, 'docs/versions/1.0/REQUIREMENTS.md', reqs);
      write(top, '.goodboy/policy.md', policy(pol));
    };
    const w = world((A) => {
      docs(A);
      sh(A, "git add -A && git commit -q -m 'ABC-1 docs'");
    });
    const B = join(tmp(), 'B');
    worktree(w, B, 'HEAD');
    await startSession(w);
    const { sessionCriteria } = await criteriaModule();
    docs(w.A, 'ids are UUIDs'); // the session adds a policy test line in A
    const ids = (top: string) => sessionCriteria(w.sid, top).criteria.map((c) => c.id).sort();
    expect(ids(w.A)).toEqual(['POL-P1', 'REQ-1']);
    expect(ids(B)).toEqual(['REQ-1']);
    const files = () => readdirSync(w.sdir).filter((f) => /^criteria-(?:pin|seen)/.test(f)).sort();
    const before = files();
    recreateGitDir(w.A);
    sh(w.A, `git worktree remove --force ${JSON.stringify(B)}`);
    Bun.sleepSync(20);
    worktree(w, B, 'HEAD');
    expect(ids(w.A)).toEqual(['POL-P1', 'REQ-1']); // the first pin and seen list are still the first top's
    expect(ids(B)).toEqual(['REQ-1']);
    expect(files()).toEqual(before); // no pin or seen list of a new identity
  });
});

describe('round 10, fix 2: no git at a path the session pinned is unknown and incomplete, never empty', () => {
  test('a hidden .git before the edits and the records (q9): the changes are not judged against an empty start', async () => {
    const w = world();
    await startSession(w);
    const hid = join(tmp(), 'hidden-git');
    sh(w.A, `mv .git ${JSON.stringify(hid)}`);
    const calc = write(w.A, 'src/calc.ts', CALC_X + '// typed\n');
    const nt = newTest(w.A);
    const weak = write(w.A, 'tests/calc.test.ts', `${T}test("add", () => {});\n`); // an existing test loses its assertions
    for (const f of [calc, nt, weak]) await post(w, w.A, f);
    testRecord(w.A, [calc, join(w.A, 'package.json')], {}, CALC_TESTS);
    reviewRecord(w.A, [calc, nt, weak, join(w.A, 'package.json'), join(w.A, '.gitignore')]);
    const { topStart } = await pinsModule();
    expect(topStart(w.sid, w.A)).toMatchObject({ kind: 'unknown', incomplete: true });
    const out = await stop(w, w.A, I5);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('could not be established');
    expect(out.reason).toContain('no git directory');
  });

  test('a directory that never had a pin and no git is still the empty start (a plain directory)', async () => {
    const w = world();
    await startSession(w);
    const { topStart } = await pinsModule();
    expect(topStart(w.sid, tmp())).toEqual({ kind: 'empty' });
  });

  test('a registration that is missing never grants the empty start: a worktree of the snapshot whose pin is gone', async () => {
    const w = world();
    const B = join(tmp(), 'B');
    worktree(w, B, w.Y);
    await startSession(w); // B is pinned at the session's start
    const { topIdentity, topStart } = await pinsModule();
    const key = topIdentity(B).key;
    rmSync(join(w.sdir, `start-pin-${key}.json`)); // lost (the state guard puts it back after a Bash call; here it is gone)
    expect(topStart(w.sid, B)).toMatchObject({ kind: 'unknown', incomplete: true }); // not rediscovered from today's HEAD
    sh(B, 'mv .git .git.away');
    expect(topStart(w.sid, B)).toMatchObject({ kind: 'unknown', incomplete: true }); // and no git there is not empty either
  });
});

describe('round 10, fix 3: a hook that merely passes through another repository does not pin it', () => {
  async function bashIn(w: World, cwd: string): Promise<void> {
    await hook(w, cwd, 'post-tool-use.ts', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
  }
  const editsLog = (w: World) => (existsSync(join(w.sdir, 'edits.jsonl')) ? readFileSync(join(w.sdir, 'edits.jsonl'), 'utf8') : '');

  test('a read of an unrelated dirty sub-repository records nothing and the Stop does not block (sub2)', async () => {
    const w = world();
    await startSession(w);
    const S = join(w.A, 'sub');
    mkdirSync(S);
    sh(S, GIT_INIT);
    write(S, 'lib.ts', 'export const l = 1;\n');
    write(S, 'pre-dirty.ts', 'x\n');
    sh(S, "git add lib.ts && git commit -q -m 'ABC-1 sub'");
    const pins = startPins(w).length;
    await bashIn(w, S);
    expect(editsLog(w)).not.toContain('pre-dirty');
    expect(startPins(w).length).toBe(pins);
    const out = await stop(w, w.A, { GOODBOY_TEST_GATE: 'on' });
    expect(out.decision).toBeUndefined();
  });

  test('a Stop that judges the other repository still resolves its start (unknown) and blocks an edit there', async () => {
    const w = world();
    await startSession(w);
    const C = join(tmp(), 'C');
    sh(w.A, `git clone -q ${JSON.stringify(w.A)} ${JSON.stringify(C)} && cd ${JSON.stringify(C)} && git config user.email t@e.com && git config user.name t`);
    await bashIn(w, C);
    expect(startPins(w).length).toBe(1); // the pass-through pinned nothing
    await post(w, C, write(C, 'src/calc.ts', CALC_X + '// edit\n'));
    const out = await stop(w, C, { GOODBOY_TEST_GATE: 'on' });
    expect(out.decision).toBe('block');
    expect(out.reason).toContain("The session's start for");
  });

  test('a repository the session makes inside the project is pinned at its first edit, empty, and stays so after its first commit (r5)', async () => {
    const w = world();
    await startSession(w);
    const S = join(w.A, 'sub');
    write(S, 'package.json', '{"name":"s"}');
    sh(S, GIT_INIT);
    const f = write(S, 'src/lib.ts', 'export const s = 1;\n');
    await post(w, S, f); // a Write in the new repository: its first sight, before any commit
    expect(startPins(w).length).toBe(2);
    sh(S, "git add -A && git commit -q -m 'ABC-1 init'");
    await post(w, S, write(S, 'src/lib.ts', 'export const s = 2;\n'));
    const { topStart } = await pinsModule();
    expect(topStart(w.sid, S)).toEqual({ kind: 'empty' }); // it was empty when the session first wrote there
  });

  test('an absolute-path Write into a repository made inside the project, issued from the project cwd, is its first sight (r5)', async () => {
    const w = world();
    await startSession(w);
    const S = join(w.A, 'sub');
    write(S, 'package.json', '{"name":"s"}');
    sh(S, GIT_INIT);
    const f = write(S, 'src/lib.ts', 'export const s = 1;\n');
    await post(w, w.A, f); // the hook's cwd is the project's, the file is in sub (an absolute path)
    expect(startPins(w).length).toBe(2);
    sh(S, "git add -A && git commit -q -m 'ABC-1 init'");
    const { topStart } = await pinsModule();
    expect(topStart(w.sid, S)).toEqual({ kind: 'empty' }); // empty when the session first wrote there, not unknown after the commit
  });

  test('MultiEdit by absolute path into a repository made inside the project is its first sight too', async () => {
    const w = world();
    await startSession(w);
    const S = join(w.A, 'sub');
    write(S, 'package.json', '{"name":"s"}');
    sh(S, GIT_INIT);
    const f = write(S, 'src/lib.ts', 'export const s = 1;\n');
    await hook(w, w.A, 'post-tool-use.ts', { hook_event_name: 'PostToolUse', tool_name: 'MultiEdit', tool_input: { file_path: f, edits: [{ old_string: '1', new_string: '2' }] } });
    expect(startPins(w).length).toBe(2);
  });

  test('a write by absolute path into the first top or a pinned worktree, from anywhere, spawns no git', async () => {
    const w = world();
    await startSession(w);
    const B = laterWorktree(w, w.Y);
    await post(w, B, write(B, 'src/one.ts', 'export const one = 1;\n')); // first sight of B: pinned
    const elsewhere = tmp();
    const f = fakeGit();
    await post(w, elsewhere, write(w.A, 'src/two.ts', 'export const two = 2;\n'));
    await post(w, elsewhere, write(B, 'src/three.ts', 'export const three = 3;\n'));
    await post(w, w.A, write(B, 'src/four.ts', 'export const four = 4;\n'));
    expect(f.calls()).toEqual([]);
  });

  test('editedInside: a log that cannot be read is no proof of a pass-through (true)', async () => {
    const { editedInside } = await coverageModule();
    const dir = tmp();
    expect(editedInside('i33-nolog', dir, () => ({ files: [], firstEditAt: null }))).toBe(false);
    expect(editedInside('i33-nolog', dir, () => ({ files: [join(dir, 'a.ts')], firstEditAt: null }))).toBe(true);
    expect(editedInside('i33-nolog', dir, () => { throw new Error('unreadable'); })).toBe(true);
  });

  test('a worktree the session writes in cannot defer its first sight by pointing its .git at a decoy common dir (r11)', async () => {
    const w = world();
    await startSession(w);
    const W = join(tmp(), 'W');
    worktree(w, W, w.X);
    const real = readFileSync(join(W, '.git'), 'utf8');
    const admin = real.replace('gitdir:', '').trim();
    const decoy = tmp('goodboy-i33-decoy-');
    sh(w.A, `mkdir -p ${decoy}/common/worktrees && cp -a .git/. ${decoy}/common/ && rm -rf ${decoy}/common/worktrees/* && cp -a ${JSON.stringify(admin)} ${decoy}/common/worktrees/W && echo ../.. > ${decoy}/common/worktrees/W/commondir && echo ${join(W, '.git')} > ${decoy}/common/worktrees/W/gitdir`);
    writeFileSync(join(W, '.git'), `gitdir: ${decoy}/common/worktrees/W\n`);
    const before = startPins(w).length;
    await post(w, W, write(W, 'src/calc.ts', CALC_X + '// typed\n')); // an edit in W: first sight now, with the decoy in place
    expect(startPins(w).length).toBe(before + 1);
    writeFileSync(join(W, '.git'), real); // the real .git back, then the baseline moved to an older commit
    sh(W, `git reset -q --hard ${w.Y}`);
    const { topStart } = await pinsModule();
    expect(topStart(w.sid, W)).not.toEqual({ kind: 'commit', head: w.Y }); // never the new HEAD
  });

  test('metadata that cannot be read proves nothing: a clone whose .git is a symlink is still discovered', async () => {
    const w = world();
    await startSession(w);
    const C = join(tmp(), 'C');
    sh(w.A, `git clone -q ${JSON.stringify(w.A)} ${JSON.stringify(C)}`);
    const real = join(tmp(), 'real-git');
    sh(C, `mv .git ${JSON.stringify(real)} && ln -s ${JSON.stringify(real)} .git`);
    const { commonDirOf } = await pinsModule();
    expect(commonDirOf(C)).toBeNull(); // read from files: a symlinked .git is not readable that way
    const pins = startPins(w).length;
    await bashIn(w, C);
    expect(startPins(w).length).toBe(pins + 1);
  });

  test('a separate git dir in a directory that is merely named "worktrees" is a repository of its own (no gitdir file, no damage)', async () => {
    const top = tmp();
    const sep = join(tmp(), 'worktrees', 'x');
    mkdirSync(dirname(sep), { recursive: true });
    sh(top, `git init -q --separate-git-dir ${JSON.stringify(sep)}`);
    const { commonDirOf } = await pinsModule();
    expect(commonDirOf(top)).toBe(realpathSync(sep));
  });

  test('an unreadable commondir of a linked worktree is no repository of its own (it is not a proof of a different one)', async () => {
    const w = world();
    await startSession(w);
    const B = laterWorktree(w, w.Y);
    const { commonDirOf } = await pinsModule();
    expect(commonDirOf(B)).toBe(realpathSync(join(w.A, '.git')));
    const admin = sh(B, 'cat .git').replace('gitdir: ', '').trim();
    chmodSync(join(admin, 'commondir'), 0o000);
    try {
      expect(commonDirOf(B)).toBeNull();
    } finally {
      chmodSync(join(admin, 'commondir'), 0o644);
    }
    rmSync(join(admin, 'commondir'));
    expect(commonDirOf(B)).toBeNull(); // a worktree admin dir without one is damaged, not standalone
  });
});

describe('round 10, fix 4: the stop_hook_active Stop with an unresolved baseline ends the turn unverified, with a warning', () => {
  async function active(w: World, cwd: string, env: Record<string, string>): Promise<Stopped> {
    return JSON.parse((await hook(w, cwd, 'stop.ts', { hook_event_name: 'Stop', stop_hook_active: true }, env)) || '{}') as Stopped;
  }
  const cursors = (w: World) => readdirSync(w.sdir).filter((f) => f.startsWith('.goodboy-last-'));

  test.each([
    ['incomplete (an orphan worktree: no HEAD in a repository with history)', 'orphan'],
    ['unknown (a clone: another repository with history)', 'clone'],
  ])('%s: a warning, no acceptance, every obligation kept, and the next full Stop blocks again', async (_label, kind) => {
    const w = world();
    await startSession(w);
    let top: string;
    if (kind === 'orphan') {
      top = laterWorktree(w, w.X);
      sh(top, 'git checkout -q --orphan o');
    } else {
      top = join(tmp(), 'C');
      sh(w.A, `git clone -q ${JSON.stringify(w.A)} ${JSON.stringify(top)} && cd ${JSON.stringify(top)} && git config user.email t@e.com && git config user.name t`);
    }
    const calc = write(top, 'src/calc.ts', CALC_X + '// typed\n');
    const nt = newTest(top);
    for (const f of [calc, nt]) await post(w, top, f);
    testRecord(top, [calc, join(top, 'package.json')]);
    reviewRecord(top, [calc, nt, join(top, 'package.json'), join(top, '.gitignore')]);
    const env = { GOODBOY_TEST_GATE: 'on', GOODBOY_EXISTING_TESTS: 'on', GOODBOY_DIFF_COVERAGE: 'off' };
    const first = await stop(w, top, env);
    expect(first.decision).toBe('block');
    const edits = readFileSync(join(w.sdir, 'edits.jsonl'), 'utf8');

    const second = await active(w, top, env);
    expect(second.decision).toBeUndefined();
    expect(second.systemMessage).toContain('검증 없이 끝났습니다');
    expect(second.systemMessage).toContain('다음 Stop에서 다시 차단');
    expect(cursors(w)).toEqual([]); // neither the test cursor nor the review cursor moved
    expect(readFileSync(join(w.sdir, 'edits.jsonl'), 'utf8')).toBe(edits);
    const { readGateLog } = await import('../lib/gate-log');
    expect(readGateLog(w.sid).some((e) => e.gate === 'start' && e.decision === 'warn' && (e.reason ?? '').startsWith('unverified-on-stop-active'))).toBe(true);

    const third = await stop(w, top, env);
    expect(third.decision).toBe('block'); // the next full Stop blocks again
    expect(cursors(w)).toEqual([]);
  });

  test('control: a resolved baseline accepts on the active Stop as before (no warning)', async () => {
    const w = world();
    await startSession(w);
    const calc = write(w.A, 'src/calc.ts', CALC_X + '// typed\n');
    const nt = newTest(w.A);
    for (const f of [calc, nt]) await post(w, w.A, f);
    testRecord(w.A, [calc]);
    reviewRecord(w.A, [calc, nt]);
    const out = await active(w, w.A, { GOODBOY_TEST_GATE: 'on', GOODBOY_EXISTING_TESTS: 'off', GOODBOY_DIFF_COVERAGE: 'off' });
    expect(out.systemMessage ?? '').not.toContain('검증 없이');
    expect(cursors(w).length).toBe(2); // accepted: both cursors moved
  });

  test('an active Stop with an unresolved baseline and nothing pending is silent (no noise for an edit-free turn)', async () => {
    const w = world();
    await startSession(w);
    const C = join(tmp(), 'C');
    sh(w.A, `git clone -q ${JSON.stringify(w.A)} ${JSON.stringify(C)}`);
    const { topStart } = await pinsModule();
    expect(topStart(w.sid, C)).toMatchObject({ kind: 'unknown' }); // unresolved, yet nothing is pending
    const out = await active(w, C, { GOODBOY_TEST_GATE: 'on' });
    expect(out.systemMessage ?? '').not.toContain('검증 없이');
  });
});

describe('round 10, fix 5: the incomplete-start gate fails closed, and the "no repository" probe reads English', () => {
  test('incompleteStartProblem: an exception is a block, as startProblem\'s is', async () => {
    const w = world();
    await startSession(w);
    const dir = tmp('goodboy-i33-preload-');
    // A preload that makes lib/changed-coverage.ts's incompleteStart throw: the hook is a script, not importable.
    writeFileSync(
      join(dir, 'throw.ts'),
      [
        "import { plugin } from 'bun';",
        'plugin({ name: "throw-incomplete-start", setup(build) {',
        '  build.onLoad({ filter: /lib\\/changed-coverage\\.ts$/ }, async (args) => {',
        '    const text = await Bun.file(args.path).text();',
        "    const head = 'export function incompleteStart(sessionId: string, top: string): string | null {';",
        '    if (!text.includes(head)) throw new Error("incompleteStart not found");',
        "    return { contents: text.replace(head, head + '\\n  throw new Error(\"injected\");'), loader: 'ts' };",
        '  });',
        '} });',
        '',
      ].join('\n'),
    );
    const p = Bun.spawn(['bun', '--preload', join(dir, 'throw.ts'), join(ROOT, 'hooks', 'stop.ts')], {
      cwd: w.A,
      env: baseEnv(w, { GOODBOY_TEST_GATE: 'on' }),
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: w.sid, cwd: w.A, hook_event_name: 'Stop', stop_hook_active: false })),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const text = await new Response(p.stdout).text();
    await p.exited;
    const out = JSON.parse(text || '{}') as Stopped;
    expect(out.decision).toBe('block'); // with no edits at all: the gate could not tell, so it does not pass
    expect(out.reason).toContain('could not be read');
    expect(out.reason).toContain('injected');
  });

  /** A git first on PATH whose "not a git repository" message is German unless it runs with LC_ALL=C and no LANGUAGE. */
  function localeGit(mode: 'translate' | 'always-translated'): void {
    const dir = tmp('goodboy-i33-locale-');
    writeFileSync(
      join(dir, 'git'),
      [
        '#!/bin/sh',
        'case "$*" in *--show-toplevel*)',
        mode === 'always-translated'
          ? '  echo "fatal: kein Git-Repository" >&2; exit 128 ;;'
          : '  if [ "$LC_ALL" = "C" ] && [ -z "$LANGUAGE" ]; then echo "fatal: not a git repository (or any of the parent directories): .git" >&2; else echo "fatal: kein Git-Repository (oder irgendein Elternverzeichnis): .git" >&2; fi; exit 128 ;;',
        'esac',
        'exec "$GB_REAL" "$@"',
        '',
      ].join('\n'),
    );
    chmodSync(join(dir, 'git'), 0o755);
    const names = ['PATH', 'GB_REAL', 'LC_ALL', 'LANGUAGE'];
    const saved = names.map((n) => process.env[n]);
    process.env.GB_REAL = REAL_GIT;
    process.env.LC_ALL = 'de_DE.UTF-8'; // the user's locale
    process.env.LANGUAGE = 'de';
    process.env.PATH = `${dir}${delimiter}${process.env.PATH}`;
    restore.push(() => names.forEach((n, i) => (saved[i] === undefined ? delete process.env[n] : (process.env[n] = saved[i]))));
  }

  test('a directory that is no repository is empty even where git translates its messages (LC_ALL=C, LANGUAGE unset)', async () => {
    const w = world();
    await startSession(w);
    const plain = tmp();
    localeGit('translate');
    const { topStart, topIdentity } = await pinsModule();
    expect(topIdentity(plain).unknown).toBeUndefined();
    expect(topStart(w.sid, plain)).toEqual({ kind: 'empty' });
  });

  test('exit 128 alone is no evidence: a message that is not "not a git repository" is unknown', async () => {
    const w = world();
    await startSession(w);
    const plain = tmp();
    localeGit('always-translated'); // even under LC_ALL=C the text does not say it
    const { topStart } = await pinsModule();
    expect(topStart(w.sid, plain)).toMatchObject({ kind: 'unknown', incomplete: true });
  });
});

describe('round 10: one budget table, no local copies', () => {
  test('the hooks take their start-pin budgets from lib/start-pins.ts', async () => {
    const { START_PIN_BUDGET_MS } = await pinsModule();
    expect(START_PIN_BUDGET_MS).toEqual({ sessionStart: 8_000, postToolUse: 8_000, stop: 6_000 });
    for (const hook of ['session-start', 'post-tool-use', 'stop']) {
      const text = readFileSync(join(ROOT, 'hooks', `${hook}.ts`), 'utf8');
      expect(text).not.toMatch(/const START_PIN_BUDGET_MS\b/);
      expect(text).toContain('START_PIN_BUDGET_MS.');
    }
  });
});
