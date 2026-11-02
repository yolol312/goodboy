// (#35) A linked worktree of the project's repository nested anywhere in the project dir is a checkout of
// its own, whenever it was made. Real SessionStart, PostToolUse and Stop hooks are spawned against
// temporary repos (git worktrees included); the edit scope is also read in process.
//   1. the #35 scenario: a worktree made mid-session at A/.worktrees/b is judged by a Stop run inside it,
//      with its own records and its own cursors; a Stop in A then has nothing to say about it;
//   2. cross-check from A: edits made in B this turn block A's Stop (names B), the next Stop only warns,
//      a later edit blocks again, and the user's Stop marker passes the block once;
//   3. cross-check from B: edits made in A (outside B) this turn block B's Stop (names A); any change in the
//      project this turn (even one in B alone) blocks while A's edits wait;
//   4. a Stop inside A/.claude/worktrees checks no other checkout;
//   5. the edit scope: getEditsSince(sid, 0, A) leaves out a file of a nested worktree and keeps the
//      files of A, of Claude Code's agent worktrees, and of a nested clone.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { approvalMarkerPath } from '../lib/approval-marker';
import { ensureSessionDir, getEditsSince } from '../lib/file-tracker';
import { linkedWorktreeOf, nestedCheckoutOf } from '../lib/git-dirs';
import { projectDir } from '../lib/project-dir';
import { workTreeState } from '../lib/push-test';

const ROOT = resolve(import.meta.dir, '..');
setDefaultTimeout(90_000);

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

function tmp(prefix = 'goodboy-i35-'): string {
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
  A: string;
  X: string;
  Y: string;
  sid: string;
  home: string;
  sdir: string;
}

let counter = 0;
function world(): World {
  const A = tmp();
  const home = tmp('goodboy-i35-home-');
  sh(A, GIT_INIT);
  write(A, 'package.json', '{"name":"p","version":"1.0.0","scripts":{"test":"bun test"}}');
  write(A, '.gitignore', '.claude/\ncoverage/\n');
  write(A, 'src/calc.ts', CALC_Y);
  write(A, 'tests/calc.test.ts', `${T}import { add } from "../src/calc";\ntest("add", () => { expect(add(1, 2)).toBe(3); expect(add(0, 0)).toBe(0); });\n`);
  sh(A, "git add -A && git commit -q -m 'ABC-1 Y'");
  const Y = sh(A, 'git rev-parse HEAD');
  write(A, 'src/calc.ts', CALC_X);
  sh(A, "git add -A && git commit -q -m 'ABC-1 X'");
  const X = sh(A, 'git rev-parse HEAD');
  const sid = `i35${Math.random().toString(36).slice(2, 8)}${counter++}`;
  const sdir = join(tmpdir(), `goodboy-session-${sid}`);
  dirs.push(sdir);
  return { A, X, Y, sid, home, sdir };
}

const baseEnv = (w: World, env: Record<string, string> = {}): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  HOME: w.home,
  CLAUDE_PLUGIN_ROOT: ROOT,
  CLAUDE_PROJECT_DIR: w.A,
  GOODBOY_DISABLE_DELEGATION: '1',
  GOODBOY_CLAIM_FLUSH_WAIT_MS: '0',
  GOODBOY_POLICY_GATE: 'off',
  GOODBOY_DOCS_GATE: 'off',
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
const startSession = (w: World) => hook(w, w.A, 'session-start.ts', { hook_event_name: 'SessionStart', source: 'startup' });
const post = (w: World, cwd: string, file: string) => hook(w, cwd, 'post-tool-use.ts', { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: file } });
interface Stopped {
  decision?: string;
  reason?: string;
  systemMessage?: string;
}
const GATES = { GOODBOY_TEST_GATE: 'on', GOODBOY_DIFF_COVERAGE: 'off', GOODBOY_EXISTING_TESTS: 'off' };
async function stop(w: World, cwd: string, env: Record<string, string> = GATES): Promise<Stopped> {
  const text = (await hook(w, cwd, 'stop.ts', { hook_event_name: 'Stop', stop_hook_active: false }, env)) || '{}';
  return JSON.parse(text) as Stopped;
}
const worktree = (w: World, dir: string, rev: string) => sh(w.A, `git worktree add -q --detach ${JSON.stringify(dir)} ${rev}`);
const CROSS = 'another checkout of the project';
const WARN = '[goodboy] 다른 체크아웃(';

// ── Records the gates accept ─────────────────────────────────────────────────────────────────

const DIMS = ['hallucination', 'performance', 'refactoring-quality', 'security-secrets', 'security-authz', 'security-injection', 'error-path', 'test-quality'];
function reviewRecord(top: string, files: string[]): void {
  write(top, '.claude/reviews/r.json', JSON.stringify({ timestamp: new Date(Date.now() + 1000).toISOString(), tree: workTreeState(top).tree, reviewed_files: files, category: 'fix-bug', findings: [], unknown_assumptions_checked: [], verdict: 'pass', dimensions_checked: DIMS }));
}
const ACC = [{ id: 'AC-1', description: 'add', test: 'tests/calc-new.test.ts', red: { command: 'bun test', output: '1 fail', exit_code: 1 }, green: { command: 'bun test', output: '1 pass', exit_code: 0 } }];
function testRecord(top: string, tested: string[]): void {
  write(top, '.claude/tests/result.json', JSON.stringify({ timestamp: new Date(Date.now() + 1000).toISOString(), ...workTreeState(top), tested_files: tested, category: 'fix-bug', test_files: [join(top, 'tests/calc-new.test.ts')], environment: { mode: 'local' }, suites: [{ name: 'unit', command: 'bun test', passed: 3, failed: 0, output: '3 pass', type: 'unit', duration_ms: 5 }], acceptance: ACC, verdict: 'pass' }));
}
const newTest = (top: string) => write(top, 'tests/calc-new.test.ts', `${T}import { add } from "../src/calc";\ntest("neg", () => { expect(add(-1, 1)).toBe(0); });\n`);
const cursors = (w: World, kind: 'test' | 'review') => readdirSync(w.sdir).filter((f) => f.startsWith(`.goodboy-last-${kind}-`));
const CHECKOUT_COUNT = '.goodboy-checkout-retry-count.txt';

// ── 1. The #35 scenario ──────────────────────────────────────────────────────────────────────

describe('#35: a worktree made mid-session at A/.worktrees/b is a checkout of its own', () => {
  test('a Stop in B passes on records written in B and writes B\'s cursors; a Stop in A then does not block on B', async () => {
    const w = world();
    await startSession(w);
    const B = join(w.A, '.worktrees', 'b');
    worktree(w, B, w.Y); // made after the session started, inside A, outside .claude/worktrees
    const calc = write(B, 'src/calc.ts', CALC_Y.replace('a + b;', 'a + b; // typed'));
    const nt = newTest(B);
    for (const f of [calc, nt]) await post(w, B, f);
    testRecord(B, [calc]);
    reviewRecord(B, [calc, nt]);

    const inB = await stop(w, B);
    expect(inB.decision).toBeUndefined(); // the rule 11 block ("edits under a nested worktree") is gone
    expect(inB.reason ?? '').not.toContain('nested');
    expect(inB.reason ?? '').not.toContain("The session's start");
    expect(cursors(w, 'test').length).toBe(1);
    expect(cursors(w, 'review').length).toBe(1);

    const inA = await stop(w, w.A);
    expect(inA.decision).toBeUndefined();
    expect(inA.reason ?? '').not.toContain(CROSS);
    expect(inA.systemMessage ?? '').not.toContain(WARN); // B's edits were accepted in B: nothing waits there
    expect(cursors(w, 'test').length).toBe(1); // A's Stop wrote none: it had nothing of its own to accept
    expect(cursors(w, 'review').length).toBe(1);
  });

  test('without records the same edit blocks in B (the checkout is judged, not skipped)', async () => {
    const w = world();
    await startSession(w);
    const B = join(w.A, '.worktrees', 'b');
    worktree(w, B, w.Y);
    const calc = write(B, 'src/calc.ts', CALC_Y.replace('a + b;', 'a + b; // typed'));
    await post(w, B, calc);
    const inB = await stop(w, B);
    expect(inB.decision).toBe('block');
    expect(inB.reason).toContain('No test result covers the changed code');
    expect(inB.reason).toContain('src/calc.ts');
  });
});

// ── 2. The cross-check from A ────────────────────────────────────────────────────────────────

describe('#35: a Stop in A points to edits made this turn in a nested checkout', () => {
  test('blocks once with B named, then warns; a later edit blocks again; the user\'s Stop marker passes one block', async () => {
    const w = world();
    await startSession(w);
    const B = join(w.A, 'wt', 'b');
    worktree(w, B, w.Y);
    const calc = write(B, 'src/calc.ts', CALC_Y.replace('a + b;', 'a + b; // typed'));
    const nt = newTest(B);
    await post(w, w.A, calc); // the shell is in A
    await post(w, w.A, nt);
    testRecord(w.A, [calc]); // records in A are no judgement of B's edits
    reviewRecord(w.A, [calc, nt]);

    const first = await stop(w, w.A);
    expect(first.decision).toBe('block');
    expect(first.reason).toContain(CROSS);
    expect(first.reason).toContain(B);
    expect(first.reason).toContain('src/calc.ts');
    expect(readFileSync(join(w.sdir, CHECKOUT_COUNT), 'utf8').trim()).toBe('1');
    expect(cursors(w, 'test')).toEqual([]);
    expect(cursors(w, 'review')).toEqual([]);

    // The next Stop: no edit since the previous one, so the same pending edits only warn.
    const second = await stop(w, w.A);
    expect(second.decision).toBeUndefined();
    expect(second.systemMessage ?? '').toContain(WARN);
    expect(second.systemMessage ?? '').toContain(B);
    expect(existsSync(join(w.sdir, CHECKOUT_COUNT))).toBe(false); // the counter restarts

    // A new edit in B blocks again, and the user's marker passes that one Stop, once.
    await post(w, w.A, write(B, 'src/calc.ts', CALC_Y.replace('a + b;', 'a + b; // typed twice')));
    const marker = approvalMarkerPath(w.A, 'stop', w.sid);
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, ''); // the user's `! touch`
    expect(existsSync(marker)).toBe(true);
    const passed = await stop(w, w.A);
    expect(passed.decision).toBeUndefined();
    expect(passed.systemMessage ?? '').toContain('사용자 승인 마커');
    expect(passed.systemMessage ?? '').toContain('checkout');
    expect(existsSync(marker)).toBe(false);

    await post(w, w.A, write(B, 'src/calc.ts', CALC_Y.replace('a + b;', 'a + b; // typed thrice')));
    const again = await stop(w, w.A);
    expect(again.decision).toBe('block');
    expect(again.reason).toContain(CROSS);
  });

  test('a checkout whose edit changes nothing against its start is not a pending change', async () => {
    const w = world();
    await startSession(w);
    const B = join(w.A, 'wt', 'b');
    worktree(w, B, w.Y);
    const calc = write(B, 'src/calc.ts', CALC_Y.replace('a + b;', 'a + b; // typed'));
    await post(w, w.A, calc);
    write(B, 'src/calc.ts', CALC_Y); // put back: no net change against B's start
    const out = await stop(w, w.A);
    expect(out.decision).toBeUndefined();
    expect(out.reason ?? '').not.toContain(CROSS);
    expect(out.systemMessage ?? '').not.toContain(WARN);
  });
});

// ── 3. The cross-check from B ────────────────────────────────────────────────────────────────

describe('#35: a Stop in a nested checkout points to edits made this turn in the project dir', () => {
  test('an edit in A (outside B) blocks B\'s Stop with A named, then warns', async () => {
    const w = world();
    await startSession(w);
    const B = join(w.A, 'wt', 'b');
    worktree(w, B, w.Y);
    const edit = write(w.A, 'src/calc.ts', CALC_X + '// edit\n');
    await post(w, w.A, edit);
    const first = await stop(w, B);
    expect(first.decision).toBe('block');
    expect(first.reason).toContain(CROSS);
    expect(first.reason).toContain(`${w.A}: src/calc.ts`);
    const second = await stop(w, B);
    expect(second.decision).toBeUndefined();
    expect(second.systemMessage ?? '').toContain(WARN);
    expect(second.systemMessage ?? '').toContain(w.A);
  });

  test('any change this turn blocks while A\'s edits wait: an edit in B alone, after a warned idle turn, blocks naming A', async () => {
    const w = world();
    await startSession(w);
    const B = join(w.A, 'wt', 'b');
    worktree(w, B, w.Y);
    await post(w, w.A, write(w.A, 'src/calc.ts', CALC_X + '// edit\n'));
    expect((await stop(w, B)).decision).toBe('block'); // A's edit was made this turn
    const idle = await stop(w, B); // an idle turn: A's edits still wait, only a warning
    expect(idle.decision).toBeUndefined();
    expect(idle.systemMessage ?? '').toContain(WARN);
    await post(w, B, write(B, 'src/calc.ts', CALC_Y.replace('a + b;', 'a + b; // typed'))); // this turn's change is in B only
    const out = await stop(w, B);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('Unverified edits are in another checkout of the project');
    expect(out.reason).toContain(`${w.A}: src/calc.ts`);
    expect(out.reason).not.toContain(`${B}: `); // B's own edit is not listed as another checkout's
  });

  test('B\'s own edits are not another checkout\'s from B', async () => {
    const w = world();
    await startSession(w);
    const B = join(w.A, 'wt', 'b');
    worktree(w, B, w.Y);
    const calc = write(B, 'src/calc.ts', CALC_Y.replace('a + b;', 'a + b; // typed'));
    await post(w, B, calc);
    const out = await stop(w, B); // blocks on its own missing test result, not on a cross-check
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('No test result covers the changed code');
    expect(out.reason).not.toContain(CROSS);
  });
});

// ── 4. Claude Code's agent worktrees ─────────────────────────────────────────────────────────

describe('#35: a Stop in A/.claude/worktrees/x checks no other checkout', () => {
  test('the same pending edit in a nested checkout blocks A\'s Stop and not x\'s', async () => {
    const w = world();
    await startSession(w);
    const x = join(w.A, '.claude', 'worktrees', 'x');
    worktree(w, x, w.Y);
    const B = join(w.A, 'wt', 'b');
    worktree(w, B, w.Y);
    await post(w, w.A, write(B, 'src/calc.ts', CALC_Y.replace('a + b;', 'a + b; // typed')));

    const inX = await stop(w, x);
    expect(inX.decision).toBeUndefined();
    expect(inX.reason ?? '').not.toContain(CROSS);
    expect(inX.systemMessage ?? '').not.toContain(WARN);
    expect(existsSync(join(w.sdir, CHECKOUT_COUNT))).toBe(false);

    const inA = await stop(w, w.A); // control: the same state blocks from the project dir
    expect(inA.decision).toBe('block');
    expect(inA.reason).toContain(CROSS);
    expect(inA.reason).toContain(B);
  });
});

// ── 5. The edit scope, in process ────────────────────────────────────────────────────────────

describe('#35: getEditsSince leaves a nested checkout out of the enclosing dir\'s scope', () => {
  function seed(sid: string, files: string[]): void {
    const dir = ensureSessionDir(sid);
    dirs.push(dir);
    writeFileSync(join(dir, 'edits.jsonl'), files.map((file) => JSON.stringify({ file, turn: 1, timestamp: new Date().toISOString() })).join('\n') + '\n');
  }

  test('a file of a nested worktree is out of A\'s scope; A\'s own files, an agent worktree\'s and a nested clone\'s stay', () => {
    const w = world();
    const B = join(w.A, 'wt', 'b');
    worktree(w, B, w.Y);
    const x = join(w.A, '.claude', 'worktrees', 'x');
    worktree(w, x, w.Y);
    const clone = join(w.A, 'vendor', 'clone');
    mkdirSync(clone, { recursive: true });
    sh(clone, `${GIT_INIT} && git commit -q --allow-empty -m c`);
    const inA = join(w.A, 'src', 'calc.ts');
    const inB = join(B, 'src', 'calc.ts');
    const inDeepB = join(B, 'src', 'deep', 'more', 'f.ts');
    const inX = join(x, 'src', 'calc.ts');
    const inClone = join(clone, 'src', 'c.ts');
    for (const f of [inDeepB, inClone]) write('/', f, 'export const v = 1;\n'); // the scope only counts files that exist
    const files = [inA, inB, inDeepB, inX, inClone];
    seed(w.sid, files);
    const scoped = getEditsSince(w.sid, 0, w.A).sort();
    expect(scoped).toEqual([inA, inX, inClone].sort());
    expect(getEditsSince(w.sid, 0, B).sort()).toEqual([inB, inDeepB].sort()); // B's own scope keeps its files
    expect(getEditsSince(w.sid, 0).sort()).toEqual([...files].sort()); // no dir: everything
    expect(nestedCheckoutOf(inB, w.A)).toBe(B);
    expect(nestedCheckoutOf(inX, w.A)).toBeNull();
  });

  test('a .git file planted in a subdir that names a real worktree\'s admin dir is no checkout (its back-pointer names another path)', () => {
    const w = world();
    const B = join(w.A, 'wt', 'b');
    worktree(w, B, w.Y);
    const admin = sh(B, 'cat .git').replace('gitdir: ', '').trim();
    const planted = join(w.A, 'docs', 'sub');
    mkdirSync(planted, { recursive: true });
    writeFileSync(join(planted, '.git'), `gitdir: ${admin}\n`);
    const file = join(planted, 'f.ts');
    writeFileSync(file, 'export const v = 1;\n');
    seed(w.sid, [file, join(B, 'src', 'calc.ts')]);
    expect(linkedWorktreeOf(B, w.A)).toBe(true); // the control: the real one passes the same rule
    expect(linkedWorktreeOf(planted, w.A)).toBe(false);
    expect(nestedCheckoutOf(file, w.A)).toBeNull();
    expect(getEditsSince(w.sid, 0, w.A)).toEqual([file]); // stays in A's scope; B's file does not
    expect(projectDir(planted, { CLAUDE_PROJECT_DIR: w.A })).toBe(w.A); // no Stop run there takes it as a project
    expect(projectDir(join(B, 'src'), { CLAUDE_PROJECT_DIR: w.A })).toBe(B);
  });

  test('an unusable argument is no nested checkout, never a throw (the scope reads it as part of the root)', () => {
    const w = world();
    expect(nestedCheckoutOf(undefined as unknown as string, w.A)).toBeNull();
    expect(nestedCheckoutOf(join(w.A, 'src', 'calc.ts'), join(w.A, 'src', 'calc.ts'))).toBeNull(); // the root itself: nothing between
    expect(nestedCheckoutOf(join(tmp(), 'x.ts'), w.A)).toBeNull(); // outside the root
  });

  test('a worktree moved without `git worktree move` is no checkout either (the admin dir still names its old path)', () => {
    const w = world();
    const B = join(w.A, 'wt', 'b');
    worktree(w, B, w.Y);
    const moved = join(w.A, 'elsewhere', 'b');
    mkdirSync(dirname(moved), { recursive: true });
    sh(w.A, `mv ${JSON.stringify(B)} ${JSON.stringify(moved)}`);
    expect(linkedWorktreeOf(moved, w.A)).toBe(false);
    expect(nestedCheckoutOf(join(moved, 'src', 'calc.ts'), w.A)).toBeNull();
  });
});

describe('#35: edits under a planted .git are judged by A\'s own Stop', () => {
  test('a Stop in A blocks on them as A\'s own change, not as another checkout\'s', async () => {
    const w = world();
    await startSession(w);
    const B = join(w.A, 'wt', 'b');
    worktree(w, B, w.Y);
    const admin = sh(B, 'cat .git').replace('gitdir: ', '').trim();
    const planted = join(w.A, 'docs', 'sub');
    mkdirSync(planted, { recursive: true });
    writeFileSync(join(planted, '.git'), `gitdir: ${admin}\n`);
    const file = write(planted, 'f.ts', 'export const v = 1;\n');
    await post(w, w.A, file);
    const out = await stop(w, w.A);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('No test result covers the changed code');
    expect(out.reason).toContain('f.ts');
    expect(out.reason).not.toContain(CROSS);
  });
});

// ── 6. PreToolUse: a path of the project dir seen from a nested checkout ─────────────────────

describe('#35: a call run in a nested checkout is judged for a project-dir path against the project dir', () => {
  const pre = async (w: World, cwd: string, tool: string, file: string, agent?: string): Promise<{ denied: boolean; reason: string }> => {
    const text = await hook(
      w,
      cwd,
      'pre-tool-use.ts',
      { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: file, content: 'export const v = 1;\n' }, ...(agent ? { agent_type: agent, agent_id: 'x1' } : {}) },
      { GOODBOY_REASONING_GATE: 'off', GOODBOY_SKILL_GATE: 'on' },
    );
    const out = JSON.parse(text || '{}') as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    return { denied: out.hookSpecificOutput?.permissionDecision === 'deny', reason: out.hookSpecificOutput?.permissionDecisionReason ?? '' };
  };

  test('a read-only goodboy agent in B may not Write A/src/calc.ts (nor B\'s own file); a path outside the project is not limited', async () => {
    const w = world();
    await startSession(w);
    const B = join(w.A, 'wt', 'b');
    worktree(w, B, w.Y);
    const inA = await pre(w, B, 'Write', join(w.A, 'src', 'calc.ts'), 'goodboy:review-all');
    expect(inA.denied).toBe(true);
    expect(inA.reason).toContain('src/calc.ts');
    expect((await pre(w, B, 'Write', join(B, 'src', 'calc.ts'), 'goodboy:review-all')).denied).toBe(true);
    expect((await pre(w, B, 'Write', join(tmp(), 'probe.ts'), 'goodboy:review-all')).denied).toBe(false);
    // The test writer keeps its own limits for the project dir's paths too.
    const code = await pre(w, B, 'Write', join(w.A, 'src', 'calc.ts'), 'goodboy:test-unit');
    expect(code.denied).toBe(true);
    expect(code.reason).toContain('test files only');
    expect((await pre(w, B, 'Write', join(w.A, 'tests', 'new.test.ts'), 'goodboy:test-unit')).denied).toBe(false);
  });

  test('the skill rule judges A/src/calc.ts from B as project code too (the main session needs a workflow skill)', async () => {
    const w = world();
    await startSession(w);
    const B = join(w.A, 'wt', 'b');
    worktree(w, B, w.Y);
    const out = await pre(w, B, 'Write', join(w.A, 'src', 'calc.ts'));
    expect(out.denied).toBe(true);
    expect(out.reason).toContain('workflow');
    expect((await pre(w, B, 'Write', join(tmp(), 'probe.ts'))).denied).toBe(false); // outside the project: exempt
  });
});
